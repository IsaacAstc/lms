// 강의 시간표: 커리큘럼 초안 편집 → 등록, 등록된 시간표 셀 편집 → 일괄 저장.
import {
  collection, doc, onSnapshot, query, where, writeBatch, getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./firebase.js";
import { START_TIMES, END_TIMES } from "./constants.js";
import { onCoursesChange, coursesCache } from "./courses.js";
import { onRoomsChange, getRooms } from "./rooms.js";
import { onProgramsChange, getProgramById } from "./programs.js";
import { onInstructorsChange, getInstructors } from "./instructors.js";
import { regenerateSurvey } from "./survey-gen.js";
import { escapeHtml } from "./app.js";

const sessionsCol = collection(db, "sessions");
let unsub = null;
let selectedCourseId = "";
let selectedCourse = null;
let sessionsCache = [];

export function initSessions() {
  const courseSel = document.getElementById("session-course");

  // 강사 datalist(강사 마스터 기반).
  onInstructorsChange(() => {
    const dl = document.getElementById("session-instructor-list");
    dl.innerHTML = "";
    for (const i of getInstructors()) {
      const o = document.createElement("option");
      o.value = i.name;
      o.label = `${i.affiliation || ""} / ${i.instructorType || ""}`;
      dl.appendChild(o);
    }
  });

  // 과정 셀렉트(차수).
  onCoursesChange((courses) => {
    const prev = courseSel.value;
    courseSel.innerHTML = `<option value="">과정을 선택하세요</option>`;
    for (const c of courses) {
      const o = document.createElement("option");
      o.value = c.id;
      o.textContent = `${c.code} ${c.name} (${c.round}차수)`;
      courseSel.appendChild(o);
    }
    courseSel.value = prev;
  });

  // 커리큘럼 불러오기 select.
  onProgramsChange((programs) => {
    const sel = document.getElementById("load-program");
    const prev = sel.value;
    sel.innerHTML = `<option value="">커리큘럼 선택</option>`;
    for (const p of programs) {
      const o = document.createElement("option");
      o.value = p.id; o.textContent = p.name;
      sel.appendChild(o);
    }
    sel.value = prev;
  });

  // 강의실 변경 시 그리드 옵션 갱신(편집 중이 아니면).
  onRoomsChange(() => { if (selectedCourseId) renderGrid(); });

  courseSel.addEventListener("change", () => {
    selectedCourseId = courseSel.value;
    selectedCourse = coursesCache.find((c) => c.id === selectedCourseId) || null;
    refreshSubjectList();
    clearDraft();
    document.getElementById("load-program").value = selectedCourse?.programId || "";
    document.getElementById("load-basedate").value = selectedCourse?.startDate || "";
    subscribeSessions();
  });

  document.getElementById("load-btn").addEventListener("click", buildDraft);
  document.getElementById("draft-add").addEventListener("click", () =>
    document.getElementById("draft-tbody").appendChild(editRow({ room: selectedCourse?.venue }, { draft: true }))
  );
  document.getElementById("draft-clear").addEventListener("click", clearDraft);
  document.getElementById("draft-commit").addEventListener("click", commitDraft);

  document.getElementById("grid-add").addEventListener("click", () =>
    document.getElementById("session-tbody").appendChild(editRow({ room: selectedCourse?.venue }, { copy: true }))
  );
  document.getElementById("session-commit").addEventListener("click", commitGrid);
}

export function teardownSessions() {
  if (unsub) unsub();
  unsub = null;
}

// 선택 차수 커리큘럼 과목을 datalist로 제안.
function refreshSubjectList() {
  const dl = document.getElementById("session-subject-list");
  dl.innerHTML = "";
  const prog = selectedCourse?.programId ? getProgramById(selectedCourse.programId) : null;
  const seen = new Set();
  for (const s of prog?.subjects || []) {
    if (seen.has(s.subject)) continue;
    seen.add(s.subject);
    const o = document.createElement("option");
    o.value = s.subject;
    dl.appendChild(o);
  }
}

function dayToDate(baseDate, dayNo) {
  if (!baseDate) return "";
  const d = new Date(baseDate + "T00:00:00");
  d.setDate(d.getDate() + ((dayNo || 1) - 1));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ── 편집 가능한 행 (초안·그리드 공용) ──
function editRow(v = {}, opts = {}) {
  const tr = document.createElement("tr");
  if (v.id) tr.dataset.id = v.id;
  tr.dataset.kind = v.teacherKind || "";
  const roomOpts = ['<option value="">강의실</option>']
    .concat(getRooms().map((r) => `<option${v.room === r.name ? " selected" : ""}>${escapeHtml(r.name)}</option>`))
    .join("");
  const timeOpts = (arr, sel) => arr.map((t) => `<option${t === sel ? " selected" : ""}>${t}</option>`).join("");
  const actions = opts.copy
    ? `<button type="button" class="copy e-copy">복사</button><button type="button" class="del e-del">삭제</button>`
    : `<button type="button" class="del e-del">삭제</button>`;
  tr.innerHTML = `
    <td><input type="date" class="e-date" value="${v.date || ""}"></td>
    <td><input class="e-subj" list="session-subject-list" value="${escapeHtml(v.subject || "")}"></td>
    <td><select class="e-start">${timeOpts(START_TIMES, v.startTime)}</select></td>
    <td><select class="e-end">${timeOpts(END_TIMES, v.endTime)}</select></td>
    <td><select class="e-room">${roomOpts}</select></td>
    <td><input class="e-inst" list="session-instructor-list" value="${escapeHtml(v.instructor || "")}" placeholder="강사명"></td>
    <td class="actions">${actions}</td>`;
  tr.querySelector(".e-del").addEventListener("click", () => {
    tr.remove();
    if (opts.draft && !document.querySelectorAll("#draft-tbody tr").length) clearDraft();
  });
  if (opts.copy) {
    tr.querySelector(".e-copy").addEventListener("click", () => {
      const clone = editRow({ ...readRow(tr), id: "", teacherKind: tr.dataset.kind }, opts);
      tr.after(clone);
    });
  }
  return tr;
}

function readRow(tr) {
  return {
    id: tr.dataset.id || "",
    date: tr.querySelector(".e-date").value,
    subject: tr.querySelector(".e-subj").value.trim(),
    startTime: tr.querySelector(".e-start").value,
    endTime: tr.querySelector(".e-end").value,
    room: tr.querySelector(".e-room").value,
    instructor: tr.querySelector(".e-inst").value.trim(),
    teacherKind: tr.dataset.kind || "",
  };
}

// 행 값 검증 + instructorId 매핑. 오류 메시지 반환(정상이면 null), data는 out에 채움.
function validateRow(r, out) {
  if (!r.date || !r.subject) return "모든 행에 일자와 과목을 입력하세요.";
  if (r.endTime <= r.startTime) return `'${r.subject}' 행의 종료시각이 시작시각보다 빠릅니다.`;
  const inst = r.instructor ? getInstructors().find((i) => i.name === r.instructor) : null;
  if (r.instructor && !inst) return `'${r.instructor}'은(는) 강사 마스터에 없습니다. 마스터의 강사만 지정할 수 있습니다.`;
  Object.assign(out, {
    date: r.date, subject: r.subject, startTime: r.startTime, endTime: r.endTime,
    room: r.room, instructor: r.instructor, instructorId: inst ? inst.id : "", teacherKind: r.teacherKind,
  });
  return null;
}

// 시간대 겹침 여부.
function overlaps(a, b) {
  return a.date === b.date && a.startTime < b.endTime && b.startTime < a.endTime;
}

// 제출 배치 내부 충돌: 같은 일자에 (a) 동일 강의실 시간 겹침, (b) 동일 강사 이중배정.
function findConflicts(items) {
  const msgs = [];
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      const a = items[i], b = items[j];
      if (!overlaps(a, b)) continue;
      if (a.room && a.room === b.room) {
        msgs.push(`${a.date} ${a.room}: '${a.subject}'와 '${b.subject}' 강의실 시간 겹침`);
      }
      if (a.instructorId && a.instructorId === b.instructorId) {
        msgs.push(`${a.date} ${escapeHtml(a.instructor)}: '${a.subject}'와 '${b.subject}' 강사 이중배정`);
      }
    }
  }
  return msgs;
}

