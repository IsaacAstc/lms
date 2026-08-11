import { firebaseConfig, setupAppCheck } from "./firebase-config.js";
import { startMission1, startMission2, startMission3, setMissionConfig } from "./missions.js";
import { MISSION_SETTINGS_PATH, mergeMissionConfig } from "./mission-config.js";
import {
  EVENT_PARAM,
  LEGACY_EVENT_ID,
  getEventOpenState,
  formatEventPeriod,
  normalizeMissionOrder,
} from "./events.js";

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getFirestore,
  doc,
  getDoc,
  getDocs,
  setDoc,
  updateDoc,
  collection,
  query,
  where,
  orderBy,
  limit,
  onSnapshot,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
setupAppCheck(app);
const db = getFirestore(app);

// ---------------------------------------------------------------------
// 화면 전환 유틸
// ---------------------------------------------------------------------
function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  setTimeout(() => t.classList.remove("show"), 2000);
}

// ---------------------------------------------------------------------
// 세션(참가자) 상태
// ---------------------------------------------------------------------
const SESSION_KEY = "avsec_session_id";
const state = {
  ref: null,
  sessionId: null,
  data: null,
  eventId: LEGACY_EVENT_ID,
  event: null,
  eventChoices: null, // 동시 진행 행사가 여러 개일 때의 선택 후보
};
let leaderboardStarted = false;

function genCode() {
  return "AV-" + Math.random().toString(36).slice(2, 8).toUpperCase();
}

// ---------------------------------------------------------------------
// 기기별 참여 횟수 제한 (행사당 최대 2회)
//   localStorage 기반이라 시크릿 모드·캐시 삭제로 우회가 가능하다.
//   로그인이 없는 구조에서의 한계이며, 완전 차단이 아닌 중복 참여 억제용.
//
//   부스에 비치한 공용 기기(여러 명이 순서대로 사용)는 이 제한에 걸리면 안 되므로
//   ?kiosk=1 로 한 번 접속해 두면 해당 기기는 제한이 면제된다. (?kiosk=0 으로 해제)
// ---------------------------------------------------------------------
const MAX_PLAYS_PER_EVENT = 2;
const KIOSK_KEY = "avsec_kiosk";

function playCountKey(eventId) {
  return `avsec_plays_${eventId}`;
}

function getPlayCount(eventId) {
  return parseInt(localStorage.getItem(playCountKey(eventId)) || "0", 10) || 0;
}

function incPlayCount(eventId) {
  localStorage.setItem(playCountKey(eventId), String(getPlayCount(eventId) + 1));
}

function isKioskDevice() {
  return localStorage.getItem(KIOSK_KEY) === "1";
}

// 공용 기기 지정/해제 (?kiosk=1 / ?kiosk=0)
function applyKioskParam() {
  const v = new URLSearchParams(location.search).get("kiosk");
  if (v === "1") localStorage.setItem(KIOSK_KEY, "1");
  else if (v === "0") localStorage.removeItem(KIOSK_KEY);
}

// 이 기기가 현재 행사에 더 참여할 수 있는지
function canPlayMore() {
  if (isKioskDevice()) return true;
  return getPlayCount(state.eventId) < MAX_PLAYS_PER_EVENT;
}

// 같은 닉네임을 쓰는 다른 참가자(문서)가 있는지 확인 (내 기존 세션은 제외).
// 닉네임 중복은 같은 행사 안에서만 따진다 — 행사가 다르면 같은 닉네임을 허용.
async function checkNicknameTaken(nickname, excludeId) {
  const q = query(
    collection(db, "participants"),
    where("eventId", "==", state.eventId),
    where("nickname", "==", nickname),
    limit(2)
  );
  const snap = await getDocs(q);
  return snap.docs.some((d) => d.id !== excludeId);
}

