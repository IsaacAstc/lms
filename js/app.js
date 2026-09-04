// 앱 셸: 로그인 게이트, 탭 라우팅, 화면 초기화.
import { watchAuth, login, logout, isAdmin, isMaster, myAllowedTabs, isObserver } from "./auth.js";
import { initCourses } from "./courses.js";
import { initSessions } from "./sessions.js";
import { initRooms } from "./rooms.js";
import { initInstructors } from "./instructors.js";
import { initPrograms } from "./programs.js";
import { initSettings } from "./settings.js";
import { initPayroll } from "./payroll.js";
import { initExpenses } from "./expenses.js";
import { initSurveys } from "./surveys.js";
import { initReports } from "./reports.js";
import { initStats } from "./stats.js";
import { initReportDoc } from "./report-doc.js";
import { initFreetext } from "./freetext.js";
import { initDataAdmin } from "./data-admin.js";
import { initAdmins } from "./admins.js";
import { initBoardAdmin } from "./board-admin.js";
import { initExportButtons } from "./export-csv.js";
import { initCsvImport } from "./csv-import.js";
import { initSeed } from "./seed.js";
import { initOrgSelectors, initOrgAdmin, tabFeature } from "./orgs.js";
import { initRentals } from "./rentals.js";
import { initPadAdmin } from "./pad-admin.js";
import { initLogiAdmin } from "./logi-admin.js";
import { initNamedAdmin } from "./named-admin.js";
import { currentOrg } from "./firebase.js";