// 다른 차수와의 충돌: 같은 기간 세션을 조회해 강의실·강사 겹침 검출(경고용).
async function findExternalConflicts(items) {
  const dates = [...new Set(items.map((i) => i.date).filter(Boolean))];
  if (!dates.length) return [];
  const min = dates.reduce((a, b) => (a < b ? a : b));
  const max = dates.reduce((a, b) => (a > b ? a : b));
  let externals = [];
  try {
    const snap = await getDocs(query(sessionsCol, where("date", ">=", min), where("date", "<=", max)));
    externals = snap.docs
      .map((d) => ({ id: d.id, ...d.data() }))
      .filter((s) => s.courseId !== selectedCourseId); // 현재 차수는 이 배치로 대체되므로 제외.
  } catch (e) { return [`다른 차수 충돌 조회 실패(검증 생략): ${e.message}`]; }
  const nameOf = (cid) => coursesCache.find((c) => c.id === cid)?.name || "다른 차수";
  const msgs = [];
  for (const a of items) {
    for (const e of externals) {
      if (!overlaps(a, e)) continue;
      const who = `${e.date} [${escapeHtml(nameOf(e.courseId))}]`;
      if (a.room && a.room === e.room) {
        msgs.push(`${who} ${a.room}: '${a.subject}'가 '${escapeHtml(e.subject || "")}'와 강의실 겹침`);
      }
      if (a.instructorId && a.instructorId === e.instructorId) {
        msgs.push(`${who} ${escapeHtml(a.instructor)}: '${a.subject}'와 강사 이중배정`);
      }
    }
  }
  return msgs;
}

