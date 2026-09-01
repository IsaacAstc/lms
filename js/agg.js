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
  if (c?.courseType) return c.courseType; // 차수에 지정된 과정유형 우선.
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
  // eduItems/instItems: 집계에 사용된 문항 라벨(응답 스냅샷 우선, 없으면 현행 상수).
  return {
    count: 0, eduItems: null, instItems: null,
    edu: { cells: {}, all: {}, nByType: {}, totalAll: sc() }, inst: { groups: {} },
    ox: {},     // O/X 문항: label → {yes, no}
    extra: {},  // 카테고리 5점 문항: catTitle → {label → {sum, count}}
    choice: {}, // 선다형·복수 응답: label → {n(응답자), multi, opts: {보기 → count}}
    ftx: {},    // 자유·조건부 주관식 응답 건수: label → n (원문 파기 후 건수만 보존)
  };
}

// 응답들에서 문항 스냅샷을 찾는다(없으면 현행 상수 — 과거 데이터 하위호환).
function itemsOf(responses) {
  const r1 = responses.find((r) => Array.isArray(r.eduItems) && r.eduItems.length);
  const r2 = responses.find((r) => Array.isArray(r.instructorItems) && r.instructorItems.length);
  return {
    eduItems: r1 ? r1.eduItems.slice() : EDU_ITEMS.slice(),
    instItems: r2 ? r2.instructorItems.slice() : INSTRUCTOR_ITEMS.slice(),
  };
}

// 표시용 문항 목록(집계에 저장된 것 우선).
export function eduItemsOf(a) { return (a?.eduItems?.length ? a.eduItems : EDU_ITEMS); }
export function instItemsOf(a) { return (a?.instItems?.length ? a.instItems : INSTRUCTOR_ITEMS); }

