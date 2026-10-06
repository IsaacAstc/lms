// 공문·안내문 초안(AI): 출강 요청 · 교육 안내 · 결과 보고 본문.
// - 사실(일정·인원·점수)은 여기서 데이터로 만들어 넘기고, 모델은 문장만 쓴다(aiDraftDocument).
// - 강사 실명은 넘기지 않는다(초안의 이름 자리는 ○○○). 초안은 저장하지 않는다.
import { collection, getDocs, query, where } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { db, app } from "./firebase.js";
import { escapeHtml } from "./app.js";
import { coursesCache } from "./courses.js";

let sessions = []; // 선택 차수의 시간표

export function initDocDraft() {
  if (!document.querySelector('[data-tab="docdraft"]')) return;
  const kind = document.getElementById("dd-kind");
  const course = document.getElementById("dd-course");
  const syncKind = () => { document.getElementById("dd-inst-wrap").hidden = kind.value !== "dispatch"; };
  kind.addEventListener("change", syncKind);
  syncKind();
  course.addEventListener("change", loadSessions);
  document.getElementById("dd-run").addEventListener("click", run);
  document.addEventListener("tabshown", (e) => { if (e.detail === "docdraft") paintCourses(); });
}

function paintCourses() {
  const sel = document.getElementById("dd-course");
  const cur = sel.value;
  const list = coursesCache.filter((c) => !c.hidden)
    .sort((a, b) => (b.startDate || "").localeCompare(a.startDate || ""));
  sel.innerHTML = `<option value="">차수 선택</option>` + list.map((c) =>
    `<option value="${escapeHtml(c.id)}"${c.id === cur ? " selected" : ""}>${escapeHtml(c.startDate || "")} · ${escapeHtml(c.name || "")} ${c.round != null ? `${escapeHtml(String(c.round))}차` : ""}</option>`).join("");
}

async function loadSessions() {
  const id = document.getElementById("dd-course").value;
  const inst = document.getElementById("dd-inst");
  sessions = [];
  inst.innerHTML = `<option value="">(차수 선택 후)</option>`;
  if (!id) return;
  try {
    const snap = await getDocs(query(collection(db, "sessions"), where("courseId", "==", id)));
    sessions = snap.docs.map((d) => d.data())
      .sort((a, b) => `${a.date}${a.startTime}`.localeCompare(`${b.date}${b.startTime}`));
  } catch (e) { alert("시간표 불러오기 실패: " + e.message); return; }
  // 강사 선택은 화면에서만 이름을 보여 주고, AI에는 그 강사의 일정만 넘긴다.
  const names = [...new Set(sessions.map((s) => s.instructor).filter(Boolean))];
  inst.innerHTML = names.length
    ? names.map((n) => `<option>${escapeHtml(n)}</option>`).join("")
    : `<option value="">(시간표에 강사 없음)</option>`;
}

const slot = (s) => ({ date: s.date || "", start: s.startTime || "", end: s.endTime || "", subject: s.subject || "", room: s.room || "" });
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const r2 = (v) => (v == null ? null : Number(v.toFixed(2)));

async function satisfactionOf(courseId) {
  const snap = await getDocs(query(collection(db, "surveyResponses"), where("courseId", "==", courseId)));
  if (snap.empty) return null;
  const edu = [], inst = [];
  for (const d of snap.docs) {
    const r = d.data();
    Object.values(r.edu || {}).forEach((v) => Number.isFinite(v) && edu.push(v));
    (r.instructors || []).forEach((it) => [0, 1, 2].forEach((i) => Number.isFinite(it[`q${i}`]) && inst.push(it[`q${i}`])));
  }
  const all = edu.concat(inst);
  return { responses: snap.size, scale: "100점 환산",
    overall: r2(avg(all) && avg(all) * 20), education: r2(avg(edu) && avg(edu) * 20), instructor: r2(avg(inst) && avg(inst) * 20) };
}

