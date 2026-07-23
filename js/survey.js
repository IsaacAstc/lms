// 공개 설문 응답 페이지 (로그인 없음, 완전 익명).
// 강의실 고유 URL: survey.html?room=<강의실ID>. KST 기준 노출 창일 때만 표시.
import {
  collection, query, where, getDocs, getDoc, doc, addDoc, Timestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./firebase.js";
import { fmtKst, kstToday } from "./time.js";

const SCALE_LABELS = ["1 매우 아니다", "2 아니다", "3 보통", "4 그렇다", "5 매우 그렇다"];
const root = document.getElementById("survey-root");

function esc(v) {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function msg(html) { root.innerHTML = html; }

async function main() {
  const params = new URLSearchParams(location.search);

  // 관리자 미리보기: ?preview=1&course=<id> — 노출 창 무시, 제출 비활성.
  if (params.get("preview") === "1" && params.get("course")) {
    try {
      const s = await getDoc(doc(db, "publicSurveys", params.get("course")));
      if (!s.exists()) return msg(`<p class="empty">설문 정의가 없습니다.</p>`);
      render(s.data(), true);
    } catch (e) {
      msg(`<p class="empty">미리보기를 불러오지 못했습니다.</p>`);
    }
    return;
  }

  const roomId = params.get("room");
  if (!roomId) return msg(`<p class="empty">잘못된 접근입니다. (강의실 정보 없음)</p>`);

  let survey = null;
  try {
    const snap = await getDocs(query(collection(db, "publicSurveys"), where("roomId", "==", roomId)));
    const now = Date.now();
    const active = snap.docs.map((d) => d.data()).filter((s) => s.openMs <= now && now <= s.closeMs);
    active.sort((a, b) => a.endMs - b.endMs);
    survey = active[0] || null;
  } catch (e) {
    return msg(`<p class="empty">설문을 불러오지 못했습니다. 잠시 후 다시 시도하세요.</p>`);
  }

  if (!survey) return msg(`<p class="empty">현재 진행 중인 설문이 없습니다.<br>교육 종료 2시간 전부터 응답하실 수 있습니다.</p>`);

  if (localStorage.getItem(`survey_done_${survey.courseId}`)) {
    return msg(`<p class="empty">이미 응답을 제출하셨습니다. 감사합니다.</p>`);
  }
  render(survey);
}

function ratingRow(name, label) {
  const opts = SCALE_LABELS.map(
    (t, i) => `<label class="scale"><input type="radio" name="${name}" value="${i + 1}" required><span>${esc(t)}</span></label>`
  ).join("");
  return `<div class="q-item"><div class="q-label">${esc(label)}</div><div class="scale-row">${opts}</div></div>`;
}

function render(survey, preview = false) {
  const edu = survey.eduItems.map((t, i) => ratingRow(`edu_${i}`, `${i + 1}. ${t}`)).join("");
  const instBlocks = (survey.instructorTargets || [])
    .map((t, ti) => {
      const rows = survey.instructorItems.map((it, i) => ratingRow(`inst_${ti}_${i}`, it)).join("");
      return `<fieldset class="inst-block"><legend>${esc(t.subject)} — ${esc(t.instructorName)}</legend>${rows}</fieldset>`;
    })
    .join("");

  root.innerHTML = `
    ${preview ? `<p class="preview-banner">미리보기 — 실제 제출되지 않습니다.</p>` : ""}
    <h1>${esc(survey.courseName)} 만족도 설문</h1>
    <p class="notice">개인을 식별할 수 있는 정보(성명, 소속, 연락처 등)는 기재하지 마십시오. 응답은 완전 익명으로 처리됩니다.</p>
    <form id="s-form">
      <h2>교육 만족도</h2>
      ${edu}
      ${instBlocks ? `<h2>강사 만족도</h2>${instBlocks}` : ""}
      <h2>주관식</h2>
      <div class="q-item"><div class="q-label">교육 불만족 의견</div>
        <textarea name="free_dissatisfied" rows="3"></textarea></div>
      <div class="q-item"><div class="q-label">교육 관련 제안·개선요구 의견</div>
        <textarea name="free_suggestion" rows="3"></textarea></div>
      <button type="submit" id="s-submit">제출</button>
      <p id="s-error" class="error"></p>
    </form>`;

  if (preview) {
    const btn = document.getElementById("s-submit");
    btn.disabled = true;
    btn.textContent = "미리보기(제출 불가)";
  } else {
    document.getElementById("s-form").addEventListener("submit", (e) => submit(e, survey));
  }
}

async function submit(e, survey) {
  e.preventDefault();
  const form = e.target;
  const err = document.getElementById("s-error");
  err.textContent = "";

  const edu = {};
  for (let i = 0; i < survey.eduItems.length; i++) {
    const v = form[`edu_${i}`]?.value;
    if (!v) { err.textContent = "모든 교육 만족도 문항에 응답해 주세요."; return; }
    edu[`q${i}`] = Number(v);
  }
  const instructors = [];
  (survey.instructorTargets || []).forEach((t, ti) => {
    const rec = { instructorId: t.instructorId, subject: t.subject, instructorName: t.instructorName };
    for (let i = 0; i < survey.instructorItems.length; i++) {
      const v = form[`inst_${ti}_${i}`]?.value;
      if (v) rec[`q${i}`] = Number(v);
    }
    instructors.push(rec);
  });

  const submitBtn = document.getElementById("s-submit");
  submitBtn.disabled = true;
  try {
    const expireAt = Timestamp.fromDate(new Date(Date.now() + 180 * 24 * 3600 * 1000));
    await addDoc(collection(db, "surveyResponses"), {
      courseId: survey.courseId,
      courseType: survey.courseType || "",
      roomId: survey.roomId,
      collectedDate: kstToday(),
      edu,
      instructors,
      freeDissatisfied: form.free_dissatisfied.value.trim(),
      freeSuggestion: form.free_suggestion.value.trim(),
      expireAt,
    });
    localStorage.setItem(`survey_done_${survey.courseId}`, "1");
    msg(`<p class="empty">응답이 제출되었습니다. 참여해 주셔서 감사합니다.</p>`);
  } catch (e2) {
    err.textContent = "제출에 실패했습니다. 다시 시도해 주세요.";
    submitBtn.disabled = false;
  }
}

main();
