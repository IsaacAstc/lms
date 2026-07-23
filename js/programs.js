// 과정 커리큘럼 마스터 CRUD. 과목(subjects)은 문서 내 배열로 저장.
import { watchCollection, onCollection, addItem, updateItem, removeItem, getCache } from "./store.js";
import { escapeHtml } from "./app.js";
import { TEACHER_KINDS, START_TIMES, END_TIMES } from "./constants.js";

let editingId = null;
let subjectsDraft = []; // 현재 편집 중인 과목 배열
let editingSubjIndex = null; // 편집 중인 과목의 인덱스(null=신규 추가)

export function getPrograms() {
  return [...getCache("programs")].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
}
export function onProgramsChange(cb) {
  return onCollection("programs", () => cb(getPrograms()));
}
export function getProgramById(id) {
  return getCache("programs").find((p) => p.id === id) || null;
}

export function initPrograms() {
  watchCollection("programs");
  const form = document.getElementById("program-form");
  const tbody = document.getElementById("program-tbody");
  const submitBtn = document.getElementById("program-submit");
  const cancelBtn = document.getElementById("program-cancel");
  const addSubjBtn = document.getElementById("subject-add");

  // 과목 입력 보조 드롭다운.
  fillSelect(document.getElementById("subj-kind"), TEACHER_KINDS);
  fillSelect(document.getElementById("subj-start"), START_TIMES);
  fillSelect(document.getElementById("subj-end"), END_TIMES);

  const subjCancelBtn = document.getElementById("subject-cancel");

  addSubjBtn.addEventListener("click", () => {
    const dayNo = Number(document.getElementById("subj-day").value) || 1;
    const subject = document.getElementById("subj-name").value.trim();
    const startTime = document.getElementById("subj-start").value;
    const endTime = document.getElementById("subj-end").value;
    const teacherKind = document.getElementById("subj-kind").value;
    const content = document.getElementById("subj-content").value.trim();
    if (!subject) return alert("과목명을 입력하세요.");
    if (endTime <= startTime) return alert("종료시각은 시작시각 이후여야 합니다.");
    if (editingSubjIndex != null) {
      // 기존 과목 편집 반영(순서 유지).
      const keepOrder = subjectsDraft[editingSubjIndex]?.order ?? (editingSubjIndex + 1) * 10;
      subjectsDraft[editingSubjIndex] = { order: keepOrder, dayNo, subject, startTime, endTime, teacherKind, content };
    } else {
      subjectsDraft.push({ order: (subjectsDraft.length + 1) * 10, dayNo, subject, startTime, endTime, teacherKind, content });
    }
    clearSubjInputs();
    renderDraft();
  });

  subjCancelBtn.addEventListener("click", clearSubjInputs);

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = {
      name: form.name.value.trim(),
      category: form.category.value.trim(),
      totalDays: form.totalDays.value ? Number(form.totalDays.value) : null,
      totalHours: form.totalHours.value ? Number(form.totalHours.value) : null,
      note: form.note.value.trim(),
      subjects: subjectsDraft,
    };
    if (!data.name) return alert("과정명을 입력하세요.");
    try {
      if (editingId) await updateItem("programs", editingId, data);
      else await addItem("programs", data);
      reset(form, submitBtn, cancelBtn);
    } catch (err) { alert("저장 실패: " + err.message); }
  });
  cancelBtn.addEventListener("click", () => reset(form, submitBtn, cancelBtn));

  onCollection("programs", () => renderList(tbody, form, submitBtn, cancelBtn));
}

function fillSelect(sel, values) {
  for (const v of values) {
    const o = document.createElement("option");
    o.value = v; o.textContent = v;
    sel.appendChild(o);
  }
}

function reset(form, submitBtn, cancelBtn) {
  form.reset();
  editingId = null;
  subjectsDraft = [];
  clearSubjInputs();
  renderDraft();
  submitBtn.textContent = "등록";
  cancelBtn.hidden = true;
}

// 과목 입력칸 초기화 + 신규 추가 모드로 전환.
function clearSubjInputs() {
  editingSubjIndex = null;
  document.getElementById("subj-name").value = "";
  document.getElementById("subj-content").value = "";
  document.getElementById("subject-add").textContent = "과목 추가";
  document.getElementById("subject-cancel").hidden = true;
}

