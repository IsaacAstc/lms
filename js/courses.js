// 과정·차수 마스터 CRUD.
import {
  collection,
  addDoc,
  doc,
  setDoc,
  deleteDoc,
  updateDoc,
  onSnapshot,
  query,
  where,
  getDoc,
  getDocs,
  writeBatch,
  orderBy,
  runTransaction,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./firebase.js";
import { escapeHtml, isMasterMode } from "./app.js";
import { onProgramsChange, getProgramById, getPrograms } from "./programs.js";
import { onRoomsChange, getRooms } from "./rooms.js";
import { selectCourse } from "./sessions.js";
import { BOARD_EXCLUDED_TYPES } from "./constants.js";
import { getSurveySets, onSettingsChange } from "./settings.js";
import { regenerateSurvey } from "./survey-gen.js";
import { fmtDot, kstToday } from "./time.js";

const coursesCol = collection(db, "courses");
let unsub = null;
let editingId = null;
// 과정유형 선택지(settings/courseTypes). 문서가 없으면 기본값 사용.
const DEFAULT_COURSE_TYPES = ["초기", "정기", "특별", "초정기통합"];
let courseTypes = DEFAULT_COURSE_TYPES.slice();
// 다른 화면(시간표)에서 과정 목록을 재사용하기 위한 캐시.
export let coursesCache = [];
const listeners = [];

// 과정 목록 변경 구독 (시간표 화면에서 과정 셀렉트 갱신용).
export function onCoursesChange(cb) {
  listeners.push(cb);
  cb(coursesCache);
}

export function initCourses() {
  const form = document.getElementById("course-form");
  const tbody = document.getElementById("course-tbody");
  const cancelBtn = document.getElementById("course-cancel");
  const submitBtn = document.getElementById("course-submit");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = readForm(form);
    const err = validate(data);
    if (err) {
      alert(err);
      return;
    }
    try {
      let savedId = editingId;
      if (editingId) {
        // 정원·신청·이수 수치 갱신은 트랜잭션으로(동시 편집 시 원자적 read-modify, CLAUDE.md #8).
        const ref = doc(db, "courses", editingId);
        await runTransaction(db, async (tx) => {
          const snap = await tx.get(ref);
          if (!snap.exists()) throw new Error("이미 삭제된 과정입니다. 목록을 새로고침하세요.");
          tx.update(ref, data);
        });
      } else {
        const ref = await addDoc(coursesCol, data);
        savedId = ref.id;
      }
      // 공개 보드·설문 반영. 저장 자체는 끝났으므로 실패해도 폼은 초기화하되 반드시 알린다.
      try {
        await applyPublicState(savedId, data);
      } catch (pubErr) {
        alert(`차수는 저장했지만 공개 보드·설문 반영에 실패했습니다: ${pubErr.message}\n`
          + `설정 → 공개 현황 보드에서 '전체 강제 동기화'를 실행하세요.`);
      }
      resetForm(form, submitBtn, cancelBtn);
    } catch (e) {
      alert("저장 실패: " + e.message);
    }
  });

  cancelBtn.addEventListener("click", () => resetForm(form, submitBtn, cancelBtn));

  // 설문 문항 세트 셀렉트(설정 변경 시 갱신).
  onSettingsChange(() => {
    const sel = form.surveySetId;
    if (!sel) return;
    const prev = sel.value;
    sel.innerHTML = `<option value="">(커리큘럼/기본 따름)</option>`
      + getSurveySets().map((x) => `<option value="${escapeHtml(x.id)}">${escapeHtml(x.name || x.id)}</option>`).join("");
    sel.value = prev;
  });

  // 과정유형 선택지 로드 + (마스터) 편집 UI.
  initCourseTypeUi(form);
  loadCourseTypes(form);

  // 목록 필터(기본 올해).
  initCourseFilter(() => renderTable(tbody, form, submitBtn, cancelBtn));

  // 커리큘럼(과정 마스터) 연결 드롭다운 + 과정명 datalist.
  onProgramsChange((programs) => {
    const prev = form.programId.value;
    form.programId.innerHTML = `<option value="">(연결 안 함)</option>`;
    const nameList = document.getElementById("course-name-list");
    nameList.innerHTML = "";
    for (const p of programs) {
      const o = document.createElement("option");
      o.value = p.id; o.textContent = p.name;
      form.programId.appendChild(o);
      const dopt = document.createElement("option");
      dopt.value = p.name;
      nameList.appendChild(dopt);
    }
    form.programId.value = prev;
  });

  // 교육장 드롭다운(강의실 마스터 기반).
  onRoomsChange(() => {
    const prev = form.venue.value;
    form.venue.innerHTML = `<option value="">선택</option>`;
    for (const r of getRooms()) {
      const o = document.createElement("option");
      o.value = r.name; o.textContent = r.name;
      form.venue.appendChild(o);
    }
    form.venue.value = prev;
  });

  // 과정명을 커리큘럼에서 선택하면 커리큘럼 연결을 자동 설정(이후 과정명 수정 가능).
  form.name.addEventListener("input", () => {
    const match = getPrograms().find((p) => p.name === form.name.value.trim());
    if (match) {
      form.programId.value = match.id;
      // 커리큘럼 구분이 과정유형 옵션과 일치하면 자동 채움(이후 수정 가능).
      if (!form.courseType.value && courseTypes.includes(match.category)) {
        form.courseType.value = match.category;
      }
    }
  });

  // 실시간 목록.
  const q = query(coursesCol, orderBy("code"));
  unsub = onSnapshot(q, (snap) => {
    coursesCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    // 인라인 수정 중이면 다시 그리지 않는다(입력 중인 값이 지워지는 것 방지).
    // 저장·취소 시점에 rerender가 호출되므로 갱신은 그때 반영된다.
    if (!inlineId) renderTable(tbody, form, submitBtn, cancelBtn);
    listeners.forEach((cb) => cb(coursesCache));
  }, (err) => {
    // 조회 실패(권한 등)를 조용히 감추지 않고 표시.
    console.error("courses onSnapshot:", err);
    tbody.innerHTML = `<tr><td colspan="16" class="empty">목록을 불러오지 못했습니다: ${escapeHtml(err.code || err.message)}<br>보안규칙 재배포 또는 로그인 계정의 관리자 권한을 확인하세요.</td></tr>`;
  });
}

