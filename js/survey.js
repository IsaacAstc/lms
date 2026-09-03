// 공개 설문 응답 페이지 (로그인 없음, 완전 익명).
// 강의실 고유 URL: survey.html?room=<강의실ID>. KST 기준 노출 창일 때만 표시.
import {
  collection, query, where, getDocs, getDoc, doc, addDoc, Timestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { db, app } from "./firebase.js";
import { fmtKst, kstToday } from "./time.js";

// 5점 척도 설명(2·4점은 설명 없이 숫자만).
const SCALE_DESC = ["매우 불만족", "", "보통", "", "매우 만족"];
const root = document.getElementById("survey-root");

function esc(v) {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function msg(html) { root.innerHTML = html; }

async function main() {
  const params = new URLSearchParams(location.search);

  // 관리자 미리보기: ?preview=1&course=<id> — 노출 창 무시, 제출 비활성.
  if (params.get("preview") === "1" && params.get("course")) {
    try {
      const s = await getDoc(doc(db, "publicSurveys", params.get("course")));
      if (!s.exists()) return msg(`<p class="empty">설문 정의가 없습니다.</p>`);
      render(s.data(), true);
    } catch (e) {
      msg(`<p class="empty">미리보기를 불러오지 못했습니다.</p>`);
    }
    return;
  }

  const roomId = params.get("room");
  if (!roomId) return msg(`<p class="empty">잘못된 접근입니다. (강의실 정보 없음)</p>`);

  let survey = null;
  try {
    const snap = await getDocs(query(collection(db, "publicSurveys"), where("roomId", "==", roomId)));
    const now = Date.now();
    const active = snap.docs.map((d) => d.data()).filter((s) => s.openMs <= now && now <= s.closeMs);
    active.sort((a, b) => a.endMs - b.endMs);
    survey = active[0] || null;
  } catch (e) {
    return msg(`<p class="empty">설문을 불러오지 못했습니다. 잠시 후 다시 시도하세요.</p>`);
  }

  if (!survey) return msg(`<p class="empty">현재 진행 중인 설문이 없습니다.<br>교육 종료 2시간 전부터 응답하실 수 있습니다.</p>`);

  if (localStorage.getItem(`survey_done_${survey.courseId}`)) {
    return msg(`<p class="empty">이미 응답을 제출하셨습니다. 감사합니다.</p>`);
  }
  render(survey);
}

function ratingRow(name, label) {
  const opts = SCALE_DESC.map((desc, i) => {
    const txt = desc ? `${i + 1} ${desc}` : `${i + 1}`;
    return `<label class="scale"><input type="radio" name="${name}" value="${i + 1}" required><span>${esc(txt)}</span></label>`;
  }).join("");
  return `<div class="q-item"><div class="q-label">${esc(label)}</div><div class="scale-row">${opts}</div></div>`;
}

function render(survey, preview = false) {
  const edu = (survey.eduItems || []).map((t, i) => ratingRow(`edu_${i}`, `${i + 1}. ${t}`)).join("");
  const instBlocks = ((survey.instructorItems || []).length ? (survey.instructorTargets || []) : [])
    .map((t, ti) => {
      const rows = survey.instructorItems.map((it, i) => ratingRow(`inst_${ti}_${i}`, it)).join("");
      return `<fieldset class="inst-block"><legend>${esc(t.subject)} — ${esc(t.instructorName)}</legend>${rows}</fieldset>`;
    })
    .join("");

  // 문항 카테고리(섹션): 5점/O·X/주관식/선다형/복수 응답 혼합(설정 빌더에서 구성).
  const T = survey.titles || {};
  const sections = sectionsOfSurvey(survey);
  // 안내 문구(note)는 응답 입력이 없으므로 번호를 매기지 않고 건너뛴다.
  const secHtml = sections.map((sec, si) => {
    let no = 0;
    const body = sec.items.map((q, i) => {
      if (q.type === "note") return `<div class="survey-note">${esc(q.label)}</div>`;
      no++;
      return questionHtml(q, `sec_${si}_${i}`, no - 1);
    }).join("");
    return `<h2>${esc(sec.title)}</h2>${body}`;
  }).join("");

  root.innerHTML = `
    ${preview ? `<p class="preview-banner">미리보기 — 실제 제출되지 않습니다.</p>` : ""}
    <h1>${esc(survey.courseName)} 만족도 설문</h1>
    <p class="notice">개인을 식별할 수 있는 정보(성명, 소속, 연락처 등)는 기재하지 마십시오. 응답은 완전 익명으로 처리됩니다.</p>
    <form id="s-form">
      ${edu ? `<h2>${esc(T.edu || "교육 만족도")}</h2>${edu}` : ""}
      ${instBlocks ? `<h2>${esc(T.inst || "강사 만족도")}</h2>${instBlocks}` : ""}
      ${secHtml}
      <button type="submit" id="s-submit">제출</button>
      <p id="s-error" class="error"></p>
    </form>`;

  wireFollowUps(survey);
  wirePhotoPreview();

  if (preview) {
    const btn = document.getElementById("s-submit");
    btn.disabled = true;
    btn.textContent = "미리보기(제출 불가)";
  } else {
    document.getElementById("s-form").addEventListener("submit", (e) => submit(e, survey));
  }
}

// 설문 문서의 섹션 목록. 신형(sections) 우선, 구버전 문서(extraCats·oxItems·freeItems 등)는 변환.
/* ── 사진 첨부 ──
 * 브라우저에서 긴 변 1600px·JPEG로 축소해 전송 부담을 줄인다.
 * 이미지 데이터는 Cloud Function이 메일로 중계만 하고 어디에도 저장하지 않는다. */
const PHOTO_MAX_DIM = 1600;
function compressImage(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, PHOTO_MAX_DIM / Math.max(img.width, img.height));
        const cv = document.createElement("canvas");
        cv.width = Math.round(img.width * scale);
        cv.height = Math.round(img.height * scale);
        cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
        let out = cv.toDataURL("image/jpeg", 0.8);
        if (out.length > 3000000) out = cv.toDataURL("image/jpeg", 0.6);
        resolve(out);
      };
      img.onerror = () => reject(new Error("이미지를 읽지 못했습니다."));
      img.src = fr.result;
    };
    fr.onerror = () => reject(new Error("파일을 읽지 못했습니다."));
    fr.readAsDataURL(file);
  });
}
// 선택 즉시 미리보기(제출 전 확인용).
function wirePhotoPreview() {
  document.querySelectorAll('#s-form input[type="file"]').forEach((inp) => {
    inp.addEventListener("change", async () => {
      const box = document.getElementById(`pv-${inp.name}`);
      if (!box) return;
      box.innerHTML = "";
      const f = inp.files[0];
      if (!f) return;
      try {
        const data = await compressImage(f);
        box.innerHTML = `<img src="${data}" alt="첨부 미리보기">`;
      } catch { box.textContent = "미리보기를 표시할 수 없습니다."; }
    });
  });
}

