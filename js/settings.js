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
    eduItems: Array.isArray(picked.eduItems) && picked.eduItems.length ? picked.eduItems : cur.eduItems,
    instructorItems: Array.isArray(picked.instructorItems) && picked.instructorItems.length ? picked.instructorItems : cur.instructorItems,
  };
}

// 추가 문항 세트 목록: [{ id, name, eduItems, instructorItems }]
export function getSurveySets() {
  const d = docByName("surveyItems");
  return (Array.isArray(d?.sets) ? d.sets : []).filter((x) => x && x.id);
}

// 주관식 문구(2종 고정)·O/X 문항·섹션 제목·추가 카테고리 —
// 발효일자 이력 없이 현재값만 유지(세트별 별도 저장).
function extrasOf(src) {
  return {
    freeItems: Array.isArray(src?.freeItems) && src.freeItems.length === 2 ? src.freeItems : null,
    oxItems: Array.isArray(src?.oxItems) ? src.oxItems.filter(Boolean) : null,
    titles: (src?.titles && typeof src.titles === "object") ? { ...DEFAULT_SECTION_TITLES, ...src.titles } : null,
    extraCats: Array.isArray(src?.extraCats)
      ? src.extraCats.filter((c) => c && c.title && Array.isArray(c.items) && c.items.length) : null,
    // 조건부 후속 문항(1단계 분기): {q(대상 문항 라벨), cond('yes'|'no'|'score'), maxScore, type('text'|'ox'), label}
    followUps: Array.isArray(src?.followUps)
      ? src.followUps.filter((f) => f && f.q && f.label && ["yes", "no", "score"].includes(f.cond) && ["text", "ox"].includes(f.type)) : null,
  };
}

