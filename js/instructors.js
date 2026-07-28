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

// ── 강사유형·여비기준 이력(발효일자 기준) ──
// history: [{ from: 'YYYY-MM-DD', instructorType, travelBasis }, ...]
// 해당 일자에 유효한 값을 반환. 이력이 없으면 마스터의 현재값(하위호환),
// 이력이 있으나 일자가 첫 이력보다 이르면 가장 이른 이력을 최초값으로 본다.
export function resolveInstructorAt(inst, dateStr) {
  const cur = {
    instructorType: inst?.instructorType || "",
    travelBasis: inst?.travelBasis || "",
  };
  const hist = (Array.isArray(inst?.history) ? inst.history : [])
    .filter((h) => h && h.from)
    .sort((a, b) => a.from.localeCompare(b.from));
  if (!hist.length || !dateStr) return cur;
  let picked = hist[0]; // 첫 이력 이전 날짜는 최초값으로 처리.
  for (const h of hist) { if (h.from <= dateStr) picked = h; else break; }
  return {
    instructorType: picked.instructorType || cur.instructorType,
    travelBasis: picked.travelBasis || cur.travelBasis,
  };
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

// 이력이 있으면 현재값 옆에 표시(과거 기간은 다른 값으로 계산됨을 알림).
function histBadge(i) {
  const n = Array.isArray(i.history) ? i.history.filter((h) => h && h.from).length : 0;
  return n ? ` <span class="grp-count">이력 ${n}</span>` : "";
}

// ── 이력 편집기(행 아래 펼침) ──
function toggleHistory(tr, inst) {
  const next = tr.nextElementSibling;
  if (next?.classList.contains("hist-row")) { next.remove(); return; }
  const row = document.createElement("tr");
  row.className = "hist-row";
  const td = document.createElement("td");
  td.colSpan = 7;
  row.appendChild(td);
  tr.after(row);
  renderHistoryEditor(td, inst);
}

function renderHistoryEditor(td, inst) {
  // 화면에서만 다루는 작업본(저장 시 문서에 반영).
  const draft = (Array.isArray(inst.history) ? inst.history : [])
    .map((h) => ({ from: h.from || "", instructorType: h.instructorType || "", travelBasis: h.travelBasis || "" }))
    .sort((a, b) => a.from.localeCompare(b.from));

  const typeOpts = (sel) => {
    const keys = Object.keys(getFeeRates());
    const types = keys.length ? keys : INSTRUCTOR_TYPES;
    return [`<option value="">선택</option>`]
      .concat(types.map((t) => `<option${t === sel ? " selected" : ""}>${escapeHtml(t)}</option>`)).join("");
  };

  const paint = () => {
    const rows = draft.map((h, idx) => `
      <tr>
        <td><input type="date" class="h-from" data-i="${idx}" value="${escapeHtml(h.from)}"></td>
        <td><select class="h-type" data-i="${idx}">${typeOpts(h.instructorType)}</select></td>
        <td><input class="h-basis" data-i="${idx}" list="travel-basis-list" value="${escapeHtml(h.travelBasis)}"></td>
        <td class="actions"><button type="button" class="del h-del" data-i="${idx}">삭제</button></td>
      </tr>`).join("");
    td.innerHTML = `
      <div class="hist-box">
        <b>${escapeHtml(inst.name)}</b> 강사유형·여비기준 이력
        <p class="hint">발효일자부터 그 값이 적용됩니다. 강사료·소요경비는 <b>강의 일자에 유효한 값</b>으로 계산됩니다.
          이력이 없으면 현재 마스터 값(<b>${escapeHtml(inst.instructorType || "-")}</b> / ${escapeHtml(inst.travelBasis || "-")})이 모든 기간에 적용됩니다.</p>
        <div class="table-wrap"><table>
          <thead><tr><th>발효일자</th><th>강사유형</th><th>여비기준</th><th>관리</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="4" class="empty">등록된 이력이 없습니다.</td></tr>`}</tbody>
        </table></div>
        <div class="form-actions">
          <button type="button" class="h-add">이력 추가</button>
          <button type="button" class="h-save">이력 저장</button>
        </div>
      </div>`;

    td.querySelectorAll(".h-from").forEach((el) => el.addEventListener("change", (e) => { draft[+e.target.dataset.i].from = e.target.value; }));
    td.querySelectorAll(".h-type").forEach((el) => el.addEventListener("change", (e) => { draft[+e.target.dataset.i].instructorType = e.target.value; }));
    td.querySelectorAll(".h-basis").forEach((el) => el.addEventListener("input", (e) => { draft[+e.target.dataset.i].travelBasis = e.target.value; }));
    td.querySelectorAll(".h-del").forEach((el) => el.addEventListener("click", (e) => { draft.splice(+e.target.dataset.i, 1); paint(); }));

    td.querySelector(".h-add").addEventListener("click", () => {
      const last = draft[draft.length - 1];
      // 직전 값(없으면 현재 마스터 값)을 기본으로 채워 한쪽만 바뀌는 경우도 쉽게 입력.
      draft.push({
        from: "",
        instructorType: last?.instructorType || inst.instructorType || "",
        travelBasis: last?.travelBasis || inst.travelBasis || "",
      });
      paint();
    });

    td.querySelector(".h-save").addEventListener("click", async () => {
      const clean = draft
        .map((h) => ({ from: (h.from || "").trim(), instructorType: h.instructorType || "", travelBasis: (h.travelBasis || "").trim() }))
        .filter((h) => h.from || h.instructorType || h.travelBasis);
      if (clean.some((h) => !h.from)) return alert("발효일자를 모두 입력하세요.");
      if (clean.some((h) => !h.instructorType)) return alert("강사유형을 모두 선택하세요.");
      const froms = clean.map((h) => h.from);
      if (new Set(froms).size !== froms.length) return alert("발효일자가 중복되었습니다.");
      clean.sort((a, b) => a.from.localeCompare(b.from));
      // 최신 이력을 마스터 현재값에도 반영해 목록·신규 계산 기본값이 어긋나지 않게 한다.
      const latest = clean[clean.length - 1];
      const patch = { history: clean };
      if (latest) { patch.instructorType = latest.instructorType; patch.travelBasis = latest.travelBasis; }
      try {
        await updateItem("instructors", inst.id, patch);
        alert("이력을 저장했습니다.");
      } catch (err) { alert("저장 실패: " + err.message); }
    });
  };
  paint();
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
      <td>${escapeHtml(i.instructorType ?? "")}${histBadge(i)}</td>
      <td>${escapeHtml(i.travelBasis ?? "")}</td>
      <td>${escapeHtml(i.position ?? "")}</td>
      <td>${i.careerYears ?? ""}</td>
      <td class="actions">
        <button type="button" class="hist">이력</button>
        <button type="button" class="edit">수정</button>
        <button type="button" class="del">삭제</button>
      </td>`;
    tr.querySelector(".hist").addEventListener("click", () => toggleHistory(tr, i));
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
