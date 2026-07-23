// 시각 유틸 — 시스템 전 구간 Asia/Seoul(UTC+09:00) 기준.

// KST 로컬 일시(date 'YYYY-MM-DD', time 'HH:MM')를 절대 시각(epoch ms)으로.
export function kstToMs(date, time) {
  if (!date) return NaN;
  return Date.parse(`${date}T${time || "00:00"}:00+09:00`);
}

// epoch ms → KST 표시 문자열 'YYYY-MM-DD HH:MM'.
export function fmtKst(ms) {
  if (!ms && ms !== 0) return "";
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Seoul",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).format(new Date(ms));
  return parts.replace("T", " ").replace(",", "");
}

// 오늘의 KST 날짜 'YYYY-MM-DD'.
export function kstToday() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
}

export const HOUR_MS = 3600 * 1000;
