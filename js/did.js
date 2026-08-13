// 현장 안내 DID (공개, 로그인 없음) — 로비 대형 TV 상시 표출.
// 데이터: publicBoard(오늘 진행 중 교육 — 숨김·비공개유형은 애초에 미게시),
//        rentals(오늘 대관 행사 — 행사명·장소·시간만, 개인정보 없음),
//        publicBoard/__did(제목·안내문구·로고·배경 설정).
// 항목이 한 화면을 넘으면 페이지를 자동 순환한다.
import {
  collection, doc, onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./firebase.js";

const PAGE_SIZE = 4;        // 한 화면 카드 수(교육+대관 합산, 1열 대형 텍스트 기준)
const PAGE_INTERVAL = 10000; // 페이지 순환 간격(ms)

let courses = [];   // publicBoard
let rentals = [];
let pageTick = 0;
let lastPages = 1;      // 마지막 렌더 기준 총 페이지 수
let lastDay = "";       // 마지막 렌더 날짜(자정 경계 감지)

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
// 1열 배치: 교육·대관을 합쳐 한 화면 최대 PAGE_SIZE건으로 페이지 순환.
// 각 페이지에서 해당 유형의 항목이 있을 때만 그 섹션(헤더)을 표시한다.
function render() {
  const today = todayStr();

  const edu = courses
    .filter((c) => (c.startDate || "") <= today && today <= (c.endDate || c.startDate || ""))
    .sort((a, b) => (a.venue || "").localeCompare(b.venue || "") || (a.name || "").localeCompare(b.name || ""));
  const rent = rentals
    .filter((r) => !r.hidden && (r.startDate || "") <= today && today <= (r.endDate || r.startDate || ""))
    .sort((a, b) => (a.startTime || "").localeCompare(b.startTime || ""));

  const all = [
    ...edu.map((c) => ({ kind: "edu", c })),
    ...rent.map((r) => ({ kind: "rent", r })),
  ];
  const pages = Math.max(1, Math.ceil(all.length / PAGE_SIZE));
  lastPages = pages;
  lastDay = today;
  const p = pageTick % pages;
  const label = pages > 1 ? `${p + 1} / ${pages}` : "";
  const items = all.slice(p * PAGE_SIZE, (p + 1) * PAGE_SIZE);
  const eduItems = items.filter((x) => x.kind === "edu");
  const rentItems = items.filter((x) => x.kind === "rent");

  // 이 페이지에 해당 유형이 없으면 섹션을 숨긴다.
  // 단 교육이 아예 없는 날은 '오늘 진행 중인 교육이 없습니다' 안내를 위해 섹션 유지.
  $("sec-edu").classList.toggle("hidden", edu.length > 0 && !eduItems.length);
  $("sec-rent").classList.toggle("hidden", !rentItems.length);
  $("edu-page").textContent = label;
  $("rent-page").textContent = eduItems.length ? "" : label;

  $("edu-cards").innerHTML = eduItems.length
    ? eduItems.map(({ c }) => `
      <div class="card">
        <div class="info">
          <div class="name">${esc(c.name)}${c.round ? ` <small style="font-weight:400;color:#5a6c84;">${esc(String(c.round))}차수</small>` : ""}</div>
          <div class="sub">${esc(c.startDate || "")}${c.endDate && c.endDate !== c.startDate ? ` - ${esc(c.endDate)}` : ""}</div>
        </div>
        <div class="room">${esc(c.venue || "장소 미정")}</div>
      </div>`).join("")
    : `<div class="empty">오늘 진행 중인 교육이 없습니다.</div>`;

  $("rent-cards").innerHTML = rentItems.map(({ r }) => `
    <div class="card">
      <div class="info">
        <div class="name">${esc(r.name)}</div>
        <div class="sub">${esc(r.startTime || "")}${r.endTime ? ` - ${esc(r.endTime)}` : ""}${r.note ? ` · ${esc(r.note)}` : ""}</div>
      </div>
      <div class="room">${esc(r.venue || "장소 미정")}</div>
    </div>`).join("");
}

function applyConfig(cfg) {
  $("title").textContent = cfg.title || "KAC 항공보안교육센터";
  document.title = cfg.title || "KAC 항공보안교육센터";
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
  // 페이지 순환: 페이지가 2개 이상일 때만 다시 그린다(단일 페이지 불필요 갱신·깜빡임 방지).
  // 날짜가 바뀌면(자정) 표시 대상이 달라지므로 그때는 강제 갱신.
  setInterval(() => {
    const dayChanged = todayStr() !== lastDay;
    if (lastPages > 1 || dayChanged) { pageTick++; render(); }
  }, PAGE_INTERVAL);

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
