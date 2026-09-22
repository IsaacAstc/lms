// 공사 내부용 수강신청 페이지(board_kac.html).
// 공개 보드(board.js)와 같은 publicBoard 컬렉션·같은 submitApplication 함수를 쓰므로
// 정원·신청·잔여 수치는 두 페이지가 자동으로 공유된다.
// 공개 보드와 다른 점: 공문·신청양식 첨부가 없고, 대신 소속기관을 고른다.
// 접수는 발급된 접수번호를 공문에 적어 사내 공문으로 진행한다.
import {
  collection, doc, onSnapshot,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { db, app } from "./firebase.js";

let applyEnabled = false;      // __config.applyEnabled — 공개 보드와 공유
let orgUnits = [];             // __kac.orgUnits — 관리자가 관리하는 소속기관 목록
let domains = [];              // __kac.domains — 허용 이메일 도메인(비우면 제한 없음)
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
  // 신청 마감: 교육 시작일까지 접수(시작일이 지나면 신청 불가, 취소는 계속 가능).
  const closed = !!c.startDate && c.startDate < todayStr();
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
        ${closed
          ? `<button type="button" class="board-apply-btn" disabled title="교육 시작일이 지나 접수가 마감되었습니다">접수 마감</button>`
          : (!full ? `<button type="button" class="board-apply-btn" data-id="${esc(c.id)}" data-kind="apply">신청</button>` : "")}
        <button type="button" class="board-apply-btn ghost" data-id="${esc(c.id)}" data-kind="cancel">신청 취소</button>
      </div>` : ""}
    </article>`;
}

// ── 내부 신청/취소 양식 ──
const dlg = document.getElementById("apply-dialog");
let current = null; // { id, kind, course }

// 허용 도메인 검사. 목록이 비어 있으면 제한하지 않는다(관리자가 아직 설정하지 않은 상태).
function domainOk(email) {
  if (!domains.length) return true;
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const d = email.slice(at + 1).toLowerCase();
  return domains.some((x) => d === x || d.endsWith("." + x));
}

function openDialog(id, kind) {
  const c = items.find((x) => x.id === id);
  if (!c) return;
  current = { id, kind, course: c };
  const apply = kind === "apply";
  document.getElementById("apply-title").textContent = apply ? "교육 신청 (내부)" : "신청 취소";
  document.getElementById("apply-course").textContent =
    `${c.name || ""}${c.round ? ` ${c.round}차수` : ""} · ${dot(c.startDate || "")}${c.endDate && c.endDate !== c.startDate ? " - " + dot(c.endDate) : ""}`;
  document.getElementById("apply-fields-apply").hidden = !apply;
  document.getElementById("apply-guide").hidden = !apply; // 취소에는 공문 절차 안내가 필요 없다.
  document.getElementById("apply-fields-cancel").hidden = apply;
  if (apply) {
    const remaining = c.remaining != null ? c.remaining : Math.max(0, (c.capacity || 0) - (c.appliedCount || 0));
    const maxN = Math.max(1, Math.min(20, remaining || 20));
    document.getElementById("apply-count").innerHTML =
      Array.from({ length: maxN }, (_, i) => `<option value="${i + 1}">${i + 1}명</option>`).join("");
  }
  document.getElementById("apply-receipt").value = "";
  document.getElementById("apply-cancel-count").value = "";
  document.getElementById("apply-subject").value = "";
  document.getElementById("apply-body").value = "";
  document.getElementById("apply-status").textContent = "";
  const sendBtn = document.getElementById("apply-send");
  sendBtn.textContent = apply ? "신청" : "취소 처리";
  sendBtn.disabled = false;
  sendBtn.hidden = false;
  dlg.showModal();
}

