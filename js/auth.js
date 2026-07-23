// 관리자 인증 게이트.
import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getDoc, doc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { auth, db } from "./firebase.js";

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
