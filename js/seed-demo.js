// 심사·시연용 모의데이터 생성(공공 AI 대전환 챌린지 등 외부 심사용 데모 기관 전용).
// 운영 데이터와 섞이지 않도록 '추가 기관(별도 Firebase 프로젝트)'이고 '비어 있을 때'만 실행한다.
// 강사·과정·설문 응답은 모두 가상이며 실존 인물·기관과 무관하다(개인정보 없음).
// 날짜는 실행 시점 기준 지난달~3개월 뒤로 만든다 — 언제 실행해도 '지난달 보고서'와
// '앞으로의 공개 보드'가 함께 채워진다.
import {
  collection, getDocs, doc, writeBatch, setDoc, Timestamp, query, limit,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db, currentOrg } from "./firebase.js";
import { SEED_ROOMS, SEED_PROGRAMS, SEED_FEE_RATES, SEED_TRAVEL_RATES } from "./seed-data.js";
import { regenerateSurvey } from "./survey-gen.js";

// ── 결정적 난수(같은 날 다시 만들어도 같은 데이터) ──
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

// 가상 강사(이름·소속 모두 가상). 강사유형·여비기준은 기준표 키와 일치해야 집계된다.
const DEMO_INSTRUCTORS = [
  ["한서진", "가상교육훈련센터", "본사/김포", "전임교관", "차장"],
  ["오세린", "가상교육훈련센터", "본사/김포", "전임교관", "과장"],
  ["강도윤", "가상교육훈련센터", "본사/김포", "전임교관", "대리"],
  ["임태오", "가상교육훈련센터", "본사/김포", "전임교관", "대리"],
  ["윤하람", "가상공항 보안운영부", "본사/김포", "사내강사", "부장"],
  ["서지안", "가상공항 보안계획부", "본사/김포", "사내강사", "차장"],
  ["문채윤", "가상공항 보안장비부", "사외 - 시내", "사내강사", "과장"],
  ["배준서", "가상공항 운영단", "부 산", "사내강사", "팀장"],
  ["노가온", "가상보안연구원", "사외 - 시내", "사외-비대상(경력10년↑)", "연구위원"],
  ["류시우", "가상보안컨설팅", "사외 - 시외", "사외-비대상(경력20년↑)", "대표"],
  ["진다온", "가상경찰청 대테러과", "사외 - 시내", "사외-청탁(5급 이하/직원)", "경위"],
  ["표은재", "가상대학교 보안학과", "사외 - 시외", "사외-비대상(기타)", "교수"],
];
// 커리큘럼의 강사구분 → 배정할 강사유형 묶음.
const KIND_POOL = {
  "전임교관": (t) => t === "전임교관",
  "사내교관": (t) => t === "사내강사",
  "사외교관": (t) => t.startsWith("사외"),
  "사내/사외교관": (t) => t === "사내강사" || t.startsWith("사외"),
};

// 차수로 만들 커리큘럼(일수가 정해져 있고 시간표가 있는 과정만).
const DEMO_PROGRAMS = [
  "보안검색요원 초기과정", "보안검색요원 정기과정", "보안검색감독자 초기과정",
  "항공경비요원 초기과정", "행동탐지요원 초기과정", "행동탐지요원 정기과정",
  "항공보안장비 유지보수요원 정기과정", "공항보안 감독자 초/정기과정",
];

// 가상 주관식 응답(일부러 이름·연락처가 섞인 문장 포함 — AI 분석 전 가림 처리 시연용).
const FREE_DIS = [
  "실습 시간이 부족했습니다.", "강의실 냉방이 너무 강했어요.", "교재 글씨가 작아 읽기 어려웠습니다.",
  "CBT 실습 PC가 느려서 대기 시간이 길었습니다.", "점심 이후 이론 수업이 연달아 있어 집중이 어려웠어요.",
  "주차 공간이 부족합니다.", "휴게 공간이 좁아요.", "없음", "없습니다.",
  "김민수 강사님 설명이 빨라서 따라가기 힘들었어요.", "자료 요청은 010-1234-5678로 연락 주세요.",
];
const FREE_SUG = [
  "판독 실습 비중을 늘려 주세요.", "최신 위협 사례를 더 다뤄 주면 좋겠습니다.", "교재를 PDF로도 제공해 주세요.",
  "현장 견학 프로그램이 있으면 좋겠습니다.", "조별 토의 시간을 늘려 주세요.", "쉬는 시간을 10분 더 주세요.",
  "모의 평가 문제를 미리 풀어볼 수 있게 해 주세요.", "좋은 교육 감사합니다.", "없음",
];

