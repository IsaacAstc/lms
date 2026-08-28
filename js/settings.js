// 기준값 설정: 강사료(강사유형별 단가·월상한), 여비(소속지별 금액).
// 각 행의 키(강사유형/소속지)까지 수정 가능하며, 행 복사·삭제·추가를 지원.
import { watchCollection, onCollection, getCache, setDocById } from "./store.js";
import { escapeHtml } from "./app.js";
import { INSTRUCTOR_TYPES, DEFAULT_EDU_ITEMS, DEFAULT_INSTRUCTOR_ITEMS as DEFAULT_INST_ITEMS, DEFAULT_FREE_ITEMS, DEFAULT_SECTION_TITLES } from "./constants.js";


function docByName(name) {
  return getCache("settings").find((d) => d.id === name);
}
export function getFeeRates() {
  return docByName("feeRates")?.rates || {};
}
export function getTravelRates() {
  return docByName("travelRates")?.rates || {};
}

// ── 기준값 개정 이력(발효일자) ──
// settings/{feeRates|travelRates} = { rates, history: [{ from, rates }] }
// 개정 이력이 없으면 현재 rates가 전 기간에 적용(하위호환).
function ratesAt(docName, dateStr) {
  const d = docByName(docName);
  const cur = d?.rates || {};
  const hist = (Array.isArray(d?.history) ? d.history : [])
    .filter((h) => h && h.from && h.rates)
    .sort((a, b) => a.from.localeCompare(b.from));
  if (!hist.length || !dateStr) return cur;
  let picked = hist[0]; // 첫 개정 이전 일자는 최초 개정본을 적용.
  for (const h of hist) { if (h.from <= dateStr) picked = h; else break; }
  return picked.rates || cur;
}
export function getFeeRatesAt(dateStr) { return ratesAt("feeRates", dateStr); }
export function getTravelRatesAt(dateStr) { return ratesAt("travelRates", dateStr); }
// ── 설문 문항(교육/강사) — 발효일자 이력 ──
// settings/surveyItems = { eduItems, instructorItems, history: [{from, eduItems, instructorItems}] }
export function getSurveyItems() {
  const d = docByName("surveyItems");
  return {
    eduItems: Array.isArray(d?.eduItems) ? d.eduItems : null,
    instructorItems: Array.isArray(d?.instructorItems) ? d.instructorItems : null,
  };
}
export function getSurveyItemsAt(dateStr) {
  const d = docByName("surveyItems");
  const cur = {
    eduItems: Array.isArray(d?.eduItems) ? d.eduItems : null,
    instructorItems: Array.isArray(d?.instructorItems) ? d.instructorItems : null,
  };
  const hist = (Array.isArray(d?.history) ? d.history : [])
    .filter((h) => h && h.from)
    .sort((a, b) => a.from.localeCompare(b.from));
  if (!hist.length || !dateStr) return cur;
  let picked = hist[0]; // 첫 개정 이전은 최초 개정본 적용.
  for (const h of hist) { if (h.from <= dateStr) picked = h; else break; }
  return {
    eduItems: Array.isArray(picked.eduItems) ? picked.eduItems : cur.eduItems,
    instructorItems: Array.isArray(picked.instructorItems) ? picked.instructorItems : cur.instructorItems,
  };
}

// 추가 문항 세트 목록: [{ id, name, eduItems, instructorItems }]
export function getSurveySets() {
  const d = docByName("surveyItems");
  return (Array.isArray(d?.sets) ? d.sets : []).filter((x) => x && x.id);
}

// ── 문항 카테고리(섹션) 빌더 모델 ──
// 교육·강사 만족도(집계 표준의 뼈대)를 제외한 모든 문항은 sections에 담는다:
//   sections: [{title, items: [{type, label, options?, slot?}]}]
//   type: scale(5점) | ox(예/아니오) | text(주관식) | choice(선다형 택1) | multi(복수 응답)
//   slot: 'dis'|'sug' — 기본 주관식 2종의 역할 표식(원문 분류·보고서 2종 구분 유지). 각 1개까지.
// 발효일자 이력 없이 현재값만 유지(세트별 별도 저장). 구버전 필드(freeItems 등)는 읽을 때 변환.
export const Q_TYPES = [
  ["scale", "5점 척도"], ["ox", "예/아니오"], ["text", "주관식"],
  ["choice", "선다형(택1)"], ["multi", "복수 응답"], ["fu", "조건부 후속"],
];
const Q_TYPE_IDS = Q_TYPES.map(([t]) => t);

