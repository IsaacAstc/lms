// 시스템 공용 상수.

// 강의실 고정 목록 (7개 공간).
export const ROOMS = [
  "A강의실",
  "B강의실",
  "C강의실",
  "D강의실",
  "CBT실습실",
  "X-ray실습실",
  "온라인스튜디오",
];

// 시각 드롭다운 옵션 생성 (10분 간격).
// 시작시각: 09:00 ~ 17:00, 종료시각: 09:50 ~ 17:50
function buildTimes(startHour, startMin, endHour, endMin, stepMin) {
  const times = [];
  let t = startHour * 60 + startMin;
  const end = endHour * 60 + endMin;
  while (t <= end) {
    const h = String(Math.floor(t / 60)).padStart(2, "0");
    const m = String(t % 60).padStart(2, "0");
    times.push(`${h}:${m}`);
    t += stepMin;
  }
  return times;
}

export const START_TIMES = buildTimes(9, 0, 17, 0, 10);
export const END_TIMES = buildTimes(9, 50, 17, 50, 10);
