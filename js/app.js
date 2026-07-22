// 앱 셸: 로그인 게이트, 탭 라우팅, 화면 초기화.
import { watchAuth, login, logout } from "./auth.js";
import { initCourses } from "./courses.js";
import { initSessions } from "./sessions.js";

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

function showTab(name) {
  document.querySelectorAll(".tab-panel").forEach((p) => {
    p.hidden = p.dataset.tab !== name;
  });
  document.querySelectorAll(".tab-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === name);
  });
}

function setupTabs() {
  document.querySelectorAll(".tab-btn").forEach((btn) => {
    btn.addEventListener("click", () => showTab(btn.dataset.tab));
  });
  showTab("courses");
}

function initApp() {
  if (initialized) return;
  initialized = true;
  setupTabs();
  initCourses();
  initSessions();
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
    (user) => {
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
