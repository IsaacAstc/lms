// ===================================================================
// LMS 통합 후: LMS의 Firebase 프로젝트 설정을 그대로 사용한다.
// (js/firebase-config.js 는 배포 시 GitHub Actions Secrets 로 생성됨)
// 로그인 세션도 LMS 관리자 화면과 공유된다(같은 프로젝트·같은 도메인).
// ===================================================================
export { firebaseConfig } from "../../js/firebase-config.js";

// App Check 는 LMS 통합 시 제거했다(LMS 프로젝트에는 reCAPTCHA 미등록).
// 호출부(app.js/admin.js) 수정을 최소화하기 위해 시그니처만 유지한다.
export function setupAppCheck() {
  return null;
}