function normQuestion(q) {
  if (!q || typeof q.label !== "string" || !q.label || !Q_TYPE_IDS.includes(q.type)) return null;
  if (q.type === "fu") {
    // 조건부 후속: 대상 문항(q)·조건·후속 유형을 함께 보관. 설문에서는 대상 문항 아래에 렌더.
    if (!q.q || !["yes", "no", "score"].includes(q.cond) || !["text", "ox"].includes(q.futype)) return null;
    return { type: "fu", label: q.label, q: q.q, cond: q.cond, maxScore: q.maxScore || 2, futype: q.futype, options: [], slot: null };
  }
  return {
    type: q.type, label: q.label,
    options: Array.isArray(q.options) ? q.options.filter(Boolean) : [],
    slot: q.slot === "dis" || q.slot === "sug" ? q.slot : null,
  };
}
// 섹션 내 fu 항목들 → buildSurvey용 followUps 형식으로 변환.
function followUpsFromSections(sections) {
  return (sections || []).flatMap((s) => s.items.filter((q) => q.type === "fu")
    .map((q) => ({ q: q.q, cond: q.cond, maxScore: q.cond === "score" ? (q.maxScore || 2) : null, type: q.futype, label: q.label })));
}
// sections 정규화: 신형 필드가 있으면 그대로, 없으면 구버전 필드(주관식·O/X·추가 카테고리)를 변환.
function sectionsOf(src) {
  if (Array.isArray(src?.sections)) {
    const out = src.sections
      .map((s) => ({ title: (s?.title || "").trim(), items: (Array.isArray(s?.items) ? s.items : []).map(normQuestion).filter(Boolean) }))
      .filter((s) => s.title && s.items.length);
    // 과도기 문서: 별도 저장된 followUps 중 섹션에 fu 항목으로 없는 것은 대상 문항 뒤(없으면 마지막 섹션)에 주입.
    const have = new Set(out.flatMap((s) => s.items.filter((q) => q.type === "fu").map((q) => `${q.q}|${q.label}`)));
    for (const f of (Array.isArray(src.followUps) ? src.followUps : [])) {
      if (!f || !f.q || !f.label || have.has(`${f.q}|${f.label}`)) continue;
      const item = { type: "fu", label: f.label, q: f.q, cond: f.cond, maxScore: f.maxScore || 2, futype: f.type, options: [], slot: null };
      if (!normQuestion(item)) continue;
      const sec = out.find((s) => s.items.some((x) => x.label === f.q)) || out[out.length - 1];
      if (!sec) continue;
      const pi = sec.items.findIndex((x) => x.label === f.q);
      sec.items.splice(pi >= 0 ? pi + 1 : sec.items.length, 0, item);
    }
    return out; // 빈 배열도 '의도적 0개'로 유지.
  }
  if (!src) return null;
  // ── 구버전 변환 ──
  const t = (src.titles && typeof src.titles === "object") ? { ...DEFAULT_SECTION_TITLES, ...src.titles } : DEFAULT_SECTION_TITLES;
  const out = [];
  const cats = Array.isArray(src.extraCats) ? src.extraCats.filter((c) => c && c.title && Array.isArray(c.items) && c.items.length) : [];
  for (const c of cats) out.push({ title: c.title, items: c.items.filter(Boolean).map((lb) => ({ type: "scale", label: lb, options: [], slot: null })) });
  const ox = Array.isArray(src.oxItems) ? src.oxItems.filter(Boolean) : [];
  if (ox.length) out.push({ title: t.ox, items: ox.map((lb) => ({ type: "ox", label: lb, options: [], slot: null })) });
  const freeItems = [];
  if (Array.isArray(src.freeItems) && src.freeItems.length === 2) {
    src.freeItems.forEach((x, i) => {
      const slot = i === 0 ? "dis" : "sug";
      if (typeof x === "string") freeItems.push({ type: "text", label: x, options: [], slot });
      else if (x && x.use !== false) freeItems.push({ type: "text", label: x.label || DEFAULT_FREE_ITEMS[i], options: [], slot });
    });
  } else {
    DEFAULT_FREE_ITEMS.forEach((lb, i) => freeItems.push({ type: "text", label: lb, options: [], slot: i === 0 ? "dis" : "sug" }));
  }
  for (const lb of (Array.isArray(src.freeExtraItems) ? src.freeExtraItems.filter(Boolean) : []))
    freeItems.push({ type: "text", label: lb, options: [], slot: null });
  if (freeItems.length) out.push({ title: t.free, items: freeItems });
  // 구버전의 별도 followUps → 대상 문항 뒤에 fu 항목으로 주입.
  for (const f of (Array.isArray(src.followUps) ? src.followUps : [])) {
    if (!f || !f.q || !f.label) continue;
    const item = { type: "fu", label: f.label, q: f.q, cond: f.cond, maxScore: f.maxScore || 2, futype: f.type, options: [], slot: null };
    if (!normQuestion(item)) continue;
    const sec = out.find((s) => s.items.some((x) => x.label === f.q)) || out[out.length - 1];
    if (!sec) continue;
    const pi = sec.items.findIndex((x) => x.label === f.q);
    sec.items.splice(pi >= 0 ? pi + 1 : sec.items.length, 0, item);
  }
  return out;
}
function extrasOf(src) {
  const sections = sectionsOf(src);
  return {
    titles: (src?.titles && typeof src.titles === "object") ? { ...DEFAULT_SECTION_TITLES, ...src.titles } : null,
    sections,
    // 조건부 후속: 섹션의 fu 항목에서 도출(빌더 통합). 섹션이 없으면 구버전 별도 필드 사용.
    followUps: sections
      ? followUpsFromSections(sections)
      : (Array.isArray(src?.followUps)
        ? src.followUps.filter((f) => f && f.q && f.label && ["yes", "no", "score"].includes(f.cond) && ["text", "ox"].includes(f.type)) : null),
  };
}

// 세트 우선순위로 문항 해석: 차수 지정 > 커리큘럼 지정 > 기본 세트(발효일자 이력).
export function resolveSurveyItems({ setId, dateStr }) {
  if (setId) {
    const set = getSurveySets().find((x) => x.id === setId);
    if (set) {
      return {
        // 빈 배열은 '의도적 0개'(해당 섹션 미표시) — null(미설정 → 기본 문항)과 구분.
        eduItems: Array.isArray(set.eduItems) ? set.eduItems : null,
        instructorItems: Array.isArray(set.instructorItems) ? set.instructorItems : null,
        ...extrasOf(set),
        setId, setName: set.name || "",
      };
    }
  }
  return { ...getSurveyItemsAt(dateStr), ...extrasOf(docByName("surveyItems")), setId: "", setName: "" };
}

export function getRateHistory(docName) {
  const d = docByName(docName);
  return (Array.isArray(d?.history) ? d.history : [])
    .filter((h) => h && h.from)
    .sort((a, b) => a.from.localeCompare(b.from));
}
export function onSettingsChange(cb) {
  return onCollection("settings", cb);
}

// 기준값 저장 공통: 개정 이력이 있으면 '가장 최근 개정본'도 함께 갱신해
// 현재값(rates)과 최신 이력이 어긋나지 않게 한다.
async function saveRates(docName, rates, label) {
  const hist = getRateHistory(docName).map((h) => ({ from: h.from, rates: h.rates }));
  if (hist.length) hist[hist.length - 1] = { ...hist[hist.length - 1], rates };
  try {
    await setDocById("settings", docName, hist.length ? { rates, history: hist } : { rates });
    alert(hist.length
      ? `${label}을 저장했습니다. (가장 최근 개정본 ${hist[hist.length - 1].from}부터 적용)`
      : `${label}을 저장했습니다.`);
  } catch (e) { alert("저장 실패: " + e.message); }
}

