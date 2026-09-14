// 자료실 관리(관리자): 공개 다운로드 목록 편집 + 공개 주소 안내.
//
// 파일 자체는 저장소의 files/ 폴더에 커밋해 GitHub Pages가 그대로 서빙하고,
// 여기서는 제목·설명·분류·순서 같은 '목록 정보'만 Firestore(downloads)에 둔다.
// 파일을 Firestore에 base64로 넣지 않는 이유: 신청양식(publicBoard/__form)처럼
// 수십 KB짜리 한 개면 몰라도, 자료실은 개수·크기가 늘어나는 곳이라 문서 1MB 상한과
// 읽기 요금에 금방 걸린다.
//
// ⚠ 저장소가 public이라 files/ 에 올린 파일은 목록에 등록하지 않아도 주소를 알면
//   받을 수 있다. 공개해도 되는 파일만 올린다(개인정보·내부 문서 금지).
import {
  collection, getDocs, query, orderBy,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./firebase.js";
import { escapeHtml } from "./app.js";
import { orgQuery } from "./orgs.js";
import { addItem, updateItem, removeItem } from "./store.js";

const COLL = "downloads";
const esc = escapeHtml;
const $ = (id) => document.getElementById(id);

let list = [];
let editingId = null;

export function initDownloadsAdmin() {
  $("dl-save").addEventListener("click", save);
  $("dl-cancel").addEventListener("click", resetForm);
  $("dl-url-copy").addEventListener("click", () => {
    navigator.clipboard?.writeText($("dl-url").value);
    $("dl-url-copy").textContent = "복사됨";
    setTimeout(() => { $("dl-url-copy").textContent = "주소 복사"; }, 1500);
  });
  document.addEventListener("tabshown", (e) => { if (e.detail === "downloads") load(); });
}

async function load() {
  const base = location.origin + location.pathname.replace(/[^/]*$/, "");
  $("dl-url").value = `${base}downloads.html${orgQuery(true)}`;
  $("dl-open").href = `${base}downloads.html${orgQuery(true)}`;
  try {
    const snap = await getDocs(query(collection(db, COLL), orderBy("order")));
    list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (e) {
    // 정렬 필드가 없는 문서가 섞여 있으면 orderBy가 비어 나올 수 있어, 정렬 없이 한 번 더.
    const snap = await getDocs(collection(db, COLL));
    list = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    list.sort((a, b) => (a.order || 0) - (b.order || 0));
  }
  paint();
}

const fmtSize = (n) => (!n ? "" : n < 1024 * 1024
  ? `${Math.round(n / 1024)}KB`
  : `${(n / (1024 * 1024)).toFixed(1)}MB`);

function paint() {
  const box = $("dl-list");
  if (!list.length) {
    box.innerHTML = `<p class="empty">등록된 자료가 없습니다. 아래에서 추가하세요.</p>`;
    return;
  }
  box.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>순서</th><th>분류</th><th>제목</th><th>파일</th><th>크기</th><th>공개</th><th></th></tr></thead>
    <tbody>${list.map((d) => `<tr>
      <td>${d.order ?? ""}</td>
      <td>${esc(d.category || "")}</td>
      <td><b>${esc(d.title || "")}</b>${d.desc ? `<br/><small class="muted">${esc(d.desc)}</small>` : ""}</td>
      <td><code>${esc(d.path || "")}</code></td>
      <td>${fmtSize(d.size)}</td>
      <td>${d.published ? `<span class="chip chip-on">공개</span>` : `<span class="chip">숨김</span>`}</td>
      <td class="row-actions">
        <button type="button" data-edit="${d.id}">편집</button>
        <button type="button" class="del" data-del="${d.id}">삭제</button>
      </td>
    </tr>`).join("")}</tbody></table></div>`;
  box.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => edit(b.dataset.edit)));
  box.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => del(b.dataset.del)));
}

function resetForm() {
  editingId = null;
  for (const id of ["dl-title", "dl-desc", "dl-path", "dl-category"]) $(id).value = "";
  $("dl-order").value = String((list.reduce((m, d) => Math.max(m, d.order || 0), 0)) + 10);
  $("dl-published").checked = true;
  $("dl-form-title").textContent = "자료 추가";
  $("dl-cancel").hidden = true;
  $("dl-msg").textContent = "";
}

function edit(id) {
  const d = list.find((x) => x.id === id);
  if (!d) return;
  editingId = id;
  $("dl-title").value = d.title || "";
  $("dl-desc").value = d.desc || "";
  $("dl-path").value = d.path || "";
  $("dl-category").value = d.category || "";
  $("dl-order").value = d.order ?? 0;
  $("dl-published").checked = !!d.published;
  $("dl-form-title").textContent = "자료 편집";
  $("dl-cancel").hidden = false;
  $("dl-msg").textContent = "";
  $("dl-title").scrollIntoView({ behavior: "smooth", block: "center" });
}

async function del(id) {
  const d = list.find((x) => x.id === id);
  if (!confirm(`"${d?.title || id}"를 목록에서 지울까요?\n\n파일 자체는 지워지지 않습니다 — files/ 폴더의 파일은 GitHub에서 따로 삭제해야 합니다.`)) return;
  try {
    await removeItem(COLL, id);
    if (editingId === id) resetForm();
    load();
  } catch (e) { alert("삭제 실패: " + e.message); }
}

/* 파일 경로 정리 — 관리자가 주소를 통째로 붙여넣거나 앞에 /를 붙여도 받아준다.
 * 저장은 항상 사이트 기준 상대경로(files/...)로 통일한다. */
function normalizePath(v) {
  let p = String(v || "").trim();
  if (!p) return "";
  p = p.replace(/^https?:\/\/[^/]+\//i, "");     // 전체 주소를 붙여넣은 경우
  p = p.replace(/^\/+/, "");                      // 맨 앞 슬래시
  const base = location.pathname.replace(/[^/]*$/, "").replace(/^\/+/, "");
  if (base && p.startsWith(base)) p = p.slice(base.length);  // 하위 경로 배포 대응
  return p;
}

/* 파일이 실제로 있는지, 용량이 얼마인지 확인한다.
 * HEAD 요청이 막히거나 서버가 크기를 알려주지 않을 수 있으므로, 실패해도 저장은 막지 않는다. */
async function probe(path) {
  try {
    const res = await fetch(path, { method: "HEAD" });
    if (!res.ok) return { ok: false, size: 0 };
    return { ok: true, size: Number(res.headers.get("content-length") || 0) };
  } catch {
    return { ok: null, size: 0 };   // 확인 불가
  }
}

async function save() {
  const title = $("dl-title").value.trim();
  const path = normalizePath($("dl-path").value);
  if (!title) return alert("제목을 입력하세요.");
  if (!path) return alert("파일 경로를 입력하세요. (예: files/안내문.pdf)");

  $("dl-msg").textContent = "파일 확인 중…";
  const found = await probe(path);
  if (found.ok === false
      && !confirm(`${path} 파일을 찾지 못했습니다.\n\n아직 GitHub에 올리지 않았거나 경로가 틀렸을 수 있습니다.\n이대로 등록하면 공개 페이지에서 다운로드가 실패합니다.\n\n그래도 등록할까요?`)) {
    $("dl-msg").textContent = "";
    return;
  }

  const d = {
    title,
    desc: $("dl-desc").value.trim(),
    path,
    category: $("dl-category").value.trim(),
    order: Number($("dl-order").value) || 0,
    published: $("dl-published").checked,
    size: found.size || 0,
    updatedAtMs: Date.now(),
  };
  try {
    if (editingId) await updateItem(COLL, editingId, d);
    else await addItem(COLL, d);
    $("dl-msg").textContent = found.ok === null
      ? "저장했습니다. (파일 존재 여부는 확인하지 못했습니다 — 공개 페이지에서 직접 눌러 확인하세요)"
      : "저장했습니다.";
    resetForm();
    load();
  } catch (e) { alert("저장 실패: " + e.message); }
}