// 제출코드: 사진(메일)과 시스템 응답 기록을 잇는 무작위 8자. 혼동 문자(0/O,1/I/L) 제외.
// 응답자 개인정보가 아니라 이 제출 건에만 붙는 임의 식별자다.
function newSubmitCode() {
  const chars = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
  const buf = new Uint8Array(8);
  crypto.getRandomValues(buf);
  return [...buf].map((b) => chars[b % chars.length]).join("");
}

const FREE_DEFAULTS = ["교육 불만족 의견", "교육 관련 제안·개선요구 의견"];
function sectionsOfSurvey(survey) {
  if (Array.isArray(survey.sections)) {
    // 조건부 후속(fu) 항목은 대상 문항 아래에 별도 렌더(wireFollowUps)되므로 섹션 흐름에서 제외.
    return survey.sections
      .map((s) => ({ title: s?.title || "", items: (Array.isArray(s?.items) ? s.items : []).filter((q) => q && q.label && q.type && q.type !== "fu") }))
      .filter((s) => s.title && s.items.length);
  }
  // ── 구버전 변환(기존 발행 설문 호환) ──
  const T = survey.titles || {};
  const out = [];
  for (const c of survey.extraCats || []) {
    if (c?.title && (c.items || []).length)
      out.push({ title: c.title, items: c.items.map((lb) => ({ type: "scale", label: lb, options: [], slot: null })) });
  }
  const ox = survey.oxItems || [];
  if (ox.length) out.push({ title: T.ox || "예/아니오", items: ox.map((lb) => ({ type: "ox", label: lb, options: [], slot: null })) });
  const free = [];
  const raw = survey.freeItems?.length === 2 ? survey.freeItems : FREE_DEFAULTS;
  raw.forEach((x, i) => {
    const slot = i === 0 ? "dis" : "sug";
    if (typeof x === "string") free.push({ type: "text", label: x, options: [], slot });
    else if (x && x.use !== false) free.push({ type: "text", label: x.label || FREE_DEFAULTS[i], options: [], slot });
  });
  for (const lb of survey.freeExtraItems || []) free.push({ type: "text", label: lb, options: [], slot: null });
  if (free.length) out.push({ title: T.free || "주관식", items: free });
  return out;
}

