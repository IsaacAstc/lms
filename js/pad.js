// 수업 보드 — 참여자(공개) 페이지. 로그인 없음, 개인정보 미수집.
// 보드 설정(collabBoards)과 게시물(collabPosts)을 실시간 구독해 렌더링한다.
// 본인 글 판별은 기기 키(localStorage) 기반 — 작성한 기기에서만 수정·삭제 가능.
import {
  collection, doc, onSnapshot, addDoc, updateDoc, query, where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./firebase.js";

const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const boardId = new URLSearchParams(location.search).get("board") || "";
const root = $("pad-root");

// 기기 키: 본인 글 수정·삭제 판별용(무작위 문자열 — 개인정보 아님).
const DK_KEY = "padDeviceKey";
let deviceKey = localStorage.getItem(DK_KEY);
if (!deviceKey) {
  deviceKey = Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);
  localStorage.setItem(DK_KEY, deviceKey);
}
const nickKey = "padNick";

// 반응 중복 방지(기기당 게시물별 1회).
const reactedKey = (pid) => `padReact:${pid}`;

// 비속어 필터(간단 사전 — 완벽하지 않음, 승인제 병행 권장).
const BADWORDS = ["시발", "씨발", "씨팔", "병신", "지랄", "좆", "존나", "개새끼", "새끼", "니미", "미친놈", "미친년", "꺼져"];
function cleanText(t) {
  let s = String(t || "");
  for (const w of BADWORDS) s = s.split(w).join("●".repeat(w.length));
  return s;
}

const COLORS = ["#ffffff", "#fff3d6", "#e2f0ff", "#e5f7e5", "#fde7ef", "#efe7fd"];
let board = null;
let posts = [];
let editingPost = null; // 수정 모드일 때 대상

function fail(msg) { root.innerHTML = `<p class="empty">${esc(msg)}</p>`; }

if (!boardId) {
  fail("잘못된 접근입니다. 안내받은 보드 링크(QR)로 접속하세요.");
} else {
  onSnapshot(doc(db, "collabBoards", boardId), (snap) => {
    if (!snap.exists()) return fail("보드를 찾을 수 없습니다. 링크를 확인하세요.");
    board = { id: snap.id, ...snap.data() };
    $("pad-title").textContent = board.title || "수업 보드";
    document.title = board.title || "수업 보드";
    $("pad-desc").textContent = board.desc || "";
    $("pad-write-btn").hidden = board.active === false;
    if (board.active === false) fail("종료(보관)된 보드입니다.");
    else render();
  }, () => fail("보드를 불러오지 못했습니다."));

  // 보안규칙상 익명 조회는 공개(approved) 글만 가능 — 본인 승인 대기 글은 로컬 캐시로 표시.
  onSnapshot(query(collection(db, "collabPosts"),
    where("boardId", "==", boardId), where("approved", "==", true)), (snap) => {
    posts = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    render();
  }, () => {});
}

// 본인이 올린 승인 대기 글(승인 전까지 이 기기에서만 보임).
const mineKey = `padMine:${boardId}`;
function loadMine() {
  try { return JSON.parse(localStorage.getItem(mineKey)) || []; } catch { return []; }
}
function saveMine(list) { localStorage.setItem(mineKey, JSON.stringify(list.slice(-20))); }

function visiblePosts() {
  const serverIds = new Set(posts.map((p) => p.id));
  // 서버에 공개된 글 + 아직 승인 안 된 본인 글(로컬 캐시, 승인되면 서버 글로 대체).
  const mine = loadMine().filter((m) => !serverIds.has(m.id));
  if (mine.length !== loadMine().length) saveMine(mine);
  return [...posts, ...mine].filter((p) => !p.deleted);
}

function sortPosts(list) {
  if (board.reaction === "vote") {
    return list.sort((a, b) => (b.likes || 0) - (a.likes || 0) || (a.createdAtMs || 0) - (b.createdAtMs || 0));
  }
  return list.sort((a, b) => (a.createdAtMs || 0) - (b.createdAtMs || 0));
}

let lastList = [];
function render() {
  if (!board || board.active === false) return;
  const list = sortPosts(visiblePosts());
  lastList = list;
  if (board.layout === "shelf") {
    const cols = board.columns || [];
    root.innerHTML = `<div class="pad-shelf">${cols.map((c) => `
      <div class="pad-col">
        <div class="pad-col-head">${esc(c.name)} <span class="pad-col-cnt">${list.filter((p) => p.columnId === c.id).length}</span></div>
        <div class="pad-col-body">${list.filter((p) => p.columnId === c.id).map(cardHtml).join("") || ""}</div>
      </div>`).join("")}</div>`;
  } else {
    const cls = board.layout === "stream" ? "pad-stream" : "pad-wall";
    root.innerHTML = `<div class="${cls}">${list.map(cardHtml).join("") ||
      `<p class="empty">아직 게시물이 없습니다. 첫 글을 남겨보세요!</p>`}</div>`;
  }
  wireCards();
}

