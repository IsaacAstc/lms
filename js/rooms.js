// 강의실 마스터 CRUD.
import { watchCollection, onCollection, addItem, updateItem, removeItem, getCache } from "./store.js";
import { escapeHtml } from "./app.js";

let editingId = null;

export function getRooms() {
  return [...getCache("rooms")].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}
export function onRoomsChange(cb) {
  return onCollection("rooms", () => cb(getRooms()));
}

export function initRooms() {
  watchCollection("rooms");
  const form = document.getElementById("room-form");
  const tbody = document.getElementById("room-tbody");
  const submitBtn = document.getElementById("room-submit");
  const cancelBtn = document.getElementById("room-cancel");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = {
      name: form.name.value.trim(),
      capacity: form.capacity.value ? Number(form.capacity.value) : null,
      order: form.order.value ? Number(form.order.value) : 0,
      note: form.note.value.trim(),
    };
    if (!data.name) return alert("강의실명을 입력하세요.");
    try {
      if (editingId) await updateItem("rooms", editingId, data);
      else await addItem("rooms", data);
      reset(form, submitBtn, cancelBtn);
    } catch (err) {
      alert("저장 실패: " + err.message);
    }
  });
  cancelBtn.addEventListener("click", () => reset(form, submitBtn, cancelBtn));

  onCollection("rooms", () => render(tbody, form, submitBtn, cancelBtn));
}

function reset(form, submitBtn, cancelBtn) {
  form.reset();
  editingId = null;
  submitBtn.textContent = "등록";
  cancelBtn.hidden = true;
}

function render(tbody, form, submitBtn, cancelBtn) {
  const rooms = getRooms();
  tbody.innerHTML = "";
  if (!rooms.length) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty">등록된 강의실이 없습니다.</td></tr>`;
    return;
  }
  const base = location.origin + location.pathname.replace(/[^/]*$/, "");
  for (const r of rooms) {
    const url = `${base}survey.html?room=${r.id}`;
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${r.order ?? ""}</td>
      <td>${escapeHtml(r.name)}</td>
      <td>${r.capacity ?? ""}</td>
      <td>${escapeHtml(r.note ?? "")}</td>
      <td class="url-cell"><input readonly value="${escapeHtml(url)}"><button type="button" class="copy url-copy">복사</button></td>
      <td class="actions">
        <button type="button" class="edit">수정</button>
        <button type="button" class="del">삭제</button>
      </td>`;
    tr.querySelector(".url-copy").addEventListener("click", () => {
      navigator.clipboard?.writeText(url);
      tr.querySelector(".url-copy").textContent = "복사됨";
    });
    tr.querySelector(".edit").addEventListener("click", () => {
      editingId = r.id;
      form.name.value = r.name ?? "";
      form.capacity.value = r.capacity ?? "";
      form.order.value = r.order ?? "";
      form.note.value = r.note ?? "";
      submitBtn.textContent = "수정 저장";
      cancelBtn.hidden = false;
      form.scrollIntoView({ behavior: "smooth" });
    });
    tr.querySelector(".del").addEventListener("click", async () => {
      if (!confirm(`'${r.name}' 강의실을 삭제하시겠습니까?`)) return;
      try { await removeItem("rooms", r.id); } catch (err) { alert("삭제 실패: " + err.message); }
    });
    tbody.appendChild(tr);
  }
}
