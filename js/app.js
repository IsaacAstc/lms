// 앱 셸: 로그인 게이트, 탭 라우팅, 화면 초기화.
import { watchAuth, login, logout, isAdmin } from "./auth.js";
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
import { initExportButtons } from "./export-csv.js";
import { initSeed } from "./seed.js";

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
  { id: "admin", label: "설정", tabs: [["settings", "기준값 설정"], ["admins", "관리자 계정"], ["data", "데이터 관리"]] },
];
const groupOfTab = (name) => TAB_GROUPS.find((g) => g.tabs.some(([t]) => t === name));

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
  for (const g of TAB_GROUPS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "tab-btn";
    b.dataset.group = g.id;
    b.textContent = g.label;
    b.addEventListener("click", () => showTab(g.tabs[0][0]));
    nav.appendChild(b);
  }
  showTab("courses");
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
  initDataAdmin();
  initAdmins();
  initExportButtons();
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
      loginView.hidden = true;
      appView.hidden = false;
      userEmail.textContent = user.email || "";
      initApp();
    },
    () => {
      appView.hidden = true;
      loginView.hidden = false;
    }
  );
});