function linkCard(url) {
  let host = "";
  try { host = new URL(url).hostname; } catch { return ""; }
  const yt = url.match(/(?:youtu\.be\/|v=|shorts\/|embed\/)([\w-]{11})/);
  if (yt) return `<div class="pad-embed"><iframe src="https://www.youtube.com/embed/${yt[1]}?rel=0" allowfullscreen loading="lazy"></iframe></div>`;
  return `<a class="pad-link" href="${esc(url)}" target="_blank" rel="noopener nofollow">🔗 ${esc(host)}</a>`;
}

function cardHtml(p) {
  const mine = p.deviceKey === deviceKey;
  const rx = board.reaction;
  const reacted = localStorage.getItem(reactedKey(p.id));
  return `
    <article class="pad-card" data-id="${esc(p.id)}" style="background:${esc(p.color || "#ffffff")}">
      ${p.approved ? "" : `<div class="pad-pending">⏳ 승인 대기 — 본인에게만 보입니다</div>`}
      <h3 class="pad-card-title">${esc(p.title)}</h3>
      ${p.body ? `<p class="pad-card-body">${esc(p.body)}</p>` : ""}
      ${p.imageData ? `<img class="pad-card-img" src="${esc(p.imageData)}" alt="">` : ""}
      ${p.linkUrl ? linkCard(p.linkUrl) : ""}
      <div class="pad-card-foot">
        <span class="pad-nick">${p.nickname ? esc(p.nickname) : "익명"}</span>
        ${rx !== "none" ? `<button type="button" class="pad-react${reacted ? " on" : ""}" ${!p.approved ? "disabled" : ""}>
          ${rx === "vote" ? "👍" : "❤️"} ${p.likes || 0}</button>` : ""}
        ${mine ? `<button type="button" class="pad-mini pad-edit">수정</button>
                  <button type="button" class="pad-mini pad-del">삭제</button>` : ""}
      </div>
      ${board.comments ? `
        <div class="pad-comments">
          ${(p.comments || []).map((c) => `<div class="pad-comment"><b>${c.nickname ? esc(c.nickname) : "익명"}</b> ${esc(c.text)}</div>`).join("")}
          ${p.approved ? `<div class="pad-comment-form">
            <input type="text" class="pad-comment-input" maxlength="300" placeholder="댓글 입력 후 Enter">
          </div>` : ""}
        </div>` : ""}
    </article>`;
}

function wireCards() {
  root.querySelectorAll(".pad-card").forEach((card) => {
    const pid = card.dataset.id;
    const p = lastList.find((x) => x.id === pid);
    if (!p) return;
    card.querySelector(".pad-react")?.addEventListener("click", async (e) => {
      if (localStorage.getItem(reactedKey(pid))) return; // 기기당 1회
      try {
        await updateDoc(doc(db, "collabPosts", pid), { likes: (p.likes || 0) + 1 });
        localStorage.setItem(reactedKey(pid), "1");
      } catch { /* 동시 반영 충돌 시 다음 스냅샷에서 정리 */ }
    });
    card.querySelector(".pad-edit")?.addEventListener("click", () => openDialog(p));
    card.querySelector(".pad-del")?.addEventListener("click", async () => {
      if (!confirm("이 게시물을 삭제할까요?")) return;
      try { await updateDoc(doc(db, "collabPosts", pid), { deleted: true, deviceKey }); }
      catch (e) { alert("삭제하지 못했습니다: " + e.message); }
    });
    card.querySelector(".pad-comment-input")?.addEventListener("keydown", async (e) => {
      if (e.key !== "Enter") return;
      const text = cleanText(e.target.value.trim()).slice(0, 300);
      if (!text) return;
      e.target.disabled = true;
      try {
        const nick = board.authorMode === "nickname" ? (localStorage.getItem(nickKey) || "") : "";
        await updateDoc(doc(db, "collabPosts", pid), {
          comments: [...(p.comments || []), { text, nickname: nick.slice(0, 20), atMs: Date.now() }],
        });
      } catch (err) { alert("댓글을 남기지 못했습니다: " + err.message); e.target.disabled = false; }
    });
  });
}

/* ── 게시/수정 양식 ── */
const dlg = $("pad-dialog");
let imageData = "";

function buildColorPicker(cur) {
  $("pd-colors").innerHTML = COLORS.map((c) =>
    `<button type="button" class="pad-color${c === cur ? " sel" : ""}" data-c="${c}" style="background:${c}"></button>`).join("");
  $("pd-colors").querySelectorAll(".pad-color").forEach((b) => b.addEventListener("click", () => {
    $("pd-colors").querySelectorAll(".pad-color").forEach((x) => x.classList.remove("sel"));
    b.classList.add("sel");
  }));
}
const pickedColor = () => $("pd-colors").querySelector(".sel")?.dataset.c || "#ffffff";