// 문항 유형별 입력 UI(필수 검증은 제출 시 일괄 처리).
function questionHtml(q, name, i) {
  const head = `<div class="q-label">${i + 1}. ${esc(q.label)}</div>`;
  if (q.type === "scale") return ratingRow(name, `${i + 1}. ${q.label}`);
  if (q.type === "ox") return `<div class="q-item">${head}
    <div class="scale-row">
      <label class="scale-opt"><input type="radio" name="${name}" value="1"><span>예</span></label>
      <label class="scale-opt"><input type="radio" name="${name}" value="0"><span>아니오</span></label>
    </div></div>`;
  if (q.type === "choice") return `<div class="q-item">${head}
    <div class="scale-row">${(q.options || []).map((o, oi) =>
      `<label class="scale-opt"><input type="radio" name="${name}" value="${oi}"><span>${esc(o)}</span></label>`).join("")}</div></div>`;
  if (q.type === "multi") return `<div class="q-item">${head}
    <div class="scale-row">${(q.options || []).map((o, oi) =>
      `<label class="scale-opt"><input type="checkbox" name="${name}" value="${oi}"><span>${esc(o)}</span></label>`).join("")}
    </div><small class="hint">해당하는 항목을 모두 선택</small></div>`;
  // 사진 첨부: 브라우저에서 축소 후 담당자 메일로만 전송되며 시스템에는 저장되지 않는다.
  if (q.type === "photo") return `<div class="q-item">${head}
    <input type="file" name="${name}" accept="image/*" capture="environment" />
    <div class="photo-preview" id="pv-${name}"></div>
    <small class="hint">${q.required ? "필수 · " : "선택 · "}사진은 담당자 이메일로만 전달되고 시스템에는 저장되지 않습니다. 타인의 얼굴·개인정보가 담기지 않게 촬영해 주세요.</small></div>`;
  return `<div class="q-item">${head}<textarea name="${name}" rows="3"></textarea></div>`; // text
}

/* ── 조건부 후속 문항(1단계 분기) ──
 * 대상 문항 라벨로 입력 name을 찾아, 답변이 조건(예/아니오 선택 또는 N점 이하)에
 * 맞을 때만 후속 문항을 노출한다. 숨겨지면 입력값을 비운다. */
