// 강의 시간표 입력 CRUD + 강의실 시간 중복 검증.
import {
  collection,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  onSnapshot,
  query,
  where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./firebase.js";
import { ROOMS, START_TIMES, END_TIMES } from "./constants.js";
import { onCoursesChange } from "./courses.js";
import { escapeHtml } from "./app.js";

const sessionsCol = collection(db, "sessions");
let unsub = null;
let editingId = null;
let selectedCourseId = "";
let sessionsCache = [];

export function initSessions() {
  const courseSel = document.getElementById("session-course");
  const form = document.getElementById("session-form");
  const tbody = document.getElementById("session-tbody");
  const cancelBtn = document.getElementById("session-cancel");
  const submitBtn = document.getElementById("session-submit");

  // 드롭다운 옵션 채우기.
  fillOptions(form.room, ROOMS);
  fillOptions(form.startTime, START_TIMES);
  fillOptions(form.endTime, END_TIMES);

  // 과정 셀렉트를 과정 목록과 동기화.
  onCoursesChange((courses) => {
    const prev = courseSel.value;
    courseSel.innerHTML = `<option value="">과정을 선택하세요</option>`;
    for (const c of courses) {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = `${c.code} ${c.name} (${c.round}차수)`;
      courseSel.appendChild(opt);
    }
    courseSel.value = prev;
  });

  courseSel.addEventListener("change", () => {
    selectedCourseId = courseSel.value;
    resetForm(form, submitBtn, cancelBtn);
    subscribeSessions(tbody, form, submitBtn, cancelBtn);
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!selectedCourseId) {
      alert("먼저 과정을 선택하세요.");
      return;
    }
    const data = readForm(form);
    const err = validate(data);
    if (err) {
      alert(err);
      return;
    }
    // 강의실 시간 중복 경고 (저장은 관리자 판단으로 진행 가능).
    const conflict = checkConflict(data, sessionsCache, editingId);
    if (conflict) {
      const go = confirm(
        `[중복 경고] ${data.room}에 ${data.date} ${conflict.startTime}~${conflict.endTime} ` +
          `'${conflict.subject}' 강의가 이미 있습니다.\n그래도 저장하시겠습니까?`
      );
      if (!go) return;
    }
    try {
      if (editingId) {
        await updateDoc(doc(db, "sessions", editingId), data);
      } else {
        await addDoc(sessionsCol, { courseId: selectedCourseId, ...data });
      }
      resetForm(form, submitBtn, cancelBtn);
    } catch (e) {
      alert("저장 실패: " + e.message);
    }
  });

  cancelBtn.addEventListener("click", () => resetForm(form, submitBtn, cancelBtn));
}

export function teardownSessions() {
  if (unsub) unsub();
  unsub = null;
}

function subscribeSessions(tbody, form, submitBtn, cancelBtn) {
  if (unsub) unsub();
  sessionsCache = [];
  if (!selectedCourseId) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty">과정을 선택하세요.</td></tr>`;
    return;
  }
  const q = query(sessionsCol, where("courseId", "==", selectedCourseId));
  unsub = onSnapshot(q, (snap) => {
    sessionsCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    // 일자 → 시작시각 순 정렬 (클라이언트 정렬로 복합 인덱스 회피).
    sessionsCache.sort((a, b) =>
      (a.date + a.startTime).localeCompare(b.date + b.startTime)
    );
    renderTable(tbody, form, submitBtn, cancelBtn);
  });
}

// 같은 일자·같은 강의실에서 시간대가 겹치는 세션을 반환 (없으면 null).
export function checkConflict(data, existing, ignoreId) {
  for (const s of existing) {
    if (s.id === ignoreId) continue;
    if (s.date !== data.date || s.room !== data.room) continue;
    // [start, end) 구간 겹침 판정.
    if (data.startTime < s.endTime && s.startTime < data.endTime) return s;
  }
  return null;
}

function fillOptions(sel, values) {
  for (const v of values) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = v;
    sel.appendChild(opt);
  }
}

function readForm(form) {
  return {
    date: form.date.value,
    subject: form.subject.value.trim(),
    startTime: form.startTime.value,
    endTime: form.endTime.value,
    room: form.room.value,
    instructor: form.instructor.value.trim(),
  };
}

function validate(d) {
  if (!d.date) return "일자를 선택하세요.";
  if (!d.subject) return "과목명을 입력하세요.";
  if (!d.startTime || !d.endTime) return "시작/종료 시각을 선택하세요.";
  if (d.endTime <= d.startTime) return "종료시각은 시작시각 이후여야 합니다.";
  if (!d.room) return "강의실을 선택하세요.";
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
  if (sessionsCache.length === 0) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty">등록된 시간표가 없습니다.</td></tr>`;
    return;
  }
  for (const s of sessionsCache) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(s.date ?? "")}</td>
      <td>${escapeHtml(s.startTime ?? "")}~${escapeHtml(s.endTime ?? "")}</td>
      <td>${escapeHtml(s.subject ?? "")}</td>
      <td>${escapeHtml(s.room ?? "")}</td>
      <td>${escapeHtml(s.instructor ?? "")}</td>
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
      try {
        await deleteDoc(doc(db, "sessions", s.id));
      } catch (e) {
        alert("삭제 실패: " + e.message);
      }
    });
    tbody.appendChild(tr);
  }
}
