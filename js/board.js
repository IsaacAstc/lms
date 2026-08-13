// 공개 현황 보드(외부 열람 전용). publicBoard 컬렉션을 실시간 구독해 과정별 신청 현황 표시.
// 개인정보 없음 — 수치·일정만. 실제 신청 접수는 시스템 범위 밖(안내 텍스트로 설명).
import {
  collection, doc, onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { db, app } from "./firebase.js";

// 온라인 신청 활성 여부(관리자가 접수 이메일을 설정하면 __config.applyEnabled=true).
let applyEnabled = false;
const fns = getFunctions(app, "asia-northeast3");

const root = document.getElementById("board-root");
let items = [];

function esc(v) {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
const dot = (s) => String(s ?? "").replace(/(\d{4})-(\d{2})-(\d{2})/g, "$1.$2.$3");
function todayStr() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
}
// 기본 조회 범위 종료일: 다음 달 말일(KST 기준).
function endOfNextMonthStr() {
  const [y, m] = todayStr().split("-").map(Number); // m은 1~12
  // (m+1)월의 0일 = 다음 달(m+1)의 말일. UTC로 계산해 시간대 흔들림 방지.
  const d = new Date(Date.UTC(y, m + 1, 0));
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

function applyDefaultRange() {
  document.getElementById("board-from").value = todayStr();
  document.getElementById("board-to").value = endOfNextMonthStr();
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

  const isDefault = ranged && from === todayStr() && to === endOfNextMonthStr();
  note.textContent = ranged
    ? `${dot(from) || "처음"} - ${dot(to) || "끝"}${isDefault ? " (기본: 다음 달 말일까지)" : ""} · ${list.length}건`
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
  const period = c.startDate ? `${esc(dot(c.startDate))}${c.endDate && c.endDate !== c.startDate ? " - " + esc(dot(c.endDate)) : ""}` : "-";
  return `
    <article class="board-card${full ? " full" : ""}">
      <div class="board-card-head">
        <span class="board-badge">${esc(c.courseType || "과정")}</span>
        <h3>${c.planned ? `<span class="board-planned">(예정)</span> ` : ""}${esc(c.name || "")}${c.round ? ` <small>${esc(String(c.round))}차수</small>` : ""}</h3>
      </div>
      <dl class="board-meta">
        <div><dt>교육기간</dt><dd>${period}</dd></div>
        <div><dt>교육장</dt><dd>${esc(c.venue || "-")}</dd></div>
        <div><dt>정원</dt><dd>${cap || "-"}</dd></div>
        <div><dt>신청</dt><dd>${applied}</dd></div>
        <div><dt>잔여</dt><dd class="${full ? "board-full" : "board-open"}">${full ? "마감" : remaining}</dd></div>
      </dl>
      <div class="board-bar"><span style="width:${pct}%"></span></div>
      ${applyEnabled ? `<div class="board-actions no-print">
        ${!full ? `<button type="button" class="board-apply-btn" data-id="${esc(c.id)}" data-kind="apply">신청</button>` : ""}
        <button type="button" class="board-apply-btn ghost" data-id="${esc(c.id)}" data-kind="cancel">신청 취소</button>
      </div>` : ""}
    </article>`;
}

// ── 온라인 신청/취소 양식 ──
const dlg = document.getElementById("apply-dialog");
let current = null; // { id, kind, course }

function openDialog(id, kind) {
  const c = items.find((x) => x.id === id);
  if (!c) return;
  current = { id, kind, course: c };
  const apply = kind === "apply";
  document.getElementById("apply-title").textContent = apply ? "교육 신청" : "신청 취소";
  document.getElementById("apply-course").textContent =
    `${c.name || ""}${c.round ? ` ${c.round}차수` : ""} · ${dot(c.startDate || "")}${c.endDate && c.endDate !== c.startDate ? " - " + dot(c.endDate) : ""}`;
  document.getElementById("apply-fields-apply").hidden = !apply;
  document.getElementById("apply-fields-cancel").hidden = apply;
  if (apply) {
    const remaining = c.remaining != null ? c.remaining : Math.max(0, (c.capacity || 0) - (c.appliedCount || 0));
    const maxN = Math.max(1, Math.min(20, remaining || 20));
    document.getElementById("apply-count").innerHTML =
      Array.from({ length: maxN }, (_, i) => `<option value="${i + 1}">${i + 1}명</option>`).join("");
  }
  document.getElementById("apply-file").value = "";
  document.getElementById("apply-extra-files").innerHTML = "";
  document.getElementById("apply-receipt").value = "";
  document.getElementById("apply-subject").value = "";
  document.getElementById("apply-body").value = "";
  document.getElementById("apply-status").textContent = "";
  const sendBtn = document.getElementById("apply-send");
  sendBtn.disabled = false;
  sendBtn.hidden = false;
  dlg.showModal();
}

function readFileBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => reject(new Error("파일을 읽지 못했습니다."));
    r.readAsDataURL(file);
  });
}

