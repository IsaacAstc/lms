// 강사 마스터 CRUD. (강사만 개인정보 예외 허용 — 관리자 전용 저장)
import { watchCollection, onCollection, addItem, updateItem, removeItem, getCache } from "./store.js";
import { escapeHtml } from "./app.js";
import { INSTRUCTOR_TYPES } from "./constants.js";
import { getTravelRates, getFeeRates } from "./settings.js";

let editingId = null;

export function getInstructors() {
  return [...getCache("instructors")].sort((a, b) => (a.name || "").localeCompare(b.name || ""));
}
export function onInstructorsChange(cb) {
  return onCollection("instructors", () => cb(getInstructors()));
}
export function getInstructorById(id) {
  return getCache("instructors").find((i) => i.id === id) || null;
}

export function initInstructors() {
  watchCollection("instructors");
  const form = document.getElementById("instructor-form");
  const tbody = document.getElementById("instructor-tbody");
  const submitBtn = document.getElementById("instructor-submit");
  const cancelBtn = document.getElementById("instructor-cancel");
  const search = document.getElementById("instructor-search");

  // 강사유형 드롭다운(강사료 기준 키 기반, 없으면 기본 9종). 설정 변경 시 갱신.
  const refreshTypeList = () => {
    const keys = Object.keys(getFeeRates());
    const types = keys.length ? keys : INSTRUCTOR_TYPES;
    const prev = form.instructorType.value;
    form.instructorType.innerHTML = `<option value="">선택</option>`;
    for (const t of types) {
      const o = document.createElement("option");
      o.value = t; o.textContent = t;
      form.instructorType.appendChild(o);
    }
    if (prev) form.instructorType.value = prev;
  };
  // 여비기준 datalist (설정값 기반).
  const refreshTravelList = () => {
    const dl = document.getElementById("travel-basis-list");
    dl.innerHTML = "";
    for (const k of Object.keys(getTravelRates())) {
      const o = document.createElement("option");
      o.value = k;
      dl.appendChild(o);
    }
  };
  onCollection("settings", () => { refreshTypeList(); refreshTravelList(); });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = {
      name: form.name.value.trim(),
      affiliation: form.affiliation.value.trim(),
      travelBasis: form.travelBasis.value.trim(),
      instructorType: form.instructorType.value,
      position: form.position.value.trim(),
      careerYears: form.careerYears.value ? Number(form.careerYears.value) : null,
      careerDetail: form.careerDetail.value.trim(),
    };
    if (!data.name) return alert("강사명을 입력하세요.");
    if (!data.instructorType) return alert("강사유형을 선택하세요.");
    try {
      if (editingId) await updateItem("instructors", editingId, data);
      else await addItem("instructors", data);
      reset(form, submitBtn, cancelBtn);
    } catch (err) { alert("저장 실패: " + err.message); }
  });
  cancelBtn.addEventListener("click", () => reset(form, submitBtn, cancelBtn));
  search.addEventListener("input", () => render(tbody, form, submitBtn, cancelBtn, search.value.trim()));

  onCollection("instructors", () => render(tbody, form, submitBtn, cancelBtn, search.value.trim()));
}

function reset(form, submitBtn, cancelBtn) {
  form.reset();
  editingId = null;
  submitBtn.textContent = "등록";
  cancelBtn.hidden = true;
}

function render(tbody, form, submitBtn, cancelBtn, keyword) {
  let list = getInstructors();
  if (keyword) {
    const k = keyword.toLowerCase();
    list = list.filter((i) =>
      [i.name, i.affiliation, i.instructorType, i.position].some((v) => (v || "").toLowerCase().includes(k))
    );
  }
  tbody.innerHTML = "";
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty">강사가 없습니다.</td></tr>`;
    return;
  }
  for (const i of list) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(i.name)}</td>
      <td>${escapeHtml(i.affiliation ?? "")}</td>
      <td>${escapeHtml(i.instructorType ?? "")}</td>
      <td>${escapeHtml(i.travelBasis ?? "")}</td>
      <td>${escapeHtml(i.position ?? "")}</td>
      <td>${i.careerYears ?? ""}</td>
      <td class="actions">
        <button type="button" class="edit">수정</button>
        <button type="button" class="del">삭제</button>
      </td>`;
    tr.querySelector(".edit").addEventListener("click", () => {
      editingId = i.id;
      form.name.value = i.name ?? "";
      form.affiliation.value = i.affiliation ?? "";
      form.travelBasis.value = i.travelBasis ?? "";
      form.instructorType.value = i.instructorType ?? "";
      form.position.value = i.position ?? "";
      form.careerYears.value = i.careerYears ?? "";
      form.careerDetail.value = i.careerDetail ?? "";
      submitBtn.textContent = "수정 저장";
      cancelBtn.hidden = false;
      form.scrollIntoView({ behavior: "smooth" });
    });
    tr.querySelector(".del").addEventListener("click", async () => {
      if (!confirm(`'${i.name}' 강사를 삭제하시겠습니까?`)) return;
      try { await removeItem("instructors", i.id); } catch (err) { alert("삭제 실패: " + err.message); }
    });
    tbody.appendChild(tr);
  }
}