// 공용 유틸: HTML 이스케이프 (XSS 방지).
export function escapeHtml(v) {
  return String(v)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

let initialized = false;

// 상단 그룹(1단계) → 서브탭(2단계). 패널은 기존 그대로(data-tab)이며 표시만 제어.
const TAB_GROUPS = [
  { id: "operate", label: "교육 운영", tabs: [["courses", "차수·시간표"], ["programs", "과정 커리큘럼"], ["rooms", "강의실"], ["instructors", "강사"]] },
  { id: "finance", label: "강사료·경비", tabs: [["payroll", "강사료·집계"], ["expenses", "소요경비"]] },
  { id: "surveys", label: "설문", tabs: [["surveys", "설문 관리"], ["surveyitems", "문항 설정"], ["reports", "설문 집계"], ["freetext", "주관식 원문"]] },
  // 기명 조사는 개인정보 처리 경로라 익명 설문 그룹과 나란히 두지 않고 별도 그룹으로 분리한다.
  { id: "named", label: "기명 조사", tabs: [["named", "기명 조사"]] },
  { id: "stats", label: "통계·보고서", tabs: [["stats", "통계 대시보드"], ["reportdoc", "운영 보고서"]] },
  { id: "site", label: "현장·공개", tabs: [["board", "공개 현황 보드"], ["rentals", "현장 안내(DID)"]] },
  { id: "class", label: "수업 지원", tabs: [["pad", "수업 보드"], ["logi", "ICAO 로지보드"]] },
  { id: "admin", label: "설정", tabs: [["settings", "기준값 설정"], ["admins", "관리자 계정"], ["data", "데이터 관리"], ["orgs", "기관 관리"]] },
];
// 마스터 전용 탭(일반 관리자에게는 숨김 — 실제 차단은 firestore.rules).
const MASTER_ONLY_TABS = new Set(["data", "orgs"]);
// 개인정보를 처리하는 탭: '전체 허용' 계정에도 자동으로 열리지 않고,
// 계정별 사용 가능 탭에 명시적으로 지정된 경우에만 보인다(마스터 제외).
const RESTRICTED_TABS = new Set(["named"]);
let masterMode = false;
export function isMasterMode() { return masterMode; }

// 계정별 허용 탭(admins/{email}.tabs). null = 제한 없음(전체).
// 마스터는 항상 전체. 실제 차단은 firestore.rules가 담당한다.
let allowedTabs = null;
function accountAllows(tab) {
  if (masterMode) return true;
  if (RESTRICTED_TABS.has(tab)) return Array.isArray(allowedTabs) && allowedTabs.includes(tab);
  return allowedTabs === null || allowedTabs.includes(tab);
}

// 참관자(조회 전용) 모드. 실제 차단은 firestore.rules가 담당하고,
// 여기서는 저장·삭제 등 쓰기 조작을 미리 막아 불필요한 오류를 줄인다.
let observerMode = false;
export function isObserverMode() { return observerMode; }
// 쓰기성 버튼 판별(라벨 기준). '내보내기·복사·조회·필터' 등 읽기 동작은 제외한다.
const WRITE_LABEL = /저장|등록|수정|삭제|추가|반려|파기|시드|업로드|동기화|발송|복제|가져오기|재설정|생성|승인|반영|만들기|보관|복원/;
function blockWrites() {
  document.body.classList.add("observer-mode");
  const stop = (e, msg) => {
    e.preventDefault();
    e.stopImmediatePropagation();
    alert(msg);
  };
  // capture 단계에서 가로채 각 모듈의 핸들러보다 먼저 차단한다.
  // 본인 계정 비밀번호 변경·재설정은 Firestore 쓰기가 아니므로 허용.
  const SELF_OK = new Set(["pw-change-btn", "admin-reset-btn"]);
  document.addEventListener("click", (e) => {
    const b = e.target.closest("button, input[type=submit]");
    if (!b || b.disabled || SELF_OK.has(b.id)) return;
    if (WRITE_LABEL.test(b.textContent || b.value || "")) {
      stop(e, "참관자 계정은 조회만 가능합니다.");
    }
  }, true);
  document.addEventListener("submit", (e) => stop(e, "참관자 계정은 조회만 가능합니다."), true);
  // 체크박스 즉시저장(공개보드 숨김 등)도 차단.
  document.addEventListener("change", (e) => {
    if (e.target.matches("input[type=checkbox].r-hide, input[type=checkbox].c-hide")) {
      e.target.checked = !e.target.checked;
      stop(e, "참관자 계정은 조회만 가능합니다.");
    }
  }, true);
}

// 기관별 기능 취사선택: 추가 기관은 orgs 레지스트리의 features 목록에 있는 기능만 사용.
// 기본 기관은 항상 전체. features 미설정(구버전 등록분)도 전체 허용.
function orgAllows(tab) {
  if (!currentOrg) return true;                       // 기본 기관: 전체
  if (tab === "orgs") return false;                   // 기관 관리는 기본 기관 전용
  const f = tabFeature(tab);
  if (!f) return true;                                // 기능 분류 밖(설정 핵심 등)은 항상
  const feats = Array.isArray(currentOrg.features) ? currentOrg.features : null;
  return !feats || feats.includes(f);
}

// 현재 역할·기관에서 접근 가능한 탭만 남긴 그룹 목록.
function visibleGroups() {
  return TAB_GROUPS
    .map((g) => ({ ...g, tabs: g.tabs.filter(([t]) => (masterMode || !MASTER_ONLY_TABS.has(t)) && orgAllows(t) && accountAllows(t)) }))
    .filter((g) => g.tabs.length);
}
const groupOfTab = (name) => visibleGroups().find((g) => g.tabs.some(([t]) => t === name));

// 계정별 권한 지정 UI용 전체 탭 목록(마스터 전용 탭은 계정 지정 대상이 아니므로 제외).
export const ASSIGNABLE_TABS = TAB_GROUPS.flatMap((g) =>
  g.tabs.filter(([t]) => !MASTER_ONLY_TABS.has(t))
    .map(([id, label]) => ({ id, label: label || g.label, group: g.label })));

function showTab(name) {
  const group = groupOfTab(name);
  document.querySelectorAll(".tab-panel").forEach((p) => { p.hidden = p.dataset.tab !== name; });
  // 상단 그룹 버튼 활성화(그룹 내 어떤 서브탭이든 활성이면 그룹 강조).
  document.querySelectorAll("#main-tabs .tab-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.group === group?.id);
  });
  // 서브탭 바: 그룹에 탭이 2개 이상일 때만 노출.
  renderSubtabs(group, name);
  document.dispatchEvent(new CustomEvent("tabshown", { detail: name }));
}

function renderSubtabs(group, active) {
  const bar = document.getElementById("sub-tabs");
  if (!group || group.tabs.length < 2) { bar.hidden = true; bar.innerHTML = ""; return; }
  bar.hidden = false;
  bar.innerHTML = "";
  for (const [tab, label] of group.tabs) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "subtab-btn" + (tab === active ? " active" : "");
    b.textContent = label;
    b.addEventListener("click", () => showTab(tab));
    bar.appendChild(b);
  }
}

