// AI(LLM) 연동 화면: 설정 → AI 연결(모델 등록·연결 테스트·실행 기록) + 주관식 원문 → AI 분석.
// 호출은 모두 서버 함수(functions/ai.js)를 거친다 — 키 보관·개인정보 가림이 서버에서 이뤄진다.
import {
  collection, getDocs, getDoc, doc, setDoc, writeBatch, query, orderBy, limit,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { db, app } from "./firebase.js";
import { escapeHtml } from "./app.js";

const fns = getFunctions(app, "asia-northeast3");
// 분석은 모델 속도에 따라 수 분 걸릴 수 있다(기본 70초 제한을 늘린다).
const callTest = httpsCallable(fns, "aiTestProvider", { timeout: 130000 });
const callAnalyze = httpsCallable(fns, "aiAnalyzeFreetext", { timeout: 560000 });

// 등록 예시(출발점). 실제 주소·모델명은 제공처 안내를 확인한다.
// 자체 구축(Ollama·vLLM)은 서버 함수가 클라우드에서 호출하므로 외부에서 닿는 주소여야 한다.
const PRESETS = [
  ["Gemma 3 (Ollama 자체 구축)", "http://서버주소:11434/v1", "gemma3:12b"],
  ["Llama 3.1 (Ollama 자체 구축)", "http://서버주소:11434/v1", "llama3.1:8b"],
  ["GPT-OSS (Ollama 자체 구축)", "http://서버주소:11434/v1", "gpt-oss:20b"],
  ["EXAONE 3.5 (Ollama 자체 구축)", "http://서버주소:11434/v1", "exaone3.5:7.8b"],
  ["Solar (Upstage)", "https://api.upstage.ai/v1", "solar-pro2"],
  ["HyperCLOVA X (CLOVA Studio)", "https://clovastudio.stream.ntruss.com/v1/openai", "HCX-005"],
  ["Gemma 3 (OpenRouter)", "https://openrouter.ai/api/v1", "google/gemma-3-27b-it"],
  ["Llama 3.3 (OpenRouter)", "https://openrouter.ai/api/v1", "meta-llama/llama-3.3-70b-instruct"],
  ["GPT-OSS (OpenRouter)", "https://openrouter.ai/api/v1", "openai/gpt-oss-120b"],
];

let providers = []; // [{id, name, baseUrl, model, jsonMode, hasKey}]
let defaultId = "";
const newKeys = {}; // id → 이번에 새로 입력한 키(저장 시에만 서버로)

const newId = () => "p" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

export function initAiAdmin() {
  const preset = document.getElementById("ai-preset");
  if (!preset) return;
  preset.innerHTML += PRESETS.map((p, i) => `<option value="${i}">${escapeHtml(p[0])}</option>`).join("");
  preset.addEventListener("change", () => {
    const p = PRESETS[Number(preset.value)];
    preset.value = "";
    if (!p) return;
    providers.push({ id: newId(), name: p[0], baseUrl: p[1], model: p[2], jsonMode: false, hasKey: false });
    if (!defaultId) defaultId = providers[0].id;
    paintProviders();
  });
  document.getElementById("ai-prov-add").addEventListener("click", () => {
    providers.push({ id: newId(), name: "", baseUrl: "", model: "", jsonMode: false, hasKey: false });
    if (!defaultId) defaultId = providers[0].id;
    paintProviders();
  });
  document.getElementById("ai-prov-save").addEventListener("click", saveProviders);
  document.getElementById("ai-prov-body").addEventListener("input", onProvInput);
  document.getElementById("ai-prov-body").addEventListener("change", onProvInput);
  document.getElementById("ai-prov-body").addEventListener("click", onProvClick);
  document.getElementById("ai-run").addEventListener("click", runAnalysis);
  document.addEventListener("tabshown", (e) => {
    if (e.detail === "settings" || e.detail === "freetext" || e.detail === "reportdoc") loadProviders();
    if (e.detail === "settings") loadRuns();
  });
}

// ── 설정: 연결 목록 ──
async function loadProviders() {
  try {
    const d = await getDoc(doc(db, "settings", "ai"));
    const v = d.exists() ? d.data() : {};
    providers = Array.isArray(v.providers) ? v.providers.map((p) => ({ ...p })) : [];
    defaultId = v.defaultId || providers[0]?.id || "";
  } catch { providers = []; defaultId = ""; }
  paintProviders();
  paintRunSelect();
}

function paintProviders() {
  const body = document.getElementById("ai-prov-body");
  if (!body) return;
  if (!providers.length) {
    body.innerHTML = `<tr><td colspan="7" class="empty">등록된 모델이 없습니다. 예시에서 추가하거나 빈 행을 추가하세요.</td></tr>`;
    return;
  }
  // 한 화면에 들어오도록 입력칸은 칸 너비를 따르고(width:100%), 연결 테스트 결과는
  // 바로 아래 줄 전체 폭으로 보여 준다(관리 열이 결과 글자로 넓어지지 않게).
  body.innerHTML = providers.map((p, i) => `<tr data-i="${i}" class="ai-prov-row">
    <td style="text-align:center"><input type="radio" name="ai-default" data-f="default" ${p.id === defaultId ? "checked" : ""} title="기본 모델"></td>
    <td><input data-f="name" value="${escapeHtml(p.name || "")}" placeholder="표시 이름"></td>
    <td><input data-f="baseUrl" value="${escapeHtml(p.baseUrl || "")}" placeholder="https://…/v1"></td>
    <td><input data-f="model" value="${escapeHtml(p.model || "")}" placeholder="모델명"></td>
    <td style="text-align:center"><input type="checkbox" data-f="jsonMode" ${p.jsonMode ? "checked" : ""} title="JSON 모드"></td>
    <td><input type="password" data-f="key" autocomplete="new-password" placeholder="${p.hasKey ? "등록됨(바꿀 때만)" : "필요 시 입력"}"></td>
    <td class="actions">
      <button type="button" data-act="test">테스트</button>
      <button type="button" class="del" data-act="del">삭제</button>
    </td></tr>
    <tr data-out="${i}" hidden><td></td><td colspan="6" class="hint ai-test-out"></td></tr>`).join("");
}

function onProvInput(e) {
  const tr = e.target.closest("tr[data-i]");
  if (!tr) return;
  const p = providers[Number(tr.dataset.i)];
  const f = e.target.dataset.f;
  if (f === "default") defaultId = p.id;
  else if (f === "jsonMode") p.jsonMode = e.target.checked;
  else if (f === "key") newKeys[p.id] = e.target.value;
  else if (f) p[f] = e.target.value;
}

async function onProvClick(e) {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const tr = btn.closest("tr[data-i]");
  const i = Number(tr.dataset.i);
  const p = providers[i];
  if (btn.dataset.act === "del") {
    if (!confirm(`'${p.name || p.model || "이 연결"}'을(를) 목록에서 지웁니다. 저장해야 반영됩니다.`)) return;
    providers.splice(i, 1);
    if (defaultId === p.id) defaultId = providers[0]?.id || "";
    paintProviders();
    return;
  }
  // 연결 테스트는 '저장된' 설정으로 서버에서 실행한다(키가 서버에만 있으므로).
  const outRow = tr.nextElementSibling;
  const out = outRow.querySelector(".ai-test-out");
  outRow.hidden = false;
  out.textContent = "테스트 중…";
  btn.disabled = true;
  try {
    const r = (await callTest({ providerId: p.id })).data;
    out.innerHTML = r.ok
      ? `✅ ${(r.elapsedMs / 1000).toFixed(1)}초 · 응답 모델 <b>${escapeHtml(r.servedModel || "")}</b>${r.jsonOk ? "" : " · <span class='warn'>JSON 형식 아님</span>"}<br><small>${escapeHtml(r.reply || "")}</small>`
      : `❌ ${escapeHtml(r.error || "실패")}`;
  } catch (err) {
    out.textContent = "❌ " + (err.message || err) + " (저장하지 않은 연결은 먼저 저장하세요)";
  } finally { btn.disabled = false; loadRuns(); }
}

async function saveProviders() {
  for (const p of providers) {
    p.name = String(p.name || "").trim();
    p.baseUrl = String(p.baseUrl || "").trim();
    p.model = String(p.model || "").trim();
    if (!p.baseUrl || !p.model) return alert(`'${p.name || "이름 없음"}'의 접속 주소와 모델명을 입력하세요.`);
    if (!/^https?:\/\//.test(p.baseUrl)) return alert(`'${p.name || p.model}'의 접속 주소는 http:// 또는 https://로 시작해야 합니다.`);
    if (/서버주소/.test(p.baseUrl)) return alert(`'${p.name}'의 '서버주소'를 실제 주소로 바꾸세요.`);
  }
  try {
    // 키부터 저장 → 목록의 hasKey 표시가 실제와 어긋나지 않게.
    for (const [id, key] of Object.entries(newKeys)) {
      if (!key || !providers.some((p) => p.id === id)) continue;
      await setDoc(doc(db, "aiKeys", id), { key: key.trim(), updatedAtMs: Date.now() });
      providers.find((p) => p.id === id).hasKey = true;
    }
    Object.keys(newKeys).forEach((k) => delete newKeys[k]);
    await setDoc(doc(db, "settings", "ai"), {
      providers: providers.map(({ id, name, baseUrl, model, jsonMode, hasKey }) => ({ id, name, baseUrl, model, jsonMode: !!jsonMode, hasKey: !!hasKey })),
      defaultId: providers.some((p) => p.id === defaultId) ? defaultId : (providers[0]?.id || ""),
      updatedAtMs: Date.now(),
    });
    paintProviders();
    paintRunSelect();
    alert("AI 연결을 저장했습니다. '연결 테스트'로 동작을 확인하세요.");
  } catch (e) {
    alert("저장 실패: " + e.message + "\n(AI 연결 등록·수정은 마스터 계정만 가능합니다)");
  }
}

// ── 설정: 실행 기록(모델 비교·구동 입증용) ──
async function loadRuns() {
  const body = document.getElementById("ai-runs-body");
  if (!body) return;
  try {
    const snap = await getDocs(query(collection(db, "aiRuns"), orderBy("at", "desc"), limit(20)));
    if (snap.empty) { body.innerHTML = `<tr><td colspan="6" class="empty">실행 기록이 없습니다.</td></tr>`; return; }
    const fmt = new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "short", timeStyle: "short" });
    body.innerHTML = snap.docs.map((d) => {
      const r = d.data();
      const res = r.ok
        ? (r.kind === "freetext" ? `✅ 분류 ${r.classified ?? "-"}/${r.classifiable ?? "-"}건 · 가림 ${r.maskedCount ?? 0}건`
          : r.kind === "report" ? `✅ 보고서 초안${r.unverified?.length ? ` · <span class='warn'>확인 안 된 숫자 ${r.unverified.length}개</span>` : " · 숫자 대조 통과"}`
          : "✅ 연결 정상")
        : `❌ ${escapeHtml(r.error || "")}`;
      return `<tr><td>${fmt.format(new Date(r.at))}</td><td>${r.kind === "freetext" ? `주관식 분석 ${escapeHtml(r.month || "")}` : r.kind === "report" ? `보고서 ${escapeHtml(r.month || "")}` : "연결 테스트"}</td>
        <td>${escapeHtml(r.providerName || "")}</td><td>${escapeHtml(r.servedModel || r.model || "")}</td>
        <td>${res}</td><td style="text-align:right">${r.elapsedMs != null ? (r.elapsedMs / 1000).toFixed(1) + "초" : "-"}</td></tr>`;
    }).join("");
  } catch (e) { body.innerHTML = `<tr><td colspan="6" class="empty">불러오기 실패: ${escapeHtml(e.message)}</td></tr>`; }
}

