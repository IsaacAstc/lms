// 관리자 설문 관리: 생성된 공개 설문 목록·노출창·응답수·강의실 URL·미리보기·재생성·삭제.
import {
  collection, getCountFromServer, query, where, doc, deleteDoc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./firebase.js";
import { watchCollection, onCollection, getCache } from "./store.js";
import { escapeHtml } from "./app.js";
import { fmtKst } from "./time.js";
import { coursesCache } from "./courses.js";
import { getRooms } from "./rooms.js";
import { regenerateSurvey } from "./survey-gen.js";

// 공개 페이지 기본 경로 (…/survey.html).
function surveyUrl(roomId) {
  const base = location.origin + location.pathname.replace(/[^/]*$/, "");
  return `${base}survey.html?room=${roomId}`;
}
function previewUrl(courseId) {
  const base = location.origin + location.pathname.replace(/[^/]*$/, "");
  return `${base}survey.html?preview=1&course=${courseId}`;
}

export function initSurveys() {
  watchCollection("publicSurveys");
  onCollection("publicSurveys", render);
  document.getElementById("survey-refresh").addEventListener("click", loadCounts);
  // 설문 관리 탭이 표시될 때마다 응답 수 자동 갱신.
  document.addEventListener("tabshown", (e) => { if (e.detail === "surveys") loadCounts(); });
}

function render() {
  const tbody = document.getElementById("survey-tbody");
  const list = [...getCache("publicSurveys")].sort((a, b) => (b.endMs || 0) - (a.endMs || 0));
  tbody.innerHTML = "";
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty">생성된 설문이 없습니다. 시간표 등록을 완료하면 자동 생성됩니다.</td></tr>`;
    return;
  }
  for (const s of list) {
    const url = surveyUrl(s.roomId);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(s.courseName)}</td>
      <td>${escapeHtml(s.roomName || "")}</td>
      <td>${fmtKst(s.openMs)}<br>~ ${fmtKst(s.closeMs)}</td>
      <td style="text-align:right">${(s.instructorTargets || []).length}</td>
      <td class="resp-count" data-course="${s.courseId}">–</td>
      <td class="url-cell"><input readonly value="${escapeHtml(url)}"><button type="button" class="copy url-copy">복사</button></td>
      <td class="actions">
        <a href="${escapeHtml(previewUrl(s.courseId))}" target="_blank" class="btn-link">미리보기</a>
        <button type="button" class="regen">재생성</button>
        <button type="button" class="del">삭제</button>
      </td>`;
    tr.querySelector(".url-copy").addEventListener("click", () => {
      navigator.clipboard?.writeText(url);
      tr.querySelector(".url-copy").textContent = "복사됨";
    });
    tr.querySelector(".regen").addEventListener("click", async () => {
      const course = coursesCache.find((c) => c.id === s.courseId);
      if (!course) return alert("해당 차수를 찾을 수 없습니다.");
      const roomId = getRooms().find((r) => r.name === course.venue)?.id || "";
      try {
        const res = await regenerateSurvey(course, roomId);
        alert(res ? "설문을 재생성했습니다." : "생성 조건(교육장·세션)을 확인하세요. 기존 설문은 제거되었습니다.");
      } catch (e) { alert("재생성 실패: " + e.message); }
    });
    tr.querySelector(".del").addEventListener("click", async () => {
      if (!confirm(`'${s.courseName}' 설문을 삭제하시겠습니까?`)) return;
      try { await deleteDoc(doc(db, "publicSurveys", s.courseId)); } catch (e) { alert("삭제 실패: " + e.message); }
    });
    tbody.appendChild(tr);
  }
  loadCounts();
}

// 각 설문의 응답 수를 조회해 표시(자동 + 수동 새로고침).
async function loadCounts() {
  const cells = document.querySelectorAll(".resp-count");
  for (const cell of cells) {
    const courseId = cell.dataset.course;
    try {
      const snap = await getCountFromServer(query(collection(db, "surveyResponses"), where("courseId", "==", courseId)));
      cell.textContent = String(snap.data().count);
    } catch (e) { cell.textContent = "?"; }
  }
}