export function teardownCourses() {
  if (unsub) unsub();
  unsub = null;
}

function readForm(form) {
  return {
    code: form.code.value.trim(),
    name: form.name.value.trim(),
    capacity: Number(form.capacity.value),
    startDate: form.startDate.value,
    endDate: form.endDate.value,
    venue: form.venue.value.trim(),
    // 강의실 ID도 함께 저장 — 이후 강의실 이름이 바뀌어도 설문 URL 연결이 유지된다.
    venueRoomId: getRooms().find((r) => r.name === form.venue.value.trim())?.id || "",
    round: Number(form.round.value),
    programId: form.programId.value || "",
    courseType: form.courseType.value || "",
    operationTag: form.operationTag.value.trim(),
    surveySetId: form.surveySetId.value || "",
    appliedCount: form.appliedCount.value ? Number(form.appliedCount.value) : 0,
    completedCount: form.completedCount.value ? Number(form.completedCount.value) : 0,
    hasEvaluation: form.hasEvaluation.checked,
    // 예정(계획) 차수 — 공개 현황 보드에서 과정명 앞에 (예정) 표기.
    planned: form.planned.checked,
    // 공개 보드 미표시 여부. (input name은 form.hidden 속성 충돌 회피용 hideBoard)
    hidden: form.hideBoard.checked,
  };
}

// 공개 현황 보드(publicBoard)로 미러링 — 개인정보 없는 수치·일정만.
export function boardFields(data) {
  return {
    code: data.code, name: data.name, courseType: data.courseType || "", round: data.round ?? "",
    startDate: data.startDate || "", endDate: data.endDate || "", venue: data.venue || "",
    capacity: data.capacity || 0, appliedCount: data.appliedCount || 0,
    remaining: Math.max(0, (data.capacity || 0) - (data.appliedCount || 0)),
    hasEvaluation: !!data.hasEvaluation, planned: !!data.planned,
    // 비공개 운영 유형(특별·재교육): 공개 현황 보드에는 숨기고 현장 안내 DID에만 표시.
    didOnly: BOARD_EXCLUDED_TYPES.includes(data.courseType || ""),
    updatedAtMs: Date.now(),
  };
}
// 공개 게시 제외 대상: 숨김 처리한 차수만(어디에도 미게시).
// 특별·재교육은 didOnly 플래그로 게시된다(보드 숨김·DID 표시).
export function isBoardExcluded(data) {
  return !!data.hidden;
}

