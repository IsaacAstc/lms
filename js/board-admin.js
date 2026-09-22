// 공개 현황 보드 관리(관리자): 전체 동기화 + 신청 안내 문구 편집 + 공개 주소 안내.
import {
  collection, getDocs, getDoc, doc, setDoc, writeBatch, query, orderBy, limit,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { db, app } from "./firebase.js";
import { boardFields, isBoardExcluded } from "./courses.js";
import { isObserverMode } from "./app.js";
import { orgQuery } from "./orgs.js";

export function initBoardAdmin() {
  document.getElementById("board-sync").addEventListener("click", () => syncAll(true));
  document.getElementById("board-apply-save").addEventListener("click", saveApply);
  document.getElementById("board-apply-email-save").addEventListener("click", saveApplyEmail);
  document.getElementById("board-url-copy").addEventListener("click", () => {
    navigator.clipboard?.writeText(document.getElementById("board-url").value);
    document.getElementById("board-url-copy").textContent = "복사됨";
  });
  document.getElementById("board-url-qr").addEventListener("click", showBoardQr);
  document.getElementById("board-form-save").addEventListener("click", saveApplyForm);
  document.getElementById("board-qr-close").addEventListener("click", () => document.getElementById("board-qr-dialog").close());
  document.getElementById("board-kac-url-copy").addEventListener("click", () => {
    navigator.clipboard?.writeText(document.getElementById("board-kac-url").value);
    document.getElementById("board-kac-url-copy").textContent = "복사됨";
  });
  document.getElementById("board-kac-domains-save").addEventListener("click", saveKacDomains);
  document.getElementById("board-kac-org-add").addEventListener("click", addOrgUnit);
  document.getElementById("board-kac-org-body").addEventListener("click", onOrgUnitClick);
  document.addEventListener("tabshown", (e) => { if (e.detail === "board") load(); });
}

// ── 공개 페이지 QR (라이브러리는 최초 사용 시 지연 로드 — scfe·수업보드·로지보드와 공유) ──
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
// ── 신청양식 파일(publicBoard/__form — 공개 읽기, Firestore에 base64로 저장) ──
// 엑셀 양식은 수십 KB 수준이라 문서 1개로 충분(700KB 상한 — base64 팽창 감안).
const FORM_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
function showApplyFormInfo(d) {
  const cur = document.getElementById("board-form-current");
  const dl = document.getElementById("board-form-dl");
  if (!d || !d.dataBase64) { cur.textContent = "등록된 양식 없음"; dl.hidden = true; return; }
  const when = d.updatedAtMs ? new Intl.DateTimeFormat("ko-KR", { dateStyle: "short" }).format(new Date(d.updatedAtMs)) : "";
  cur.textContent = `현재 양식: ${d.name || "form.xlsx"} (${Math.round((d.size || 0) / 1024)}KB${when ? ` · ${when}` : ""})`;
  dl.hidden = false;
  dl.href = `data:${d.mime || FORM_MIME};base64,${d.dataBase64}`;
  dl.download = d.name || "신청양식.xlsx";
}
async function loadApplyForm() {
  try {
    const d = await getDoc(doc(db, "publicBoard", "__form"));
    showApplyFormInfo(d.exists() ? d.data() : null);
  } catch { /* */ }
}
async function saveApplyForm() {
  const inp = document.getElementById("board-form-file");
  const f = inp.files[0];
  if (!f) return alert("업로드할 신청양식 파일을 선택하세요.");
  if (f.size > 700 * 1024) return alert("양식 파일은 700KB 이하만 등록할 수 있습니다.");
  const dataBase64 = await new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => resolve("");
    r.readAsDataURL(f);
  });
  if (!dataBase64) return alert("파일을 읽지 못했습니다.");
  try {
    const d = { name: f.name, size: f.size, mime: f.type || FORM_MIME, dataBase64, updatedAtMs: Date.now() };
    await setDoc(doc(db, "publicBoard", "__form"), d);
    inp.value = "";
    showApplyFormInfo(d);
    alert("신청양식을 저장했습니다. 공개 보드 신청 화면에 즉시 반영됩니다.");
  } catch (e) { alert("저장 실패: " + e.message); }
}