async function getOrCreateSession(nickname) {
  let sessionId = localStorage.getItem(SESSION_KEY);

  if (sessionId) {
    const ref = doc(db, "participants", sessionId);
    const snap = await getDoc(ref);
    // 같은 행사의 기존 세션만 이어받는다(다른 행사 QR로 들어왔다면 새 참가자로 시작)
    if (snap.exists() && (snap.data().eventId || LEGACY_EVENT_ID) === state.eventId) {
      return { ref, sessionId, data: snap.data() };
    }
  }

  // 여기부터는 새 참가자 생성 — 기기별 참여 횟수 제한 확인
  if (!canPlayMore()) {
    const err = new Error("play limit reached");
    err.code = "play-limit";
    throw err;
  }

  sessionId =
    window.crypto && window.crypto.randomUUID
      ? window.crypto.randomUUID()
      : "p_" + Date.now() + "_" + Math.random().toString(36).slice(2);

  const ref = doc(db, "participants", sessionId);
  const data = {
    nickname,
    eventId: state.eventId,
    createdAt: serverTimestamp(),
    mission1: null,
    mission2: null,
    mission3: null,
    totalScore: 0,
    totalTimeMs: 0,
    completedAt: null,
    certCode: null,
    rewardGiven: false,
  };
  await setDoc(ref, data);
  localStorage.setItem(SESSION_KEY, sessionId);
  incPlayCount(state.eventId); // 새 참가자 생성 = 1회 참여로 집계
  return { ref, sessionId, data };
}

// ---------------------------------------------------------------------
// 미션 메뉴 렌더링
// ---------------------------------------------------------------------
// 이 행사에서 사용할 미션 번호와 순서 (행사 설정에 따라 일부만 쓸 수 있음)
function missionNumbers() {
  return normalizeMissionOrder(state.event && state.event.missionOrder);
}

// 사용 중인 미션들의 Firestore 필드명 (예: [1,3] → ["mission1","mission3"])
function activeMissionKeys() {
  return missionNumbers().map((n) => "mission" + n);
}

function renderMenu() {
  const order = missionNumbers();
  [1, 2, 3].forEach((n) => {
    const card = document.getElementById("card-" + n);
    const scoreEl = document.getElementById("score-" + n);
    const light = document.querySelector(`.runway-progress .light[data-m="${n}"]`);
    const idx = order.indexOf(n);

    // 이 행사에서 쓰지 않는 미션은 카드와 진행표시등을 모두 숨긴다
    const used = idx !== -1;
    card.style.display = used ? "" : "none";
    if (light) light.style.display = used ? "" : "none";
    if (!used) return;

    // 행사에서 지정한 순서대로 배치 (flex order)
    card.style.order = idx;
    if (light) light.style.order = idx;

    const m = state.data["mission" + n];
    if (m && m.completed) {
      card.classList.add("done");
      scoreEl.textContent = m.score;
      if (light) light.classList.add("on");
    } else {
      card.classList.remove("done");
      scoreEl.textContent = "-";
      if (light) light.classList.remove("on");
    }
  });
  refreshCertButtons();
}

// 이 행사에서 쓰는 미션을 모두 끝냈는지 (미션을 줄인 행사는 줄인 만큼만 요구)
function allMissionsDone() {
  return activeMissionKeys().every((k) => state.data[k] && state.data[k].completed);
}

// ---------------------------------------------------------------------
// 미션 완료 처리 → Firestore 저장 → 결과/인증서 화면
// ---------------------------------------------------------------------
async function handleMissionComplete(missionKey, result) {
  state.data[missionKey] = { completed: true, score: result.score, timeMs: result.timeMs };

  const keys = activeMissionKeys();
  const totalScore = keys.reduce((sum, k) => sum + (state.data[k] ? state.data[k].score : 0), 0);
  const totalTimeMs = keys.reduce((sum, k) => sum + (state.data[k] ? state.data[k].timeMs : 0), 0);
  state.data.totalScore = totalScore;
  state.data.totalTimeMs = totalTimeMs;

  const payload = { [missionKey]: state.data[missionKey], totalScore, totalTimeMs };

  if (allMissionsDone()) {
    state.data.certCode = genCode();
    payload.completedAt = serverTimestamp();
    payload.certCode = state.data.certCode;
  }

  try {
    await updateDoc(state.ref, payload);
  } catch (e) {
    console.error("Firestore 업데이트 실패", e);
    toast("저장 중 오류가 발생했습니다. 네트워크를 확인하세요.");
  }

  if (allMissionsDone()) {
    showComplete();
  } else {
    document.getElementById("resultTitle").textContent = "미션 클리어!";
    document.getElementById("resultScore").textContent = result.score;
    document.getElementById("resultTime").textContent = (result.timeMs / 1000).toFixed(1) + "s";
    showScreen("screen-result");
  }
}