// 공개 보드 미러. 실패는 호출부에서 처리(조용히 삼키면 숨김이 안 먹힌 채 노출될 수 있음).
async function mirrorBoard(id, data) {
  // 제외 대상은 공개 보드에서 제거(미표시).
  if (isBoardExcluded(data)) await deleteDoc(doc(db, "publicBoard", id));
  else await setDoc(doc(db, "publicBoard", id), boardFields(data));
}

// 공개 노출 상태(보드·설문)를 차수 상태에 맞춰 일괄 반영.
async function applyPublicState(id, data) {
  await mirrorBoard(id, data);
  await syncSurveyFor(id, data);
}

// ── 과정유형 선택지 관리(추가·편집은 마스터 전용, 규칙에서도 차단) ──
async function loadCourseTypes(form) {
  try {
    const d = await getDoc(doc(db, "settings", "courseTypes"));
    if (d.exists() && Array.isArray(d.data().list) && d.data().list.length) courseTypes = d.data().list.slice();
  } catch { /* 기본값 유지 */ }
  refreshTypeSelect(form);
  renderTypeChips(form);
}

// 폼의 과정유형 셀렉트를 목록으로 채움(기존 선택값이 목록에 없어도 유지).
function refreshTypeSelect(form) {
  const sel = form.courseType;
  const prev = sel.value;
  const opts = courseTypes.slice();
  if (prev && !opts.includes(prev)) opts.push(prev); // 과거 값 보존.
  sel.innerHTML = `<option value="">(미지정)</option>`
    + opts.map((t) => `<option>${escapeHtml(t)}</option>`).join("");
  sel.value = prev;
}

// 셀렉트에 없는 값이면 임시 옵션을 만들어 선택(과거 값 보존).
function setCourseTypeValue(form, value) {
  const sel = form.courseType;
  if (value && ![...sel.options].some((o) => o.value === value)) {
    const o = document.createElement("option");
    o.value = value; o.textContent = `${value} (목록에 없음)`;
    sel.appendChild(o);
  }
  sel.value = value;
}

// 마스터 전용 편집 UI(칩: 이름 편집 + 삭제).
function renderTypeChips(form) {
  const box = document.getElementById("ctype-box");
  box.hidden = !isMasterMode();
  if (box.hidden) return;
  const list = document.getElementById("ctype-list");
  list.innerHTML = courseTypes.length
    ? `<div class="chip-row">${courseTypes.map((t, i) =>
        `<span class="chip"><input class="ct-name" data-i="${i}" value="${escapeHtml(t)}" size="10"><button type="button" class="chip-del" data-i="${i}">×</button></span>`).join("")}</div>`
    : `<p class="empty">과정유형이 없습니다. 아래에서 추가하세요.</p>`;
  list.querySelectorAll(".ct-name").forEach((el) =>
    el.addEventListener("input", (e) => { courseTypes[+e.target.dataset.i] = e.target.value; }));
  list.querySelectorAll(".chip-del").forEach((b) =>
    b.addEventListener("click", () => { courseTypes.splice(+b.dataset.i, 1); renderTypeChips(form); refreshTypeSelect(form); }));
}

function initCourseTypeUi(form) {
  document.getElementById("ctype-add").addEventListener("click", () => {
    const inp = document.getElementById("ctype-new");
    const v = inp.value.trim();
    if (!v) return;
    if (!courseTypes.includes(v)) courseTypes.push(v);
    inp.value = "";
    renderTypeChips(form);
    refreshTypeSelect(form);
  });
  document.getElementById("ctype-save").addEventListener("click", async () => {
    const list = courseTypes.map((t) => t.trim()).filter(Boolean);
    if (new Set(list).size !== list.length) return alert("중복된 과정유형이 있습니다.");
    try {
      await setDoc(doc(db, "settings", "courseTypes"), { list }, { merge: true });
      courseTypes = list;
      refreshTypeSelect(form);
      renderTypeChips(form);
      alert("과정유형을 저장했습니다.");
    } catch (e) { alert("저장 실패: " + e.message); }
  });
}

