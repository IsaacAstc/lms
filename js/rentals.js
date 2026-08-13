// 현장 안내: 대관 행사 관리 + DID(현장 안내 화면) 설정.
// rentals/{id}: { name, startDate, endDate, startTime, endTime, venue, note, hidden, updatedAtMs }
//   — 공개 표시용 정보만(행사명·장소·시간). 개인정보(담당자·연락처 등)는 저장하지 않는다.
// DID 설정은 publicBoard/__did 문서(제목·안내문구·로고·배경) — 공개 읽기/관리자 쓰기 규칙 재사용.
import {
  collection, addDoc, doc, updateDoc, deleteDoc, onSnapshot, getDoc, setDoc, query, orderBy,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./firebase.js";
import { escapeHtml } from "./app.js";
import { onRoomsChange, getRooms } from "./rooms.js";
import { orgQuery } from "./orgs.js";
import { fmtDot } from "./time.js";

const col = collection(db, "rentals");
let unsub = null;
let editingId = null;
let cache = [];

export function initRentals() {
  const form = document.getElementById("rental-form");
  const tbody = document.getElementById("rental-tbody");
  const cancelBtn = document.getElementById("rental-cancel");
  const submitBtn = document.getElementById("rental-submit");

  // 장소 제안: 강의실 마스터 + 자유 입력(대강당·야외 등).
  onRoomsChange(() => {
    const dl = document.getElementById("rental-venue-list");
    dl.innerHTML = getRooms().map((r) => `<option value="${escapeHtml(r.name)}">`).join("");
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = readForm(form);
    const err = validate(data);
    if (err) return alert(err);
    try {
      if (editingId) await updateDoc(doc(db, "rentals", editingId), data);
      else await addDoc(col, data);
      resetForm(form, submitBtn, cancelBtn);
    } catch (e2) { alert("저장 실패: " + e2.message); }
  });
  cancelBtn.addEventListener("click", () => resetForm(form, submitBtn, cancelBtn));

  unsub = onSnapshot(query(col, orderBy("startDate", "desc")), (snap) => {
    cache = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    renderTable(tbody, form, submitBtn, cancelBtn);
  }, (err) => {
    tbody.innerHTML = `<tr><td colspan="7" class="empty">목록을 불러오지 못했습니다: ${escapeHtml(err.code || err.message)}<br>보안규칙(rentals) 재배포 여부를 확인하세요.</td></tr>`;
  });

  initDidConfig();
  document.addEventListener("tabshown", (e) => { if (e.detail === "rentals") loadDidConfig(); });
}

function readForm(form) {
  return {
    name: form.rname.value.trim(),
    startDate: form.rstart.value,
    endDate: form.rend.value || form.rstart.value,
    startTime: form.rstime.value,
    endTime: form.retime.value,
    venue: form.rvenue.value.trim(),
    note: form.rnote.value.trim(),
    hidden: form.rhide.checked,
    updatedAtMs: Date.now(),
  };
}
function validate(d) {
  if (!d.name) return "행사명을 입력하세요.";
  if (!d.startDate) return "시작일을 입력하세요.";
  if (d.endDate < d.startDate) return "종료일은 시작일 이후여야 합니다.";
  if (d.startTime && d.endTime && d.endTime < d.startTime) return "종료시간은 시작시간 이후여야 합니다.";
  if (!d.venue) return "장소를 입력하세요.";
  return null;
}
function resetForm(form, submitBtn, cancelBtn) {
  form.reset();
  editingId = null;
  submitBtn.textContent = "등록";
  cancelBtn.hidden = true;
}

function periodText(r) {
  const s = fmtDot(r.startDate || "");
  if (!r.endDate || r.endDate === r.startDate) return s;
  return `${s} - ${fmtDot(r.endDate)}`;
}

function renderTable(tbody, form, submitBtn, cancelBtn) {
  if (!cache.length) {
    tbody.innerHTML = `<tr><td colspan="7" class="empty">등록된 대관 행사가 없습니다.</td></tr>`;
    return;
  }
  tbody.innerHTML = "";
  for (const r of cache) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${escapeHtml(r.name)}</td>
      <td>${escapeHtml(periodText(r))}</td>
      <td>${escapeHtml(r.startTime || "")}${r.endTime ? ` - ${escapeHtml(r.endTime)}` : ""}</td>
      <td>${escapeHtml(r.venue || "")}</td>
      <td>${escapeHtml(r.note || "")}</td>
      <td style="text-align:center"><input type="checkbox" class="r-hide"${r.hidden ? " checked" : ""} title="체크 시 DID에 미표시"></td>
      <td class="actions">
        <button type="button" class="edit">수정</button>
        <button type="button" class="del">삭제</button>
      </td>`;
    tr.querySelector(".r-hide").addEventListener("change", async (e) => {
      try { await updateDoc(doc(db, "rentals", r.id), { hidden: e.target.checked, updatedAtMs: Date.now() }); }
      catch (err) { e.target.checked = !e.target.checked; alert("저장 실패: " + err.message); }
    });
    tr.querySelector(".edit").addEventListener("click", () => {
      editingId = r.id;
      form.rname.value = r.name ?? "";
      form.rstart.value = r.startDate ?? "";
      form.rend.value = r.endDate ?? "";
      form.rstime.value = r.startTime ?? "";
      form.retime.value = r.endTime ?? "";
      form.rvenue.value = r.venue ?? "";
      form.rnote.value = r.note ?? "";
      form.rhide.checked = !!r.hidden;
      submitBtn.textContent = "수정 저장";
      cancelBtn.hidden = false;
      form.scrollIntoView({ behavior: "smooth" });
    });
    tr.querySelector(".del").addEventListener("click", async () => {
      if (!confirm(`'${r.name}' 대관을 삭제할까요?`)) return;
      try { await deleteDoc(doc(db, "rentals", r.id)); } catch (e) { alert("삭제 실패: " + e.message); }
    });
    tbody.appendChild(tr);
  }
}

// ── DID 설정 ──
function initDidConfig() {
  const base = location.origin + location.pathname.replace(/[^/]*$/, "");
  const url = `${base}did.html${orgQuery(true)}`;
  document.getElementById("did-url").value = url;
  document.getElementById("did-open").href = url;
  document.getElementById("did-url-copy").addEventListener("click", () => {
    navigator.clipboard?.writeText(url);
    document.getElementById("did-url-copy").textContent = "복사됨";
  });
  document.getElementById("did-save").addEventListener("click", async () => {
    try {
      await setDoc(doc(db, "publicBoard", "__did"), {
        title: document.getElementById("did-title").value.trim(),
        notice: document.getElementById("did-notice").value.trim(),
        logoUrl: document.getElementById("did-logo").value.trim(),
        bgUrl: document.getElementById("did-bg").value.trim(),
        updatedAtMs: Date.now(),
      }, { merge: true });
      alert("DID 설정을 저장했습니다. 표출 화면에 즉시 반영됩니다.");
    } catch (e) { alert("저장 실패: " + e.message); }
  });
}
async function loadDidConfig() {
  try {
    const d = await getDoc(doc(db, "publicBoard", "__did"));
    const c = d.exists() ? d.data() : {};
    document.getElementById("did-title").value = c.title || "";
    document.getElementById("did-notice").value = c.notice || "";
    document.getElementById("did-logo").value = c.logoUrl || "";
    document.getElementById("did-bg").value = c.bgUrl || "";
  } catch { /* */ }
}
