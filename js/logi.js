// ICAO Course Logiboard — 참가자(공개) 페이지. 영어 전용, 로그인 없음, 개인정보 미수집.
// Schedule/Bulletins/Polls는 Firestore, Q&A/Chat은 RTDB 실시간.
import {
  collection, doc, onSnapshot, updateDoc, query, where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getDatabase, ref, onValue, push, set,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { db, app } from "./firebase.js";

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const courseId = new URLSearchParams(location.search).get("course") || "";

let rtdb = null;
try { rtdb = getDatabase(app); } catch { /* 메신저 비활성 */ }

// 기기 키: Q&A 스레드 식별용 무작위 문자열(개인정보 아님).
const TK = "logiThreadKey";
let threadKey = localStorage.getItem(TK);
if (!threadKey) {
  threadKey = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 24);
  localStorage.setItem(TK, threadKey);
}

let board = null;
const TABS = [
  ["schedule", "📅 Schedule", (b) => b.showSchedule !== false && (b.schedule || []).length],
  ["bulletins", "📢 Bulletins", () => true],
  ["polls", "🗳 Polls", () => true],
  ["qna", "💬 Ask Staff", (b) => b.qnaEnabled !== false && rtdb],
  ["chat", "👥 Chat", (b) => b.chatEnabled !== false && rtdb],
];
let activeTab = "";
let wired = false;
// 새 항목 감지 상태(알림·배지용)
const seen = { bul: new Set(), poll: new Map(), qna: new Set(), chat: new Set() };

function fail(msg) { $("lg-empty").hidden = false; $("lg-empty").textContent = msg; $("lg-tabs").innerHTML = ""; }

if (!courseId) {
  fail("Invalid link. Please use the QR code or link provided by the course staff.");
} else {
  onSnapshot(doc(db, "logiBoards", courseId), (snap) => {
    if (!snap.exists()) return fail("Board not found. Please check your link.");
    board = snap.data();
    $("lg-title").textContent = board.titleEn || "Course Logiboard";
    document.title = board.titleEn || "Course Logiboard";
    $("lg-sub").textContent = [board.startDate && `${board.startDate} ~ ${board.endDate}`, board.venue].filter(Boolean).join(" · ");
    $("lg-welcome").textContent = board.welcome || "";
    if (board.active === false) return fail("This course board has been closed. Thank you for participating!");
    $("lg-empty").hidden = true;
    renderTabs();
    renderSchedule();
    if (!wired) { wire(); wired = true; }
  }, () => fail("Failed to load. Please try again."));
}

function renderTabs() {
  const avail = TABS.filter(([, , ok]) => ok(board));
  if (!activeTab || !avail.some(([id]) => id === activeTab)) activeTab = avail[0]?.[0] || "";
  clearBadge(activeTab);
  $("lg-tabs").innerHTML = avail.map(([id, label]) =>
    `<button type="button" class="logi-tab${id === activeTab ? " active" : ""}" data-t="${id}">${label}${badges[id] ? ` <span class="logi-badge">${badges[id]}</span>` : ""}</button>`).join("");
  $("lg-tabs").querySelectorAll(".logi-tab").forEach((b) =>
    b.addEventListener("click", () => { activeTab = b.dataset.t; renderTabs(); }));
  TABS.forEach(([id]) => { $(`lg-${id}`).hidden = id !== activeTab; });
}

/* ── Schedule (시간표 스냅샷 — 강사명 없음) ── */
function renderSchedule() {
  const sch = board.schedule || [];
  const box = $("lg-schedule-body");
  if (!sch.length) { box.innerHTML = `<p class="empty">Schedule will be posted soon.</p>`; return; }
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
  const byDate = {};
  sch.forEach((s) => { (byDate[s.date] = byDate[s.date] || []).push(s); });
  box.innerHTML = Object.keys(byDate).sort().map((d, i) => `
    <div class="load-box${d === today ? " logi-today" : ""}">
      <b>Day ${i + 1} — ${esc(d)}${d === today ? " (Today)" : ""}</b>
      <table class="logi-sch"><tbody>
        ${byDate[d].map((s) => `<tr>
          <td class="logi-time">${esc(s.startTime)}–${esc(s.endTime)}</td>
          <td>${esc(s.subject)}</td>
          <td class="logi-room">${esc(s.room)}</td></tr>`).join("")}
      </tbody></table>
    </div>`).join("");
}

