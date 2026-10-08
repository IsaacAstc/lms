// 현장 안내: 대관 행사 관리 + DID(현장 안내 화면) 설정.
// rentals/{id}: { name, startDate, endDate, startTime, endTime, venue, note, hidden, updatedAtMs }
//   — 공개 표시용 정보만(행사명·장소·시간). 개인정보(담당자·연락처 등)는 저장하지 않는다.
// DID 설정은 publicBoard/__did 문서(제목·안내문구·로고·배경) — 공개 읽기/관리자 쓰기 규칙 재사용.
import {
  collection, addDoc, doc, updateDoc, deleteDoc, onSnapshot, getDoc, setDoc, query, orderBy,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db, app } from "./firebase.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
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

// ── 로고·배경 이미지 업로드 (저장소 media/ — 서버 함수 경유, 브라우저 토큰 없음) ──
// 이미지 압축: 로고는 투명 보존(PNG, 최대 1200px — 대기 화면 대형 표시 대응), 배경은 JPEG(최대 3840px).
function compressImage(file, { maxDim, keepAlpha, upscale }) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = (upscale ? (x) => x : (x) => Math.min(1, x))(maxDim / Math.max(img.width || maxDim, img.height || maxDim));
      const cv = document.createElement("canvas");
      cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
      const ctx = cv.getContext("2d");
      ctx.drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(img.src);
      // PNG·WebP여도 실제로 투명한 픽셀이 없으면(배너·포스터 등) JPEG로 저장한다 — PNG는 몇 배 커서 상한에 걸린다.
      let alpha = !!keepAlpha;
      if (alpha) {
        const d = ctx.getImageData(0, 0, cv.width, cv.height).data;
        alpha = false;
        for (let i = 3; i < d.length; i += 4) if (d[i] < 250) { alpha = true; break; }
      }
      if (alpha) {
        const png = cv.toDataURL("image/png");
        // 투명 PNG가 상한을 넘으면 흰 바탕에 합쳐 JPEG로 낮춘다(투명 대신 흰색).
        if (png.length <= 2.6 * 1024 * 1024) return resolve({ dataUrl: png, alpha: true });
        const bg = document.createElement("canvas");
        bg.width = cv.width; bg.height = cv.height;
        const b = bg.getContext("2d");
        b.fillStyle = "#fff"; b.fillRect(0, 0, bg.width, bg.height); b.drawImage(cv, 0, 0);
        return resolve({ dataUrl: bg.toDataURL("image/jpeg", 0.9), alpha: false, flattened: true });
      }
      resolve({ dataUrl: cv.toDataURL("image/jpeg", keepAlpha ? 0.92 : 0.82), alpha: false });
    };
    img.onerror = () => { URL.revokeObjectURL(img.src); reject(new Error("이미지 파일을 읽을 수 없습니다.")); };
    img.src = URL.createObjectURL(file);
  });
}

// 업로드는 서버 함수(publicFileUpload)가 대신 커밋한다 — GitHub 토큰은 서버 비밀값에만 있어
// 기기마다 토큰을 발급·입력할 필요가 없다(퀴즈 미디어 업로드와 같은 경로).
const callFn = (name) => httpsCallable(getFunctions(app, "asia-northeast3"), name, { timeout: 130000 });