// 차수의 강의실 ID 해석: 저장된 venueRoomId 우선, 없으면 이름으로 조회(기존 데이터 호환).
export function roomIdOf(course) {
  if (course?.venueRoomId) return course.venueRoomId;
  return getRooms().find((r) => r.name === course?.venue)?.id || "";
}

// 숨김 처리된 차수 id 집합(집계 제외용). 캐시 상태와 무관하게 직접 조회.
export async function getHiddenCourseIds() {
  const snap = await getDocs(coursesCol);
  return new Set(snap.docs.filter((d) => d.data().hidden).map((d) => d.id));
}

// 숨김 상태에 따라 공개 설문 동기화: 숨김이면 설문 제거, 해제면 재생성.
// 실패는 호출부에서 처리(숨김이 반영되지 않으면 설문이 계속 응답 가능).
async function syncSurveyFor(id, data) {
  if (data.hidden) {
    await deleteDoc(doc(db, "publicSurveys", id));
  } else {
    const roomId = roomIdOf(data);
    await regenerateSurvey({ ...data, id }, roomId);
  }
}

// 교육기간을 한 열로 압축: 같은 날이면 하루, 같은 해면 종료일의 연도 생략.
function periodText(c) {
  const s = c.startDate || "";
  const e = c.endDate || "";
  if (!s && !e) return "";
  if (!e || e === s) return escapeHtml(fmtDot(s));
  // 같은 해면 종료일의 연도를 생략(축약분도 점 구분으로 통일).
  const end = (s.slice(0, 4) === e.slice(0, 4)) ? e.slice(5).replace("-", ".") : fmtDot(e);
  return `${escapeHtml(fmtDot(s))} - ${escapeHtml(end)}`;
}

// 커리큘럼명이 과정명과 다를 때만 과정명 아래에 작게 표기(열 하나 절약).
function curriculumNote(c) {
  const n = getProgramById(c.programId)?.name;
  if (!n || n === c.name) return "";
  return `<br><small class="c-sub">${escapeHtml(n)}</small>`;
}

// 잔여석 = 정원 - 신청건수 (자동 계산). 음수면 0 하한, 경고색은 CSS로.
function remainingSeats(c) {
  const r = (c.capacity ?? 0) - (c.appliedCount ?? 0);
  return r >= 0 ? r : `<span class="warn">${r}</span>`;
}

function validate(d) {
  if (!d.code) return "과정코드는 필수입니다.";
  if (!d.name) return "과정명은 필수입니다.";
  if (!Number.isFinite(d.capacity) || d.capacity <= 0)
    return "정원은 1 이상의 숫자여야 합니다.";
  if (!Number.isFinite(d.round) || d.round <= 0)
    return "차수는 1 이상의 숫자여야 합니다.";
  if (!d.startDate || !d.endDate) return "교육기간을 입력하세요.";
  if (d.endDate < d.startDate) return "교육종료일은 시작일 이후여야 합니다.";
  if (d.appliedCount < 0 || d.completedCount < 0) return "신청건수·이수인원은 0 이상이어야 합니다.";
  if (d.appliedCount > d.capacity) return "신청건수가 정원을 초과했습니다. 정원 또는 신청건수를 확인하세요.";
  return null;
}

function resetForm(form, submitBtn, cancelBtn) {
  form.reset();
  editingId = null;
  submitBtn.textContent = "등록";
  cancelBtn.hidden = true;
}