async function showBoardQr() {
  try { await loadQrLib(); } catch (e) { return alert(e.message); }
  const url = document.getElementById("board-url").value;
  if (!url) return alert("먼저 공개 현황 보드 탭이 로드된 뒤 사용하세요.");
  document.getElementById("board-qr-url").textContent = url;
  const box = document.getElementById("board-qr-box");
  box.innerHTML = "";
  new QRCode(box, { text: url, width: 220, height: 220, correctLevel: QRCode.CorrectLevel.M });
  document.getElementById("board-qr-dialog").showModal();
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
  loadApplyForm();
  try {
    const a = await getDoc(doc(db, "settings", "apply"));
    document.getElementById("board-apply-email").value = a.exists() ? (a.data().email || "") : "";
  } catch { /* */ }
  document.getElementById("board-kac-url").value = `${base}board_kac.html${orgQuery(true)}`;
  document.getElementById("board-kac-open").href = `${base}board_kac.html${orgQuery(true)}`;
  loadKac();
  loadApplications();
  // 탭 진입 시 차이만 자동 동기화(변경 없으면 쓰기 없음). CSV 대량등록·시드분 자동 반영.
  // 참관자는 쓰기 권한이 없으므로 건너뛴다(불필요한 권한 오류 방지).
  if (!isObserverMode()) autoSync();
}