async function uploadDidImage(file, { maxDim, keepAlpha, prefix }) {
  if (!confirm(`'${file.name}'을 공개 저장소 media/ 폴더에 업로드할까요?\n공개 가능한 이미지인지 확인하세요.`)) return null;
  // SVG는 서버가 받지 않으므로(같은 도메인 스크립트 실행 방지) 고해상도 PNG로 변환해 올린다.
  const isSvg = file.type === "image/svg+xml" || /\.svg$/i.test(file.name);
  const alpha = isSvg ? true : keepAlpha === "auto"
    ? /^image\/(png|webp|gif)$/.test(file.type) || /\.(png|webp|gif)$/i.test(file.name)
    : keepAlpha;
  // PNG는 압축이 없어 같은 해상도에서도 훨씬 크다. TV가 1080p이므로 1920px면 충분하다.
  const dim = isSvg ? 2400 : alpha && keepAlpha === "auto" ? Math.min(maxDim, 1920) : maxDim;
  const out = await compressImage(file, { maxDim: dim, keepAlpha: alpha, upscale: isSvg });
  const b64 = out.dataUrl.split(",")[1];
  if (b64.length > 4 * 1024 * 1024) throw new Error("이미지가 너무 큽니다. 더 작은 이미지를 사용하세요.");
  if (out.flattened) alert("투명 PNG 용량이 커서 투명한 부분을 흰색으로 채워 JPG로 저장합니다.");
  const name = `${prefix}-${Date.now().toString(36)}.${out.alpha ? "png" : "jpg"}`;
  await callFn("publicFileUpload")({ dir: "media", name, dataBase64: b64 });
  // 절대 URL로 저장하면 업로드한 도메인(github.io 등)이 박혀, 그 도메인이 막힌 망의
  // DID에서는 이미지가 안 뜬다. 상대 경로로 저장해 표출 화면과 같은 도메인에서 받게 한다.
  return `media/${name}`;
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
  tbody.innerHTML = `<tr><td colspan="6" class="empty">불러오는 중…</td></tr>`;
  note.textContent = "";
  try {
    const files = ((await callFn("publicFileList")({ dir: "media" })).data?.files) || [];
    if (!files.length) { tbody.innerHTML = `<tr><td colspan="6" class="empty">업로드된 미디어가 없습니다.</td></tr>`; return; }
    note.textContent = `${files.length}개 · 합계 ${fmtSize(files.reduce((s, f) => s + (f.size || 0), 0))}`;
    tbody.innerHTML = "";
    for (const f of files) {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${escapeHtml(f.name)}</td>
        <td>${MEDIA_KIND(f.name)}</td>
        <td>${fmtSize(f.size || 0)}</td>
        <td>${MEDIA_SOURCE(f.name)}</td>
        <td><a href="${escapeHtml(f.path)}" target="_blank" rel="noopener" class="btn-link">열기</a></td>
        <td class="actions"><button type="button" class="del m-del">삭제</button></td>`;
      tr.querySelector(".m-del").addEventListener("click", async (e) => {
        if (!confirm(`'${f.name}' 파일을 저장소에서 삭제할까요?\n퀴즈·DID에서 참조 중이면 해당 화면에 더 이상 표시되지 않습니다.`)) return;
        const btn = e.target;
        btn.disabled = true; btn.textContent = "삭제 중…";
        try {
          await callFn("publicFileDelete")({ dir: "media", name: f.name });
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
  // 특별일정은 글자가 든 배너·공지가 올라오므로 PNG로 올린 파일은 PNG로 저장한다.
  // JPEG 재압축을 거치지 않아 글자 가장자리가 뭉개지지 않는다.
  wireDidUpload("did-special-upload", "did-special-file", "did-special", { maxDim: 3840, keepAlpha: "auto", prefix: "special" });
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
        // 이미지 비율이 화면과 다를 때 남는 여백의 색(기본 검정).
        specialBg: document.getElementById("did-special-bg").value || "#000000",
        specialStart: document.getElementById("did-special-start").value,
        specialEnd: document.getElementById("did-special-end").value,
        updatedAtMs: Date.now(),
      }, { merge: true });
      alert("DID 설정을 저장했습니다. 표출 화면에 즉시 반영됩니다.");
    } catch (e) { alert("저장 실패: " + e.message); }
  });
  // 강제 새로고침: reloadAt만 바꿔 두면 열려 있는 DID 화면이 스냅샷을 받고 스스로 재로드한다.
  document.getElementById("did-reload").addEventListener("click", async () => {
    if (!confirm("열려 있는 모든 DID 표출 화면을 새로고침합니다. 진행할까요?")) return;
    const btn = document.getElementById("did-reload");
    btn.disabled = true;
    try {
      await setDoc(doc(db, "publicBoard", "__did"), { reloadAt: Date.now() }, { merge: true });
      btn.textContent = "요청됨";
      setTimeout(() => { btn.textContent = "표출 화면 새로고침"; btn.disabled = false; }, 5000);
    } catch (e) {
      alert("요청 실패: " + e.message);
      btn.disabled = false;
    }
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
    document.getElementById("did-special-bg").value = c.specialBg || "#000000";
    // 과거(날짜만) 저장값 호환: datetime-local에 넣을 수 있게 시각 보정.
    const dt = (v, t) => (v && !v.includes("T") ? `${v}T${t}` : (v || ""));
    document.getElementById("did-special-start").value = dt(c.specialStart, "00:00");
    document.getElementById("did-special-end").value = dt(c.specialEnd, "23:59");
  } catch { /* */ }
}
