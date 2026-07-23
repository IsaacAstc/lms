// 통계 대시보드 (#8): 과정별 운영현황 + 월별 만족도 추이 + 차수 간 비교.
// 시각화는 표 + 인라인 막대(무의존). 추이·비교는 온디맨드 조회(읽기량 제어).
import {
  collection, getDocs, getDoc, doc, query, where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./firebase.js";
import { escapeHtml } from "./app.js";
import { coursesCache } from "./courses.js";
import { getProgramById } from "./programs.js";
import { deserializeAgg } from "./agg.js";

function courseTypeOf(c) {
  if (c?.courseType) return c.courseType; // 차수에 지정된 과정유형 우선.
  const prog = c?.programId ? getProgramById(c.programId) : null;
  return prog?.category || "미분류";
}
const pct = (v) => (v == null ? 0 : Math.max(0, Math.min(100, v)));
const bar = (v) => `<div class="stat-bar"><span style="width:${pct(v)}%"></span></div>`;
const fmt = (v) => (v == null ? "-" : v.toFixed(1));

export function initStats() {
  document.getElementById("stat-year").addEventListener("change", renderOps);
  document.getElementById("trend-run").addEventListener("click", renderTrend);
  document.getElementById("cmp-run").addEventListener("click", renderCompare);
  document.addEventListener("tabshown", (e) => { if (e.detail === "stats") onShow(); });
}

function onShow() {
  fillYearOptions();
  fillCourseNameOptions();
  renderOps();
  const now = new Date();
  const ym = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  if (!document.getElementById("trend-end").value) document.getElementById("trend-end").value = ym;
  if (!document.getElementById("trend-start").value) {
    const s = new Date(now.getFullYear(), now.getMonth() - 5, 1);
    document.getElementById("trend-start").value = `${s.getFullYear()}-${String(s.getMonth() + 1).padStart(2, "0")}`;
  }
}

// ── A. 과정별 운영현황 (coursesCache, 설문 읽기 없음) ──
function fillYearOptions() {
  const sel = document.getElementById("stat-year");
  const years = [...new Set(coursesCache.map((c) => (c.startDate || "").slice(0, 4)).filter(Boolean))].sort().reverse();
  const prev = sel.value;
  sel.innerHTML = `<option value="">전체 연도</option>` + years.map((y) => `<option>${y}</option>`).join("");
  sel.value = prev;
}
function renderOps() {
  const year = document.getElementById("stat-year").value;
  const list = coursesCache.filter((c) => !year || (c.startDate || "").slice(0, 4) === year);
  const groups = {};
  for (const c of list) {
    const key = c.name || "(미지정)";
    const g = groups[key] = groups[key] || { type: courseTypeOf(c), rounds: 0, cap: 0, applied: 0, completed: 0 };
    g.rounds++; g.cap += c.capacity || 0; g.applied += c.appliedCount || 0; g.completed += c.completedCount || 0;
  }
  const names = Object.keys(groups).sort();
  const box = document.getElementById("stat-ops");
  if (!names.length) { box.innerHTML = `<p class="empty">해당 연도의 차수가 없습니다.</p>`; return; }
  const rows = names.map((n) => {
    const g = groups[n];
    const denom = g.applied || g.cap;
    const rate = denom ? (g.completed / denom) * 100 : null;
    return `<tr>
      <td>${escapeHtml(g.type)}</td><td>${escapeHtml(n)}</td>
      <td style="text-align:right">${g.rounds}</td>
      <td style="text-align:right">${g.cap}</td>
      <td style="text-align:right">${g.applied}</td>
      <td style="text-align:right">${g.completed}</td>
      <td>${fmt(rate)}% ${bar(rate)}</td></tr>`;
  }).join("");
  box.innerHTML = `<table><thead><tr><th>과정유형</th><th>과정명</th><th>회차</th><th>정원합</th><th>신청합</th><th>이수합</th><th>이수율</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// ── 만족도 100점 산출(원문 → 없으면 스냅샷) ──
function overallsFromResponses(responses) {
  const edu = [], inst = [];
  for (const r of responses) {
    for (const k in (r.edu || {})) if (Number.isFinite(r.edu[k])) edu.push(r.edu[k]);
    for (const it of r.instructors || []) [0, 1, 2].forEach((i) => { if (Number.isFinite(it[`q${i}`])) inst.push(it[`q${i}`]); });
  }
  const m = (a) => (a.length ? (a.reduce((x, y) => x + y, 0) / a.length) * 20 : null);
  return { edu: m(edu), inst: m(inst), n: responses.length };
}
function overallsFromAgg(agg) {
  const eduM = agg.edu.totalAll.count ? (agg.edu.totalAll.sum / agg.edu.totalAll.count) * 20 : null;
  let s = 0, c = 0;
  for (const kind in agg.inst.groups) for (const key in agg.inst.groups[kind]) for (const it of agg.inst.groups[kind][key].items) { s += it.sum; c += it.count; }
  return { edu: eduM, inst: c ? (s / c) * 20 : null };
}
async function monthOveralls(month) {
  const snap = await getDocs(query(collection(db, "surveyResponses"),
    where("collectedDate", ">=", `${month}-01`), where("collectedDate", "<=", `${month}-31`)));
  if (snap.size) return overallsFromResponses(snap.docs.map((d) => d.data()));
  const sdoc = await getDoc(doc(db, "surveyAggregates", month));
  if (sdoc.exists()) { const o = overallsFromAgg(deserializeAgg(sdoc.data())); return { ...o, n: sdoc.data().count || 0, snapshot: true }; }
  return { edu: null, inst: null, n: 0 };
}

// ── B. 월별 만족도 추이 ──
function monthsBetween(start, end) {
  const out = [];
  let [y, m] = start.split("-").map(Number);
  const [ey, em] = end.split("-").map(Number);
  while (y < ey || (y === ey && m <= em)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m++; if (m > 12) { m = 1; y++; }
    if (out.length > 36) break;
  }
  return out;
}
async function renderTrend() {
  const start = document.getElementById("trend-start").value;
  const end = document.getElementById("trend-end").value;
  const box = document.getElementById("stat-trend");
  if (!start || !end || end < start) { box.innerHTML = `<p class="empty">기간을 올바르게 선택하세요.</p>`; return; }
  const months = monthsBetween(start, end);
  if (months.length > 24 && !confirm(`${months.length}개월을 조회합니다. 읽기량이 커질 수 있습니다. 계속할까요?`)) return;
  box.innerHTML = "조회 중…";
  const rows = [];
  for (const mth of months) {
    const o = await monthOveralls(mth);
    rows.push(`<tr>
      <td>${mth}${o.snapshot ? " <span class='warn'>(스냅샷)</span>" : ""}</td>
      <td style="text-align:right">${o.n}</td>
      <td>${fmt(o.edu)} ${bar(o.edu)}</td>
      <td>${fmt(o.inst)} ${bar(o.inst)}</td></tr>`);
  }
  box.innerHTML = `<table><thead><tr><th>월</th><th>응답수</th><th>교육만족도(100)</th><th>강사만족도(100)</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

// ── C. 차수 간 비교 ──
function fillCourseNameOptions() {
  const sel = document.getElementById("cmp-name");
  const names = [...new Set(coursesCache.map((c) => c.name).filter(Boolean))].sort();
  const prev = sel.value;
  sel.innerHTML = `<option value="">과정명 선택</option>` + names.map((n) => `<option>${escapeHtml(n)}</option>`).join("");
  sel.value = prev;
}
async function renderCompare() {
  const name = document.getElementById("cmp-name").value;
  const box = document.getElementById("stat-cmp");
  if (!name) { box.innerHTML = `<p class="empty">과정명을 선택하세요.</p>`; return; }
  const courses = coursesCache.filter((c) => c.name === name)
    .sort((a, b) => (a.startDate || "").localeCompare(b.startDate || ""));
  box.innerHTML = "조회 중…";
  const rows = [];
  for (const c of courses) {
    const snap = await getDocs(query(collection(db, "surveyResponses"), where("courseId", "==", c.id)));
    const o = overallsFromResponses(snap.docs.map((d) => d.data()));
    const denom = c.appliedCount || c.capacity;
    const rate = denom ? (c.completedCount / denom) * 100 : null;
    rows.push(`<tr>
      <td>${c.round ?? ""}차</td>
      <td>${escapeHtml(c.startDate || "")}</td>
      <td style="text-align:right">${c.completedCount ?? 0}/${denom || 0}</td>
      <td>${fmt(rate)}% ${bar(rate)}</td>
      <td style="text-align:right">${o.n}</td>
      <td>${fmt(o.edu)} ${bar(o.edu)}</td>
      <td>${fmt(o.inst)} ${bar(o.inst)}</td></tr>`);
  }
  box.innerHTML = `<table><thead><tr><th>차수</th><th>시작일</th><th>이수/모수</th><th>이수율</th><th>응답수</th><th>교육(100)</th><th>강사(100)</th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
}
