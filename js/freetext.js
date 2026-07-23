// 주관식 원문 관리 (#6): 관리자 조회·검색·분류(원문 태깅) + 기간별 시사점·피드백 반영계획.
import {
  collection, getDocs, getDoc, doc, setDoc, updateDoc, query, where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./firebase.js";
import { escapeHtml } from "./app.js";
import { coursesCache } from "./courses.js";

const DEFAULT_CATS = ["현업 활용", "강의 방식", "교재/자료", "시설/환경", "운영/진행", "기타"];
let categories = [];
let monthResponses = []; // 현재 조회된 월의 응답(태깅·집계용)

function courseNameOf(id) { return coursesCache.find((c) => c.id === id)?.name || id || "-"; }

export function initFreetext() {
  document.getElementById("cat-add").addEventListener("click", addCategory);
  document.getElementById("cat-save").addEventListener("click", saveCategories);
  document.getElementById("ft-search").addEventListener("click", search);
  document.getElementById("ft-narr-save").addEventListener("click", saveNarrative);
  const now = new Date();
  document.getElementById("ft-month").value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  loadCategories();
}

// ── 분류 항목 관리 (settings/surveyCategories.list) ──
async function loadCategories() {
  try {
    const d = await getDoc(doc(db, "settings", "surveyCategories"));
    categories = d.exists() && Array.isArray(d.data().list) ? d.data().list : DEFAULT_CATS.slice();
  } catch { categories = DEFAULT_CATS.slice(); }
  renderCategoryList();
}
function renderCategoryList() {
  const box = document.getElementById("cat-list");
  box.innerHTML = categories.length
    ? `<div class="chip-row">${categories.map((c, i) =>
        `<span class="chip">${escapeHtml(c)}<button type="button" data-i="${i}" class="chip-del">×</button></span>`).join("")}</div>`
    : `<p class="empty">분류 항목이 없습니다. 아래에서 추가하세요.</p>`;
  box.querySelectorAll(".chip-del").forEach((b) =>
    b.addEventListener("click", () => { categories.splice(Number(b.dataset.i), 1); renderCategoryList(); }));
}
function addCategory() {
  const inp = document.getElementById("cat-new");
  const v = inp.value.trim();
  if (!v) return;
  if (!categories.includes(v)) categories.push(v);
  inp.value = "";
  renderCategoryList();
}
async function saveCategories() {
  try {
    await setDoc(doc(db, "settings", "surveyCategories"), { list: categories }, { merge: true });
    alert("분류 항목을 저장했습니다.");
    refreshCatSelects();
  } catch (e) { alert("저장 실패: " + e.message); }
}

// ── 원문 조회 · 분류 ──
async function search() {
  const month = document.getElementById("ft-month").value;
  if (!month) return alert("기간(월)을 선택하세요.");
  const listBox = document.getElementById("ft-list");
  listBox.innerHTML = "조회 중…";
  try {
    const snap = await getDocs(query(collection(db, "surveyResponses"),
      where("collectedDate", ">=", `${month}-01`), where("collectedDate", "<=", `${month}-31`)));
    monthResponses = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (e) { listBox.innerHTML = "조회 실패: " + e.message; return; }
  renderEntries();
  await loadNarrative(month);
}

function currentEntries() {
  const kind = document.getElementById("ft-kind").value;
  const kw = document.getElementById("ft-kw").value.trim().toLowerCase();
  const out = [];
  for (const r of monthResponses) {
    const when = r.collectedAt || r.collectedDate || "";
    const cn = courseNameOf(r.courseId);
    if (r.freeDissatisfied) out.push({ id: r.id, kind: "불만족", text: r.freeDissatisfied, field: "catDissatisfied", cat: r.catDissatisfied || "", when, courseName: cn });
    if (r.freeSuggestion) out.push({ id: r.id, kind: "제안개선", text: r.freeSuggestion, field: "catSuggestion", cat: r.catSuggestion || "", when, courseName: cn });
  }
  return out.filter((e) => (!kind || e.kind === kind) && (!kw || e.text.toLowerCase().includes(kw)));
}

function catOptions(sel) {
  return [`<option value="">(미분류)</option>`]
    .concat(categories.map((c) => `<option${c === sel ? " selected" : ""}>${escapeHtml(c)}</option>`)).join("");
}
function renderEntries() {
  const box = document.getElementById("ft-list");
  const entries = currentEntries();
  if (!entries.length) { box.innerHTML = `<p class="empty">조건에 맞는 원문이 없습니다.</p>`; renderCatCounts(); return; }
  const rows = entries.map((e) => `<tr>
      <td>${escapeHtml(e.when)}</td>
      <td>${escapeHtml(e.courseName)}</td>
      <td>${escapeHtml(e.kind)}</td>
      <td class="raw-free">${escapeHtml(e.text)}</td>
      <td><select class="ft-cat" data-id="${e.id}" data-field="${e.field}">${catOptions(e.cat)}</select></td>
    </tr>`).join("");
  box.innerHTML = `<table><thead><tr><th>수집일시</th><th>과정명</th><th>종류</th><th>원문</th><th>분류</th></tr></thead><tbody>${rows}</tbody></table>`;
  box.querySelectorAll(".ft-cat").forEach((s) =>
    s.addEventListener("change", async () => {
      const id = s.dataset.id, field = s.dataset.field, val = s.value;
      try {
        await updateDoc(doc(db, "surveyResponses", id), { [field]: val });
        const r = monthResponses.find((x) => x.id === id); if (r) r[field] = val;
        renderCatCounts();
      } catch (e) { alert("분류 저장 실패: " + e.message); }
    }));
  renderCatCounts();
}
function refreshCatSelects() {
  if (monthResponses.length) renderEntries();
}

// 분류별 건수(현재 월 응답 기준).
function computeCounts() {
  const m = {};
  for (const r of monthResponses) {
    for (const f of ["catDissatisfied", "catSuggestion"]) {
      const v = r[f];
      if (v) m[v] = (m[v] || 0) + 1;
    }
  }
  return m;
}
function renderCatCounts() {
  const m = computeCounts();
  const keys = Object.keys(m);
  document.getElementById("ft-cat-counts").innerHTML = keys.length
    ? "분류별 건수: " + keys.map((k) => `${escapeHtml(k)} ${m[k]}`).join(" · ")
    : "분류된 원문이 없습니다.";
}

// ── 기간 시사점 · 피드백 반영계획 (surveyAggregates/{month}) ──
async function loadNarrative(month) {
  try {
    const d = await getDoc(doc(db, "surveyAggregates", month));
    const data = d.exists() ? d.data() : {};
    document.getElementById("ft-summary").value = data.summary || "";
    document.getElementById("ft-action").value = data.actionTaken || "";
  } catch { /* ignore */ }
}
async function saveNarrative() {
  const month = document.getElementById("ft-month").value;
  if (!month) return alert("기간(월)을 선택하세요.");
  const counts = computeCounts();
  const categoriesArr = Object.entries(counts).map(([label, count]) => ({ label, count }));
  try {
    await setDoc(doc(db, "surveyAggregates", month), {
      yearMonth: month,
      summary: document.getElementById("ft-summary").value.trim(),
      actionTaken: document.getElementById("ft-action").value.trim(),
      categories: categoriesArr,
    }, { merge: true });
    alert("시사점·피드백 반영계획을 저장했습니다.");
  } catch (e) { alert("저장 실패: " + e.message); }
}