// ── 커리큘럼 초안 ──
function buildDraft() {
  if (!selectedCourseId) return alert("먼저 과정(차수)을 선택하세요.");
  const pid = document.getElementById("load-program").value;
  const baseDate = document.getElementById("load-basedate").value;
  if (!pid) return alert("불러올 커리큘럼을 선택하세요.");
  if (!baseDate) return alert("1일차 기준일을 선택하세요.");
  const prog = getProgramById(pid);
  const subjects = prog?.subjects || [];
  if (!subjects.length) return alert("선택한 커리큘럼에 과목이 없습니다.");
  const tbody = document.getElementById("draft-tbody");
  if (tbody.children.length && !confirm("기존 초안을 새로 불러온 내용으로 교체합니다. 계속할까요?")) return;
  tbody.innerHTML = "";
  for (const s of subjects) {
    tbody.appendChild(editRow({
      date: dayToDate(baseDate, s.dayNo),
      subject: s.subject, startTime: s.startTime, endTime: s.endTime,
      room: selectedCourse?.venue || "", instructor: "", teacherKind: s.teacherKind,
    }, { draft: true }));
  }
  document.getElementById("draft-actions").hidden = false;
}

function clearDraft() {
  document.getElementById("draft-tbody").innerHTML = "";
  document.getElementById("draft-actions").hidden = true;
}

