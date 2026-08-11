// =====================================================================
// 서비스 워커 — PWA 설치 지원 + 앱 셸 오프라인 캐시
// 전략: 동일 출처 GET만 처리(네트워크 우선 → 실패 시 캐시).
//   - Firebase/Firestore/App Check/폰트 등 교차 출처와 비GET 요청은
//     가로채지 않으므로 데이터 통신·보안 검증에 영향을 주지 않는다.
//   - 부스는 상시 온라인이라 네트워크 우선으로 항상 최신본을 제공하고,
//     오프라인일 때만 캐시로 폴백한다.
// 배포로 정적 파일을 크게 바꿀 때는 CACHE 버전을 올린다.
// =====================================================================
const CACHE = "avsec-hero-v4";
const ASSETS = [
  "./",
  "./index.html",
  "./css/style.css",
  "./js/app.js",
  "./js/missions.js",
  "./js/firebase-config.js",
  "./js/events.js",
  "./js/mission-config.js",
  "./js/html2canvas.min.js",
  "./manifest.webmanifest",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // 쓰기(Firestore 등)는 건드리지 않음
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 교차 출처는 기본 네트워크 처리

  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE).then((cache) => cache.put(req, copy));
        return res;
      })
      .catch(() =>
        caches.match(req).then((cached) => cached || (req.mode === "navigate" ? caches.match("./index.html") : undefined))
      )
  );
});