/* ── Bulletins ── */
onSnapshotSafe(() => courseId && onSnapshot(
  query(collection(db, "logiBulletins"), where("courseId", "==", courseId)), (snap) => {
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.pinned - a.pinned) || (b.createdAtMs || 0) - (a.createdAtMs || 0));
    for (const bl of list) {
      if (!seen.bul.has(bl.id)) {
        if ((bl.createdAtMs || 0) > loadedAt) announce("bulletins", "New announcement", bl.title);
        seen.bul.add(bl.id);
      }
    }
    const box = $("lg-bul-body");
    box.innerHTML = list.length ? "" : `<p class="empty">No announcements yet.</p>`;
    for (const bl of list) {
      const when = bl.createdAtMs ? new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "short" }).format(new Date(bl.createdAtMs)) : "";
      const div = document.createElement("div");
      div.className = "load-box" + (bl.pinned ? " logi-pinned" : "");
      div.innerHTML = `${bl.pinned ? `<span class="logi-pin">📌 Pinned</span>` : ""}
        <b>${esc(bl.title)}</b> <small>${esc(when)}</small>
        ${bl.body ? `<p style="white-space:pre-wrap;margin:0.4rem 0 0;">${esc(bl.body)}</p>` : ""}
        ${bl.linkUrl ? `<a class="pad-link" href="${esc(bl.linkUrl)}" target="_blank" rel="noopener nofollow">🔗 Link</a>` : ""}`;
      box.appendChild(div);
    }
  }, () => {}));

/* ── Polls ── */
const votedKey = (pid) => `logiVoted:${pid}`;
onSnapshotSafe(() => courseId && onSnapshot(
  query(collection(db, "logiPolls"), where("courseId", "==", courseId)), (snap) => {
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => (b.open - a.open) || (b.createdAtMs || 0) - (a.createdAtMs || 0));
    for (const p of list) {
      const prev = seen.poll.get(p.id);
      if (!prev) {
        if ((p.createdAtMs || 0) > loadedAt) announce("polls", "New poll", p.question);
      } else if (prev.open && !p.open) {
        announce("polls", "Poll closed — results available", p.question);
      }
      seen.poll.set(p.id, { open: !!p.open });
    }
    const box = $("lg-poll-body");
    box.innerHTML = list.length ? "" : `<p class="empty">No polls yet.</p>`;
    for (const p of list) box.appendChild(pollCard(p));
  }, () => {}));

function pollCard(p) {
  const voted = localStorage.getItem(votedKey(p.id));
  const total = (p.votes || []).reduce((s, n) => s + n, 0);
  const showResults = p.showResults !== "closed" || !p.open;
  const canVote = p.open && !voted;
  const div = document.createElement("div");
  div.className = "load-box";
  div.innerHTML = `<b>${esc(p.question)}</b>
    <small>${p.open ? (p.multi ? "Select all that apply" : "Select one") : "Closed"}${voted ? " · You voted ✓" : ""}${showResults ? ` · ${total} vote${total === 1 ? "" : "s"}` : ""}</small>
    <div class="logi-poll-opts">${(p.options || []).map((o, i) => {
      const n = (p.votes || [])[i] || 0;
      const pct = total ? Math.round(100 * n / total) : 0;
      return `<div class="logi-poll-opt">
        ${canVote ? `<label class="chk"><input type="${p.multi ? "checkbox" : "radio"}" name="pv-${p.id}" value="${i}"> ${esc(o)}</label>`
          : `<span>${esc(o)}</span>`}
        ${showResults ? `<div class="logi-poll-bar"><span style="width:${pct}%"></span></div><small>${n} (${pct}%)</small>` : ""}
      </div>`;
    }).join("")}</div>
    ${canVote ? `<button type="button" class="pv-submit">Vote</button>` : ""}
    ${!showResults && p.open ? `<small>Results will be revealed when the poll closes.</small>` : ""}`;
  div.querySelector(".pv-submit")?.addEventListener("click", async () => {
    const sel = [...div.querySelectorAll(`input[name="pv-${p.id}"]:checked`)].map((i) => Number(i.value));
    if (!sel.length) return alert("Please select an option.");
    const votes = (p.options || []).map((_, i) => ((p.votes || [])[i] || 0) + (sel.includes(i) ? 1 : 0));
    try {
      await updateDoc(doc(db, "logiPolls", p.id), { votes });
      localStorage.setItem(votedKey(p.id), "1");
    } catch (e) { alert("Vote failed: " + (e.message || e)); }
  });
  return div;
}

