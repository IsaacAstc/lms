// 관리자 설문 관리: 생성된 공개 설문 목록·노출창·응답수·강의실 URL·미리보기·재생성·삭제.
import {
  collection, getCountFromServer, query, where, doc, deleteDoc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./firebase.js";
import { watchCollection, onCollection, getCache } from "./store.js";
import { escapeHtml } from "./app.js";
import { fmtKst, fmtDot } from "./time.js";
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

// 기본 표시 범위: 오늘 기준 앞뒤 N일(교육 종료일 기준).
const DEFAULT_SPAN_DAYS = 30;
function todayStr() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
}
function dayOffsetStr(n) {
  const base = new Date(`${todayStr()}T00:00:00+09:00`);
  base.setDate(base.getDate() + n);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(base);
}
function applyDefaultRange() {
  document.getElementById("sv-from").value = dayOffsetStr(-DEFAULT_SPAN_DAYS);
  document.getElementById("sv-to").value = dayOffsetStr(DEFAULT_SPAN_DAYS);
}

export function initSurveys() {
  // 구독 등록 즉시 render가 1회 호출되므로 기본 범위를 먼저 설정한다.
  applyDefaultRange();
  watchCollection("publicSurveys");
  onCollection("publicSurveys", render);
  document.getElementById("survey-refresh").addEventListener("click", loadCounts);
  ["sv-from", "sv-to"].forEach((id) =>
    document.getElementById(id).addEventListener("change", render));
  document.getElementById("sv-reset").addEventListener("click", () => { applyDefaultRange(); render(); });
  document.getElementById("sv-all").addEventListener("click", () => {
    document.getElementById("sv-from").value = "";
    document.getElementById("sv-to").value = "";
    render();
  });
  // 설문 관리 탭이 표시될 때마다 응답 수 자동 갱신.
  document.addEventListener("tabshown", (e) => { if (e.detail === "surveys") loadCounts(); });
}

// 노출 창 표기: 같은 날이면 '2026.08.27 15:50 - 18:50', 다르면 두 줄로.
function windowText(s) {
  const a = fmtDot(fmtKst(s.openMs));
  const b = fmtDot(fmtKst(s.closeMs));
  const [ad, at] = a.split(" ");
  const [bd, bt] = b.split(" ");
  return ad === bd ? `${ad} ${at} - ${bt}` : `${a}<br>- ${b}`;
}

// 설문의 교육 종료일(endMs)이 지정 범위 안이면 표시. 범위 미지정이면 전체.
function inRange(s, from, to) {
  if (!from && !to) return true;
  if (!s.endMs) return true; // 기준 시각이 없으면 숨기지 않음.
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date(s.endMs));
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}

function render() {
  const tbody = document.getElementById("survey-tbody");
  const all = getCache("publicSurveys");
  const from = document.getElementById("sv-from").value;
  const to = document.getElementById("sv-to").value;
  if (from && to && to < from) {
    document.getElementById("sv-count").textContent = "";
    tbody.innerHTML = `<tr><td colspan="7" class="empty">종료일자가 시작일자보다 빠릅니다. 기간을 다시 선택하세요.</td></tr>`;
    return;
  }
  const list = all.filter((s) => inRange(s, from, to)).sort((a, b) => (b.endMs || 0) - (a.endMs || 0));
  document.getElementById("sv-count").textContent = `${list.length} / 전체 ${all.length}건`;
  tbody.innerHTML = "";
  if (!all.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty">생성된 설문이 없습니다. 시간표 등록을 완료하면 자동 생성됩니다.</td></tr>`;
    return;
  }
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty">선택한 기간에 설문이 없습니다. 기간을 바꾸거나 ‘전체 보기’를 누르세요.</td></tr>`;
    return;
  }
  for (const s of list) {
    const url = surveyUrl(s.roomId);
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(s.courseName)}</td>
      <td>${escapeHtml(s.roomName || "")}</td>
      <td>${windowText(s)}</td>
      <td style="text-align:right">${(s.instructorTargets || []).length}</td>
      <td class="resp-count" data-course="${s.courseId}">–</td>
      <td class="url-cell"><button type="button" class="copy url-copy" title="${escapeHtml(url)}">복사</button><a class="btn-link url-open" href="${escapeHtml(url)}" target="_blank" title="${escapeHtml(url)}">열기</a></td>
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
