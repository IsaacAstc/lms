// 탭별 CSV 대량 등록(import) + 표준 템플릿 다운로드.
// 중복(기존과 같은 키)은 삭제/덮어쓰기 없이 '메시지로 표시 후 추가'(사용자 확정).
import {
  collection, doc, getDocs, writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./firebase.js";
import { downloadCsv } from "./csv.js";

const num = (v) => { const n = Number(String(v ?? "").replace(/,/g, "").trim()); return Number.isFinite(n) ? n : 0; };
const bool = (v) => /^(y|yes|true|1|o|○|예)$/i.test(String(v ?? "").trim());
const kindOf = (t) => { t = t || ""; if (t.startsWith("전임")) return "전임"; if (t.startsWith("사내")) return "사내"; if (t.startsWith("사외")) return "사외"; return ""; };

// ── CSV 파서(따옴표·콤마·개행 처리) ──
function parseCsv(text) {
  text = String(text).replace(/^﻿/, "");
  const rows = []; let field = "", row = [], inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\r") { /* skip */ }
    else if (ch === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim() !== ""));
}
function toRecords(text) {
  const rows = parseCsv(text);
  if (!rows.length) return [];
  const header = rows[0].map((h) => h.trim());
  return rows.slice(1).map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

// ── 대상별 정의 ──
const TARGETS = {
  programs: {
    label: "과정 커리큘럼", coll: "programs",
    headers: ["과정명", "구분", "총일수", "총시수", "순서", "일차", "과목", "시작", "종료", "교관유형", "교육내용"],
    example: ["보안검색요원 정기", "정기", "1", "6", "1", "1", "항공보안 개요", "09:00", "10:50", "전임", "총론"],
    dupKey: (d) => d.name,
    // 과정명으로 묶어 subjects 배열 구성(과정당 1문서).
    async build(records) {
      const skipped = [];
      const byName = {};
      records.forEach((r, i) => {
        const name = (r["과정명"] || "").trim();
        if (!name) { skipped.push({ line: i + 2, reason: "과정명 없음" }); return; }
        const g = byName[name] = byName[name] || { name, category: (r["구분"] || "").trim(), totalDays: num(r["총일수"]), totalHours: num(r["총시수"]), subjects: [] };
        if ((r["과목"] || "").trim()) {
          g.subjects.push({ order: num(r["순서"]), dayNo: num(r["일차"]) || 1, subject: (r["과목"] || "").trim(),
            startTime: (r["시작"] || "").trim(), endTime: (r["종료"] || "").trim(), teacherKind: kindOf(r["교관유형"]), content: (r["교육내용"] || "").trim() });
        }
      });
      for (const g of Object.values(byName)) g.subjects.sort((a, b) => (a.dayNo - b.dayNo) || (a.order - b.order));
      return { docs: Object.values(byName), skipped };
    },
  },
  rooms: {
    label: "강의실", coll: "rooms",
    headers: ["강의실명", "정원", "표시순서", "비고"],
    example: ["A강의실", "30", "1", ""],
    dupKey: (d) => d.name,
    async build(records) {
      const skipped = [], docs = [];
      records.forEach((r, i) => {
        const name = (r["강의실명"] || "").trim();
        if (!name) { skipped.push({ line: i + 2, reason: "강의실명 없음" }); return; }
        docs.push({ name, capacity: num(r["정원"]), order: num(r["표시순서"]), note: (r["비고"] || "").trim() });
      });
      return { docs, skipped };
    },
  },
  instructors: {
    label: "강사", coll: "instructors",
    headers: ["강사명", "소속", "강사유형", "여비기준", "직책", "경력(년)", "경력상세"],
    example: ["홍길동", "본사", "사내강사", "본사/김포", "차장", "10", ""],
    dupKey: (d) => d.name,
    async build(records) {
      const skipped = [], docs = [];
      records.forEach((r, i) => {
        const name = (r["강사명"] || "").trim();
        if (!name) { skipped.push({ line: i + 2, reason: "강사명 없음" }); return; }
        docs.push({ name, affiliation: (r["소속"] || "").trim(), instructorType: (r["강사유형"] || "").trim(),
          travelBasis: (r["여비기준"] || "").trim(), position: (r["직책"] || "").trim(),
          careerYears: num(r["경력(년)"]), careerDetail: (r["경력상세"] || "").trim() });
      });
      return { docs, skipped };
    },
  },
  courses: {
    label: "차수", coll: "courses",
    headers: ["과정코드", "과정명", "차수", "정원", "신청건수", "이수인원", "평가포함", "교육시작일", "교육종료일", "교육장", "과정유형", "운영유형", "커리큘럼명", "숨김"],
    example: ["검정test", "보안검색요원 정기", "1", "30", "0", "0", "Y", "2026-07-27", "2026-07-27", "CBT실습실", "정기", "", "", ""],
    dupKey: (d) => `${d.code}|${d.round}`,
    async build(records) {
      const psnap = await getDocs(collection(db, "programs"));
      const pByName = Object.fromEntries(psnap.docs.map((d) => [(d.data().name || "").trim(), d.id]));
      const skipped = [], docs = [];
      records.forEach((r, i) => {
        const code = (r["과정코드"] || "").trim();
        const name = (r["과정명"] || "").trim();
        if (!code || !name) { skipped.push({ line: i + 2, reason: "과정코드/과정명 필수" }); return; }
        const cur = (r["커리큘럼명"] || "").trim();
        docs.push({ code, name, round: num(r["차수"]) || 1, capacity: num(r["정원"]),
          appliedCount: num(r["신청건수"]), completedCount: num(r["이수인원"]), hasEvaluation: bool(r["평가포함"]),
          startDate: (r["교육시작일"] || "").trim(), endDate: (r["교육종료일"] || "").trim(),
          venue: (r["교육장"] || "").trim(), courseType: (r["과정유형"] || "").trim(),
          operationTag: (r["운영유형"] || "").trim(), programId: cur ? (pByName[cur] || "") : "",
          hidden: bool(r["숨김"]) });
      });
      return { docs, skipped };
    },
  },
  sessions: {
    label: "시간표", coll: "sessions",
    headers: ["과정코드", "차수", "일자", "과목", "시작", "종료", "강의실", "강사"],
    example: ["검정test", "1", "2026-07-27", "항공보안 개요", "09:00", "10:50", "CBT실습실", "홍길동"],
    dupKey: (d) => `${d.courseId}|${d.date}|${d.startTime}|${d.room}`,
    async build(records) {
      const [csnap, isnap] = await Promise.all([getDocs(collection(db, "courses")), getDocs(collection(db, "instructors"))]);
      const cById = {}; csnap.docs.forEach((d) => { const c = d.data(); cById[`${(c.code || "").trim()}|${c.round ?? 1}`] = d.id; });
      const iByName = {}; isnap.docs.forEach((d) => { const x = d.data(); iByName[(x.name || "").trim()] = { id: d.id, type: x.instructorType || "" }; });
      const skipped = [], docs = [];
      records.forEach((r, i) => {
        const code = (r["과정코드"] || "").trim(), round = num(r["차수"]) || 1;
        const cid = cById[`${code}|${round}`];
        if (!cid) { skipped.push({ line: i + 2, reason: `차수 없음(${code} ${round}차)` }); return; }
        const iname = (r["강사"] || "").trim();
        const inst = iname ? iByName[iname] : null;
        if (iname && !inst) { skipped.push({ line: i + 2, reason: `강사 미등록(${iname})` }); return; }
        docs.push({ courseId: cid, date: (r["일자"] || "").trim(), subject: (r["과목"] || "").trim(),
          startTime: (r["시작"] || "").trim(), endTime: (r["종료"] || "").trim(), room: (r["강의실"] || "").trim(),
          instructor: iname, instructorId: inst?.id || "", teacherKind: kindOf(inst?.type) });
      });
      return { docs, skipped };
    },
  },
};

let fileInput = null;
let pendingTarget = null;

export function initCsvImport() {
  fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.accept = ".csv,text/csv";
  fileInput.style.display = "none";
  document.body.appendChild(fileInput);
  fileInput.addEventListener("change", onFile);

  document.addEventListener("click", (e) => {
    const tplBtn = e.target.closest(".csv-tpl");
    if (tplBtn) { downloadTemplate(tplBtn.dataset.import); return; }
    const impBtn = e.target.closest(".csv-import");
    if (impBtn) { pendingTarget = impBtn.dataset.import; fileInput.value = ""; fileInput.click(); }
  });
}

function downloadTemplate(key) {
  const t = TARGETS[key];
  if (!t) return;
  const cell = (v) => /[",\n\r]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v);
  const csv = [t.headers, t.example].map((r) => r.map(cell).join(",")).join("\r\n");
  downloadCsv(`템플릿_${t.label}.csv`, csv);
}

async function onFile() {
  const file = fileInput.files[0];
  const t = TARGETS[pendingTarget];
  if (!file || !t) return;
  let text;
  try { text = await file.text(); } catch (e) { alert("파일 읽기 실패: " + e.message); return; }
  const records = toRecords(text);
  if (!records.length) return alert("데이터 행이 없습니다. 헤더 아래에 데이터를 입력했는지 확인하세요.");

  let built;
  try { built = await t.build(records); } catch (e) { alert("가져오기 처리 실패: " + e.message); return; }
  const { docs, skipped } = built;
  if (!docs.length) return alert(`등록할 데이터가 없습니다.` + (skipped.length ? `\n건너뜀 ${skipped.length}건:\n` + skipped.slice(0, 10).map((s) => `  ${s.line}행: ${s.reason}`).join("\n") : ""));

  // 중복 검사(기존과 같은 키) — 표시만 하고 추가.
  const existing = await getDocs(collection(db, t.coll));
  const existKeys = new Set(existing.docs.map((d) => t.dupKey(d.data())));
  const dups = docs.filter((d) => existKeys.has(t.dupKey(d)));

  let msg = `[${t.label}] ${docs.length}건을 등록합니다.`;
  if (skipped.length) msg += `\n· 건너뜀 ${skipped.length}건: ` + skipped.slice(0, 8).map((s) => `${s.line}행(${s.reason})`).join(", ") + (skipped.length > 8 ? " 외" : "");
  if (dups.length) msg += `\n· 기존과 중복되는 키 ${dups.length}건(덮어쓰지 않고 그대로 추가): ` + dups.slice(0, 8).map((d) => t.dupKey(d)).join(", ") + (dups.length > 8 ? " 외" : "");
  msg += `\n\n계속할까요?`;
  if (!confirm(msg)) return;

  try {
    for (let i = 0; i < docs.length; i += 450) {
      const batch = writeBatch(db);
      docs.slice(i, i + 450).forEach((data) => batch.set(doc(collection(db, t.coll)), data));
      await batch.commit();
    }
    alert(`[${t.label}] ${docs.length}건 등록 완료.` + (skipped.length ? ` (건너뜀 ${skipped.length}건)` : ""));
  } catch (e) { alert("등록 실패: " + e.message); }
}
