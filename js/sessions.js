// 강의 시간표 CRUD + 강의실 시간 중복 검증 + 커리큘럼 연동/입력 보조.
import {
  collection, addDoc, updateDoc, deleteDoc, doc, onSnapshot, query, where, writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./firebase.js";
import { START_TIMES, END_TIMES } from "./constants.js";
import { onCoursesChange, coursesCache } from "./courses.js";
import { onRoomsChange, getRooms } from "./rooms.js";
import { onProgramsChange, getProgramById } from "./programs.js";
import { onInstructorsChange, getInstructors } from "./instructors.js";
import { escapeHtml } from "./app.js";

const sessionsCol = collection(db, "sessions");
let unsub = null;
let editingId = null;
let selectedCourseId = "";
let selectedCourse = null;
let sessionsCache = [];

export function initSessions() {
  const courseSel = document.getElementById("session-course");
  const form = document.getElementById("session-form");
  const tbody = document.getElementById("session-tbody");
  const cancelBtn = document.getElementById("session-cancel");
  const submitBtn = document.getElementById("session-submit");

  fillOptions(form.startTime, START_TIMES);
  fillOptions(form.endTime, END_TIMES);

  // 강의실 드롭다운(rooms 컬렉션 기반, 실시간).
  onRoomsChange(() => {
    const prev = form.room.value;
    form.room.innerHTML = `<option value="">강의실 선택</option>`;
    for (const r of getRooms()) {
      const o = document.createElement("option");
      o.value = r.name; o.textContent = r.name;
      form.room.appendChild(o);
    }
    form.room.value = prev;
  });

  // 강사 datalist(강사 마스터 기반, 마스터에서만 선택).
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

  // 과정 셀렉트(차수) 동기화.
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

  // 커리큘럼 불러오기 select(과정 마스터).
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

  courseSel.addEventListener("change", () => {
    selectedCourseId = courseSel.value;
    selectedCourse = coursesCache.find((c) => c.id === selectedCourseId) || null;
    resetForm(form, submitBtn, cancelBtn);
    refreshSubjectList();
    subscribeSessions(tbody, form, submitBtn, cancelBtn);
  });

  document.getElementById("load-btn").addEventListener("click", () => bulkLoadCurriculum());

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!selectedCourseId) return alert("먼저 과정을 선택하세요.");
    const data = readForm(form);
    const err = validate(data);
    if (err) return alert(err);
    const conflict = checkConflict(data, sessionsCache, editingId);
    if (conflict) {
      const go = confirm(
        `[중복 경고] ${data.room}에 ${data.date} ${conflict.startTime}~${conflict.endTime} ` +
          `'${conflict.subject}' 강의가 이미 있습니다.\n그래도 저장하시겠습니까?`
      );
      if (!go) return;
    }
    try {
      if (editingId) await updateDoc(doc(db, "sessions", editingId), data);
      else await addDoc(sessionsCol, { courseId: selectedCourseId, ...data });
      resetForm(form, submitBtn, cancelBtn);
    } catch (e) { alert("저장 실패: " + e.message); }
  });

  cancelBtn.addEventListener("click", () => resetForm(form, submitBtn, cancelBtn));
}

export function teardownSessions() {
  if (unsub) unsub();
  unsub = null;
}

// 선택 차수에 연결된 과정 커리큘럼 과목을 datalist로 제안.
function refreshSubjectList() {
  const dl = document.getElementById("session-subject-list");
  dl.innerHTML = "";
  const pid = selectedCourse?.programId;
  const prog = pid ? getProgramById(pid) : null;
  const subjects = prog ? (prog.subjects || []) : [];
  const seen = new Set();
  for (const s of subjects) {
    if (seen.has(s.subject)) continue;
    seen.add(s.subject);
    const o = document.createElement("option");
    o.value = s.subject;
    dl.appendChild(o);
  }
}

// 커리큘럼을 시간표로 일괄 생성(차수 인스턴스). 이후 개별 수정 가능.
async function bulkLoadCurriculum() {
  if (!selectedCourseId) return alert("먼저 과정(차수)을 선택하세요.");
  const pid = document.getElementById("load-program").value;
  const baseDate = document.getElementById("load-basedate").value;
  if (!pid) return alert("불러올 커리큘럼을 선택하세요.");
  if (!baseDate) return alert("1일차 기준일을 선택하세요.");
  const prog = getProgramById(pid);
  const subjects = prog?.subjects || [];
  if (!subjects.length) return alert("선택한 커리큘럼에 과목이 없습니다.");
  if (!confirm(`'${prog.name}' 커리큘럼의 ${subjects.length}개 과목을 시간표로 생성합니다.\n(1일차 = ${baseDate})`)) return;

  const batch = writeBatch(db);
  for (const s of subjects) {
    const d = new Date(baseDate + "T00:00:00");
    d.setDate(d.getDate() + ((s.dayNo || 1) - 1));
    const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    const ref = doc(sessionsCol);
    batch.set(ref, {
      courseId: selectedCourseId,
      date: dateStr,
      subject: s.subject,
      startTime: s.startTime,
      endTime: s.endTime,
      room: "",
      instructor: "",
      instructorId: "",
      teacherKind: s.teacherKind || "",
    });
  }
  try {
    await batch.commit();
    alert("커리큘럼을 시간표로 불러왔습니다. 강의실·강사를 개별 지정하세요.");
  } catch (e) { alert("불러오기 실패: " + e.message); }
}

