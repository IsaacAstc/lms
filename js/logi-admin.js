// ICAO 로지보드(국제과정 참가자 포털) — 관리자 기능.
// logiBoards/{차수ID}: 보드 설정 + 시간표 스냅샷(강사명 제외, 공개 읽기).
// logiBulletins/{id}: 공지(영문). logiPolls/{id}: 투표. 메신저(Q&A·채팅)는 RTDB(logi/{차수ID}).
// 보존: 자동 파기 없음 — 관리자가 보드 삭제 시 공지·투표·메시지를 함께 삭제한다.
import {
  collection, addDoc, doc, setDoc, updateDoc, deleteDoc, getDoc, getDocs,
  onSnapshot, query, where, orderBy,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  getDatabase, ref, onValue, push, remove, set,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";
import { db, app } from "./firebase.js";
import { escapeHtml } from "./app.js";
import { orgQuery } from "./orgs.js";

let rtdb = null;
try { rtdb = getDatabase(app); } catch { /* databaseURL 미설정 — 메신저만 비활성 */ }

let boards = [];
let currentBoard = null; // 상세 관리 중인 보드
const unsubs = { boards: null, bulletins: null, polls: null, qna: null, chat: null };

const logiUrl = (id) => {
  const base = location.origin + location.pathname.replace(/[^/]*$/, "");
  return `${base}logi.html?course=${id}${orgQuery(false)}`;
};
const esc = escapeHtml;
const fmtWhen = (ms) => ms ? new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "short" }).format(new Date(ms)) : "";

export function initLogiAdmin() {
  document.getElementById("logi-activate").addEventListener("click", activateBoard);
  document.getElementById("logi-bul-add").addEventListener("click", addBulletin);
  document.getElementById("logi-poll-add").addEventListener("click", addPoll);
  document.getElementById("logi-qna-send").addEventListener("click", sendQnaReply);
  document.getElementById("logi-period-save").addEventListener("click", savePeriod);
  document.getElementById("logi-qr-close").addEventListener("click", () => document.getElementById("logi-qr-dialog").close());
  document.addEventListener("tabshown", (e) => { if (e.detail === "logi") loadCourseOptions(); });

  unsubs.boards = onSnapshot(collection(db, "logiBoards"), (snap) => {
    boards = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
    renderBoards();
  }, (err) => {
    document.getElementById("logi-tbody").innerHTML =
      `<tr><td colspan="5" class="empty">목록 실패: ${esc(err.code || err.message)} — 보안규칙(logiBoards) 배포 확인</td></tr>`;
  });
}

// 활성화 대상 차수 선택지(아직 로지보드가 없는 차수).
async function loadCourseOptions() {
  const sel = document.getElementById("logi-course");
  try {
    const snap = await getDocs(collection(db, "courses"));
    const existing = new Set(boards.map((b) => b.id));
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .filter((c) => !existing.has(c.id))
      .sort((a, b) => (b.startDate || "").localeCompare(a.startDate || ""));
    sel.innerHTML = `<option value="">차수 선택</option>` + list.map((c) =>
      `<option value="${esc(c.id)}">${esc(c.name)}${c.round ? ` ${c.round}차수` : ""} (${esc(c.startDate || "")})</option>`).join("");
  } catch { /* */ }
}

// 시간표 스냅샷(강사명 제외 — 공개 페이지에 개인정보 미노출).
async function scheduleSnapshot(courseId) {
  const snap = await getDocs(query(collection(db, "sessions"), where("courseId", "==", courseId)));
  return snap.docs.map((d) => d.data())
    .map((s) => ({ date: s.date || "", subject: s.subject || "", startTime: s.startTime || "", endTime: s.endTime || "", room: s.room || "" }))
    .sort((a, b) => a.date.localeCompare(b.date) || a.startTime.localeCompare(b.startTime));
}

