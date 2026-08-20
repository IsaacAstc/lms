/* 로지보드 FCM 백그라운드 푸시 서비스워커.
 * Firebase 설정은 커밋하지 않으므로(기관별 상이) 등록 시 URL 쿼리로 전달받는다:
 *   navigator.serviceWorker.register("firebase-messaging-sw.js?config=<encodeURIComponent(JSON)>")
 * 발송은 notification 페이로드라 표시 자체는 FCM SDK가 처리한다. */
/* global firebase, importScripts */
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");

try {
  const cfg = JSON.parse(new URL(self.location.href).searchParams.get("config") || "null");
  if (cfg && cfg.apiKey) {
    firebase.initializeApp(cfg);
    firebase.messaging();
  }
} catch (e) { /* 설정 누락 시 푸시만 비활성 */ }
// 알림 클릭 이동은 발송 시 webpush.fcmOptions.link 로 FCM SDK가 처리한다.
