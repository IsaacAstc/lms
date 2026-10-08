// 기관별 Firebase 설정 해석(퀴즈·히어로 미션처럼 기본 기관에 고정돼 있던 독립 화면용).
// URL에 ?org=<기관ID>가 있으면 기본(허브) 프로젝트의 공개 문서 orgs/{id}에서 그 기관의
// config를 읽어 쓴다 — SDK 종류(compat/modular)와 무관하게 쓰도록 Firestore REST로 읽는다.
// 없거나 읽기 실패면 기본 기관 설정을 그대로 쓴다.
import { firebaseConfig as baseConfig } from "./firebase-config.js";

export const orgId = (new URLSearchParams(location.search).get("org") || "").trim();

function plain(v) {
  if (!v) return undefined;
  if ("stringValue" in v) return v.stringValue;
  if ("booleanValue" in v) return v.booleanValue;
  if ("mapValue" in v) {
    const o = {};
    for (const [k, x] of Object.entries(v.mapValue.fields || {})) o[k] = plain(x);
    return o;
  }
  return undefined;
}

async function resolve() {
  if (!orgId || !/^[A-Za-z0-9_-]{1,64}$/.test(orgId)) return baseConfig;
  try {
    const url = `https://firestore.googleapis.com/v1/projects/${baseConfig.projectId}`
      + `/databases/(default)/documents/orgs/${orgId}?key=${baseConfig.apiKey}`;
    const res = await fetch(url);
    if (!res.ok) return baseConfig;
    const f = (await res.json()).fields || {};
    const cfg = plain(f.config);
    if (plain(f.active) === false || !cfg || !cfg.apiKey) return baseConfig;
    return cfg;
  } catch { return baseConfig; }
}

export const firebaseConfig = await resolve();
// 기관 화면에서 만든 링크(QR 등)에 붙일 꼬리표.
export const orgParam = orgId && firebaseConfig !== baseConfig ? `org=${encodeURIComponent(orgId)}` : "";