async function buildFacts(kind, c) {
  const facts = {
    document: kind,
    sender: document.getElementById("dd-org").value.trim() || "○○○",
    course: { name: c.name || "", round: c.round ?? null, courseType: c.courseType || "", startDate: c.startDate || "", endDate: c.endDate || "",
      venue: c.venue || "", capacity: c.capacity ?? null },
  };
  if (kind === "dispatch") {
    const who = document.getElementById("dd-inst").value;
    if (!who) throw new Error("강사를 고르세요.");
    facts.instructor = "○○○";
    facts.schedule = sessions.filter((s) => s.instructor === who).map(slot);
  } else if (kind === "notice") {
    facts.subjects = [...new Set(sessions.map((s) => s.subject).filter(Boolean))];
    facts.totalSessions = sessions.length;
  } else {
    facts.result = { applied: c.appliedCount ?? null, completed: c.completedCount ?? null };
    facts.satisfaction = await satisfactionOf(c.id);
  }
  return facts;
}

async function run() {
  const kind = document.getElementById("dd-kind").value;
  const c = coursesCache.find((x) => x.id === document.getElementById("dd-course").value);
  const providerId = document.getElementById("dd-provider").value;
  if (!c) return alert("차수를 고르세요.");
  if (!providerId) return alert("설정 → AI 연결에서 모델을 먼저 등록하세요.");
  const btn = document.getElementById("dd-run");
  const out = document.getElementById("dd-out");
  btn.disabled = true;
  const t0 = Date.now();
  const status = document.createElement("p");
  status.className = "hint";
  out.prepend(status);
  const tick = setInterval(() => { status.textContent = `AI 작성 중… ${Math.round((Date.now() - t0) / 1000)}초`; }, 1000);
  try {
    const facts = await buildFacts(kind, c);
    const fn = httpsCallable(getFunctions(app, "asia-northeast3"), "aiDraftDocument", { timeout: 250000 });
    const r = (await fn({ kind, facts, providerId })).data;
    render(r, facts);
  } catch (e) { alert(e.message || e); } finally { clearInterval(tick); status.remove(); btn.disabled = false; }
}

function render(r, facts) {
  const card = document.createElement("div");
  card.className = "ai-card";
  const warn = r.unverified?.length
    ? `<p class="warn">⚠ 자료에서 확인되지 않은 숫자: <b>${r.unverified.map(escapeHtml).join(", ")}</b> — 모델이 지어냈을 수 있으니 고치거나 지우세요.</p>`
    : `<p class="hint">✅ 초안의 숫자를 모두 자료와 대조했습니다(확인 안 된 숫자 없음).</p>`;
  card.innerHTML = `
    <div class="ai-card-head">
      <b>${escapeHtml(r.label)}</b>
      <span class="muted">${escapeHtml(r.provider.name || r.provider.model)} · ${escapeHtml(r.provider.servedModel || r.provider.model)} · ${(r.elapsedMs / 1000).toFixed(1)}초</span>
      <button type="button" class="ai-close" title="닫기">×</button>
    </div>
    ${warn}
    <label class="ta-label">제목<input class="d-title" value="${escapeHtml(r.title || "")}"></label>
    <label class="ta-label">본문<textarea class="d-body" rows="16">${escapeHtml(r.body || "")}</textarea></label>
    <div class="form-actions"><button type="button" class="d-copy">제목·본문 복사</button></div>
    <details><summary>AI에 넘긴 자료 보기</summary><pre style="white-space:pre-wrap;font-size:0.78rem">${escapeHtml(JSON.stringify(facts, null, 2))}</pre></details>`;
  card.querySelector(".ai-close").addEventListener("click", () => card.remove());
  card.querySelector(".d-copy").addEventListener("click", async (e) => {
    const text = `${card.querySelector(".d-title").value}\n\n${card.querySelector(".d-body").value}`;
    try { await navigator.clipboard.writeText(text); e.target.textContent = "복사됨 ✓"; setTimeout(() => { e.target.textContent = "제목·본문 복사"; }, 1500); }
    catch { alert("복사 실패 — 본문을 직접 선택해 복사하세요."); }
  });
  document.getElementById("dd-out").prepend(card);
}