function showComplete() {
  document.getElementById("certNickname").textContent = state.data.nickname;
  document.getElementById("certCode").textContent = "CODE: " + state.data.certCode;
  document.getElementById("totalScoreDisplay").textContent = state.data.totalScore;
  document.getElementById("totalTimeDisplay").textContent =
    (state.data.totalTimeMs / 1000).toFixed(1) + "s";
  showScreen("screen-complete");
  prepareCertImage(); // 인증서 이미지를 미리 생성(버튼은 준비 완료 시 활성화)
}

// ---------------------------------------------------------------------
// 실시간 리더보드
// ---------------------------------------------------------------------
function startLeaderboardListener() {
  if (leaderboardStarted) return;
  leaderboardStarted = true;
  // 현재 행사 참가자만 순위에 표시
  // ⚠ Firestore 복합 색인 필요: eventId(==) + totalScore(desc) + totalTimeMs(asc)
  //    최초 실행 시 브라우저 콘솔에 표시되는 링크로 색인을 생성하세요.
  const q = query(
    collection(db, "participants"),
    where("eventId", "==", state.eventId),
    orderBy("totalScore", "desc"),
    orderBy("totalTimeMs", "asc"),
    limit(20)
  );
  onSnapshot(
    q,
    (snap) => renderLeaderboard(snap.docs.map((d) => d.data())),
    (err) => {
      console.error("리더보드 구독 실패", err);
      document.getElementById("leaderboardList").innerHTML =
        '<p style="color:var(--text-muted);font-size:13px;text-align:center">순위를 불러올 수 없습니다. (Firestore 색인 생성이 필요할 수 있습니다 — 브라우저 콘솔의 링크를 확인하세요)</p>';
    }
  );
}

