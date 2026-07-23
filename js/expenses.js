// 소요경비 집계 (8-2): 월별. 자동(사내/사외 강사료·출강여비) + 수동(교재연구비·물품·다과·추가항목) + 1인당 단가(이수인원 분모).
import {
  collection, getDocs, getDoc, doc, setDoc, query, where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./firebase.js";
import { escapeHtml } from "./app.js";
import { coursesCache } from "./courses.js";
import { getInstructorById } from "./instructors.js";
import { getFeeRates, getTravelRates } from "./settings.js";
import { calcHour, calcFee, applyMonthlyCap, calcTravel } from "./payroll.js";

let auto = { 사내: 0, 사외: 0, travel: 0, detail: [] }; // 자동 산출값(원) + 강사별 세부
let customItems = []; // 사용자 추가 수동 항목 [{label, amount}]

export function initExpenses() {
  const now = new Date();
  document.getElementById("exp-month").value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  document.getElementById("exp-run").addEventListener("click", run);
  document.getElementById("exp-save").addEventListener("click", save);
}

// 그 월 시간표에서 강사유형별 강사료·여비 자동 산출 + 강사별 세부.
async function computeAuto(month) {
  const feeRates = getFeeRates();
  const travelRates = getTravelRates();
  const snap = await getDocs(query(collection(db, "sessions"),
    where("date", ">=", `${month}-01`), where("date", "<=", `${month}-31`)));
  const byInst = {};
  for (const d of snap.docs) {
    const s = d.data();
    if (!s.instructorId) continue;
    const inst = getInstructorById(s.instructorId);
    if (!inst) continue;
    const g = byInst[s.instructorId] = byInst[s.instructorId] || { inst, fee: 0, hours: 0, dates: new Set() };
    const h = calcHour(s.startTime, s.endTime);
    g.fee += calcFee(inst.instructorType, h, feeRates);
    g.hours += h;
    g.dates.add(s.date);
  }
  const out = { 사내: 0, 사외: 0, travel: 0, detail: [] };
  for (const g of Object.values(byInst)) {
    const capped = applyMonthlyCap(g.fee, g.inst.instructorType, feeRates);
    const t = g.inst.instructorType || "";
    let travel = 0;
    for (const _ of g.dates) { const tr = calcTravel(g.inst.travelBasis, travelRates); if (!tr.manual) travel += tr.amount; }
    if (t.startsWith("사내")) out.사내 += capped;
    else if (t.startsWith("사외")) out.사외 += capped;
    out.travel += travel;
    out.detail.push({
      name: g.inst.name || "(미상)", type: t || "(미지정)",
      days: g.dates.size, hours: g.hours, fee: capped, travel,
    });
  }
  out.detail.sort((a, b) => (b.fee + b.travel) - (a.fee + a.travel));
  return out;
}

async function run() {
  const month = document.getElementById("exp-month").value;
  if (!month) return alert("월을 선택하세요.");
  const box = document.getElementById("exp-table");
  box.innerHTML = "조회 중…";
  auto = await computeAuto(month);
  // 저장된 수동값 로드.
  let saved = {};
  try { const d = await getDoc(doc(db, "expenses", month)); if (d.exists()) saved = d.data(); } catch { /* */ }
  customItems = Array.isArray(saved.custom)
    ? saved.custom.map((c) => ({ label: c.label || "", amount: Number(c.amount) || 0 }))
    : [];
  // 그 월 시작 차수의 이수인원 합(기본값).
  const completedDefault = coursesCache
    .filter((c) => (c.startDate || "").slice(0, 7) === month)
    .reduce((s, c) => s + (c.completedCount || 0), 0);

  render(box, {
    materialResearch: saved.materialResearch ?? 0,
    supplies: saved.supplies ?? 0,
    refreshments: saved.refreshments ?? 0,
    completed: saved.completed ?? completedDefault,
  });
  renderDetail();
}

function customRows() {
  const won = (n) => (n || 0).toLocaleString("ko-KR");
  return customItems.map((c, i) => `
    <tr data-ci="${i}">
      <td>+</td>
      <td><input type="text" class="c-label" data-i="${i}" value="${escapeHtml(c.label)}" placeholder="항목명"></td>
      <td><input type="number" min="0" class="c-amt" data-i="${i}" value="${c.amount}"></td>
      <td><button type="button" class="c-del" data-i="${i}">삭제</button></td>
    </tr>`).join("");
}

function render(box, v) {
  const won = (n) => (n || 0).toLocaleString("ko-KR");
  box.innerHTML = `
    <table id="exp-tbl">
      <thead><tr><th>구분</th><th>내용</th><th>비용(원)</th><th>비고</th></tr></thead>
      <tbody>
        <tr><td>1</td><td>전임교관 교재연구비</td><td><input type="number" min="0" id="e-material" value="${v.materialResearch}"></td><td>복리후생비-교재연구(수동)</td></tr>
        <tr><td>2</td><td>사내강사료</td><td class="num" id="e-in">${won(auto.사내)}</td><td>자동(강사료 계산)</td></tr>
        <tr><td>3</td><td>사외강사료</td><td class="num" id="e-out">${won(auto.사외)}</td><td>자동(강사료 계산)</td></tr>
        <tr><td>4</td><td>출강여비</td><td class="num" id="e-travel">${won(auto.travel)}</td><td>자동(고정 여비 합)</td></tr>
        <tr><td>5</td><td>물품(교재·교구 등)</td><td><input type="number" min="0" id="e-supplies" value="${v.supplies}"></td><td>수동</td></tr>
        <tr><td>6</td><td>다과 및 간식</td><td><input type="number" min="0" id="e-refresh" value="${v.refreshments}"></td><td>수동</td></tr>
        ${customRows()}
        <tr><td colspan="4"><button type="button" id="e-add">+ 비용항목 추가</button></td></tr>
        <tr class="sum-row"><td colspan="2"><b>합계</b></td><td class="num" id="e-total"></td><td></td></tr>
        <tr><td colspan="2">이수인원(명)</td><td><input type="number" min="0" id="e-completed" value="${v.completed}"></td><td>1인당 단가 분모</td></tr>
        <tr class="sum-row"><td colspan="2"><b>교육생 1인당 단가</b></td><td class="num" id="e-unit"></td><td></td></tr>
      </tbody>
    </table>`;
  ["e-material", "e-supplies", "e-refresh", "e-completed"].forEach((id) =>
    document.getElementById(id).addEventListener("input", recompute));
  box.querySelectorAll(".c-label").forEach((el) =>
    el.addEventListener("input", (e) => { customItems[+e.target.dataset.i].label = e.target.value; }));
  box.querySelectorAll(".c-amt").forEach((el) =>
    el.addEventListener("input", (e) => { customItems[+e.target.dataset.i].amount = Number(e.target.value) || 0; recompute(); }));
  box.querySelectorAll(".c-del").forEach((el) =>
    el.addEventListener("click", (e) => { customItems.splice(+e.target.dataset.i, 1); render(box, readValues()); }));
  document.getElementById("e-add").addEventListener("click", () => {
    customItems.push({ label: "", amount: 0 });
    render(box, readValues());
  });
  recompute();
}

// 현재 입력값을 읽어 render 재호출 시 유지.
function readValues() {
  const num = (id) => (document.getElementById(id) ? Number(document.getElementById(id).value) || 0 : 0);
  return {
    materialResearch: num("e-material"), supplies: num("e-supplies"),
    refreshments: num("e-refresh"), completed: num("e-completed"),
  };
}

function customTotal() {
  return customItems.reduce((s, c) => s + (Number(c.amount) || 0), 0);
}

function recompute() {
  const num = (id) => Number(document.getElementById(id).value) || 0;
  const total = auto.사내 + auto.사외 + auto.travel
    + num("e-material") + num("e-supplies") + num("e-refresh") + customTotal();
  const completed = num("e-completed");
  document.getElementById("e-total").textContent = total.toLocaleString("ko-KR");
  document.getElementById("e-unit").textContent = completed ? Math.round(total / completed).toLocaleString("ko-KR") + " 원/명" : "-";
}

// 강사별 세부 내역(사내/사외 강사료·여비 산출 근거).
function renderDetail() {
  const box = document.getElementById("exp-detail");
  if (!box) return;
  if (!auto.detail.length) { box.innerHTML = `<p class="hint">강사별 세부 내역: 해당 월 시간표에 강사 배정 세션이 없습니다.</p>`; return; }
  const won = (n) => (n || 0).toLocaleString("ko-KR");
  const rows = auto.detail.map((d) => `<tr>
    <td>${escapeHtml(d.name)}</td><td>${escapeHtml(d.type)}</td>
    <td style="text-align:right">${d.days}</td>
    <td style="text-align:right">${d.hours}</td>
    <td class="num">${won(d.fee)}</td>
    <td class="num">${won(d.travel)}</td>
    <td class="num">${won(d.fee + d.travel)}</td></tr>`).join("");
  box.innerHTML = `<details open><summary>강사별 세부 내역 (강사료·여비 산출 근거)</summary>
    <table id="exp-detail-tbl"><thead><tr><th>강사</th><th>유형</th><th>출강일수</th><th>강의시간</th><th>강사료(월상한 적용)</th><th>여비</th><th>소계</th></tr></thead>
    <tbody>${rows}</tbody></table></details>`;
}

async function save() {
  const month = document.getElementById("exp-month").value;
  if (!document.getElementById("e-material")) return alert("먼저 조회하세요.");
  const num = (id) => Number(document.getElementById(id).value) || 0;
  const custom = customItems
    .filter((c) => (c.label || "").trim() || c.amount)
    .map((c) => ({ label: (c.label || "").trim(), amount: Number(c.amount) || 0 }));
  const payload = {
    yearMonth: month,
    materialResearch: num("e-material"),
    supplies: num("e-supplies"),
    refreshments: num("e-refresh"),
    completed: num("e-completed"),
    custom,
    autoInHouse: auto.사내, autoOutsource: auto.사외, autoTravel: auto.travel,
    total: auto.사내 + auto.사외 + auto.travel
      + num("e-material") + num("e-supplies") + num("e-refresh")
      + custom.reduce((s, c) => s + c.amount, 0),
    updatedAtMs: Date.now(),
  };
  try {
    await setDoc(doc(db, "expenses", month), payload, { merge: true });
    alert("소요경비를 저장했습니다.");
  } catch (e) { alert("저장 실패: " + e.message); }
}
