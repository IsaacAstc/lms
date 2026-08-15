// 공개 현황 보드 관리(관리자): 전체 동기화 + 신청 안내 문구 편집 + 공개 주소 안내.
import {
  collection, getDocs, getDoc, doc, setDoc, writeBatch, query, orderBy, limit,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { db, app } from "./firebase.js";
import { boardFields, isBoardExcluded } from "./courses.js";
import { orgQuery } from "./orgs.js";

export function initBoardAdmin() {
  document.getElementById("board-sync").addEventListener("click", () => syncAll(true));
  document.getElementById("board-apply-save").addEventListener("click", saveApply);
  document.getElementById("board-apply-email-save").addEventListener("click", saveApplyEmail);
  document.getElementById("board-url-copy").addEventListener("click", () => {
    navigator.clipboard?.writeText(document.getElementById("board-url").value);
    document.getElementById("board-url-copy").textContent = "복사됨";
  });
  document.addEventListener("tabshown", (e) => { if (e.detail === "board") load(); });
}

async function load() {
  const base = location.origin + location.pathname.replace(/[^/]*$/, "");
  document.getElementById("board-url").value = `${base}board.html${orgQuery(true)}`;
  document.getElementById("board-open").href = `${base}board.html${orgQuery(true)}`;
  try {
    const d = await getDoc(doc(db, "publicBoard", "__config"));
    document.getElementById("board-apply-input").value = d.exists() ? (d.data().applyInfo || "") : "";
    document.getElementById("board-apply-enabled").checked = d.exists() && !!d.data().applyEnabled;
  } catch { /* */ }
  try {
    const a = await getDoc(doc(db, "settings", "apply"));
    document.getElementById("board-apply-email").value = a.exists() ? (a.data().email || "") : "";
  } catch { /* */ }
  loadApplications();
  // 탭 진입 시 차이만 자동 동기화(변경 없으면 쓰기 없음). CSV 대량등록·시드분 자동 반영.
  autoSync();
}

// 보드 미러 필드 비교(updatedAtMs 제외).
function boardDiffers(a, b) {
  const keys = ["code", "name", "courseType", "round", "startDate", "endDate", "venue", "capacity", "appliedCount", "remaining"];
  const boolKeys = ["hasEvaluation", "planned"]; // 미설정(undefined)과 false는 같은 값으로 취급.
  return keys.some((k) => (a?.[k] ?? "") !== (b[k] ?? ""))
    || boolKeys.some((k) => !!a?.[k] !== !!b[k]);
}

// 미게시/변경된 차수만 게시 + 삭제분 정리(조용히). 상태 표시.
async function autoSync() {
  const log = document.getElementById("board-sync-log");
  log.textContent = "현황 확인 중…";
  try {
    const [csnap, bsnap] = await Promise.all([
      getDocs(collection(db, "courses")),
      getDocs(collection(db, "publicBoard")),
    ]);
    const boardById = {};
    bsnap.docs.forEach((d) => { if (!d.id.startsWith("__")) boardById[d.id] = d.data(); });
    // 숨김 차수·비공개 과정유형은 게시 대상에서 제외(보드에 있으면 제거).
    const visible = csnap.docs.filter((d) => !isBoardExcluded(d.data()));
    const visibleIds = new Set(visible.map((d) => d.id));
    const toWrite = visible.filter((d) => { const cur = boardById[d.id]; return !cur || boardDiffers(cur, boardFields(d.data())); });
    const stale = bsnap.docs.filter((d) => !d.id.startsWith("__") && !visibleIds.has(d.id));
    for (let i = 0; i < toWrite.length; i += 450) {
      const batch = writeBatch(db);
      toWrite.slice(i, i + 450).forEach((d) => batch.set(doc(db, "publicBoard", d.id), boardFields(d.data())));
      await batch.commit();
    }
    for (let i = 0; i < stale.length; i += 450) {
      const batch = writeBatch(db);
      stale.slice(i, i + 450).forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
    const hiddenCount = csnap.size - visible.length; // 숨김 + 비공개 과정유형
    log.textContent = `게시 ${visible.length}건` + (hiddenCount ? ` (숨김·비공개유형 ${hiddenCount}건 제외)` : "") +
      (toWrite.length || stale.length ? ` · 자동 반영: 갱신 ${toWrite.length}건${stale.length ? `, 정리 ${stale.length}건` : ""}` : " · 최신 상태");
  } catch (e) { log.textContent = "현황 확인 실패: " + e.message; }
}

async function saveApply() {
  const v = document.getElementById("board-apply-input").value.trim();
  try {
    await setDoc(doc(db, "publicBoard", "__config"), { applyInfo: v, updatedAtMs: Date.now() }, { merge: true });
    alert("신청 안내 문구를 저장했습니다.");
  } catch (e) { alert("저장 실패: " + e.message); }
}

// 접수 이메일(관리자 전용 settings) + 보드 노출 여부(__config, 공개는 boolean만).
async function saveApplyEmail() {
  // 쉼표(,)로 복수 주소 입력 가능 — 저장 전 각 주소 형식 검증.
  const raw = document.getElementById("board-apply-email").value.trim();
  const list = raw.split(/[,;\s]+/).filter(Boolean);
  const email = list.join(", ");
  const enabled = document.getElementById("board-apply-enabled").checked;
  const badAddr = list.find((a) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(a));
  if ((enabled && !list.length) || badAddr) { alert(`접수 이메일 주소를 확인하세요.${badAddr ? ` (잘못된 주소: ${badAddr})` : ""}`); return; }
  try {
    await setDoc(doc(db, "settings", "apply"), { email }, { merge: true });
    await setDoc(doc(db, "publicBoard", "__config"), { applyEnabled: enabled && !!email, updatedAtMs: Date.now() }, { merge: true });
    alert("접수 설정을 저장했습니다." + (enabled && email ? " 보드에 신청 버튼이 노출됩니다." : " (신청 버튼 비노출)"));
  } catch (e) { alert("저장 실패: " + e.message); }
}

// 접수 이력 + 반려 처리. 문서에는 접수번호 해시·수치·상태만 남고,
// 신청자 이메일은 반려 통지용으로 마감일까지만 보관된다(서버가 자동 파기).
const fns = getFunctions(app, "asia-northeast3");

async function loadApplications() {
  const body = document.getElementById("board-apps-body");
  try {
    const snap = await getDocs(query(collection(db, "applications"), orderBy("createdAt", "desc"), limit(50)));
    if (snap.empty) { body.innerHTML = `<tr><td colspan="5" class="empty">접수 이력이 없습니다.</td></tr>`; return; }
    const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const label = { cancelled: "취소됨", rejected: "반려됨" };
    body.innerHTML = "";
    snap.docs.forEach((d) => {
      const a = d.data();
      const t = a.createdAt?.toDate ? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "short", timeStyle: "short" }).format(a.createdAt.toDate()) : "-";
      const tr = document.createElement("tr");
      tr.innerHTML = `<td>${t}</td><td>${esc(a.courseName || a.courseId)}</td><td>${a.count || 0}명</td>
        <td>${label[a.status] || "신청"}${a.rejectReason ? ` <small>(${esc(a.rejectReason)})</small>` : ""}</td>
        <td class="actions">${a.status === "active" ? `<button type="button" class="reject">반려</button>` : ""}</td>`;
      const btn = tr.querySelector(".reject");
      if (btn) btn.addEventListener("click", () => rejectApplication(d.id, a, btn));
      body.appendChild(tr);
    });
  } catch (e) { body.innerHTML = `<tr><td colspan="5" class="empty">불러오기 실패: ${e.message}</td></tr>`; }
}