async function send() {
  if (!current) return;
  const status = document.getElementById("apply-status");
  const btn = document.getElementById("apply-send");
  const email = document.getElementById("apply-email").value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { status.textContent = "이메일 주소를 확인하세요."; return; }

  const payload = {
    kind: current.kind,
    courseId: current.id,
    email,
    title: document.getElementById("apply-subject").value.trim(),
    body: document.getElementById("apply-body").value.trim(),
  };
  if (current.kind === "apply") {
    payload.count = Number(document.getElementById("apply-count").value);
  } else {
    payload.receiptCode = document.getElementById("apply-receipt").value.trim();
    if (!payload.receiptCode) { status.textContent = "접수번호를 입력하세요."; return; }
  }

  // 첨부: 공문(필수) + 기타 첨부(선택, 추가 버튼) — 파일당 5MB, 전체 8MB 제한.
  const files = [document.getElementById("apply-file").files[0]];
  document.querySelectorAll("#apply-extra-files input[type=file]").forEach((inp) => {
    if (inp.files[0]) files.push(inp.files[0]);
  });
  if (!files[0]) { status.textContent = "공문 파일을 첨부하세요(필수)."; return; }
  let total = 0;
  for (const f of files) {
    if (f.size > 5 * 1024 * 1024) { status.textContent = `첨부파일은 파일당 5MB 이하만 가능합니다. (${f.name})`; return; }
    total += f.size;
  }
  if (total > 8 * 1024 * 1024) { status.textContent = "첨부파일 전체 합계는 8MB 이하만 가능합니다."; return; }
  status.textContent = "첨부파일 처리 중…";
  payload.attachments = [];
  for (const f of files) {
    const data = await readFileBase64(f).catch(() => null);
    if (!data) { status.textContent = `첨부파일을 읽지 못했습니다. (${f.name})`; return; }
    payload.attachments.push({ name: f.name, dataBase64: data });
  }

  btn.disabled = true;
  status.textContent = "발송 중… (잠시 기다려 주세요)";
  try {
    const res = await httpsCallable(fns, "submitApplication")(payload);
    const r = res.data || {};
    if (current.kind === "apply") {
      status.innerHTML = `✅ 접수 완료! <b>접수번호: ${esc(r.receiptCode || "")}</b><br>` +
        `확인 메일을 발송했습니다. 접수번호는 취소 시 필요하니 보관하세요.`;
    } else {
      status.textContent = r.mailFailed
        ? "✅ 취소 처리되었습니다. (확인 메일 발송은 실패 — 잔여석은 복구됨)"
        : "✅ 취소 완료. 확인 메일을 발송했으며 잔여석이 복구되었습니다.";
    }
    btn.hidden = true; // 완료 후엔 닫기만 — 중복 발송 방지
  } catch (e) {
    status.textContent = "❌ " + (e.message || "처리에 실패했습니다. 잠시 후 다시 시도하세요.");
    btn.disabled = false;
  }
}

root.addEventListener("click", (e) => {
  const b = e.target.closest(".board-apply-btn");
  if (b) openDialog(b.dataset.id, b.dataset.kind);
});
document.getElementById("apply-send").addEventListener("click", send);
document.getElementById("apply-close").addEventListener("click", () => dlg.close());
document.getElementById("apply-add-file").addEventListener("click", () => {
  const box = document.getElementById("apply-extra-files");
  if (box.querySelectorAll("input[type=file]").length >= 4) { alert("기타 첨부는 최대 4개까지 가능합니다."); return; }
  const label = document.createElement("label");
  label.innerHTML = `기타 첨부 <small>(5MB 이하)</small>`;
  const inp = document.createElement("input");
  inp.type = "file";
  label.appendChild(inp);
  box.appendChild(label);
});

function main() {
  applyDefaultRange(); // 최초 조회는 오늘 ~ 다음 달 말일.

  // 신청 안내 텍스트(__config 문서) 구독.
  onSnapshot(doc(db, "publicBoard", "__config"), (snap) => {
    const cfg = snap.exists() ? snap.data() : {};
    const applyInfo = cfg.applyInfo || "";
    const was = applyEnabled;
    applyEnabled = !!cfg.applyEnabled;
    if (was !== applyEnabled) render();
    const box = document.getElementById("board-apply");
    if (applyInfo.trim()) {
      document.getElementById("board-apply-text").innerHTML = esc(applyInfo).replace(/\n/g, "<br>");
      box.hidden = false;
    } else box.hidden = true;
  }, () => {});

  // 과정 현황 구독(실시간).
  onSnapshot(collection(db, "publicBoard"), (snap) => {
    items = snap.docs.filter((d) => !d.id.startsWith("__")).map((d) => ({ id: d.id, ...d.data() }));
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