const pad = (n) => String(n).padStart(2, "0");
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// 주말을 건너뛰어 n번째 평일.
function addWorkdays(d, n) {
  const r = new Date(d);
  let left = n;
  while (left > 0) { r.setDate(r.getDate() + 1); if (r.getDay() !== 0 && r.getDay() !== 6) left--; }
  return r;
}
function firstWorkdayOnOrAfter(d) {
  const r = new Date(d);
  while (r.getDay() === 0 || r.getDay() === 6) r.setDate(r.getDate() + 1);
  return r;
}

// 운영 데이터 보호: 추가 기관이면서, 핵심 컬렉션이 모두 비어 있어야 한다.
async function assertEmptyDemoTarget() {
  if (!currentOrg) throw new Error("기본 기관에서는 실행할 수 없습니다. 심사용 데모 기관으로 접속하세요.");
  for (const name of ["courses", "sessions", "instructors", "surveyResponses"]) {
    const snap = await getDocs(query(collection(db, name), limit(1)));
    if (!snap.empty) throw new Error(`이미 '${name}' 데이터가 있습니다. 빈 데모 기관에서만 실행할 수 있습니다.`);
  }
}

// 큰 쓰기는 450건 단위로 나눠 커밋(배치 한도 500).
async function commitAll(writes, log) {
  for (let i = 0; i < writes.length; i += 450) {
    const b = writeBatch(db);
    for (const [ref, data] of writes.slice(i, i + 450)) b.set(ref, data);
    await b.commit();
    log(`  …${Math.min(i + 450, writes.length)}/${writes.length}`);
  }
}