function setupTabs() {
  const nav = document.getElementById("main-tabs");
  nav.innerHTML = "";
  for (const g of visibleGroups()) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tab-btn";
    b.dataset.group = g.id;
    b.textContent = g.label;
    b.addEventListener("click", () => showTab(g.tabs[0][0]));
    nav.appendChild(b);
  }
  // 첫 화면: 차수·시간표가 허용이면 그것, 아니면 첫 번째 보이는 탭.
  const groups = visibleGroups();
  const first = groups.some((g) => g.tabs.some(([t]) => t === "courses")) ? "courses" : groups[0]?.tabs[0][0];
  if (first) showTab(first);
}

function initApp() {
  if (initialized) return;
  initialized = true;
  setupTabs();
  // 마스터/설정 먼저 초기화(구독 시작) → 시간표·강사료가 이를 참조.
  initSettings();
  initRooms();
  initInstructors();
  initPrograms();
  initCourses();
  initSessions();
  initPayroll();
  initExpenses();
  initSurveys();
  initReports();
  initStats();
  initReportDoc();
  initFreetext();
  if (masterMode) initDataAdmin(); // 데이터 관리는 마스터 전용(불필요한 조회도 방지).
  if (masterMode) initOrgAdmin(); // 기관 관리(마스터 전용, 편집은 허브에서만).
  initAdmins();
  initBoardAdmin();
  initRentals();
  initPadAdmin();
  initLogiAdmin();
  initNamedAdmin();
  initExportButtons();
  initCsvImport();
  initSeed();
}

window.addEventListener("DOMContentLoaded", () => {
  const loginView = document.getElementById("login-view");
  const appView = document.getElementById("app-view");
  const loginForm = document.getElementById("login-form");
  const loginError = document.getElementById("login-error");
  const userEmail = document.getElementById("user-email");

  loginForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    loginError.textContent = "";
    try {
      await login(loginForm.email.value.trim(), loginForm.password.value);
    } catch (err) {
      loginError.textContent = "로그인 실패: 이메일 또는 비밀번호를 확인하세요.";
    }
  });

  document.getElementById("logout-btn").addEventListener("click", () => logout());

  // 기관 선택(로그인 화면·상단바) — 등록된 기관이 있을 때만 표시.
  initOrgSelectors();

  // 계정 전환 시 이전 계정의 탭 구성·구독이 남지 않도록 완전 재초기화(새로고침)한다.
  // (initApp은 1회성이라 재로그인만으로는 탭 바가 다시 그려지지 않는다)
  let sessionUid = null;

  watchAuth(
    async (user) => {
      if (initialized && sessionUid && user.uid !== sessionUid) { location.reload(); return; }
      sessionUid = user.uid;
      // 인증됐더라도 관리자 권한(보안규칙 허용)이 없으면 앱 셸을 열지 않는다.
      const admin = await isAdmin();
      if (!admin) {
        loginError.textContent = "관리자 권한이 없는 계정입니다. 관리자에게 문의하세요.";
        appView.hidden = true;
        loginView.hidden = false;
        await logout();
        return;
      }
      masterMode = await isMaster(); // 탭 구성 전에 역할 확정.
      observerMode = masterMode ? false : await isObserver();
      allowedTabs = masterMode ? null : await myAllowedTabs(); // 계정별 탭 권한.
      loginView.hidden = true;
      appView.hidden = false;
      const roleLabel = masterMode ? "마스터 관리자" : observerMode ? "참관자 · 조회 전용" : "일반 관리자";
      userEmail.textContent = `${user.email || ""} (${roleLabel})`;
      // 비디오 볼트(별도 프로젝트, 같은 Firebase 로그인 세션 공유):
      // 마스터 + 기관 기능(vault) 허용일 때만 노출. 보이면 바로가기 바도 함께 노출.
      const vaultLink = document.getElementById("link-vault");
      vaultLink.hidden = !(masterMode && orgAllows("vault"));
      if (!vaultLink.hidden) document.querySelector(".quick-links").hidden = false;
      if (observerMode) blockWrites();
      initApp();
    },
    () => {
      appView.hidden = true;
      loginView.hidden = false;
      // 로그인 상태였다가 로그아웃한 경우에만 새로고침(최초 진입 시에는 그대로).
      if (initialized) location.reload();
    }
  );
});