async function commitDraft() {
  if (!selectedCourseId) return alert("먼저 과정(차수)을 선택하세요.");
  const rows = [...document.querySelectorAll("#draft-tbody tr")];
  if (!rows.length) return alert("등록할 초안이 없습니다.");
  const items = [];
  for (const tr of rows) {
    const out = {};
    const err = validateRow(readRow(tr), out);
    if (err) return alert(err);
    items.push(out);
  }
  const conflicts = [...findConflicts(items), ...await findExternalConflicts(items)];
  if (conflicts.length && !confirm(`[중복 경고]\n${conflicts.join("\n")}\n\n그래도 등록할까요?`)) return;
  if (!confirm(`${items.length}개 과목을 시간표로 등록합니다. 진행할까요?`)) return;
  const batch = writeBatch(db);
  for (const data of items) batch.set(doc(sessionsCol), { courseId: selectedCourseId, ...data });
  try {
    await batch.commit();
    clearDraft();
    await syncSurvey();
    alert("시간표 등록을 완료했습니다.");
  } catch (e) { alert("등록 실패: " + e.message); }
}

// 현재 차수의 공개 설문 정의를 재생성(교육장→강의실ID 매핑). 실패해도 비치명적.
async function syncSurvey() {
  try {
    if (!selectedCourse) return;
    const roomId = getRooms().find((r) => r.name === selectedCourse.venue)?.id || "";
    await regenerateSurvey(selectedCourse, roomId);
  } catch (e) { console.warn("설문 생성 건너뜀:", e.message); }
}

// ── 등록된 시간표 그리드 ──
function subscribeSessions() {
  if (unsub) unsub();
  sessionsCache = [];
  if (!selectedCourseId) {
    document.getElementById("session-tbody").innerHTML =
      `<tr><td colspan="7" class="empty">과정을 선택하세요.</td></tr>`;
    document.getElementById("grid-actions").hidden = true;
    return;
  }
  const q = query(sessionsCol, where("courseId", "==", selectedCourseId));
  unsub = onSnapshot(q, (snap) => {
    sessionsCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    sessionsCache.sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
    renderGrid();
  });
}

function renderGrid() {
  const tbody = document.getElementById("session-tbody");
  tbody.innerHTML = "";
  document.getElementById("grid-actions").hidden = !selectedCourseId;
  for (const s of sessionsCache) tbody.appendChild(editRow(s, { copy: true }));
}

async function commitGrid() {
  if (!selectedCourseId) return alert("먼저 과정(차수)을 선택하세요.");
  const rows = [...document.querySelectorAll("#session-tbody tr")].filter((tr) => tr.querySelector(".e-date"));
  const items = [];
  for (const tr of rows) {
    const out = {};
    const r = readRow(tr);
    const err = validateRow(r, out);
    if (err) return alert(err);
    items.push({ id: r.id, data: out });
  }
  const dataItems = items.map((i) => i.data);
  const conflicts = [...findConflicts(dataItems), ...await findExternalConflicts(dataItems)];
  if (conflicts.length && !confirm(`[중복 경고]\n${conflicts.join("\n")}\n\n그래도 저장할까요?`)) return;

  // 삭제 대상 = 기존 문서 중 현재 행에 없는 id.
  const presentIds = new Set(items.filter((i) => i.id).map((i) => i.id));
  const deletions = sessionsCache.filter((s) => !presentIds.has(s.id)).map((s) => s.id);
  const newCount = items.filter((i) => !i.id).length;
  if (!confirm(`수정 ${items.length - newCount}건, 추가 ${newCount}건, 삭제 ${deletions.length}건을 저장합니다. 진행할까요?`)) return;

  const batch = writeBatch(db);
  for (const it of items) {
    if (it.id) batch.set(doc(db, "sessions", it.id), { courseId: selectedCourseId, ...it.data });
    else batch.set(doc(sessionsCol), { courseId: selectedCourseId, ...it.data });
  }
  for (const id of deletions) batch.delete(doc(db, "sessions", id));
  try {
    await batch.commit();
    await syncSurvey();
    alert("시간표 수정을 완료했습니다.");
  } catch (e) { alert("저장 실패: " + e.message); }
}
