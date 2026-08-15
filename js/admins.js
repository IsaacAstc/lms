// 관리자 계정 관리: 내 비밀번호 변경 + 다른 관리자 추가/편집/삭제.
// Spark(서버리스) 제약:
//  - 다른 관리자 '추가'는 보조 앱 인스턴스로 Auth 계정 생성(현재 세션 유지) + admins 컬렉션 등록.
//  - '편집'은 메모 수정 및 비밀번호 재설정 메일 발송(타인 비밀번호 직접 변경은 불가).
//  - '삭제'는 allowlist(admins 컬렉션)에서 제거하여 접근을 회수. Auth 계정 자체의 완전 삭제는
//    Admin SDK가 필요하므로 Firebase 콘솔에서 별도 처리해야 함.
import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth, createUserWithEmailAndPassword, signOut,
  updatePassword, reauthenticateWithCredential, EmailAuthProvider, sendPasswordResetEmail,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  collection, doc, setDoc, updateDoc, deleteDoc, onSnapshot, deleteField,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db, auth, activeConfig } from "./firebase.js";
import { escapeHtml, isMasterMode, ASSIGNABLE_TABS } from "./app.js";

let unsub = null;

export function initAdmins() {
  document.getElementById("pw-change-btn").addEventListener("click", changeOwnPassword);
  document.getElementById("admin-add-btn").addEventListener("click", addAdmin);
  document.getElementById("admin-reset-btn").addEventListener("click", sendResetMe);
  // 역할 선택은 마스터에게만 노출(규칙에서도 마스터만 부여 가능).
  document.getElementById("admin-role-wrap").hidden = !isMasterMode();
  subscribe();
  document.addEventListener("tabshown", (e) => {
    if (e.detail !== "admins") return;
    document.getElementById("me-email").textContent =
      `${auth.currentUser?.email || ""} (${isMasterMode() ? "마스터 관리자" : "일반 관리자"})`;
  });
}

// ── 내 비밀번호 변경 ──
async function changeOwnPassword() {
  const cur = document.getElementById("pw-current").value;
  const nw = document.getElementById("pw-new").value;
  const nw2 = document.getElementById("pw-new2").value;
  const out = document.getElementById("pw-msg");
  out.textContent = "";
  if (!cur || !nw) { out.textContent = "현재/새 비밀번호를 입력하세요."; return; }
  if (nw.length < 6) { out.textContent = "새 비밀번호는 6자 이상이어야 합니다."; return; }
  if (nw !== nw2) { out.textContent = "새 비밀번호 확인이 일치하지 않습니다."; return; }
  try {
    const user = auth.currentUser;
    const cred = EmailAuthProvider.credential(user.email, cur);
    await reauthenticateWithCredential(user, cred); // 최근 인증 확인.
    await updatePassword(user, nw);
    out.style.color = "#3a3";
    out.textContent = "비밀번호를 변경했습니다.";
    ["pw-current", "pw-new", "pw-new2"].forEach((id) => (document.getElementById(id).value = ""));
  } catch (e) {
    out.style.color = "";
    out.textContent = e.code === "auth/wrong-password" || e.code === "auth/invalid-credential"
      ? "현재 비밀번호가 올바르지 않습니다."
      : "변경 실패: " + e.message;
  }
}

// 내 계정 비밀번호 재설정 메일(현재 로그인 이메일로).
async function sendResetMe() {
  const out = document.getElementById("pw-msg");
  try {
    await sendPasswordResetEmail(auth, auth.currentUser.email);
    out.style.color = "#3a3";
    out.textContent = `재설정 메일을 ${auth.currentUser.email} 로 보냈습니다.`;
  } catch (e) { out.style.color = ""; out.textContent = "메일 발송 실패: " + e.message; }
}

// ── 관리자 추가 ──
async function addAdmin() {
  const email = document.getElementById("admin-email").value.trim().toLowerCase();
  const pw = document.getElementById("admin-pw").value;
  const memo = document.getElementById("admin-memo").value.trim();
  const out = document.getElementById("admin-add-msg");
  out.style.color = ""; out.textContent = "";
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { out.textContent = "올바른 이메일을 입력하세요."; return; }
  if (pw && pw.length < 6) { out.textContent = "초기 비밀번호는 6자 이상이어야 합니다."; return; }

  try {
    // 1) Auth 계정 생성(보조 앱 — 현재 세션에 영향 없음). 비밀번호를 준 경우에만.
    let authNote = "";
    if (pw) {
      const created = await createAuthUser(email, pw);
      authNote = created ? " Auth 계정 생성됨." : " (이미 존재하는 Auth 계정 — 목록에만 등록)";
    } else {
      authNote = " (Auth 계정 미생성 — 대상자가 로그인하려면 콘솔/재설정 메일로 계정 필요)";
    }
    // 2) allowlist(admins) 등록. 역할 부여는 마스터만(규칙에서도 차단).
    const role = (isMasterMode() && document.getElementById("admin-role").value === "master") ? "master" : "admin";
    await setDoc(doc(db, "admins", email), {
      email, memo, role, addedBy: auth.currentUser?.email || "", addedAtMs: Date.now(),
    }, { merge: true });
    out.style.color = "#3a3";
    out.textContent = `'${email}' 관리자를 등록했습니다.${authNote}`;
    ["admin-email", "admin-pw", "admin-memo"].forEach((id) => (document.getElementById(id).value = ""));
  } catch (e) { out.style.color = ""; out.textContent = "추가 실패: " + e.message; }
}

