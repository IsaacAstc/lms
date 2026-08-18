// 기관(테넌트) 관리 — 방안2: 코드 공유 + 기관별 Firebase 프로젝트.
// 기관 목록은 허브(기본 기관) 프로젝트의 orgs/{orgId}에 저장한다(공개 읽기, 쓰기는 허브 마스터만).
//   orgs/{orgId}: { name, config: {apiKey, authDomain, projectId, ...}, active, updatedAtMs }
// 기관 추가 절차: (1) Firebase 콘솔에서 프로젝트 생성 + Auth 활성화 + firestore.rules 게시
//                (2) 여기 '기관 관리'에서 config 등록 → 로그인 화면에 자동 표시.
import {
  collection, getDocs, doc, setDoc, deleteDoc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { hubDb, currentOrg, switchOrg, guardedReload } from "./firebase.js";
import { escapeHtml, isMasterMode } from "./app.js";

// 기관별 취사선택 가능한 기능(탭 그룹 단위). 설정 핵심(기준값·관리자·데이터 관리)은 항상 포함.
export const ORG_FEATURES = [
  ["courses", "차수·시간표"],
  ["master", "마스터(커리큘럼·강의실·강사)"],
  ["finance", "강사료·경비"],
  ["surveys", "설문 관리"],
  ["survey-result", "설문 결과"],
  ["stats", "통계"],
  ["reportdoc", "운영 보고서"],
  ["rentals", "현장 안내(대관·DID)"],
  ["board", "공개 현황 보드"],
  ["pad", "수업 보드(협업)"],
  // 상단바 바로가기(퀴즈·히어로 미션은 기본 기관 백엔드로 연결되는 링크).
  ["quiz", "퀴즈 바로가기"],
  ["scfe", "히어로 미션 바로가기"],
];
// 탭 id → 기능 id. 매핑에 없는 탭(설정 핵심)은 기능 선택과 무관하게 항상 표시.
const TAB_FEATURE = {
  courses: "courses",
  programs: "master", rooms: "master", instructors: "master",
  payroll: "finance", expenses: "finance",
  surveys: "surveys",
  reports: "survey-result", freetext: "survey-result",
  stats: "stats",
  reportdoc: "reportdoc",
  rentals: "rentals",
  board: "board",
  pad: "pad",
};
export function tabFeature(tab) { return TAB_FEATURE[tab] || null; }

let orgsCache = null; // [{id, name, active, config, features}]

async function fetchOrgs() {
  if (orgsCache) return orgsCache;
  try {
    const snap = await getDocs(collection(hubDb, "orgs"));
    orgsCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (a.name || a.id).localeCompare(b.name || b.id));
  } catch (e) {
    console.error("기관 목록 조회 실패:", e);
    orgsCache = [];
  }
  return orgsCache;
}

