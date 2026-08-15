// 관리자 인증 게이트.
import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getDoc, doc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { auth, db } from "./firebase.js";
import { BOOTSTRAP_MASTERS } from "./constants.js";

// 관리자 여부 판정: 관리자 전용 문서 읽기를 시도해 보안규칙 허용 여부로 확인.
// (이메일 목록을 클라이언트에 중복하지 않고 firestore.rules의 판정과 항상 일치.)
// 문서가 없어도 규칙이 허용하면 성공(exists()=false), 거부되면 permission-denied 예외.
export async function isAdmin() {
  try {
    await getDoc(doc(db, "settings", "dataPolicy"));
    return true;
  } catch (e) {
    return false;
  }
}

// 마스터 관리자 여부(화면 표시용 — 실제 차단은 firestore.rules가 담당).
// 규칙과 동일 기준: 부트스트랩 마스터 목록 또는 admins 문서의 role === 'master'.
// 부트스트랩 목록은 규칙에 있어 클라이언트가 읽을 수 없으므로 constants에 표시용으로 둔다.
export async function isMaster() {
  const email = (auth.currentUser?.email || "").toLowerCase();
  if (!email) return false;
  if (BOOTSTRAP_MASTERS.includes(email)) return true;
  try {
    const d = await getDoc(doc(db, "admins", email));
    return d.exists() && d.data().role === "master";
  } catch { return false; }
}

// 내 계정에 허용된 탭 목록. null = 제한 없음(전체 허용 — 미지정 계정·부트스트랩).
// 실제 차단은 firestore.rules가 담당하고, 여기서는 화면 구성용으로 읽는다.
export async function myAllowedTabs() {
  const email = (auth.currentUser?.email || "").toLowerCase();
  if (!email || BOOTSTRAP_MASTERS.includes(email)) return null;
  try {
    const d = await getDoc(doc(db, "admins", email));
    const t = d.exists() ? d.data().tabs : null;
    return Array.isArray(t) ? t : null;
  } catch { return null; }
}

// 참관자(조회 전용) 여부. role === 'observer' — 모든 쓰기가 규칙에서 차단된다.
export async function isObserver() {
  const email = (auth.currentUser?.email || "").toLowerCase();
  if (!email || BOOTSTRAP_MASTERS.includes(email)) return false;
  try {
    const d = await getDoc(doc(db, "admins", email));
    return d.exists() && d.data().role === "observer";
  } catch { return false; }
}

// 로그인 상태에 따라 콜백 실행. (관리자 계정은 Firebase 콘솔에서 사전 생성)
export function watchAuth(onLogin, onLogout) {
  onAuthStateChanged(auth, (user) => {
    if (user) onLogin(user);
    else onLogout();
  });
}

export async function login(email, password) {
  await signInWithEmailAndPassword(auth, email, password);
}

export async function logout() {
  await signOut(auth);
}
