// 관리자 설문 관리: 생성된 공개 설문 목록·노출창·응답수·강의실 URL·미리보기·재생성·삭제.
import {
  collection, getCountFromServer, query, where, doc, deleteDoc, setDoc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./firebase.js";
import { watchCollection, onCollection, getCache } from "./store.js";
import { escapeHtml } from "./app.js";
import { fmtKst, fmtDot, kstToMs, HOUR_MS } from "./time.js";
import { coursesCache, roomIdOf } from "./courses.js";
import { getRooms } from "./rooms.js";
import { regenerateSurvey } from "./survey-gen.js";
import { orgQuery } from "./orgs.js";

// 공개 페이지 기본 경로 (…/survey.html).
function surveyUrl(roomId) {
  const base = location.origin + location.pathname.replace(/[^/]*$/, "");
  return `${base}survey.html?room=${roomId}${orgQuery()}`;
}
function previewUrl(courseId) {
  const base = location.origin + location.pathname.replace(/[^/]*$/, "");
  return `${base}survey.html?preview=1&course=${courseId}${orgQuery()}`;
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
  document.getElementById("sv-window-save").addEventListener("click", saveWindow);
  document.getElementById("sv-window-auto").addEventListener("click", restoreAutoWindow);
  document.getElementById("sv-window-close-btn").addEventListener("click", () =>
    document.getElementById("sv-window-dialog").close());
  document.getElementById("sv-qr-close").addEventListener("click", () =>
    document.getElementById("sv-qr-dialog").close());
}

// ── 설문 URL QR (라이브러리는 최초 사용 시 지연 로드 — 다른 모듈과 공유) ──
let qrLibLoading = null;
function loadQrLib() {
  if (typeof QRCode !== "undefined") return Promise.resolve();
  if (!qrLibLoading) {
    qrLibLoading = new Promise((resolve, reject) => {
      const el = document.createElement("script");
      el.src = "scfe/js/qrcode.min.js";
      el.onload = resolve;
      el.onerror = () => reject(new Error("QR 라이브러리를 불러오지 못했습니다."));
      document.head.appendChild(el);
    });
  }
  return qrLibLoading;
}
async function showSurveyQr(s, url) {
  try { await loadQrLib(); } catch (e) { return alert(e.message); }
  document.getElementById("sv-qr-title").textContent = s.courseName || "설문";
  document.getElementById("sv-qr-url").textContent = url;
  const box = document.getElementById("sv-qr-box");
  box.innerHTML = "";
  new QRCode(box, { text: url, width: 220, height: 220, correctLevel: QRCode.CorrectLevel.M });
  document.getElementById("sv-qr-dialog").showModal();
}

/* ── 노출기간 수동 수정 ──
 * 기본은 자동(종료 2시간 전 ~ 종료 후 1시간). 저장하면 manualWindow 표시가 붙고
 * 시간표 재생성 시에도 수동 값이 유지된다(survey-gen.js에서 보존). */
let windowTarget = null; // 편집 중인 설문 문서
const msToInput = (ms) => (fmtKst(ms) || "").replace(" ", "T");
function inputToMs(v) {
  const [date, time] = String(v || "").split("T");
  return kstToMs(date, time);
}
function openWindowDialog(s) {
  windowTarget = s;
  document.getElementById("sv-window-course").textContent =
    `${s.courseName}${s.manualWindow ? " · 현재 수동 설정" : " · 현재 기본값(자동)"}`;
  document.getElementById("sv-window-open").value = msToInput(s.openMs);
  document.getElementById("sv-window-close").value = msToInput(s.closeMs);
  document.getElementById("sv-window-dialog").showModal();
}
async function saveWindow() {
  if (!windowTarget) return;
  const openMs = inputToMs(document.getElementById("sv-window-open").value);
  const closeMs = inputToMs(document.getElementById("sv-window-close").value);
  if (!Number.isFinite(openMs) || !Number.isFinite(closeMs)) return alert("시작·종료 일시를 모두 입력하세요.");
  if (closeMs <= openMs) return alert("종료가 시작보다 빠르거나 같습니다.");
  try {
    await setDoc(doc(db, "publicSurveys", windowTarget.courseId),
      { openMs, closeMs, manualWindow: true, updatedAtMs: Date.now() }, { merge: true });
    document.getElementById("sv-window-dialog").close();
  } catch (e) { alert("저장 실패: " + e.message); }
}
async function restoreAutoWindow() {
  if (!windowTarget) return;
  if (!windowTarget.endMs) return alert("교육 종료 시각 정보가 없어 기본값을 계산할 수 없습니다.");
  try {
    await setDoc(doc(db, "publicSurveys", windowTarget.courseId), {
      openMs: windowTarget.endMs - 2 * HOUR_MS,
      closeMs: windowTarget.endMs + 1 * HOUR_MS,
      manualWindow: false, updatedAtMs: Date.now(),
    }, { merge: true });
    document.getElementById("sv-window-dialog").close();
  } catch (e) { alert("복원 실패: " + e.message); }
}

// 노출 창 표기: 같은 날이면 '2026.08.27 15:50 - 18:50', 다르면 두 줄로.
function windowText(s) {
  const a = fmtDot(fmtKst(s.openMs));
  const b = fmtDot(fmtKst(s.closeMs));
  const [ad, at] = a.split(" ");
  const [bd, bt] = b.split(" ");
  return ad === bd ? `${ad} ${at} - ${bt}` : `${a}<br>- ${b}`;
}

// 설문의 노출 창(openMs~closeMs)이 지정 범위와 겹치면 표시. 범위 미지정이면 전체.
// (수동 노출기간을 조정한 설문도 그 기간 기준으로 조회된다)
function inRange(s, from, to) {
  if (!from && !to) return true;
  const day = (ms) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date(ms));
  const openDay = s.openMs ? day(s.openMs) : (s.endMs ? day(s.endMs) : "");
  const closeDay = s.closeMs ? day(s.closeMs) : openDay;
  if (!openDay) return true; // 기준 시각이 없으면 숨기지 않음.
  if (from && closeDay < from) return false;
  if (to && openDay > to) return false;
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
      <td>${windowText(s)}${s.manualWindow ? ` <small title="수동 지정된 노출기간 — 재생성해도 유지">(수동)</small>` : ""}
        <button type="button" class="pad-mini win-edit" title="노출기간 수정">✎</button></td>
      <td style="text-align:right">${(s.instructorTargets || []).length}</td>
      <td class="resp-count" data-course="${s.courseId}">–</td>
      <td class="url-cell"><button type="button" class="copy url-copy" title="${escapeHtml(url)}">복사</button><button type="button" class="url-qr">QR</button><a class="btn-link url-open" href="${escapeHtml(url)}" target="_blank" title="${escapeHtml(url)}">열기</a></td>
      <td class="actions">
        <a href="${escapeHtml(previewUrl(s.courseId))}" target="_blank" class="btn-link">미리보기</a>
        <button type="button" class="regen">재생성</button>
        <button type="button" class="del">삭제</button>
      </td>`;
    tr.querySelector(".win-edit").addEventListener("click", () => openWindowDialog(s));
    tr.querySelector(".url-qr").addEventListener("click", () => showSurveyQr(s, url));
    tr.querySelector(".url-copy").addEventListener("click", () => {
      navigator.clipboard?.writeText(url);
      tr.querySelector(".url-copy").textContent = "복사됨";
    });
    tr.querySelector(".regen").addEventListener("click", async () => {
      const course = coursesCache.find((c) => c.id === s.courseId);
      if (!course) return alert("해당 차수를 찾을 수 없습니다.");
      const roomId = roomIdOf(course);
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
