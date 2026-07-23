// 설문 집계 공용 모듈: 원문 응답 → 집계 구조(sum/count 보존, 합산 가능) → 표 렌더.
// 원문 파기 시 이 집계를 스냅샷으로 저장하고, 대시보드는 원문 없으면 스냅샷으로 렌더한다.
import { coursesCache } from "./courses.js";
import { getProgramById } from "./programs.js";
import { getInstructorById } from "./instructors.js";
import { EDU_ITEMS, INSTRUCTOR_ITEMS } from "./survey-gen.js";
import { escapeHtml } from "./app.js";

export { EDU_ITEMS, INSTRUCTOR_ITEMS };

function courseTypeOf(id) {
  const c = coursesCache.find((x) => x.id === id);
  const prog = c?.programId ? getProgramById(c.programId) : null;
  return prog?.category || "미분류";
}
function courseNameOf(id) {
  return coursesCache.find((x) => x.id === id)?.name || id || "-";
}
function teacherKindOf(id) {
  const t = getInstructorById(id)?.instructorType || "";
  if (t.startsWith("전임")) return "전임교관";
  if (t.startsWith("사내")) return "사내교관";
  if (t.startsWith("사외")) return "사외교관";
  return "기타";
}

const sc = () => ({ sum: 0, count: 0 });
const add = (t, s) => { t.sum += s.sum || 0; t.count += s.count || 0; };

export function emptyAgg() {
  return { count: 0, edu: { cells: {}, all: {}, nByType: {}, totalAll: sc() }, inst: { groups: {} } };
}

// 원문 응답 배열 → 집계.
export function computeAgg(responses) {
  const a = emptyAgg();
  for (const r of responses) {
    a.count++;
    const type = courseTypeOf(r.courseId);
    a.edu.cells[type] = a.edu.cells[type] || {};
    a.edu.nByType[type] = (a.edu.nByType[type] || 0) + 1;
    EDU_ITEMS.forEach((_, i) => {
      const v = r.edu?.[`q${i}`];
      if (!Number.isFinite(v)) return;
      (a.edu.cells[type][i] = a.edu.cells[type][i] || sc()).sum += v; a.edu.cells[type][i].count++;
      (a.edu.all[i] = a.edu.all[i] || sc()).sum += v; a.edu.all[i].count++;
      a.edu.totalAll.sum += v; a.edu.totalAll.count++;
    });
    for (const it of r.instructors || []) {
      const kind = teacherKindOf(it.instructorId);
      const key = `${it.instructorId}|${r.courseId}|${it.subject}`;
      a.inst.groups[kind] = a.inst.groups[kind] || {};
      const g = a.inst.groups[kind][key] = a.inst.groups[kind][key] ||
        { name: it.instructorName, affiliation: getInstructorById(it.instructorId)?.affiliation || "", courseName: courseNameOf(r.courseId), subject: it.subject, items: [sc(), sc(), sc()], n: 0 };
      g.n++;
      INSTRUCTOR_ITEMS.forEach((_, i) => { const v = it[`q${i}`]; if (Number.isFinite(v)) { g.items[i].sum += v; g.items[i].count++; } });
    }
  }
  return a;
}

// 두 집계 병합(월별 스냅샷 누적/기간 합산).
export function mergeAgg(a, b) {
  a.count += b.count || 0;
  for (const t in b.edu.cells) { a.edu.cells[t] = a.edu.cells[t] || {}; for (const i in b.edu.cells[t]) { a.edu.cells[t][i] = a.edu.cells[t][i] || sc(); add(a.edu.cells[t][i], b.edu.cells[t][i]); } }
  for (const i in b.edu.all) { a.edu.all[i] = a.edu.all[i] || sc(); add(a.edu.all[i], b.edu.all[i]); }
  for (const t in b.edu.nByType) a.edu.nByType[t] = (a.edu.nByType[t] || 0) + b.edu.nByType[t];
  add(a.edu.totalAll, b.edu.totalAll);
  for (const k in b.inst.groups) {
    a.inst.groups[k] = a.inst.groups[k] || {};
    for (const key in b.inst.groups[k]) {
      const bg = b.inst.groups[k][key];
      const ag = a.inst.groups[k][key] = a.inst.groups[k][key] || { name: bg.name, affiliation: bg.affiliation || "", courseName: bg.courseName, subject: bg.subject, items: [sc(), sc(), sc()], n: 0 };
      ag.n += bg.n; bg.items.forEach((s, i) => add(ag.items[i], s));
    }
  }
  return a;
}