// 현재 편집 중인 값을 새 개정본으로 등록(발효일자부터 적용).
async function addRevision(docName, rates, label) {
  const from = document.getElementById(docName === "feeRates" ? "fee-rev-date" : "travel-rev-date").value;
  if (!from) return alert("개정 발효일자를 선택하세요.");
  const hist = getRateHistory(docName).map((h) => ({ from: h.from, rates: h.rates }));
  if (hist.some((h) => h.from === from)) return alert("같은 발효일자의 개정본이 이미 있습니다.");
  // 첫 개정 등록 시, 그 이전 기간은 기존 현재값이 적용되도록 시작 이력을 함께 남긴다.
  if (!hist.length) {
    const base = docName === "feeRates" ? getFeeRates() : getTravelRates();
    if (Object.keys(base).length) hist.push({ from: "1900-01-01", rates: base });
  }
  hist.push({ from, rates });
  hist.sort((a, b) => a.from.localeCompare(b.from));
  const latest = hist[hist.length - 1];
  try {
    await setDocById("settings", docName, { rates: latest.rates, history: hist });
    alert(`${label} 개정본을 등록했습니다. (${from}부터 적용)`);
  } catch (e) { alert("등록 실패: " + e.message); }
}

// 개정 이력 목록 렌더(발효일자 + 삭제).
function renderRevisions(docName, boxId) {
  const box = document.getElementById(boxId);
  if (!box) return;
  const hist = getRateHistory(docName);
  if (!hist.length) {
    box.innerHTML = `<p class="hint">등록된 개정 이력이 없습니다. 현재 기준값이 <b>모든 기간</b>에 적용됩니다.</p>`;
    return;
  }
  box.innerHTML = `<p class="hint">개정 일자를 클릭하면 그 버전을 아래 편집 표로 불러옵니다(저장 전까지 반영되지 않음).</p>
    <div class="chip-row">${hist.map((h, i) =>
    `<span class="chip"><button type="button" class="chip-load" data-i="${i}" title="이 개정본을 편집 표로 불러오기">${escapeHtml(h.from)}부터</button><button type="button" class="chip-del" data-i="${i}">×</button></span>`).join("")}</div>`;
  box.querySelectorAll(".chip-load").forEach((b) => b.addEventListener("click", () => {
    const h = hist[Number(b.dataset.i)];
    if (docName === "feeRates") renderFees(h.rates || {});
    else renderTravel(h.rates || {});
    alert(`${h.from}부터 적용되는 개정본을 편집 표로 불러왔습니다.\n'저장'하면 현재 기준값(및 최신 개정본)이 이 내용으로 바뀌니 주의하세요.`);
  }));
  box.querySelectorAll(".chip-del").forEach((b) => b.addEventListener("click", async () => {
    const i = Number(b.dataset.i);
    if (!confirm(`${hist[i].from}부터 적용되는 개정본을 삭제할까요?\n해당 기간은 직전(또는 최초) 개정본으로 계산됩니다.`)) return;
    const next = hist.filter((_, idx) => idx !== i).map((h) => ({ from: h.from, rates: h.rates }));
    const latest = next[next.length - 1];
    try {
      await setDocById("settings", docName, next.length
        ? { rates: latest.rates, history: next }
        : { rates: (docName === "feeRates" ? getFeeRates() : getTravelRates()), history: [] });
    } catch (e) { alert("삭제 실패: " + e.message); }
  }));
}

