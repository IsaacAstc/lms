// 수업 보드(협업 게시판, 패들렛 벤치마킹) — 관리자 기능.
// collabBoards/{id}: 보드 설정(제목·레이아웃·칼럼·반응·댓글·승인제·작성자 표시·보관).
// collabPosts/{id}: 게시물(제목·본문·이미지 내장·링크·닉네임·기기키·승인·반응·댓글 배열).
// 참여는 공개 페이지 pad.html?board=<ID> (로그인 없음, 개인정보 미수집).
import {
  collection, addDoc, doc, updateDoc, deleteDoc, onSnapshot, getDocs, query, where, orderBy,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./firebase.js";
import { escapeHtml } from "./app.js";
import { orgQuery } from "./orgs.js";

const boardsCol = collection(db, "collabBoards");
let unsub = null;
let boards = [];
let editingId = null;
let pendingUnsub = null;

const LAYOUTS = { shelf: "셸프(칼럼)", wall: "담벼락", stream: "스트림" };
const REACTIONS = { like: "좋아요", vote: "투표", none: "없음" };

const padUrl = (id) => {
  const base = location.origin + location.pathname.replace(/[^/]*$/, "");
  const oq = orgQuery(false); // "&org=..." or ""
  return `${base}pad.html?board=${id}${oq}`;
};

export function initPadAdmin() {
  const form = document.getElementById("pad-form");
  form.addEventListener("submit", onSave);
  document.getElementById("pad-cancel").addEventListener("click", resetForm);
  document.getElementById("pad-qr-close").addEventListener("click", () => document.getElementById("pad-qr-dialog").close());
  // 셸프일 때만 칼럼 입력 노출.
  form.playout.addEventListener("change", () => {
    document.getElementById("pad-cols-wrap").hidden = form.playout.value !== "shelf";
  });

  unsub = onSnapshot(query(boardsCol, orderBy("createdAtMs", "desc")), (snap) => {
    boards = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderList();
  }, (err) => {
    document.getElementById("pad-tbody").innerHTML =
      `<tr><td colspan="6" class="empty">목록을 불러오지 못했습니다: ${escapeHtml(err.code || err.message)}<br>보안규칙(collabBoards) 배포 여부를 확인하세요.</td></tr>`;
  });
}

function readForm(form) {
  const layout = form.playout.value;
  const cols = layout === "shelf"
    ? form.pcols.value.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 10)
    : [];
  return {
    title: form.ptitle.value.trim(),
    desc: form.pdesc.value.trim(),
    layout,
    columns: cols.map((name, i) => ({ id: "c" + i, name })),
    reaction: form.preaction.value,
    comments: form.pcomments.checked,
    moderated: form.pmoderated.checked,
    authorMode: form.pauthor.value, // nickname | anon
    active: true,
    updatedAtMs: Date.now(),
  };
}

async function onSave(e) {
  e.preventDefault();
  const form = e.target;
  const data = readForm(form);
  if (!data.title) return alert("보드 제목을 입력하세요.");
  if (data.layout === "shelf" && !data.columns.length) return alert("셸프 형식은 칼럼을 1개 이상 입력하세요(쉼표 구분).");
  try {
    if (editingId) {
      await updateDoc(doc(db, "collabBoards", editingId), data);
    } else {
      await addDoc(boardsCol, { ...data, createdAtMs: Date.now() });
    }
    resetForm();
  } catch (err) { alert("저장 실패: " + err.message); }
}

function resetForm() {
  const form = document.getElementById("pad-form");
  form.reset();
  editingId = null;
  document.getElementById("pad-submit").textContent = "보드 만들기";
  document.getElementById("pad-cancel").hidden = true;
  document.getElementById("pad-cols-wrap").hidden = form.playout.value !== "shelf";
}

function settingsSummary(b) {
  return [
    LAYOUTS[b.layout] || b.layout,
    `반응:${REACTIONS[b.reaction] || b.reaction}`,
    b.comments ? "댓글" : null,
    b.moderated ? "승인제" : null,
    b.authorMode === "nickname" ? "닉네임" : "익명",
  ].filter(Boolean).join(" · ");
}

