// 강사료·강사별 강의시간 집계.
// 순수 계산 함수 + 기간(월별/연간) 집계 UI.
import {
  collection, getDocs, query, where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./firebase.js";
import { escapeHtml } from "./app.js";
import { getFeeRates, getTravelRates } from "./settings.js";
import { getInstructors, getInstructorById, resolveInstructorAt } from "./instructors.js";
import { getHiddenCourseIds } from "./courses.js";

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

// ── 강사유형 그룹 ──
// 표시 순서. '사외'는 세부 유형(시내/시외/청탁/비대상 등)을 하나로 묶는다.
const GROUP_ORDER = ["전임교관", "사내강사", "사외", "기타"];
function groupOf(instructorType) {
  const t = instructorType || "";
  if (t.startsWith("전임")) return "전임교관";
  if (t.startsWith("사내")) return "사내강사";
  if (t.startsWith("사외")) return "사외";
  return "기타";
}

// ── 집계 UI ──

export function initPayroll() {
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

// 선택 기간의 세션만 서버에서 조회(무료 읽기 한도 보호).
async function fetchSessions(type, value) {
  if (!value) return [];
  const start = type === "year" ? `${value}-01-01` : `${value}-01`;
  const end = type === "year" ? `${value}-12-31` : `${value}-31`;
  const q = query(collection(db, "sessions"),
    where("date", ">=", start), where("date", "<=", end));
  const [snap, hiddenIds] = await Promise.all([getDocs(q), getHiddenCourseIds()]);
  // 숨김 처리된 차수의 세션은 집계에서 제외.
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .filter((s) => !hiddenIds.has(s.courseId));
}

async function renderAggregate(type, value) {
  const feeRates = getFeeRates();
  const travelRates = getTravelRates();
  const all = await fetchSessions(type, value);
  const sessions = all.filter((s) => s.instructorId);

  // 강사 × 강사유형별 집계.
  // 유형이 기간 중 바뀐 경우(이력) 강의 일자에 유효한 값으로 계산하고, 유형별로 행을 분리한다.
  const byKey = {};
  for (const s of sessions) {
    const inst = getInstructorById(s.instructorId);
    if (!inst) continue;
    const eff = resolveInstructorAt(inst, s.date); // 일자 기준 강사유형·여비기준
    const key = `${s.instructorId}|${eff.instructorType}`;
    const g = (byKey[key] = byKey[key] || {
      inst, type: eff.instructorType, dates: new Map(), hours: 0, monthFee: {}, sessions: 0,
    });
    const hour = calcHour(s.startTime, s.endTime);
    g.hours += hour;
    g.sessions += 1;
    g.dates.set(s.date, eff.travelBasis); // 출강일 → 그날의 여비기준
    const ym = s.date.slice(0, 7);
    g.monthFee[ym] = (g.monthFee[ym] || 0) + calcFee(eff.instructorType, hour, feeRates);
  }

  const rows = [];
  let totFee = 0, totTravel = 0;
  for (const g of Object.values(byKey)) {
    // 월별 월상한 적용 후 합산(해당 유형 기준).
    let cappedFee = 0;
    for (const [, raw] of Object.entries(g.monthFee)) {
      cappedFee += applyMonthlyCap(raw, g.type, feeRates);
    }
    // 여비: 출강일(고유 일자)마다 1회, 그날 유효한 여비기준으로.
    let travelSum = 0, travelManual = false;
    for (const basis of g.dates.values()) {
      const t = calcTravel(basis, travelRates);
      if (t.manual) travelManual = true; else travelSum += t.amount;
    }
    totFee += cappedFee;
    totTravel += travelSum;
    rows.push({
      name: g.inst.name,
      type: g.type,
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
    // 강사유형 그룹별로 묶어 표시(전임교관 → 사내강사 → 사외 → 기타).
    for (const key of GROUP_ORDER) {
      const list = rows.filter((r) => groupOf(r.type) === key);
      if (!list.length) continue;
      const sum = list.reduce((a, r) => ({
        days: a.days + r.days, hours: a.hours + r.hours,
        fee: a.fee + r.fee, travel: a.travel + r.travel, total: a.total + r.total,
      }), { days: 0, hours: 0, fee: 0, travel: 0, total: 0 });

      const head = document.createElement("tr");
      head.className = "grp-row";
      head.innerHTML = `<td colspan="7"><b>${escapeHtml(key)}</b> <span class="grp-count">${list.length}명</span></td>`;
      tbody.appendChild(head);

      for (const r of list) {
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

      const sub = document.createElement("tr");
      sub.className = "sum-row";
      sub.innerHTML = `
        <td colspan="2"><b>${escapeHtml(key)} 소계</b></td>
        <td style="text-align:right">${sum.days}</td>
        <td style="text-align:right">${sum.hours}</td>
        <td style="text-align:right">${won(sum.fee)}</td>
        <td style="text-align:right">${won(sum.travel)}</td>
        <td style="text-align:right"><b>${won(sum.total)}</b></td>`;
      tbody.appendChild(sub);
    }
  }
  document.getElementById("pay-total").textContent =
    `강사료 ${won(totFee)} + 여비(자동분) ${won(totTravel)} = ${won(totFee + totTravel)}`;
}

function won(n) {
  return (n || 0).toLocaleString("ko-KR") + "원";
}
