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
export const hubApp = initializeApp(firebaseConfig, "hub");
export const hubDb = getFirestore(hubApp);

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
    const snap = await getDoc(doc(hubDb, "orgs", urlOrg));
    const d = snap.exists() ? snap.data() : null;
    if (d && d.active !== false && d.config?.apiKey) {
      org = { id: urlOrg, name: d.name || urlOrg };
      cfg = d.config;
    }
  } catch { /* 허브 조회 실패 → 기본 기관으로 동작 */ }
} else {
  const s = storedOrg();
  if (s?.config?.apiKey) {
    org = { id: s.id, name: s.name || s.id };
    cfg = s.config;
  }
}

// 현재 기관. null = 기본(허브) 기관.
export const currentOrg = org;
// 현재 기관의 설정값(관리자 계정 생성용 보조 앱 등에서 재사용).
export const activeConfig = cfg;

// 기관 전환: 선택을 저장하고 새로고침(전체 재초기화). o = {id, name, config} 또는 null(기본 기관).
export function switchOrg(o) {
  if (o) localStorage.setItem(ORG_LS_KEY, JSON.stringify({ id: o.id, name: o.name, config: o.config }));
  else localStorage.removeItem(ORG_LS_KEY);
  location.reload();
}

const app = initializeApp(cfg);
export const db = getFirestore(app);
export const auth = getAuth(app);