// 반려: 잔여석 복구 + 상태 변경 + 신청자에게 사유 통지(서버에서 일괄 처리).
async function rejectApplication(id, a, btn) {
  const reason = prompt(
    `'${a.courseName || a.courseId}' ${a.count}명 접수를 반려합니다.\n`
    + "신청자에게 그대로 통지되는 사유를 입력하세요(예: 공문 누락, 명단 서식 미비).\n"
    + "※ 잔여석은 즉시 복구되며 기존 접수번호는 사용할 수 없게 됩니다.");
  if (reason == null) return;
  if (!reason.trim()) return alert("반려 사유를 입력하세요.");
  btn.disabled = true; btn.textContent = "처리 중…";
  try {
    const res = await httpsCallable(fns, "rejectApplication")({ applicationId: id, reason: reason.trim() });
    const r = res.data || {};
    alert(r.mailFailed
      ? "반려 처리했습니다(잔여석 복구 완료). 다만 통지 메일 발송에 실패했습니다 — 접수 메일에 직접 회신해 주세요."
      : r.noApplicantEmail
        ? "반려 처리했습니다(잔여석 복구 완료). 신청자 이메일이 이미 파기되어(마감일 경과) 접수처에만 통지되었습니다."
        : "반려 처리했습니다. 잔여석이 복구되고 신청자에게 사유가 통지되었습니다.");
    loadApplications();
  } catch (e) {
    alert("반려 실패: " + (e.message || e));
    btn.disabled = false; btn.textContent = "반려";
  }
}

async function syncAll(force) {
  const log = document.getElementById("board-sync-log");
  const btn = document.getElementById("board-sync");
  btn.disabled = true;
  log.textContent = "동기화 중…";
  try {
    const [csnap, bsnap] = await Promise.all([
      getDocs(collection(db, "courses")),
      getDocs(collection(db, "publicBoard")),
    ]);
    // 제외 대상이 아닌 차수만 게시(미러).
    const visible = csnap.docs.filter((d) => !isBoardExcluded(d.data()));
    for (let i = 0; i < visible.length; i += 450) {
      const batch = writeBatch(db);
      visible.slice(i, i + 450).forEach((d) => batch.set(doc(db, "publicBoard", d.id), boardFields(d.data())));
      await batch.commit();
    }
    // 삭제·제외된 차수의 잔여 보드 항목 정리(__config 제외).
    const visibleIds = new Set(visible.map((d) => d.id));
    const stale = bsnap.docs.filter((d) => !d.id.startsWith("__") && !visibleIds.has(d.id));
    for (let i = 0; i < stale.length; i += 450) {
      const batch = writeBatch(db);
      stale.slice(i, i + 450).forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
    const hiddenCount = csnap.size - visible.length; // 숨김 + 비공개 과정유형
    log.textContent = `동기화 완료: 게시 ${visible.length}건` + (hiddenCount ? ` (숨김·비공개유형 ${hiddenCount}건 제외)` : "") + (stale.length ? `, 정리 ${stale.length}건` : "");
  } catch (e) { log.textContent = "동기화 실패: " + e.message; }
  finally { btn.disabled = false; }
}
