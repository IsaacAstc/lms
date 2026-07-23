// 운영 결과 보고서 자동 생성 (CLAUDE.md 2-2). 월별. 화면 미리보기 + 인쇄(PDF) + 표별 CSV.
// 기존 집계/소요경비 데이터를 조립: 만족도 요약 → 세부항목 → 주관식 원문 → 시사점·피드백 → 운영결과 → 소요경비.
import {
  collection, getDocs, getDoc, doc, query, where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./firebase.js";
import { escapeHtml } from "./app.js";
import { coursesCache } from "./courses.js";
import { getProgramById } from "./programs.js";
import {
  computeAgg, deserializeAgg, renderEduHTML, renderInstHTML,
} from "./agg.js";

function courseTypeOf(id) {
  const c = coursesCache.find((x) => x.id === id);
  if (c?.courseType) return c.courseType;
  const prog = c?.programId ? getProgramById(c.programId) : null;
  return prog?.category || "미분류";
}
function courseNameOf(id) { return coursesCache.find((c) => c.id === id)?.name || id || "-"; }
const won = (n) => (n || 0).toLocaleString("ko-KR");
const fmt = (v) => (v == null ? "-" : v.toFixed(2));

export function initReportDoc() {
  const now = new Date();
  document.getElementById("rd-month").value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  document.getElementById("rd-run").addEventListener("click", run);
  document.getElementById("rd-print").addEventListener("click", printDoc);
}

// 과정유형 × (교육/강사) 만족도 요약 — 원문 응답 기준(100점 환산).
function summaryFromResponses(responses) {
  const byType = {}; // type → {edu:[], inst:[]}
  const allEdu = [], allInst = [];
  for (const r of responses) {
    const t = courseTypeOf(r.courseId);
    const g = byType[t] = byType[t] || { edu: [], inst: [], n: 0 };
    g.n++;
    for (const k in (r.edu || {})) if (Number.isFinite(r.edu[k])) { g.edu.push(r.edu[k]); allEdu.push(r.edu[k]); }
    for (const it of r.instructors || []) [0, 1, 2].forEach((i) => {
      if (Number.isFinite(it[`q${i}`])) { g.inst.push(it[`q${i}`]); allInst.push(it[`q${i}`]); }
    });
  }
  const m = (a) => (a.length ? (a.reduce((x, y) => x + y, 0) / a.length) * 20 : null);
  const rows = Object.entries(byType).map(([type, g]) => ({
    type, n: g.n, edu: m(g.edu), inst: m(g.inst),
    overall: m([...g.edu, ...g.inst]),
  }));
  rows.sort((a, b) => a.type.localeCompare(b.type));
  return { rows, total: { n: responses.length, edu: m(allEdu), inst: m(allInst), overall: m([...allEdu, ...allInst]) } };
}

function summaryTableHTML(sm) {
  if (!sm.rows.length) return `<p class="empty">해당 기간 설문 응답이 없습니다.</p>`;
  const body = sm.rows.map((r) => `<tr>
    <td>${escapeHtml(r.type)}</td>
    <td style="text-align:right">${r.n}</td>
    <td style="text-align:right">${fmt(r.edu)}</td>
    <td style="text-align:right">${fmt(r.inst)}</td>
    <td style="text-align:right"><b>${fmt(r.overall)}</b></td></tr>`).join("");
  const t = sm.total;
  const totalRow = `<tr class="sum-row">
    <td><b>종합(응답자 수 가중)</b></td>
    <td style="text-align:right"><b>${t.n}</b></td>
    <td style="text-align:right"><b>${fmt(t.edu)}</b></td>
    <td style="text-align:right"><b>${fmt(t.inst)}</b></td>
    <td style="text-align:right"><b>${fmt(t.overall)}</b></td></tr>`;
  return `<table><thead><tr><th>과정유형</th><th>응답수</th><th>교육만족도(100)</th><th>강사만족도(100)</th><th>총평균</th></tr></thead><tbody>${body}${totalRow}</tbody></table>`;
}

// 주관식 원문(과정명 그룹 + 기타).
function freetextHTML(responses) {
  const byCourse = {};
  for (const r of responses) {
    const name = courseNameOf(r.courseId);
    const items = byCourse[name] = byCourse[name] || [];
    if (r.freeDissatisfied) items.push({ kind: "불만족", text: r.freeDissatisfied });
    if (r.freeSuggestion) items.push({ kind: "제안·개선", text: r.freeSuggestion });
  }
  const names = Object.keys(byCourse).filter((n) => byCourse[n].length).sort();
  if (!names.length) return `<p class="empty">주관식 원문이 없습니다.</p>`;
  return names.map((n) => `
    <h4>${escapeHtml(n)}</h4>
    <table><thead><tr><th>종류</th><th>원문</th></tr></thead><tbody>${
      byCourse[n].map((e) => `<tr><td>${escapeHtml(e.kind)}</td><td class="raw-free">${escapeHtml(e.text)}</td></tr>`).join("")
    }</tbody></table>`).join("");
}

// 운영결과(회차·계획/이수 인원·강의실).
function operationsHTML(month) {
  const list = coursesCache
    .filter((c) => (c.startDate || "").slice(0, 7) === month)
    .sort((a, b) => (a.startDate || "").localeCompare(b.startDate || ""));
  if (!list.length) return `<p class="empty">해당 월에 시작한 차수가 없습니다.</p>`;
  const rows = list.map((c) => `<tr>
    <td>${escapeHtml(c.name || "")}</td>
    <td>${escapeHtml(courseTypeOf(c.id))}</td>
    <td style="text-align:right">${c.round ?? ""}</td>
    <td style="text-align:right">${c.capacity ?? 0}</td>
    <td style="text-align:right">${c.appliedCount ?? 0}</td>
    <td style="text-align:right">${c.completedCount ?? 0}</td>
    <td>${escapeHtml(c.venue || "")}</td>
    <td>${escapeHtml(c.startDate || "")}~${escapeHtml(c.endDate || "")}</td></tr>`).join("");
  return `<table><thead><tr><th>과정명</th><th>유형</th><th>차수</th><th>정원</th><th>신청</th><th>이수</th><th>교육장</th><th>교육기간</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// 소요경비(1인당 단가).
async function expensesHTML(month) {
  let e = null;
  try { const d = await getDoc(doc(db, "expenses", month)); if (d.exists()) e = d.data(); } catch { /* */ }
  if (!e) return `<p class="empty">해당 월 소요경비가 저장되지 않았습니다. (소요경비 탭에서 저장 후 반영)</p>`;
  const custom = Array.isArray(e.custom) ? e.custom : [];
  const rows = [
    ["전임교관 교재연구비", e.materialResearch],
    ["사내강사료", e.autoInHouse],
    ["사외강사료", e.autoOutsource],
    ["출강여비", e.autoTravel],
    ["물품(교재·교구 등)", e.supplies],
    ["다과 및 간식", e.refreshments],
    ...custom.map((c) => [c.label || "(기타)", c.amount]),
  ].map(([label, v]) => `<tr><td>${escapeHtml(label)}</td><td style="text-align:right">${won(v)}</td></tr>`).join("");
  const total = e.total ?? 0;
  const completed = e.completed ?? 0;
  const unit = completed ? Math.round(total / completed) : null;
  return `<table><thead><tr><th>항목</th><th>비용(원)</th></tr></thead><tbody>${rows}
    <tr class="sum-row"><td><b>합계</b></td><td style="text-align:right"><b>${won(total)}</b></td></tr>
    <tr><td>이수인원(명)</td><td style="text-align:right">${completed}</td></tr>
    <tr class="sum-row"><td><b>교육생 1인당 단가</b></td><td style="text-align:right"><b>${unit == null ? "-" : won(unit) + " 원/명"}</b></td></tr>
    </tbody></table>`;
}

async function run() {
  const month = document.getElementById("rd-month").value;
  const box = document.getElementById("rd-doc");
  if (!month) return alert("월을 선택하세요.");
  box.innerHTML = "보고서 생성 중…";

  // 설문 원문(기간) → 없으면 스냅샷.
  let responses = [];
  let agg = null, snapshot = false;
  try {
    const snap = await getDocs(query(collection(db, "surveyResponses"),
      where("collectedDate", ">=", `${month}-01`), where("collectedDate", "<=", `${month}-31`)));
    responses = snap.docs.map((d) => d.data());
  } catch (e) { box.innerHTML = "설문 조회 실패: " + escapeHtml(e.message); return; }

  let summaryHtml, detailEdu, detailInst, freetext;
  let narrative = { summary: "", actionTaken: "" };
  if (responses.length) {
    agg = computeAgg(responses);
    summaryHtml = summaryTableHTML(summaryFromResponses(responses));
    detailEdu = renderEduHTML(agg);
    detailInst = renderInstHTML(agg);
    freetext = freetextHTML(responses);
  } else {
    // 원문 파기됨 → 스냅샷.
    const sdoc = await getDoc(doc(db, "surveyAggregates", month));
    if (sdoc.exists()) {
      snapshot = true;
      agg = deserializeAgg(sdoc.data());
      summaryHtml = `<p class="hint">원문이 파기되어 과정유형별 요약은 세부 집계표로 대체합니다.</p>`;
      detailEdu = renderEduHTML(agg);
      detailInst = renderInstHTML(agg);
      freetext = `<p class="empty">원문이 파기되어 주관식 원문은 표시할 수 없습니다.</p>`;
    } else {
      summaryHtml = detailEdu = detailInst = freetext = `<p class="empty">해당 기간 설문 데이터가 없습니다.</p>`;
    }
  }

  // 시사점·피드백 반영계획(surveyAggregates/{month}).
  try {
    const nd = await getDoc(doc(db, "surveyAggregates", month));
    if (nd.exists()) narrative = { summary: nd.data().summary || "", actionTaken: nd.data().actionTaken || "" };
  } catch { /* */ }

  const ops = operationsHTML(month);
  const exp = await expensesHTML(month);

  box.innerHTML = `
    <div class="report-head">
      <h1>${escapeHtml(month)} 교육 운영 결과 보고서</h1>
      ${snapshot ? `<p class="warn">※ 이 달의 설문 원문은 파기되어 집계 스냅샷 기준으로 작성되었습니다.</p>` : ""}
    </div>
    <section><h3>1. 만족도 요약 (과정유형 × 교육/강사, 100점 환산)</h3>${summaryHtml}</section>
    <section><h3>2. 교육 만족도 세부항목</h3>${detailEdu}</section>
    <section><h3>3. 강사 만족도 세부항목</h3>${detailInst}</section>
    <section><h3>4. 주관식 원문</h3>${freetext}</section>
    <section><h3>5. 시사점</h3><div class="report-narr">${narrative.summary ? escapeHtml(narrative.summary).replace(/\n/g, "<br>") : `<span class="empty">주관식 원문 탭에서 시사점을 입력하면 표시됩니다.</span>`}</div></section>
    <section><h3>6. 피드백 반영계획</h3><div class="report-narr">${narrative.actionTaken ? escapeHtml(narrative.actionTaken).replace(/\n/g, "<br>") : `<span class="empty">주관식 원문 탭에서 피드백 반영계획을 입력하면 표시됩니다.</span>`}</div></section>
    <section><h3>7. 운영 결과</h3>${ops}</section>
    <section><h3>8. 소요경비</h3>${exp}</section>`;
}

// 인쇄: 보고서 영역만 새 창으로 열어 print(전역 CSS 충돌 회피).
function printDoc() {
  const box = document.getElementById("rd-doc");
  if (!box || box.querySelector(".empty") && box.children.length <= 1) return alert("먼저 보고서를 생성하세요.");
  const w = window.open("", "_blank");
  if (!w) return alert("팝업이 차단되었습니다. 팝업을 허용하세요.");
  w.document.write(`<!doctype html><html lang="ko"><head><meta charset="utf-8">
    <title>운영 결과 보고서</title>
    <style>
      body{font-family:'Malgun Gothic',sans-serif;margin:24px;color:#111;font-size:12px;}
      h1{font-size:18px;} h3{font-size:14px;margin-top:18px;border-bottom:2px solid #333;padding-bottom:4px;}
      h4{font-size:12px;margin:8px 0 4px;}
      table{border-collapse:collapse;width:100%;margin:6px 0;}
      th,td{border:1px solid #999;padding:4px 6px;font-size:11px;}
      th{background:#eee;} .sum-row{background:#f6f6f6;font-weight:bold;}
      .report-narr{white-space:pre-wrap;border:1px solid #ccc;padding:8px;min-height:32px;}
      .warn{color:#a30;} .empty{color:#888;} .raw-free{white-space:pre-wrap;}
    </style></head><body>${box.innerHTML}</body></html>`);
  w.document.close();
  w.focus();
  w.onload = () => { w.print(); };
  // onload가 이미 지났을 수 있어 보조 호출.
  setTimeout(() => { try { w.print(); } catch { /* */ } }, 300);
}