async function activateBoard() {
  const courseId = document.getElementById("logi-course").value;
  if (!courseId) return alert("차수를 선택하세요.");
  const titleEn = document.getElementById("logi-title-en").value.trim();
  if (!titleEn) return alert("영문 과정명을 입력하세요.");
  try {
    const cSnap = await getDoc(doc(db, "courses", courseId));
    const c = cSnap.exists() ? cSnap.data() : {};
    const schedule = await scheduleSnapshot(courseId);
    await setDoc(doc(db, "logiBoards", courseId), {
      titleEn,
      welcome: document.getElementById("logi-welcome").value.trim(),
      startDate: c.startDate || "", endDate: c.endDate || "", venue: c.venue || "",
      showSchedule: document.getElementById("logi-opt-schedule").checked,
      qnaEnabled: document.getElementById("logi-opt-qna").checked,
      chatEnabled: document.getElementById("logi-opt-chat").checked,
      active: true, schedule,
      createdAtMs: Date.now(), updatedAtMs: Date.now(),
    });
    document.getElementById("logi-title-en").value = "";
    document.getElementById("logi-welcome").value = "";
    loadCourseOptions();
    alert(`로지보드를 활성화했습니다. (시간표 ${schedule.length}건 동기화)`);
  } catch (e) { alert("활성화 실패: " + e.message); }
}

function renderBoards() {
  const tbody = document.getElementById("logi-tbody");
  if (!boards.length) { tbody.innerHTML = `<tr><td colspan="5" class="empty">활성화된 로지보드가 없습니다.</td></tr>`; return; }
  tbody.innerHTML = "";
  for (const b of boards) {
    const tr = document.createElement("tr");
    if (b.active === false) tr.style.opacity = "0.55";
    tr.innerHTML = `
      <td>${esc(b.titleEn)}${b.active === false ? " <small>(닫힘)</small>" : ""}</td>
      <td>${esc(b.startDate || "")} ~ ${esc(b.endDate || "")}</td>
      <td>${[b.showSchedule && "일정", "공지", "투표", b.qnaEnabled && "Q&A", b.chatEnabled && "채팅"].filter(Boolean).join("·")}</td>
      <td class="actions">
        <a href="${esc(logiUrl(b.id))}" target="_blank" rel="noopener" class="btn-link">열기</a>
        <button type="button" class="l-copy">URL 복사</button>
        <button type="button" class="l-qr">QR</button>
      </td>
      <td class="actions">
        <button type="button" class="l-manage">관리</button>
        <button type="button" class="l-sync" title="차수 시간표를 다시 복사">시간표 재동기화</button>
        <button type="button" class="l-close">${b.active === false ? "다시 열기" : "닫기"}</button>
        <button type="button" class="del l-del">삭제</button>
      </td>`;
    tr.querySelector(".l-copy").addEventListener("click", (e) => {
      navigator.clipboard?.writeText(logiUrl(b.id));
      e.target.textContent = "복사됨";
      setTimeout(() => { e.target.textContent = "URL 복사"; }, 1500);
    });
    tr.querySelector(".l-sync").addEventListener("click", async () => {
      try {
        const schedule = await scheduleSnapshot(b.id);
        await updateDoc(doc(db, "logiBoards", b.id), { schedule, updatedAtMs: Date.now() });
        alert(`시간표 ${schedule.length}건을 재동기화했습니다.`);
      } catch (e) { alert("재동기화 실패: " + e.message); }
    });
    tr.querySelector(".l-close").addEventListener("click", async () => {
      try { await updateDoc(doc(db, "logiBoards", b.id), { active: b.active === false, updatedAtMs: Date.now() }); }
      catch (e) { alert("변경 실패: " + e.message); }
    });
    tr.querySelector(".l-del").addEventListener("click", async () => {
      if (!confirm(`'${b.titleEn}' 로지보드와 공지·투표·메시지 전체를 삭제할까요? 복구할 수 없습니다.`)) return;
      try {
        for (const col of ["logiBulletins", "logiPolls"]) {
          const s = await getDocs(query(collection(db, col), where("courseId", "==", b.id)));
          for (const d of s.docs) await deleteDoc(d.ref);
        }
        if (rtdb) await remove(ref(rtdb, `logi/${b.id}`)).catch(() => {});
        await deleteDoc(doc(db, "logiBoards", b.id));
        if (currentBoard?.id === b.id) closeManage();
      } catch (e) { alert("삭제 실패: " + e.message); }
    });
    tr.querySelector(".l-qr").addEventListener("click", () => showQr(b));
    tr.querySelector(".l-manage").addEventListener("click", () => openManage(b));
    tbody.appendChild(tr);
  }
}

