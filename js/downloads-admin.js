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
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { db, app } from "./firebase.js";
import { escapeHtml } from "./app.js";
import { orgQuery } from "./orgs.js";
import { addItem, updateItem, removeItem } from "./store.js";

const COLL = "downloads";
// 파일 조작은 저장소 쓰기 토큰이 필요해 함수를 거친다(토큰은 브라우저에 두지 않는다).
const callFn = (name) => httpsCallable(getFunctions(app, "asia-northeast3"), name);
const esc = escapeHtml;
const $ = (id) => document.getElementById(id);

let list = [];
let files = [];          // files/ 폴더의 실제 파일 목록(함수로 조회)
let editingId = null;

export function initDownloadsAdmin() {
  $("dl-save").addEventListener("click", save);
  $("dl-cancel").addEventListener("click", resetForm);
  $("dl-upload").addEventListener("click", upload);
  $("dl-files-refresh").addEventListener("click", () => loadFiles(true));
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
  loadFiles();
}

/* ── files/ 폴더의 실제 파일 ──
 * 저장소를 직접 보지 않아도 무엇이 올라가 있는지, 그중 무엇이 아직 목록에 등록되지
 * 않았는지 한눈에 보이게 한다. 경로를 손으로 적다 오타를 내는 일을 없애는 것이 목적. */
async function loadFiles(manual = false) {
  const box = $("dl-files");
  box.innerHTML = `<p class="empty">파일 목록을 불러오는 중…</p>`;
  try {
    files = (await callFn("publicFileList")())?.data?.files || [];
  } catch (e) {
    files = [];
    box.innerHTML = `<p class="empty">파일 목록을 불러오지 못했습니다. ${esc(e.message || "")}</p>`;
    if (manual) alert("파일 목록을 불러오지 못했습니다: " + (e.message || e));
    return;
  }
  paintFiles();
}

function paintFiles() {
  const box = $("dl-files");
  if (!files.length) {
    box.innerHTML = `<p class="empty">올라간 파일이 없습니다. 위에서 파일을 선택해 올리세요.</p>`;
    return;
  }
  const used = new Set(list.map((d) => d.path));
  box.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>파일</th><th>크기</th><th>목록 등록</th><th></th></tr></thead>
    <tbody>${files.map((f) => `<tr>
      <td><code>${esc(f.path)}</code></td>
      <td>${fmtSize(f.size)}</td>
      <td>${used.has(f.path)
        ? `<span class="chip chip-on">등록됨</span>`
        : `<span class="chip">미등록</span>`}</td>
      <td class="row-actions">
        ${used.has(f.path) ? "" : `<button type="button" data-use="${esc(f.name)}">목록에 추가</button>`}
        <button type="button" class="del" data-fdel="${esc(f.name)}">파일 삭제</button>
      </td>
    </tr>`).join("")}</tbody></table></div>`;
  box.querySelectorAll("[data-use]").forEach((b) => b.addEventListener("click", () => useFile(b.dataset.use)));
  box.querySelectorAll("[data-fdel]").forEach((b) => b.addEventListener("click", () => delFile(b.dataset.fdel)));
}

// 올라간 파일을 곧바로 '자료 추가' 폼에 채워 준다(제목은 파일명에서 뽑아 초안으로).
function useFile(name) {
  const f = files.find((x) => x.name === name);
  if (!f) return;
  resetForm();
  $("dl-path").value = f.path;
  if (!$("dl-title").value) $("dl-title").value = name.replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ");
  $("dl-msg").textContent = "제목을 확인하고 저장하세요.";
  $("dl-title").focus();
  $("dl-title").scrollIntoView({ behavior: "smooth", block: "center" });
}

async function delFile(name) {
  const path = `files/${name}`;
  const registered = list.filter((d) => d.path === path);
  if (!confirm(`${path} 파일을 저장소에서 지웁니다.\n\n`
    + (registered.length ? `⚠ 이 파일은 자료 목록 ${registered.length}건에 연결돼 있습니다. 지우면 그 자료의 다운로드가 실패합니다.\n\n` : "")
    + `지운 뒤에는 주소로도 받을 수 없습니다. 다만 git 이력에는 남습니다.\n\n계속할까요?`)) return;
  try {
    const res = await callFn("publicFileDelete")({ name });
    alert(res?.data?.deleted ? "파일을 지웠습니다. 반영까지 1~2분 걸립니다." : (res?.data?.reason || "이미 없는 파일입니다."));
    loadFiles();
  } catch (e) { alert("삭제 실패: " + (e.message || e)); }
}

async function upload() {
  const inp = $("dl-file");
  const f = inp.files[0];
  if (!f) return alert("올릴 파일을 선택하세요.");
  if (f.size > 8 * 1024 * 1024) {
    return alert("파일은 8MB 이하만 올릴 수 있습니다.\n더 큰 파일은 GitHub 저장소 files/ 폴더에서 직접 올리세요.");
  }
  const dataBase64 = await new Promise((resolve) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = () => resolve("");
    r.readAsDataURL(f);
  });
  if (!dataBase64) return alert("파일을 읽지 못했습니다.");

  const btn = $("dl-upload");
  btn.disabled = true;
  $("dl-upload-msg").textContent = "올리는 중…";
  try {
    const res = await callFn("publicFileUpload")({ name: f.name, dataBase64 });
    const d = res?.data || {};
    inp.value = "";
    // 배포가 끝나야 실제 주소에서 받을 수 있다 — 바로 확인하면 404가 뜬다.
    $("dl-upload-msg").textContent =
      `${d.path} ${d.replaced ? "교체" : "업로드"} 완료. 실제 주소에 반영되기까지 1~2분 걸립니다.`;
    await loadFiles();
    useFile(d.name);
  } catch (e) {
    $("dl-upload-msg").textContent = "";
    alert("업로드 실패: " + (e.message || e));
  }
  btn.disabled = false;
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
  if (!confirm(`"${d?.title || id}"를 목록에서 지울까요?\n\n파일 자체는 남습니다 — 파일까지 지우려면 아래 '올라간 파일'에서 '파일 삭제'를 누르세요.`)) return;
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
    await load();
    paintFiles();
  } catch (e) { alert("저장 실패: " + e.message); }
}
