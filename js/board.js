// 공개 현황 보드(외부 열람 전용). publicBoard 컬렉션을 실시간 구독해 과정별 신청 현황 표시.
// 개인정보 없음 — 수치·일정만. 실제 신청 접수는 시스템 범위 밖(안내 텍스트로 설명).
import {
  collection, doc, onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./firebase.js";

const root = document.getElementById("board-root");
let items = [];

function esc(v) {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function todayStr() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
}
// KST 기준 오늘 + n일.
function dayOffsetStr(n) {
  const base = new Date(`${todayStr()}T00:00:00+09:00`);
  base.setDate(base.getDate() + n);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(base);
}

// 기본 조회 범위: 오늘 ~ +N일.
const DEFAULT_RANGE_DAYS = 30;
function applyDefaultRange() {
  document.getElementById("board-from").value = todayStr();
  document.getElementById("board-to").value = dayOffsetStr(DEFAULT_RANGE_DAYS);
  document.getElementById("board-past").checked = false;
}

// 교육기간이 지정 범위와 겹치면 표시(여러 날 과정이 경계에 걸쳐도 포함).
function inRange(c, from, to) {
  const s = c.startDate || "";
  const e = c.endDate || s;
  if (from && e && e < from) return false;
  if (to && s && s > to) return false;
  return true;
}

function render() {
  const includePast = document.getElementById("board-past").checked;
  const from = document.getElementById("board-from").value;
  const to = document.getElementById("board-to").value;
  const note = document.getElementById("board-filter-note");
  const today = todayStr();

  if (from && to && to < from) {
    root.innerHTML = `<p class="empty">종료일자가 시작일자보다 빠릅니다. 기간을 다시 선택하세요.</p>`;
    note.textContent = "";
    return;
  }

  const ranged = !!(from || to);
  // 기간을 지정하면 그 범위를 기준으로 하고, 아니면 '지난 과정 포함' 여부로 판단.
  const list = items
    .filter((c) => (ranged ? inRange(c, from, to) : (includePast || !c.endDate || c.endDate >= today)))
    .sort((a, b) => (a.startDate || "").localeCompare(b.startDate || "") || (a.name || "").localeCompare(b.name || ""));

  const isDefault = ranged && from === todayStr() && to === dayOffsetStr(DEFAULT_RANGE_DAYS);
  note.textContent = ranged
    ? `${from || "처음"} ~ ${to || "끝"}${isDefault ? ` (기본 ${DEFAULT_RANGE_DAYS}일)` : ""} · ${list.length}건`
    : (includePast ? `전체 기간 · ${list.length}건` : `진행 예정·진행 중 · ${list.length}건`);

  if (!list.length) {
    root.innerHTML = `<p class="empty">${ranged ? "해당 기간에 교육 과정이 없습니다." : "현재 안내 중인 교육 과정이 없습니다."}</p>`;
    return;
  }
  root.innerHTML = `<div class="board-grid">${list.map(card).join("")}</div>`;
}

function card(c) {
  const cap = c.capacity || 0;
  const applied = c.appliedCount || 0;
  const remaining = c.remaining != null ? c.remaining : Math.max(0, cap - applied);
  const full = cap > 0 && remaining <= 0;
  const pct = cap ? Math.min(100, Math.round((applied / cap) * 100)) : 0;
  const period = c.startDate ? `${esc(c.startDate)}${c.endDate && c.endDate !== c.startDate ? " ~ " + esc(c.endDate) : ""}` : "-";
  return `
    <article class="board-card${full ? " full" : ""}">
      <div class="board-card-head">
        <span class="board-badge">${esc(c.courseType || "과정")}</span>
        <h3>${esc(c.name || "")}${c.round ? ` <small>${esc(String(c.round))}차수</small>` : ""}</h3>
      </div>
      <dl class="board-meta">
        <div><dt>교육기간</dt><dd>${period}</dd></div>
        <div><dt>교육장</dt><dd>${esc(c.venue || "-")}</dd></div>
        <div><dt>정원</dt><dd>${cap || "-"}</dd></div>
        <div><dt>신청</dt><dd>${applied}</dd></div>
        <div><dt>잔여</dt><dd class="${full ? "board-full" : "board-open"}">${full ? "마감" : remaining}</dd></div>
      </dl>
      <div class="board-bar"><span style="width:${pct}%"></span></div>
    </article>`;
}

function main() {
  applyDefaultRange(); // 최초 조회는 오늘~+N일 기본 범위.

  // 신청 안내 텍스트(__config 문서) 구독.
  onSnapshot(doc(db, "publicBoard", "__config"), (snap) => {
    const applyInfo = snap.exists() ? (snap.data().applyInfo || "") : "";
    const box = document.getElementById("board-apply");
    if (applyInfo.trim()) {
      document.getElementById("board-apply-text").innerHTML = esc(applyInfo).replace(/\n/g, "<br>");
      box.hidden = false;
    } else box.hidden = true;
  }, () => {});

  // 과정 현황 구독(실시간).
  onSnapshot(collection(db, "publicBoard"), (snap) => {
    items = snap.docs.filter((d) => !d.id.startsWith("__")).map((d) => d.data());
    const latest = items.reduce((m, c) => Math.max(m, c.updatedAtMs || 0), 0);
    document.getElementById("board-updated").textContent = latest
      ? `업데이트: ${new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "medium", timeStyle: "short" }).format(new Date(latest))}`
      : "";
    render();
  }, () => { root.innerHTML = `<p class="empty">현황을 불러오지 못했습니다. 잠시 후 다시 시도하세요.</p>`; });

  document.getElementById("board-past").addEventListener("change", render);
  document.getElementById("board-from").addEventListener("change", render);
  document.getElementById("board-to").addEventListener("change", render);
  document.getElementById("board-reset").addEventListener("click", () => {
    applyDefaultRange(); // 기본 범위로 복귀.
    render();
  });
}

main();