// ── QR 표시 (라이브러리는 최초 사용 시 지연 로드 — scfe·수업보드와 공유) ──
let qrLibLoading = null;
function loadQrLib() {
  if (typeof QRCode !== "undefined") return Promise.resolve();
  if (!qrLibLoading) {
    qrLibLoading = new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "scfe/js/qrcode.min.js";
      s.onload = resolve;
      s.onerror = () => reject(new Error("QR 라이브러리를 불러오지 못했습니다."));
      document.head.appendChild(s);
    });
  }
  return qrLibLoading;
}
async function showQr(b) {
  try { await loadQrLib(); } catch (e) { return alert(e.message); }
  const url = logiUrl(b.id);
  document.getElementById("logi-qr-title").textContent = b.titleEn || "Logiboard";
  document.getElementById("logi-qr-url").textContent = url;
  const box = document.getElementById("logi-qr-box");
  box.innerHTML = "";
  new QRCode(box, { text: url, width: 220, height: 220, correctLevel: QRCode.CorrectLevel.M });
  document.getElementById("logi-qr-dialog").showModal();
}

function closeManage() {
  currentBoard = null;
  document.getElementById("logi-manage").hidden = true;
  ["bulletins", "polls", "qna", "chat"].forEach((k) => { if (unsubs[k]) { unsubs[k](); unsubs[k] = null; } });
}