// ── Firestore 저장용 직렬화(맵 키에 '/' 등이 있어도 안전하도록 배열화) ──
export function serializeAgg(a) {
  return {
    count: a.count,
    eduCells: Object.entries(a.edu.cells).map(([type, items]) => ({
      type, n: a.edu.nByType[type] || 0,
      items: Object.entries(items).map(([i, v]) => ({ i: Number(i), sum: v.sum, count: v.count })),
    })),
    eduAll: Object.entries(a.edu.all).map(([i, v]) => ({ i: Number(i), sum: v.sum, count: v.count })),
    eduTotalAll: a.edu.totalAll,
    inst: Object.entries(a.inst.groups).map(([kind, rows]) => ({
      kind,
      rows: Object.values(rows).map((g) => ({ name: g.name, affiliation: g.affiliation || "", courseName: g.courseName, subject: g.subject, n: g.n, items: g.items })),
    })),
  };
}
export function deserializeAgg(d) {
  const a = emptyAgg();
  a.count = d.count || 0;
  for (const c of d.eduCells || []) { a.edu.cells[c.type] = {}; a.edu.nByType[c.type] = c.n || 0; for (const it of c.items) a.edu.cells[c.type][it.i] = { sum: it.sum, count: it.count }; }
  for (const it of d.eduAll || []) a.edu.all[it.i] = { sum: it.sum, count: it.count };
  a.edu.totalAll = d.eduTotalAll || sc();
  for (const grp of d.inst || []) { a.inst.groups[grp.kind] = {}; (grp.rows || []).forEach((g, idx) => { a.inst.groups[grp.kind][`${idx}`] = { name: g.name, affiliation: g.affiliation || "", courseName: g.courseName, subject: g.subject, n: g.n, items: g.items }; }); }
  return a;
}

// ── 렌더 ──
const mean100 = (s) => (s && s.count ? (s.sum / s.count) * 20 : null);
const fmt = (v) => (v == null ? "-" : v.toFixed(2));

export function renderEduHTML(a) {
  if (!a.count) return `<p class="empty">해당 기간 응답이 없습니다.</p>`;
  const types = Object.keys(a.edu.cells).sort();
  const head = `<tr><th>구분</th>${types.map((t) => `<th>${escapeHtml(t)}<br>(n=${a.edu.nByType[t] || 0})</th>`).join("")}<th>전체 평균</th></tr>`;
  const rows = EDU_ITEMS.map((item, i) => {
    const tds = types.map((t) => `<td>${fmt(mean100(a.edu.cells[t][i]))}</td>`).join("");
    return `<tr><td>${escapeHtml(item)}</td>${tds}<td>${fmt(mean100(a.edu.all[i]))}</td></tr>`;
  }).join("");
  const sumTds = types.map((t) => {
    const tot = sc();
    for (const i in a.edu.cells[t]) add(tot, a.edu.cells[t][i]);
    return `<td><b>${fmt(mean100(tot))}</b></td>`;
  }).join("");
  const totalRow = `<tr class="sum-row"><td>응답자 수 가중평균(종합)</td>${sumTds}<td><b>${fmt(mean100(a.edu.totalAll))}</b></td></tr>`;
  return `<table><thead>${head}</thead><tbody>${rows}${totalRow}</tbody></table>`;
}

export function renderInstHTML(a) {
  const kinds = Object.keys(a.inst.groups).sort();
  if (!kinds.length) return `<p class="empty">강사 만족도 응답이 없습니다.</p>`;
  // 동명이인 판정: 같은 이름에 서로 다른 소속이 둘 이상 있을 때만 소속을 병기해 구분.
  // (한 강사가 여러 과목을 맡아도 소속은 하나이므로 오탐 없음.)
  const affByName = {};
  for (const kind of kinds) for (const g of Object.values(a.inst.groups[kind])) (affByName[g.name] = affByName[g.name] || new Set()).add(g.affiliation || "");
  const dispName = (g) => (affByName[g.name] && affByName[g.name].size > 1 && g.affiliation) ? `${g.name}(${g.affiliation})` : g.name;
  const head = `<tr><th>교관유형</th><th>강사</th><th>과정명(과목명)</th>${INSTRUCTOR_ITEMS.map((t) => `<th>${escapeHtml(t)}</th>`).join("")}<th>강사별 평균</th><th>n</th></tr>`;
  let body = "";
  for (const kind of kinds) {
    const rows = Object.values(a.inst.groups[kind]).sort((x, y) => x.name.localeCompare(y.name));
    rows.forEach((g, idx) => {
      const itemMeans = g.items.map((s) => mean100(s));
      const itemTds = itemMeans.map((m) => `<td>${fmt(m)}</td>`).join("");
      const overall = (() => { const v = itemMeans.filter((x) => x != null); return v.length ? v.reduce((p, c) => p + c, 0) / v.length : null; })();
      body += `<tr>${idx === 0 ? `<td rowspan="${rows.length}">${escapeHtml(kind)}</td>` : ""}<td>${escapeHtml(dispName(g))}</td><td>${escapeHtml(g.courseName)}(${escapeHtml(g.subject)})</td>${itemTds}<td><b>${fmt(overall)}</b></td><td style="text-align:right">${g.n}</td></tr>`;
    });
  }
  return `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
}