// ── 목록 필터(기본: 올해) ──
let filterInit = false;
function initCourseFilter(rerender) {
  const yearSel = document.getElementById("cf-year");
  ["cf-year", "cf-from", "cf-to", "cf-type", "cf-status", "cf-venue"].forEach((id) =>
    document.getElementById(id).addEventListener("change", rerender));
  document.getElementById("cf-q").addEventListener("input", rerender);
  document.getElementById("cf-reset").addEventListener("click", () => {
    document.getElementById("cf-from").value = "";
    document.getElementById("cf-to").value = "";
    ["cf-q", "cf-type", "cf-status", "cf-venue"].forEach((id) => { document.getElementById(id).value = ""; });
    yearSel.value = String(new Date().getFullYear());
    rerender();
  });
  // 향후 30일: 오늘부터 30일 이내에 진행되는(기간이 겹치는) 과정만.
  document.getElementById("cf-30d").addEventListener("click", () => {
    const d = new Date();
    const iso = (x) => `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
    document.getElementById("cf-from").value = iso(d);
    d.setDate(d.getDate() + 30);
    document.getElementById("cf-to").value = iso(d);
    rerender();
  });
}

// 데이터에 있는 연도로 셀렉트 갱신(선택값 유지, 최초에는 올해 기본 선택).
function refreshYearOptions() {
  const sel = document.getElementById("cf-year");
  const years = [...new Set(coursesCache.map((c) => (c.startDate || "").slice(0, 4)).filter(Boolean))]
    .sort().reverse();
  const thisYear = String(new Date().getFullYear());
  if (!years.includes(thisYear)) years.unshift(thisYear);
  const prev = filterInit ? sel.value : thisYear;
  sel.innerHTML = `<option value="">전체 연도</option>` + years.map((y) => `<option>${y}</option>`).join("");
  sel.value = [...sel.options].some((o) => o.value === prev) ? prev : "";
  filterInit = true;
  refreshFilterOptions();
}

// 유형·교육장 셀렉트 갱신: 기준값(과정유형)·강의실 마스터 + 데이터에만 있는 값도 포함(선택값 유지).
function refreshFilterOptions() {
  const fill = (id, values, allLabel) => {
    const sel = document.getElementById(id);
    const prev = sel.value;
    sel.innerHTML = `<option value="">${allLabel}</option>`
      + values.map((v) => `<option>${escapeHtml(v)}</option>`).join("");
    sel.value = [...sel.options].some((o) => o.value === prev) ? prev : "";
  };
  const inData = (get) => coursesCache.map(get).filter(Boolean);
  fill("cf-type", [...new Set([...courseTypes, ...inData((c) => c.courseType)])], "전체 유형");
  fill("cf-venue", [...new Set([...getRooms().map((r) => r.name), ...inData((c) => c.venue)])], "전체 교육장");
}

// 기간을 지정하면 범위 우선, 아니면 연도 기준. 교육기간이 겹치면 표시.
// 검색·유형·상태·교육장은 날짜 조건과 AND 결합.
function applyFilter(list) {
  const year = document.getElementById("cf-year").value;
  const from = document.getElementById("cf-from").value;
  const to = document.getElementById("cf-to").value;
  const q = document.getElementById("cf-q").value.trim().toLowerCase();
  const type = document.getElementById("cf-type").value;
  const status = document.getElementById("cf-status").value;
  const venue = document.getElementById("cf-venue").value;
  const today = kstToday();

  return list.filter((c) => {
    const s = c.startDate || "";
    const e = c.endDate || s;
    if (from || to) {
      if (from && e && e < from) return false;
      if (to && s && s > to) return false;
    } else if (year && s.slice(0, 4) !== year) return false;
    if (q && !`${c.name || ""} ${c.code || ""}`.toLowerCase().includes(q)) return false;
    if (type && (c.courseType || "") !== type) return false;
    if (venue && (c.venue || "") !== venue) return false;
    if (status) {
      // 오늘 기준: 예정(시작 전) / 진행 중(기간 내) / 종료(종료 후). 날짜 미입력 차수는 상태 필터에서 제외.
      const st = !s ? "" : s > today ? "upcoming" : (e || s) < today ? "done" : "ongoing";
      if (st !== status) return false;
    }
    return true;
  });
}

// ── 목록 내 인라인 수정 ──
// 표에 있는 열만 그 자리에서 고치고, 표에 없는 필드(커리큘럼·운영유형·설문 세트)는
// 기존 값을 그대로 보존한다. 그 필드까지 고칠 때는 '상세'로 상단 폼을 사용.
let inlineId = null;

function typeOptions(cur) {
  const list = courseTypes.includes(cur) || !cur ? courseTypes : [cur, ...courseTypes];
  return `<option value="">(미지정)</option>`
    + list.map((t) => `<option${t === cur ? " selected" : ""}>${escapeHtml(t)}</option>`).join("");
}

function venueOptions(cur) {
  const names = getRooms().map((r) => r.name);
  const list = !cur || names.includes(cur) ? names : [cur, ...names];
  return `<option value="">선택</option>`
    + list.map((n) => `<option${n === cur ? " selected" : ""}>${escapeHtml(n)}</option>`).join("");
}

// 상세 수정: 표에 없는 필드(커리큘럼·운영유형·설문 세트)까지 고칠 때 상단 폼으로 올린다.
function openDetail(c, form, submitBtn, cancelBtn) {
  editingId = c.id;
  form.code.value = c.code ?? "";
  form.name.value = c.name ?? "";
  form.capacity.value = c.capacity ?? "";
  form.startDate.value = c.startDate ?? "";
  form.endDate.value = c.endDate ?? "";
  form.venue.value = c.venue ?? "";
  form.round.value = c.round ?? "";
  form.programId.value = c.programId ?? "";
  // 목록에서 삭제·변경된 과거 값도 선택 상태를 유지(저장 시 값이 비워지지 않도록).
  setCourseTypeValue(form, c.courseType ?? "");
  form.operationTag.value = c.operationTag ?? "";
  form.surveySetId.value = c.surveySetId ?? "";
  form.appliedCount.value = c.appliedCount ?? 0;
  form.completedCount.value = c.completedCount ?? 0;
  form.hasEvaluation.checked = !!c.hasEvaluation;
  form.planned.checked = !!c.planned;
  form.hideBoard.checked = !!c.hidden;
  submitBtn.textContent = "수정 저장";
  cancelBtn.hidden = false;
  form.scrollIntoView({ behavior: "smooth" });
}

function editRowHtml(c) {
  return `
    <td><input class="e-code" value="${escapeHtml(c.code ?? "")}" required></td>
    <td><input class="e-name" list="course-name-list" value="${escapeHtml(c.name ?? "")}" required></td>
    <td><select class="e-type">${typeOptions(c.courseType ?? "")}</select></td>
    <td><input class="e-round" type="number" min="1" value="${c.round ?? ""}"></td>
    <td><input class="e-cap" type="number" min="1" value="${c.capacity ?? ""}"></td>
    <td><input class="e-applied" type="number" min="0" value="${c.appliedCount ?? 0}"></td>
    <td class="e-remain">${remainingSeats(c)}</td>
    <td><input class="e-completed" type="number" min="0" value="${c.completedCount ?? 0}"></td>
    <td style="text-align:center"><input class="e-eval" type="checkbox"${c.hasEvaluation ? " checked" : ""}></td>
    <td class="e-period">
      <input class="e-start" type="date" value="${escapeHtml(c.startDate ?? "")}">
      <input class="e-end" type="date" value="${escapeHtml(c.endDate ?? "")}">
    </td>
    <td><select class="e-venue">${venueOptions(c.venue ?? "")}</select></td>
    <td style="text-align:center"><input class="e-plan" type="checkbox"${c.planned ? " checked" : ""}></td>
    <td style="text-align:center"><input class="e-hide" type="checkbox"${c.hidden ? " checked" : ""}></td>
    <td class="actions">
      <button type="button" class="save">저장</button>
      <button type="button" class="cancel">취소</button>
      <button type="button" class="detail" title="커리큘럼·운영유형·설문 세트까지 수정(상단 폼)">상세</button>
    </td>`;
}

// 수정 행의 입력값 읽기. 표에 없는 필드는 기존 문서 값을 유지.
function readRow(tr, c) {
  const g = (s) => tr.querySelector(s);
  const venue = g(".e-venue").value.trim();
  return {
    code: g(".e-code").value.trim(),
    name: g(".e-name").value.trim(),
    courseType: g(".e-type").value,
    round: Number(g(".e-round").value),
    capacity: Number(g(".e-cap").value),
    appliedCount: Number(g(".e-applied").value || 0),
    completedCount: Number(g(".e-completed").value || 0),
    hasEvaluation: g(".e-eval").checked,
    startDate: g(".e-start").value,
    endDate: g(".e-end").value,
    venue,
    venueRoomId: getRooms().find((r) => r.name === venue)?.id || "",
    planned: g(".e-plan").checked,
    hidden: g(".e-hide").checked,
    programId: c.programId || "",
    operationTag: c.operationTag || "",
    surveySetId: c.surveySetId || "",
  };
}

function wireEditRow(tr, c, rerender, detail) {
  // 정원·신청을 고치면 잔여석을 즉시 반영(저장 전 확인용).
  const live = () => {
    tr.querySelector(".e-remain").innerHTML = remainingSeats({
      capacity: Number(tr.querySelector(".e-cap").value),
      appliedCount: Number(tr.querySelector(".e-applied").value || 0),
    });
  };
  tr.querySelector(".e-cap").addEventListener("input", live);
  tr.querySelector(".e-applied").addEventListener("input", live);
  // 과정명을 커리큘럼에서 고르면 커리큘럼 연결도 함께 갱신.
  tr.querySelector(".e-name").addEventListener("change", (e) => {
    const match = getPrograms().find((p) => p.name === e.target.value.trim());
    if (match) c = { ...c, programId: match.id };
  });
  tr.querySelector(".cancel").addEventListener("click", () => { inlineId = null; rerender(); });
  // 표에 없는 필드까지 고칠 때는 상단 폼으로(인라인 수정은 닫는다).
  tr.querySelector(".detail").addEventListener("click", () => {
    inlineId = null;
    rerender();
    detail(c);
  });
  // Enter로 저장, Esc로 취소.
  tr.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); tr.querySelector(".save").click(); }
    if (e.key === "Escape") { inlineId = null; rerender(); }
  });
  tr.querySelector(".save").addEventListener("click", async () => {
    const data = readRow(tr, c);
    const err = validate(data);
    if (err) return alert(err);
    const btn = tr.querySelector(".save");
    btn.disabled = true;
    try {
      const ref = doc(db, "courses", c.id);
      await runTransaction(db, async (tx) => {
        const snap = await tx.get(ref);
        if (!snap.exists()) throw new Error("이미 삭제된 과정입니다. 목록을 새로고침하세요.");
        tx.update(ref, data);
      });
    } catch (e) {
      btn.disabled = false;
      return alert("저장 실패: " + e.message);
    }
    inlineId = null;
    try {
      await applyPublicState(c.id, data);
    } catch (e) {
      alert(`차수는 저장했지만 공개 보드·설문 반영에 실패했습니다: ${e.message}\n`
        + "설정 → 공개 현황 보드에서 '전체 강제 동기화'를 실행하세요.");
    }
    rerender();
  });
}

function renderTable(tbody, form, submitBtn, cancelBtn) {
  tbody.innerHTML = "";
  refreshYearOptions();
  if (coursesCache.length === 0) {
    document.getElementById("cf-count").textContent = "";
    tbody.innerHTML = `<tr><td colspan="14" class="empty">등록된 과정이 없습니다.</td></tr>`;
    return;
  }
  // 목록 표시는 시작일 내림차순(최근 과정 우선). 같은 날짜는 과정코드·차수 순.
  const rows = applyFilter([...coursesCache]).sort((a, b) =>
    (b.startDate || "").localeCompare(a.startDate || "")
    || (a.code || "").localeCompare(b.code || "")
    || (a.round ?? 0) - (b.round ?? 0));
  document.getElementById("cf-count").textContent = `${rows.length} / 전체 ${coursesCache.length}건`;
  if (!rows.length) {
    tbody.innerHTML = `<tr><td colspan="14" class="empty">선택한 기간에 등록된 과정이 없습니다. 연도를 바꾸거나 ‘전체 연도’를 선택하세요.</td></tr>`;
    return;
  }
  const rerender = () => renderTable(tbody, form, submitBtn, cancelBtn);
  for (const c of rows) {
    const tr = document.createElement("tr");
    // 인라인 수정 중인 행은 입력 폼으로 표시.
    if (c.id === inlineId) {
      tr.className = "inline-edit";
      tr.innerHTML = editRowHtml(c);
      wireEditRow(tr, c, rerender, (x) => openDetail(x, form, submitBtn, cancelBtn));
      tbody.appendChild(tr);
      continue;
    }
    tr.innerHTML = `
      <td>${escapeHtml(c.code)}</td>
      <td class="c-name">${escapeHtml(c.name)}${curriculumNote(c)}</td>
      <td>${escapeHtml(c.courseType ?? "")}</td>
      <td>${c.round ?? ""}</td>
      <td>${c.capacity ?? ""}</td>
      <td>${c.appliedCount ?? 0}</td>
      <td>${remainingSeats(c)}</td>
      <td>${c.completedCount ?? 0}</td>
      <td style="text-align:center">${c.hasEvaluation ? "○" : ""}</td>
      <td>${periodText(c)}</td>
      <td>${escapeHtml(c.venue ?? "")}</td>
      <td style="text-align:center"><input type="checkbox" class="c-plan"${c.planned ? " checked" : ""} title="체크 시 공개 보드에서 과정명 앞에 (예정) 표기"></td>
      <td style="text-align:center"><input type="checkbox" class="c-hide"${c.hidden ? " checked" : ""} title="체크 시 공개 보드 미표시 + 설문 비활성 + 강사료·경비 집계 제외"></td>
      <td class="actions">
        <button type="button" class="timetable">시간표</button>
        <button type="button" class="edit" title="이 줄에서 바로 수정(상세 항목은 수정 중 ‘상세’)">수정</button>
        <button type="button" class="del">삭제</button>
      </td>`;
    tr.querySelector(".timetable").addEventListener("click", () => selectCourse(c.id));
    // 목록에서 바로 예정(계획) 토글 → 저장 + 공개 보드 표기 반영.
    tr.querySelector(".c-plan").addEventListener("change", async (e) => {
      const on = e.target.checked;
      try {
        await updateDoc(doc(db, "courses", c.id), { planned: on });
      } catch (err) {
        e.target.checked = !on;
        alert("예정 설정 실패: " + err.message);
        return;
      }
      try {
        await mirrorBoard(c.id, { ...c, planned: on });
      } catch (err) {
        alert(`예정 설정은 저장했지만 공개 보드 반영에 실패했습니다: ${err.message}\n`
          + "설정 → 공개 현황 보드에서 '전체 강제 동기화'를 실행하세요.");
      }
    });
    // 목록에서 바로 숨김 토글 → 저장 + 공개 보드 반영.
    tr.querySelector(".c-hide").addEventListener("change", async (e) => {
      const on = e.target.checked;
      try {
        await updateDoc(doc(db, "courses", c.id), { hidden: on });
      } catch (err) {
        e.target.checked = !on; // 저장 자체가 실패 → 체크 상태 원복.
        alert("숨김 설정 실패: " + err.message);
        return;
      }
      try {
        await applyPublicState(c.id, { ...c, hidden: on });
      } catch (err) {
        // 저장은 됐으나 공개 반영 실패 → 노출이 남을 수 있으므로 명확히 경고.
        alert(`숨김 설정은 저장했지만 공개 보드·설문 반영에 실패했습니다: ${err.message}\n`
          + (on ? "해당 차수가 아직 외부에 노출·응답 가능할 수 있습니다.\n" : "")
          + "설정 → 공개 현황 보드에서 '전체 강제 동기화'를 실행하세요.");
      }
    });
    // 이 줄에서 바로 수정(표에 있는 열만).
    tr.querySelector(".edit").addEventListener("click", () => {
      inlineId = c.id;
      rerender();
      tbody.querySelector("tr.inline-edit .e-code")?.focus();
    });
    tr.querySelector(".del").addEventListener("click", async () => {
      if (!confirm(`'${c.name}' ${c.round}차수를 삭제하시겠습니까?\n연결된 시간표·공개설문도 함께 삭제됩니다.`)) return;
      try {
        // 연결된 시간표 세션 조회 후 차수·세션·공개설문을 한 배치로 삭제(고아 세션 방지).
        const ss = await getDocs(query(collection(db, "sessions"), where("courseId", "==", c.id)));
        const batch = writeBatch(db);
        ss.docs.forEach((d) => batch.delete(d.ref));
        batch.delete(doc(db, "publicSurveys", c.id));
        batch.delete(doc(db, "publicBoard", c.id));
        batch.delete(doc(db, "courses", c.id));
        await batch.commit();
      } catch (e) {
        alert("삭제 실패: " + e.message);
      }
    });
    tbody.appendChild(tr);
  }
}