// 원문 응답 배열 → 집계.
export function computeAgg(responses) {
  const a = emptyAgg();
  const snap = itemsOf(responses);
  a.eduItems = snap.eduItems;
  a.instItems = snap.instItems;
  for (const r of responses) {
    a.count++;
    const type = courseTypeOf(r.courseId);
    a.edu.cells[type] = a.edu.cells[type] || {};
    a.edu.nByType[type] = (a.edu.nByType[type] || 0) + 1;
    a.eduItems.forEach((_, i) => {
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
        { name: it.instructorName, affiliation: getInstructorById(it.instructorId)?.affiliation || "", courseName: courseNameOf(r.courseId), subject: it.subject, items: a.instItems.map(() => sc()), n: 0 };
      g.n++;
      a.instItems.forEach((_, i) => { const v = it[`q${i}`]; if (Number.isFinite(v)) { (g.items[i] = g.items[i] || sc()).sum += v; g.items[i].count++; } });
    }
    // O/X·추가 카테고리: 응답에 저장된 라벨 스냅샷 기준(라벨이 같으면 합산).
    for (const o of r.oxAnswers || []) {
      if (!o || !o.label) continue;
      const t = a.ox[o.label] = a.ox[o.label] || { yes: 0, no: 0 };
      if (o.yes) t.yes++; else t.no++;
    }
    for (const x of r.extraAnswers || []) {
      if (!x || !x.cat || !x.label || !Number.isFinite(x.v)) continue;
      const cat = a.extra[x.cat] = a.extra[x.cat] || {};
      const s = cat[x.label] = cat[x.label] || sc();
      s.sum += x.v; s.count++;
    }
    for (const c of r.choiceAnswers || []) {
      if (!c || !c.label || !Array.isArray(c.options)) continue;
      const t = a.choice[c.label] = a.choice[c.label] || { n: 0, multi: !!c.multi, opts: {} };
      t.n++;
      for (const o of c.options) if (o) t.opts[o] = (t.opts[o] || 0) + 1;
    }
    for (const t of [...(r.freeExtra || []), ...(r.fuTexts || [])]) {
      if (t?.label && t?.text) a.ftx[t.label] = (a.ftx[t.label] || 0) + 1;
    }
  }
  return a;
}

// 두 집계 병합(월별 스냅샷 누적/기간 합산).
export function mergeAgg(a, b) {
  a.count += b.count || 0;
  if (!a.eduItems?.length && b.eduItems?.length) a.eduItems = b.eduItems.slice();
  if (!a.instItems?.length && b.instItems?.length) a.instItems = b.instItems.slice();
  for (const t in b.edu.cells) { a.edu.cells[t] = a.edu.cells[t] || {}; for (const i in b.edu.cells[t]) { a.edu.cells[t][i] = a.edu.cells[t][i] || sc(); add(a.edu.cells[t][i], b.edu.cells[t][i]); } }
  for (const i in b.edu.all) { a.edu.all[i] = a.edu.all[i] || sc(); add(a.edu.all[i], b.edu.all[i]); }
  for (const t in b.edu.nByType) a.edu.nByType[t] = (a.edu.nByType[t] || 0) + b.edu.nByType[t];
  add(a.edu.totalAll, b.edu.totalAll);
  for (const k in b.inst.groups) {
    a.inst.groups[k] = a.inst.groups[k] || {};
    for (const key in b.inst.groups[k]) {
      const bg = b.inst.groups[k][key];
      const ag = a.inst.groups[k][key] = a.inst.groups[k][key] || { name: bg.name, affiliation: bg.affiliation || "", courseName: bg.courseName, subject: bg.subject, items: bg.items.map(() => sc()), n: 0 };
      ag.n += bg.n; bg.items.forEach((s, i) => add(ag.items[i] = ag.items[i] || sc(), s));
    }
  }
  for (const lb in b.ox || {}) {
    const t = a.ox[lb] = a.ox[lb] || { yes: 0, no: 0 };
    t.yes += b.ox[lb].yes || 0; t.no += b.ox[lb].no || 0;
  }
  for (const c in b.extra || {}) {
    a.extra[c] = a.extra[c] || {};
    for (const lb in b.extra[c]) add(a.extra[c][lb] = a.extra[c][lb] || sc(), b.extra[c][lb]);
  }
  for (const lb in b.choice || {}) {
    const bt = b.choice[lb];
    const t = a.choice[lb] = a.choice[lb] || { n: 0, multi: !!bt.multi, opts: {} };
    t.n += bt.n || 0;
    for (const o in bt.opts || {}) t.opts[o] = (t.opts[o] || 0) + bt.opts[o];
  }
  for (const lb in b.ftx || {}) a.ftx[lb] = (a.ftx[lb] || 0) + b.ftx[lb];
  return a;
}

// ── Firestore 저장용 직렬화(맵 키에 '/' 등이 있어도 안전하도록 배열화) ──
export function serializeAgg(a) {
  return {
    count: a.count,
    eduItems: eduItemsOf(a),
    instItems: instItemsOf(a),
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
    ox: Object.entries(a.ox).map(([label, v]) => ({ label, yes: v.yes || 0, no: v.no || 0 })),
    extra: Object.entries(a.extra).map(([cat, items]) => ({
      cat, items: Object.entries(items).map(([label, s]) => ({ label, sum: s.sum, count: s.count })),
    })),
    choice: Object.entries(a.choice).map(([label, t]) => ({
      label, n: t.n, multi: !!t.multi, opts: Object.entries(t.opts).map(([option, count]) => ({ option, count })),
    })),
    ftx: Object.entries(a.ftx).map(([label, n]) => ({ label, n })),
  };
}
export function deserializeAgg(d) {
  const a = emptyAgg();
  a.count = d.count || 0;
  a.eduItems = Array.isArray(d.eduItems) && d.eduItems.length ? d.eduItems : null;
  a.instItems = Array.isArray(d.instItems) && d.instItems.length ? d.instItems : null;
  for (const c of d.eduCells || []) { a.edu.cells[c.type] = {}; a.edu.nByType[c.type] = c.n || 0; for (const it of c.items) a.edu.cells[c.type][it.i] = { sum: it.sum, count: it.count }; }
  for (const it of d.eduAll || []) a.edu.all[it.i] = { sum: it.sum, count: it.count };
  a.edu.totalAll = d.eduTotalAll || sc();
  for (const grp of d.inst || []) { a.inst.groups[grp.kind] = {}; (grp.rows || []).forEach((g, idx) => { a.inst.groups[grp.kind][`${idx}`] = { name: g.name, affiliation: g.affiliation || "", courseName: g.courseName, subject: g.subject, n: g.n, items: g.items }; }); }
  for (const o of d.ox || []) a.ox[o.label] = { yes: o.yes || 0, no: o.no || 0 };
  for (const c of d.extra || []) { a.extra[c.cat] = {}; for (const it of c.items || []) a.extra[c.cat][it.label] = { sum: it.sum, count: it.count }; }
  for (const c of d.choice || []) a.choice[c.label] = { n: c.n || 0, multi: !!c.multi, opts: Object.fromEntries((c.opts || []).map((o) => [o.option, o.count || 0])) };
  for (const f of d.ftx || []) a.ftx[f.label] = f.n || 0;
  return a;
}

// ── 렌더 ──
const mean100 = (s) => (s && s.count ? (s.sum / s.count) * 20 : null);
const fmt = (v) => (v == null ? "-" : v.toFixed(2));

export function renderEduHTML(a) {
  if (!a.count) return `<p class="empty">해당 기간 응답이 없습니다.</p>`;
  const types = Object.keys(a.edu.cells).sort();
  const head = `<tr><th>구분</th>${types.map((t) => `<th>${escapeHtml(t)}<br>(n=${a.edu.nByType[t] || 0})</th>`).join("")}<th>전체 평균</th></tr>`;
  const rows = eduItemsOf(a).map((item, i) => {
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

// O/X(예/아니오) 문항: 건수 + '예' 비율(%) 표. 문항이 없으면 빈 문자열(호출부에서 섹션 숨김).
export function renderOxHTML(a) {
  const labels = Object.keys(a?.ox || {});
  if (!labels.length) return "";
  const rows = labels.map((lb) => {
    const t = a.ox[lb];
    const n = (t.yes || 0) + (t.no || 0);
    const pct = n ? ((t.yes / n) * 100).toFixed(2) + "%" : "-";
    return `<tr><td>${escapeHtml(lb)}</td>
      <td style="text-align:right">${n}</td>
      <td style="text-align:right">${t.yes || 0}</td>
      <td style="text-align:right">${t.no || 0}</td>
      <td style="text-align:right"><b>${pct}</b></td></tr>`;
  }).join("");
  return `<table><thead><tr><th>문항</th><th>응답수</th><th>예</th><th>아니오</th><th>예 비율</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// 선다형·복수 응답: 문항별 보기 분포 표(건수 + 비율%). 없으면 빈 문자열.
export function renderChoiceHTML(a) {
  const labels = Object.keys(a?.choice || {});
  if (!labels.length) return "";
  return labels.map((lb) => {
    const t = a.choice[lb];
    const rows = Object.keys(t.opts).map((o) => {
      const pct = t.n ? ((t.opts[o] / t.n) * 100).toFixed(2) + "%" : "-";
      return `<tr><td>${escapeHtml(o)}</td><td style="text-align:right">${t.opts[o]}</td><td style="text-align:right">${pct}</td></tr>`;
    }).join("");
    return `<p class="hint" style="margin-bottom:0.2rem"><b>${escapeHtml(lb)}</b> — ${t.multi ? "복수 응답" : "택1"} · 응답 ${t.n}건${t.multi ? " (비율은 응답자 대비)" : ""}</p>
      <table><thead><tr><th>보기</th><th>선택</th><th>비율</th></tr></thead><tbody>${rows}</tbody></table>`;
  }).join("");
}

// 자유·조건부 주관식 응답 건수(원문 파기 후 스냅샷용). 없으면 빈 문자열.
export function renderFtxHTML(a) {
  const labels = Object.keys(a?.ftx || {});
  if (!labels.length) return "";
  const rows = labels.map((lb) =>
    `<tr><td>${escapeHtml(lb)}</td><td style="text-align:right">${a.ftx[lb]}</td></tr>`).join("");
  return `<table><thead><tr><th>주관식 문항(자유·조건부)</th><th>응답 건수</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// 카테고리 5점 문항: 카테고리별 표(100점 환산 평균). 없으면 빈 문자열.
export function renderExtraHTML(a) {
  const cats = Object.keys(a?.extra || {}).sort();
  if (!cats.length) return "";
  return cats.map((cat) => {
    const items = a.extra[cat];
    const rows = Object.keys(items).map((lb) =>
      `<tr><td>${escapeHtml(lb)}</td>
        <td style="text-align:right">${items[lb].count}</td>
        <td style="text-align:right"><b>${fmt(mean100(items[lb]))}</b></td></tr>`).join("");
    const tot = sc();
    for (const lb in items) add(tot, items[lb]);
    return `<p class="hint" style="margin-bottom:0.2rem"><b>${escapeHtml(cat)}</b></p>
      <table><thead><tr><th>문항</th><th>응답수</th><th>평균(100)</th></tr></thead>
      <tbody>${rows}<tr class="sum-row"><td><b>카테고리 평균</b></td><td style="text-align:right"><b>${tot.count}</b></td><td style="text-align:right"><b>${fmt(mean100(tot))}</b></td></tr></tbody></table>`;
  }).join("");
}

// 운영 보고서용: 같은 강사(교관유형 내)를 한 행으로 합쳐 표시.
//  - 강사 열은 항상 '이름(소속)' 형태(소속 없으면 이름만).
//  - 과정명 열은 출강 과정명을 중복 제거해 한 셀에 나열.
//  - 문항별 점수는 응답 수 가중평균(과목별 sum/count 합산), n은 과목별 응답 합계.
// 열 방향(항목별) 종합: 그룹들의 문항별 sum/count를 그대로 합산(응답자 수 가중)한 행 생성.
// firstCells: 행 맨 앞 셀 HTML(colspan 처리 포함).
function instTotalRow(groups, items, firstCells) {
  const tot = items.map(() => sc());
  let n = 0;
  for (const g of groups) {
    n += g.n;
    items.forEach((_, i) => { const s = g.items[i]; if (s) add(tot[i], s); });
  }
  const all = sc();
  tot.forEach((s) => add(all, s));
  return `<tr class="sum-row">${firstCells}${tot.map((s) => `<td><b>${fmt(mean100(s))}</b></td>`).join("")}<td><b>${fmt(mean100(all))}</b></td><td style="text-align:right"><b>${n}</b></td></tr>`;
}

export function renderInstMergedHTML(a) {
  const kinds = Object.keys(a.inst.groups).sort();
  if (!kinds.length) return `<p class="empty">강사 만족도 응답이 없습니다.</p>`;
  const items = instItemsOf(a);
  const head = `<tr><th>교관유형</th><th>강사(소속)</th><th>과정명</th>${items.map((t) => `<th>${escapeHtml(t)}</th>`).join("")}<th>강사별 평균</th><th>n</th></tr>`;
  let body = "";
  for (const kind of kinds) {
    // 그룹 키(instructorId|courseId|subject)의 강사 ID 기준으로 병합.
    const merged = {};
    for (const [key, g] of Object.entries(a.inst.groups[kind])) {
      const instId = key.split("|")[0] || `${g.name}|${g.affiliation || ""}`;
      const m = merged[instId] = merged[instId] || {
        name: g.name, affiliation: g.affiliation || "",
        courses: new Set(), items: items.map(() => ({ sum: 0, count: 0 })), n: 0,
      };
      if (g.courseName) m.courses.add(g.courseName);
      m.n += g.n;
      items.forEach((_, i) => { const s = g.items[i]; if (s) { m.items[i].sum += s.sum; m.items[i].count += s.count; } });
    }
    const rows = Object.values(merged).sort((x, y) => x.name.localeCompare(y.name));
    rows.forEach((m, idx) => {
      const itemMeans = m.items.map((s) => mean100(s));
      const itemTds = itemMeans.map((v) => `<td>${fmt(v)}</td>`).join("");
      const overall = (() => { const v = itemMeans.filter((x) => x != null); return v.length ? v.reduce((p, c) => p + c, 0) / v.length : null; })();
      const nameCell = `${escapeHtml(m.name)}${m.affiliation ? `(${escapeHtml(m.affiliation)})` : ""}`;
      body += `<tr>${idx === 0 ? `<td rowspan="${rows.length + 1}">${escapeHtml(kind)}</td>` : ""}<td>${nameCell}</td><td>${[...m.courses].map(escapeHtml).join(", ")}</td>${itemTds}<td><b>${fmt(overall)}</b></td><td style="text-align:right">${m.n}</td></tr>`;
    });
    // 교관유형 소계(항목별 응답자 수 가중평균).
    body += instTotalRow(Object.values(a.inst.groups[kind]), items, `<td colspan="2"><b>소계(응답자 수 가중)</b></td>`);
  }
  // 전체 평균(항목별 응답자 수 가중평균).
  body += instTotalRow(kinds.flatMap((k) => Object.values(a.inst.groups[k])), items, `<td colspan="3"><b>전체 평균(응답자 수 가중)</b></td>`);
  return `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
}

export function renderInstHTML(a) {
  const kinds = Object.keys(a.inst.groups).sort();
  if (!kinds.length) return `<p class="empty">강사 만족도 응답이 없습니다.</p>`;
  // 동명이인 판정: 같은 이름에 서로 다른 소속이 둘 이상 있을 때만 소속을 병기해 구분.
  // (한 강사가 여러 과목을 맡아도 소속은 하나이므로 오탐 없음.)
  const affByName = {};
  for (const kind of kinds) for (const g of Object.values(a.inst.groups[kind])) (affByName[g.name] = affByName[g.name] || new Set()).add(g.affiliation || "");
  const dispName = (g) => (affByName[g.name] && affByName[g.name].size > 1 && g.affiliation) ? `${g.name}(${g.affiliation})` : g.name;
  const head = `<tr><th>교관유형</th><th>강사</th><th>과정명(과목명)</th>${instItemsOf(a).map((t) => `<th>${escapeHtml(t)}</th>`).join("")}<th>강사별 평균</th><th>n</th></tr>`;
  let body = "";
  for (const kind of kinds) {
    const rows = Object.values(a.inst.groups[kind]).sort((x, y) => x.name.localeCompare(y.name));
    rows.forEach((g, idx) => {
      const itemMeans = g.items.map((s) => mean100(s));
      const itemTds = itemMeans.map((m) => `<td>${fmt(m)}</td>`).join("");
      const overall = (() => { const v = itemMeans.filter((x) => x != null); return v.length ? v.reduce((p, c) => p + c, 0) / v.length : null; })();
      body += `<tr>${idx === 0 ? `<td rowspan="${rows.length + 1}">${escapeHtml(kind)}</td>` : ""}<td>${escapeHtml(dispName(g))}</td><td>${escapeHtml(g.courseName)}(${escapeHtml(g.subject)})</td>${itemTds}<td><b>${fmt(overall)}</b></td><td style="text-align:right">${g.n}</td></tr>`;
    });
    body += instTotalRow(Object.values(a.inst.groups[kind]), instItemsOf(a), `<td colspan="2"><b>소계(응답자 수 가중)</b></td>`);
  }
  body += instTotalRow(kinds.flatMap((k) => Object.values(a.inst.groups[k])), instItemsOf(a), `<td colspan="3"><b>전체 평균(응답자 수 가중)</b></td>`);
  return `<table><thead>${head}</thead><tbody>${body}</tbody></table>`;
}