function renderList() {
  const tbody = document.getElementById("pad-tbody");
  if (!boards.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty">아직 보드가 없습니다. 위에서 첫 보드를 만들어 보세요.</td></tr>`;
    return;
  }
  tbody.innerHTML = "";
  for (const b of boards) {
    const tr = document.createElement("tr");
    if (b.active === false) tr.style.opacity = "0.55";
    tr.innerHTML = `
      <td>${escapeHtml(b.title)}${b.active === false ? " <small>(보관됨)</small>" : ""}</td>
      <td>${escapeHtml(settingsSummary(b))}</td>
      <td>${b.layout === "shelf" ? escapeHtml((b.columns || []).map((c) => c.name).join(", ")) : "-"}</td>
      <td class="actions">
        <a href="${escapeHtml(padUrl(b.id))}" target="_blank" rel="noopener" class="btn-link">열기</a>
        <button type="button" class="p-copy">URL 복사</button>
        <button type="button" class="p-qr">QR</button>
      </td>
      <td class="actions">
        <button type="button" class="p-mod">${b.moderated ? "승인 대기" : "게시물"}</button>
        <button type="button" class="p-csv">CSV</button>
      </td>
      <td class="actions">
        <button type="button" class="p-edit">수정</button>
        <button type="button" class="p-dup" title="설정·칼럼 복제(게시물 제외)">⧉</button>
        <button type="button" class="p-arch">${b.active === false ? "복원" : "보관"}</button>
        <button type="button" class="del p-del">삭제</button>
      </td>`;
    tr.querySelector(".p-copy").addEventListener("click", (e) => {
      navigator.clipboard?.writeText(padUrl(b.id));
      e.target.textContent = "복사됨";
      setTimeout(() => { e.target.textContent = "URL 복사"; }, 1500);
    });
    tr.querySelector(".p-edit").addEventListener("click", () => {
      const form = document.getElementById("pad-form");
      editingId = b.id;
      form.ptitle.value = b.title || "";
      form.pdesc.value = b.desc || "";
      form.playout.value = b.layout || "wall";
      form.pcols.value = (b.columns || []).map((c) => c.name).join(", ");
      form.preaction.value = b.reaction || "like";
      form.pcomments.checked = !!b.comments;
      form.pmoderated.checked = !!b.moderated;
      form.pauthor.value = b.authorMode || "nickname";
      document.getElementById("pad-cols-wrap").hidden = form.playout.value !== "shelf";
      document.getElementById("pad-submit").textContent = "수정 저장";
      document.getElementById("pad-cancel").hidden = false;
      form.scrollIntoView({ behavior: "smooth" });
    });
    tr.querySelector(".p-dup").addEventListener("click", async () => {
      try {
        const copy = { ...b, title: (b.title + " (사본)").slice(0, 60), active: true, createdAtMs: Date.now(), updatedAtMs: Date.now() };
        delete copy.id;
        await addDoc(boardsCol, copy);
        alert("보드를 복제했습니다(게시물 제외).");
      } catch (err) { alert("복제 실패: " + err.message); }
    });
    tr.querySelector(".p-arch").addEventListener("click", async () => {
      try { await updateDoc(doc(db, "collabBoards", b.id), { active: b.active === false, updatedAtMs: Date.now() }); }
      catch (err) { alert("변경 실패: " + err.message); }
    });
    tr.querySelector(".p-del").addEventListener("click", async () => {
      if (!confirm(`'${b.title}' 보드와 게시물 전체를 삭제할까요? 복구할 수 없습니다.`)) return;
      try {
        const posts = await getDocs(query(collection(db, "collabPosts"), where("boardId", "==", b.id)));
        for (const p of posts.docs) await deleteDoc(p.ref);
        await deleteDoc(doc(db, "collabBoards", b.id));
      } catch (err) { alert("삭제 실패: " + err.message); }
    });
    tr.querySelector(".p-qr").addEventListener("click", () => showQr(b));
    tr.querySelector(".p-mod").addEventListener("click", () => openPosts(b));
    tr.querySelector(".p-csv").addEventListener("click", () => exportCsv(b));
    tbody.appendChild(tr);
  }
}

// ── QR 표시 (qrcode 라이브러리는 최초 사용 시 지연 로드 — scfe와 공유) ──
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
  const url = padUrl(b.id);
  document.getElementById("pad-qr-title").textContent = b.title || "수업 보드";
  document.getElementById("pad-qr-url").textContent = url;
  const box = document.getElementById("pad-qr-box");
  box.innerHTML = "";
  new QRCode(box, { text: url, width: 220, height: 220, correctLevel: QRCode.CorrectLevel.M });
  document.getElementById("pad-qr-dialog").showModal();
}