function subscribeSessions(tbody, form, submitBtn, cancelBtn) {
  if (unsub) unsub();
  sessionsCache = [];
  if (!selectedCourseId) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty">과정을 선택하세요.</td></tr>`;
    return;
  }
  const q = query(sessionsCol, where("courseId", "==", selectedCourseId));
  unsub = onSnapshot(q, (snap) => {
    sessionsCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    sessionsCache.sort((a, b) => (a.date + a.startTime).localeCompare(b.date + b.startTime));
    renderTable(tbody, form, submitBtn, cancelBtn);
  });
}

export function checkConflict(data, existing, ignoreId) {
  for (const s of existing) {
    if (s.id === ignoreId) continue;
    if (!data.room || s.room !== data.room || s.date !== data.date) continue;
    if (data.startTime < s.endTime && s.startTime < data.endTime) return s;
  }
  return null;
}

function fillOptions(sel, values) {
  for (const v of values) {
    const o = document.createElement("option");
    o.value = v; o.textContent = v;
    sel.appendChild(o);
  }
}

function readForm(form) {
  const instName = form.instructor.value.trim();
  const inst = instName ? getInstructors().find((i) => i.name === instName) : null;
  return {
    date: form.date.value,
    subject: form.subject.value.trim(),
    startTime: form.startTime.value,
    endTime: form.endTime.value,
    room: form.room.value,
    instructor: instName,
    instructorId: inst ? inst.id : "",
  };
}

function validate(d) {
  if (!d.date) return "일자를 선택하세요.";
  if (!d.subject) return "과목명을 입력하세요.";
  if (!d.startTime || !d.endTime) return "시작/종료 시각을 선택하세요.";
  if (d.endTime <= d.startTime) return "종료시각은 시작시각 이후여야 합니다.";
  if (!d.room) return "강의실을 선택하세요.";
  // 강사는 입력했다면 반드시 마스터에 존재해야 함(자유입력 불가).
  if (d.instructor && !d.instructorId) return "강사는 강사 마스터에 등록된 강사만 선택할 수 있습니다.";
  return null;
}

function resetForm(form, submitBtn, cancelBtn) {
  form.reset();
  editingId = null;
  submitBtn.textContent = "등록";
  cancelBtn.hidden = true;
}

function renderTable(tbody, form, submitBtn, cancelBtn) {
  tbody.innerHTML = "";
  if (!sessionsCache.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty">등록된 시간표가 없습니다.</td></tr>`;
    return;
  }
  for (const s of sessionsCache) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(s.date ?? "")}</td>
      <td>${escapeHtml(s.startTime ?? "")}~${escapeHtml(s.endTime ?? "")}</td>
      <td>${escapeHtml(s.subject ?? "")}</td>
      <td>${escapeHtml(s.room ?? "") || "<span class='warn'>미지정</span>"}</td>
      <td>${escapeHtml(s.instructor ?? "") || "<span class='warn'>미지정</span>"}</td>
      <td>${escapeHtml(s.teacherKind ?? "")}</td>
      <td class="actions">
        <button type="button" class="edit">수정</button>
        <button type="button" class="del">삭제</button>
      </td>`;
    tr.querySelector(".edit").addEventListener("click", () => {
      editingId = s.id;
      form.date.value = s.date ?? "";
      form.subject.value = s.subject ?? "";
      form.startTime.value = s.startTime ?? "";
      form.endTime.value = s.endTime ?? "";
      form.room.value = s.room ?? "";
      form.instructor.value = s.instructor ?? "";
      submitBtn.textContent = "수정 저장";
      cancelBtn.hidden = false;
      form.scrollIntoView({ behavior: "smooth" });
    });
    tr.querySelector(".del").addEventListener("click", async () => {
      if (!confirm(`'${s.subject}' 시간표를 삭제하시겠습니까?`)) return;
      try { await deleteDoc(doc(db, "sessions", s.id)); } catch (e) { alert("삭제 실패: " + e.message); }
    });
    tbody.appendChild(tr);
  }
}
