// 설문 집계 대시보드 (#7): 과정유형별 교육/강사 만족도, 100점 환산, 소표본(10명 미만) 마스킹.
import { watchCollection, onCollection, getCache } from "./store.js";
import { escapeHtml } from "./app.js";
import { coursesCache } from "./courses.js";
import { getProgramById } from "./programs.js";
import { getInstructorById } from "./instructors.js";
import { EDU_ITEMS, INSTRUCTOR_ITEMS } from "./survey-gen.js";

// 설문 집계는 관리자 전용 화면이므로 실제 값을 공개(마스킹 없음).
// (외부 공개·내보내기 산출물은 개인정보 원칙(4-8)상 소표본 마스킹 별도 적용 예정)

// 과정유형: 차수→연결 커리큘럼(program)의 구분에서 자동. 없으면 미분류.
function courseTypeOf(courseId) {
  const c = coursesCache.find((x) => x.id === courseId);
  const prog = c?.programId ? getProgramById(c.programId) : null;
  return prog?.category || "미분류";
}
// 교관유형: 강사 마스터 instructorType → 전임/사내/사외 교관.
function teacherKindOf(instructorId) {
  const t = getInstructorById(instructorId)?.instructorType || "";
  if (t.startsWith("전임")) return "전임교관";
  if (t.startsWith("사내")) return "사내교관";
  if (t.startsWith("사외")) return "사외교관";
  return "기타";
}

const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null);
const to100 = (m) => (m == null ? null : m * 20);
const fmt = (v) => (v == null ? "-" : v.toFixed(2));
const cell = (n, v) => fmt(v);

export function initReports() {
  watchCollection("surveyResponses");
  const typeSel = document.getElementById("rep-period-type");
  const monthInput = document.getElementById("rep-period");
  const now = new Date();
  monthInput.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  document.getElementById("rep-run").addEventListener("click", run);
  // 데이터 도착 시 자동 1회 렌더.
  onCollection("surveyResponses", () => { if (document.querySelector('.tab-panel[data-tab="reports"]:not([hidden])')) run(); });
  document.addEventListener("tabshown", (e) => { if (e.detail === "reports") run(); });
}

function currentResponses() {
  const typeSel = document.getElementById("rep-period-type").value;
  const month = document.getElementById("rep-period").value;
  let list = getCache("surveyResponses");
  if (typeSel === "month" && month) list = list.filter((r) => (r.collectedDate || "").slice(0, 7) === month);
  return list;
}

function run() {
  const responses = currentResponses();
  document.getElementById("rep-total").textContent = `총 응답 ${responses.length}건`;
  renderEducation(responses);
  renderInstructors(responses);
}

// ── 교육 만족도: 과정유형 × 6항목 (+ 전체 평균) ──
function renderEducation(responses) {
  const byType = {};
  for (const r of responses) {
    const t = courseTypeOf(r.courseId);
    (byType[t] = byType[t] || []).push(r);
  }
  const types = Object.keys(byType).sort();
  const head = `<tr><th>구분</th>${types.map((t) => `<th>${escapeHtml(t)}<br>(n=${byType[t].length})</th>`).join("")}<th>전체 평균</th></tr>`;

  const rows = EDU_ITEMS.map((item, i) => {
    const tds = types.map((t) => {
      const scores = byType[t].map((r) => r.edu?.[`q${i}`]).filter(Number.isFinite);
      return `<td>${cell(byType[t].length, to100(avg(scores)))}</td>`;
    }).join("");
    const allScores = responses.map((r) => r.edu?.[`q${i}`]).filter(Number.isFinite);
    return `<tr><td>${escapeHtml(item)}</td>${tds}<td>${cell(responses.length, to100(avg(allScores)))}</td></tr>`;
  }).join("");

  // 종합평균: 응답자 전체 6문항 풀링 평균.
  const totalRow = (() => {
    const tds = types.map((t) => {
      const all = [];
      byType[t].forEach((r) => EDU_ITEMS.forEach((_, i) => { const v = r.edu?.[`q${i}`]; if (Number.isFinite(v)) all.push(v); }));
      return `<td><b>${cell(byType[t].length, to100(avg(all)))}</b></td>`;
    }).join("");
    const all = [];
    responses.forEach((r) => EDU_ITEMS.forEach((_, i) => { const v = r.edu?.[`q${i}`]; if (Number.isFinite(v)) all.push(v); }));
    return `<tr class="sum-row"><td>응답자 수 가중평균(종합)</td>${tds}<td><b>${cell(responses.length, to100(avg(all)))}</b></td></tr>`;
  })();

  document.getElementById("rep-edu").innerHTML =
    responses.length ? `<table><thead>${head}</thead><tbody>${rows}${totalRow}</tbody></table>`
                     : `<p class="empty">해당 기간 응답이 없습니다.</p>`;
}

// ── 강사 만족도: 교관유형 그룹 × (강사×과정) × 3항목 ──
function renderInstructors(responses) {
  const groups = {}; // teacherKind → key(instructorId|subject) → {name,subject,entries:[]}
  for (const r of responses) {
    for (const it of r.instructors || []) {
      const kind = teacherKindOf(it.instructorId);
      const key = `${it.instructorId}|${it.subject}`;
      const g = (groups[kind] = groups[kind] || {});
      const e = (g[key] = g[key] || { name: it.instructorName, subject: it.subject, entries: [] });
      e.entries.push(it);
    }
  }
  const kinds = Object.keys(groups).sort();
  if (!kinds.length) {
    document.getElementById("rep-inst").innerHTML = `<p class="empty">강사 만족도 응답이 없습니다.</p>`;
    return;
  }
  const head = `<tr><th>교관유형</th><th>강사</th><th>과정(과목)</th>${INSTRUCTOR_ITEMS.map((t) => `<th>${escapeHtml(t)}</th>`).join("")}<th>강사별 평균</th><th>n</th></tr>`;
  let body = "";
  for (const kind of kinds) {
    const rows = Object.values(groups[kind]).sort((a, b) => a.name.localeCompare(b.name));
    rows.forEach((e, idx) => {
      const n = e.entries.length;
      const itemMeans = INSTRUCTOR_ITEMS.map((_, i) => avg(e.entries.map((x) => x[`q${i}`]).filter(Number.isFinite)));
      const itemTds = itemMeans.map((m) => `<td>${cell(n, to100(m))}</td>`).join("");
      const overall = avg(itemMeans.filter((v) => v != null));
      body += `<tr>${idx === 0 ? `<td rowspan="${rows.length}">${escapeHtml(kind)}</td>` : ""}<td>${escapeHtml(e.name)}</td><td>${escapeHtml(e.subject)}</td>${itemTds}<td><b>${cell(n, to100(overall))}</b></td><td style="text-align:right">${n}</td></tr>`;
    });
  }
  document.getElementById("rep-inst").innerHTML = `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
}