function openManage(b) {
  currentBoard = b;
  document.getElementById("logi-manage").hidden = false;
  document.getElementById("logi-manage-title").textContent = `'${b.titleEn}' 관리`;
  document.getElementById("logi-period-start").value = b.startDate || "";
  document.getElementById("logi-period-end").value = b.endDate || "";
  document.getElementById("logi-manage").scrollIntoView({ behavior: "smooth" });

  // 공지 목록
  if (unsubs.bulletins) unsubs.bulletins();
  unsubs.bulletins = onSnapshot(query(collection(db, "logiBulletins"), where("courseId", "==", b.id)), (snap) => {
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((x, y) => (y.pinned - x.pinned) || (y.createdAtMs || 0) - (x.createdAtMs || 0));
    const tbody = document.getElementById("logi-bul-body");
    tbody.innerHTML = list.length ? "" : `<tr><td colspan="4" class="empty">공지가 없습니다.</td></tr>`;
    for (const bl of list) {
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${bl.pinned ? "📌" : ""}</td><td>${esc(bl.title)}</td><td>${fmtWhen(bl.createdAtMs)}</td>
        <td class="actions"><button type="button" class="b-pin">${bl.pinned ? "고정해제" : "고정"}</button>
        <button type="button" class="del b-del">삭제</button></td>`;
      tr.querySelector(".b-pin").addEventListener("click", () =>
        updateDoc(doc(db, "logiBulletins", bl.id), { pinned: !bl.pinned }).catch((e) => alert(e.message)));
      tr.querySelector(".b-del").addEventListener("click", () => {
        if (confirm("이 공지를 삭제할까요?")) deleteDoc(doc(db, "logiBulletins", bl.id)).catch((e) => alert(e.message));
      });
      tbody.appendChild(tr);
    }
  });

  // 투표 목록
  if (unsubs.polls) unsubs.polls();
  unsubs.polls = onSnapshot(query(collection(db, "logiPolls"), where("courseId", "==", b.id)), (snap) => {
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((x, y) => (y.createdAtMs || 0) - (x.createdAtMs || 0));
    const box = document.getElementById("logi-poll-list");
    box.innerHTML = list.length ? "" : `<p class="empty">투표가 없습니다.</p>`;
    for (const p of list) {
      const total = (p.votes || []).reduce((s, n) => s + n, 0);
      const rows = (p.options || []).map((o, i) => {
        const n = (p.votes || [])[i] || 0;
        const pct = total ? Math.round(100 * n / total) : 0;
        return `<div class="logi-poll-row"><span>${esc(o)}</span><b>${n}표 (${pct}%)</b></div>`;
      }).join("");
      const div = document.createElement("div");
      div.className = "load-box";
      div.innerHTML = `<b>${esc(p.question)}</b> <small>${p.open ? "진행 중" : "마감"} · ${total}표 · 결과 ${p.showResults === "closed" ? "마감 후 공개" : "실시간 공개"}</small>
        ${rows}
        <div class="form-actions">
          <button type="button" class="q-toggle">${p.open ? "마감" : "다시 열기"}</button>
          <button type="button" class="del q-del">삭제</button>
        </div>`;
      div.querySelector(".q-toggle").addEventListener("click", () =>
        updateDoc(doc(db, "logiPolls", p.id), { open: !p.open }).catch((e) => alert(e.message)));
      div.querySelector(".q-del").addEventListener("click", () => {
        if (confirm("이 투표를 삭제할까요?")) deleteDoc(doc(db, "logiPolls", p.id)).catch((e) => alert(e.message));
      });
      box.appendChild(div);
    }
  });

  // Q&A 수신함 + 채팅 모니터 (RTDB)
  const qnaBox = document.getElementById("logi-qna-threads");
  const chatBox = document.getElementById("logi-chat-list");
  if (!rtdb) {
    qnaBox.innerHTML = chatBox.innerHTML = `<p class="empty">Realtime Database 미설정 — 메신저 비활성</p>`;
    return;
  }
  if (unsubs.qna) unsubs.qna();
  const qnaRef = ref(rtdb, `logi/${b.id}/qna`);
  const onQna = onValue(qnaRef, (snap) => {
    const threads = snap.val() || {};
    const ids = Object.keys(threads);
    qnaBox.innerHTML = ids.length ? "" : `<p class="empty">문의 스레드가 없습니다.</p>`;
    ids.map((tid) => {
      const msgs = Object.entries(threads[tid] || {}).map(([mid, m]) => ({ mid, ...m })).sort((a, c) => a.atMs - c.atMs);
      return { tid, msgs, last: msgs[msgs.length - 1] };
    }).sort((a, c) => (c.last?.atMs || 0) - (a.last?.atMs || 0)).forEach((t) => {
      const div = document.createElement("div");
      div.className = "load-box";
      const needReply = t.last?.from === "trainee";
      div.innerHTML = `<b>${needReply ? "🔴 " : ""}스레드 ${esc(t.tid.slice(0, 6))}…</b> <small>${fmtWhen(t.last?.atMs)}</small>
        <div class="logi-msgs">${t.msgs.slice(-20).map((m) =>
          `<div class="logi-msg ${m.from}"><b>${m.from === "staff" ? "Staff" : "Trainee"}</b> ${esc(m.text)}${m.edited ? ` <small class="logi-edited">(수정됨)</small>` : ""}</div>`).join("")}</div>
        <button type="button" class="t-reply">답장</button>`;
      div.querySelector(".t-reply").addEventListener("click", () => {
        document.getElementById("logi-qna-target").value = t.tid;
        document.getElementById("logi-qna-target-label").textContent = `→ 스레드 ${t.tid.slice(0, 6)}…`;
        document.getElementById("logi-qna-text").focus();
      });
      qnaBox.appendChild(div);
    });
  });
  unsubs.qna = () => onQna();

  if (unsubs.chat) unsubs.chat();
  const chatRef = ref(rtdb, `logi/${b.id}/chat`);
  const onChat = onValue(chatRef, (snap) => {
    const msgs = Object.entries(snap.val() || {}).map(([mid, m]) => ({ mid, ...m })).sort((a, c) => a.atMs - c.atMs).slice(-100);
    chatBox.innerHTML = msgs.length ? "" : `<p class="empty">채팅 메시지가 없습니다.</p>`;
    for (const m of msgs) {
      const div = document.createElement("div");
      div.className = "logi-msg";
      div.innerHTML = `<b>${esc(m.name)}</b> ${esc(m.text)}${m.edited ? ` <small class="logi-edited">(수정됨)</small>` : ""} <small>${fmtWhen(m.atMs)}</small>
        <button type="button" class="pad-mini c-del">삭제</button>`;
      div.querySelector(".c-del").addEventListener("click", () => {
        if (confirm("이 메시지를 삭제할까요?")) remove(ref(rtdb, `logi/${b.id}/chat/${m.mid}`)).catch((e) => alert(e.message));
      });
      chatBox.appendChild(div);
    }
    chatBox.scrollTop = chatBox.scrollHeight;
  });
  unsubs.chat = () => onChat();
}

async function addBulletin() {
  if (!currentBoard) return;
  const title = document.getElementById("logi-bul-title").value.trim();
  const body = document.getElementById("logi-bul-text").value.trim();
  if (!title) return alert("공지 제목(영문)을 입력하세요.");
  try {
    await addDoc(collection(db, "logiBulletins"), {
      courseId: currentBoard.id, title, body,
      linkUrl: document.getElementById("logi-bul-link").value.trim(),
      pinned: document.getElementById("logi-bul-pin").checked,
      createdAtMs: Date.now(),
    });
    ["logi-bul-title", "logi-bul-text", "logi-bul-link"].forEach((id) => { document.getElementById(id).value = ""; });
    document.getElementById("logi-bul-pin").checked = false;
  } catch (e) { alert("공지 등록 실패: " + e.message); }
}

async function addPoll() {
  if (!currentBoard) return;
  const question = document.getElementById("logi-poll-q").value.trim();
  const options = document.getElementById("logi-poll-opts").value.split("\n").map((s) => s.trim()).filter(Boolean).slice(0, 8);
  if (!question) return alert("질문(영문)을 입력하세요.");
  if (options.length < 2) return alert("보기를 2개 이상 입력하세요(줄바꿈 구분).");
  try {
    await addDoc(collection(db, "logiPolls"), {
      courseId: currentBoard.id, question, options,
      votes: options.map(() => 0),
      multi: document.getElementById("logi-poll-multi").checked,
      showResults: document.getElementById("logi-poll-results").value, // always | closed
      open: true, createdAtMs: Date.now(),
    });
    document.getElementById("logi-poll-q").value = "";
    document.getElementById("logi-poll-opts").value = "";
  } catch (e) { alert("투표 등록 실패: " + e.message); }
}

// 운영기간 수정: 교육기간 전후로도 보드를 운영하는 경우가 많아 차수와 독립적으로 조정한다.
async function savePeriod() {
  if (!currentBoard) return;
  const startDate = document.getElementById("logi-period-start").value;
  const endDate = document.getElementById("logi-period-end").value;
  if (!startDate || !endDate) return alert("시작·종료일을 모두 입력하세요.");
  if (endDate < startDate) return alert("종료일이 시작일보다 빠릅니다.");
  try {
    await updateDoc(doc(db, "logiBoards", currentBoard.id), { startDate, endDate, updatedAtMs: Date.now() });
    currentBoard = { ...currentBoard, startDate, endDate };
    alert("운영기간을 저장했습니다.");
  } catch (e) { alert("저장 실패: " + e.message); }
}

async function sendQnaReply() {
  if (!currentBoard || !rtdb) return;
  const tid = document.getElementById("logi-qna-target").value;
  const text = document.getElementById("logi-qna-text").value.trim().slice(0, 500);
  if (!tid) return alert("답장할 스레드를 먼저 선택하세요(스레드의 '답장' 버튼).");
  if (!text) return alert("답장 내용을 입력하세요.");
  try {
    await set(push(ref(rtdb, `logi/${currentBoard.id}/qna/${tid}`)), { from: "staff", text, atMs: Date.now() });
    document.getElementById("logi-qna-text").value = "";
  } catch (e) { alert("발송 실패: " + e.message); }
}
