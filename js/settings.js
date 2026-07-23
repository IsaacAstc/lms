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
export function onSettingsChange(cb) {
  return onCollection("settings", cb);
}

export function initSettings() {
  watchCollection("settings");
  onCollection("settings", renderAll);

  document.getElementById("fee-save").addEventListener("click", saveFees);
  document.getElementById("travel-save").addEventListener("click", saveTravel);
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
async function saveFees() {
  const rates = {};
  let dup = false;
  document.querySelectorAll("#fee-tbody tr").forEach((tr) => {
    const type = tr.querySelector(".f-type").value.trim();
    if (!type) return;
    if (rates[type]) dup = true;
    rates[type] = readFeeRow(tr);
  });
  if (dup && !confirm("중복된 강사유형이 있습니다. 마지막 값으로 저장됩니다. 계속할까요?")) return;
  try {
    await setDocById("settings", "feeRates", { rates });
    alert("강사료 기준을 저장했습니다.");
  } catch (e) { alert("저장 실패: " + e.message); }
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
async function saveTravel() {
  const rates = {};
  let dup = false;
  document.querySelectorAll("#travel-tbody tr").forEach((tr) => {
    const key = tr.querySelector(".t-key").value.trim();
    if (!key) return;
    if (rates[key]) dup = true;
    rates[key] = readTravelRow(tr);
  });
  if (dup && !confirm("중복된 소속지/기준이 있습니다. 마지막 값으로 저장됩니다. 계속할까요?")) return;
  try {
    await setDocById("settings", "travelRates", { rates });
    alert("여비 기준을 저장했습니다.");
  } catch (e) { alert("저장 실패: " + e.message); }
}