// 보드 미러 필드 비교(updatedAtMs 제외).
function boardDiffers(a, b) {
  const keys = ["code", "name", "courseType", "round", "startDate", "endDate", "venue", "capacity", "appliedCount", "remaining"];
  const boolKeys = ["hasEvaluation", "planned", "didOnly"]; // 미설정(undefined)과 false는 같은 값으로 취급.
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
    // 숨김 차수만 게시 대상에서 제외(특별·재교육은 didOnly 플래그로 게시 — 보드 숨김·DID 표시).
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
    const hiddenCount = csnap.size - visible.length; // 숨김 처리분
    log.textContent = `게시 ${visible.length}건` + (hiddenCount ? ` (숨김 ${hiddenCount}건 제외)` : "") +
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

/* ── 공사 내부용 페이지 설정(publicBoard/__kac — 공개 읽기) ──
 * 소속기관 목록과 허용 이메일 도메인. 기관명·도메인뿐이라 개인정보가 아니며,
 * 내부 페이지가 로그인 없이 읽어야 하므로 공개 문서에 둔다. */
let kacOrgUnits = [];
let kacDomains = [];

async function loadKac() {
  try {
    const d = await getDoc(doc(db, "publicBoard", "__kac"));
    const v = d.exists() ? d.data() : {};
    kacOrgUnits = Array.isArray(v.orgUnits) ? v.orgUnits.map((x) => String(x)) : [];
    kacDomains = Array.isArray(v.domains) ? v.domains.map((x) => String(x)) : [];
  } catch { kacOrgUnits = []; kacDomains = []; }
  document.getElementById("board-kac-domains").value = kacDomains.join(", ");
  paintOrgUnits();
}

function paintOrgUnits() {
  const body = document.getElementById("board-kac-org-body");
  if (!kacOrgUnits.length) {
    body.innerHTML = `<tr><td colspan="3" class="empty">등록된 소속기관이 없습니다. 추가하세요.</td></tr>`;
    return;
  }
  body.innerHTML = kacOrgUnits.map((o, i) => `
    <tr>
      <td>${i + 1}</td>
      <td>${escHtml(o)}</td>
      <td class="actions">
        <button type="button" data-act="up" data-i="${i}"${i === 0 ? " disabled" : ""}>▲</button>
        <button type="button" data-act="down" data-i="${i}"${i === kacOrgUnits.length - 1 ? " disabled" : ""}>▼</button>
        <button type="button" data-act="rename" data-i="${i}">이름 수정</button>
        <button type="button" data-act="del" data-i="${i}">삭제</button>
      </td>
    </tr>`).join("");
}

function escHtml(v) {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

async function saveOrgUnits(msg) {
  try {
    await setDoc(doc(db, "publicBoard", "__kac"), { orgUnits: kacOrgUnits, updatedAtMs: Date.now() }, { merge: true });
    paintOrgUnits();
    if (msg) alert(msg);
  } catch (e) { alert("저장 실패: " + e.message); loadKac(); }
}

async function addOrgUnit() {
  const inp = document.getElementById("board-kac-org-new");
  const v = inp.value.trim();
  if (!v) { alert("소속기관 이름을 입력하세요."); return; }
  if (kacOrgUnits.includes(v)) { alert("이미 등록된 소속기관입니다."); return; }
  kacOrgUnits.push(v);
  inp.value = "";
  await saveOrgUnits();
}

async function onOrgUnitClick(e) {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const i = Number(btn.dataset.i);
  const act = btn.dataset.act;
  if (act === "del") {
    // 이미 이 기관으로 접수된 건은 그대로 남는다(접수 기록은 문자열로 저장됨).
    if (!confirm(`'${kacOrgUnits[i]}'을(를) 목록에서 삭제할까요?\n이후 이 기관으로는 신청할 수 없습니다.`)) return;
    kacOrgUnits.splice(i, 1);
  } else if (act === "rename") {
    const v = prompt("소속기관 이름", kacOrgUnits[i]);
    if (v == null) return;
    const t = v.trim();
    if (!t) { alert("이름이 비었습니다."); return; }
    if (kacOrgUnits.some((x, j) => j !== i && x === t)) { alert("이미 등록된 소속기관입니다."); return; }
    kacOrgUnits[i] = t;
  } else if (act === "up" && i > 0) {
    [kacOrgUnits[i - 1], kacOrgUnits[i]] = [kacOrgUnits[i], kacOrgUnits[i - 1]];
  } else if (act === "down" && i < kacOrgUnits.length - 1) {
    [kacOrgUnits[i + 1], kacOrgUnits[i]] = [kacOrgUnits[i], kacOrgUnits[i + 1]];
  } else return;
  await saveOrgUnits();
}

async function saveKacDomains() {
  const raw = document.getElementById("board-kac-domains").value.trim();
  const list = raw.split(/[,;\s]+/).filter(Boolean).map((x) => x.replace(/^@/, "").toLowerCase());
  const bad = list.find((d) => !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d));
  if (bad) { alert(`도메인 형식을 확인하세요. (잘못된 값: ${bad})`); return; }
  try {
    await setDoc(doc(db, "publicBoard", "__kac"), { domains: list, updatedAtMs: Date.now() }, { merge: true });
    kacDomains = list;
    alert(list.length
      ? `허용 도메인을 저장했습니다. (${list.map((d) => "@" + d).join(", ")})`
      : "허용 도메인을 비웠습니다. 모든 이메일 주소로 내부 신청이 가능합니다.");
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
      const via = a.channel === "internal" ? `<small>내부 · ${esc(a.orgUnit || "-")}</small>` : `<small>공개</small>`;
      // 일부 취소가 있었던 건은 원래 인원과 취소분을 같이 보여준다(공문 대조용).
      const cancelled = (a.cancelLog || []).reduce((n, x) => n + (x.count || 0), 0);
      const countCell = cancelled && a.status === "active"
        ? `${a.count || 0}명 <small>(취소 ${cancelled}명)</small>`
        : `${a.count || 0}명`;
      tr.innerHTML = `<td>${t}</td><td>${esc(a.courseName || a.courseId)}<br>${via}</td><td>${countCell}</td>
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
    const hiddenCount = csnap.size - visible.length; // 숨김 처리분
    log.textContent = `동기화 완료: 게시 ${visible.length}건` + (hiddenCount ? ` (숨김 ${hiddenCount}건 제외)` : "") + (stale.length ? `, 정리 ${stale.length}건` : "");
  } catch (e) { log.textContent = "동기화 실패: " + e.message; }
  finally { btn.disabled = false; }
}
