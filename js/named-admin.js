// 기명 조사 관리 (개인정보 처리 경로 — 익명 설문 모듈과 완전히 분리)
//
// 익명 설문(surveys.js)과 코드·데이터·화면 어디에서도 섞이지 않는다.
//  · 조사 정의: namedSurveys — 문항·동의 문안·목적별 보유기간을 관리자가 직접 편집한다.
//    (동의 문안과 보유기간을 코드에 박아두지 않는 이유: 개인정보 보호 담당부서 검토 결과가
//     바뀌어도 화면에서 고치면 되도록 하기 위함)
//  · 응답: namedResponses — 브라우저에서 직접 읽지 못한다. 조회·내보내기·파기를 모두
//    서버 함수로만 수행하고, 그 호출이 취급자 접속기록(accessLogs)으로 남는다.
//  · 응답자 식별자는 서버에서 해시로 변환돼 저장되므로 이 화면에서도 원문은 볼 수 없다.
import { escapeHtml } from "./app.js";
import { orgQuery } from "./orgs.js";
import { watchCollection, onCollection, addItem, updateItem, removeItem, setDocById, getDocById } from "./store.js";
import {
  collection, query, orderBy, limit as qLimit, getDocs,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getFunctions, httpsCallable } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-functions.js";
import { db, app } from "./firebase.js";

// 응답(namedResponses)은 보안규칙에서 클라이언트 접근을 전면 차단했다.
// 조회·내보내기·파기는 모두 함수를 거치며, 그 호출이 곧 접속기록으로 남는다.
const callFn = (name) => httpsCallable(getFunctions(app, "asia-northeast3"), name);

const COLL = "namedSurveys";

// 문항 유형 — 익명 설문과 달리 5점 척도·집계 기능은 두지 않는다(통계 목적 조사가 아님).
const Q_TYPES = [
  ["ox", "예/아니오"], ["choice", "선다형(택1)"], ["multi", "복수 응답"],
  ["text", "주관식"], ["note", "안내 문구"],
];
// 선택 목적(이벤트 등) 항목 — 값이 저장되지 않고 담당자 메일로만 전달된다.
const OPT_TYPES = [["photo", "사진 첨부"], ["mailtext", "입력(연락처 등)"]];

let list = [];
let editingId = null;   // 편집 중인 조사 ID(null = 새 조사)
let draft = null;       // 편집 중인 정의

const $ = (id) => document.getElementById(id);
const esc = escapeHtml;

// 기본 정의 — 실제 문안은 개인정보 보호 담당부서 검토 후 화면에서 확정한다.
function blankSurvey() {
  return {
    title: "",
    intro: "",
    idLabel: "훈련 시스템 아이디",
    idHint: "본인 확인용이 아니라 중복 응답을 막기 위한 항목입니다. 입력값은 되돌릴 수 없는 형태로 변환되어 저장됩니다.",
    status: "draft",
    openMs: 0,
    closeMs: 0,
    purposeMain: {
      label: "수료생 취업 실태 통계",
      items: "아이디(변환 저장), 취업 여부, 회사 구분",
      retainDays: 365,
      notice: "",
    },
    purposeOpt: {
      enabled: false,
      label: "경품 증정 이벤트 운영",
      items: "인증 사진, 연락처",
      retainDays: 90,
      notice: "",
      declineNote: "동의하지 않으셔도 설문에 응답하실 수 있으며, 경품 이벤트 응모만 제외됩니다.",
    },
    questions: [],
    optItems: [],
  };
}

