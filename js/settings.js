// 기준값 설정: 강사료(강사유형별 단가·월상한), 여비(소속지별 금액).
import { watchCollection, onCollection, getCache, setDocById } from "./store.js";
import { escapeHtml } from "./app.js";
import { INSTRUCTOR_TYPES } from "./constants.js";

// settings 컬렉션의 feeRates / travelRates 문서를 사용.
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
}

function renderAll() {
  renderFees();
  renderTravel();
}

// 강사료 단가 테이블 (강사유형 고정 9종).
function renderFees() {
  const tbody = document.getElementById("fee-tbody");
  const rates = getFeeRates();
  tbody.innerHTML = "";
  for (const type of INSTRUCTOR_TYPES) {
    const r = rates[type] || { firstHour: 0, addHour: 0, monthlyCap: null };
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(type)}</td>
      <td><input type="number" min="0" class="f-first" value="${r.firstHour ?? 0}"></td>
      <td><input type="number" min="0" class="f-add" value="${r.addHour ?? 0}"></td>
      <td><input type="number" min="0" class="f-cap" value="${r.monthlyCap ?? ""}" placeholder="무제한"></td>`;
    tr.dataset.type = type;
    tbody.appendChild(tr);
  }
}

async function saveFees() {
  const rates = {};
  document.querySelectorAll("#fee-tbody tr").forEach((tr) => {
    const capVal = tr.querySelector(".f-cap").value;
    rates[tr.dataset.type] = {
      firstHour: Number(tr.querySelector(".f-first").value) || 0,
      addHour: Number(tr.querySelector(".f-add").value) || 0,
      monthlyCap: capVal === "" ? null : Number(capVal),
    };
  });
  try {
    await setDocById("settings", "feeRates", { rates });
    alert("강사료 기준을 저장했습니다.");
  } catch (e) { alert("저장 실패: " + e.message); }
}

// 여비 테이블 (소속지 키는 기존 값 + 추가 가능).
function renderTravel() {
  const tbody = document.getElementById("travel-tbody");
  const rates = getTravelRates();
  tbody.innerHTML = "";
  const keys = Object.keys(rates);
  if (!keys.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="empty">기준이 없습니다. 시드를 실행하세요.</td></tr>`;
    return;
  }
  for (const key of keys) {
    const r = rates[key] || {};
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(key)}</td>
      <td><input type="number" min="0" class="t-amt" value="${r.amount ?? 0}"></td>
      <td style="text-align:center"><input type="checkbox" class="t-man" ${r.manual ? "checked" : ""}></td>
      <td><input type="text" class="t-note" value="${escapeHtml(r.note ?? "")}"></td>`;
    tr.dataset.key = key;
    tbody.appendChild(tr);
  }
}

async function saveTravel() {
  const rates = {};
  document.querySelectorAll("#travel-tbody tr").forEach((tr) => {
    if (!tr.dataset.key) return;
    rates[tr.dataset.key] = {
      amount: Number(tr.querySelector(".t-amt").value) || 0,
      manual: tr.querySelector(".t-man").checked,
      note: tr.querySelector(".t-note").value.trim(),
    };
  });
  try {
    await setDocById("settings", "travelRates", { rates });
    alert("여비 기준을 저장했습니다.");
  } catch (e) { alert("저장 실패: " + e.message); }
}