// ── 로그인 화면·상단바의 기관 선택 ──
export async function initOrgSelectors() {
  const orgs = await fetchOrgs();
  const active = orgs.filter((o) => o.active !== false && o.config?.apiKey);
  for (const selId of ["login-org", "topbar-org"]) {
    const sel = document.getElementById(selId);
    if (!sel) continue;
    // 기관이 하나도 등록되지 않았으면 선택 UI 자체를 숨긴다(단일 기관 운영).
    const wrap = sel.closest("[data-org-wrap]") || sel;
    if (!active.length && !currentOrg) { wrap.hidden = true; continue; }
    wrap.hidden = false;
    sel.innerHTML = `<option value="">기본 기관</option>`
      + active.map((o) => `<option value="${escapeHtml(o.id)}">${escapeHtml(o.name || o.id)}</option>`).join("")
      // 비활성/삭제된 기관에 접속 중이면 선택 상태 유지를 위해 항목 보존.
      + (currentOrg && !active.some((o) => o.id === currentOrg.id)
        ? `<option value="${escapeHtml(currentOrg.id)}">${escapeHtml(currentOrg.name)} (등록 해제됨)</option>` : "");
    sel.value = currentOrg ? currentOrg.id : "";
    sel.addEventListener("change", () => {
      const id = sel.value;
      if ((currentOrg?.id || "") === id) return;
      const o = active.find((x) => x.id === id);
      switchOrg(o ? { id: o.id, name: o.name, config: o.config, features: o.features } : null); // null = 기본 기관.
    });
  }
  // 접속 중 기관의 레지스트리 변경(기관명·config·기능 목록)을 저장본에 반영.
  // 키 순서 차이로 인한 오탐을 막기 위해 정규화(정렬) 후 비교하고,
  // 다를 때만 저장 + 가드된 새로고침(연속 반복 시 자동 중단) 1회.
  if (currentOrg) {
    const reg = orgs.find((o) => o.id === currentOrg.id);
    if (reg) {
      const stable = (v) => JSON.stringify(v, (k, x) =>
        (x && typeof x === "object" && !Array.isArray(x))
          ? Object.fromEntries(Object.keys(x).sort().map((kk) => [kk, x[kk]])) : x);
      const fresh = { id: reg.id, name: reg.name || "", config: reg.config || {}, features: reg.features ?? null };
      const stored = JSON.parse(localStorage.getItem("lmsOrg") || "null");
      const norm = stored ? { id: stored.id, name: stored.name || "", config: stored.config || {}, features: stored.features ?? null } : null;
      if (norm && stable(norm) !== stable(fresh)) {
        localStorage.setItem("lmsOrg", JSON.stringify(fresh));
        guardedReload();
        return;
      }
    }
  }

  // 상단바 바로가기: 기관별 사용 기능에 따라 칩 단위로 표시.
  // 기본 기관은 전체 표시. 추가 기관은 현황 보드=board, 퀴즈=quiz, 히어로 미션=scfe 기능 선택을 따른다.
  const feats = currentOrg && Array.isArray(currentOrg.features) ? currentOrg.features : null;
  const allowChip = (f) => !currentOrg || !feats || feats.includes(f);
  const chips = [
    ['a[href^="board.html"]', "board"],
    ['a[href^="quiz.html"]', "quiz"],
    ['a[href^="scfe/"]', "scfe"],
  ];
  let shown = 0;
  for (const [selr, f] of chips) {
    const a = document.querySelector(`.quick-links ${selr}`);
    if (!a) continue;
    a.hidden = !allowChip(f);
    if (!a.hidden) shown++;
  }
  const quick = document.querySelector(".quick-links");
  if (quick) quick.hidden = !shown;

  // 상단바 표시명 + 바로가기(현황 보드)에 기관 파라미터 반영.
  const label = document.getElementById("org-label");
  if (label) label.textContent = currentOrg ? currentOrg.name : "";
  const boardLink = document.querySelector('.quick-links a[href^="board.html"]');
  if (boardLink && currentOrg) boardLink.href = `board.html?org=${encodeURIComponent(currentOrg.id)}`;
}

// ── 기관 관리 탭(허브 마스터 전용) ──
const REQUIRED_KEYS = ["apiKey", "authDomain", "projectId", "appId"];