/* ── 목록 ── */
function paintList() {
  const box = $("named-list");
  if (!box) return;
  if (!list.length) {
    box.innerHTML = `<p class="empty">등록된 조사가 없습니다. '새 조사'로 시작하세요.</p>`;
    return;
  }
  const now = Date.now();
  box.innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>조사명</th><th>상태</th><th>응답 기간</th><th>선택 목적</th><th>보유기간</th><th></th></tr></thead>
    <tbody>${list.map((s) => {
      const open = s.status === "open" && (!s.openMs || s.openMs <= now) && (!s.closeMs || now <= s.closeMs);
      const state = s.status === "draft" ? `<span class="chip">작성 중</span>`
        : s.status === "closed" ? `<span class="chip">종료</span>`
        : open ? `<span class="chip chip-on">응답 접수 중</span>` : `<span class="chip">기간 밖</span>`;
      return `<tr>
        <td><b>${esc(s.title || "(제목 없음)")}</b></td>
        <td>${state}</td>
        <td>${fmtRange(s.openMs, s.closeMs)}</td>
        <td>${s.purposeOpt?.enabled ? esc(s.purposeOpt.label || "사용") : "<span class='muted'>미사용</span>"}</td>
        <td>필수 ${s.purposeMain?.retainDays || "-"}일${s.purposeOpt?.enabled ? ` · 선택 ${s.purposeOpt.retainDays || "-"}일` : ""}</td>
        <td class="row-actions">
          <button type="button" data-edit="${s.id}">편집</button>
          <button type="button" data-resp="${s.id}">응답</button>
          <button type="button" data-link="${s.id}">주소</button>
          <button type="button" class="del" data-del="${s.id}">삭제</button>
        </td>
      </tr>`;
    }).join("")}</tbody></table></div>`;

  box.querySelectorAll("[data-edit]").forEach((b) => b.addEventListener("click", () => openEditor(b.dataset.edit)));
  box.querySelectorAll("[data-resp]").forEach((b) => b.addEventListener("click", () => showResponses(b.dataset.resp)));
  box.querySelectorAll("[data-link]").forEach((b) => b.addEventListener("click", () => showLink(b.dataset.link)));
  box.querySelectorAll("[data-del]").forEach((b) => b.addEventListener("click", () => delSurvey(b.dataset.del)));
}

function fmtRange(a, b) {
  const f = (ms) => (ms ? new Date(ms).toLocaleString("ko-KR", { timeZone: "Asia/Seoul", dateStyle: "short", timeStyle: "short" }) : "제한 없음");
  return `${f(a)} ~ ${f(b)}`;
}
// datetime-local 값 ↔ epoch(ms). 브라우저 로컬 시각 기준.
const msToLocal = (ms) => {
  if (!ms) return "";
  const d = new Date(ms - new Date().getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
};
const localToMs = (v) => (v ? new Date(v).getTime() : 0);

/* ── 편집기 ── */
function openEditor(id) {
  editingId = id || null;
  const src = id ? list.find((s) => s.id === id) : null;
  draft = src ? JSON.parse(JSON.stringify({ ...blankSurvey(), ...src })) : blankSurvey();
  delete draft.id;
  draft.questions = Array.isArray(draft.questions) ? draft.questions : [];
  draft.optItems = Array.isArray(draft.optItems) ? draft.optItems : [];
  $("named-editor").hidden = false;
  $("named-editor-title").textContent = id ? "조사 편집" : "새 조사";
  paintEditor();
  $("named-editor").scrollIntoView({ behavior: "smooth", block: "start" });
}

function paintEditor() {
  if (!draft) return;
  const d = draft;
  $("nm-title").value = d.title || "";
  $("nm-intro").value = d.intro || "";
  $("nm-idlabel").value = d.idLabel || "";
  $("nm-idhint").value = d.idHint || "";
  $("nm-status").value = d.status || "draft";
  $("nm-open").value = msToLocal(d.openMs);
  $("nm-close").value = msToLocal(d.closeMs);

  $("nm-main-label").value = d.purposeMain.label || "";
  $("nm-main-items").value = d.purposeMain.items || "";
  $("nm-main-days").value = d.purposeMain.retainDays || 365;
  $("nm-main-notice").value = d.purposeMain.notice || "";

  $("nm-opt-on").checked = !!d.purposeOpt.enabled;
  $("nm-opt-label").value = d.purposeOpt.label || "";
  $("nm-opt-items").value = d.purposeOpt.items || "";
  $("nm-opt-days").value = d.purposeOpt.retainDays || 90;
  $("nm-opt-notice").value = d.purposeOpt.notice || "";
  $("nm-opt-decline").value = d.purposeOpt.declineNote || "";
  $("nm-opt-fields").hidden = !d.purposeOpt.enabled;

  paintQuestions();
}

function paintQuestions() {
  const box = $("nm-questions");
  box.innerHTML = draft.questions.map((q, i) => `<div class="load-row">
      <span>${i + 1}.</span>
      <select class="nq-type" data-i="${i}">${Q_TYPES.map(([t, lb]) => `<option value="${t}"${q.type === t ? " selected" : ""}>${lb}</option>`).join("")}</select>
      ${q.type === "note"
        ? `<textarea class="nq-label" data-i="${i}" rows="2" placeholder="안내 문구" style="min-width:320px">${esc(q.label || "")}</textarea>`
        : `<input class="nq-label" data-i="${i}" value="${esc(q.label || "")}" placeholder="문항 문구" style="min-width:240px">`}
      ${(q.type === "choice" || q.type === "multi")
        ? `<input class="nq-opts" data-i="${i}" value="${esc((q.options || []).join(" / "))}" placeholder="보기 — ' / '로 구분" style="min-width:220px">`
        : ""}
      ${q.type === "note" ? "" : `<label class="chk"><input type="checkbox" class="nq-req" data-i="${i}"${q.required ? " checked" : ""}> 필수</label>`}
      <button type="button" class="chip-move nq-move" data-i="${i}" data-d="-1" title="위로">◀</button>
      <button type="button" class="chip-move nq-move" data-i="${i}" data-d="1" title="아래로">▶</button>
      <button type="button" class="chip-del nq-del" data-i="${i}">×</button>
    </div>`).join("") || `<p class="empty">문항이 없습니다.</p>`;

  const optBox = $("nm-optitems");
  optBox.innerHTML = draft.optItems.map((q, i) => `<div class="load-row">
      <span>${i + 1}.</span>
      <select class="no-type" data-i="${i}">${OPT_TYPES.map(([t, lb]) => `<option value="${t}"${q.type === t ? " selected" : ""}>${lb}</option>`).join("")}</select>
      <input class="no-label" data-i="${i}" value="${esc(q.label || "")}" placeholder="항목 문구" style="min-width:240px">
      <button type="button" class="chip-del no-del" data-i="${i}">×</button>
    </div>`).join("") || `<p class="empty">선택 목적 항목이 없습니다.</p>`;

  box.querySelectorAll(".nq-type").forEach((el) => el.addEventListener("change", (e) => {
    draft.questions[+e.target.dataset.i].type = e.target.value; paintQuestions();
  }));
  box.querySelectorAll(".nq-label").forEach((el) => el.addEventListener("input", (e) => {
    draft.questions[+e.target.dataset.i].label = e.target.value;
  }));
  box.querySelectorAll(".nq-opts").forEach((el) => el.addEventListener("input", (e) => {
    draft.questions[+e.target.dataset.i].options = e.target.value.split("/").map((t) => t.trim()).filter(Boolean);
  }));
  box.querySelectorAll(".nq-req").forEach((el) => el.addEventListener("change", (e) => {
    draft.questions[+e.target.dataset.i].required = e.target.checked;
  }));
  box.querySelectorAll(".nq-move").forEach((b) => b.addEventListener("click", () => {
    const i = +b.dataset.i; const j = i + Number(b.dataset.d);
    if (j < 0 || j >= draft.questions.length) return;
    const a = draft.questions;
    [a[i], a[j]] = [a[j], a[i]];
    paintQuestions();
  }));
  box.querySelectorAll(".nq-del").forEach((b) => b.addEventListener("click", () => {
    draft.questions.splice(+b.dataset.i, 1); paintQuestions();
  }));

  optBox.querySelectorAll(".no-type").forEach((el) => el.addEventListener("change", (e) => {
    draft.optItems[+e.target.dataset.i].type = e.target.value;
  }));
  optBox.querySelectorAll(".no-label").forEach((el) => el.addEventListener("input", (e) => {
    draft.optItems[+e.target.dataset.i].label = e.target.value;
  }));
  optBox.querySelectorAll(".no-del").forEach((b) => b.addEventListener("click", () => {
    draft.optItems.splice(+b.dataset.i, 1); paintQuestions();
  }));
}

// 화면 값을 읽어 저장용 정의를 만든다.
// draft를 직접 고치지 않는다 — 검증에 걸려 저장이 중단되면 화면과 draft가 어긋나
// 문항 편집이 엉뚱한 행에 적용되기 때문이다(빈 라벨 문항이 조용히 사라지는 문제 포함).
function readEditor() {
  const d = draft;
  return {
    title: $("nm-title").value.trim(),
    intro: $("nm-intro").value.trim(),
    idLabel: $("nm-idlabel").value.trim() || "식별자",
    idHint: $("nm-idhint").value.trim(),
    status: $("nm-status").value,
    openMs: localToMs($("nm-open").value),
    closeMs: localToMs($("nm-close").value),
    purposeMain: {
      label: $("nm-main-label").value.trim(),
      items: $("nm-main-items").value.trim(),
      retainDays: Math.max(1, Number($("nm-main-days").value) || 365),
      notice: $("nm-main-notice").value.trim(),
    },
    purposeOpt: {
      enabled: $("nm-opt-on").checked,
      label: $("nm-opt-label").value.trim(),
      items: $("nm-opt-items").value.trim(),
      retainDays: Math.max(1, Number($("nm-opt-days").value) || 90),
      notice: $("nm-opt-notice").value.trim(),
      declineNote: $("nm-opt-decline").value.trim(),
    },
    questions: d.questions.map((q) => ({
      type: q.type,
      label: (q.label || "").trim(),
      options: Array.isArray(q.options) ? q.options : [],
      required: q.type === "note" ? false : !!q.required,
    })),
    optItems: d.optItems.map((q) => ({ type: q.type, label: (q.label || "").trim() })),
  };
}

async function saveSurvey() {
  const d = readEditor();
  if (!d.title) return alert("조사명을 입력하세요.");
  if (!d.purposeMain.label || !d.purposeMain.items) return alert("필수 목적의 목적과 수집 항목을 입력하세요. 동의 고지에 반드시 들어가야 하는 내용입니다.");
  if (d.purposeOpt.enabled && (!d.purposeOpt.label || !d.purposeOpt.items)) {
    return alert("선택 목적을 사용하려면 목적과 수집 항목을 입력하세요.");
  }
  const blank = d.questions.findIndex((q) => !q.label);
  if (blank >= 0) return alert(`${blank + 1}번 문항의 문구가 비어 있습니다. 입력하거나 삭제하세요.`);
  const blankOpt = d.optItems.findIndex((q) => !q.label);
  if (blankOpt >= 0) return alert(`선택 목적 항목 ${blankOpt + 1}번의 문구가 비어 있습니다.`);
  if (d.status === "open" && !d.questions.length) return alert("문항이 없는 조사는 접수를 시작할 수 없습니다.");
  if (d.purposeOpt.enabled && !d.optItems.length) {
    return alert("선택 목적을 사용하려면 선택 목적 항목(사진·입력)을 1개 이상 등록하세요.");
  }
  // 접수 중인 조사의 문항을 바꾸면, 그 사이 페이지를 열어 둔 응답자의 제출이
  // 서버에서 거부된다(엉뚱한 문항에 답이 붙는 것을 막기 위한 동작).
  const src = editingId ? list.find((x) => x.id === editingId) : null;
  const changed = src && JSON.stringify(src.questions || []) !== JSON.stringify(d.questions);
  if (changed && (src.status === "open" || d.status === "open")) {
    if (!confirm("접수 중인 조사의 문항을 변경합니다.\n지금 응답 화면을 열어 둔 사람은 새로고침 후 다시 제출해야 합니다.\n계속할까요?")) return;
  }
  d.updatedAtMs = Date.now();
  try {
    if (editingId) await updateItem(COLL, editingId, d);
    else { d.createdAtMs = Date.now(); await addItem(COLL, d); }
    $("named-editor").hidden = true;
    draft = null; editingId = null;
  } catch (e) { alert("저장 실패: " + e.message); }
}

async function delSurvey(id) {
  const s = list.find((x) => x.id === id);
  let cnt = 0;
  try { cnt = await countResponses(id); }
  catch (e) { return alert("응답 건수를 확인하지 못해 삭제를 중단합니다: " + (e.message || e)); }
  if (cnt > 0) return alert(`응답 ${cnt}건이 남아 있어 삭제할 수 없습니다. 응답 화면에서 먼저 파기하세요.`);
  if (!confirm(`'${s?.title || id}' 조사를 삭제할까요?`)) return;
  try { await removeItem(COLL, id); } catch (e) { alert("삭제 실패: " + e.message); }
}

// 건수만 확인하는 전용 함수를 쓴다. 목록 조회 함수를 부르면
// 열람하지 않았는데도 접속기록에 '조회'가 남아 기록이 사실과 달라진다.
async function countResponses(surveyId) {
  const res = await callFn("namedResponsesCount")({ surveyId });
  return res?.data?.count ?? 0;
}

function showLink(id) {
  // 기관 파라미터(orgQuery)를 붙여야 추가 기관에서도 해당 기관 백엔드로 연결된다.
  const org = orgQuery(false);
  const url = `${location.origin}${location.pathname.replace(/index\.html$/, "")}named.html?s=${id}${org}`;
  const box = $("named-link-box");
  box.hidden = false;
  box.innerHTML = `<label>응답 페이지 주소 <input id="nm-url" readonly value="${esc(url)}" style="min-width:340px"></label>
    <button type="button" id="nm-copy">복사</button>
    <p class="hint">이 주소는 대상자에게만 안내하세요. 익명 설문과 달리 개인정보를 수집하는 페이지입니다.</p>`;
  $("nm-url").select?.();
  $("nm-copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(url); $("nm-copy").textContent = "복사됨"; } catch { alert("복사에 실패했습니다. 주소를 직접 선택해 복사하세요."); }
  });
}

/* ── 응답 조회·내보내기·파기 (모두 함수 경유 — 호출이 접속기록으로 남는다) ── */
let respCache = { surveyId: "", rows: [], labels: [] };

async function showResponses(surveyId) {
  const s = list.find((x) => x.id === surveyId);
  const box = $("named-resp");
  box.hidden = false;
  box.innerHTML = `<p class="empty">불러오는 중…</p>`;
  let rows = [];
  try {
    const res = await callFn("namedResponsesList")({ surveyId });
    rows = res?.data?.rows || [];
  } catch (e) {
    box.innerHTML = `<p class="empty">응답을 불러오지 못했습니다: ${esc(e.message || e)}</p>`;
    return;
  }
  rows.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
  const labels = [...new Set(rows.flatMap((r) => (r.answers || []).map((a) => a.label)))];
  respCache = { surveyId, rows, labels };

  box.innerHTML = `
    <h3>${esc(s?.title || surveyId)} — 응답 ${rows.length}건</h3>
    <p class="hint">응답에는 <b>응답자 식별자가 붙어 있지 않습니다.</b> 중복 응답 표시만 별도로 보관하며 응답 내용과 연결되지 않으므로, 어떤 응답이 누구의 것인지는 시스템에서도 알 수 없습니다. 사진·연락처 등 선택 목적 항목은 저장되지 않으며 제출코드로 담당자 메일과 대조합니다.</p>
    <p class="hint">이 화면의 <b>조회·내보내기·파기는 모두 접속기록으로 남습니다</b>(계정·일시·접속지·건수). 내보내기는 사유 입력이 필요합니다.</p>
    <div class="form-actions">
      <button type="button" id="nm-resp-csv">CSV 내보내기</button>
      <button type="button" class="del" id="nm-resp-purge">기간 지정 파기</button>
      <button type="button" id="nm-resp-close">닫기</button>
    </div>
    ${rows.length ? `<div class="table-wrap"><table>
      <thead><tr><th>수집 일시</th><th>선택 동의</th><th>제출코드</th>${labels.map((l) => `<th>${esc(l)}</th>`).join("")}<th>파기 예정</th><th></th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td>${esc(r.collectedAt || r.collectedDate || "")}</td>
        <td>${r.consentOpt ? "동의" : "<span class='muted'>미동의</span>"}</td>
        <td><code>${esc(r.submitCode || "")}</code></td>
        ${labels.map((l) => {
          const a = (r.answers || []).find((x) => x.label === l);
          const v = a ? (Array.isArray(a.value) ? a.value.join(", ") : a.value) : "";
          return `<td>${esc(v)}</td>`;
        }).join("")}
        <td>${esc(fmtMs(r.purgeAtMs))}</td>
        <td><button type="button" class="chip-del" data-rdel="${esc(r.id)}" title="이 응답 파기">×</button></td>
      </tr>`).join("")}</tbody></table></div>` : `<p class="empty">아직 응답이 없습니다.</p>`}`;

  box.querySelectorAll("[data-rdel]").forEach((b) => b.addEventListener("click", () => purgeIds(surveyId, [b.dataset.rdel], "건별 파기")));
  $("nm-resp-csv").addEventListener("click", exportCsv);
  $("nm-resp-purge").addEventListener("click", () => purgeRange(surveyId));
  $("nm-resp-close").addEventListener("click", () => {
    box.hidden = true;
    respCache = { surveyId: "", rows: [], labels: [] }; // 화면을 닫으면 개인정보를 메모리에 남기지 않는다
  });
}

