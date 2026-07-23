// 시스템 공용 상수.

// 강의실 기본 목록 (최초 시드용). 실제 운영은 rooms 컬렉션에서 관리.
export const DEFAULT_ROOMS = [
  "A강의실",
  "B강의실",
  "C강의실",
  "D강의실",
  "CBT실습실",
  "X-ray실습실",
  "온라인스튜디오",
];

// 강사 유형 (강사료 기준 키). 계산 엑셀 기준 9종.
export const INSTRUCTOR_TYPES = [
  "사내강사",
  "전임교관",
  "사외-청탁(장차관/기관장)",
  "사외-청탁(4급 이상/임원)",
  "사외-청탁(5급 이하/직원)",
  "사외-비대상(경력30년↑)",
  "사외-비대상(경력20년↑)",
  "사외-비대상(경력10년↑)",
  "사외-비대상(기타)",
];

// 교관 유형 (커리큘럼 과목의 담당 교관 구분).
export const TEACHER_KINDS = ["전임교관", "사내교관", "사외교관"];

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
