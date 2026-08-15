// 앱 셸: 로그인 게이트, 탭 라우팅, 화면 초기화.
import { watchAuth, login, logout, isAdmin, isMaster, myAllowedTabs } from "./auth.js";
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
  { id: "courses", label: "차수·시간표", tabs: [["courses", ""]] },
  { id: "master", label: "마스터", tabs: [["programs", "과정 커리큘럼"], ["rooms", "강의실"], ["instructors", "강사"]] },
  { id: "finance", label: "강사료·경비", tabs: [["payroll", "강사료·집계"], ["expenses", "소요경비"]] },
  { id: "surveys", label: "설문 관리", tabs: [["surveys", ""]] },
  { id: "survey-result", label: "설문 결과", tabs: [["reports", "설문 집계"], ["freetext", "주관식 원문"]] },
  { id: "stats", label: "통계", tabs: [["stats", ""]] },
  { id: "reportdoc", label: "운영 보고서", tabs: [["reportdoc", ""]] },
  { id: "site", label: "현장 안내", tabs: [["rentals", ""]] },
  { id: "admin", label: "설정", tabs: [["settings", "기준값 설정"], ["admins", "관리자 계정"], ["data", "데이터 관리"], ["board", "공개 현황 보드"], ["orgs", "기관 관리"]] },
];
// 마스터 전용 탭(일반 관리자에게는 숨김 — 실제 차단은 firestore.rules).
const MASTER_ONLY_TABS = new Set(["data", "orgs"]);
let masterMode = false;
export function isMasterMode() { return masterMode; }

// 계정별 허용 탭(admins/{email}.tabs). null = 제한 없음(전체).
// 마스터는 항상 전체. 실제 차단은 firestore.rules가 담당한다.
let allowedTabs = null;
function accountAllows(tab) {
  return masterMode || allowedTabs === null || allowedTabs.includes(tab);
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

  watchAuth(
    async (user) => {
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
      allowedTabs = masterMode ? null : await myAllowedTabs(); // 계정별 탭 권한.
      loginView.hidden = true;
      appView.hidden = false;
      userEmail.textContent = `${user.email || ""} (${masterMode ? "마스터 관리자" : "일반 관리자"})`;
      initApp();
    },
    () => {
      appView.hidden = true;
      loginView.hidden = false;
    }
  );
});