function parentNameOf(survey, label) {
  const e = (survey.eduItems || []).indexOf(label);
  if (e >= 0) return { name: `edu_${e}`, scale: true };
  const sections = sectionsOfSurvey(survey);
  for (let si = 0; si < sections.length; si++) {
    for (let i = 0; i < sections[si].items.length; i++) {
      const q = sections[si].items[i];
      if (q.label !== label) continue;
      if (q.type === "scale") return { name: `sec_${si}_${i}`, scale: true };
      if (q.type === "ox") return { name: `sec_${si}_${i}`, scale: false };
    }
  }
  return null;
}
function wireFollowUps(survey) {
  const form = document.getElementById("s-form");
  (survey.followUps || []).forEach((f, fi) => {
    const p = parentNameOf(survey, f.q);
    if (!p) return; // 대상 문항이 이 설문에 없음(세트 변경 등) — 무시.
    const inputs = form.querySelectorAll(`input[name="${p.name}"]`);
    if (!inputs.length) return;
    const div = document.createElement("div");
    div.className = "q-item fu-item";
    div.id = `fu-${fi}`;
    div.hidden = true;
    div.innerHTML = f.type === "ox"
      ? `<div class="q-label">↳ ${esc(f.label)}</div>
         <div class="scale-row">
           <label class="scale-opt"><input type="radio" name="fu_${fi}" value="1"><span>예</span></label>
           <label class="scale-opt"><input type="radio" name="fu_${fi}" value="0"><span>아니오</span></label>
         </div>`
      : f.type === "photo"
        ? `<div class="q-label">↳ ${esc(f.label)}</div>
           <input type="file" name="fu_${fi}" accept="image/*" capture="environment" />
           <div class="photo-preview" id="pv-fu_${fi}"></div>
           <small class="hint">선택 · 사진은 담당자 이메일로만 전달되고 시스템에는 저장되지 않습니다.</small>`
        : `<div class="q-label">↳ ${esc(f.label)}</div><textarea name="fu_${fi}" rows="2"></textarea>`;
    // 대상 문항 바로 아래에 삽입.
    inputs[0].closest(".q-item").after(div);
    const update = () => {
      const v = form[p.name]?.value;
      const show = v !== "" && v != null && (p.scale
        ? Number(v) <= (f.maxScore || 2) && f.cond === "score"
        : (f.cond === "yes" ? v === "1" : v === "0"));
      div.hidden = !show;
      if (!show) { // 조건이 풀리면 입력값을 비워 잘못 제출되지 않게 한다.
        if (f.type === "ox") div.querySelectorAll("input").forEach((r) => { r.checked = false; });
        else if (f.type === "photo") {
          const fi2 = div.querySelector('input[type="file"]');
          if (fi2) fi2.value = "";
          const pv = div.querySelector(".photo-preview");
          if (pv) pv.innerHTML = "";
        } else div.querySelector("textarea").value = "";
      }
    };
    inputs.forEach((r) => r.addEventListener("change", update));
  });
}

