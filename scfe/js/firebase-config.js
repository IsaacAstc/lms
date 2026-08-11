// ===================================================================
// Firebase 프로젝트 설정값
// README.md "1. Firebase 프로젝트 생성" 단계에서 발급받은 값을 아래에 그대로 붙여넣으세요.
// (Firebase 콘솔 > 프로젝트 설정 > 일반 > 내 앱 > SDK 설정 및 구성 > config)
// ===================================================================
import {
  initializeAppCheck,
  ReCaptchaV3Provider,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app-check.js";

export const firebaseConfig = {
  apiKey: "AIzaSyDxV5m8kyAiQORElcThHW3WKXwhZZo-ABs",
  authDomain: "exhibition-d3dca.firebaseapp.com",
  projectId: "exhibition-d3dca",
  storageBucket: "exhibition-d3dca.firebasestorage.app",
  messagingSenderId: "767535254962",
  appId: "1:767535254962:web:bcf4649fd20db2478768ab",
};

// ===================================================================
// App Check (reCAPTCHA v3) — 우리 앱에서 온 요청만 Firestore에 통과시킴.
// 사이트 키는 공개값이라 소스에 포함해도 안전 (비밀 키는 Firebase 콘솔에만 저장).
// ===================================================================
export const RECAPTCHA_SITE_KEY = "6Lew1lAtAAAAAGAhjGCEQxKC1caPFZAn5S0VG3sS";

export function setupAppCheck(app) {
  return initializeAppCheck(app, {
    provider: new ReCaptchaV3Provider(RECAPTCHA_SITE_KEY),
    isTokenAutoRefreshEnabled: true,
  });
}
