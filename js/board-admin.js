// 공개 현황 보드 관리(관리자): 전체 동기화 + 신청 안내 문구 편집 + 공개 주소 안내.
import {
  collection, getDocs, getDoc, doc, setDoc, writeBatch, updateDoc, query, orderBy, limit,
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
  document.getElementById("manual-save").addEventListener("click", saveManual);
  document.getElementById("manual-cancel-edit").addEventListener("click", () => resetManual());
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
  loadApplications();
  loadManualCourses();
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

// 접수 이력 + 반려 처리. 문서에는 접수번호·수치·상태만 남고,
// 신청자 이메일은 반려 통지용으로 마감일까지만 보관된다(서버가 자동 파기).
const fns = getFunctions(app, "asia-northeast3");

async function loadApplications() {
  const body = document.getElementById("board-apps-body");
  try {
    const snap = await getDocs(query(collection(db, "applications"), orderBy("createdAt", "desc"), limit(50)));
    if (snap.empty) { body.innerHTML = `<tr><td colspan="7" class="empty">접수 이력이 없습니다.</td></tr>`; return; }
    const esc = (v) => String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const label = { cancelled: "취소됨", rejected: "반려됨" };
    body.innerHTML = "";
    snap.docs.forEach((d) => {
      const a = d.data();
      const t = a.createdAt?.toDate ? new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "short", timeStyle: "short" }).format(a.createdAt.toDate()) : "-";
      const tr = document.createElement("tr");
      // 내부용 신청 페이지는 폐기됐지만, 그 경로로 접수된 과거 기록은 구분해 보여준다.
      const via = a.channel === "manual"
        ? `<small class="manual-tag">수동 · ${esc(a.source || "기타")}${a.docNo ? ` · ${esc(a.docNo)}` : ""}</small>`
        : a.channel === "internal" ? `<small>내부 · ${esc(a.orgUnit || "-")}</small>` : `<small>공개</small>`;
      // 일부 취소가 있었던 건은 원래 인원과 취소분을 같이 보여준다(공문 대조용).
      const cancelled = (a.cancelLog || []).reduce((n, x) => n + (x.count || 0), 0);
      const countCell = cancelled && a.status === "active"
        ? `${a.count || 0}명 <small>(취소 ${cancelled}명)</small>`
        : `${a.count || 0}명`;
      // 접수번호 원문은 이 기능이 들어오기 전 건에는 없다(해시만 저장했다).
      const code = (a.code ? `<code class="receipt-code">${esc(a.code)}</code>` : `<small class="muted">기록 없음</small>`)
        // 묶음 신청: 같은 공문으로 함께 접수된 건(묶음 번호 = 첫 과정 접수번호)
        + (a.groupId ? `<br><small class="muted" title="같은 공문으로 함께 신청된 과정 수">묶음 ${esc(a.groupId)} · ${a.groupSize || "?"}개</small>` : "");
      tr.innerHTML = `<td>${t}</td><td>${code}</td><td>${a.org ? `<b>${esc(a.org)}</b><br>` : ""}${esc(a.courseName || a.courseId)}<br>${via}</td><td>${countCell}</td>
        <td>${a.channel === "manual" && a.status === "cancelled" ? "삭제됨" : (label[a.status] || "신청")}${a.rejectReason ? `<br><small>${esc(a.rejectReason)}</small>` : ""}</td>
        <td><input type="text" class="app-memo" maxlength="300" placeholder="메모" value="${esc(a.memo || "")}" style="width:100%;min-width:6rem;box-sizing:border-box"></td>
        <td class="actions">${a.status !== "active" ? ""
          : a.channel === "manual" ? `<button type="button" class="m-edit">수정</button> <button type="button" class="m-del danger">삭제</button>`
          : `<button type="button" class="reject">반려</button>`}</td>`;
      // 관리자 메모: 칸을 벗어나면 저장(바뀐 경우만). 개인정보는 적지 않는다.
      const memo = tr.querySelector(".app-memo");
      memo.addEventListener("change", async () => {
        try {
          await updateDoc(doc(db, "applications", d.id), { memo: memo.value.trim().slice(0, 300), memoAtMs: Date.now() });
          memo.style.background = "#eaf6ea"; setTimeout(() => { memo.style.background = ""; }, 1200);
        } catch (e) { alert("메모 저장 실패: " + e.message); }
      });
      const btn = tr.querySelector(".reject");
      if (btn) btn.addEventListener("click", () => rejectApplication(d.id, a, btn));
      tr.querySelector(".m-edit")?.addEventListener("click", () => editManual(d.id, a));
      const del = tr.querySelector(".m-del");
      if (del) del.addEventListener("click", () => deleteManual(d.id, a, del));
      body.appendChild(tr);
    });
  } catch (e) { body.innerHTML = `<tr><td colspan="7" class="empty">불러오기 실패: ${e.message}</td></tr>`; }
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

// ── 수동 접수(사내 공문·온나라 공문 등 보드 밖 신청) ──
// 서버(manualApplication)가 트랜잭션으로 신청건수·보드 잔여석을 함께 갱신한다.
let manualEditId = null;
let manualCourses = [];

