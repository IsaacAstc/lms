// 과정 커리큘럼 마스터 CRUD. 과목(subjects)은 문서 내 배열로 저장.
import { watchCollection, onCollection, addItem, updateItem, removeItem, getCache } from "./store.js";
import { escapeHtml } from "./app.js";
import { TEACHER_KINDS, START_TIMES, END_TIMES } from "./constants.js";

let editingId = null;
let subjectsDraft = []; // 현재 편집 중인 과목 배열

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

  addSubjBtn.addEventListener("click", () => {
    const dayNo = Number(document.getElementById("subj-day").value) || 1;
    const subject = document.getElementById("subj-name").value.trim();
    const startTime = document.getElementById("subj-start").value;
    const endTime = document.getElementById("subj-end").value;
    const teacherKind = document.getElementById("subj-kind").value;
    const content = document.getElementById("subj-content").value.trim();
    if (!subject) return alert("과목명을 입력하세요.");
    if (endTime <= startTime) return alert("종료시각은 시작시각 이후여야 합니다.");
    subjectsDraft.push({ order: (subjectsDraft.length + 1) * 10, dayNo, subject, startTime, endTime, teacherKind, content });
    document.getElementById("subj-name").value = "";
    document.getElementById("subj-content").value = "";
    renderDraft();
  });

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
  renderDraft();
  submitBtn.textContent = "등록";
  cancelBtn.hidden = true;
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
      (s, idx) => `<tr>
        <td>${s.dayNo}일차</td>
        <td>${escapeHtml(s.subject)}</td>
        <td>${s.startTime}~${s.endTime}</td>
        <td>${escapeHtml(s.teacherKind)}</td>
        <td><button type="button" data-i="${idx}" class="del-subj">삭제</button></td>
      </tr>`
    )
    .join("");
  box.innerHTML = `<table><thead><tr><th>일차</th><th>과목</th><th>시간</th><th>교관</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
  box.querySelectorAll(".del-subj").forEach((b) =>
    b.addEventListener("click", () => {
      subjectsDraft.splice(Number(b.dataset.i), 1);
      renderDraft();
    })
  );
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
        <button type="button" class="del">삭제</button>
      </td>`;
    tr.querySelector(".edit").addEventListener("click", () => {
      editingId = p.id;
      form.name.value = p.name ?? "";
      form.category.value = p.category ?? "";
      form.totalDays.value = p.totalDays ?? "";
      form.totalHours.value = p.totalHours ?? "";
      form.note.value = p.note ?? "";
      subjectsDraft = (p.subjects || []).map((s) => ({ ...s }));
      renderDraft();
      submitBtn.textContent = "수정 저장";
      cancelBtn.hidden = false;
      form.scrollIntoView({ behavior: "smooth" });
    });
    tr.querySelector(".del").addEventListener("click", async () => {
      if (!confirm(`'${p.name}' 과정을 삭제하시겠습니까?`)) return;
      try { await removeItem("programs", p.id); } catch (err) { alert("삭제 실패: " + err.message); }
    });
    tbody.appendChild(tr);
  }
}
