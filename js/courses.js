// 과정·차수 마스터 CRUD.
import {
  collection,
  addDoc,
  updateDoc,
  deleteDoc,
  doc,
  onSnapshot,
  query,
  orderBy,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./firebase.js";
import { escapeHtml } from "./app.js";
import { onProgramsChange, getProgramById, getPrograms } from "./programs.js";

const coursesCol = collection(db, "courses");
let unsub = null;
let editingId = null;
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
      if (editingId) {
        await updateDoc(doc(db, "courses", editingId), data);
      } else {
        await addDoc(coursesCol, data);
      }
      resetForm(form, submitBtn, cancelBtn);
    } catch (e) {
      alert("저장 실패: " + e.message);
    }
  });

  cancelBtn.addEventListener("click", () => resetForm(form, submitBtn, cancelBtn));

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

  // 과정명을 커리큘럼에서 선택하면 커리큘럼 연결을 자동 설정(이후 과정명 수정 가능).
  form.name.addEventListener("input", () => {
    const match = getPrograms().find((p) => p.name === form.name.value.trim());
    if (match) form.programId.value = match.id;
  });

  // 실시간 목록.
  const q = query(coursesCol, orderBy("code"));
  unsub = onSnapshot(q, (snap) => {
    coursesCache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderTable(tbody, form, submitBtn, cancelBtn);
    listeners.forEach((cb) => cb(coursesCache));
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
    round: Number(form.round.value),
    programId: form.programId.value || "",
    appliedCount: form.appliedCount.value ? Number(form.appliedCount.value) : 0,
    completedCount: form.completedCount.value ? Number(form.completedCount.value) : 0,
    hasEvaluation: form.hasEvaluation.checked,
  };
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

function renderTable(tbody, form, submitBtn, cancelBtn) {
  tbody.innerHTML = "";
  if (coursesCache.length === 0) {
    tbody.innerHTML = `<tr><td colspan="13" class="empty">등록된 과정이 없습니다.</td></tr>`;
    return;
  }
  for (const c of coursesCache) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(c.code)}</td>
      <td>${escapeHtml(c.name)}</td>
      <td>${c.round ?? ""}</td>
      <td>${c.capacity ?? ""}</td>
      <td>${c.appliedCount ?? 0}</td>
      <td>${remainingSeats(c)}</td>
      <td>${c.completedCount ?? 0}</td>
      <td style="text-align:center">${c.hasEvaluation ? "○" : ""}</td>
      <td>${escapeHtml(c.startDate ?? "")}</td>
      <td>${escapeHtml(c.endDate ?? "")}</td>
      <td>${escapeHtml(c.venue ?? "")}</td>
      <td>${escapeHtml(getProgramById(c.programId)?.name ?? "")}</td>
      <td class="actions">
        <button type="button" class="edit">수정</button>
        <button type="button" class="del">삭제</button>
      </td>`;
    tr.querySelector(".edit").addEventListener("click", () => {
      editingId = c.id;
      form.code.value = c.code ?? "";
      form.name.value = c.name ?? "";
      form.capacity.value = c.capacity ?? "";
      form.startDate.value = c.startDate ?? "";
      form.endDate.value = c.endDate ?? "";
      form.venue.value = c.venue ?? "";
      form.round.value = c.round ?? "";
      form.programId.value = c.programId ?? "";
      form.appliedCount.value = c.appliedCount ?? 0;
      form.completedCount.value = c.completedCount ?? 0;
      form.hasEvaluation.checked = !!c.hasEvaluation;
      submitBtn.textContent = "수정 저장";
      cancelBtn.hidden = false;
      form.scrollIntoView({ behavior: "smooth" });
    });
    tr.querySelector(".del").addEventListener("click", async () => {
      if (!confirm(`'${c.name}' ${c.round}차수를 삭제하시겠습니까?`)) return;
      try {
        await deleteDoc(doc(db, "courses", c.id));
      } catch (e) {
        alert("삭제 실패: " + e.message);
      }
    });
    tbody.appendChild(tr);
  }
}
