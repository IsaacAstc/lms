// 강사료·강사별 강의시간 집계.
// 순수 계산 함수 + 기간(월별/연간) 집계 UI.
import { watchCollection, onCollection, getCache } from "./store.js";
import { escapeHtml } from "./app.js";
import { getFeeRates, getTravelRates } from "./settings.js";
import { getInstructors, getInstructorById } from "./instructors.js";

// ── 순수 계산 함수 (엑셀 '계산' 시트 로직) ──

// 강의시간(시간). 진행시간을 60분 단위로 올림(50분→1시간).
// 예: 10:00~10:50 → 1, 10:00~11:50 → 2, 10:00~12:50 → 3.
export function calcHour(startTime, endTime) {
  if (!startTime || !endTime) return 0;
  const toMin = (t) => parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(3, 5), 10);
  const diff = toMin(endTime) - toMin(startTime);
  return diff > 0 ? Math.ceil(diff / 60) : 0;
}

// 강사료 = 최초1시간 + 추가1시간 × (Hour-1). 기준 없으면 0.
export function calcFee(instructorType, hour, feeRates) {
  const r = feeRates[instructorType];
  if (!r || hour <= 0) return 0;
  return (r.firstHour || 0) + (r.addHour || 0) * (hour - 1);
}

// 월상한 적용: 강사료 합계를 monthlyCap으로 캡. null이면 무제한.
export function applyMonthlyCap(rawFee, instructorType, feeRates) {
  const r = feeRates[instructorType];
  if (!r || r.monthlyCap == null) return rawFee;
  return Math.min(rawFee, r.monthlyCap);
}

// 여비: 고정금액이면 자동, manual이면 수동 표시.
export function calcTravel(travelBasis, travelRates) {
  const r = travelRates[travelBasis];
  if (!r) return { amount: 0, manual: true };
  return { amount: r.amount || 0, manual: !!r.manual };
}

// ── 집계 UI ──

export function initPayroll() {
  watchCollection("sessions");
  const periodType = document.getElementById("pay-period-type");
  const periodInput = document.getElementById("pay-period");
  const runBtn = document.getElementById("pay-run");

  const today = new Date();
  periodInput.value = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;

  const syncInputType = () => {
    if (periodType.value === "year") {
      periodInput.type = "number";
      periodInput.placeholder = "연도 (예: 2026)";
      if (periodInput.value.includes("-")) periodInput.value = periodInput.value.slice(0, 4);
    } else {
      periodInput.type = "month";
      if (!periodInput.value.includes("-")) periodInput.value = `${periodInput.value}-01`;
    }
  };
  periodType.addEventListener("change", syncInputType);
  runBtn.addEventListener("click", () => renderAggregate(periodType.value, periodInput.value));
}

// 기간 필터: month → 'YYYY-MM', year → 'YYYY'.
function inPeriod(dateStr, type, value) {
  if (!dateStr || !value) return false;
  return type === "year" ? dateStr.slice(0, 4) === String(value) : dateStr.slice(0, 7) === value;
}

function renderAggregate(type, value) {
  const feeRates = getFeeRates();
  const travelRates = getTravelRates();
  const sessions = getCache("sessions").filter((s) => inPeriod(s.date, type, value) && s.instructorId);

  // 강사별 집계.
  const byInstructor = {};
  for (const s of sessions) {
    const inst = getInstructorById(s.instructorId);
    if (!inst) continue;
    const g = (byInstructor[s.instructorId] = byInstructor[s.instructorId] || {
      inst, dates: new Set(), hours: 0, monthFee: {}, sessions: 0,
    });
    const hour = calcHour(s.startTime, s.endTime);
    g.hours += hour;
    g.sessions += 1;
    g.dates.add(s.date);
    const ym = s.date.slice(0, 7);
    g.monthFee[ym] = (g.monthFee[ym] || 0) + calcFee(inst.instructorType, hour, feeRates);
  }

  const rows = [];
  let totFee = 0, totTravel = 0;
  for (const g of Object.values(byInstructor)) {
    // 월별 월상한 적용 후 합산.
    let cappedFee = 0;
    for (const [, raw] of Object.entries(g.monthFee)) {
      cappedFee += applyMonthlyCap(raw, g.inst.instructorType, feeRates);
    }
    // 여비: 출강일(고유 일자)마다 1회.
    let travelSum = 0, travelManual = false;
    for (const _ of g.dates) {
      const t = calcTravel(g.inst.travelBasis, travelRates);
      if (t.manual) travelManual = true; else travelSum += t.amount;
    }
    totFee += cappedFee;
    totTravel += travelSum;
    rows.push({
      name: g.inst.name,
      type: g.inst.instructorType,
      days: g.dates.size,
      hours: g.hours,
      fee: cappedFee,
      travel: travelSum,
      travelManual,
      total: cappedFee + travelSum,
    });
  }
  rows.sort((a, b) => a.name.localeCompare(b.name));

  const tbody = document.getElementById("pay-tbody");
  tbody.innerHTML = "";
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty">해당 기간에 강사 지정된 시간표가 없습니다.</td></tr>`;
  } else {
    for (const r of rows) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(r.name)}</td>
        <td>${escapeHtml(r.type)}</td>
        <td style="text-align:right">${r.days}</td>
        <td style="text-align:right">${r.hours}</td>
        <td style="text-align:right">${won(r.fee)}</td>
        <td style="text-align:right">${won(r.travel)}${r.travelManual ? " <span class='warn'>(수동확인)</span>" : ""}</td>
        <td style="text-align:right"><b>${won(r.total)}</b></td>`;
      tbody.appendChild(tr);
    }
  }
  document.getElementById("pay-total").textContent =
    `강사료 ${won(totFee)} + 여비(자동분) ${won(totTravel)} = ${won(totFee + totTravel)}`;
}

function won(n) {
  return (n || 0).toLocaleString("ko-KR") + "원";
}