async function loadManualCourses() {
  const sel = document.getElementById("manual-course");
  try {
    const snap = await getDocs(collection(db, "courses"));
    manualCourses = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
      .sort((a, b) => String(b.startDate || "").localeCompare(String(a.startDate || "")));
    const keep = sel.value;
    sel.innerHTML = `<option value="">과정 선택…</option>` + manualCourses.map((c) => {
      const remain = Math.max(0, (c.capacity || 0) - (c.appliedCount || 0));
      const name = `${c.name || c.id}${c.round ? ` ${c.round}차수` : ""}`;
      return `<option value="${c.id}">${name.replace(/</g, "&lt;")} (${c.startDate || "일자 미정"} · 잔여 ${remain}석)</option>`;
    }).join("");
    sel.value = keep;
  } catch (e) { document.getElementById("manual-log").textContent = "과정 목록 불러오기 실패: " + e.message; }
}

function resetManual(msg = "") {
  manualEditId = null;
  ["manual-count", "manual-org", "manual-docno"].forEach((id) => { document.getElementById(id).value = ""; });
  document.getElementById("manual-source").value = "사내 공문";
  document.getElementById("manual-course").disabled = false;
  document.getElementById("manual-save").textContent = "등록";
  document.getElementById("manual-cancel-edit").hidden = true;
  document.getElementById("manual-log").textContent = msg;
}

function editManual(id, a) {
  manualEditId = id;
  const sel = document.getElementById("manual-course");
  if (![...sel.options].some((o) => o.value === a.courseId)) {
    sel.insertAdjacentHTML("beforeend", `<option value="${a.courseId}">${String(a.courseName || a.courseId).replace(/</g, "&lt;")}</option>`);
  }
  sel.value = a.courseId;
  sel.disabled = true; // 과정 변경은 삭제 후 다시 등록
  document.getElementById("manual-count").value = a.count || "";
  document.getElementById("manual-org").value = a.org || "";
  document.getElementById("manual-source").value = a.source || "기타";
  document.getElementById("manual-docno").value = a.docNo || "";
  document.getElementById("manual-save").textContent = "수정 저장";
  document.getElementById("manual-cancel-edit").hidden = false;
  document.getElementById("manual-log").textContent = `수정 중: ${a.courseName || a.courseId} · ${a.code || ""} (과정을 바꾸려면 삭제 후 다시 등록하세요)`;
  const fold = document.getElementById("board-manual-fold");
  fold.open = true;
  fold.scrollIntoView({ behavior: "smooth", block: "center" });
}

async function saveManual() {
  if (isObserverMode()) return alert("참관자 계정은 조회만 할 수 있습니다.");
  const btn = document.getElementById("manual-save");
  const log = document.getElementById("manual-log");
  const payload = {
    action: manualEditId ? "update" : "create",
    applicationId: manualEditId || undefined,
    courseId: document.getElementById("manual-course").value,
    count: Number(document.getElementById("manual-count").value),
    org: document.getElementById("manual-org").value.trim(),
    source: document.getElementById("manual-source").value,
    docNo: document.getElementById("manual-docno").value.trim(),
  };
  if (!manualEditId && !payload.courseId) return alert("과정을 선택하세요.");
  if (!Number.isInteger(payload.count) || payload.count < 1 || payload.count > 200) return alert("인원은 1~200명으로 입력하세요.");
  if (!payload.org) return alert("신청기관을 입력하세요.");
  const call = httpsCallable(fns, "manualApplication");
  btn.disabled = true; log.textContent = "처리 중…";
  try {
    let res;
    try { res = await call(payload); }
    catch (e) {
      // 정원 초과: 공문으로 확정된 건일 수 있어 확인 후 그대로 등록할 수 있다.
      if (!e.details?.over) throw e;
      if (!confirm(`${e.message}\n그래도 등록할까요? (신청건수가 정원을 넘게 됩니다)`)) { log.textContent = "취소했습니다."; return; }
      res = await call({ ...payload, allowOver: true });
    }
    const r = res.data || {};
    resetManual(manualEditId ? "" : (r.code ? `등록했습니다 — ${r.courseName} ${payload.count}명 (관리번호 ${r.code}, 신청 ${r.applied}/${r.capacity})` : "저장했습니다."));
    if (payload.action === "update") log.textContent = "수정했습니다" + (r.delta ? ` (인원 ${r.delta > 0 ? "+" : ""}${r.delta}명 반영)` : "") + ".";
    loadApplications(); loadManualCourses();
  } catch (e) { log.textContent = "실패: " + (e.message || e); }
  finally { btn.disabled = false; }
}

async function deleteManual(id, a, btn) {
  if (isObserverMode()) return alert("참관자 계정은 조회만 할 수 있습니다.");
  if (!confirm(`수동 등록 건을 삭제합니다.\n${a.courseName || a.courseId} · ${a.org || ""} ${a.count}명\n잔여석이 ${a.count}석 복구됩니다.`)) return;
  btn.disabled = true; btn.textContent = "처리 중…";
  try {
    await httpsCallable(fns, "manualApplication")({ action: "delete", applicationId: id });
    if (manualEditId === id) resetManual();
    loadApplications(); loadManualCourses();
  } catch (e) {
    alert("삭제 실패: " + (e.message || e));
    btn.disabled = false; btn.textContent = "삭제";
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
