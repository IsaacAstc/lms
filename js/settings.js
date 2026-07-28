// 기준값 설정: 강사료(강사유형별 단가·월상한), 여비(소속지별 금액).
// 각 행의 키(강사유형/소속지)까지 수정 가능하며, 행 복사·삭제·추가를 지원.
import { watchCollection, onCollection, getCache, setDocById } from "./store.js";
import { escapeHtml } from "./app.js";
import { INSTRUCTOR_TYPES } from "./constants.js";

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
}

function renderAll() {
  renderFees();
  renderTravel();
  renderRevisions("feeRates", "fee-rev-list");
  renderRevisions("travelRates", "travel-rev-list");
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
