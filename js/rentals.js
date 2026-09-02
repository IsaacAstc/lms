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
  document.getElementById("media-refresh").addEventListener("click", loadMediaList);
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

// ── 로고·배경 이미지 업로드 (저장소 media/ — 퀴즈 편집기와 동일 방식·토큰 공유) ──
const GH_REPO = "IsaacAstc/lms";
const GH_TOKEN_KEY = "qbGhToken"; // 퀴즈 편집기와 같은 키(토큰 1회 등록으로 양쪽 사용)
function ghToken() {
  let t = localStorage.getItem(GH_TOKEN_KEY);
  if (!t) {
    t = prompt(
      "이미지 업로드에는 GitHub 토큰이 필요합니다(이 브라우저에만 저장).\n\n"
      + "발급: github.com → Settings → Developer settings → Fine-grained tokens →\n"
      + `대상 저장소 ${GH_REPO}, 권한은 Contents: Read and write만 → 생성된 토큰 붙여넣기`);
    if (!t) return null;
    localStorage.setItem(GH_TOKEN_KEY, t.trim());
    t = t.trim();
  }
  return t;
}

// 이미지 압축: 로고는 투명 보존(PNG, 최대 1200px — 대기 화면 대형 표시 대응), 배경은 JPEG(최대 3840px).
function compressImage(file, { maxDim, keepAlpha }) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const cv = document.createElement("canvas");
      cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
      cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(img.src);
      resolve(keepAlpha ? cv.toDataURL("image/png") : cv.toDataURL("image/jpeg", 0.82));
    };
    img.onerror = () => { URL.revokeObjectURL(img.src); reject(new Error("이미지 파일을 읽을 수 없습니다.")); };
    img.src = URL.createObjectURL(file);
  });
}

async function uploadDidImage(file, { maxDim, keepAlpha, prefix }) {
  const token = ghToken();
  if (!token) return null;
  if (!confirm(`'${file.name}'을 공개 저장소 media/ 폴더에 업로드할까요?\n공개 가능한 이미지인지 확인하세요.`)) return null;
  // SVG는 벡터 그대로 업로드(래스터 변환 없음 — 로고 선명도 유지). 그 외는 캔버스 압축.
  const isSvg = file.type === "image/svg+xml" || /\.svg$/i.test(file.name);
  let b64, ext;
  if (isSvg) {
    if (file.size > 1024 * 1024) throw new Error("SVG는 1MB 이하만 업로드할 수 있습니다.");
    // 큰 파일에서 String.fromCharCode(...bytes) 전개는 스택 초과 — 청크 단위로 변환.
    const bytes = new Uint8Array(await file.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 8192) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
    }
    b64 = btoa(bin);
    ext = "svg";
  } else {
    const dataUrl = await compressImage(file, { maxDim, keepAlpha });
    b64 = dataUrl.split(",")[1];
    if (b64.length > 2 * 1024 * 1024) throw new Error("이미지가 너무 큽니다. 더 작은 이미지를 사용하세요.");
    ext = keepAlpha ? "png" : "jpg";
  }
  const path = `media/${prefix}-${Date.now().toString(36)}.${ext}`;
  const resp = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${path}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    body: JSON.stringify({ message: `media: DID ${prefix} 이미지 업로드`, content: b64 }),
  });
  if (resp.status === 401 || resp.status === 403) {
    localStorage.removeItem(GH_TOKEN_KEY);
    throw new Error("토큰이 유효하지 않거나 권한이 없습니다. 다시 시도해 토큰을 재등록하세요.");
  }
  if (!resp.ok) throw new Error(`업로드 실패 (HTTP ${resp.status})`);
  return `${location.origin}${location.pathname.replace(/[^/]*$/, "")}${path}`;
}

function wireDidUpload(btnId, fileId, inputId, opts) {
  document.getElementById(btnId).addEventListener("click", () => document.getElementById(fileId).click());
  document.getElementById(fileId).addEventListener("change", async (e) => {
    const file = e.target.files[0]; e.target.value = "";
    if (!file) return;
    const btn = document.getElementById(btnId);
    const origLabel = btn.textContent;
    btn.disabled = true; btn.textContent = "업로드 중…";
    try {
      const url = await uploadDidImage(file, opts);
      if (url) {
        document.getElementById(inputId).value = url;
        alert("업로드 완료. 'DID 설정 저장'을 눌러 반영하세요. (배포 1~2분 후 표시됩니다)");
      }
    } catch (err) { alert(err.message || "업로드에 실패했습니다."); }
    finally { btn.disabled = false; btn.textContent = origLabel; }
  });
}

// ── 업로드 미디어 관리 (media/ 폴더 — 퀴즈·DID 업로드분 조회·삭제) ──
const MEDIA_KIND = (name) => {
  if (/\.(mp4|webm|ogg)$/i.test(name)) return "동영상";
  if (/\.svg$/i.test(name)) return "SVG";
  if (/\.(png|jpe?g|gif|webp)$/i.test(name)) return "이미지";
  return "기타";
};
// 파일명 접두어로 업로드 출처 표시(logo-/bg-/special- = DID, video- 등 = 퀴즈).
const MEDIA_SOURCE = (name) =>
  /^logo-/.test(name) ? "DID 로고" : /^bg-/.test(name) ? "DID 배경"
    : /^special-/.test(name) ? "DID 특별일정" : "퀴즈";