// 과목을 입력칸으로 불러와 편집 모드로 전환.
function editSubject(idx) {
  const s = subjectsDraft[idx];
  if (!s) return;
  document.getElementById("subj-day").value = s.dayNo ?? 1;
  document.getElementById("subj-name").value = s.subject ?? "";
  document.getElementById("subj-start").value = s.startTime ?? "";
  document.getElementById("subj-end").value = s.endTime ?? "";
  document.getElementById("subj-kind").value = s.teacherKind ?? "";
  document.getElementById("subj-content").value = s.content ?? "";
  editingSubjIndex = idx;
  document.getElementById("subject-add").textContent = "과목 수정 반영";
  document.getElementById("subject-cancel").hidden = false;
}

// 편집 중 과목 목록.
function renderDraft() {
  const box = document.getElementById("subject-draft");
  if (!subjectsDraft.length) {
    box.innerHTML = `<p class="empty">추가된 과목이 없습니다.</p>`;
    return;
  }
  const rows = subjectsDraft
    .map(
      (s, idx) => `<tr${idx === editingSubjIndex ? ' class="editing-row"' : ""}>
        <td>${s.dayNo}일차</td>
        <td>${escapeHtml(s.subject)}</td>
        <td>${s.startTime}~${s.endTime}</td>
        <td>${escapeHtml(s.teacherKind)}</td>
        <td class="actions">
          <button type="button" data-i="${idx}" class="edit-subj">편집</button>
          <button type="button" data-i="${idx}" class="del-subj">삭제</button>
        </td>
      </tr>`
    )
    .join("");
  box.innerHTML = `<table><thead><tr><th>일차</th><th>과목</th><th>시간</th><th>교관</th><th>관리</th></tr></thead><tbody>${rows}</tbody></table>`;
  box.querySelectorAll(".edit-subj").forEach((b) =>
    b.addEventListener("click", () => editSubject(Number(b.dataset.i)))
  );
  box.querySelectorAll(".del-subj").forEach((b) =>
    b.addEventListener("click", () => {
      const i = Number(b.dataset.i);
      subjectsDraft.splice(i, 1);
      if (editingSubjIndex === i) clearSubjInputs();
      else if (editingSubjIndex != null && editingSubjIndex > i) editingSubjIndex -= 1;
      renderDraft();
    })
  );
}

// 과정을 폼으로 불러온다. copy=true면 신규 등록용(사본), false면 기존 수정.
function loadIntoForm(form, p, submitBtn, cancelBtn, copy) {
  editingId = copy ? null : p.id;
  form.name.value = copy ? `${p.name} (사본)` : (p.name ?? "");
  form.category.value = p.category ?? "";
  form.totalDays.value = p.totalDays ?? "";
  form.totalHours.value = p.totalHours ?? "";
  form.note.value = p.note ?? "";
  subjectsDraft = (p.subjects || []).map((s) => ({ ...s }));
  clearSubjInputs();
  renderDraft();
  submitBtn.textContent = copy ? "사본 등록" : "수정 저장";
  cancelBtn.hidden = false;
  form.scrollIntoView({ behavior: "smooth" });
}

function renderList(tbody, form, submitBtn, cancelBtn) {
  const list = getPrograms();
  tbody.innerHTML = "";
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="5" class="empty">등록된 과정이 없습니다.</td></tr>`;
    return;
  }
  for (const p of list) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(p.name)}</td>
      <td>${escapeHtml(p.category ?? "")}</td>
      <td>${p.totalDays ?? ""}${p.totalDays ? "일" : ""}</td>
      <td>${(p.subjects || []).length}과목</td>
      <td class="actions">
        <button type="button" class="edit">수정</button>
        <button type="button" class="copy">복사</button>
        <button type="button" class="del">삭제</button>
      </td>`;
    tr.querySelector(".edit").addEventListener("click", () => {
      loadIntoForm(form, p, submitBtn, cancelBtn, false);
    });
    tr.querySelector(".copy").addEventListener("click", () => {
      loadIntoForm(form, p, submitBtn, cancelBtn, true);
    });
    tr.querySelector(".del").addEventListener("click", async () => {
      if (!confirm(`'${p.name}' 과정을 삭제하시겠습니까?`)) return;
      try { await removeItem("programs", p.id); } catch (err) { alert("삭제 실패: " + err.message); }
    });
    tbody.appendChild(tr);
  }
}