// 세트 우선순위로 문항 해석: 차수 지정 > 커리큘럼 지정 > 기본 세트(발효일자 이력).
export function resolveSurveyItems({ setId, dateStr }) {
  if (setId) {
    const set = getSurveySets().find((x) => x.id === setId);
    if (set) {
      return {
        eduItems: set.eduItems?.length ? set.eduItems : null,
        instructorItems: set.instructorItems?.length ? set.instructorItems : null,
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
  box.innerHTML = `<div class="chip-row">${hist.map((h, i) =>
    `<span class="chip">${escapeHtml(h.from)}부터<button type="button" class="chip-del" data-i="${i}">×</button></span>`).join("")}</div>`;
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

let eduDraft = null, instDraft = null, freeDraft = null, oxDraft = null;
let titlesDraft = null;   // {edu, inst, free, ox} — 섹션(카테고리) 제목
let extraDraft = null;    // [{title, items:[]}] — 추가 카테고리(5점 척도)
let fuDraft = null;       // [{q, cond, maxScore, type, label}] — 조건부 후속 문항
let editingSetId = "";   // "" = 기본 세트
let draftLoadedFor = null; // 현재 draft가 어느 세트에서 로드됐는지

// 편집 대상 세트의 문항을 draft로 로드.
function loadDraftForSet() {
  if (draftLoadedFor === editingSetId) return;
  if (editingSetId) {
    const set = getSurveySets().find((x) => x.id === editingSetId);
    eduDraft = (set?.eduItems || DEFAULT_EDU_ITEMS).slice();
    instDraft = (set?.instructorItems || DEFAULT_INST_ITEMS).slice();
    freeDraft = (extrasOf(set).freeItems || DEFAULT_FREE_ITEMS).slice();
    oxDraft = (extrasOf(set).oxItems || []).slice();
    titlesDraft = { ...(extrasOf(set).titles || DEFAULT_SECTION_TITLES) };
    extraDraft = (extrasOf(set).extraCats || []).map((c) => ({ title: c.title, items: c.items.slice() }));
    fuDraft = (extrasOf(set).followUps || []).map((f) => ({ ...f }));
  } else {
    const cur = getSurveyItems();
    const d = docByName("surveyItems");
    eduDraft = (cur.eduItems || DEFAULT_EDU_ITEMS).slice();
    instDraft = (cur.instructorItems || DEFAULT_INST_ITEMS).slice();
    freeDraft = (extrasOf(d).freeItems || DEFAULT_FREE_ITEMS).slice();
    oxDraft = (extrasOf(d).oxItems || []).slice();
    titlesDraft = { ...(extrasOf(d).titles || DEFAULT_SECTION_TITLES) };
    extraDraft = (extrasOf(d).extraCats || []).map((c) => ({ title: c.title, items: c.items.slice() }));
    fuDraft = (extrasOf(d).followUps || []).map((f) => ({ ...f }));
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

function paintSurveyItems() {
  loadDraftForSet();
  renderSetSelect();
  itemListRows("si-edu-list", eduDraft);
  itemListRows("si-inst-list", instDraft);
  bindItemEditors("si-edu-list", eduDraft);
  bindItemEditors("si-inst-list", instDraft);
  // 주관식 문구: 2개 고정(삭제·추가 없음), 문구만 수정.
  const fbox = document.getElementById("si-free-list");
  if (fbox) {
    fbox.innerHTML = `<div class="chip-row">${freeDraft.map((t, i) =>
      `<span class="chip"><input class="si-free" data-i="${i}" value="${escapeHtml(t)}" size="26"></span>`).join("")}</div>`;
    fbox.querySelectorAll(".si-free").forEach((el) =>
      el.addEventListener("input", (e) => { freeDraft[+e.target.dataset.i] = e.target.value; }));
  }
  // O/X(예/아니오) 문항: 자유 추가·삭제(없으면 설문에 미표시).
  const obox = document.getElementById("si-ox-list");
  if (obox) {
    itemListRows("si-ox-list", oxDraft);
    if (!oxDraft.length) obox.innerHTML = `<p class="hint">O/X 문항이 없습니다(설문에 표시되지 않음).</p>`;
    bindItemEditors("si-ox-list", oxDraft);
  }
  // 섹션(카테고리) 제목: 설문 화면의 소제목. 교육·강사는 집계 구조상 삭제 불가, 제목만 수정.
  const tbox = document.getElementById("si-titles");
  if (tbox) {
    const T = [["edu", "교육 만족도 제목"], ["inst", "강사 만족도 제목"], ["free", "주관식 제목"], ["ox", "O/X 제목"]];
    tbox.innerHTML = `<div class="chip-row">${T.map(([k, lb]) =>
      `<span class="chip">${lb} <input class="si-title" data-k="${k}" value="${escapeHtml(titlesDraft[k] || DEFAULT_SECTION_TITLES[k])}" size="14"></span>`).join("")}</div>`;
    tbox.querySelectorAll(".si-title").forEach((el) =>
      el.addEventListener("input", (e) => { titlesDraft[e.target.dataset.k] = e.target.value; }));
  }
  // 추가 카테고리(5점 척도 문항 그룹): 카테고리 단위 추가·삭제 + 문항 편집.
  const xbox = document.getElementById("si-extra-list");
  if (xbox) {
    xbox.innerHTML = extraDraft.length ? "" : `<p class="hint">추가 카테고리가 없습니다.</p>`;
    extraDraft.forEach((cat, ci) => {
      const div = document.createElement("div");
      div.className = "load-box";
      div.innerHTML = `<div class="load-row">
          <label>카테고리명 <input class="xc-title" data-c="${ci}" value="${escapeHtml(cat.title)}" size="20"></label>
          <button type="button" class="xc-item-add" data-c="${ci}">문항 추가</button>
          <button type="button" class="xc-move" data-c="${ci}" data-d="-1" title="카테고리를 위로">▲</button>
          <button type="button" class="xc-move" data-c="${ci}" data-d="1" title="카테고리를 아래로">▼</button>
          <button type="button" class="del xc-del" data-c="${ci}">카테고리 삭제</button>
        </div>
        <div class="chip-row">${cat.items.map((t, i) =>
          `<span class="chip">${i + 1}.<input class="xc-item" data-c="${ci}" data-i="${i}" value="${escapeHtml(t)}" size="18"><button type="button" class="chip-move xc-item-move" data-c="${ci}" data-i="${i}" data-d="-1" title="앞으로">◀</button><button type="button" class="chip-move xc-item-move" data-c="${ci}" data-i="${i}" data-d="1" title="뒤로">▶</button><button type="button" class="chip-del xc-item-del" data-c="${ci}" data-i="${i}">×</button></span>`).join("")}</div>`;
      xbox.appendChild(div);
    });
    xbox.querySelectorAll(".xc-title").forEach((el) =>
      el.addEventListener("input", (e) => { extraDraft[+e.target.dataset.c].title = e.target.value; }));
    xbox.querySelectorAll(".xc-item").forEach((el) =>
      el.addEventListener("input", (e) => { extraDraft[+e.target.dataset.c].items[+e.target.dataset.i] = e.target.value; }));
    xbox.querySelectorAll(".xc-item-add").forEach((b) =>
      b.addEventListener("click", () => { extraDraft[+b.dataset.c].items.push(""); paintSurveyItems(); }));
    xbox.querySelectorAll(".xc-item-del").forEach((b) =>
      b.addEventListener("click", () => { extraDraft[+b.dataset.c].items.splice(+b.dataset.i, 1); paintSurveyItems(); }));
    xbox.querySelectorAll(".xc-item-move").forEach((b) =>
      b.addEventListener("click", () => { moveItem(extraDraft[+b.dataset.c].items, +b.dataset.i, +b.dataset.d); paintSurveyItems(); }));
    xbox.querySelectorAll(".xc-move").forEach((b) =>
      b.addEventListener("click", () => { moveItem(extraDraft, +b.dataset.c, +b.dataset.d); paintSurveyItems(); }));
    xbox.querySelectorAll(".xc-del").forEach((b) =>
      b.addEventListener("click", () => {
        const c = extraDraft[+b.dataset.c];
        if (!confirm(`'${c.title || "(이름 없음)"}' 카테고리를 삭제할까요?`)) return;
        extraDraft.splice(+b.dataset.c, 1); paintSurveyItems();
      }));
  }
  // 조건부 후속 문항 편집기.
  const fbox2 = document.getElementById("si-fu-list");
  if (fbox2) {
    // 대상 후보: 교육 문항·추가 카테고리 문항(5점 → N점 이하 조건), O/X 문항(예/아니오 조건).
    // 강사 문항은 강사별로 반복 표시되어 분기 대상에서 제외.
    const scaleTargets = [
      ...eduDraft.map((t) => t.trim()).filter(Boolean),
      ...extraDraft.flatMap((c) => c.items.map((t) => t.trim()).filter(Boolean)),
    ];
    const oxTargets = oxDraft.map((t) => t.trim()).filter(Boolean);
    const qOptions = (sel) =>
      `<option value="">대상 문항 선택</option>`
      + (scaleTargets.length ? `<optgroup label="5점 문항">${scaleTargets.map((t) => `<option${t === sel ? " selected" : ""}>${escapeHtml(t)}</option>`).join("")}</optgroup>` : "")
      + (oxTargets.length ? `<optgroup label="O/X 문항">${oxTargets.map((t) => `<option${t === sel ? " selected" : ""}>${escapeHtml(t)}</option>`).join("")}</optgroup>` : "");
    fbox2.innerHTML = fuDraft.length ? "" : `<p class="hint">조건부 후속 문항이 없습니다.</p>`;
    fuDraft.forEach((f, i) => {
      const isOxTarget = oxTargets.includes(f.q);
      const div = document.createElement("div");
      div.className = "load-row";
      div.innerHTML = `
        <select class="fu-q" data-i="${i}">${qOptions(f.q)}</select>
        <select class="fu-cond" data-i="${i}">
          ${isOxTarget
            ? `<option value="yes"${f.cond === "yes" ? " selected" : ""}>'예' 선택 시</option>
               <option value="no"${f.cond === "no" ? " selected" : ""}>'아니오' 선택 시</option>`
            : `<option value="score"${f.cond === "score" ? " selected" : ""}>N점 이하 선택 시</option>`}
        </select>
        <label class="fu-score-wrap"${f.cond === "score" ? "" : " hidden"}>N= <input type="number" class="fu-score" data-i="${i}" min="1" max="4" value="${f.maxScore || 2}" style="width:3.5rem"></label>
        <select class="fu-type" data-i="${i}">
          <option value="text"${f.type === "text" ? " selected" : ""}>후속: 주관식</option>
          <option value="ox"${f.type === "ox" ? " selected" : ""}>후속: 예/아니오</option>
        </select>
        <input class="fu-label" data-i="${i}" value="${escapeHtml(f.label || "")}" placeholder="후속 문항 문구" style="min-width:220px">
        <button type="button" class="del fu-del" data-i="${i}">삭제</button>`;
      fbox2.appendChild(div);
    });
    fbox2.querySelectorAll(".fu-q").forEach((el) => el.addEventListener("change", (e) => {
      const f = fuDraft[+e.target.dataset.i];
      f.q = e.target.value;
      f.cond = oxTargets.includes(f.q) ? (f.cond === "no" ? "no" : "yes") : "score";
      paintSurveyItems();
    }));
    fbox2.querySelectorAll(".fu-cond").forEach((el) => el.addEventListener("change", (e) => {
      fuDraft[+e.target.dataset.i].cond = e.target.value;
      paintSurveyItems();
    }));
    fbox2.querySelectorAll(".fu-score").forEach((el) => el.addEventListener("input", (e) => {
      fuDraft[+e.target.dataset.i].maxScore = Math.min(4, Math.max(1, Number(e.target.value) || 2));
    }));
    fbox2.querySelectorAll(".fu-type").forEach((el) => el.addEventListener("change", (e) => {
      fuDraft[+e.target.dataset.i].type = e.target.value;
    }));
    fbox2.querySelectorAll(".fu-label").forEach((el) => el.addEventListener("input", (e) => {
      fuDraft[+e.target.dataset.i].label = e.target.value;
    }));
    fbox2.querySelectorAll(".fu-del").forEach((b) => b.addEventListener("click", () => {
      fuDraft.splice(+b.dataset.i, 1); paintSurveyItems();
    }));
  }
  renderItemRevisions();
}

// 세트 저장/추가/삭제.
async function saveCurrentSet() {
  const items = collectItems();
  if (!items.eduItems.length || !items.instructorItems.length) return alert("교육·강사 문항을 각각 1개 이상 입력하세요.");
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
  return {
    eduItems: eduDraft.map((t) => t.trim()).filter(Boolean),
    instructorItems: instDraft.map((t) => t.trim()).filter(Boolean),
    // 주관식은 2개 고정 — 비워두면 기본 문구로 복원.
    freeItems: freeDraft.map((t, i) => (t.trim() || DEFAULT_FREE_ITEMS[i])),
    oxItems: oxDraft.map((t) => t.trim()).filter(Boolean),
    titles: Object.fromEntries(Object.keys(DEFAULT_SECTION_TITLES).map((k) =>
      [k, (titlesDraft[k] || "").trim() || DEFAULT_SECTION_TITLES[k]])),
    extraCats: extraDraft
      .map((c) => ({ title: (c.title || "").trim(), items: c.items.map((t) => t.trim()).filter(Boolean) }))
      .filter((c) => c.title && c.items.length),
    followUps: fuDraft
      .map((f) => ({ q: (f.q || "").trim(), cond: f.cond, maxScore: f.cond === "score" ? (f.maxScore || 2) : null, type: f.type, label: (f.label || "").trim() }))
      .filter((f) => f.q && f.label && ["yes", "no", "score"].includes(f.cond) && ["text", "ox"].includes(f.type)),
  };
}
// 기본 세트 top-level의 주관식·O/X 현행값(세트 편집·삭제 등에서 보존용).
function topExtras() {
  const d = docByName("surveyItems");
  const x = extrasOf(d);
  return {
    freeItems: x.freeItems || DEFAULT_FREE_ITEMS,
    oxItems: x.oxItems || [],
    titles: x.titles || DEFAULT_SECTION_TITLES,
    extraCats: x.extraCats || [],
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
  box.innerHTML = `<div class="chip-row">${hist.map((h, i) =>
    `<span class="chip">${escapeHtml(h.from)}부터 (교육 ${h.eduItems?.length ?? 0}·강사 ${h.instructorItems?.length ?? 0})<button type="button" class="chip-del" data-i="${i}">×</button></span>`).join("")}</div>`;
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
  if (!items.eduItems.length || !items.instructorItems.length) return alert("교육·강사 문항을 각각 1개 이상 입력하세요.");
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
  if (!items.eduItems.length || !items.instructorItems.length) return alert("교육·강사 문항을 각각 1개 이상 입력하세요.");
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
        freeItems: items.freeItems, oxItems: items.oxItems,
        titles: items.titles, extraCats: items.extraCats, followUps: items.followUps, history: hist,
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
  document.getElementById("si-ox-add").addEventListener("click", () => { oxDraft.push(""); paintSurveyItems(); });
  document.getElementById("si-extra-add").addEventListener("click", () => { extraDraft.push({ title: "", items: [""] }); paintSurveyItems(); });
  document.getElementById("si-fu-add").addEventListener("click", () => { fuDraft.push({ q: "", cond: "score", maxScore: 2, type: "text", label: "" }); paintSurveyItems(); });
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
function renderFees() {
  const tbody = document.getElementById("fee-tbody");
  const rates = getFeeRates();
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
function renderTravel() {
  const tbody = document.getElementById("travel-tbody");
  const rates = getTravelRates();
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