const fmtSize = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + " MB" : Math.max(1, Math.round(n / 1024)) + " KB";

async function loadMediaList() {
  const tbody = document.getElementById("media-tbody");
  const note = document.getElementById("media-note");
  const token = ghToken();
  if (!token) return;
  tbody.innerHTML = `<tr><td colspan="6" class="empty">불러오는 중…</td></tr>`;
  note.textContent = "";
  try {
    const resp = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/media`, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
    });
    if (resp.status === 401 || resp.status === 403) {
      localStorage.removeItem(GH_TOKEN_KEY);
      throw new Error("토큰이 유효하지 않습니다. 다시 조회해 토큰을 재등록하세요.");
    }
    if (resp.status === 404) { tbody.innerHTML = `<tr><td colspan="6" class="empty">media/ 폴더에 파일이 없습니다.</td></tr>`; return; }
    if (!resp.ok) throw new Error(`조회 실패 (HTTP ${resp.status})`);
    const files = (await resp.json()).filter((f) => f.type === "file" && f.name !== "README.md");
    if (!files.length) { tbody.innerHTML = `<tr><td colspan="6" class="empty">업로드된 미디어가 없습니다.</td></tr>`; return; }
    files.sort((a, b) => a.name.localeCompare(b.name));
    note.textContent = `${files.length}개 · 합계 ${fmtSize(files.reduce((s, f) => s + (f.size || 0), 0))}`;
    tbody.innerHTML = "";
    for (const f of files) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(f.name)}</td>
        <td>${MEDIA_KIND(f.name)}</td>
        <td>${fmtSize(f.size || 0)}</td>
        <td>${MEDIA_SOURCE(f.name)}</td>
        <td><a href="${escapeHtml(f.download_url)}" target="_blank" rel="noopener" class="btn-link">열기</a></td>
        <td class="actions"><button type="button" class="del m-del">삭제</button></td>`;
      tr.querySelector(".m-del").addEventListener("click", async (e) => {
        if (!confirm(`'${f.name}' 파일을 저장소에서 삭제할까요?\n퀴즈·DID에서 참조 중이면 해당 화면에 더 이상 표시되지 않습니다.`)) return;
        const btn = e.target;
        btn.disabled = true; btn.textContent = "삭제 중…";
        try {
          const del = await fetch(`https://api.github.com/repos/${GH_REPO}/contents/${f.path}`, {
            method: "DELETE",
            headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
            body: JSON.stringify({ message: `media: ${f.name} 삭제 (관리자 화면)`, sha: f.sha }),
          });
          if (!del.ok) throw new Error(`삭제 실패 (HTTP ${del.status})`);
          loadMediaList();
        } catch (err) {
          alert(err.message || "삭제에 실패했습니다.");
          btn.disabled = false; btn.textContent = "삭제";
        }
      });
      tbody.appendChild(tr);
    }
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty">${escapeHtml(e.message || "목록을 불러오지 못했습니다.")}</td></tr>`;
  }
}

// ── DID 설정 ──
function initDidConfig() {
  wireDidUpload("did-logo-upload", "did-logo-file", "did-logo", { maxDim: 1200, keepAlpha: true, prefix: "logo" });
  wireDidUpload("did-logo2-upload", "did-logo2-file", "did-logo2", { maxDim: 1200, keepAlpha: true, prefix: "logo" });
  wireDidUpload("did-bg-upload", "did-bg-file", "did-bg", { maxDim: 3840, keepAlpha: false, prefix: "bg" });
  wireDidUpload("did-special-upload", "did-special-file", "did-special", { maxDim: 3840, keepAlpha: false, prefix: "special" });
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
        // 섹션 제목(비우면 DID에서 기본 문구 사용).
        eduTitle: document.getElementById("did-edu-title").value.trim(),
        rentTitle: document.getElementById("did-rent-title").value.trim(),
        logoUrl: document.getElementById("did-logo").value.trim(),
        logoUrl2: document.getElementById("did-logo2").value.trim(),
        bgUrl: document.getElementById("did-bg").value.trim(),
        specialOn: document.getElementById("did-special-on").checked,
        specialUrl: document.getElementById("did-special").value.trim(),
        specialStart: document.getElementById("did-special-start").value,
        specialEnd: document.getElementById("did-special-end").value,
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
    document.getElementById("did-edu-title").value = c.eduTitle || "";
    document.getElementById("did-rent-title").value = c.rentTitle || "";
    document.getElementById("did-logo").value = c.logoUrl || "";
    document.getElementById("did-logo2").value = c.logoUrl2 || "";
    document.getElementById("did-bg").value = c.bgUrl || "";
    document.getElementById("did-special-on").checked = !!c.specialOn;
    document.getElementById("did-special").value = c.specialUrl || "";
    // 과거(날짜만) 저장값 호환: datetime-local에 넣을 수 있게 시각 보정.
    const dt = (v, t) => (v && !v.includes("T") ? `${v}T${t}` : (v || ""));
    document.getElementById("did-special-start").value = dt(c.specialStart, "00:00");
    document.getElementById("did-special-end").value = dt(c.specialEnd, "23:59");
  } catch { /* */ }
}