async function submit(e, survey) {
  e.preventDefault();
  const form = e.target;
  const err = document.getElementById("s-error");
  err.textContent = "";

  const edu = {};
  for (let i = 0; i < survey.eduItems.length; i++) {
    const v = form[`edu_${i}`]?.value;
    if (!v) { err.textContent = "모든 교육 만족도 문항에 응답해 주세요."; return; }
    edu[`q${i}`] = Number(v);
  }
  const instructors = [];
  (survey.instructorTargets || []).forEach((t, ti) => {
    const rec = { instructorId: t.instructorId, subject: t.subject, instructorName: t.instructorName };
    for (let i = 0; i < survey.instructorItems.length; i++) {
      const v = form[`inst_${ti}_${i}`]?.value;
      if (v) rec[`q${i}`] = Number(v);
    }
    instructors.push(rec);
  });

  // 문항 카테고리(섹션) 응답 수집.
  // 객관식(5점·O/X·선다형·복수)은 필수, 주관식은 선택 입력.
  const sections = sectionsOfSurvey(survey);
  const extraAnswers = [];   // 5점: {cat, label, v}
  const oxAnswers = [];      // 예/아니오: {label, yes}
  const choiceAnswers = [];  // 선다형·복수: {cat, label, options:[보기 문구], multi}
  const freeExtra = [];      // 자유 주관식: {label, text}
  const photoFiles = [];     // 사진 첨부: {label, file} — 메일 전송용(응답 문서에는 미저장)
  let freeDis = "", freeSug = "";
  for (let si = 0; si < sections.length; si++) {
    const sec = sections[si];
    for (let i = 0; i < sec.items.length; i++) {
      const q = sec.items[i];
      const name = `sec_${si}_${i}`;
      if (q.type === "note") continue; // 안내 문구 — 수집할 응답 없음
      if (q.type === "scale") {
        const v = form[name]?.value;
        if (!v) { err.textContent = `'${sec.title}' 문항에 모두 응답해 주세요.`; return; }
        extraAnswers.push({ cat: sec.title, label: q.label, v: Number(v) });
      } else if (q.type === "ox") {
        const v = form[name]?.value;
        if (v !== "0" && v !== "1") { err.textContent = `'${sec.title}'의 예/아니오 문항에 응답해 주세요.`; return; }
        oxAnswers.push({ label: q.label, yes: v === "1" });
      } else if (q.type === "choice") {
        const v = form[name]?.value;
        if (v === "" || v == null) { err.textContent = `'${sec.title}'의 선택 문항에 응답해 주세요.`; return; }
        choiceAnswers.push({ cat: sec.title, label: q.label, options: [q.options[Number(v)]].filter(Boolean), multi: false });
      } else if (q.type === "multi") {
        const sel = [...document.querySelectorAll(`input[name="${name}"]:checked`)].map((el) => q.options[Number(el.value)]).filter(Boolean);
        if (!sel.length) { err.textContent = `'${sec.title}'의 복수 응답 문항에서 하나 이상 선택해 주세요.`; return; }
        choiceAnswers.push({ cat: sec.title, label: q.label, options: sel, multi: true });
      } else if (q.type === "photo") {
        const f = form[name]?.files?.[0];
        if (!f) {
          if (q.required) { err.textContent = `'${q.label}' 사진을 첨부해 주세요.`; return; }
        } else if (!/^image\//.test(f.type)) {
          err.textContent = "이미지 파일만 첨부할 수 있습니다."; return;
        } else {
          photoFiles.push({ label: q.label, file: f });
        }
      } else { // text — 기본 2종(slot)은 기존 필드로, 나머지는 자유 주관식으로.
        const t = (form[name]?.value || "").trim();
        if (q.slot === "dis") freeDis = t;
        else if (q.slot === "sug") freeSug = t;
        else if (t) freeExtra.push({ label: q.label, text: t });
      }
    }
  }

  // 조건부 후속 문항: 노출된 것만 수집. O/X 후속은 필수, 주관식 후속은 선택.
  const fuTexts = [];
  for (let fi = 0; fi < (survey.followUps || []).length; fi++) {
    const f = survey.followUps[fi];
    const div = document.getElementById(`fu-${fi}`);
    if (!div || div.hidden) continue;
    if (f.type === "ox") {
      const v = form[`fu_${fi}`]?.value;
      if (v !== "0" && v !== "1") { err.textContent = `'${f.label}' 문항에 응답해 주세요.`; return; }
      oxAnswers.push({ label: f.label, yes: v === "1" });
    } else if (f.type === "photo") { // 조건부 사진(선택) — 첨부한 경우에만 메일로 전달.
      const file = form[`fu_${fi}`]?.files?.[0];
      if (file) {
        if (!/^image\//.test(file.type)) { err.textContent = "이미지 파일만 첨부할 수 있습니다."; return; }
        photoFiles.push({ label: f.label, file });
      }
    } else {
      const t = (form[`fu_${fi}`]?.value || "").trim();
      if (t) fuTexts.push({ q: f.q, label: f.label, text: t });
    }
  }

  const payload = {
    courseId: survey.courseId,
    courseType: survey.courseType || "",
    roomId: survey.roomId,
    collectedDate: kstToday(),       // 일 단위(기간 조회·파기용)
    collectedAt: fmtKst(Date.now()), // 수집 일시(표시용, KST 'YYYY-MM-DD HH:MM')
    edu,
    instructors,
    // 응답 시점의 문항 스냅샷. 이후 문항이 개정돼도 과거 집계·보고서가 그대로 유지된다.
    eduItems: survey.eduItems || [],
    instructorItems: survey.instructorItems || [],
    scale: survey.scale || 5,
    freeDissatisfied: freeDis,
    freeSuggestion: freeSug,
  };
  // 라벨 스냅샷 포함 저장 — 원문 파기 후에도 라벨 기준 집계 가능.
  if (freeExtra.length) payload.freeExtra = freeExtra;
  if (oxAnswers.length) payload.oxAnswers = oxAnswers;
  if (extraAnswers.length) payload.extraAnswers = extraAnswers;
  if (choiceAnswers.length) payload.choiceAnswers = choiceAnswers;
  if (fuTexts.length) payload.fuTexts = fuTexts; // 조건부 주관식 원문(180일 파기 대상 동일)
  // 사진은 저장하지 않고 제출 기록만 남긴다(문항 라벨·첨부 여부).
  // 사진이 있으면 제출코드를 발급해 메일과 응답 기록 양쪽에 남긴다(관리자 매칭용).
  if (photoFiles.length) {
    payload.photoNotes = photoFiles.map((p) => ({ label: p.label, attached: true }));
    payload.submitCode = newSubmitCode();
  }
  // 제출 전 한 번 더 확인.
  confirmSubmit(() => doSubmit(payload, survey, photoFiles));
}

// 확인 오버레이: 뒤로(수정) / 확인(제출).
function confirmSubmit(onConfirm) {
  const ov = document.createElement("div");
  ov.className = "confirm-overlay";
  ov.innerHTML = `
    <div class="confirm-box">
      <p>응답을 제출하시겠습니까?<br>제출 후에는 수정할 수 없습니다.</p>
      <div class="confirm-actions">
        <button type="button" class="c-back">뒤로(수정)</button>
        <button type="button" class="c-ok">확인(제출)</button>
      </div>
    </div>`;
  ov.querySelector(".c-back").addEventListener("click", () => ov.remove());
  ov.querySelector(".c-ok").addEventListener("click", () => { ov.remove(); onConfirm(); });
  document.body.appendChild(ov);
}

async function doSubmit(payload, survey, photoFiles = []) {
  const err = document.getElementById("s-error");
  const submitBtn = document.getElementById("s-submit");
  submitBtn.disabled = true;
  try {
    // 1) 사진이 있으면 먼저 메일로 전송(저장 없이 중계). 실패 시 제출을 중단해
    //    "사진은 안 갔는데 응답만 기록"되는 상태를 만들지 않는다.
    if (photoFiles.length) {
      err.textContent = "사진 전송 중… (잠시 기다려 주세요)";
      const photos = [];
      for (const p of photoFiles) {
        const dataUrl = await compressImage(p.file);
        photos.push({ label: p.label, dataBase64: dataUrl.split(",")[1] || "" });
      }
      const fns = getFunctions(app, "asia-northeast3");
      await httpsCallable(fns, "submitSurveyPhotos")({
        courseId: survey.courseId,
        roomId: survey.roomId || "",
        submitCode: payload.submitCode || "", // 시스템 응답 기록과 매칭하는 제출코드
        photos,
        answers: summarizeAnswers(payload, survey), // 메일 본문용 응답 요약(개인정보 없음)
      });
    }
    // 2) 사진을 제외한 응답을 익명으로 기록.
    err.textContent = "";
    const expireAt = Timestamp.fromDate(new Date(Date.now() + 180 * 24 * 3600 * 1000));
    await addDoc(collection(db, "surveyResponses"), { ...payload, expireAt });
    localStorage.setItem(`survey_done_${survey.courseId}`, "1");
    msg(`<p class="empty">응답이 제출되었습니다. 참여해 주셔서 감사합니다.</p>`);
  } catch (e2) {
    err.textContent = (e2 && e2.message) ? `제출에 실패했습니다: ${e2.message}` : "제출에 실패했습니다. 다시 시도해 주세요.";
    submitBtn.disabled = false;
  }
}

// 메일 본문에 넣을 응답 요약(문항 라벨 + 값). 개인 식별정보는 애초에 수집하지 않는다.
function summarizeAnswers(payload, survey) {
  const lines = [];
  (survey.eduItems || []).forEach((t, i) => {
    const v = payload.edu?.[`q${i}`];
    if (v != null) lines.push(`[교육] ${t}: ${v}점`);
  });
  for (const it of payload.instructors || []) {
    const vals = (survey.instructorItems || []).map((t, i) => it[`q${i}`] != null ? `${t} ${it[`q${i}`]}점` : null).filter(Boolean);
    if (vals.length) lines.push(`[강사] ${it.instructorName || ""}(${it.subject || ""}): ${vals.join(", ")}`);
  }
  for (const x of payload.extraAnswers || []) lines.push(`[${x.cat}] ${x.label}: ${x.v}점`);
  for (const o of payload.oxAnswers || []) lines.push(`[예/아니오] ${o.label}: ${o.yes ? "예" : "아니오"}`);
  for (const c of payload.choiceAnswers || []) lines.push(`[${c.cat}] ${c.label}: ${(c.options || []).join(", ")}`);
  if (payload.freeDissatisfied) lines.push(`[주관식-불만족] ${payload.freeDissatisfied}`);
  if (payload.freeSuggestion) lines.push(`[주관식-제안개선] ${payload.freeSuggestion}`);
  for (const t of payload.freeExtra || []) lines.push(`[주관식] ${t.label}: ${t.text}`);
  for (const t of payload.fuTexts || []) lines.push(`[조건부] ${t.label}: ${t.text}`);
  return lines.join("\n").slice(0, 4000);
}

main();