export async function seedDemo(log = () => {}) {
  await assertEmptyDemoTarget();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const R = rng(Number(ymd(today).replace(/-/g, "")));
  const pick = (arr) => arr[Math.floor(R() * arr.length)];
  const between = (a, b) => a + Math.floor(R() * (b - a + 1));

  // 1) 기준값·강의실·커리큘럼·강사
  log("기준값·강의실·커리큘럼·강사 등록");
  await setDoc(doc(db, "settings", "feeRates"), { rates: SEED_FEE_RATES });
  await setDoc(doc(db, "settings", "travelRates"), { rates: { ...SEED_TRAVEL_RATES, "여비 없음": { amount: 0, manual: false } } });
  const rooms = SEED_ROOMS.map((r) => ({ ref: doc(collection(db, "rooms")), data: r }));
  const programs = SEED_PROGRAMS.map((p) => ({ ref: doc(collection(db, "programs")), data: p }));
  const instructors = DEMO_INSTRUCTORS.map(([name, affiliation, travelBasis, instructorType, position]) => ({
    ref: doc(collection(db, "instructors")),
    data: { name, affiliation, travelBasis, instructorType, position, careerYears: null, careerDetail: "가상 데이터" },
  }));
  await commitAll([...rooms, ...programs, ...instructors].map((x) => [x.ref, x.data]), log);

  // 2) 차수: 지난달 1일 ~ 3개월 뒤 말일, 주 1~2개.
  log("차수·시간표 생성");
  const start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
  const end = new Date(today.getFullYear(), today.getMonth() + 3, 0);
  const roundOf = {};
  const courses = [];
  const sessionWrites = [];
  const classrooms = rooms.filter((r) => /강의실|실습실/.test(r.data.name));
  for (let d = firstWorkdayOnOrAfter(start); d <= end; d = firstWorkdayOnOrAfter(addWorkdays(d, between(2, 4)))) {
    const progName = pick(DEMO_PROGRAMS);
    const prog = programs.find((p) => p.data.name === progName);
    if (!prog || !prog.data.totalDays) continue;
    const startDate = new Date(d);
    const endDate = addWorkdays(startDate, prog.data.totalDays - 1);
    const room = pick(classrooms.length ? classrooms : rooms);
    roundOf[progName] = (roundOf[progName] || between(20, 80)) + 1;
    const past = endDate < today;
    const cap = pick([20, 24, 30]);
    const applied = past ? between(Math.floor(cap * 0.6), cap) : between(0, cap);
    const courseType = prog.data.category === "초/정기" ? "초정기통합" : prog.data.category;
    const c = {
      ref: doc(collection(db, "courses")),
      data: {
        code: "", name: progName.replace(/과정$/, "").trim(), capacity: cap,
        startDate: ymd(startDate), endDate: ymd(endDate),
        venue: room.data.name, venueRoomId: room.ref.id, round: roundOf[progName],
        programId: prog.ref.id, courseType, operationTag: "", surveySetId: "",
        appliedCount: applied, completedCount: past ? Math.max(0, applied - between(0, 2)) : 0,
        hasEvaluation: courseType !== "초정기통합", planned: startDate > addWorkdays(today, 40), hidden: false,
      },
    };
    courses.push(c);
    // 시간표: 커리큘럼의 일차·시각대로, 강사는 강사구분에 맞는 가상 강사 중에서.
    for (const s of prog.data.subjects || []) {
      const date = ymd(addWorkdays(startDate, (s.dayNo || 1) - 1));
      const fits = KIND_POOL[s.teacherKind] || (() => false);
      const pool = instructors.filter((i) => fits(i.data.instructorType));
      const inst = /교육\s*등록|설문|수료/.test(s.subject) ? null : (pool.length ? pick(pool) : null);
      sessionWrites.push([doc(collection(db, "sessions")), {
        courseId: c.ref.id, date, subject: s.subject, startTime: s.startTime, endTime: s.endTime,
        room: room.data.name, instructor: inst ? inst.data.name : "", instructorId: inst ? inst.ref.id : "",
        teacherKind: s.teacherKind || "",
      }]);
    }
  }
  await commitAll([...courses.map((c) => [c.ref, c.data]), ...sessionWrites], log);

  // 3) 공개 설문 정의 + 끝난 차수의 익명 응답
  log("설문 정의·응답 생성");
  const responseWrites = [];
  const expireAt = Timestamp.fromDate(new Date(Date.now() + 180 * 24 * 3600 * 1000));
  for (const c of courses) {
    const survey = await regenerateSurvey({ ...c.data, id: c.ref.id }, c.data.venueRoomId);
    if (!survey || new Date(c.data.endDate) >= today) continue;
    const n = Math.round(c.data.appliedCount * (0.6 + R() * 0.3));
    const skew = R() < 0.25 ? 0.8 : 0; // 일부 차수는 만족도가 낮게 — 차수 간 비교가 보이도록.
    const score = () => Math.max(1, Math.min(5, 5 - Math.floor(R() * (2 + skew * 2))));
    for (let k = 0; k < n; k++) {
      const edu = {};
      survey.eduItems.forEach((_, i) => { edu[`q${i}`] = score(); });
      const insts = (survey.instructorTargets || []).map((t) => {
        const rec = { instructorId: t.instructorId, subject: t.subject, instructorName: t.instructorName };
        survey.instructorItems.forEach((_, i) => { rec[`q${i}`] = score(); });
        return rec;
      });
      responseWrites.push([doc(collection(db, "surveyResponses")), {
        courseId: c.ref.id, courseType: c.data.courseType, roomId: c.data.venueRoomId,
        collectedDate: c.data.endDate, collectedAt: `${c.data.endDate} 17:${pad(between(0, 50))}`,
        edu, instructors: insts,
        eduItems: survey.eduItems, instructorItems: survey.instructorItems, scale: 5,
        freeDissatisfied: R() < 0.45 ? pick(FREE_DIS) : "",
        freeSuggestion: R() < 0.45 ? pick(FREE_SUG) : "",
        expireAt,
      }]);
    }
  }
  await commitAll(responseWrites, log);

  // 4) 지난달 소요경비(수동 입력분) — 운영 보고서 9번이 채워지도록.
  const lastMonth = `${start.getFullYear()}-${pad(start.getMonth() + 1)}`;
  await setDoc(doc(db, "expenses", lastMonth), {
    materialResearch: 240000, supplies: between(30, 60) * 10000, refreshments: between(20, 40) * 10000, custom: [],
  });

  // 5) 현장 안내(대관) 몇 건
  const rentalWrites = [0, 3, 8].map((off) => {
    const d = ymd(addWorkdays(today, off));
    return [doc(collection(db, "rentals")), {
      name: pick(["가상공항 보안협의회", "신입직원 보안 오리엔테이션", "보안장비 시연회"]),
      startDate: d, endDate: d, startTime: "14:00", endTime: "16:00",
      venue: pick(rooms).data.name, note: "", hidden: false, updatedAtMs: Date.now(),
    }];
  });
  await commitAll(rentalWrites, log);

  // 데모 표식 — 화면에 '심사용 모의데이터' 안내를 띄우는 데 쓴다.
  await setDoc(doc(db, "settings", "demoMode"), { enabled: true, seededAt: ymd(today) });
  await seedDemoQuiz();

  return {
    instructors: instructors.length, courses: courses.length, sessions: sessionWrites.length,
    responses: responseWrites.length, reportMonth: lastMonth,
  };
}

