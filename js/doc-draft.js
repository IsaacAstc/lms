// 공문·안내문 초안(AI): 출강 요청 · 교육 안내 · 결과 보고 본문 — 월 단위.
// - 출강 요청은 그 달 일정을 강사 소속기관별로 묶어 기관당 한 문서로 만든다.
// - 사실(일정·인원·점수)은 여기서 데이터로 만들어 넘기고, 모델은 문장만 쓴다(aiDraftDocument).
// - 강사 실명은 넘기지 않는다(○○○ 강사A 식 표기). 초안은 저장하지 않는다.
import { collection, getDocs, query, where } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { db, app } from "./firebase.js";
import { escapeHtml } from "./app.js";
import { coursesCache } from "./courses.js";

const NO_AFF = "(소속 미지정)";
let monthData = null; // { month, sessions, affOf: {instructorKey: 소속} }

const thisMonth = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date()).slice(0, 7);
const instKey = (s) => s.instructorId || `name:${s.instructor || ""}`;

export function initDocDraft() {
  if (!document.querySelector('[data-tab="docdraft"]')) return;
  const kind = document.getElementById("dd-kind");
  const month = document.getElementById("dd-month");
  month.value = thisMonth();
  const syncKind = () => { document.getElementById("dd-aff-wrap").hidden = kind.value !== "dispatch"; };
  kind.addEventListener("change", syncKind);
  syncKind();
  month.addEventListener("change", loadMonth);
  document.getElementById("dd-run").addEventListener("click", run);
  document.addEventListener("tabshown", (e) => { if (e.detail === "docdraft" && !monthData) loadMonth(); });
}

const coursesOfMonth = (m) => coursesCache.filter((c) => !c.hidden && (c.startDate || "").slice(0, 7) === m)
  .sort((a, b) => (a.startDate || "").localeCompare(b.startDate || "") || (a.name || "").localeCompare(b.name || ""));

async function loadMonth() {
  const m = document.getElementById("dd-month").value;
  const aff = document.getElementById("dd-aff");
  const info = document.getElementById("dd-info");
  monthData = null;
  aff.innerHTML = `<option value="">불러오는 중…</option>`;
  if (!m) return;
  try {
    const [ss, is] = await Promise.all([
      getDocs(query(collection(db, "sessions"), where("date", ">=", `${m}-01`), where("date", "<=", `${m}-31`))),
      getDocs(collection(db, "instructors")),
    ]);
    const affById = Object.fromEntries(is.docs.map((d) => [d.id, String(d.data().affiliation || "").trim()]));
    const affByName = Object.fromEntries(is.docs.map((d) => [String(d.data().name || "").trim(), String(d.data().affiliation || "").trim()]));
    const hidden = new Set(coursesCache.filter((c) => c.hidden).map((c) => c.id));
    const sessions = ss.docs.map((d) => d.data()).filter((s) => !hidden.has(s.courseId) && (s.instructorId || s.instructor))
      .sort((a, b) => `${a.date}${a.startTime}`.localeCompare(`${b.date}${b.startTime}`));
    const affOf = {};
    for (const s of sessions) affOf[instKey(s)] = (s.instructorId ? affById[s.instructorId] : affByName[s.instructor]) || NO_AFF;
    monthData = { month: m, sessions, affOf };
  } catch (e) { aff.innerHTML = `<option value="">불러오기 실패</option>`; alert("일정 불러오기 실패: " + e.message); return; }
  // 소속별 강사 수·출강 건수.
  const groups = {};
  for (const s of monthData.sessions) {
    const g = groups[monthData.affOf[instKey(s)]] = groups[monthData.affOf[instKey(s)]] || { inst: new Set(), n: 0 };
    g.inst.add(instKey(s)); g.n++;
  }
  const names = Object.keys(groups).sort((a, b) => (a === NO_AFF) - (b === NO_AFF) || a.localeCompare(b));
  aff.innerHTML = names.length
    ? names.map((a) => `<option value="${escapeHtml(a)}">${escapeHtml(a)} (강사 ${groups[a].inst.size}명 · ${groups[a].n}건)</option>`).join("")
    : `<option value="">(이 달 출강 일정 없음)</option>`;
  info.textContent = `${m}: 시작 차수 ${coursesOfMonth(m).length}개 · 강의 일정 ${monthData.sessions.length}건`;
}