// 보조 앱 인스턴스로 Auth 사용자 생성. 반환: 신규생성 true / 이미존재 false. (다른 오류는 throw)
async function createAuthUser(email, pw) {
  // 현재 접속 중인 기관의 프로젝트에 계정 생성(기관 전환 시에도 올바른 프로젝트 대상).
  const secondary = initializeApp(activeConfig, "admin-create-" + Date.now());
  const secAuth = getAuth(secondary);
  try {
    await createUserWithEmailAndPassword(secAuth, email, pw);
    return true;
  } catch (e) {
    if (e.code === "auth/email-already-in-use") return false;
    throw e;
  } finally {
    await signOut(secAuth).catch(() => {});
    await deleteApp(secondary).catch(() => {});
  }
}

// ── 관리자 목록(편집/삭제) ──
function subscribe() {
  if (unsub) unsub();
  unsub = onSnapshot(collection(db, "admins"), (snap) => {
    const list = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.email.localeCompare(b.email));
    render(list);
  }, () => { document.getElementById("admin-tbody").innerHTML = `<tr><td colspan="6" class="empty">목록을 불러오지 못했습니다.</td></tr>`; });
}

// 계정별 허용 탭 셀. tabs 필드가 없으면 '전체 허용'(기존 계정 호환).
function tabCell(a, master) {
  const cur = Array.isArray(a.tabs) ? a.tabs : null;
  if (!master) {
    return cur === null ? "전체" : (cur.length
      ? escapeHtml(ASSIGNABLE_TABS.filter((t) => cur.includes(t.id)).map((t) => t.label).join(", "))
      : "<span class='warn'>없음</span>");
  }
  const boxes = ASSIGNABLE_TABS.map((t) =>
    `<label class="tabchk"><input type="checkbox" class="a-tab" value="${t.id}"${cur && cur.includes(t.id) ? " checked" : ""}> ${escapeHtml(t.label)}</label>`
  ).join("");
  return `<details class="tabperm"><summary>${cur === null ? "전체 허용" : `${cur.length}개 탭`}</summary>
      <label class="tabchk all"><input type="checkbox" class="a-taball"${cur === null ? " checked" : ""}> <b>전체 허용</b></label>
      <div class="tabchk-grid">${boxes}</div>
    </details>`;
}

function render(list) {
  const tbody = document.getElementById("admin-tbody");
  tbody.innerHTML = "";
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty">등록된 관리자가 없습니다. (부트스트랩 관리자는 보안규칙에 고정)</td></tr>`;
    return;
  }
  for (const a of list) {
    const tr = document.createElement("tr");
    const when = a.addedAtMs ? new Date(a.addedAtMs).toLocaleDateString("ko-KR") : "";
    const master = isMasterMode();
    const roleCell = master
      ? `<select class="a-role">
           <option value="admin"${a.role !== "master" ? " selected" : ""}>일반 관리자</option>
           <option value="master"${a.role === "master" ? " selected" : ""}>마스터 관리자</option>
         </select>`
      : (a.role === "master" ? "마스터 관리자" : "일반 관리자");
    tr.innerHTML = `
      <td>${escapeHtml(a.email)}</td>
      <td>${roleCell}</td>
      <td><input class="a-memo" value="${escapeHtml(a.memo || "")}" placeholder="메모"></td>
      <td>${tabCell(a, master)}</td>
      <td>${escapeHtml(when)}</td>
      <td class="actions">
        <button type="button" class="a-save">저장</button>
        <button type="button" class="a-reset">재설정메일</button>
        ${master ? `<button type="button" class="del a-del">삭제</button>` : ""}
      </td>`;
    tr.querySelector(".a-save").addEventListener("click", async () => {
      const patch = { memo: tr.querySelector(".a-memo").value.trim() };
      const roleSel = tr.querySelector(".a-role");
      if (roleSel) patch.role = roleSel.value; // 역할 변경은 마스터만(규칙에서도 차단).
      // 탭 권한(마스터만 편집). '전체 허용' 체크 시 tabs 필드를 제거해 제한 없음으로 둔다.
      const allBox = tr.querySelector(".a-taball");
      if (allBox) {
        patch.tabs = allBox.checked
          ? deleteField()
          : [...tr.querySelectorAll(".a-tab:checked")].map((c) => c.value);
      }
      try { await updateDoc(doc(db, "admins", a.id), patch); alert("저장했습니다."); }
      catch (e) { alert("저장 실패: " + e.message); }
    });
    // '전체 허용' 체크 시 개별 탭 선택 비활성화.
    const allBox = tr.querySelector(".a-taball");
    if (allBox) {
      const sync = () => tr.querySelectorAll(".a-tab").forEach((c) => { c.disabled = allBox.checked; });
      allBox.addEventListener("change", sync);
      sync();
    }
    tr.querySelector(".a-reset").addEventListener("click", async () => {
      if (!confirm(`${a.email} 로 비밀번호 재설정 메일을 보낼까요?`)) return;
      try { await sendPasswordResetEmail(auth, a.email); alert("재설정 메일을 보냈습니다."); }
      catch (e) { alert("메일 발송 실패: " + e.message); }
    });
    tr.querySelector(".a-del")?.addEventListener("click", async () => {
      // 이메일 대소문자 무관하게 본인 판정(Auth는 가입 시 표기를 보존).
      if ((a.email || "").toLowerCase() === (auth.currentUser?.email || "").toLowerCase()) {
        return alert("본인 계정은 이 목록에서 삭제할 수 없습니다.");
      }
      if (!confirm(`'${a.email}'의 관리자 권한을 회수합니다.\n(Auth 계정 자체는 남아 있으며, 완전 삭제는 Firebase 콘솔에서 처리)\n계속할까요?`)) return;
      try { await deleteDoc(doc(db, "admins", a.id)); }
      catch (e) { alert("삭제 실패: " + e.message); }
    });
    tbody.appendChild(tr);
  }
}
