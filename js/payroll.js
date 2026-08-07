// 강사료·강사별 강의시간 집계.
// 순수 계산 함수 + 기간(월별/연간) 집계 UI.
import {
  collection, getDocs, query, where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./firebase.js";
import { escapeHtml } from "./app.js";
import { getFeeRatesAt, getTravelRatesAt } from "./settings.js";
import { getInstructors, getInstructorById, resolveInstructorAt } from "./instructors.js";
import { getHiddenCourseIds, coursesCache } from "./courses.js";
import { isPayExcludedSubject } from "./constants.js";
import { fmtDot } from "./time.js";

// ── 순수 계산 함수 (엑셀 '계산' 시트 로직) ──

// 강의시간(시간). 진행시간을 60분 단위로 올림(50분→1시간).
// 예: 10:00~10:50 → 1, 10:00~11:50 → 2, 10:00~12:50 → 3.
// 점심시간(12:00-13:00)을 완전히 걸치는 과목은 그 1시간을 차감한다.
// 예: 11:00~13:50 → (170-60분) → 2.
export function calcHour(startTime, endTime) {
  if (!startTime || !endTime) return 0;
  const toMin = (t) => parseInt(t.slice(0, 2), 10) * 60 + parseInt(t.slice(3, 5), 10);
  const start = toMin(startTime), end = toMin(endTime);
  let diff = end - start;
  if (start <= 12 * 60 && end >= 13 * 60) diff -= 60; // 점심 1시간 제외
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

// 해당 월의 말일(월상한 판정 기준일).
function monthEnd(ym) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(Date.UTC(y, m, 0));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

async function renderAggregate(type, value) {
  const all = await fetchSessions(type, value);
  // 운영 안내 성격 과목(교육등록 및 안내/설문 및 수료/평가 및 설문)은 강사료 계산 제외.
  const sessions = all.filter((s) => s.instructorId && !isPayExcludedSubject(s.subject));

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
    // 기준값도 강의 일자에 유효한 개정본으로 계산(규정 개정 소급 방지).
    const fee = calcFee(eff.instructorType, hour, getFeeRatesAt(s.date));
    g.monthFee[ym] = (g.monthFee[ym] || 0) + fee;
    // 세부 내역(계산근거 표시용).
    (g.items = g.items || []).push({
      date: s.date, courseId: s.courseId, subject: s.subject || "",
      startTime: s.startTime || "", endTime: s.endTime || "", hour, fee,
    });
  }

  const rows = [];
  let totFee = 0, totTravel = 0;
  for (const g of Object.values(byKey)) {
    // 월별 월상한 적용 후 합산(해당 유형 기준).
    let cappedFee = 0;
    for (const [ym, raw] of Object.entries(g.monthFee)) {
      // 월상한은 그 달 말일 시점에 유효한 개정본 기준.
      cappedFee += applyMonthlyCap(raw, g.type, getFeeRatesAt(monthEnd(ym)));
    }
    // 여비: 출강일(고유 일자)마다 1회, 그날 유효한 여비기준으로.
    let travelSum = 0, travelManual = false;
    for (const [date, basis] of g.dates.entries()) {
      const t = calcTravel(basis, getTravelRatesAt(date));
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
      items: g.items || [],
      monthFee: g.monthFee,
      dates: g.dates,
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
          <td>${escapeHtml(r.name)} <button type="button" class="pay-detail-btn" title="출강 과정·과목·시간 등 계산근거">세부</button></td>
          <td>${escapeHtml(r.type)}</td>
          <td style="text-align:right">${r.days}</td>
          <td style="text-align:right">${r.hours}</td>
          <td style="text-align:right">${won(r.fee)}</td>
          <td style="text-align:right">${won(r.travel)}${r.travelManual ? " <span class='warn'>(수동확인)</span>" : ""}</td>
          <td style="text-align:right"><b>${won(r.total)}</b></td>`;
        tr.querySelector(".pay-detail-btn").addEventListener("click", (e) => toggleDetail(tr, r, e.target));
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

// ── 강사별 세부 내역(계산근거) 토글 ──
function courseLabelOf(courseId) {
  const c = coursesCache.find((x) => x.id === courseId);
  return c ? `${c.name || ""}${c.round ? ` ${c.round}차수` : ""}` : "(삭제된 과정)";
}

function toggleDetail(tr, r, btn) {
  const next = tr.nextElementSibling;
  if (next && next.classList.contains("pay-detail-row")) {
    next.remove();
    btn.textContent = "세부";
    return;
  }
  btn.textContent = "닫기";
  const items = [...r.items].sort((a, b) =>
    (a.date + a.startTime).localeCompare(b.date + b.startTime));
  const body = items.map((it) => `<tr>
      <td>${escapeHtml(fmtDot(it.date))}</td>
      <td>${escapeHtml(courseLabelOf(it.courseId))}</td>
      <td>${escapeHtml(it.subject)}</td>
      <td>${escapeHtml(it.startTime)}-${escapeHtml(it.endTime)}</td>
      <td style="text-align:right">${it.hour}</td>
      <td style="text-align:right">${won(it.fee)}</td>
    </tr>`).join("");
  // 월별 강사료: 원금액과 월상한 적용 여부.
  const feeLines = Object.entries(r.monthFee).sort()
    .map(([ym, raw]) => {
      const capped = applyMonthlyCap(raw, r.type, getFeeRatesAt(monthEnd(ym)));
      return `${ym.replace("-", ".")}월 ${won(raw)}${capped < raw ? ` → 월상한 적용 ${won(capped)}` : ""}`;
    }).join(" · ");
  // 여비: 출강일별 기준·금액.
  const travelLines = [...r.dates.entries()].sort()
    .map(([date, basis]) => {
      const t = calcTravel(basis, getTravelRatesAt(date));
      return `${fmtDot(date)} ${escapeHtml(basis || "(기준없음)")} ${t.manual ? "수동확인" : won(t.amount)}`;
    }).join(" · ");
  const detail = document.createElement("tr");
  detail.className = "pay-detail-row";
  detail.innerHTML = `<td colspan="7">
    <table class="pay-detail">
      <thead><tr><th>일자</th><th>과정</th><th>과목</th><th>시간</th><th>Hour</th><th>강사료</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
    <p class="hint">강사료(월별): ${feeLines || "-"}</p>
    <p class="hint">여비(출강일별): ${travelLines || "-"}</p>
  </td>`;
  tr.after(detail);
}
