// 공개 설문 정의 생성/갱신 (publicSurveys/{courseId}).
// 서버리스: 시간표 등록/수정 시 이 문서를 만들고, 공개 페이지가 KST 시각으로 노출 여부 판정.
import {
  collection, getDocs, query, where, doc, setDoc, deleteDoc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./firebase.js";
import { kstToMs, HOUR_MS } from "./time.js";
import { getSurveyItemsAt } from "./settings.js";
import { DEFAULT_EDU_ITEMS, DEFAULT_INSTRUCTOR_ITEMS } from "./constants.js";

// 교육만족도 6문항 / 강사만족도 3문항 (CLAUDE.md 2-1, 5점 척도).
// 기본값은 constants에 두고 재export(설정 문항이 있으면 그것이 우선).
export const EDU_ITEMS = DEFAULT_EDU_ITEMS;
export const INSTRUCTOR_ITEMS = DEFAULT_INSTRUCTOR_ITEMS;
// 강사만족도에서 제외할 과목명 패턴(첫/마지막 과목 안전장치).
const EXCLUDE_PATTERNS = [/교육\s*등록/, /평가/, /설문/, /수료/];

// 이 소속의 강사는 설문에 개인 강사명 대신 기관명을 표시한다(기관 단위 평가).
export const ORG_AS_NAME = ["공항테러대책협의회"];
function displayInstructorName(session, inst) {
  const aff = (inst?.affiliation || "").trim();
  return ORG_AS_NAME.includes(aff) ? aff : session.instructor;
}

// 노출 창: 종료 2시간 전 ~ 종료 후 1시간.
const OPEN_BEFORE_MS = 2 * HOUR_MS;
const CLOSE_AFTER_MS = 1 * HOUR_MS;

// 과정+세션으로 공개 설문 정의 객체 생성. roomId 없거나 세션 없으면 null.
// instructorsById: { [id]: {affiliation, ...} } — 소속 기반 표시명 결정에 사용(없으면 세션의 강사명 사용).
export function buildSurvey(course, sessions, roomId, instructorsById = {}, itemsAt = null) {
  if (!roomId) return null;
  if (course?.hidden) return null; // 숨김 차수는 설문 비활성(기존 문서는 호출부에서 제거).
  const sorted = [...sessions].sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
  if (!sorted.length) return null;
  const last = sorted[sorted.length - 1];
  const endMs = kstToMs(last.date, last.endTime);
  if (!endMs) return null;
  // 문항: 설정의 발효일자 이력 우선, 없으면 현행 상수.
  const items = {
    eduItems: itemsAt?.eduItems?.length ? itemsAt.eduItems : EDU_ITEMS,
    instructorItems: itemsAt?.instructorItems?.length ? itemsAt.instructorItems : INSTRUCTOR_ITEMS,
  };

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
    instructorTargets.push({
      key, subject: s.subject, instructorId: s.instructorId,
      instructorName: displayInstructorName(s, instructorsById[s.instructorId]),
    });
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
    // 교육 종료일 기준으로 유효한 문항(설정에 개정 이력이 있으면 그 버전).
    eduItems: items.eduItems,
    instructorItems: items.instructorItems,
    instructorTargets,
    updatedAtMs: Date.now(),
  };
}

// 과정의 세션을 읽어 공개 설문 문서를 생성/갱신. 반환: survey 또는 null(스킵).
export async function regenerateSurvey(course, roomId) {
  if (!course?.id) return null;
  // 강사 소속(표시명 결정용)을 함께 조회 — 캐시 상태와 무관하게 동작.
  const [snap, isnap] = await Promise.all([
    getDocs(query(collection(db, "sessions"), where("courseId", "==", course.id))),
    getDocs(collection(db, "instructors")),
  ]);
  const sessions = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  const instructorsById = Object.fromEntries(isnap.docs.map((d) => [d.id, d.data()]));
  // 교육 종료일 기준 문항을 해석해 전달.
  const sorted = [...sessions].sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
  const lastDate = sorted.length ? sorted[sorted.length - 1].date : "";
  const survey = buildSurvey(course, sessions, roomId, instructorsById, getSurveyItemsAt(lastDate));
  if (!survey) {
    // 생성 조건 미충족: 기존 문서 있으면 제거.
    await deleteDoc(doc(db, "publicSurveys", course.id)).catch(() => {});
    return null;
  }
  await setDoc(doc(db, "publicSurveys", course.id), survey);
  return survey;
}
