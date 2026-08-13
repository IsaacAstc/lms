// Firebase 초기화 및 공용 인스턴스 export.
// 기관(테넌트) 분리: 코드는 하나, 데이터는 기관별 Firebase 프로젝트.
// 기관 결정 우선순위: URL ?org= (공개 페이지 링크) > localStorage(관리자 선택) > 기본(허브).
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore, doc, getDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { firebaseConfig } from "./firebase-config.js";

export { firebaseConfig };

// 허브(기본 기관) 앱 — 기관 목록(orgs 컬렉션)은 항상 허브에 저장된다.
// 기관 config는 원래 공개값이라 공개 읽기여도 안전(실제 방어선은 각 프로젝트의 보안규칙).
// 주의: 이름 붙은 앱은 로그인 세션을 공유하지 않으므로(persistence 키에 앱 이름 포함)
// 기관 해석(공개 읽기) 전용으로만 쓰고, 허브 쓰기는 아래 hubDb(기본 앱)로 한다.
const resolverApp = initializeApp(firebaseConfig, "hub-resolver");
const resolverDb = getFirestore(resolverApp);

const ORG_LS_KEY = "lmsOrg";
function storedOrg() {
  try { return JSON.parse(localStorage.getItem(ORG_LS_KEY) || "null"); } catch { return null; }
}

let org = null;
let cfg = firebaseConfig;
const urlOrg = (new URLSearchParams(location.search).get("org") || "").trim();
if (urlOrg) {
  // 공개 페이지(현황 보드·설문) 링크: 허브의 orgs 레지스트리에서 해석.
  try {
    const snap = await getDoc(doc(resolverDb, "orgs", urlOrg));
    const d = snap.exists() ? snap.data() : null;
    if (d && d.active !== false && d.config?.apiKey) {
      org = { id: urlOrg, name: d.name || urlOrg, features: d.features };
      cfg = d.config;
    }
  } catch { /* 허브 조회 실패 → 기본 기관으로 동작 */ }
} else {
  const s = storedOrg();
  if (s?.config?.apiKey) {
    org = { id: s.id, name: s.name || s.id, features: s.features };
    cfg = s.config;
  }
}

// 현재 기관. null = 기본(허브) 기관.
export const currentOrg = org;
// 현재 기관의 설정값(관리자 계정 생성용 보조 앱 등에서 재사용).
export const activeConfig = cfg;

// 자동 새로고침 반복 방지: 세션 내 연속 3회를 넘으면 중단(설정 오류 등으로 인한 무한 루프 차단).
// 정상 기동 5초 후 카운터를 리셋한다.
export function guardedReload() {
  const n = Number(sessionStorage.getItem("orgReloadN") || 0);
  if (n >= 3) {
    console.warn("기관 전환 새로고침이 반복되어 중단합니다. 저장된 기관 선택을 초기화합니다.");
    localStorage.removeItem(ORG_LS_KEY);
    sessionStorage.removeItem("orgReloadN");
    return false;
  }
  sessionStorage.setItem("orgReloadN", String(n + 1));
  location.reload();
  return true;
}
setTimeout(() => sessionStorage.removeItem("orgReloadN"), 5000);

// 기관 전환: 선택을 저장하고 새로고침(전체 재초기화). o = {id, name, config, features} 또는 null(기본 기관).
export function switchOrg(o) {
  if (o) localStorage.setItem(ORG_LS_KEY, JSON.stringify({ id: o.id, name: o.name, config: o.config, features: o.features ?? null }));
  else localStorage.removeItem(ORG_LS_KEY);
  guardedReload() || location.reload();
}

const app = initializeApp(cfg);
export { app };
export const db = getFirestore(app);
export const auth = getAuth(app);

// 허브 DB 핸들:
//  - 기본 기관 접속 중이면 로그인된 기본 앱을 그대로 사용(orgs 쓰기에 인증 필요).
//  - 다른 기관 접속 중이면 해석용 허브 앱(비로그인 → 공개 읽기만 가능. 편집은 UI에서 차단).
export const hubDb = org ? resolverDb : db;