function openDialog(post = null) {
  editingPost = post;
  imageData = post?.imageData || "";
  $("pd-heading").textContent = post ? "게시물 수정" : "게시물 작성";
  $("pd-save").textContent = post ? "수정 저장" : "게시";
  const colWrap = $("pd-col-wrap");
  if (board.layout === "shelf") {
    colWrap.hidden = false;
    $("pd-col").innerHTML = (board.columns || []).map((c) =>
      `<option value="${esc(c.id)}"${post?.columnId === c.id ? " selected" : ""}>${esc(c.name)}</option>`).join("");
  } else colWrap.hidden = true;
  $("pd-nick-wrap").hidden = board.authorMode !== "nickname";
  $("pd-title").value = post?.title || "";
  $("pd-body").value = post?.body || "";
  $("pd-nick").value = post?.nickname ?? (localStorage.getItem(nickKey) || "");
  $("pd-link").value = post?.linkUrl || "";
  $("pd-image").value = "";
  $("pd-image-prev").innerHTML = imageData ? `<img src="${esc(imageData)}" style="max-height:80px;border-radius:6px;">` : "";
  buildColorPicker(post?.color || "#ffffff");
  $("pd-status").textContent = "";
  $("pd-save").disabled = false;
  dlg.showModal();
}

$("pad-write-btn").addEventListener("click", () => openDialog());
$("pd-close").addEventListener("click", () => dlg.close());

// 이미지: 캔버스 압축 후 문서 내장(최대 900px JPEG — 대략 100~200KB).
$("pd-image").addEventListener("change", (e) => {
  const f = e.target.files[0];
  if (!f) return;
  const img = new Image();
  img.onload = () => {
    const scale = Math.min(1, 900 / Math.max(img.width, img.height));
    const cv = document.createElement("canvas");
    cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
    cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
    URL.revokeObjectURL(img.src);
    imageData = cv.toDataURL("image/jpeg", 0.8);
    if (imageData.length > 400000) { imageData = cv.toDataURL("image/jpeg", 0.55); }
    if (imageData.length > 400000) { imageData = ""; $("pd-status").textContent = "이미지가 너무 큽니다. 다른 이미지를 사용하세요."; return; }
    $("pd-image-prev").innerHTML = `<img src="${imageData}" style="max-height:80px;border-radius:6px;">`;
  };
  img.onerror = () => { $("pd-status").textContent = "이미지를 읽을 수 없습니다."; };
  img.src = URL.createObjectURL(f);
});

$("pd-save").addEventListener("click", async () => {
  const status = $("pd-status");
  const title = cleanText($("pd-title").value.trim()).slice(0, 100);
  if (!title) { status.textContent = "제목을 입력하세요."; return; }
  const body = cleanText($("pd-body").value.trim()).slice(0, 2000);
  const nickname = board.authorMode === "nickname" ? cleanText($("pd-nick").value.trim()).slice(0, 20) : "";
  if (board.authorMode === "nickname") localStorage.setItem(nickKey, nickname);
  const linkUrl = $("pd-link").value.trim().slice(0, 500);
  if (linkUrl && !/^https?:\/\//.test(linkUrl)) { status.textContent = "링크는 http(s)://로 시작해야 합니다."; return; }
  $("pd-save").disabled = true;
  status.textContent = "저장 중…";
  try {
    if (editingPost) {
      await updateDoc(doc(db, "collabPosts", editingPost.id), {
        title, body, nickname, linkUrl, imageData, color: pickedColor(),
        columnId: board.layout === "shelf" ? $("pd-col").value : "",
        deviceKey, updatedAtMs: Date.now(),
      });
    } else {
      const data = {
        boardId, columnId: board.layout === "shelf" ? $("pd-col").value : "",
        title, body, nickname, linkUrl, imageData, color: pickedColor(),
        deviceKey, likes: 0, comments: [],
        approved: !board.moderated, deleted: false, createdAtMs: Date.now(),
      };
      const ref = await addDoc(collection(db, "collabPosts"), data);
      if (board.moderated) { saveMine([...loadMine(), { ...data, id: ref.id }]); render(); }
    }
    status.textContent = editingPost ? "✅ 수정했습니다."
      : board.moderated ? "✅ 게시했습니다. 교수자 승인 후 모두에게 공개됩니다." : "✅ 게시했습니다!";
    setTimeout(() => dlg.close(), 900);
  } catch (e) {
    status.textContent = "저장 실패: " + (e.message || e);
    $("pd-save").disabled = false;
  }
});