// ── 주관식 원문: AI 분석 ──
// 모델 선택 상자(주관식 원문 #ai-run-provider, 운영 보고서 .ai-provider-select)를 채운다.
function paintRunSelect() {
  const sels = new Set([document.getElementById("ai-run-provider"), ...document.querySelectorAll(".ai-provider-select")]);
  for (const sel of sels) {
    if (!sel) continue;
    const prev = sel.value;
    sel.innerHTML = providers.length
      ? providers.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name || p.model)}${p.id === defaultId ? " (기본)" : ""}</option>`).join("")
      : `<option value="">(설정 → AI 연결에서 등록)</option>`;
    sel.value = providers.some((p) => p.id === prev) ? prev : defaultId;
  }
}

async function runAnalysis() {
  const month = document.getElementById("ft-month").value;
  const providerId = document.getElementById("ai-run-provider").value;
  const status = document.getElementById("ai-run-status");
  if (!month) return alert("위 '원문 조회 · 분류'에서 기간(월)을 먼저 고르세요.");
  if (!providerId) return alert("설정 → AI 연결에서 모델을 먼저 등록하세요.");
  const btn = document.getElementById("ai-run");
  btn.disabled = true;
  const t0 = Date.now();
  const tick = setInterval(() => { status.textContent = `분석 중… ${Math.round((Date.now() - t0) / 1000)}초 (모델에 따라 수 분 걸릴 수 있습니다)`; }, 1000);
  try {
    const r = (await callAnalyze({ month, providerId })).data;
    status.textContent = "";
    renderResult(r);
  } catch (e) {
    status.textContent = "";
    alert(e.message || e);
  } finally { clearInterval(tick); btn.disabled = false; }
}

// 결과 카드: 실행할 때마다 위에 쌓인다 → 모델별 결과를 나란히 비교.
function renderResult(r) {
  const box = document.getElementById("ai-results");
  const card = document.createElement("div");
  card.className = "ai-card";
  const countStr = Object.entries(r.counts || {}).map(([k, v]) => `${escapeHtml(k)} ${v}`).join(" · ") || "-";
  const rows = r.items.map((x) => `<tr>
      <td>${escapeHtml(x.course)}</td><td>${escapeHtml(x.kind)}</td>
      <td class="raw-free">${escapeHtml(x.text)}</td>
      <td>${x.field ? (x.cat ? escapeHtml(x.cat) : "<span class='muted'>(미분류)</span>") : "<span class='muted'>분류 대상 아님</span>"}</td></tr>`).join("");
  card.innerHTML = `
    <div class="ai-card-head">
      <b>${escapeHtml(r.provider.name || r.provider.model)}</b>
      <span class="muted">${escapeHtml(r.provider.servedModel || r.provider.model)} · ${escapeHtml(r.month)} · ${(r.elapsedMs / 1000).toFixed(1)}초 · 모델 호출 ${r.calls}회</span>
      <button type="button" class="ai-close" title="이 결과 닫기">×</button>
    </div>
    <p class="hint">분류 ${r.classified}/${r.classifiable}건 · 개인정보 가림 ${r.maskedCount}건${r.skipped ? ` · <span class="warn">상한 초과로 ${r.skipped}건 제외</span>` : ""}<br>분류별: ${countStr}</p>
    <div class="ai-draft"><b>시사점 초안</b><pre class="report-narr">${escapeHtml(r.summary || "-")}</pre></div>
    <div class="ai-draft"><b>피드백 반영계획 초안</b><pre class="report-narr">${escapeHtml(r.action || "-")}</pre></div>
    <div class="form-actions">
      <button type="button" class="ai-apply-cat">분류 적용 (${r.items.filter((x) => x.field && x.cat).length}건)</button>
      <button type="button" class="ai-apply-narr">시사점·반영계획 초안 넣기</button>
    </div>
    <details><summary>모델로 보낸 원문과 분류 결과 (${r.items.length}건)</summary>
      <div class="table-wrap"><table><thead><tr><th>과정</th><th>종류</th><th>보낸 원문(가림 처리)</th><th>AI 분류</th></tr></thead><tbody>${rows}</tbody></table></div>
    </details>`;
  card.querySelector(".ai-close").addEventListener("click", () => card.remove());
  card.querySelector(".ai-apply-narr").addEventListener("click", () => {
    const sum = document.getElementById("ft-summary");
    const act = document.getElementById("ft-action");
    if ((sum.value.trim() || act.value.trim()) && !confirm("입력돼 있는 시사점·반영계획을 이 초안으로 바꿉니다. 계속할까요?")) return;
    sum.value = r.summary || "";
    act.value = r.action || "";
    sum.scrollIntoView({ behavior: "smooth", block: "center" });
    alert("초안을 넣었습니다. 다듬은 뒤 '시사점·피드백 저장'을 눌러야 저장됩니다.");
  });
  card.querySelector(".ai-apply-cat").addEventListener("click", async (e) => {
    const list = r.items.filter((x) => x.field && x.cat);
    if (!list.length) return alert("적용할 분류가 없습니다.");
    if (!confirm(`AI 분류 ${list.length}건을 원문에 반영합니다(기존 분류는 덮어씀). 계속할까요?`)) return;
    e.target.disabled = true;
    try {
      for (let i = 0; i < list.length; i += 400) {
        const b = writeBatch(db);
        for (const x of list.slice(i, i + 400)) b.update(doc(db, "surveyResponses", x.rid), { [x.field]: x.cat });
        await b.commit();
      }
      alert(`${list.length}건을 반영했습니다.`);
      document.getElementById("ft-search").click(); // 위 원문 목록·분류별 건수 새로고침
    } catch (err) { alert("반영 실패: " + err.message); e.target.disabled = false; }
  });
  box.prepend(card);
}