// 시연용 샘플 퀴즈 1세트(퀴즈 배틀). 일반 상식 수준의 항공보안 문항 — 실제 평가 문항 아님.
const DEMO_QUIZ = {
  id: "demo-quiz", title: "[데모] 항공보안 기본 상식",
  questions: [
    { type: "mc", text: "항공기 객실 반입이 금지되는 물품은?", choices: ["노트북", "칼날 6cm 이상 칼", "휴대폰", "책"], answers: [1], points: "standard", timeLimit: 20, explain: "날붙이류는 객실 반입이 제한됩니다." },
    { type: "ox", text: "액체류는 100ml 이하 용기에 담아 1L 투명 지퍼백 1개까지 객실 반입할 수 있다.", answers: [0], points: "standard", timeLimit: 20 },
    { type: "mc", text: "보안검색 시 X-ray 판독 대상이 아닌 것은?", choices: ["휴대 수하물", "위탁 수하물", "승객의 탑승권 QR", "화물"], answers: [2], points: "standard", timeLimit: 20 },
    { type: "poll", text: "오늘 교육에서 가장 유익했던 부분은?", choices: ["이론", "실습", "사례 분석", "토론"], answers: [0], points: "none", timeLimit: 20 },
    { type: "short", text: "공항 보호구역 출입 시 패용해야 하는 것은? (두 글자)", accepted: ["출입증"], answers: [0], points: "double", timeLimit: 30 },
  ],
};
export async function seedDemoQuiz() {
  if (!currentOrg) throw new Error("기본 기관에서는 실행하지 않습니다.");
  const qs = DEMO_QUIZ.questions.map((q) => ({
    choices: ["", "", "", ""], accepted: [], shuffle: false, media: null, body: "", explain: "", ...q,
  }));
  await setDoc(doc(db, "quizzes", DEMO_QUIZ.id), { ...DEMO_QUIZ, questions: qs });
}

// 데이터 관리 탭의 '초기 데이터' 아래에 섹션을 붙인다. 기본 기관에서는 만들지 않는다
// (실수 방지 1차). 실행 시 추가 기관이면서 비어 있는지 다시 확인한다(2차).
export function initSeedDemo() {
  const anchor = document.getElementById("seed-log");
  if (!anchor || !currentOrg) return;
  const box = document.createElement("div");
  box.innerHTML = `
    <h3>심사·시연용 모의데이터</h3>
    <p class="hint">외부 심사·시연용 <b>데모 기관</b>에 가상 강사·차수·시간표·설문 응답을 한 번에 만듭니다.
      실존 인물·기관과 무관한 가상 데이터이며, <b>추가 기관이면서 비어 있을 때만</b> 실행됩니다(운영 기관에서는 거부).
      날짜는 실행일 기준 지난달~3개월 뒤로 만들어집니다.</p>
    <div class="form-actions"><button id="seed-demo-btn" type="button">모의데이터 생성</button>
      <button id="seed-demo-quiz-btn" type="button">샘플 퀴즈 추가</button></div>
    <pre id="seed-demo-log" class="seed-log"></pre>`;
  anchor.after(box);
  const btn = box.querySelector("#seed-demo-btn");
  const out = box.querySelector("#seed-demo-log");
  box.querySelector("#seed-demo-quiz-btn").addEventListener("click", async () => {
    try { await seedDemoQuiz(); out.textContent = "샘플 퀴즈 '[데모] 항공보안 기본 상식'을 추가했습니다(퀴즈 화면에서 확인)."; }
    catch (e) { out.textContent = "샘플 퀴즈 추가 실패: " + (e.message || e); }
  });
  btn.addEventListener("click", async () => {
    const typed = prompt(
      "심사·시연용 모의데이터를 이 기관에 생성합니다.\n" +
      "가상 강사·차수·시간표·설문 응답이 수백 건 만들어집니다(빈 기관에서만 실행됨).\n\n" +
      "계속하려면 '모의데이터'라고 입력하세요.");
    if (typed !== "모의데이터") return;
    btn.disabled = true;
    out.textContent = "";
    const log = (m) => { out.textContent += m + "\n"; };
    try {
      const r = await seedDemo(log);
      log(`\n완료 — 강사 ${r.instructors}명, 차수 ${r.courses}개, 시간표 ${r.sessions}건, 설문 응답 ${r.responses}건.`);
      log(`운영 보고서는 ${r.reportMonth}을(를) 선택해 확인하세요. 페이지를 새로고침하면 목록에 반영됩니다.`);
    } catch (e) {
      log("중단: " + (e.message || e));
    } finally {
      btn.disabled = false;
    }
  });
}