function renderLeaderboard(rows) {
  const list = document.getElementById("leaderboardList");
  if (rows.length === 0) {
    list.innerHTML = '<p style="color:var(--text-muted);font-size:13px;text-align:center">아직 참가자가 없습니다.</p>';
    return;
  }
  list.innerHTML = rows
    .map((r, i) => {
      const rank = i + 1;
      const cls = rank === 1 ? "top1" : rank === 2 ? "top2" : rank === 3 ? "top3" : "";
      return `<div class="leaderboard-row ${cls}">
        <div class="rank">${rank}</div>
        <div class="nick">${escapeHtml(r.nickname || "-")}</div>
        <div class="pts">${r.totalScore || 0}pt</div>
      </div>`;
    })
    .join("");
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---------------------------------------------------------------------
// 카운트다운 유틸 (미션 1·2 공용, 3초)
// ---------------------------------------------------------------------
function runCountdown(onDone) {
  showScreen("screen-countdown");
  const numEl = document.getElementById("countdownNum");
  let count = 3;
  numEl.textContent = count;
  const iv = setInterval(() => {
    count--;
    if (count > 0) {
      numEl.textContent = count;
    } else {
      clearInterval(iv);
      onDone();
    }
  }, 1000);
}

// ---------------------------------------------------------------------
// 이벤트 바인딩
// ---------------------------------------------------------------------
// 미션 카드 → 사전 안내화면으로 이동
[1, 2, 3].forEach((n) => {
  document.getElementById("card-" + n).addEventListener("click", () => {
    const key = "mission" + n;
    if (!state.data) return;
    if (state.data[key] && state.data[key].completed) {
      toast("이미 완료한 미션입니다");
      return;
    }
    showScreen("screen-pre" + n);
  });
});

// 시작하기 버튼 → 카운트다운 → 게임
function launchMission(n) {
  const key = "mission" + n;
  const onComplete = (result) => handleMissionComplete(key, result);
  if (n === 1 || n === 2) {
    runCountdown(() => {
      showScreen("screen-m" + n);
      if (n === 1) startMission1(onComplete);
      if (n === 2) startMission2(onComplete);
    });
  } else {
    showScreen("screen-m" + n);
    startMission3(onComplete);
  }
}

document.getElementById("btnStartM1").addEventListener("click", () => launchMission(1));
document.getElementById("btnStartM2").addEventListener("click", () => launchMission(2));
document.getElementById("btnStartM3").addEventListener("click", () => launchMission(3));

document.getElementById("btnStart").addEventListener("click", async () => {
  const input = document.getElementById("nicknameInput");
  const nickname = input.value.trim();
  if (!nickname) {
    toast("닉네임을 입력하세요");
    return;
  }
  const btn = document.getElementById("btnStart");
  btn.disabled = true;
  btn.textContent = "연결 중...";
  try {
    const existingSessionId = localStorage.getItem(SESSION_KEY);
    const taken = await checkNicknameTaken(nickname, existingSessionId);
    if (taken) {
      toast("이미 사용 중인 닉네임이에요. 다른 닉네임을 입력해주세요.");
      input.focus();
      input.select();
      return;
    }
    const session = await getOrCreateSession(nickname);
    state.ref = session.ref;
    state.sessionId = session.sessionId;
    state.data = session.data;
    renderMenu();
    startLeaderboardListener();
    showScreen("screen-menu");
  } catch (e) {
    if (e && e.code === "play-limit") {
      toast(`이 기기에서는 ${MAX_PLAYS_PER_EVENT}회까지만 참여할 수 있어요.`);
    } else {
      console.error(e);
      toast("연결에 실패했습니다. firebase-config.js 설정을 확인하세요.");
    }
  } finally {
    btn.textContent = "미션 시작하기";
    refreshStartAvailability(); // 제한에 걸렸다면 버튼은 비활성 유지
  }
});


document.getElementById("btnBackToMenu").addEventListener("click", () => {
  renderMenu();
  showScreen("screen-menu");
});

function goLeaderboard() {
  startLeaderboardListener();
  refreshCertButtons(); // 완료 상태면 순위표에도 저장/공유 버튼 노출
  showScreen("screen-leaderboard");
}
document.getElementById("btnGoLeaderboard").addEventListener("click", goLeaderboard);
document.getElementById("btnGoLeaderboardFromStart").addEventListener("click", goLeaderboard);
document.getElementById("btnGoLeaderboardFromComplete").addEventListener("click", goLeaderboard);

// ---------------------------------------------------------------------
// 인증서 이미지 저장 / 공유 (html2canvas + Web Share)
//   iOS는 웹에서 사진 앱에 직접 저장이 불가능해, 갤러리 저장의 유일한 경로인
//   OS 공유시트를 사용한다(공유시트 > '사진에 저장'). 데스크톱은 다운로드로 폴백.
//   또한 iOS는 탭 직후에만 공유를 허용하므로(transient activation), 인증서 화면이
//   뜰 때 이미지를 미리 만들어 두고 버튼 탭 시 곧바로 공유한다.
// ---------------------------------------------------------------------
const btnCertImage = document.getElementById("btnCertImage");
const canShareFiles = () => !!(navigator.canShare && navigator.share);
let certFile = null; // 미리 생성해 둔 인증서 PNG File
let certRenderPromise = null; // 생성 진행 중 프로미스(빠른 탭 대비)

// 순위표·미션 목록 화면에 노출되는 저장/공유 버튼(완료 상태에서만 표시)
const certToggleBtns = ["btnCertImageMenu", "btnCertImageLb"].map((id) => document.getElementById(id));

function certFilename() {
  const code = state.data && state.data.certCode ? state.data.certCode : "cert";
  return `avsec-hero-${code}.png`;
}

// 인증서 영역을 캡처해 PNG File로 반환
async function renderCertFile() {
  const target = document.getElementById("certCapture");
  if (document.fonts && document.fonts.ready) {
    try { await document.fonts.ready; } catch (_) { /* 폰트 대기 실패 무시 */ }
  }
  const canvas = await window.html2canvas(target, {
    backgroundColor: "#0b1220",
    scale: Math.min(3, (window.devicePixelRatio || 1) * 2),
    useCORS: true,
  });
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
  return new File([blob], certFilename(), { type: "image/png" });
}

// 인증서 화면 표시 시 호출: 버튼은 곧바로 누를 수 있게 두고, 뒤에서 이미지를 미리 생성.
// (한 번 생성해 두면 순위표·목록 화면에서도 캐시를 재사용하므로 재캡처 불필요)
function prepareCertImage() {
  if (!btnCertImage) return;
  certFile = null;
  document.getElementById("certHelp").style.display = canShareFiles() ? "block" : "none";
  certRenderPromise = renderCertFile()
    .then((f) => { certFile = f; return f; })
    .catch((e) => { console.error("인증서 이미지 생성 실패", e); return null; });
}

// 준비된 인증서 File 확보. 캐시 우선 → 진행 중이면 대기 → 완료 화면일 때만 즉석 캡처.
async function getCertFile() {
  if (certFile) return certFile;
  if (certRenderPromise) { await certRenderPromise; if (certFile) return certFile; }
  if (document.getElementById("screen-complete").classList.contains("active")) {
    try { certFile = await renderCertFile(); } catch (e) { console.error(e); }
  }
  return certFile;
}

// 완료 상태일 때만 순위표·목록의 저장/공유 버튼을 노출
function refreshCertButtons() {
  const show = !!state.data && allMissionsDone();
  certToggleBtns.forEach((b) => { if (b) b.style.display = show ? "" : "none"; });
}

// 저장/공유 실행(완료 화면·순위표·목록 공용)
async function shareCertImage() {
  const file = await getCertFile();
  if (!file) {
    toast("인증서 이미지를 준비 중이에요. 잠시 후 다시 눌러 주세요.");
    return;
  }
  // 모바일: 공유시트 → '사진에 저장'
  if (canShareFiles() && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({
        files: [file],
        title: "항공보안 히어로 인증서",
        text: "항공보안 히어로 미션을 완료했어요! 🛡️",
      });
    } catch (e) {
      if (e && e.name === "NotAllowedError") {
        // 준비 전 급히 탭해 iOS 권한이 만료된 경우 — 이미지는 이제 준비됨
        toast("한 번 더 눌러 저장·공유하세요.");
      } else if (!e || e.name !== "AbortError") {
        console.error(e);
        toast("저장/공유에 실패했어요. 다시 시도하거나 화면을 캡처해 주세요.");
      }
    }
    return;
  }
  // 데스크톱 등 공유 미지원 → 다운로드
  const url = URL.createObjectURL(file);
  const a = document.createElement("a");
  a.href = url;
  a.download = certFilename();
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

[btnCertImage, ...certToggleBtns].forEach((b) => {
  if (b) b.addEventListener("click", shareCertImage);
});
document.getElementById("btnBackFromLeaderboard").addEventListener("click", () => {
  if (state.data) {
    renderMenu();
    showScreen("screen-menu");
  } else {
    showScreen("screen-start");
  }
});

// ---------------------------------------------------------------------
// 처음으로 (다음 참가자를 위해 세션 초기화 — 같은 기기를 여러 명이 순서대로 사용하는
// 부스 환경에서, 닉네임을 새로 입력해도 이전 참가자 기록을 이어받지 않도록 처리)
// ---------------------------------------------------------------------
function resetToStart() {
  localStorage.removeItem(SESSION_KEY);
  state.ref = null;
  state.sessionId = null;
  state.data = null;
  certFile = null;
  const input = document.getElementById("nicknameInput");
  if (input) input.value = "";
  refreshStartAvailability(); // 참여 횟수를 모두 쓴 기기라면 다시 시작하지 못하게
  showScreen("screen-start");
}

document.querySelectorAll(".go-home").forEach((btn) => {
  btn.addEventListener("click", () => {
    if (state.data && !allMissionsDone()) {
      const ok = confirm("처음 화면으로 돌아가시겠습니까?\n진행 중인 미션은 이 화면으로는 다시 이어할 수 없습니다.");
      if (!ok) return;
    }
    resetToStart();
  });
});

// ---------------------------------------------------------------------
// 새로고침 등으로 재진입 시 자동 복원 시도
// ---------------------------------------------------------------------
async function tryAutoResume() {
  const sessionId = localStorage.getItem(SESSION_KEY);
  if (!sessionId) return;
  try {
    const ref = doc(db, "participants", sessionId);
    const snap = await getDoc(ref);
    // 다른 행사의 세션이면 복원하지 않고 새로 시작하게 둔다
    if (snap.exists() && (snap.data().eventId || LEGACY_EVENT_ID) === state.eventId) {
      state.ref = ref;
      state.sessionId = sessionId;
      state.data = snap.data();
      renderMenu();
      startLeaderboardListener();
      if (allMissionsDone()) {
        showComplete();
      } else {
        showScreen("screen-menu");
      }
    }
  } catch (e) {
    console.warn("자동 복원 실패(최초 접속이면 정상):", e.message);
  }
}

// ---------------------------------------------------------------------
// 미션 설정(문구·항목·제한시간) 로드 및 화면 반영
//   Firestore settings/missions 문서가 없거나 값이 비어 있으면 기본값을 사용한다.
// ---------------------------------------------------------------------
async function loadMissionConfig() {
  let saved = null;
  try {
    const snap = await getDoc(doc(db, MISSION_SETTINGS_PATH.collection, MISSION_SETTINGS_PATH.docId));
    if (snap.exists()) saved = snap.data();
  } catch (e) {
    console.warn("미션 설정 조회 실패(기본값 사용):", e.message);
  }
  const cfg = mergeMissionConfig(saved);
  setMissionConfig(cfg); // 게임 로직(missions.js)에 반영
  applyMissionConfigToUI(cfg);
}

// 미션 카드·사전 안내 화면의 문구를 설정값으로 갱신
function applyMissionConfigToUI(cfg) {
  [1, 2, 3].forEach((n) => {
    const m = cfg["mission" + n];
    if (!m) return;
    const set = (id, value, html = false) => {
      const el = document.getElementById(id);
      if (!el || value == null) return;
      if (html) el.innerHTML = value;
      else el.textContent = value;
    };
    set("cardName-" + n, m.name);
    set("cardDesc-" + n, m.cardDesc);
    set("preTitle-" + n, m.title);
    // 안내 문구는 <strong> 등 간단한 강조 태그를 허용 (관리자만 편집 가능)
    set("preLine1-" + n, m.line1, true);
    set("preLine2-" + n, m.line2, true);
    if (m.durationSec) set("preTime-" + n, m.durationSec + "초");
  });
}

// ---------------------------------------------------------------------
// 행사(세션) 결정 — ?event=<ID> → 활성 행사 → 레거시(기본)
// ---------------------------------------------------------------------
async function resolveEvent() {
  const idFromUrl = new URLSearchParams(location.search).get(EVENT_PARAM);
  if (idFromUrl) {
    try {
      const snap = await getDoc(doc(db, "events", idFromUrl));
      if (snap.exists()) {
        state.eventId = snap.id;
        state.event = snap.data();
        return;
      }
      console.warn("QR의 행사 ID를 찾을 수 없습니다:", idFromUrl);
    } catch (e) {
      console.warn("행사 조회 실패:", e.message);
    }
  }
  // QR 없이 접속한 경우: 진행중으로 표시된 행사들 중에서 고른다.
  // 여러 행사를 동시에 운영할 수 있으므로, 후보가 2개 이상이면 선택 화면을 띄운다.
  try {
    const snap = await getDocs(query(collection(db, "events"), where("active", "==", true)));
    const candidates = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    const openNow = candidates.filter((e) => getEventOpenState(e).open);
    const pool = openNow.length > 0 ? openNow : candidates;

    if (pool.length > 1) {
      state.eventChoices = pool; // 선택 화면에서 사용
      return;
    }
    if (pool.length === 1) {
      state.eventId = pool[0].id;
      state.event = pool[0];
      return;
    }
  } catch (e) {
    console.warn("활성 행사 조회 실패:", e.message);
  }
  state.eventId = LEGACY_EVENT_ID; // 행사를 하나도 만들지 않은 경우(기존 동작 유지)
  state.event = null;
}

// 여러 행사가 동시에 진행 중일 때 참가자가 직접 고르는 화면
function renderEventPicker() {
  const list = document.getElementById("eventChoiceList");
  if (!list) return;
  list.innerHTML = "";
  state.eventChoices.forEach((ev) => {
    const btn = document.createElement("button");
    btn.className = "btn btn-secondary event-choice";
    btn.innerHTML = `<span class="ec-name"></span><span class="ec-period"></span>`;
    btn.querySelector(".ec-name").textContent = ev.name || "행사";
    btn.querySelector(".ec-period").textContent = formatEventPeriod(ev);
    btn.addEventListener("click", () => selectEvent(ev));
    list.appendChild(btn);
  });
}

// 선택한 행사로 확정하고 평소 흐름(자동 복원 → 시작 화면)으로 진입
async function selectEvent(ev) {
  state.eventId = ev.id;
  state.event = ev;
  state.eventChoices = null;
  applyEventToUI();
  await tryAutoResume();
  if (!state.data) showScreen("screen-start");
}

// 시작 화면에서 참가 가능 여부 갱신 (행사 기간 + 기기별 참여 횟수)
function refreshStartAvailability() {
  const noticeEl = document.getElementById("eventNotice");
  const startBtn = document.getElementById("btnStart");
  if (!noticeEl || !startBtn) return;

  const { open, reason } = getEventOpenState(state.event);
  let msg = "";
  if (!open) {
    msg =
      reason === "before"
        ? "아직 행사 시작 전입니다. 시작 시간에 다시 접속해 주세요."
        : "종료된 행사입니다. 참여해 주셔서 감사합니다!";
  } else if (!canPlayMore()) {
    msg = `이 기기에서는 ${MAX_PLAYS_PER_EVENT}회까지 참여할 수 있습니다.\n다음 참가자에게 양보해 주세요!`;
  }

  noticeEl.textContent = msg;
  noticeEl.style.display = msg ? "block" : "none";
  startBtn.disabled = !!msg;
}

// 행사 이름/일정 표시 + 참가 가능 여부 반영
function applyEventToUI() {
  const nameEl = document.getElementById("eventName");
  if (nameEl) {
    if (state.event) {
      nameEl.textContent = `${state.event.name} · ${formatEventPeriod(state.event)}`;
      nameEl.style.display = "block";
    } else {
      nameEl.style.display = "none";
    }
  }
  refreshStartAvailability();
}

(async function init() {
  applyKioskParam(); // ?kiosk=1 로 접속한 공용 기기는 참여 횟수 제한 면제
  await Promise.all([resolveEvent(), loadMissionConfig()]);
  if (state.eventChoices) {
    // 진행중인 행사가 여러 개 → 참가자가 직접 선택
    renderEventPicker();
    showScreen("screen-event-select");
    return;
  }
  applyEventToUI();
  await tryAutoResume();
})();
