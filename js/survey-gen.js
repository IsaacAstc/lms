// 공개 설문 정의 생성/갱신 (publicSurveys/{courseId}).
// 서버리스: 시간표 등록/수정 시 이 문서를 만들고, 공개 페이지가 KST 시각으로 노출 여부 판정.
import {
  collection, getDocs, query, where, doc, setDoc, deleteDoc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./firebase.js";
import { kstToMs, HOUR_MS } from "./time.js";

// 교육만족도 6문항 / 강사만족도 3문항 (CLAUDE.md 2-1, 5점 척도).
export const EDU_ITEMS = [
  "현업(현장) 활용여부",
  "전문지식 향상여부",
  "교육내용",
  "교재/기타 강의자재",
  "담당직원 교육 준비성",
  "강의실 쾌적성/청결성",
];
export const INSTRUCTOR_ITEMS = [
  "강의준비 및 강의능력",
  "질의응답 성실도",
  "전반적인 교육만족도",
];
// 강사만족도에서 제외할 과목명 패턴(첫/마지막 과목 안전장치).
const EXCLUDE_PATTERNS = [/교육\s*등록/, /평가/, /설문/, /수료/];

// 노출 창: 종료 2시간 전 ~ 종료 후 6시간.
const OPEN_BEFORE_MS = 2 * HOUR_MS;
const CLOSE_AFTER_MS = 6 * HOUR_MS;

// 과정+세션으로 공개 설문 정의 객체 생성. roomId 없거나 세션 없으면 null.
export function buildSurvey(course, sessions, roomId) {
  if (!roomId) return null;
  const sorted = [...sessions].sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
  if (!sorted.length) return null;
  const last = sorted[sorted.length - 1];
  const endMs = kstToMs(last.date, last.endTime);
  if (!endMs) return null;

  // 강사만족도 대상: 첫/마지막 세션 및 제외 패턴 제외 + 강사 지정된 세션. (강사×과목) 단위.
  const seen = new Set();
  const instructorTargets = [];
  sorted.forEach((s, idx) => {
    if (idx === 0 || idx === sorted.length - 1) return;
    if (!s.instructorId || !s.instructor) return;
    if (EXCLUDE_PATTERNS.some((p) => p.test(s.subject || ""))) return;
    const key = `${s.instructorId}|${s.subject}`;
    if (seen.has(key)) return;
    seen.add(key);
    instructorTargets.push({ key, subject: s.subject, instructorId: s.instructorId, instructorName: s.instructor });
  });

  return {
    courseId: course.id,
    courseName: course.name || "",
    courseType: course.courseType || "",
    roomId,
    roomName: course.venue || "",
    openMs: endMs - OPEN_BEFORE_MS,
    closeMs: endMs + CLOSE_AFTER_MS,
    endMs,
    scale: 5,
    eduItems: EDU_ITEMS,
    instructorItems: INSTRUCTOR_ITEMS,
    instructorTargets,
    updatedAtMs: Date.now(),
  };
}

// 과정의 세션을 읽어 공개 설문 문서를 생성/갱신. 반환: survey 또는 null(스킵).
export async function regenerateSurvey(course, roomId) {
  if (!course?.id) return null;
  const snap = await getDocs(query(collection(db, "sessions"), where("courseId", "==", course.id)));
  const sessions = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const survey = buildSurvey(course, sessions, roomId);
  if (!survey) {
    // 생성 조건 미충족: 기존 문서 있으면 제거.
    await deleteDoc(doc(db, "publicSurveys", course.id)).catch(() => {});
    return null;
  }
  await setDoc(doc(db, "publicSurveys", course.id), survey);
  return survey;
}
