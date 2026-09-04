// 기명 조사 응답 페이지 (named.html?s=<조사ID>)
//
// 익명 설문(survey.js)과 분리된 별도 페이지다. 이 페이지는 개인정보를 수집하므로
// 문항을 열기 전에 목적별 동의를 먼저 받는다.
//  · 필수 목적 동의 없이는 진행 불가, 선택 목적은 동의하지 않아도 응답 가능(법 제16조 제3항).
//  · 응답은 클라이언트가 직접 저장하지 않고 submitNamedSurvey 함수로만 접수된다
//    (동의 확인·식별자 해시·중복 판정을 서버에서 수행하기 위함).
//  · 선택 목적 항목(사진·연락처)은 어디에도 저장되지 않고 담당자 메일로만 전달된다.
import { getDoc, doc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { db, app } from "./firebase.js";

const root = document.getElementById("named-root");
const PHOTO_MAX_DIM = 1600;

function esc(v) {
  return String(v ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
const msg = (html) => { root.innerHTML = html; };
const nl2br = (v) => esc(v).replace(/\n/g, "<br>");

let survey = null;
let surveyId = "";

async function main() {
  surveyId = new URLSearchParams(location.search).get("s") || "";
  if (!surveyId) return msg(`<p class="empty">잘못된 접근입니다. (조사 정보 없음)</p>`);
  try {
    const snap = await getDoc(doc(db, "namedSurveys", surveyId));
    if (!snap.exists()) return msg(`<p class="empty">조사를 찾을 수 없습니다.</p>`);
    survey = snap.data();
  } catch {
    return msg(`<p class="empty">조사를 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.</p>`);
  }

  const now = Date.now();
  if (survey.status !== "open") return msg(`<p class="empty">현재 응답을 받지 않는 조사입니다.</p>`);
  if (survey.openMs && now < survey.openMs) return msg(`<p class="empty">아직 시작되지 않은 조사입니다.</p>`);
  if (survey.closeMs && now > survey.closeMs) return msg(`<p class="empty">응답 기간이 종료되었습니다.</p>`);

  renderConsent();
}

/* ── 1단계: 목적별 동의 ── */
function renderConsent() {
  const m = survey.purposeMain || {};
  const o = survey.purposeOpt || {};
  const days = (n) => `${n || "-"}일`;
  root.innerHTML = `
    <h1>${esc(survey.title || "조사 참여")}</h1>
    ${survey.intro ? `<p class="survey-note">${nl2br(survey.intro)}</p>` : ""}
    <h2>개인정보 수집·이용 동의</h2>
    <p class="notice">아래 내용을 확인하신 뒤 동의 여부를 선택해 주세요. 동의하지 않으실 권리가 있습니다.</p>

    <div class="consent-block">
      <h3>[필수] ${esc(m.label || "조사 목적")}</h3>
      <dl class="consent-dl">
        <div><dt>수집·이용 목적</dt><dd>${esc(m.label || "")}</dd></div>
        <div><dt>수집 항목</dt><dd>${esc(m.items || "")}</dd></div>
        <div><dt>보유·이용 기간</dt><dd>수집일부터 ${days(m.retainDays)} (기간 경과 시 지체 없이 파기)</dd></div>
        <div><dt>동의 거부권</dt><dd>동의를 거부하실 수 있으나, 거부하시면 이 조사에 참여하실 수 없습니다.</dd></div>
      </dl>
      ${m.notice ? `<p class="hint">${nl2br(m.notice)}</p>` : ""}
      <label class="chk consent-chk"><input type="checkbox" id="c-main"> 위 내용에 동의합니다. <b>(필수)</b></label>
    </div>

    ${o.enabled ? `<div class="consent-block">
      <h3>[선택] ${esc(o.label || "선택 목적")}</h3>
      <dl class="consent-dl">
        <div><dt>수집·이용 목적</dt><dd>${esc(o.label || "")}</dd></div>
        <div><dt>수집 항목</dt><dd>${esc(o.items || "")}</dd></div>
        <div><dt>보유·이용 기간</dt><dd>목적 달성 즉시 파기(최대 ${days(o.retainDays)})</dd></div>
        <div><dt>동의 거부권</dt><dd>${esc(o.declineNote || "동의하지 않으셔도 조사에는 참여하실 수 있습니다.")}</dd></div>
      </dl>
      ${o.notice ? `<p class="hint">${nl2br(o.notice)}</p>` : ""}
      <label class="chk consent-chk"><input type="checkbox" id="c-opt"> 위 내용에 동의합니다. <b>(선택)</b></label>
    </div>` : ""}

    <button type="button" id="c-next">동의하고 시작하기</button>
    <p id="c-error" class="error"></p>`;

  document.getElementById("c-next").addEventListener("click", () => {
    const err = document.getElementById("c-error");
    if (!document.getElementById("c-main").checked) {
      err.textContent = "필수 항목에 동의하셔야 조사에 참여할 수 있습니다.";
      return;
    }
    renderForm(!!document.getElementById("c-opt")?.checked);
  });
}

/* ── 2단계: 문항 ── */
function questionHtml(q, name, no) {
  if (q.type === "note") return `<div class="survey-note">${nl2br(q.label)}</div>`;
  const head = `<div class="q-label">${no}. ${esc(q.label)}${q.required ? "" : ` <span class="q-opt">(선택)</span>`}</div>`;
  if (q.type === "ox") return `<div class="q-item">${head}
    <div class="scale-row">
      <label class="scale-opt"><input type="radio" name="${name}" value="예"><span>예</span></label>
      <label class="scale-opt"><input type="radio" name="${name}" value="아니오"><span>아니오</span></label>
    </div></div>`;
  if (q.type === "choice") return `<div class="q-item">${head}
    <div class="scale-row">${(q.options || []).map((op) =>
      `<label class="scale-opt"><input type="radio" name="${name}" value="${esc(op)}"><span>${esc(op)}</span></label>`).join("")}</div></div>`;
  if (q.type === "multi") return `<div class="q-item">${head}
    <div class="scale-row">${(q.options || []).map((op) =>
      `<label class="scale-opt"><input type="checkbox" name="${name}" value="${esc(op)}"><span>${esc(op)}</span></label>`).join("")}
    </div><small class="hint">해당하는 항목을 모두 선택</small></div>`;
  return `<div class="q-item">${head}<textarea name="${name}" rows="3"></textarea></div>`;
}

function renderForm(consentOpt) {
  const qs = Array.isArray(survey.questions) ? survey.questions : [];
  let no = 0;
  const body = qs.map((q, i) => {
    if (q.type !== "note") no++;
    return questionHtml(q, `q_${i}`, no);
  }).join("");

  const optItems = consentOpt && survey.purposeOpt?.enabled ? (survey.optItems || []) : [];
  const optHtml = optItems.length ? `
    <h2>${esc(survey.purposeOpt.label || "선택 항목")}</h2>
    <p class="hint">아래 항목은 <b>시스템에 저장되지 않고</b> 담당자 이메일로만 전달됩니다. 모두 채우셔야 접수됩니다.</p>
    ${optItems.map((q, i) => q.type === "photo"
      ? `<div class="q-item"><div class="q-label">${esc(q.label)}</div>
           <input type="file" name="o_${i}" accept="image/*" capture="environment" />
           <div class="photo-preview" id="pv-o_${i}"></div>
           <small class="hint">타인의 얼굴·개인정보가 담기지 않게 촬영해 주세요.</small></div>`
      : `<div class="q-item"><div class="q-label">${esc(q.label)}</div>
           <input type="text" name="o_${i}" maxlength="100" autocomplete="off" /></div>`).join("")}` : "";

  root.innerHTML = `
    <h1>${esc(survey.title || "조사 참여")}</h1>
    <form id="n-form">
      <div class="q-item">
        <div class="q-label">${esc(survey.idLabel || "식별자")}</div>
        <input type="text" name="rid" maxlength="100" autocomplete="off" required />
        ${survey.idHint ? `<small class="hint">${nl2br(survey.idHint)}</small>` : ""}
      </div>
      ${body}
      ${optHtml}
      <button type="submit" id="n-submit">제출</button>
      <p id="n-error" class="error"></p>
    </form>`;

  wirePhotoPreview();
  document.getElementById("n-form").addEventListener("submit", (e) => {
    e.preventDefault();
    submit(consentOpt, optItems);
  });
}

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
function wirePhotoPreview() {
  document.querySelectorAll('#n-form input[type="file"]').forEach((inp) => {
    inp.addEventListener("change", async () => {
      const box = document.getElementById(`pv-${inp.name}`);
      if (!box) return;
      const f = inp.files?.[0];
      if (!f) { box.innerHTML = ""; return; }
      try { box.innerHTML = `<img src="${await compressImage(f)}" alt="첨부 미리보기">`; }
      catch { box.textContent = "미리보기를 표시할 수 없습니다."; }
    });
  });
}

async function submit(consentOpt, optItems) {
  const form = document.getElementById("n-form");
  const err = document.getElementById("n-error");
  const btn = document.getElementById("n-submit");
  err.textContent = "";

  const rid = (form.rid.value || "").trim();
  if (!rid) { err.textContent = `${survey.idLabel || "식별자"}을(를) 입력해 주세요.`; return; }

  // 문항 응답 수집(검증은 서버에서도 다시 수행한다).
  const qs = Array.isArray(survey.questions) ? survey.questions : [];
  const answers = [];
  for (let i = 0; i < qs.length; i++) {
    const q = qs[i];
    if (q.type === "note") { answers.push(""); continue; }
    let v;
    if (q.type === "multi") v = [...form.querySelectorAll(`input[name="q_${i}"]:checked`)].map((el) => el.value);
    else v = (form[`q_${i}`]?.value || "").trim();
    const empty = Array.isArray(v) ? !v.length : !v;
    if (empty && q.required) { err.textContent = `'${q.label}' 항목에 응답해 주세요.`; return; }
    answers.push(v);
  }

  // 선택 목적 항목 — 모두 채운 경우에만 전송(부분 제출로 개인정보가 남는 것을 막는다).
  const photos = [];
  const mailTexts = [];
  let missing = 0;
  for (let i = 0; i < optItems.length; i++) {
    const it = optItems[i];
    if (it.type === "photo") {
      const f = form[`o_${i}`]?.files?.[0];
      if (!f) { missing++; continue; }
      if (!/^image\//.test(f.type)) { err.textContent = "이미지 파일만 첨부할 수 있습니다."; return; }
      photos.push({ label: it.label, file: f });
    } else {
      const t = (form[`o_${i}`]?.value || "").trim();
      if (!t) { missing++; continue; }
      mailTexts.push({ label: it.label, text: t.slice(0, 100) });
    }
  }
  if (optItems.length && missing) {
    const ok = confirm(`${survey.purposeOpt?.label || "선택 항목"}의 항목 ${missing}개가 비어 있습니다.\n이대로 제출하면 조사 응답만 접수되고 선택 항목은 접수되지 않습니다.\n계속하시겠습니까?`);
    if (!ok) return;
    photos.length = 0;
    mailTexts.length = 0;
  }

  btn.disabled = true;
  btn.textContent = "제출 중…";
  try {
    const payloadPhotos = [];
    for (const p of photos) {
      const dataUrl = await compressImage(p.file);
      payloadPhotos.push({ label: p.label, dataBase64: dataUrl.split(",")[1] });
    }
    const fn = httpsCallable(getFunctions(app, "asia-northeast3"), "submitNamedSurvey");
    const res = await fn({
      surveyId,
      respondentId: rid,
      consentMain: true,
      consentOpt: !!consentOpt,
      answers,
      photos: payloadPhotos,
      mailTexts,
    });
    const code = res?.data?.submitCode || "";
    msg(`<p class="empty">응답이 접수되었습니다. 감사합니다.
      ${code ? `<br><br>선택 항목 제출코드: <b>${esc(code)}</b><br><small>문의 시 이 코드를 알려주시면 확인이 빠릅니다.</small>` : ""}</p>`);
  } catch (e) {
    btn.disabled = false;
    btn.textContent = "제출";
    err.textContent = e?.message || "제출에 실패했습니다. 잠시 후 다시 시도해 주세요.";
  }
}

main();
