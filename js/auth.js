// 관리자 인증 게이트.
import {
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { auth } from "./firebase.js";

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
