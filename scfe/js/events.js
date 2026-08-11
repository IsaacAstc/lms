// =====================================================================
// 행사(세션) 공통 정의 — 참가자 앱(app.js)과 관리자 앱(admin.js)이 함께 사용
//
// 하나의 배포로 여러 행사를 운영하기 위한 개념.
//   - 각 행사는 events 컬렉션의 문서 하나
//   - 참가자 문서(participants)는 eventId로 소속 행사를 가짐
//   - 행사별 QR은 ?event=<행사ID> 파라미터로 구분
// =====================================================================

// 참가자용 URL에서 행사를 지정하는 쿼리 파라미터 이름
export const EVENT_PARAM = "event";

// eventId가 없는 과거 참가자 데이터(행사 기능 도입 이전)를 묶는 가상 행사 ID.
// 실제 events 문서로 존재하지 않으며, 화면에서만 "기본(이전 데이터)"으로 표시된다.
export const LEGACY_EVENT_ID = "legacy";
export const LEGACY_EVENT_NAME = "기본 (이전 데이터)";

// 행사에서 사용할 미션 번호와 순서. 미설정이면 기본 3개 전부.
export const DEFAULT_MISSION_ORDER = [1, 2, 3];

// 저장된 missionOrder를 안전하게 정리 (유효 번호만, 중복 제거, 비면 기본값)
export function normalizeMissionOrder(raw) {
  if (!Array.isArray(raw)) return [...DEFAULT_MISSION_ORDER];
  const out = [];
  raw.forEach((v) => {
    const n = Number(v);
    if ([1, 2, 3].includes(n) && !out.includes(n)) out.push(n);
  });
  return out.length ? out : [...DEFAULT_MISSION_ORDER];
}

// "1,3" 형태의 입력을 배열로 파싱 (관리자 화면용). 잘못된 값이면 null.
export function parseMissionOrder(text) {
  const parts = String(text || "")
    .split(/[,\s]+/)
    .filter(Boolean);
  if (parts.length === 0) return null;
  const out = [];
  for (const p of parts) {
    const n = Number(p);
    if (![1, 2, 3].includes(n) || out.includes(n)) return null; // 범위 밖 또는 중복
    out.push(n);
  }
  return out;
}

// 행사 일정 문자열은 <input type="datetime-local"> 값(예: "2026-08-01T09:00")을
// 그대로 저장한다. 현장 기기의 로컬 시각 기준으로 비교한다.
function toDate(v) {
  if (!v) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d;
}

// 지금 이 행사가 참가 가능한 상태인지 판정.
// 반환: { open: boolean, reason: "before" | "after" | null }
export function getEventOpenState(ev, now = new Date()) {
  if (!ev) return { open: true, reason: null }; // 행사 미설정(레거시)이면 항상 개방
  const start = toDate(ev.startAt);
  const end = toDate(ev.endAt);
  if (start && now < start) return { open: false, reason: "before" };
  if (end && now > end) return { open: false, reason: "after" };
  return { open: true, reason: null };
}

// 일정을 사람이 읽는 짧은 문자열로 (예: "8/1 09:00 ~ 8/4 18:00")
export function formatEventPeriod(ev) {
  const start = toDate(ev && ev.startAt);
  const end = toDate(ev && ev.endAt);
  if (!start && !end) return "상시";
  const fmt = (d) =>
    `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(
      d.getMinutes()
    ).padStart(2, "0")}`;
  if (start && end) return `${fmt(start)} ~ ${fmt(end)}`;
  if (start) return `${fmt(start)} ~`;
  return `~ ${fmt(end)}`;
}