/* ── Q&A (1:1) + Group Chat — RTDB ── */
function wire() {
  if (!rtdb) return;
  // Q&A: 내 스레드만 구독.
  onValue(ref(rtdb, `logi/${courseId}/qna/${threadKey}`), (snap) => {
    const entries = Object.entries(snap.val() || {});
    for (const [mid, m] of entries) {
      if (!seen.qna.has(mid)) {
        if (m.from === "staff" && (m.atMs || 0) > loadedAt) announce("qna", "Reply from course staff", m.text);
        seen.qna.add(mid);
      }
    }
    const msgs = entries.map(([, m]) => m).sort((a, b) => a.atMs - b.atMs);
    const box = $("lg-qna-msgs");
    box.innerHTML = msgs.length ? "" : `<p class="empty">No messages yet — ask us anything about the course, venue, meals, or transportation.</p>`;
    for (const m of msgs) {
      const div = document.createElement("div");
      div.className = `logi-msg ${m.from}`;
      div.innerHTML = `<b>${m.from === "staff" ? "Staff" : "You"}</b> ${esc(m.text)}`;
      box.appendChild(div);
    }
    box.scrollTop = box.scrollHeight;
  });
  $("lg-qna-send").addEventListener("click", sendQna);
  $("lg-qna-input").addEventListener("keydown", (e) => { if (e.key === "Enter") sendQna(); });

  // Group chat.
  onValue(ref(rtdb, `logi/${courseId}/chat`), (snap) => {
    const entries = Object.entries(snap.val() || {});
    const myName = localStorage.getItem("logiName") || "";
    for (const [mid, m] of entries) {
      if (!seen.chat.has(mid)) {
        if ((m.atMs || 0) > loadedAt && m.name !== myName) announce("chat", `Chat — ${m.name}`, m.text);
        seen.chat.add(mid);
      }
    }
    const msgs = entries.map(([, m]) => m).sort((a, b) => a.atMs - b.atMs).slice(-150);
    const box = $("lg-chat-msgs");
    box.innerHTML = msgs.length ? "" : `<p class="empty">No messages yet — say hello! 👋</p>`;
    for (const m of msgs) {
      const div = document.createElement("div");
      div.className = "logi-msg";
      div.innerHTML = `<b>${esc(m.name)}</b> ${esc(m.text)}`;
      box.appendChild(div);
    }
    box.scrollTop = box.scrollHeight;
  });
  $("lg-chat-name").value = localStorage.getItem("logiName") || "";
  $("lg-chat-send").addEventListener("click", sendChat);
  $("lg-chat-input").addEventListener("keydown", (e) => { if (e.key === "Enter") sendChat(); });
}

async function sendQna() {
  const input = $("lg-qna-input");
  const text = input.value.trim().slice(0, 500);
  if (!text) return;
  input.value = "";
  try { await set(push(ref(rtdb, `logi/${courseId}/qna/${threadKey}`)), { from: "trainee", text, atMs: Date.now() }); }
  catch (e) { alert("Send failed: " + (e.message || e)); input.value = text; }
}

async function sendChat() {
  const name = $("lg-chat-name").value.trim().slice(0, 20);
  const input = $("lg-chat-input");
  const text = input.value.trim().slice(0, 500);
  if (!name) return alert("Please enter a display name (nickname).");
  if (!text) return;
  localStorage.setItem("logiName", name);
  input.value = "";
  try { await set(push(ref(rtdb, `logi/${courseId}/chat`)), { name, text, atMs: Date.now() }); }
  catch (e) { alert("Send failed: " + (e.message || e)); input.value = text; }
}

// 구독 시작 헬퍼(초기 로드 전 courseId 검증용).
function onSnapshotSafe(fn) { try { fn(); } catch { /* */ } }

/* ── 홈 화면 추가 (PWA-lite) ── */
let installPrompt = null;
window.addEventListener("beforeinstallprompt", (e) => {
  e.preventDefault();
  installPrompt = e;
  $("lg-a2hs").hidden = false;
});
const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream;
const isStandalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone;
if (isIos && !isStandalone) $("lg-a2hs").hidden = false;
$("lg-a2hs").addEventListener("click", async () => {
  if (installPrompt) {
    installPrompt.prompt();
    const r = await installPrompt.userChoice.catch(() => null);
    if (r?.outcome === "accepted") $("lg-a2hs").hidden = true;
    installPrompt = null;
  } else if (isIos) {
    $("lg-ios-guide").showModal();
  } else {
    alert("Use your browser menu → “Add to Home screen” / “Install app”.");
  }
});
$("lg-ios-close").addEventListener("click", () => $("lg-ios-guide").close());
window.addEventListener("appinstalled", () => { $("lg-a2hs").hidden = true; });

/* ── 알림(페이지·설치 앱이 열려 있을 때) + 탭 미확인 배지 ──
 * 완전한 푸시(앱 종료 상태)는 FCM이 필요해 미포함 — 열려 있는 동안
 * 새 공지·투표·운영진 답장·채팅을 브라우저 알림/배지로 표시한다. */
if ("Notification" in window && Notification.permission === "default") $("lg-notify").hidden = false;
$("lg-notify").addEventListener("click", async () => {
  const p = await Notification.requestPermission();
  if (p !== "default") $("lg-notify").hidden = true;
});

const loadedAt = Date.now();
const badges = { bulletins: 0, polls: 0, qna: 0, chat: 0 };
function notify(title, body) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try { new Notification(title, { body: String(body || "").slice(0, 120), icon: "icons/logi-192.png" }); } catch { /* */ }
}
// 활성 탭이 아니거나 화면이 백그라운드면 배지+알림, 활성 탭이면 조용히.
function announce(tab, title, body) {
  const inView = !document.hidden && activeTab === tab;
  if (inView) return;
  badges[tab]++;
  renderTabs();
  notify(title, body);
}
// 탭을 열면 해당 배지 해제.
function clearBadge(tab) { if (badges[tab]) { badges[tab] = 0; } }