// ── 설문 문항 편집(마스터 전용 영역은 index.html에서 제어) ──
function itemListRows(boxId, items) {
  const box = document.getElementById(boxId);
  box.innerHTML = items.length
    ? `<div class="chip-row">${items.map((t, i) =>
        `<span class="chip">${i + 1}.<input class="si-name" data-i="${i}" value="${escapeHtml(t)}" size="18"><button type="button" class="chip-move" data-i="${i}" data-d="-1" title="앞으로">◀</button><button type="button" class="chip-move" data-i="${i}" data-d="1" title="뒤로">▶</button><button type="button" class="chip-del" data-i="${i}">×</button></span>`).join("")}</div>`
    : `<p class="empty">문항이 없습니다.</p>`;
}
// 배열 내 이동(경계 밖이면 무시).
function moveItem(arr, i, d) {
  const j = i + d;
  if (j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
}

let eduDraft = null, instDraft = null;
let titlesDraft = null;    // {edu, inst} — 교육·강사 섹션 제목
let sectionsDraft = null;  // [{title, items:[{type,label,options,slot}]}] — 문항 카테고리 빌더

// 기본값: 주관식 카테고리에 기본 2종(불만족/제안개선) 배치.
function defaultSections() {
  return [{
    title: DEFAULT_SECTION_TITLES.free,
    items: DEFAULT_FREE_ITEMS.map((lb, i) => ({ type: "text", label: lb, options: [], slot: i === 0 ? "dis" : "sug" })),
  }];
}
const cloneSections = (secs) => secs.map((s) => ({ title: s.title, items: s.items.map((q) => ({ ...q, options: q.options.slice() })) }));
let editingSetId = "";   // "" = 기본 세트
let draftLoadedFor = null; // 현재 draft가 어느 세트에서 로드됐는지
let draftFromDoc = false;  // draft가 실제 저장 문서에서 로드됐는지(구독 도착 전 기본값 로드와 구분)

// 편집 대상 세트의 문항을 draft로 로드.
// 최초 렌더는 Firestore 구독이 도착하기 전에 일어날 수 있으므로,
// 문서 없이 기본값으로 만든 draft는 문서가 도착하면 다시 로드한다(편집 유실 방지 겸 최신값 보장).
function loadDraftForSet() {
  const hasDoc = !!docByName("surveyItems");
  if (draftLoadedFor === editingSetId && (draftFromDoc || !hasDoc)) return;
  draftFromDoc = hasDoc;
  if (editingSetId) {
    const set = getSurveySets().find((x) => x.id === editingSetId);
    eduDraft = (set?.eduItems || DEFAULT_EDU_ITEMS).slice();
    instDraft = (set?.instructorItems || DEFAULT_INST_ITEMS).slice();
    titlesDraft = { ...(extrasOf(set).titles || DEFAULT_SECTION_TITLES) };
    sectionsDraft = cloneSections(extrasOf(set).sections ?? defaultSections());
  } else {
    const cur = getSurveyItems();
    const d = docByName("surveyItems");
    // 개정 이력이 있으면 최신 개정본 기준으로 로딩(현재값과 어긋난 경우 대비).
    const hist = (Array.isArray(d?.history) ? d.history : []).filter((h) => h && h.from)
      .sort((a, b) => a.from.localeCompare(b.from));
    const latest = hist[hist.length - 1];
    eduDraft = (Array.isArray(latest?.eduItems) ? latest.eduItems : (cur.eduItems || DEFAULT_EDU_ITEMS)).slice();
    instDraft = (Array.isArray(latest?.instructorItems) ? latest.instructorItems : (cur.instructorItems || DEFAULT_INST_ITEMS)).slice();
    titlesDraft = { ...(extrasOf(d).titles || DEFAULT_SECTION_TITLES) };
    sectionsDraft = cloneSections(extrasOf(d).sections ?? defaultSections());
  }
  draftLoadedFor = editingSetId;
}

function renderSetSelect() {
  const sel = document.getElementById("si-set");
  if (!sel) return;
  const sets = getSurveySets();
  sel.innerHTML = `<option value="">기본 세트</option>`
    + sets.map((x) => `<option value="${escapeHtml(x.id)}"${x.id === editingSetId ? " selected" : ""}>${escapeHtml(x.name || x.id)}</option>`).join("");
  sel.value = editingSetId;
  // 개정 이력은 기본 세트에만 적용.
  document.getElementById("si-rev-group").hidden = !!editingSetId;
  document.getElementById("si-set-del").hidden = !editingSetId;
  document.getElementById("si-set-note").textContent = editingSetId
    ? "추가 세트는 발효일자 이력 없이 현재 문항만 유지됩니다."
    : "기본 세트는 개정 발효일자 이력으로 관리됩니다.";
}

// 저장 버튼 라벨: 개정 이력이 있으면 '무엇을 덮어쓰는지'를 드러낸다(같은 판 정정 vs 개정판 발행 구분).
function saveButtonLabel(baseLabel, hist) {
  return hist.length ? `최신 개정본(${hist[hist.length - 1].from}~) 수정 저장` : baseLabel;
}

function paintSurveyItems() {
  loadDraftForSet();
  renderSetSelect();
  const saveBtn = document.getElementById("si-save");
  if (saveBtn) {
    if (editingSetId) saveBtn.textContent = "문항 세트 저장";
    else {
      const d = docByName("surveyItems");
      const hist = (Array.isArray(d?.history) ? d.history : []).filter((h) => h && h.from)
        .sort((a, b) => a.from.localeCompare(b.from));
      saveBtn.textContent = saveButtonLabel("설문 문항 저장", hist);
    }
  }
  itemListRows("si-edu-list", eduDraft);
  itemListRows("si-inst-list", instDraft);
  bindItemEditors("si-edu-list", eduDraft);
  bindItemEditors("si-inst-list", instDraft);
  // 섹션 제목: 교육·강사(고정 카테고리)만 — 나머지 카테고리 제목은 빌더에서 직접 편집.
  const tbox = document.getElementById("si-titles");
  if (tbox) {
    const T = [["edu", "교육 만족도 제목"], ["inst", "강사 만족도 제목"]];
    tbox.innerHTML = `<div class="chip-row">${T.map(([k, lb]) =>
      `<span class="chip">${lb} <input class="si-title" data-k="${k}" value="${escapeHtml(titlesDraft[k] || DEFAULT_SECTION_TITLES[k])}" size="14"></span>`).join("")}</div>`;
    tbox.querySelectorAll(".si-title").forEach((el) =>
      el.addEventListener("input", (e) => { titlesDraft[e.target.dataset.k] = e.target.value; }));
  }
  renderSectionsBuilder();
  renderItemRevisions();
}

// ── 문항 카테고리(섹션) 빌더 렌더 ──
// 카테고리마다 제목·순서(▲▼)·삭제, 문항마다 유형·문구·보기(선다형/복수)·순서(◀▶)·삭제.
function renderSectionsBuilder() {
  const box = document.getElementById("si-sections");
  if (!box) return;
  box.innerHTML = sectionsDraft.length ? "" : `<p class="hint">카테고리가 없습니다. '카테고리 추가'로 시작하세요.</p>`;
  const slotBadge = (q) => q.slot === "dis" ? `<small class="hint" title="주관식 원문 '불만족' 분류·보고서 구분에 사용">[기본·불만족]</small>`
    : q.slot === "sug" ? `<small class="hint" title="주관식 원문 '제안개선' 분류·보고서 구분에 사용">[기본·제안개선]</small>` : "";
  // 조건부 후속 대상 후보: 교육 문항·카테고리 5점 문항(N점 이하), 카테고리 O/X 문항(예/아니오).
  const secItems = (type) => sectionsDraft.flatMap((s) => s.items.filter((q) => q.type === type).map((q) => q.label.trim()).filter(Boolean));
  const scaleTargets = [...eduDraft.map((t) => t.trim()).filter(Boolean), ...secItems("scale")];
  const oxTargets = secItems("ox");
  const fuTargetOptions = (sel) =>
    `<option value="">대상 문항 선택</option>`
    + (scaleTargets.length ? `<optgroup label="5점 문항">${scaleTargets.map((t) => `<option${t === sel ? " selected" : ""}>${escapeHtml(t)}</option>`).join("")}</optgroup>` : "")
    + (oxTargets.length ? `<optgroup label="O/X 문항">${oxTargets.map((t) => `<option${t === sel ? " selected" : ""}>${escapeHtml(t)}</option>`).join("")}</optgroup>` : "");
  const fuRow = (q, si, i) => `
    <select class="fu-q" data-s="${si}" data-i="${i}">${fuTargetOptions(q.q)}</select>
    <select class="fu-cond" data-s="${si}" data-i="${i}">
      ${oxTargets.includes(q.q)
        ? `<option value="yes"${q.cond === "yes" ? " selected" : ""}>'예' 선택 시</option>
           <option value="no"${q.cond === "no" ? " selected" : ""}>'아니오' 선택 시</option>`
        : `<option value="score"${q.cond === "score" ? " selected" : ""}>N점 이하 선택 시</option>`}
    </select>
    ${q.cond === "score" ? `<label>N= <input type="number" class="fu-score" data-s="${si}" data-i="${i}" min="1" max="4" value="${q.maxScore || 2}" style="width:3.5rem"></label>` : ""}
    <select class="fu-futype" data-s="${si}" data-i="${i}">
      <option value="text"${q.futype === "text" ? " selected" : ""}>후속: 주관식</option>
      <option value="ox"${q.futype === "ox" ? " selected" : ""}>후속: 예/아니오</option>
    </select>
    <input class="sec-q-label" data-s="${si}" data-i="${i}" value="${escapeHtml(q.label)}" placeholder="후속 문항 문구" style="min-width:200px">`;
  sectionsDraft.forEach((sec, si) => {
    const div = document.createElement("div");
    div.className = "load-box";
    div.innerHTML = `<div class="load-row">
        <label>카테고리명 <input class="sec-title" data-s="${si}" value="${escapeHtml(sec.title)}" size="20"></label>
        <select class="sec-add-type" data-s="${si}">${Q_TYPES.map(([t, lb]) => `<option value="${t}">${lb}</option>`).join("")}</select>
        <button type="button" class="sec-item-add" data-s="${si}">문항 추가</button>
        <button type="button" class="sec-move" data-s="${si}" data-d="-1" title="카테고리를 위로">▲</button>
        <button type="button" class="sec-move" data-s="${si}" data-d="1" title="카테고리를 아래로">▼</button>
        <button type="button" class="del sec-del" data-s="${si}">카테고리 삭제</button>
      </div>
      ${sec.items.map((q, i) => `<div class="load-row">
        <span>${i + 1}.</span>
        <span class="hint">${q.type === "fu" ? "↳ 조건부 후속" : escapeHtml(Q_TYPES.find(([t]) => t === q.type)?.[1] || q.type)}</span>
        ${slotBadge(q)}
        ${q.type === "fu" ? fuRow(q, si, i) : `
        <input class="sec-q-label" data-s="${si}" data-i="${i}" value="${escapeHtml(q.label)}" placeholder="문항 문구" style="min-width:220px">
        ${(q.type === "choice" || q.type === "multi")
          ? `<input class="sec-q-opts" data-s="${si}" data-i="${i}" value="${escapeHtml(q.options.join(" / "))}" placeholder="보기 — ' / '로 구분 (예: A / B / C)" style="min-width:220px">`
          : ""}`}
        <button type="button" class="chip-move sec-q-move" data-s="${si}" data-i="${i}" data-d="-1" title="위로">◀</button>
        <button type="button" class="chip-move sec-q-move" data-s="${si}" data-i="${i}" data-d="1" title="아래로">▶</button>
        <button type="button" class="chip-del sec-q-del" data-s="${si}" data-i="${i}"${q.slot ? ` title="기본 주관식은 삭제하면 해당 분류가 설문에서 빠집니다"` : ""}>×</button>
      </div>`).join("")}`;
    box.appendChild(div);
  });
  box.querySelectorAll(".sec-title").forEach((el) =>
    el.addEventListener("input", (e) => { sectionsDraft[+e.target.dataset.s].title = e.target.value; }));
  box.querySelectorAll(".sec-item-add").forEach((b) =>
    b.addEventListener("click", () => {
      const si = +b.dataset.s;
      const type = b.parentElement.querySelector(".sec-add-type").value;
      sectionsDraft[si].items.push(type === "fu"
        ? { type: "fu", label: "", q: "", cond: "score", maxScore: 2, futype: "text", options: [], slot: null }
        : { type, label: "", options: [], slot: null });
      paintSurveyItems();
    }));
  // 조건부 후속 항목 컨트롤.
  box.querySelectorAll(".fu-q").forEach((el) => el.addEventListener("change", (e) => {
    const q = sectionsDraft[+e.target.dataset.s].items[+e.target.dataset.i];
    q.q = e.target.value;
    q.cond = oxTargets.includes(q.q) ? (q.cond === "no" ? "no" : "yes") : "score";
    paintSurveyItems();
  }));
  box.querySelectorAll(".fu-cond").forEach((el) => el.addEventListener("change", (e) => {
    sectionsDraft[+e.target.dataset.s].items[+e.target.dataset.i].cond = e.target.value;
    paintSurveyItems();
  }));
  box.querySelectorAll(".fu-score").forEach((el) => el.addEventListener("input", (e) => {
    sectionsDraft[+e.target.dataset.s].items[+e.target.dataset.i].maxScore = Math.min(4, Math.max(1, Number(e.target.value) || 2));
  }));
  box.querySelectorAll(".fu-futype").forEach((el) => el.addEventListener("change", (e) => {
    sectionsDraft[+e.target.dataset.s].items[+e.target.dataset.i].futype = e.target.value;
  }));
  box.querySelectorAll(".sec-move").forEach((b) =>
    b.addEventListener("click", () => { moveItem(sectionsDraft, +b.dataset.s, +b.dataset.d); paintSurveyItems(); }));
  box.querySelectorAll(".sec-del").forEach((b) =>
    b.addEventListener("click", () => {
      const s = sectionsDraft[+b.dataset.s];
      if (!confirm(`'${s.title || "(이름 없음)"}' 카테고리와 문항 ${s.items.length}개를 삭제할까요?`)) return;
      sectionsDraft.splice(+b.dataset.s, 1); paintSurveyItems();
    }));
  box.querySelectorAll(".sec-q-label").forEach((el) =>
    el.addEventListener("input", (e) => { sectionsDraft[+e.target.dataset.s].items[+e.target.dataset.i].label = e.target.value; }));
  box.querySelectorAll(".sec-q-opts").forEach((el) =>
    el.addEventListener("input", (e) => {
      sectionsDraft[+e.target.dataset.s].items[+e.target.dataset.i].options =
        e.target.value.split("/").map((t) => t.trim()).filter(Boolean);
    }));
  box.querySelectorAll(".sec-q-move").forEach((b) =>
    b.addEventListener("click", () => { moveItem(sectionsDraft[+b.dataset.s].items, +b.dataset.i, +b.dataset.d); paintSurveyItems(); }));
  box.querySelectorAll(".sec-q-del").forEach((b) =>
    b.addEventListener("click", () => { sectionsDraft[+b.dataset.s].items.splice(+b.dataset.i, 1); paintSurveyItems(); }));
}

// 기본 주관식(불만족/제안개선) 슬롯이 없으면 되살리는 버튼용.
function restoreSlot(slot) {
  const label = slot === "dis" ? DEFAULT_FREE_ITEMS[0] : DEFAULT_FREE_ITEMS[1];
  const has = sectionsDraft.some((s) => s.items.some((q) => q.slot === slot));
  if (has) return alert("이미 편집기에 있습니다.");
  let target = sectionsDraft[sectionsDraft.length - 1];
  if (!target) { target = { title: DEFAULT_SECTION_TITLES.free, items: [] }; sectionsDraft.push(target); }
  target.items.push({ type: "text", label, options: [], slot });
  paintSurveyItems();
}

// 세트 저장/추가/삭제.
// 선다형·복수 응답 문항은 보기 2개 이상 필요.
function invalidChoice(items) {
  return items.sections.flatMap((s) => s.items)
    .find((q) => (q.type === "choice" || q.type === "multi") && q.options.length < 2);
}

async function saveCurrentSet() {
  const items = collectItems();
  // 교육·강사 문항 0개 허용 — 비우면 설문에서 해당 섹션이 표시되지 않는다.
  const bad = invalidChoice(items);
  if (bad) return alert(`'${bad.label}' 문항의 보기를 2개 이상 입력하세요(" / "로 구분).`);
  if (!editingSetId) return saveSurveyItems(); // 기본 세트는 기존 로직(이력 연동).
  const d = docByName("surveyItems") || {};
  const sets = getSurveySets().map((x) => (x.id === editingSetId ? { ...x, ...items } : x));
  try {
    await setDocById("settings", "surveyItems", {
      eduItems: d.eduItems || DEFAULT_EDU_ITEMS, instructorItems: d.instructorItems || DEFAULT_INST_ITEMS,
      ...topExtras(),
      history: Array.isArray(d.history) ? d.history : [], sets,
    });
    alert("문항 세트를 저장했습니다.");
  } catch (e) { alert("저장 실패: " + e.message); }
}
async function addSet() {
  const name = (document.getElementById("si-set-new").value || "").trim();
  if (!name) return alert("새 세트 이름을 입력하세요.");
  const sets = getSurveySets();
  if (sets.some((x) => (x.name || "") === name)) return alert("같은 이름의 세트가 이미 있습니다.");
  const d = docByName("surveyItems") || {};
  const id = "set-" + Date.now();
  // 현재 편집 중인 문항을 초기값으로 복제.
  const items = collectItems();
  const next = [...sets, { id, name, ...items }];
  try {
    await setDocById("settings", "surveyItems", {
      eduItems: d.eduItems || DEFAULT_EDU_ITEMS, instructorItems: d.instructorItems || DEFAULT_INST_ITEMS,
      ...topExtras(),
      history: Array.isArray(d.history) ? d.history : [], sets: next,
    });
    document.getElementById("si-set-new").value = "";
    editingSetId = id; draftLoadedFor = null;
    paintSurveyItems();
    alert(`'${name}' 세트를 추가했습니다.`);
  } catch (e) { alert("추가 실패: " + e.message); }
}
async function deleteSet() {
  if (!editingSetId) return;
  const set = getSurveySets().find((x) => x.id === editingSetId);
  if (!confirm(`'${set?.name || editingSetId}' 세트를 삭제할까요?\n이 세트를 쓰던 과정·차수는 기본 세트로 되돌아갑니다.`)) return;
  const d = docByName("surveyItems") || {};
  const next = getSurveySets().filter((x) => x.id !== editingSetId);
  try {
    await setDocById("settings", "surveyItems", {
      eduItems: d.eduItems || DEFAULT_EDU_ITEMS, instructorItems: d.instructorItems || DEFAULT_INST_ITEMS,
      ...topExtras(),
      history: Array.isArray(d.history) ? d.history : [], sets: next,
    });
    editingSetId = ""; draftLoadedFor = null;
    paintSurveyItems();
  } catch (e) { alert("삭제 실패: " + e.message); }
}
function bindItemEditors(boxId, draft) {
  const box = document.getElementById(boxId);
  box.querySelectorAll(".si-name").forEach((el) =>
    el.addEventListener("input", (e) => { draft[+e.target.dataset.i] = e.target.value; }));
  box.querySelectorAll(".chip-del").forEach((b) =>
    b.addEventListener("click", () => { draft.splice(+b.dataset.i, 1); paintSurveyItems(); }));
  box.querySelectorAll(".chip-move").forEach((b) =>
    b.addEventListener("click", () => { moveItem(draft, +b.dataset.i, +b.dataset.d); paintSurveyItems(); }));
}
function collectItems() {
  const sections = sectionsDraft
    .map((s) => ({
      title: (s.title || "").trim(),
      items: s.items
        .map((q) => (q.type === "fu"
          ? { type: "fu", label: (q.label || "").trim(), q: (q.q || "").trim(), cond: q.cond, maxScore: q.maxScore || 2, futype: q.futype, options: [], slot: null }
          : { type: q.type, label: (q.label || "").trim(), options: q.options.map((o) => o.trim()).filter(Boolean), slot: q.slot || null }))
        .filter((q) => q.label && (q.type !== "fu" || (q.q && ["yes", "no", "score"].includes(q.cond) && ["text", "ox"].includes(q.futype)))),
    }))
    .filter((s) => s.title && s.items.length);
  return {
    eduItems: eduDraft.map((t) => t.trim()).filter(Boolean),
    instructorItems: instDraft.map((t) => t.trim()).filter(Boolean),
    titles: Object.fromEntries(Object.keys(DEFAULT_SECTION_TITLES).map((k) =>
      [k, (titlesDraft[k] || "").trim() || DEFAULT_SECTION_TITLES[k]])),
    sections,
    followUps: followUpsFromSections(sections), // buildSurvey 호환용(빌더 fu 항목에서 도출)
  };
}
// 기본 세트 top-level의 주관식·O/X 현행값(세트 편집·삭제 등에서 보존용).
function topExtras() {
  const d = docByName("surveyItems");
  const x = extrasOf(d);
  return {
    titles: x.titles || DEFAULT_SECTION_TITLES,
    sections: x.sections ?? defaultSections(),
    followUps: x.followUps || [],
  };
}
function renderItemRevisions() {
  const box = document.getElementById("si-rev-list");
  if (!box) return;
  const d = docByName("surveyItems");
  const hist = (Array.isArray(d?.history) ? d.history : []).filter((h) => h && h.from)
    .sort((a, b) => a.from.localeCompare(b.from));
  if (!hist.length) {
    box.innerHTML = `<p class="hint">등록된 문항 개정 이력이 없습니다. 현재 문항이 <b>이후 생성되는 설문</b>에 적용됩니다.</p>`;
    return;
  }
  box.innerHTML = `<p class="hint">개정 일자를 클릭하면 그 버전의 교육·강사 문항을 편집기로 불러옵니다(저장 전까지 반영되지 않음).</p>
    <div class="chip-row">${hist.map((h, i) =>
    `<span class="chip"><button type="button" class="chip-load" data-i="${i}" title="이 개정본의 문항을 편집기로 불러오기">${escapeHtml(h.from)}부터 (교육 ${h.eduItems?.length ?? 0}·강사 ${h.instructorItems?.length ?? 0})</button><button type="button" class="chip-del" data-i="${i}">×</button></span>`).join("")}</div>`;
  box.querySelectorAll(".chip-load").forEach((b) => b.addEventListener("click", () => {
    const h = hist[Number(b.dataset.i)];
    eduDraft = Array.isArray(h.eduItems) ? h.eduItems.slice() : [];
    instDraft = Array.isArray(h.instructorItems) ? h.instructorItems.slice() : [];
    paintSurveyItems();
    alert(`${h.from}부터 적용되는 개정본의 교육·강사 문항을 편집기로 불러왔습니다.\n(주관식·O/X 등 나머지 항목은 이력이 없어 그대로입니다)\n'설문 문항 저장'을 누르면 현재 문항(및 최신 개정본)이 이 내용으로 바뀌니 주의하세요.`);
  }));
  box.querySelectorAll(".chip-del").forEach((b) => b.addEventListener("click", async () => {
    const i = Number(b.dataset.i);
    if (!confirm(`${hist[i].from}부터 적용되는 문항 개정본을 삭제할까요?`)) return;
    const next = hist.filter((_, idx) => idx !== i);
    const latest = next[next.length - 1];
    try {
      const cur0 = docByName("surveyItems") || {};
      const sets0 = Array.isArray(cur0.sets) ? cur0.sets : [];
      await setDocById("settings", "surveyItems", latest
        ? { eduItems: latest.eduItems, instructorItems: latest.instructorItems, ...topExtras(), history: next, sets: sets0 }
        : { ...collectItems(), history: [], sets: sets0 });
    } catch (e) { alert("삭제 실패: " + e.message); }
  }));
}
async function saveSurveyItems() {
  const items = collectItems();
  // 교육·강사 문항 0개 허용 — 비우면 설문에서 해당 섹션이 표시되지 않는다.
  const bad = invalidChoice(items);
  if (bad) return alert(`'${bad.label}' 문항의 보기를 2개 이상 입력하세요(" / "로 구분).`);
  const d = docByName("surveyItems");
  const hist = (Array.isArray(d?.history) ? d.history : []).filter((h) => h && h.from)
    .sort((a, b) => a.from.localeCompare(b.from));
  // 이력에는 교육·강사 문항만 보관(주관식·O/X는 현행값만 유지).
  if (hist.length) hist[hist.length - 1] = { ...hist[hist.length - 1], eduItems: items.eduItems, instructorItems: items.instructorItems };
  try {
    const cur = docByName("surveyItems") || {};
    await setDocById("settings", "surveyItems",
      { ...items, history: hist, sets: Array.isArray(cur.sets) ? cur.sets : [] });
    alert("설문 문항을 저장했습니다.");
  } catch (e) { alert("저장 실패: " + e.message); }
}
async function addItemRevision() {
  const from = document.getElementById("si-rev-date").value;
  if (!from) return alert("개정 발효일자를 선택하세요.");
  const items = collectItems();
  // 교육·강사 문항 0개 허용 — 비우면 설문에서 해당 섹션이 표시되지 않는다.
  const d = docByName("surveyItems");
  const hist = (Array.isArray(d?.history) ? d.history : []).filter((h) => h && h.from)
    .sort((a, b) => a.from.localeCompare(b.from));
  if (hist.some((h) => h.from === from)) return alert("같은 발효일자의 개정본이 이미 있습니다.");
  if (!hist.length) {
    const cur = getSurveyItems();
    hist.push({ from: "1900-01-01",
      eduItems: cur.eduItems || DEFAULT_EDU_ITEMS, instructorItems: cur.instructorItems || DEFAULT_INST_ITEMS });
  }
  hist.push({ from, eduItems: items.eduItems, instructorItems: items.instructorItems });
  hist.sort((a, b) => a.from.localeCompare(b.from));
  const latest = hist[hist.length - 1];
  try {
    const cur0 = docByName("surveyItems") || {};
    await setDocById("settings", "surveyItems",
      { eduItems: latest.eduItems, instructorItems: latest.instructorItems,
        titles: items.titles, sections: items.sections, followUps: items.followUps, history: hist,
        sets: Array.isArray(cur0.sets) ? cur0.sets : [] });
    alert(`설문 문항 개정본을 등록했습니다. (${from}부터 생성되는 설문에 적용)`);
  } catch (e) { alert("등록 실패: " + e.message); }
}

export function initSettings() {
  watchCollection("settings");
  onCollection("settings", renderAll);

  document.getElementById("fee-save").addEventListener("click", saveFees);
  document.getElementById("travel-save").addEventListener("click", saveTravel);
  document.getElementById("fee-rev-add").addEventListener("click", () => addRevision("feeRates", collectFees(), "강사료 기준"));
  document.getElementById("travel-rev-add").addEventListener("click", () => addRevision("travelRates", collectTravel(), "여비 기준"));
  document.getElementById("fee-add").addEventListener("click", () =>
    document.getElementById("fee-tbody").appendChild(feeRow("", { firstHour: 0, addHour: 0, monthlyCap: null }))
  );
  document.getElementById("travel-add").addEventListener("click", () =>
    document.getElementById("travel-tbody").appendChild(travelRow("", { amount: 0, manual: false, note: "" }))
  );

  // 설문 문항 편집.
  document.getElementById("si-edu-add").addEventListener("click", () => { eduDraft.push(""); paintSurveyItems(); });
  document.getElementById("si-inst-add").addEventListener("click", () => { instDraft.push(""); paintSurveyItems(); });
  document.getElementById("si-sec-add").addEventListener("click", () => {
    sectionsDraft.push({ title: "", items: [{ type: "scale", label: "", options: [], slot: null }] });
    paintSurveyItems();
  });
  document.getElementById("si-slot-dis").addEventListener("click", () => restoreSlot("dis"));
  document.getElementById("si-slot-sug").addEventListener("click", () => restoreSlot("sug"));
  document.getElementById("si-save").addEventListener("click", saveCurrentSet);
  document.getElementById("si-set").addEventListener("change", (e) => {
    editingSetId = e.target.value; draftLoadedFor = null; paintSurveyItems();
  });
  document.getElementById("si-set-add").addEventListener("click", addSet);
  document.getElementById("si-set-del").addEventListener("click", deleteSet);
  document.getElementById("si-rev-add").addEventListener("click", addItemRevision);
}

function renderAll() {
  renderFees();
  renderTravel();
  renderRevisions("feeRates", "fee-rev-list");
  renderRevisions("travelRates", "travel-rev-list");
  document.getElementById("fee-save").textContent = saveButtonLabel("강사료 기준 저장", getRateHistory("feeRates"));
  document.getElementById("travel-save").textContent = saveButtonLabel("여비 기준 저장", getRateHistory("travelRates"));
  paintSurveyItems();
}

// ── 강사료 기준 ──
function feeRow(type, r) {
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td><input class="f-type" value="${escapeHtml(type)}" placeholder="강사유형"></td>
    <td><input type="number" min="0" class="f-first" value="${r.firstHour ?? 0}"></td>
    <td><input type="number" min="0" class="f-add" value="${r.addHour ?? 0}"></td>
    <td><input type="number" min="0" class="f-cap" value="${r.monthlyCap ?? ""}" placeholder="무제한"></td>
    <td class="actions">
      <button type="button" class="copy f-copy">복사</button>
      <button type="button" class="del f-del">삭제</button>
    </td>`;
  tr.querySelector(".f-copy").addEventListener("click", () =>
    tr.after(feeRow(tr.querySelector(".f-type").value + " (사본)", readFeeRow(tr)))
  );
  tr.querySelector(".f-del").addEventListener("click", () => tr.remove());
  return tr;
}
function readFeeRow(tr) {
  const cap = tr.querySelector(".f-cap").value;
  return {
    firstHour: Number(tr.querySelector(".f-first").value) || 0,
    addHour: Number(tr.querySelector(".f-add").value) || 0,
    monthlyCap: cap === "" ? null : Number(cap),
  };
}
// 개정 이력이 있으면 편집 표 기본 로딩은 '최신 개정본' 기준(현재값과 어긋난 경우 대비).
function latestRevisionRates(docName) {
  const hist = getRateHistory(docName);
  return hist.length ? hist[hist.length - 1].rates : null;
}
function renderFees(ratesOverride) {
  const tbody = document.getElementById("fee-tbody");
  const rates = ratesOverride || latestRevisionRates("feeRates") || getFeeRates();
  tbody.innerHTML = "";
  // 저장된 항목이 있으면 그대로, 없으면 기본 9종 뼈대.
  const types = Object.keys(rates).length ? Object.keys(rates) : INSTRUCTOR_TYPES;
  for (const t of types) {
    tbody.appendChild(feeRow(t, rates[t] || { firstHour: 0, addHour: 0, monthlyCap: null }));
  }
}
function collectFees() {
  const rates = {};
  document.querySelectorAll("#fee-tbody tr").forEach((tr) => {
    const type = tr.querySelector(".f-type").value.trim();
    if (!type) return;
    rates[type] = readFeeRow(tr);
  });
  return rates;
}
async function saveFees() {
  const seen = new Set();
  let dup = false;
  document.querySelectorAll("#fee-tbody tr").forEach((tr) => {
    const type = tr.querySelector(".f-type").value.trim();
    if (!type) return;
    if (seen.has(type)) dup = true;
    seen.add(type);
  });
  if (dup && !confirm("중복된 강사유형이 있습니다. 마지막 값으로 저장됩니다. 계속할까요?")) return;
  await saveRates("feeRates", collectFees(), "강사료 기준");
}

// ── 여비 기준 ──
function travelRow(key, r) {
  const tr = document.createElement("tr");
  tr.innerHTML = `
    <td><input class="t-key" value="${escapeHtml(key)}" placeholder="소속지/기준"></td>
    <td><input type="number" min="0" class="t-amt" value="${r.amount ?? 0}"></td>
    <td style="text-align:center"><input type="checkbox" class="t-man" ${r.manual ? "checked" : ""}></td>
    <td><input type="text" class="t-note" value="${escapeHtml(r.note ?? "")}"></td>
    <td class="actions">
      <button type="button" class="copy t-copy">복사</button>
      <button type="button" class="del t-del">삭제</button>
    </td>`;
  tr.querySelector(".t-copy").addEventListener("click", () =>
    tr.after(travelRow(tr.querySelector(".t-key").value + " (사본)", readTravelRow(tr)))
  );
  tr.querySelector(".t-del").addEventListener("click", () => tr.remove());
  return tr;
}
function readTravelRow(tr) {
  return {
    amount: Number(tr.querySelector(".t-amt").value) || 0,
    manual: tr.querySelector(".t-man").checked,
    note: tr.querySelector(".t-note").value.trim(),
  };
}
function renderTravel(ratesOverride) {
  const tbody = document.getElementById("travel-tbody");
  const rates = ratesOverride || latestRevisionRates("travelRates") || getTravelRates();
  tbody.innerHTML = "";
  const keys = Object.keys(rates);
  if (!keys.length) {
    tbody.appendChild(travelRow("", { amount: 0, manual: false, note: "" }));
    return;
  }
  for (const k of keys) tbody.appendChild(travelRow(k, rates[k] || {}));
}
function collectTravel() {
  const rates = {};
  document.querySelectorAll("#travel-tbody tr").forEach((tr) => {
    const key = tr.querySelector(".t-key").value.trim();
    if (!key) return;
    rates[key] = readTravelRow(tr);
  });
  return rates;
}
async function saveTravel() {
  const seen = new Set();
  let dup = false;
  document.querySelectorAll("#travel-tbody tr").forEach((tr) => {
    const key = tr.querySelector(".t-key").value.trim();
    if (!key) return;
    if (seen.has(key)) dup = true;
    seen.add(key);
  });
  if (dup && !confirm("중복된 소속지/기준이 있습니다. 마지막 값으로 저장됩니다. 계속할까요?")) return;
  await saveRates("travelRates", collectTravel(), "여비 기준");
}
