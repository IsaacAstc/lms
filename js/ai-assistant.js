// AI 운영 비서: 자연어 질문 → 서버(aiAskOps)가 조회 도구를 골라 계산 → 답변.
// 화면은 대화 기록만 들고 있다(저장하지 않음). 최근 4개 문답을 맥락으로 함께 보낸다.
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { app } from "./firebase.js";
import { escapeHtml } from "./app.js";

const EXAMPLES = [
  "이번 주 진행되는 교육 알려줘",
  "다음 달 신청이 저조하거나 마감 임박한 차수는?",
  "이번 달 시간표에 강의실이나 강사가 겹치는 일정 있어?",
  "지난달 만족도가 가장 낮은 교육 문항은?",
  "지난달 불만족 의견은 어떤 분류가 많았어?",
  "아직 완료되지 않은 개선 조치 정리해줘",
];
const TOOL_LABEL = {
  courses_in_range: "차수 조회", capacity_alerts: "정원 점검", schedule_conflicts: "시간표 중복 점검",
  satisfaction: "만족도 집계", feedback_categories: "주관식 분류 집계", improvements_status: "개선 조치 현황",
};
const history = [];

export function initAssistant() {
  const panel = document.querySelector('[data-tab="assistant"]');
  if (!panel) return;
  const ex = document.getElementById("ask-examples");
  ex.innerHTML = EXAMPLES.map((q) => `<button type="button" class="ask-chip">${escapeHtml(q)}</button>`).join("");
  ex.addEventListener("click", (e) => {
    const b = e.target.closest(".ask-chip");
    if (!b) return;
    document.getElementById("ask-q").value = b.textContent;
    ask();
  });
  document.getElementById("ask-send").addEventListener("click", ask);
  document.getElementById("ask-q").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); ask(); }
  });
}

function bubble(cls, html) {
  const log = document.getElementById("ask-log");
  const el = document.createElement("div");
  el.className = `ask-msg ${cls}`;
  el.innerHTML = html;
  log.appendChild(el);
  el.scrollIntoView({ block: "nearest" });
  return el;
}

async function ask() {
  const qEl = document.getElementById("ask-q");
  const q = qEl.value.trim();
  const providerId = document.getElementById("ask-provider").value;
  if (!q) return;
  if (!providerId) return alert("설정 → AI 연결에서 모델을 먼저 등록하세요.");
  const btn = document.getElementById("ask-send");
  btn.disabled = true;
  qEl.value = "";
  bubble("me", escapeHtml(q));
  const wait = bubble("ai pending", "조회·정리 중…");
  const t0 = Date.now();
  const tick = setInterval(() => { wait.textContent = `조회·정리 중… ${Math.round((Date.now() - t0) / 1000)}초`; }, 1000);
  try {
    const fn = httpsCallable(getFunctions(app, "asia-northeast3"), "aiAskOps", { timeout: 310000 });
    const r = (await fn({ question: q, providerId, history })).data;
    history.push({ q, a: r.answer });
    if (history.length > 4) history.shift();
    const tools = r.steps.length
      ? r.steps.map((s) => `<span class="ask-tool">🔎 ${escapeHtml(TOOL_LABEL[s.tool] || s.tool)}${s.args && (s.args.from || s.args.month)
        ? ` <small>${escapeHtml(s.args.month || `${s.args.from}~${s.args.to}`)}</small>` : ""}</span>`).join("")
      : `<span class="ask-tool muted">조회 없이 답변</span>`;
    const warn = r.unverified?.length
      ? `<p class="warn">⚠ 조회 결과에서 확인되지 않은 숫자: <b>${r.unverified.map(escapeHtml).join(", ")}</b></p>` : "";
    const fb = r.fallback ? `<span class="muted"> · ${escapeHtml(r.fallback.from)} 실패 → <b>${escapeHtml(r.fallback.to)}</b>로 자동 대체</span>` : "";
    wait.className = "ask-msg ai";
    wait.innerHTML = `<div class="ask-tools">${tools}</div>
      <div class="ask-answer">${escapeHtml(r.answer).replace(/\n/g, "<br>")}</div>${warn}
      <div class="ask-meta muted">${escapeHtml(r.provider.servedModel || r.provider.model)} · ${(r.elapsedMs / 1000).toFixed(1)}초${fb}</div>
      ${r.results.length ? `<details><summary>조회 결과 보기</summary><pre>${escapeHtml(JSON.stringify(r.results, null, 2))}</pre></details>` : ""}`;
  } catch (e) {
    wait.className = "ask-msg ai err";
    wait.textContent = "실패: " + (e.message || e);
  } finally { clearInterval(tick); btn.disabled = false; qEl.focus(); }
}
