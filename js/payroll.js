// 강사료·강사별 강의시간 집계.
// 순수 계산 함수 + 기간(월별/연간) 집계 UI.
import {
  collection, getDocs, query, where, doc, getDoc, setDoc, deleteField, updateDoc,
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

// ── 지급 조정 ──
// 소속기관 내부 규정 등으로 기준과 달리 지급하는 경우의 조정(사유 필수):
//  1) 상시 규칙(instructors 문서): adjustTravelPerDay(출강일당 여비 고정액, 0=미지급),
//     adjustMonthlyCap(월 강사료 상한 대체액), adjustReason.
//  2) 월별 건별(payAdjustments/{YYYY-MM}.items["강사ID|유형"]): fee/travel 최종액(null=조정 없음), reason.
//     월별 건별이 상시 규칙보다 우선한다.
// 강사료 집계·소요경비·운영 보고서가 모두 이 순서로 동일 적용한다.
export async function fetchPayAdjustments(type, value) {
  try {
    if (type === "year") {
      const snap = await getDocs(collection(db, "payAdjustments"));
      const out = {};
      snap.docs.forEach((d) => { if (d.id.startsWith(`${value}-`)) out[d.id] = d.data().items || {}; });
      return out;
    }
    const d = await getDoc(doc(db, "payAdjustments", value));
    return d.exists() ? { [value]: d.data().items || {} } : {};
  } catch { return {}; } // 규칙 미배포 등 — 조정 없이 계산
}

// 월 강사료: 기준 월상한 → 상시 상한 대체 → 월별 건별 최종액 순으로 적용.
export function adjustedMonthFee(rawFee, instType, feeRates, inst, override) {
  if (override && override.fee != null) return { fee: override.fee, adjusted: true, reason: override.reason || "" };
  let fee = applyMonthlyCap(rawFee, instType, feeRates);
  if (inst && inst.adjustMonthlyCap != null && inst.adjustMonthlyCap !== "") {
    const capped = Math.min(rawFee, Number(inst.adjustMonthlyCap));
    if (capped !== fee) return { fee: capped, adjusted: true, reason: inst.adjustReason || "" };
    fee = capped;
  }
  return { fee, adjusted: false, reason: "" };
}

// 출강일 1일 여비: 상시 고정액이 있으면 그 값(수동확인 아님), 없으면 기준값.
export function adjustedDayTravel(basis, travelRates, inst) {
  if (inst && inst.adjustTravelPerDay != null && inst.adjustTravelPerDay !== "") {
    return { amount: Number(inst.adjustTravelPerDay), manual: false, adjusted: true, reason: inst.adjustReason || "" };
  }
  const t = calcTravel(basis, travelRates);
  return { ...t, adjusted: false, reason: "" };
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
  document.getElementById("pay-adj-save").addEventListener("click", () => saveAdjust(false));
  document.getElementById("pay-adj-clear").addEventListener("click", () => {
    if (confirm("이 달의 건별 조정을 해제할까요? (상시 규칙·자동 계산으로 복귀)")) saveAdjust(true);
  });
  document.getElementById("pay-adj-close").addEventListener("click", () =>
    document.getElementById("pay-adjust-dialog").close());
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

let lastPeriod = null; // 조정 저장 후 재조회용 {type, value}

async function renderAggregate(type, value) {
  lastPeriod = { type, value };
  const adjByYm = await fetchPayAdjustments(type, value);
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
      inst, key, type: eff.instructorType, dates: new Map(), hours: 0, monthFee: {}, sessions: 0,
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
    // 월별 강사료: 기준 월상한 → 상시 상한 대체 → 월별 건별 최종액 순으로 적용.
    let cappedFee = 0, adjustedFee = false;
    const reasons = new Set();
    for (const [ym, raw] of Object.entries(g.monthFee)) {
      const o = adjByYm[ym]?.[g.key];
      const r = adjustedMonthFee(raw, g.type, getFeeRatesAt(monthEnd(ym)), g.inst, o);
      cappedFee += r.fee;
      if (r.adjusted) { adjustedFee = true; if (r.reason) reasons.add(r.reason); }
    }
    // 여비: 출강일마다 1회(상시 고정액 반영). 월별 건별 여비 최종액이 있으면 그 달 여비를 통째로 대체.
    const travelByYm = {};
    let travelManual = false;
    for (const [date, basis] of g.dates.entries()) {
      const t = adjustedDayTravel(basis, getTravelRatesAt(date), g.inst);
      const ym = date.slice(0, 7);
      travelByYm[ym] = travelByYm[ym] || { sum: 0, adjusted: false };
      if (t.manual) travelManual = true; else travelByYm[ym].sum += t.amount;
      if (t.adjusted) { travelByYm[ym].adjusted = true; if (t.reason) reasons.add(t.reason); }
    }
    let travelSum = 0, adjustedTravel = false;
    for (const [ym, tv] of Object.entries(travelByYm)) {
      const o = adjByYm[ym]?.[g.key];
      if (o && o.travel != null) {
        travelSum += o.travel;
        adjustedTravel = true;
        if (o.reason) reasons.add(o.reason);
      } else {
        travelSum += tv.sum;
        if (tv.adjusted) adjustedTravel = true;
      }
    }
    totFee += cappedFee;
    totTravel += travelSum;
    rows.push({
      name: g.inst.name,
      key: g.key,
      type: g.type,
      days: g.dates.size,
      hours: g.hours,
      fee: cappedFee,
      travel: travelSum,
      travelManual,
      adjustedFee, adjustedTravel,
      adjustReasons: [...reasons],
      total: cappedFee + travelSum,
      items: g.items || [],
      monthFee: g.monthFee,
      dates: g.dates,
      inst: g.inst,
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
        const adjTitle = r.adjustReasons.length ? ` title="조정 사유: ${escapeHtml(r.adjustReasons.join(" / "))}"` : "";
        const tr = document.createElement("tr");
        tr.innerHTML = `
          <td>${escapeHtml(r.name)} <button type="button" class="pay-detail-btn" title="출강 과정·과목·시간 등 계산근거">세부</button>${type === "month" ? ` <button type="button" class="pay-adjust-btn" title="이 달 지급액 조정(사유 기재)">조정</button>` : ""}</td>
          <td>${escapeHtml(r.type)}</td>
          <td style="text-align:right">${r.days}</td>
          <td style="text-align:right">${r.hours}</td>
          <td style="text-align:right"${adjTitle}>${won(r.fee)}${r.adjustedFee ? " <span class='warn'>(조정)</span>" : ""}</td>
          <td style="text-align:right"${adjTitle}>${won(r.travel)}${r.adjustedTravel ? " <span class='warn'>(조정)</span>" : ""}${r.travelManual ? " <span class='warn'>(수동확인)</span>" : ""}</td>
          <td style="text-align:right"><b>${won(r.total)}</b></td>`;
        tr.querySelector(".pay-detail-btn").addEventListener("click", (e) => toggleDetail(tr, r, e.target));
        tr.querySelector(".pay-adjust-btn")?.addEventListener("click", () => openAdjustDialog(r, value));
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

// ── 월별 건별 지급 조정 다이얼로그 ──
let adjustTarget = null; // {row, ym}
async function openAdjustDialog(r, ym) {
  adjustTarget = { row: r, ym };
  document.getElementById("pay-adj-title").textContent = `${r.name} (${r.type}) — ${ym} 지급 조정`;
  document.getElementById("pay-adj-auto").textContent =
    `자동 계산: 강사료 ${won(r.fee)}${r.adjustedFee ? "(조정 반영)" : ""} · 여비 ${won(r.travel)}${r.adjustedTravel ? "(조정 반영)" : ""}` +
    (r.inst?.adjustReason ? ` · 상시 규칙: ${r.inst.adjustReason}` : "");
  // 기존 월별 건별 값 로드.
  let cur = null;
  try {
    const d = await getDoc(doc(db, "payAdjustments", ym));
    cur = d.exists() ? (d.data().items || {})[r.key] || null : null;
  } catch { /* */ }
  document.getElementById("pay-adj-fee").value = cur && cur.fee != null ? cur.fee : "";
  document.getElementById("pay-adj-travel").value = cur && cur.travel != null ? cur.travel : "";
  document.getElementById("pay-adj-reason").value = cur?.reason || "";
  document.getElementById("pay-adjust-dialog").showModal();
}

async function saveAdjust(clear) {
  if (!adjustTarget) return;
  const { row, ym } = adjustTarget;
  const feeV = document.getElementById("pay-adj-fee").value;
  const travelV = document.getElementById("pay-adj-travel").value;
  const reason = document.getElementById("pay-adj-reason").value.trim();
  try {
    const ref = doc(db, "payAdjustments", ym);
    if (clear || (feeV === "" && travelV === "")) {
      const d = await getDoc(ref);
      if (d.exists()) await updateDoc(ref, { [`items.${row.key}`]: deleteField(), updatedAtMs: Date.now() });
    } else {
      if (!reason) return alert("조정 사유를 입력하세요(필수).");
      await setDoc(ref, {
        items: { [row.key]: {
          fee: feeV === "" ? null : Math.max(0, Number(feeV)),
          travel: travelV === "" ? null : Math.max(0, Number(travelV)),
          reason,
        } },
        updatedAtMs: Date.now(),
      }, { merge: true });
    }
    document.getElementById("pay-adjust-dialog").close();
    if (lastPeriod) renderAggregate(lastPeriod.type, lastPeriod.value);
  } catch (e) { alert("저장 실패: " + e.message + "\n(보안규칙 payAdjustments 배포 여부를 확인하세요)"); }
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
    ${(r.adjustedFee || r.adjustedTravel) ? `<p class="hint"><b>지급 조정 적용</b> — 사유: ${escapeHtml(r.adjustReasons.join(" / ") || "(사유 미기재)")} <small>(표의 강사료·여비는 조정 반영 후 금액)</small></p>` : ""}
  </td>`;
  tr.after(detail);
}