const fmtMs = (ms) => (ms ? new Date(ms).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul" }) : "");

// 내보내기: 사유를 받아 함수로 다시 조회한다(내려받은 내용과 기록이 일치하도록).
async function exportCsv() {
  const { surveyId } = respCache;
  if (!surveyId) return;
  const reason = prompt("내보내기 사유를 입력하세요. 접속기록에 함께 남습니다.\n(예: 2026년 취업 실태 통계 작성)");
  if (reason == null) return;
  if (reason.trim().length < 5) return alert("사유를 5자 이상 입력하세요.");
  let rows = [];
  try {
    const res = await callFn("namedResponsesExport")({ surveyId, reason: reason.trim() });
    rows = res?.data?.rows || [];
  } catch (e) { return alert("내보내기 실패: " + (e.message || e)); }

  const labels = [...new Set(rows.flatMap((r) => (r.answers || []).map((a) => a.label)))];
  const title = list.find((x) => x.id === surveyId)?.title || surveyId;
  const head = ["수집일시", "선택동의", "제출코드", ...labels];
  const body = rows.map((r) => [
    r.collectedAt || r.collectedDate || "",
    r.consentOpt ? "동의" : "미동의",
    r.submitCode || "",
    ...labels.map((l) => {
      const a = (r.answers || []).find((x) => x.label === l);
      return a ? (Array.isArray(a.value) ? a.value.join(" / ") : a.value) : "";
    }),
  ]);
  const csv = [head, ...body].map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(",")).join("\r\n");
  const blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${title}_응답.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

async function purgeIds(surveyId, ids, reason, range) {
  const warn = range
    ? `응답 ${ids.length}건과 해당 기간의 중복 방지 표시를 함께 파기합니다.`
    : `응답 ${ids.length}건을 파기합니다.\n중복 방지 표시는 응답과 연결되어 있지 않아 남으며, 해당 응답자는 보유기간이 끝날 때까지 재응답할 수 없습니다.`;
  if (!confirm(`${warn}\n되돌릴 수 없습니다. 계속할까요?`)) return;
  const why = prompt("파기 사유를 입력하세요. 접속기록에 함께 남습니다.", reason || "");
  if (why == null) return;
  if (!why.trim()) return alert("파기 사유를 입력하세요.");
  try {
    const res = await callFn("namedResponsesDelete")({ surveyId, ids, reason: why.trim(), ...(range || {}) });
    const m = res?.data?.marks;
    alert(`${res?.data?.deleted ?? 0}건을 파기했습니다.${m ? ` (중복 방지 표시 ${m}건 포함)` : ""}`);
    showResponses(surveyId);
  } catch (e) { alert("파기 실패: " + (e.message || e)); }
}

async function purgeRange(surveyId) {
  const from = prompt("파기 시작일(YYYY-MM-DD)");
  if (!from) return;
  const to = prompt("파기 종료일(YYYY-MM-DD)", from);
  if (!to) return;
  const targets = respCache.rows.filter((r) => (r.collectedDate || "") >= from && (r.collectedDate || "") <= to);
  if (!targets.length) return alert("해당 기간의 응답이 없습니다.");
  await purgeIds(surveyId, targets.map((r) => r.id), `${from} ~ ${to} 수집분 보유기간 경과 파기`, { from, to });
}

/* ── 취급자 접속기록(법 제29조) ── */
async function showAccessLog() {
  const box = $("named-log");
  box.hidden = false;
  box.innerHTML = `<p class="empty">불러오는 중…</p>`;
  let rows = [];
  try {
    const snap = await getDocs(query(collection(db, "accessLogs"), orderBy("atMs", "desc"), qLimit(300)));
    rows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } catch (e) {
    box.innerHTML = `<p class="empty">접속기록을 불러오지 못했습니다: ${esc(e.message || e)}</p>`;
    return;
  }
  const titleOf = (id) => list.find((x) => x.id === id)?.title || id || "";
  box.innerHTML = `
    <h3>취급자 접속기록 <span class="hint" style="font-weight:400">최근 300건 · 1년 보관 · 기록은 수정·삭제 불가</span></h3>
    <div class="form-actions">
      <button type="button" id="nm-log-review">이번 달 점검 완료 기록</button>
      <button type="button" id="nm-log-close">닫기</button>
    </div>
    ${rows.length ? `<div class="table-wrap"><table>
      <thead><tr><th>일시(KST)</th><th>계정</th><th>접속지</th><th>수행업무</th><th>대상 조사</th><th>건수</th><th>사유</th></tr></thead>
      <tbody>${rows.map((r) => `<tr>
        <td>${esc(r.atKst || "")}</td>
        <td>${esc(r.account || "")}</td>
        <td>${esc(r.ip || "")}</td>
        <td>${esc(r.op || "")}</td>
        <td>${esc(titleOf(r.surveyId))}</td>
        <td>${r.count ?? ""}</td>
        <td>${esc(r.reason || "")}</td>
      </tr>`).join("")}</tbody></table></div>` : `<p class="empty">기록이 없습니다.</p>`}`;

  $("nm-log-close").addEventListener("click", () => { box.hidden = true; });
  $("nm-log-review").addEventListener("click", async () => {
    const month = new Date().toLocaleDateString("sv-SE", { timeZone: "Asia/Seoul" }).slice(0, 7);
    const note = prompt(`${month} 접속기록 점검 결과를 기록합니다. 특이사항이 있으면 입력하세요.`, "특이사항 없음");
    if (note == null) return;
    try {
      await callFn("namedAccessReview")({ month, note: note.trim() });
      alert("점검 기록을 남겼습니다.");
      showAccessLog();
    } catch (e) { alert("기록 실패: " + (e.message || e)); }
  });
}

/* ── 제출물 수신 메일 ── */
async function openMailDialog() {
  let cfg = {};
  try { cfg = (await getDocById("settings", "namedSurveyMail")) || {}; } catch { /* */ }
  const cur = cfg.default || "";
  const v = prompt("선택 목적 제출물(사진·연락처)을 받을 이메일 주소를 입력하세요. 여러 개는 쉼표로 구분합니다.", cur);
  if (v == null) return;
  try {
    await setDocById("settings", "namedSurveyMail", { ...cfg, default: v.trim() });
    alert("저장했습니다.");
  } catch (e) { alert("저장 실패: " + e.message); }
}

export function initNamedAdmin() {
  const panel = document.querySelector('[data-tab="named"]');
  if (!panel) return;
  watchCollection(COLL);
  onCollection(COLL, (rows) => {
    list = [...rows].sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
    paintList();
  });
  $("named-new").addEventListener("click", () => openEditor(null));
  $("named-mail").addEventListener("click", openMailDialog);
  $("named-logbtn").addEventListener("click", showAccessLog);
  $("nm-save").addEventListener("click", saveSurvey);
  $("nm-cancel").addEventListener("click", () => { $("named-editor").hidden = true; draft = null; editingId = null; });
  $("nm-opt-on").addEventListener("change", (e) => {
    if (!draft) return;
    draft.purposeOpt.enabled = e.target.checked;
    $("nm-opt-fields").hidden = !e.target.checked;
  });
  $("nm-q-add").addEventListener("click", () => {
    draft.questions.push({ type: $("nm-q-type").value, label: "", options: [], required: true });
    paintQuestions();
  });
  $("nm-o-add").addEventListener("click", () => {
    draft.optItems.push({ type: $("nm-o-type").value, label: "" });
    paintQuestions();
  });
}