const courseLabel = (id) => {
  const c = coursesCache.find((x) => x.id === id);
  return c ? `${c.name || ""}${c.round != null ? ` ${c.round}차` : ""}` : "-";
};
const courseFacts = (c) => ({ name: c.name || "", round: c.round ?? null, courseType: c.courseType || "",
  startDate: c.startDate || "", endDate: c.endDate || "", venue: c.venue || "", capacity: c.capacity ?? null });
const avg = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const r2 = (v) => (v == null ? null : Number(v.toFixed(2)));
const x20 = (v) => (v == null ? null : r2(v * 20));

async function satisfactionOf(courseId) {
  const snap = await getDocs(query(collection(db, "surveyResponses"), where("courseId", "==", courseId)));
  if (snap.empty) return null;
  const edu = [], inst = [];
  for (const d of snap.docs) {
    const r = d.data();
    Object.values(r.edu || {}).forEach((v) => Number.isFinite(v) && edu.push(v));
    (r.instructors || []).forEach((it) => [0, 1, 2].forEach((i) => Number.isFinite(it[`q${i}`]) && inst.push(it[`q${i}`])));
  }
  return { responses: snap.size, overall: x20(avg(edu.concat(inst))), education: x20(avg(edu)), instructor: x20(avg(inst)) };
}

async function buildFacts(kind) {
  const m = monthData.month;
  const facts = { document: kind, month: m, sender: document.getElementById("dd-org").value.trim() || "○○○" };
  if (kind === "dispatch") {
    const aff = document.getElementById("dd-aff").value;
    if (!aff) throw new Error("소속기관을 고르세요.");
    const mine = monthData.sessions.filter((s) => monthData.affOf[instKey(s)] === aff);
    const keys = [...new Set(mine.map(instKey))];
    facts.recipient = aff === NO_AFF ? "○○○" : aff;
    facts.instructors = keys.map((k, i) => ({
      instructor: `○○○ 강사${keys.length > 1 ? String.fromCharCode(65 + (i % 26)) : ""}`,
      schedule: mine.filter((s) => instKey(s) === k).map((s) => ({
        date: s.date || "", start: s.startTime || "", end: s.endTime || "", course: courseLabel(s.courseId), subject: s.subject || "", room: s.room || "" })),
    }));
    return facts;
  }
  const courses = coursesOfMonth(m);
  if (!courses.length) throw new Error(`${m}에 시작하는 차수가 없습니다.`);
  if (kind === "notice") {
    facts.courses = courses.map((c) => ({ ...courseFacts(c),
      subjects: [...new Set(monthData.sessions.filter((s) => s.courseId === c.id).map((s) => s.subject).filter(Boolean))] }));
  } else {
    const sats = await Promise.all(courses.map((c) => satisfactionOf(c.id)));
    facts.courses = courses.map((c, i) => ({ ...courseFacts(c), applied: c.appliedCount ?? null, completed: c.completedCount ?? null,
      satisfaction: sats[i] ? { ...sats[i], scale: "100점 환산" } : null }));
    facts.totals = { rounds: courses.length,
      capacity: courses.reduce((n, c) => n + (c.capacity || 0), 0),
      applied: courses.reduce((n, c) => n + (c.appliedCount || 0), 0),
      completed: courses.reduce((n, c) => n + (c.completedCount || 0), 0) };
  }
  return facts;
}

async function run() {
  const kind = document.getElementById("dd-kind").value;
  const providerId = document.getElementById("dd-provider").value;
  if (!monthData || monthData.month !== document.getElementById("dd-month").value) await loadMonth();
  if (!monthData) return;
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
    const facts = await buildFacts(kind);
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
  const target = facts.recipient ? ` · ${escapeHtml(facts.recipient)}` : "";
  card.innerHTML = `
    <div class="ai-card-head">
      <b>${escapeHtml(r.label)} · ${escapeHtml(facts.month)}${target}</b>
      <span class="muted">${escapeHtml(r.provider.name || r.provider.model)} · ${escapeHtml(r.provider.servedModel || r.provider.model)} · ${(r.elapsedMs / 1000).toFixed(1)}초</span>
      <button type="button" class="ai-close" title="닫기">×</button>
    </div>
    ${warn}
    <label class="ta-label">제목<input class="d-title" style="width:100%" value="${escapeHtml(r.title || "")}"></label>
    <label class="ta-label">본문<textarea class="d-body" rows="18">${escapeHtml(r.body || "")}</textarea></label>
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