// ── 게시물 관리(승인 대기 포함) ──
function openPosts(b) {
  const box = document.getElementById("pad-posts");
  document.getElementById("pad-posts-title").textContent =
    `'${b.title}' 게시물 관리${b.moderated ? " — 승인제 보드" : ""}`;
  box.hidden = false;
  if (pendingUnsub) pendingUnsub();
  pendingUnsub = onSnapshot(query(collection(db, "collabPosts"), where("boardId", "==", b.id)), (snap) => {
    const posts = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .filter((p) => !p.deleted)
      .sort((a, c) => (a.approved === c.approved ? (c.createdAtMs || 0) - (a.createdAtMs || 0) : (a.approved ? 1 : -1)));
    const tbody = document.getElementById("pad-posts-body");
    if (!posts.length) { tbody.innerHTML = `<tr><td colspan="5" class="empty">게시물이 없습니다.</td></tr>`; return; }
    tbody.innerHTML = "";
    for (const p of posts) {
      const col = b.layout === "shelf" ? ((b.columns || []).find((c) => c.id === p.columnId)?.name || "-") : "-";
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${p.approved ? "공개" : "<b>승인 대기</b>"}</td>
        <td>${escapeHtml(col)}</td>
        <td>${escapeHtml(p.title || "")}${p.nickname ? ` <small>(${escapeHtml(p.nickname)})</small>` : ""}</td>
        <td>${escapeHtml((p.body || "").slice(0, 60))}${(p.body || "").length > 60 ? "…" : ""}</td>
        <td class="actions">
          ${p.approved ? "" : `<button type="button" class="pp-ok">승인</button>`}
          <button type="button" class="del pp-del">삭제</button>
        </td>`;
      tr.querySelector(".pp-ok")?.addEventListener("click", async () => {
        try { await updateDoc(doc(db, "collabPosts", p.id), { approved: true }); }
        catch (err) { alert("승인 실패: " + err.message); }
      });
      tr.querySelector(".pp-del").addEventListener("click", async () => {
        if (!confirm("이 게시물을 삭제할까요?")) return;
        try { await deleteDoc(doc(db, "collabPosts", p.id)); }
        catch (err) { alert("삭제 실패: " + err.message); }
      });
      tbody.appendChild(tr);
    }
  });
}

// ── CSV 내보내기 (게시물 + 댓글 수 + 반응 수) ──
async function exportCsv(b) {
  try {
    const snap = await getDocs(query(collection(db, "collabPosts"), where("boardId", "==", b.id)));
    const posts = snap.docs.map((d) => d.data()).filter((p) => !p.deleted)
      .sort((a, c) => (a.createdAtMs || 0) - (c.createdAtMs || 0));
    const q2 = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const colName = (p) => b.layout === "shelf" ? ((b.columns || []).find((c) => c.id === p.columnId)?.name || "") : "";
    const when = (ms) => ms ? new Intl.DateTimeFormat("ko-KR", { dateStyle: "short", timeStyle: "short" }).format(new Date(ms)) : "";
    const lines = [
      ["보드", b.title, "형식", LAYOUTS[b.layout] || b.layout, "게시물", posts.length].map(q2).join(","),
      "",
      ["작성일시", "칼럼", "닉네임", "제목", "본문", "링크", "반응수", "댓글수", "상태"].map(q2).join(","),
      ...posts.map((p) => [
        when(p.createdAtMs), colName(p), p.nickname || "", p.title || "", p.body || "",
        p.linkUrl || "", p.likes || 0, (p.comments || []).length, p.approved ? "공개" : "승인대기",
      ].map(q2).join(",")),
      "",
      [q2("댓글 상세")].join(","),
      ["게시물 제목", "댓글", "닉네임", "일시"].map(q2).join(","),
      ...posts.flatMap((p) => (p.comments || []).map((c) =>
        [p.title || "", c.text || "", c.nickname || "", when(c.atMs)].map(q2).join(","))),
    ];
    const blob = new Blob(["﻿" + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `수업보드_${(b.title || "무제").replace(/[\\/:*?"<>|\s]+/g, "_")}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (err) { alert("내보내기 실패: " + err.message); }
}