function parseConfig(text) {
  // JSON 또는 JS 객체 리터럴(콘솔 복사본) 형태 허용.
  let t = text.trim();
  const m = t.match(/\{[\s\S]*\}/);
  if (m) t = m[0];
  let obj;
  try {
    obj = JSON.parse(t);
  } catch {
    try {
      // 콘솔 복사본은 키에 따옴표가 없다 → 안전한 범위에서 JSON으로 변환.
      obj = JSON.parse(t
        .replace(/([,{]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":')
        .replace(/,\s*}/g, "}")
        .replace(/'/g, '"'));
    } catch { return { error: "config를 해석할 수 없습니다. Firebase 콘솔의 firebaseConfig 객체를 그대로 붙여넣으세요." }; }
  }
  const missing = REQUIRED_KEYS.filter((k) => !obj[k]);
  if (missing.length) return { error: `필수 항목 누락: ${missing.join(", ")}` };
  // 필요한 키만 저장(잡음 제거).
  const keep = {};
  for (const k of ["apiKey", "authDomain", "projectId", "storageBucket", "messagingSenderId", "appId", "databaseURL"]) {
    if (obj[k]) keep[k] = String(obj[k]);
  }
  return { config: keep };
}

function renderFeatureChecks(form) {
  const box = form.querySelector("#org-features");
  if (!box || box.childElementCount) return;
  box.innerHTML = ORG_FEATURES.map(([id, label]) =>
    `<label class="chk"><input type="checkbox" name="feat" value="${id}" checked> ${escapeHtml(label)}</label>`).join("");
}
function setFeatureChecks(form, features) {
  const all = !Array.isArray(features); // 미설정 = 전체 사용
  form.querySelectorAll('input[name="feat"]').forEach((c) => { c.checked = all || features.includes(c.value); });
}
function readFeatureChecks(form) {
  return [...form.querySelectorAll('input[name="feat"]:checked')].map((c) => c.value);
}

export function initOrgAdmin() {
  const form = document.getElementById("org-form");
  if (!form) return;
  renderFeatureChecks(form);
  const listBox = document.getElementById("org-list");
  const note = document.getElementById("org-note");

  // 허브에 로그인한 마스터만 편집 가능(다른 기관 접속 중엔 허브 인증이 없어 규칙에서 거부됨).
  const editable = !currentOrg && isMasterMode();
  form.hidden = !editable;
  note.textContent = editable
    ? ""
    : (currentOrg
      ? "기관 등록·편집은 기본 기관(허브)에 마스터로 로그인한 상태에서만 가능합니다."
      : "기관 등록·편집은 마스터 관리자만 가능합니다.");

  async function render() {
    orgsCache = null;
    const orgs = await fetchOrgs();
    if (!orgs.length) { listBox.innerHTML = `<p class="empty">등록된 기관이 없습니다. 기본 기관 단독으로 운영 중입니다.</p>`; return; }
    listBox.innerHTML = `<table><thead><tr>
      <th>기관 ID</th><th>기관명</th><th>프로젝트</th><th>사용 기능</th><th>사용</th><th>관리</th>
    </tr></thead><tbody>${orgs.map((o) => `<tr>
      <td>${escapeHtml(o.id)}</td>
      <td>${escapeHtml(o.name || "")}</td>
      <td>${escapeHtml(o.config?.projectId || "")}</td>
      <td class="org-feats">${Array.isArray(o.features)
        ? (o.features.length === ORG_FEATURES.length ? "전체"
          : ORG_FEATURES.filter(([f]) => o.features.includes(f)).map(([, l]) => escapeHtml(l.split("(")[0])).join(", ") || "(없음)")
        : "전체"}</td>
      <td style="text-align:center">${o.active !== false ? "○" : "중지"}</td>
      <td class="actions">
        <button type="button" class="o-edit" data-id="${escapeHtml(o.id)}">수정</button>
        <button type="button" class="o-toggle" data-id="${escapeHtml(o.id)}">${o.active !== false ? "중지" : "사용"}</button>
        <button type="button" class="del o-del" data-id="${escapeHtml(o.id)}">삭제</button>
      </td></tr>`).join("")}</tbody></table>`;
    if (!editable) listBox.querySelectorAll("button").forEach((b) => { b.disabled = true; });

    listBox.querySelectorAll(".o-edit").forEach((b) => b.addEventListener("click", () => {
      const o = orgs.find((x) => x.id === b.dataset.id);
      form.orgId.value = o.id;
      form.orgId.readOnly = true;
      form.orgName.value = o.name || "";
      form.orgConfig.value = JSON.stringify(o.config || {}, null, 2);
      setFeatureChecks(form, o.features);
      form.scrollIntoView({ behavior: "smooth" });
    }));
    listBox.querySelectorAll(".o-toggle").forEach((b) => b.addEventListener("click", async () => {
      const o = orgs.find((x) => x.id === b.dataset.id);
      try {
        await setDoc(doc(hubDb, "orgs", o.id), {
          name: o.name || "", config: o.config || {},
          features: Array.isArray(o.features) ? o.features : ORG_FEATURES.map(([f]) => f),
          active: o.active === false, updatedAtMs: Date.now(),
        });
        render();
      } catch (e) { alert("저장 실패: " + e.message); }
    }));
    listBox.querySelectorAll(".o-del").forEach((b) => b.addEventListener("click", async () => {
      const o = orgs.find((x) => x.id === b.dataset.id);
      if (!confirm(`기관 '${o.name || o.id}' 등록을 삭제할까요?\n(레지스트리에서만 제거되며, 해당 Firebase 프로젝트와 데이터는 그대로 남습니다)`)) return;
      try { await deleteDoc(doc(hubDb, "orgs", o.id)); render(); }
      catch (e) { alert("삭제 실패: " + e.message); }
    }));
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = form.orgId.value.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(id)) return alert("기관 ID는 영문 소문자·숫자·하이픈 2~31자입니다. (URL에 사용됨)");
    const name = form.orgName.value.trim();
    if (!name) return alert("기관명을 입력하세요.");
    const parsed = parseConfig(form.orgConfig.value);
    if (parsed.error) return alert(parsed.error);
    try {
      const prev = (await fetchOrgs()).find((x) => x.id === id);
      await setDoc(doc(hubDb, "orgs", id), {
        name, config: parsed.config, features: readFeatureChecks(form),
        active: prev ? prev.active !== false : true, updatedAtMs: Date.now(),
      });
      form.reset();
      form.orgId.readOnly = false;
      alert("기관을 저장했습니다. 로그인 화면·상단바의 기관 선택에 반영됩니다.");
      render();
    } catch (e) { alert("저장 실패: " + e.message); }
  });
  document.getElementById("org-cancel").addEventListener("click", () => { form.reset(); form.orgId.readOnly = false; setFeatureChecks(form, null); });

  render();
}

// 공개 링크(설문·보드)에 붙일 기관 파라미터.
export function orgQuery(first = false) {
  if (!currentOrg) return "";
  return `${first ? "?" : "&"}org=${encodeURIComponent(currentOrg.id)}`;
}
