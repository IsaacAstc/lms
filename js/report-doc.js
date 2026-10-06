// 운영 결과 보고서 자동 생성 (CLAUDE.md 2-2). 월별. 화면 미리보기 + 인쇄(PDF) + 표별 CSV.
// 기존 집계/소요경비 데이터를 조립: 만족도 요약 → 세부항목 → 주관식 원문 → 시사점·피드백 → 운영결과 → 소요경비.
import {
  collection, getDocs, getDoc, doc, query, where, setDoc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { db, app } from "./firebase.js";
import { escapeHtml } from "./app.js";
import { openPrintWindow } from "./print-window.js";
import { coursesCache } from "./courses.js";
import { getProgramById } from "./programs.js";
import {
  computeAgg, deserializeAgg, eduItemsOf, renderEduHTML, renderInstMergedHTML, renderOxHTML, renderExtraHTML, renderChoiceHTML, renderDatesHTML, renderFtxHTML,
} from "./agg.js";
import { fmtDot } from "./time.js";

function courseTypeOf(id) {
  const c = coursesCache.find((x) => x.id === id);
  if (c?.courseType) return c.courseType;
  const prog = c?.programId ? getProgramById(c.programId) : null;
  return prog?.category || "미분류";
}
function courseNameOf(id) { return coursesCache.find((c) => c.id === id)?.name || id || "-"; }
// 과정명 옆 괄호에 붙이는 교육 일정(월은 보고서 기준이라 생략하지 않고 MM.DD로 짧게).
// 같은 과정명이 한 달에 여러 차수 있을 때 어느 차수인지 구분된다.
function periodOf(c) {
  const md = (d) => (d ? `${d.slice(5, 7)}.${d.slice(8, 10)}` : "");
  const s = md(c?.startDate || ""), e = md(c?.endDate || "");
  if (!s) return "";
  return e && e !== s ? `${s}-${e}` : s;
}
// 같은 과정명은 한 줄·한 표로 묶는다. 공백 차이(끝 공백, 두 칸 띄움)로 같은
// 과정이 따로 갈라지지 않도록 비교용 키는 공백을 정규화한다.
const nameKey = (n) => String(n || "").replace(/\s+/g, " ").trim();
function groupByName(courses) {
  const g = {};
  for (const c of courses) (g[nameKey(c.name)] = g[nameKey(c.name)] || []).push(c);
  return Object.entries(g)
    .map(([name, list]) => ({ name, list: list.sort((a, b) => (a.startDate || "").localeCompare(b.startDate || "")) }))
    .sort((a, b) => (a.list[0].startDate || "").localeCompare(b.list[0].startDate || "") || a.name.localeCompare(b.name));
}
// 과정명 (09.28, 09.30) — 묶인 차수들의 일정을 쉼표로 나열.
function nameWithPeriods(name, courses) {
  const ps = courses.map(periodOf).filter(Boolean);
  return `${escapeHtml(name || "-")}${ps.length ? ` <span class="muted">(${escapeHtml(ps.join(", "))})</span>` : ""}`;
}
const uniq = (arr) => [...new Set(arr.filter((v) => v !== "" && v != null))];
const won = (n) => (n || 0).toLocaleString("ko-KR");
const fmt = (v) => (v == null ? "-" : v.toFixed(2));

export function initReportDoc() {
  const now = new Date();
  document.getElementById("rd-month").value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  document.getElementById("rd-run").addEventListener("click", run);
  document.getElementById("rd-print").addEventListener("click", printDoc);
  document.getElementById("rd-ai-run").addEventListener("click", runAiNarrative);
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
  // 과정명이 같으면 한 표로 묶고, 원문마다 그 차수의 일정을 붙인다.
  const byId = (id) => coursesCache.find((c) => c.id === id);
  const groups = {};
  for (const r of responses) {
    const c = byId(r.courseId);
    const key = c ? nameKey(c.name) : (r.courseId || "-");
    const g = groups[key] = groups[key] || { name: key, courses: new Map(), items: [] };
    if (c) g.courses.set(c.id, c);
    const at = c?.startDate || "";
    const p = periodOf(c);
    const push = (kind, text) => g.items.push({ at, p, kind, text });
    if (r.freeDissatisfied) push("불만족", r.freeDissatisfied);
    if (r.freeSuggestion) push("제안·개선", r.freeSuggestion);
    for (const t of r.freeExtra || []) if (t?.text) push("추가주관식", `[${t.label}] ${t.text}`);
    for (const t of r.fuTexts || []) if (t?.text) push("조건부", `[${t.label}] ${t.text}`);
  }
  const list = Object.values(groups).filter((g) => g.items.length).map((g) => {
    const courses = [...g.courses.values()].sort((a, b) => (a.startDate || "").localeCompare(b.startDate || ""));
    return { ...g, courses, first: courses[0]?.startDate || "" };
  }).sort((a, b) => a.first.localeCompare(b.first) || a.name.localeCompare(b.name));
  if (!list.length) return `<p class="empty">주관식 원문이 없습니다.</p>`;
  return list.map((g) => `
    <h4>${nameWithPeriods(g.name, g.courses)}</h4>
    <table><thead><tr><th>일정</th><th>종류</th><th>원문</th></tr></thead><tbody>${
      // 차수(일정) 순으로 — 같은 차수 안에서는 들어온 순서 유지(정렬은 안정적).
      g.items.sort((a, b) => a.at.localeCompare(b.at)).map((e) =>
        `<tr><td style="white-space:nowrap">${escapeHtml(e.p || "-")}</td><td>${escapeHtml(e.kind)}</td><td class="raw-free">${escapeHtml(e.text)}</td></tr>`).join("")
    }</tbody></table>`).join("");
}

// 운영결과(회차·계획/이수 인원·강의실).
function operationsHTML(month) {
  const list = coursesCache
    .filter((c) => (c.startDate || "").slice(0, 7) === month)
    .sort((a, b) => (a.startDate || "").localeCompare(b.startDate || ""));
  if (!list.length) return `<p class="empty">해당 월에 시작한 차수가 없습니다.</p>`;
  // 운영 결과는 차수마다 한 줄(4·8번과 달리 묶지 않는다). 일정은 교육기간 열에 있으므로 과정명에는 붙이지 않는다.
  const rows = list.map((c) => `<tr>
    <td>${escapeHtml(c.name || "")}</td>
    <td>${escapeHtml(courseTypeOf(c.id))}</td>
    <td style="text-align:right">${c.round ?? ""}</td>
    <td style="text-align:right">${c.capacity ?? 0}</td>
    <td style="text-align:right">${c.appliedCount ?? 0}</td>
    <td style="text-align:right">${c.completedCount ?? 0}</td>
    <td>${escapeHtml(c.venue || "")}</td>
    <td>${escapeHtml(fmtDot(c.startDate || ""))} - ${escapeHtml(fmtDot(c.endDate || ""))}</td></tr>`).join("");
  return `<table><thead><tr><th>과정명</th><th>유형</th><th>차수</th><th>정원</th><th>신청</th><th>이수</th><th>교육장</th><th>교육기간</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// 평가포함 과정 합격률: 해당 월 시작 차수 중 hasEvaluation 차수를 과정명으로 합산.
// 산식: 합격률(%) = 이수 인원 ÷ 신청(출석) 인원 × 100, 소수점 둘째 자리.
function passRateHTML(month) {
  const list = coursesCache.filter((c) =>
    (c.startDate || "").slice(0, 7) === month && c.hasEvaluation && !c.hidden);
  if (!list.length) return `<p class="empty">해당 월에 평가가 포함된 과정이 없습니다.</p>`;
  const rate = (g) => (g.applied ? ((g.completed / g.applied) * 100).toFixed(2) + "%" : "-");
  const groups = groupByName(list).map(({ name, list: cs }) => ({
    name, cs,
    applied: cs.reduce((n, c) => n + (c.appliedCount || 0), 0),
    completed: cs.reduce((n, c) => n + (c.completedCount || 0), 0),
  }));
  const rows = groups.map((g) => `<tr>
      <td>${nameWithPeriods(g.name || "(과정명 없음)", g.cs)}${g.cs.length > 1 ? ` <small>(${g.cs.length}개 차수 합산)</small>` : ""}</td>
      <td style="text-align:right">${g.applied}</td>
      <td style="text-align:right">${g.completed}</td>
      <td style="text-align:right"><b>${rate(g)}</b></td></tr>`).join("");
  const t = groups.reduce((s, g) => ({ applied: s.applied + g.applied, completed: s.completed + g.completed }), { applied: 0, completed: 0 });
  return `<table><thead><tr><th>과정명</th><th>신청(출석) 인원</th><th>이수 인원</th><th>합격률</th></tr></thead><tbody>${rows}
    <tr class="sum-row"><td><b>전체</b></td>
      <td style="text-align:right"><b>${t.applied}</b></td>
      <td style="text-align:right"><b>${t.completed}</b></td>
      <td style="text-align:right"><b>${rate(t)}</b></td></tr></tbody></table>
    <p class="hint">산식: 합격률(%) = 이수 인원 ÷ 신청(출석) 인원 × 100 (소수점 둘째 자리, 평가 포함 과정만 집계)</p>`;
}

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
  // 1인당 단가 분모: 입교인원(신청인원). 구버전 저장분은 completed(이수인원)로 폴백.
  const enrolled = e.enrolled ?? e.completed ?? 0;
  const unit = enrolled ? Math.round(total / enrolled) : null;
  return `<table><thead><tr><th>항목</th><th>비용(원)</th></tr></thead><tbody>${rows}
    <tr class="sum-row"><td><b>합계</b></td><td style="text-align:right"><b>${won(total)}</b></td></tr>
    <tr><td>입교인원(명)</td><td style="text-align:right">${enrolled}</td></tr>
    <tr class="sum-row"><td><b>교육생 1인당 단가</b></td><td style="text-align:right"><b>${unit == null ? "-" : won(unit) + " 원/명"}</b></td></tr>
    </tbody></table>
    ${Array.isArray(e.payAdjustNotes) && e.payAdjustNotes.length ? `
      <h4>지급 조정 내역 (소속기관 내부 규정 등 — 위 강사료·여비에 반영됨)</h4>
      <table><thead><tr><th>강사</th><th>유형</th><th>조정 후 강사료(원)</th><th>조정 후 여비(원)</th><th>사유</th></tr></thead>
      <tbody>${e.payAdjustNotes.map((n) => `<tr>
        <td>${escapeHtml(n.name || "")}</td><td>${escapeHtml(n.type || "")}</td>
        <td style="text-align:right">${won(n.fee)}</td><td style="text-align:right">${won(n.travel)}</td>
        <td>${escapeHtml(n.reason || "")}</td></tr>`).join("")}</tbody></table>` : ""}`;
}

// 마지막으로 생성한 보고서의 월 — 인쇄 파일명에 쓴다(생성 뒤 월 입력을 바꿔도 내용과 맞게).
let reportMonth = "";
// 마지막으로 생성한 보고서의 원자료 — AI 총평에 넘길 지표를 여기서 만든다.
let lastReport = null; // { month, responses, agg }

async function run() {
  const month = document.getElementById("rd-month").value;
  const box = document.getElementById("rd-doc");
  if (!month) return alert("월을 선택하세요.");
  box.innerHTML = "보고서 생성 중…";
  reportMonth = month;
  lastReport = null;
  const aiBtn = document.getElementById("rd-ai-run");
  aiBtn.disabled = true;

  // 설문 원문(기간) → 없으면 스냅샷.
  let responses = [];
  let agg = null, snapshot = false;
  try {
    const snap = await getDocs(query(collection(db, "surveyResponses"),
      where("collectedDate", ">=", `${month}-01`), where("collectedDate", "<=", `${month}-31`)));
    responses = snap.docs.map((d) => d.data());
  } catch (e) { box.innerHTML = "설문 조회 실패: " + escapeHtml(e.message); return; }

  let summaryHtml, detailEdu, detailInst, freetext;
  let narrative = { overview: "", summary: "", actionTaken: "" };
  if (responses.length) {
    agg = computeAgg(responses);
    summaryHtml = summaryTableHTML(summaryFromResponses(responses));
    detailEdu = renderEduHTML(agg);
    detailInst = renderInstMergedHTML(agg);
    freetext = freetextHTML(responses);
  } else {
    // 원문 파기됨 → 스냅샷.
    const sdoc = await getDoc(doc(db, "surveyAggregates", month));
    if (sdoc.exists()) {
      snapshot = true;
      agg = deserializeAgg(sdoc.data());
      summaryHtml = `<p class="hint">원문이 파기되어 과정유형별 요약은 세부 집계표로 대체합니다.</p>`;
      detailEdu = renderEduHTML(agg);
      detailInst = renderInstMergedHTML(agg);
      // 자유·조건부 주관식은 원문 파기 후 건수 스냅샷만 표시.
      freetext = `<p class="empty">원문이 파기되어 주관식 원문은 표시할 수 없습니다.</p>` + renderFtxHTML(agg);
    } else {
      summaryHtml = detailEdu = detailInst = freetext = `<p class="empty">해당 기간 설문 데이터가 없습니다.</p>`;
    }
  }

  // 시사점·피드백 반영계획(surveyAggregates/{month}).
  try {
    const nd = await getDoc(doc(db, "surveyAggregates", month));
    if (nd.exists()) narrative = { overview: nd.data().overview || "", summary: nd.data().summary || "", actionTaken: nd.data().actionTaken || "" };
  } catch { /* */ }

  const ops = operationsHTML(month);
  const exp = await expensesHTML(month);

  box.innerHTML = `
    <div class="report-head">
      <h1>${escapeHtml(month)} 교육 운영 결과 보고서</h1>
      ${snapshot ? `<p class="warn">※ 이 달의 설문 원문은 파기되어 집계 스냅샷 기준으로 작성되었습니다.</p>` : ""}
    </div>
    ${narrative.overview ? `<section><h3>총평</h3><div class="report-narr">${escapeHtml(narrative.overview).replace(/\n/g, "<br>")}</div></section>` : ""}
    <section><h3>1. 만족도 요약 (과정유형 × 교육/강사, 100점 환산)</h3>${summaryHtml}</section>
    <section><h3>2. 교육 만족도 세부항목</h3>${detailEdu}</section>
    ${agg && (renderExtraHTML(agg) || renderOxHTML(agg) || renderChoiceHTML(agg) || renderDatesHTML(agg))
      ? `<section><h3>2-1. 추가 문항 (카테고리 5점 · 예/아니오 · 선택형 · 날짜)</h3>${renderExtraHTML(agg)}${renderOxHTML(agg)}${renderChoiceHTML(agg)}${renderDatesHTML(agg)}</section>` : ""}
    <section><h3>3. 강사 만족도 세부항목</h3>${detailInst}</section>
    <section><h3>4. 주관식 원문</h3>${freetext}</section>
    <section><h3>5. 시사점</h3><div class="report-narr">${narrative.summary ? escapeHtml(narrative.summary).replace(/\n/g, "<br>") : `<span class="empty">주관식 원문 탭에서 시사점을 입력하면 표시됩니다.</span>`}</div></section>
    <section><h3>6. 피드백 반영계획</h3><div class="report-narr">${narrative.actionTaken ? escapeHtml(narrative.actionTaken).replace(/\n/g, "<br>") : `<span class="empty">주관식 원문 탭에서 피드백 반영계획을 입력하면 표시됩니다.</span>`}</div></section>
    <section><h3>7. 운영 결과</h3>${ops}</section>
    <section><h3>8. 평가 결과 (합격률)</h3>${passRateHTML(month)}</section>
    <section><h3>9. 소요경비</h3>${exp}</section>`;
  lastReport = { month, responses, agg };
  aiBtn.disabled = false;
  aiBtn.title = "";
}

// ── AI 총평·시사점·반영계획 ──
// 숫자는 여기서(시스템이) 계산해 넘기고, 모델은 해석과 문장만 쓴다. 서버는 초안 속 숫자가
// 이 지표에 실제로 있는지 대조해 '확인 안 된 숫자'를 돌려준다(지어낸 수치 감지).
// 강사 개인별 점수는 넘기지 않는다(특정 강사 지목 방지).
const r2 = (v) => (v == null || !Number.isFinite(v) ? null : Number(v.toFixed(2)));
function prevMonthOf(month) {
  const [y, m] = month.split("-").map(Number);
  const d = new Date(y, m - 2, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
async function buildMetrics(month, responses, agg) {
  const m = { month };
  if (responses.length) {
    const sm = summaryFromResponses(responses);
    m.satisfaction = {
      responses: sm.total.n, overall: r2(sm.total.overall), education: r2(sm.total.edu), instructor: r2(sm.total.inst),
      byCourseType: sm.rows.map((x) => ({ type: x.type, responses: x.n, overall: r2(x.overall), education: r2(x.edu), instructor: r2(x.inst) })),
    };
    // 전월 대비(원문이 남아 있을 때만).
    const pm = prevMonthOf(month);
    try {
      const ps = await getDocs(query(collection(db, "surveyResponses"),
        where("collectedDate", ">=", `${pm}-01`), where("collectedDate", "<=", `${pm}-31`)));
      if (!ps.empty) {
        const p = summaryFromResponses(ps.docs.map((d) => d.data())).total;
        m.previousMonth = { month: pm, responses: p.n, overall: r2(p.overall) };
        if (p.overall != null && sm.total.overall != null) m.previousMonth.delta = r2(sm.total.overall - p.overall);
      }
    } catch { /* 전월 비교 생략 */ }
    // 교육 만족도 문항별(100점) — 높은 순.
    if (agg) {
      m.educationItems = eduItemsOf(agg).map((label, i) => {
        const c = agg.edu.all[i];
        return { item: label, score: c && c.count ? r2((c.sum / c.count) * 20) : null };
      }).filter((x) => x.score != null).sort((a, b) => b.score - a.score);
    }
    // 차수별 종합 점수 — 높은·낮은 순으로 비교할 수 있게.
    const byCourse = {};
    for (const r of responses) {
      const g = byCourse[r.courseId] = byCourse[r.courseId] || { n: 0, vals: [] };
      g.n++;
      Object.values(r.edu || {}).forEach((v) => Number.isFinite(v) && g.vals.push(v));
      (r.instructors || []).forEach((it) => [0, 1, 2].forEach((i) => Number.isFinite(it[`q${i}`]) && g.vals.push(it[`q${i}`])));
    }
    m.courses = Object.entries(byCourse).map(([id, g]) => {
      const c = coursesCache.find((x) => x.id === id);
      return { course: c?.name || "-", round: c?.round ?? null, period: periodOf(c), responses: g.n,
        overall: g.vals.length ? r2((g.vals.reduce((a, b) => a + b, 0) / g.vals.length) * 20) : null };
    }).sort((a, b) => (b.overall ?? 0) - (a.overall ?? 0)).slice(0, 40);
    // 주관식 분류별 건수(분류해 둔 것만).
    const cats = {};
    for (const r of responses) for (const f of ["catDissatisfied", "catSuggestion"]) if (r[f]) cats[r[f]] = (cats[r[f]] || 0) + 1;
    if (Object.keys(cats).length) m.feedbackCategories = cats;
  }
  // 운영 실적·합격률(그 달 시작 차수).
  const started = coursesCache.filter((c) => (c.startDate || "").slice(0, 7) === month && !c.hidden);
  m.operations = {
    rounds: started.length,
    applied: started.reduce((n, c) => n + (c.appliedCount || 0), 0),
    completed: started.reduce((n, c) => n + (c.completedCount || 0), 0),
  };
  const ev = started.filter((c) => c.hasEvaluation);
  if (ev.length) {
    const a = ev.reduce((n, c) => n + (c.appliedCount || 0), 0), d = ev.reduce((n, c) => n + (c.completedCount || 0), 0);
    m.passRate = { applied: a, completed: d, ratePercent: a ? r2((d / a) * 100) : null };
  }
  try {
    const e = await getDoc(doc(db, "expenses", month));
    if (e.exists()) {
      const x = e.data();
      const enrolled = x.enrolled ?? x.completed ?? 0;
      m.expenses = { totalWon: x.total ?? 0, enrolled, perPersonWon: enrolled ? Math.round((x.total ?? 0) / enrolled) : null };
    }
  } catch { /* */ }
  return m;
}

async function runAiNarrative() {
  if (!lastReport) return alert("보고서를 먼저 생성하세요.");
  const providerId = document.getElementById("rd-ai-provider").value;
  if (!providerId) return alert("설정 → AI 연결에서 모델을 먼저 등록하세요.");
  const btn = document.getElementById("rd-ai-run");
  const box = document.getElementById("rd-ai");
  btn.disabled = true;
  const t0 = Date.now();
  const status = document.createElement("p");
  status.className = "hint";
  box.prepend(status);
  const tick = setInterval(() => { status.textContent = `AI 작성 중… ${Math.round((Date.now() - t0) / 1000)}초`; }, 1000);
  try {
    const { month, responses, agg } = lastReport;
    const metrics = await buildMetrics(month, responses, agg);
    const fn = httpsCallable(getFunctions(app, "asia-northeast3"), "aiReportNarrative", { timeout: 320000 });
    const r = (await fn({ month, providerId, metrics })).data;
    renderAiDraft(r, metrics);
  } catch (e) {
    alert(e.message || e);
  } finally { clearInterval(tick); status.remove(); btn.disabled = false; }
}

function renderAiDraft(r, metrics) {
  const card = document.createElement("div");
  card.className = "ai-card";
  const warn = r.unverified?.length
    ? `<p class="warn">⚠ 지표에서 확인되지 않은 숫자: <b>${r.unverified.map(escapeHtml).join(", ")}</b> — 모델이 지어냈을 수 있으니 고치거나 지우세요.</p>`
    : `<p class="hint">✅ 초안의 숫자를 모두 지표와 대조했습니다(확인 안 된 숫자 없음).</p>`;
  card.innerHTML = `
    <div class="ai-card-head">
      <b>${escapeHtml(r.provider.name || r.provider.model)}</b>
      <span class="muted">${escapeHtml(r.provider.servedModel || r.provider.model)} · ${escapeHtml(r.month)} · ${(r.elapsedMs / 1000).toFixed(1)}초 · 주관식 ${r.sampleCount}건 참고 · 가림 ${r.maskedCount}건</span>
      <button type="button" class="ai-close" title="닫기">×</button>
    </div>
    ${warn}
    <label class="ta-label">총평<textarea class="d-ov" rows="4">${escapeHtml(r.overview || "")}</textarea></label>
    <label class="ta-label">시사점<textarea class="d-sum" rows="5">${escapeHtml(r.summary || "")}</textarea></label>
    <label class="ta-label">피드백 반영계획<textarea class="d-act" rows="5">${escapeHtml(r.action || "")}</textarea></label>
    <div class="form-actions"><button type="button" class="d-apply">보고서에 반영</button></div>
    <details><summary>AI에 넘긴 지표 보기</summary><pre class="report-narr" style="white-space:pre-wrap;font-size:0.78rem">${escapeHtml(JSON.stringify(metrics, null, 2))}</pre></details>`;
  card.querySelector(".ai-close").addEventListener("click", () => card.remove());
  card.querySelector(".d-apply").addEventListener("click", async () => {
    if (!confirm(`${r.month} 보고서의 총평·시사점·피드백 반영계획을 이 내용(수정본 포함)으로 저장합니다.\n기존 내용은 바뀝니다. 계속할까요?`)) return;
    try {
      await setDoc(doc(db, "surveyAggregates", r.month), {
        yearMonth: r.month,
        overview: card.querySelector(".d-ov").value.trim(),
        summary: card.querySelector(".d-sum").value.trim(),
        actionTaken: card.querySelector(".d-act").value.trim(),
        aiDraft: { model: r.provider.servedModel || r.provider.model, providerName: r.provider.name || "", at: Date.now() },
      }, { merge: true });
      card.remove();
      document.getElementById("rd-month").value = r.month;
      await run();
    } catch (e) {
      alert("저장 실패: " + e.message + "\n(시사점 저장은 '주관식 원문' 탭 권한이 있는 계정만 가능합니다)");
    }
  });
  document.getElementById("rd-ai").prepend(card);
}

// 인쇄: 보고서 영역만 새 창으로 열어 print(전역 CSS 충돌 회피).
function printDoc() {
  const box = document.getElementById("rd-doc");
  if (!box || box.querySelector(".empty") && box.children.length <= 1) return alert("먼저 보고서를 생성하세요.");
  // 창 제목이 PDF 저장 파일명이 된다: '운영 결과 보고서 (2026년 09월)'.
  const label = reportMonth ? ` (${reportMonth.slice(0, 4)}년 ${reportMonth.slice(5, 7)}월)` : "";
  openPrintWindow(`운영 결과 보고서${label}`, box.innerHTML);
}
