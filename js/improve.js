// 개선 효과 추적(닫힌 고리): 피드백 반영계획 → 개선 조치 → 이행 → 효과 확인.
// - 조치 추출만 AI가 돕고(aiExtractActions), 효과 판정은 시스템이 데이터로 계산한다.
// - 효과 지표: 해당 분류의 '불만족' 의견 수 ÷ 응답자 수 × 100 (응답자 100명당 건수).
//   조치 완료 월을 기준으로 이전 3개월과 이후 3개월을 비교한다(완료 월 자체는 제외).
// - 분류는 주관식 원문의 분류(catDissatisfied)를 쓴다 — AI 분석의 '분류 적용' 또는 수동 분류가 필요.
import {
  collection, getDocs, getDoc, doc, addDoc, updateDoc, deleteDoc, query, where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { db, app } from "./firebase.js";
import { escapeHtml } from "./app.js";

const WINDOW = 3;        // 전·후 비교 개월 수
const MIN_N = 10;        // 이보다 응답이 적으면 '데이터 부족'(소표본 원칙과 같은 기준)
const STATUSES = ["계획", "진행", "완료"];
const DEFAULT_CATS = ["현업 활용", "강의 방식", "교재/자료", "시설/환경", "운영/진행", "기타"];

export function addMonths(ym, k) {
  const [y, m] = ym.split("-").map(Number);
  const d = new Date(y, m - 1 + k, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
const thisMonth = () => {
  const d = new Date(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date()));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

// 기간의 월별 응답자 수와 분류별 불만족 건수. { 'YYYY-MM': { n, cats: {분류: 건수} } }
export async function monthlyCategoryStats(fromMonth, toMonth) {
  const snap = await getDocs(query(collection(db, "surveyResponses"),
    where("collectedDate", ">=", `${fromMonth}-01`), where("collectedDate", "<=", `${toMonth}-31`)));
  const out = {};
  for (const d of snap.docs) {
    const r = d.data();
    const ym = String(r.collectedDate || "").slice(0, 7);
    const g = out[ym] = out[ym] || { n: 0, cats: {} };
    g.n++;
    if (r.catDissatisfied) g.cats[r.catDissatisfied] = (g.cats[r.catDissatisfied] || 0) + 1;
  }
  return out;
}

function windowSum(stats, category, months) {
  let n = 0, count = 0, used = 0;
  for (const m of months) {
    const g = stats[m];
    if (!g) continue;
    used++; n += g.n; count += g.cats[category] || 0;
  }
  return { n, count, months: used, rate: n ? (count / n) * 100 : null };
}

// 완료 월 기준 전·후 비교. 이후 기간은 지금까지 지난 달만 센다.
export function effectOf(stats, category, doneMonth, nowMonth = thisMonth()) {
  const before = windowSum(stats, category, [...Array(WINDOW)].map((_, i) => addMonths(doneMonth, -(i + 1))));
  const afterMonths = [...Array(WINDOW)].map((_, i) => addMonths(doneMonth, i + 1)).filter((m) => m <= nowMonth);
  const after = windowSum(stats, category, afterMonths);
  let verdict = "데이터 부족";
  if (before.n >= MIN_N && after.n >= MIN_N) {
    const b = before.rate, a = after.rate;
    if (b === 0 && a === 0) verdict = "변화 없음";
    else {
      const rel = (a - b) / Math.max(b, 0.1);
      verdict = rel <= -0.2 ? "개선" : rel >= 0.2 ? "악화" : "변화 없음";
    }
  }
  return { before, after, delta: before.rate != null && after.rate != null ? after.rate - before.rate : null, verdict };
}

const f1 = (v) => (v == null ? "-" : v.toFixed(1));
const VERDICT_CLS = { "개선": "board-open", "악화": "board-full", "변화 없음": "muted", "데이터 부족": "muted" };
export function effectCell(e) {
  if (!e) return "-";
  return `<span class="${VERDICT_CLS[e.verdict] || ""}"><b>${e.verdict}</b></span><br>
    <small>${f1(e.before.rate)} → ${f1(e.after.rate)}건/100명 (응답 ${e.before.n}→${e.after.n})</small>`;
}

// ── 화면 ──
let categories = DEFAULT_CATS.slice();
let items = []; // [{id, action, category, planMonth, status, doneMonth, source}]
let stats = {};

export function initImprove() {
  const panel = document.querySelector('[data-tab="improve"]');
  if (!panel) return;
  document.getElementById("im-month").value = addMonths(thisMonth(), -1);
  document.getElementById("im-extract").addEventListener("click", extract);
  document.getElementById("im-add").addEventListener("click", addManual);
  document.getElementById("im-body").addEventListener("change", onRowChange);
  document.getElementById("im-body").addEventListener("click", onRowClick);
  document.addEventListener("tabshown", (e) => { if (e.detail === "improve") load(); });
}

async function loadCategories() {
  try {
    const d = await getDoc(doc(db, "settings", "surveyCategories"));
    if (d.exists() && Array.isArray(d.data().list) && d.data().list.length) categories = d.data().list.map(String);
  } catch { /* 기본 분류 */ }
  const opts = categories.map((c) => `<option>${escapeHtml(c)}</option>`).join("");
  document.getElementById("im-new-cat").innerHTML = opts;
}

async function load() {
  await loadCategories();
  const body = document.getElementById("im-body");
  body.innerHTML = `<tr><td colspan="7" class="empty">불러오는 중…</td></tr>`;
  try {
    const snap = await getDocs(collection(db, "improvements"));
    items = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.planMonth || "").localeCompare(a.planMonth || "") || (a.createdAtMs || 0) - (b.createdAtMs || 0));
    // 효과 계산에 필요한 범위만 한 번에 조회(가장 이른 완료 월 -3개월 ~ 이번 달).
    const dones = items.filter((x) => x.status === "완료" && x.doneMonth).map((x) => x.doneMonth).sort();
    stats = dones.length ? await monthlyCategoryStats(addMonths(dones[0], -WINDOW), thisMonth()) : {};
  } catch (e) { body.innerHTML = `<tr><td colspan="7" class="empty">불러오기 실패: ${escapeHtml(e.message)}</td></tr>`; return; }
  paint();
}

function paint() {
  const body = document.getElementById("im-body");
  if (!items.length) { body.innerHTML = `<tr><td colspan="7" class="empty">등록된 개선 조치가 없습니다. 위에서 반영계획을 가져오거나 직접 추가하세요.</td></tr>`; return; }
  const catOpts = (sel) => categories.concat(sel && !categories.includes(sel) ? [sel] : [])
    .map((c) => `<option${c === sel ? " selected" : ""}>${escapeHtml(c)}</option>`).join("");
  body.innerHTML = items.map((x, i) => {
    const eff = x.status === "완료" && x.doneMonth && x.category ? effectOf(stats, x.category, x.doneMonth) : null;
    return `<tr data-i="${i}">
      <td>${escapeHtml(x.action)}${x.source === "ai" ? ` <small class="muted">AI</small>` : ""}</td>
      <td><select data-f="category">${catOpts(x.category)}</select></td>
      <td>${escapeHtml(x.planMonth || "-")}</td>
      <td><select data-f="status">${STATUSES.map((s) => `<option${s === (x.status || "계획") ? " selected" : ""}>${s}</option>`).join("")}</select></td>
      <td><input type="month" data-f="doneMonth" value="${escapeHtml(x.doneMonth || "")}" ${x.status === "완료" ? "" : "disabled"}></td>
      <td>${x.status === "완료" ? (x.doneMonth ? effectCell(eff) : `<small class="muted">완료 월을 입력하세요</small>`) : `<small class="muted">완료 후 계산</small>`}</td>
      <td class="actions"><button type="button" class="del" data-act="del">삭제</button></td>
    </tr>`;
  }).join("");
}

async function onRowChange(e) {
  const tr = e.target.closest("tr[data-i]");
  if (!tr) return;
  const x = items[Number(tr.dataset.i)];
  const f = e.target.dataset.f;
  const patch = { [f]: e.target.value, updatedAtMs: Date.now() };
  // 완료로 바꾸면 완료 월 기본값을 이번 달로.
  if (f === "status" && e.target.value === "완료" && !x.doneMonth) patch.doneMonth = thisMonth();
  if (f === "status" && e.target.value !== "완료") patch.doneMonth = "";
  try {
    await updateDoc(doc(db, "improvements", x.id), patch);
    Object.assign(x, patch);
    if (f === "status" || f === "doneMonth") return load(); // 효과 계산 범위가 바뀔 수 있다
    paint();
  } catch (err) { alert("저장 실패: " + err.message); paint(); }
}

async function onRowClick(e) {
  const btn = e.target.closest("button[data-act='del']");
  if (!btn) return;
  const x = items[Number(btn.closest("tr").dataset.i)];
  if (!confirm(`'${x.action}' 조치를 삭제할까요?`)) return;
  try { await deleteDoc(doc(db, "improvements", x.id)); load(); } catch (err) { alert("삭제 실패: " + err.message); }
}

async function addManual() {
  const action = document.getElementById("im-new-action").value.trim();
  const category = document.getElementById("im-new-cat").value;
  const planMonth = document.getElementById("im-month").value;
  if (!action) return alert("조치 내용을 입력하세요.");
  try {
    await addDoc(collection(db, "improvements"), {
      action, category, planMonth, status: "계획", doneMonth: "", source: "manual", createdAtMs: Date.now(), updatedAtMs: Date.now(),
    });
    document.getElementById("im-new-action").value = "";
    load();
  } catch (err) { alert("등록 실패: " + err.message); }
}

// 반영계획에서 조치 추출(AI) → 미리보기에서 골라 등록.
async function extract() {
  const month = document.getElementById("im-month").value;
  const providerId = document.getElementById("im-provider").value;
  if (!month) return alert("반영계획의 월을 고르세요.");
  if (!providerId) return alert("설정 → AI 연결에서 모델을 먼저 등록하세요.");
  const btn = document.getElementById("im-extract");
  const box = document.getElementById("im-preview");
  btn.disabled = true;
  box.innerHTML = `<p class="hint">조치 추출 중…</p>`;
  try {
    const fn = httpsCallable(getFunctions(app, "asia-northeast3"), "aiExtractActions", { timeout: 190000 });
    const r = (await fn({ month, providerId })).data;
    renderPreview(r);
  } catch (e) { box.innerHTML = ""; alert(e.message || e); } finally { btn.disabled = false; }
}

function renderPreview(r) {
  const box = document.getElementById("im-preview");
  if (!r.actions.length) { box.innerHTML = `<p class="empty">추출된 조치가 없습니다.</p>`; return; }
  const catOpts = (sel) => `<option value="">(분류 선택)</option>` + r.categories.map((c) => `<option${c === sel ? " selected" : ""}>${escapeHtml(c)}</option>`).join("");
  box.innerHTML = `<div class="ai-card">
    <div class="ai-card-head"><b>${escapeHtml(r.provider.name || r.provider.model)}</b>
      <span class="muted">${escapeHtml(r.provider.servedModel || r.provider.model)} · ${escapeHtml(r.month)} 반영계획 · ${(r.elapsedMs / 1000).toFixed(1)}초</span></div>
    <div class="table-wrap"><table><thead><tr><th>등록</th><th>조치</th><th>분류</th></tr></thead><tbody>
    ${r.actions.map((a, i) => `<tr data-i="${i}"><td style="text-align:center"><input type="checkbox" class="p-on" checked></td>
      <td><input class="p-action" value="${escapeHtml(a.action)}" style="width:100%;box-sizing:border-box"></td>
      <td><select class="p-cat">${catOpts(a.category)}</select></td></tr>`).join("")}
    </tbody></table></div>
    <div class="form-actions"><button type="button" id="im-save-preview">선택한 조치 등록</button></div></div>`;
  document.getElementById("im-save-preview").addEventListener("click", async () => {
    const rows = [...box.querySelectorAll("tbody tr")].filter((tr) => tr.querySelector(".p-on").checked)
      .map((tr) => ({ action: tr.querySelector(".p-action").value.trim(), category: tr.querySelector(".p-cat").value }));
    if (!rows.length) return alert("등록할 조치를 고르세요.");
    if (rows.some((x) => !x.action || !x.category)) return alert("조치 내용과 분류를 모두 채우세요.");
    try {
      for (const x of rows) {
        await addDoc(collection(db, "improvements"), {
          ...x, planMonth: r.month, status: "계획", doneMonth: "", source: "ai", createdAtMs: Date.now(), updatedAtMs: Date.now(),
        });
      }
      box.innerHTML = "";
      load();
    } catch (err) { alert("등록 실패: " + err.message); }
  });
}
