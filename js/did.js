// 현장 안내 DID (공개, 로그인 없음) — 로비 대형 TV 상시 표출.
// 데이터: publicBoard(오늘 진행 중 교육 — 숨김·비공개유형은 애초에 미게시),
//        rentals(오늘 대관 행사 — 행사명·장소·시간만, 개인정보 없음),
//        publicBoard/__did(제목·안내문구·로고·배경 설정).
// 항목이 한 화면을 넘으면 페이지를 자동 순환한다.
import {
  collection, doc, onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./firebase.js";

const PAGE_SIZE = 6;        // 섹션당 한 화면 카드 수(86" 16:9 기준 가독 한계)
const PAGE_INTERVAL = 10000; // 페이지 순환 간격(ms)

let courses = [];   // publicBoard
let rentals = [];
let pageTick = 0;

const $ = (id) => document.getElementById(id);
const esc = (s) => { const d = document.createElement("div"); d.textContent = s ?? ""; return d.innerHTML; };

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ── 시계 ──
function tickClock() {
  const d = new Date();
  const days = ["일", "월", "화", "수", "목", "금", "토"];
  $("date").textContent = `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")} (${days[d.getDay()]})`;
  $("clock").textContent = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ── 렌더 ──
function pageOf(list, tick) {
  if (list.length <= PAGE_SIZE) return { items: list, label: "" };
  const pages = Math.ceil(list.length / PAGE_SIZE);
  const p = tick % pages;
  return { items: list.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE), label: `${p + 1} / ${pages}` };
}

function render() {
  const today = todayStr();

  const edu = courses
    .filter((c) => (c.startDate || "") <= today && today <= (c.endDate || c.startDate || ""))
    .sort((a, b) => (a.venue || "").localeCompare(b.venue || "") || (a.name || "").localeCompare(b.name || ""));
  const rent = rentals
    .filter((r) => !r.hidden && (r.startDate || "") <= today && today <= (r.endDate || r.startDate || ""))
    .sort((a, b) => (a.startTime || "").localeCompare(b.startTime || ""));

  // 한쪽이 비면 다른 쪽을 전체 폭으로.
  $("sec-rent").classList.toggle("hidden", !rent.length);
  $("sec-edu").classList.toggle("hidden", !edu.length && !!rent.length);

  const ep = pageOf(edu, pageTick);
  $("edu-page").textContent = ep.label;
  $("edu-cards").innerHTML = ep.items.length
    ? ep.items.map((c) => `
      <div class="card">
        <div class="info">
          <div class="name">${esc(c.name)}${c.round ? ` <small style="font-weight:400;color:#5a6c84;">${esc(String(c.round))}차수</small>` : ""}</div>
          <div class="sub">${esc(c.startDate || "")}${c.endDate && c.endDate !== c.startDate ? ` - ${esc(c.endDate)}` : ""}</div>
        </div>
        <div class="room">${esc(c.venue || "장소 미정")}</div>
      </div>`).join("")
    : `<div class="empty">오늘 진행 중인 교육이 없습니다.</div>`;

  const rp = pageOf(rent, pageTick);
  $("rent-page").textContent = rp.label;
  $("rent-cards").innerHTML = rp.items.map((r) => `
    <div class="card">
      <div class="info">
        <div class="name">${esc(r.name)}</div>
        <div class="sub">${esc(r.startTime || "")}${r.endTime ? ` - ${esc(r.endTime)}` : ""}${r.note ? ` · ${esc(r.note)}` : ""}</div>
      </div>
      <div class="room">${esc(r.venue || "장소 미정")}</div>
    </div>`).join("");
}

function applyConfig(cfg) {
  $("title").textContent = cfg.title || "현장 안내";
  document.title = cfg.title || "현장 안내";
  $("notice").textContent = cfg.notice || "";
  const logo = $("logo");
  if (cfg.logoUrl) { logo.src = cfg.logoUrl; logo.hidden = false; } else logo.hidden = true;
  const bg = $("bg");
  if (cfg.bgUrl) {
    bg.style.backgroundImage = `url("${cfg.bgUrl.replace(/"/g, "")}")`;
    bg.classList.add("has-img");
  } else {
    bg.style.backgroundImage = "";
    bg.classList.remove("has-img");
  }
}

function main() {
  tickClock();
  setInterval(tickClock, 5000);
  // 페이지 순환 + 날짜 경계(자정) 자동 갱신.
  setInterval(() => { pageTick++; render(); }, PAGE_INTERVAL);

  onSnapshot(doc(db, "publicBoard", "__did"), (snap) => {
    applyConfig(snap.exists() ? snap.data() : {});
  }, () => {});

  onSnapshot(collection(db, "publicBoard"), (snap) => {
    courses = snap.docs.filter((d) => !d.id.startsWith("__")).map((d) => d.data());
    render();
  }, () => { $("edu-cards").innerHTML = `<div class="empty">정보를 불러오지 못했습니다.</div>`; });

  onSnapshot(collection(db, "rentals"), (snap) => {
    rentals = snap.docs.map((d) => d.data());
    render();
  }, () => {});
}

main();