async function send() {
  if (!current) return;
  const status = document.getElementById("apply-status");
  const btn = document.getElementById("apply-send");
  const email = document.getElementById("apply-email").value.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { status.textContent = "이메일 주소를 확인하세요."; return; }
  if (!domainOk(email)) {
    status.textContent = `공사 메일 주소로만 신청할 수 있습니다. (허용: ${domains.map((d) => "@" + d).join(", ")})`;
    return;
  }

  const payload = {
    kind: current.kind,
    channel: "internal",
    courseId: current.id,
    email,
    title: document.getElementById("apply-subject").value.trim(),
    body: document.getElementById("apply-body").value.trim(),
  };
  if (current.kind === "apply") {
    payload.count = Number(document.getElementById("apply-count").value);
    payload.orgUnit = document.getElementById("apply-org").value;
    if (!payload.orgUnit) { status.textContent = "소속기관을 선택하세요."; return; }
  } else {
    payload.receiptCode = document.getElementById("apply-receipt").value.trim();
    if (!payload.receiptCode) { status.textContent = "접수번호를 입력하세요."; return; }
    // 취소 인원: 비우면 전체 취소(서버가 남은 인원 전체로 처리).
    const cc = document.getElementById("apply-cancel-count").value.trim();
    if (cc) {
      const n = Number(cc);
      if (!Number.isInteger(n) || n < 1) { status.textContent = "취소 인원은 1명 이상의 숫자로 입력하세요."; return; }
      payload.cancelCount = n;
    }
  }

  btn.disabled = true;
  status.textContent = "처리 중… (잠시 기다려 주세요)";
  try {
    const res = await httpsCallable(fns, "submitApplication")(payload);
    const r = res.data || {};
    if (current.kind === "apply") {
      // 접수번호를 공문에 옮겨 적어야 하므로, 눈에 띄게 보여주고 다음에 할 일을 그대로 적는다.
      document.getElementById("apply-guide").hidden = true;
      status.innerHTML = `<span class="apply-done-title">✅ 자리가 확보되었습니다</span>`
        + `<span class="apply-code">접수번호 <b>${esc(r.receiptCode || "")}</b></span>`
        + `<span class="apply-next"><b>아직 끝난 것이 아닙니다.</b> 아래대로 공문을 보내 주세요.<br>`
        + `① 사내 공문을 작성하면서 <b>제목이나 본문에 위 접수번호를 적습니다.</b><br>`
        + `② 기존 <b>신청 양식</b>을 붙임으로 첨부합니다.<br>`
        + `③ 공문을 발송하면 접수가 끝납니다.</span>`
        + `<span class="apply-next">접수번호는 방금 입력하신 메일로도 보내 드렸습니다. `
        + `신청을 취소할 때도 필요하니 보관하세요.</span>`;
    } else {
      const mailNote = r.mailFailed
        ? "(확인 메일 발송은 실패 — 잔여석은 복구됨)"
        : "확인 메일을 발송했으며 잔여석이 복구되었습니다.";
      status.innerHTML = r.partial
        ? `✅ ${r.cancelCount}명 취소 완료. <b>남은 신청 인원: ${r.remainAfter}명</b><br>`
          + `접수번호는 그대로 유효합니다. <b>인원 변경 사실을 공문으로도 알려 주세요.</b><br>`
          + `<span class="apply-next">${esc(mailNote)}</span>`
        : `✅ 전체 취소 완료. ${esc(mailNote)}<br>`
          + `<span class="apply-next">취소 사실을 공문으로도 알려 주셔야 처리가 마무리됩니다.</span>`;
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

function main() {
  applyDefaultRange(); // 최초 조회는 오늘 ~ 다음 달 말일.

  // 내부용 설정(__kac 문서) 구독 — 소속기관 목록·허용 도메인.
  onSnapshot(doc(db, "publicBoard", "__kac"), (snap) => {
    const cfg = snap.exists() ? snap.data() : {};
    orgUnits = Array.isArray(cfg.orgUnits) ? cfg.orgUnits.filter((x) => typeof x === "string" && x.trim()) : [];
    domains = Array.isArray(cfg.domains) ? cfg.domains.map((x) => String(x).trim().toLowerCase()).filter(Boolean) : [];
    const sel = document.getElementById("apply-org");
    sel.innerHTML = orgUnits.length
      ? `<option value="">선택하세요</option>` + orgUnits.map((o) => `<option value="${esc(o)}">${esc(o)}</option>`).join("")
      : `<option value="">등록된 소속기관이 없습니다 — 담당자에게 문의</option>`;
    const note = document.getElementById("apply-domain-note");
    note.textContent = domains.length ? `※ ${domains.map((d) => "@" + d).join(", ")} 주소로만 신청할 수 있습니다.` : "";
    note.hidden = !domains.length;
  }, () => {});

  // 신청 안내 텍스트·접수 활성 여부(__config 문서) 구독 — 공개 보드와 공유.
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

  // 과정 현황 구독(실시간) — 공개 보드와 같은 범위.
  onSnapshot(collection(db, "publicBoard"), (snap) => {
    items = snap.docs.filter((d) => !d.id.startsWith("__") && !d.data().didOnly).map((d) => ({ id: d.id, ...d.data() }));
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
    applyDefaultRange();
    render();
  });
}

main();
