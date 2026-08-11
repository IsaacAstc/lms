import { firebaseConfig, setupAppCheck } from "./firebase-config.js";
import {
  EVENT_PARAM,
  LEGACY_EVENT_ID,
  LEGACY_EVENT_NAME,
  formatEventPeriod,
  normalizeMissionOrder,
  parseMissionOrder,
} from "./events.js";
import {
  MISSION_SETTINGS_PATH,
  DEFAULT_MISSION_CONFIG,
  mergeMissionConfig,
} from "./mission-config.js";

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  signInWithEmailAndPassword,
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  getFirestore,
  collection,
  onSnapshot,
  doc,
  getDoc,
  setDoc,
  updateDoc,
  deleteDoc,
  getDocs,
  writeBatch,
  serverTimestamp,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

const app = initializeApp(firebaseConfig);
setupAppCheck(app);
const auth = getAuth(app);
const db = getFirestore(app);

let allRows = [];
let allEvents = [];
let allAdmins = [];
let selectedEventId = "all"; // "all" | 행사 문서 ID | LEGACY_EVENT_ID
let unsubscribe = null;
let unsubscribeEvents = null;
let unsubscribeAdmins = null;
let currentUserEmail = "";
let currentIsOwner = false;

// 아이디 형태(@ 없음) 입력 시 가상 도메인을 붙여 Firebase 이메일 계정으로 매핑
const ADMIN_ID_DOMAIN = "@kac.astc";

// 소유자(최상위 관리자) — ⚠ firestore.rules 의 isOwner() 목록과 반드시 동일하게 유지할 것.
// 여기 목록은 화면 표시/버튼 노출용이며, 실제 권한 판정은 항상 Firestore 규칙이 담당한다.
// LMS 통합: 소유자는 LMS 부트스트랩 마스터와 동일하게 유지한다.
const OWNER_EMAILS = ["isaac@airport.co.kr"];

function toEmail(idOrEmail) {
  const v = idOrEmail.trim().toLowerCase();
  return v.includes("@") ? v : v + ADMIN_ID_DOMAIN;
}

// 아이디 형태 계정은 화면에 아이디만 보여준다 (staff1@kac.astc → staff1)
function displayAccount(email) {
  return email.endsWith(ADMIN_ID_DOMAIN) ? email.slice(0, -ADMIN_ID_DOMAIN.length) : email;
}

// ---------------------------------------------------------------------
// 인증 상태 — 로그인 계정이 실제 관리자인지 확인 후에만 대시보드를 연다
// ---------------------------------------------------------------------
async function isAdminAccount(email) {
  if (OWNER_EMAILS.includes(email)) return true;
  try {
    const snap = await getDoc(doc(db, "admins", email));
    return snap.exists();
  } catch (e) {
    // 권한이 없으면 규칙에서 읽기 자체가 거부된다 → 관리자가 아님
    return false;
  }
}

onAuthStateChanged(auth, async (user) => {
  if (user) {
    const email = (user.email || "").toLowerCase();
    if (!(await isAdminAccount(email))) {
      document.getElementById("loginError").textContent =
        "이 계정에는 관리자 권한이 없습니다. 관리자에게 권한 부여를 요청하세요.";
      await signOut(auth);
      return;
    }
    currentUserEmail = email;
    currentIsOwner = OWNER_EMAILS.includes(email);
    document.getElementById("currentAdmin").textContent =
      `${displayAccount(email)} · ${currentIsOwner ? "소유자" : "관리자"}`;
    document.getElementById("loginBox").style.display = "none";
    document.getElementById("adminApp").style.display = "block";
    startListener();
    loadMissionsForEdit();
    initSiteUrlInput();
  } else {
    currentUserEmail = "";
    currentIsOwner = false;
    document.getElementById("loginBox").style.display = "block";
    document.getElementById("adminApp").style.display = "none";
    if (unsubscribe) unsubscribe();
    if (unsubscribeEvents) unsubscribeEvents();
    if (unsubscribeAdmins) unsubscribeAdmins();
  }
});

document.getElementById("btnLogin").addEventListener("click", async () => {
  const idOrEmail = document.getElementById("loginEmail").value.trim();
  const email = idOrEmail.includes("@") ? idOrEmail : idOrEmail + ADMIN_ID_DOMAIN;
  const pw = document.getElementById("loginPw").value;
  const errEl = document.getElementById("loginError");
  errEl.textContent = "";
  try {
    await signInWithEmailAndPassword(auth, email, pw);
  } catch (e) {
    errEl.textContent = "로그인 실패: 아이디(이메일)/비밀번호를 확인하세요.";
  }
});

document.getElementById("btnLogout").addEventListener("click", () => signOut(auth));

// ---------------------------------------------------------------------
// 실시간 참가자 목록
// ---------------------------------------------------------------------
function startListener() {
  const ref = collection(db, "participants");
  unsubscribe = onSnapshot(
    ref,
    (snap) => {
      allRows = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderAll();
    },
    (err) => {
      console.error("참가자 목록 구독 실패", err);
    }
  );
  // LMS 통합: 관리자 명단 구독·관리 UI 제거(LMS 관리자 목록 탭에서 일원 관리).
  unsubscribeEvents = onSnapshot(
    collection(db, "events"),
    (snap) => {
      allEvents = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      allEvents.sort((a, b) => (a.name || "").localeCompare(b.name || "", "ko"));
      renderEventSelect();
      renderEventsTable();
      renderAll();
    },
    (err) => {
      console.error("행사 목록 구독 실패", err);
    }
  );
}

// 참가자 문서의 소속 행사 ID (없으면 레거시)
function rowEventId(r) {
  return r.eventId || LEGACY_EVENT_ID;
}

// 현재 "보기 대상"에 해당하는 참가자만 추리기
function rowsForSelectedEvent() {
  if (selectedEventId === "all") return allRows;
  return allRows.filter((r) => rowEventId(r) === selectedEventId);
}

function eventNameById(id) {
  if (id === LEGACY_EVENT_ID) return LEGACY_EVENT_NAME;
  const ev = allEvents.find((e) => e.id === id);
  return ev ? ev.name : id;
}

function renderAll() {
  const filter = document.getElementById("searchInput").value.trim().toLowerCase();
  const scoped = rowsForSelectedEvent();
  const rows = filter
    ? scoped.filter(
        (r) =>
          (r.nickname || "").toLowerCase().includes(filter) ||
          (r.certCode || "").toLowerCase().includes(filter)
      )
    : scoped;
  const sorted = [...rows].sort(
    (a, b) => (b.totalScore || 0) - (a.totalScore || 0) || (a.totalTimeMs || 0) - (b.totalTimeMs || 0)
  );
  renderStats(scoped);
  renderTable(sorted);
  updateQrTargetInfo();
  const meta = document.getElementById("eventFilterMeta");
  if (meta) {
    meta.textContent =
      selectedEventId === "all"
        ? `모든 행사 합계 ${allRows.length}명`
        : `${eventNameById(selectedEventId)} · ${scoped.length}명`;
  }
}

// ---------------------------------------------------------------------
// 미션 설정 편집 (문구·항목·제한시간). 배점 공식은 코드 고정.
// ---------------------------------------------------------------------
let missionCfg = JSON.parse(JSON.stringify(DEFAULT_MISSION_CONFIG));

async function loadMissionsForEdit() {
  try {
    const snap = await getDoc(doc(db, MISSION_SETTINGS_PATH.collection, MISSION_SETTINGS_PATH.docId));
    missionCfg = mergeMissionConfig(snap.exists() ? snap.data() : null);
  } catch (e) {
    console.warn("미션 설정 조회 실패(기본값 표시):", e.message);
    missionCfg = mergeMissionConfig(null);
  }
  renderMissionEditor();
}

function textRow(label, id, value) {
  return `<div style="margin-bottom:10px">
    <label class="field-label" for="${id}">${escapeHtml(label)}</label>
    <input type="text" id="${id}" value="${escapeHtml(value || "")}" style="width:100%" />
  </div>`;
}

function renderMissionEditor() {
  const root = document.getElementById("missionEditor");
  if (!root) return;

  const block = (n) => {
    const m = missionCfg["mission" + n];
    const timeField =
      "durationSec" in m
        ? `<div style="margin-bottom:10px">
             <label class="field-label" for="m${n}-duration">제한시간(초)</label>
             <input type="number" id="m${n}-duration" min="5" max="300" value="${m.durationSec}" />
           </div>`
        : `<div style="margin-bottom:10px">
             <label class="field-label" for="m${n}-seqlen">기억할 배선 개수 (3~12)</label>
             <input type="number" id="m${n}-seqlen" min="3" max="12" value="${m.seqLen}" />
           </div>`;

    let listEditor = "";
    if (n === 1) {
      listEditor = `
        <div class="section-title" style="margin-top:6px"><span>위험물 · 안전물품 목록</span></div>
        <p style="font-size:12px;color:var(--text-muted);margin:0 0 8px">
          "위험물" 체크가 정답 항목입니다. 각 종류가 최소 1개씩 필요하며, 게임에서는 매번 위험물 6개·안전물품 6개가 무작위로 선택됩니다.
        </p>
        <div class="table-wrap"><table class="participants events-table"><thead><tr>
          <th style="width:80px">이모지</th><th>이름</th><th style="width:90px">위험물</th><th style="width:80px">삭제</th>
        </tr></thead><tbody id="m1-items"></tbody></table></div>
        <div class="toolbar" style="margin-top:8px">
          <button class="btn btn-ghost" id="m1-add" style="width:auto">항목 추가</button>
        </div>`;
    } else if (n === 3) {
      listEditor = `
        <div class="section-title" style="margin-top:6px"><span>직업 · 설명 짝</span></div>
        <p style="font-size:12px;color:var(--text-muted);margin:0 0 8px">
          최소 2쌍 필요합니다. 배점 공식이 6쌍 기준(짝당 20점)이므로 <strong>6쌍 유지를 권장</strong>합니다.
        </p>
        <div class="table-wrap"><table class="participants events-table"><thead><tr>
          <th style="width:80px">이모지</th><th style="width:160px">직업명</th><th>설명</th><th style="width:80px">삭제</th>
        </tr></thead><tbody id="m3-pairs"></tbody></table></div>
        <div class="toolbar" style="margin-top:8px">
          <button class="btn btn-ghost" id="m3-add" style="width:auto">짝 추가</button>
        </div>`;
    }

    // 기본은 접힌 상태 — 제목을 클릭하면 펼쳐진다
    return `<details class="mission-block">
      <summary>MISSION 0${n} <span class="mission-summary-name">${escapeHtml(m.name || "")}</span></summary>
      ${textRow("미션 카드 제목", `m${n}-name`, m.name)}
      ${textRow("미션 카드 한 줄 설명", `m${n}-cardDesc`, m.cardDesc)}
      ${textRow("안내 화면 제목", `m${n}-title`, m.title)}
      ${textRow("안내 문구 1줄", `m${n}-line1`, m.line1)}
      ${textRow("안내 문구 2줄", `m${n}-line2`, m.line2)}
      ${timeField}
      ${listEditor}
    </details>`;
  };

  root.innerHTML = [1, 2, 3].map(block).join("");
  renderItemRows();
  renderPairRows();

  document.getElementById("m1-add").addEventListener("click", () => {
    missionCfg.mission1.items.push({ e: "❓", l: "새 항목", d: false });
    renderItemRows();
  });
  document.getElementById("m3-add").addEventListener("click", () => {
    missionCfg.mission3.pairs.push({ id: "pair" + Date.now(), emoji: "❓", label: "새 직업", duty: "설명" });
    renderPairRows();
  });
}

function renderItemRows() {
  const body = document.getElementById("m1-items");
  if (!body) return;
  body.innerHTML = missionCfg.mission1.items
    .map(
      (it, i) => `<tr>
        <td><input type="text" class="it-e" data-i="${i}" value="${escapeHtml(it.e)}" style="width:60px" /></td>
        <td><input type="text" class="it-l" data-i="${i}" value="${escapeHtml(it.l)}" /></td>
        <td><input type="checkbox" class="it-d" data-i="${i}" ${it.d ? "checked" : ""} /></td>
        <td><button class="btn btn-danger it-del" data-i="${i}">삭제</button></td>
      </tr>`
    )
    .join("");
  body.querySelectorAll(".it-del").forEach((b) =>
    b.addEventListener("click", () => {
      collectItemRows();
      missionCfg.mission1.items.splice(Number(b.dataset.i), 1);
      renderItemRows();
    })
  );
}

function renderPairRows() {
  const body = document.getElementById("m3-pairs");
  if (!body) return;
  body.innerHTML = missionCfg.mission3.pairs
    .map(
      (p, i) => `<tr>
        <td><input type="text" class="pr-e" data-i="${i}" value="${escapeHtml(p.emoji)}" style="width:60px" /></td>
        <td><input type="text" class="pr-l" data-i="${i}" value="${escapeHtml(p.label)}" /></td>
        <td><input type="text" class="pr-d" data-i="${i}" value="${escapeHtml(p.duty)}" /></td>
        <td><button class="btn btn-danger pr-del" data-i="${i}">삭제</button></td>
      </tr>`
    )
    .join("");
  body.querySelectorAll(".pr-del").forEach((b) =>
    b.addEventListener("click", () => {
      collectPairRows();
      missionCfg.mission3.pairs.splice(Number(b.dataset.i), 1);
      renderPairRows();
    })
  );
}

// 화면 입력값을 missionCfg로 수집
function collectItemRows() {
  const body = document.getElementById("m1-items");
  if (!body) return;
  missionCfg.mission1.items = [...body.querySelectorAll("tr")].map((tr) => ({
    e: tr.querySelector(".it-e").value.trim(),
    l: tr.querySelector(".it-l").value.trim(),
    d: tr.querySelector(".it-d").checked,
  }));
}

function collectPairRows() {
  const body = document.getElementById("m3-pairs");
  if (!body) return;
  missionCfg.mission3.pairs = [...body.querySelectorAll("tr")].map((tr, i) => ({
    id: missionCfg.mission3.pairs[i] ? missionCfg.mission3.pairs[i].id : "pair" + i,
    emoji: tr.querySelector(".pr-e").value.trim(),
    label: tr.querySelector(".pr-l").value.trim(),
    duty: tr.querySelector(".pr-d").value.trim(),
  }));
}

function collectMissionEditor() {
  [1, 2, 3].forEach((n) => {
    const m = missionCfg["mission" + n];
    const val = (id) => {
      const el = document.getElementById(id);
      return el ? el.value.trim() : "";
    };
    m.name = val(`m${n}-name`);
    m.cardDesc = val(`m${n}-cardDesc`);
    m.title = val(`m${n}-title`);
    m.line1 = val(`m${n}-line1`);
    m.line2 = val(`m${n}-line2`);
    const dEl = document.getElementById(`m${n}-duration`);
    if (dEl) m.durationSec = Number(dEl.value);
    const sEl = document.getElementById(`m${n}-seqlen`);
    if (sEl) m.seqLen = Number(sEl.value);
  });
  collectItemRows();
  collectPairRows();
}

document.getElementById("btnSaveMissions").addEventListener("click", async () => {
  collectMissionEditor();
  // 저장 전 유효성 확인 — 잘못된 설정으로 게임이 깨지지 않도록
  const items = missionCfg.mission1.items.filter((i) => i.e && i.l);
  if (!items.some((i) => i.d) || !items.some((i) => !i.d)) {
    return alert("미션1: 위험물과 안전물품이 각각 최소 1개씩 필요합니다.");
  }
  const pairs = missionCfg.mission3.pairs.filter((p) => p.emoji && p.label && p.duty);
  if (pairs.length < 2) return alert("미션3: 직업 짝이 최소 2개 필요합니다.");
  if (!(missionCfg.mission1.durationSec > 0) || !(missionCfg.mission3.durationSec > 0)) {
    return alert("제한시간은 1초 이상이어야 합니다.");
  }

  const msg = document.getElementById("missionSaveMsg");
  const btn = document.getElementById("btnSaveMissions");
  btn.disabled = true;
  msg.textContent = "저장 중...";
  try {
    await setDoc(doc(db, MISSION_SETTINGS_PATH.collection, MISSION_SETTINGS_PATH.docId), {
      ...missionCfg,
      updatedAt: serverTimestamp(),
      updatedBy: currentUserEmail,
    });
    msg.textContent = "저장했습니다. 참가자 화면은 새로고침 시 반영됩니다.";
  } catch (e) {
    console.error(e);
    msg.textContent = "";
    alert("저장 실패: " + e.message);
  }
  btn.disabled = false;
});

document.getElementById("btnResetMissions").addEventListener("click", () => {
  if (!confirm("편집 중인 내용을 기본값으로 되돌립니다. (저장을 눌러야 실제 반영됩니다)")) return;
  missionCfg = JSON.parse(JSON.stringify(DEFAULT_MISSION_CONFIG));
  renderMissionEditor();
  document.getElementById("missionSaveMsg").textContent = "기본값을 불러왔습니다. 저장을 눌러 반영하세요.";
});

// ---------------------------------------------------------------------
// 행사(세션) 관리
// ---------------------------------------------------------------------
function hasLegacyRows() {
  return allRows.some((r) => !r.eventId);
}

function renderEventSelect() {
  const sel = document.getElementById("eventFilter");
  if (!sel) return;
  const opts = [{ id: "all", label: "전체 (모든 행사)" }];
  allEvents.forEach((e) => opts.push({ id: e.id, label: e.name || e.id }));
  if (hasLegacyRows()) opts.push({ id: LEGACY_EVENT_ID, label: LEGACY_EVENT_NAME });
  // 선택이 사라진 경우 전체로 되돌림
  if (!opts.some((o) => o.id === selectedEventId)) selectedEventId = "all";
  sel.innerHTML = opts
    .map((o) => `<option value="${escapeHtml(o.id)}"${o.id === selectedEventId ? " selected" : ""}>${escapeHtml(o.label)}</option>`)
    .join("");
}

function renderEventsTable() {
  const body = document.getElementById("eventsBody");
  if (!body) return;
  // 입력 중에는 다시 그리지 않음(타이핑 중 값이 날아가는 것 방지)
  if (body.contains(document.activeElement)) return;

  if (allEvents.length === 0) {
    body.innerHTML =
      '<tr><td colspan="7" style="text-align:center;color:var(--text-muted)">등록된 행사가 없습니다. 아래에서 추가하세요.<br/>행사를 만들기 전까지는 기존과 동일하게 동작합니다.</td></tr>';
    return;
  }
  body.innerHTML = allEvents
    .map((e) => {
      const count = allRows.filter((r) => rowEventId(r) === e.id).length;
      return `<tr data-id="${e.id}">
        <td><input type="text" class="ev-name" data-id="${e.id}" value="${escapeHtml(e.name || "")}" /></td>
        <td><input type="datetime-local" class="ev-start" data-id="${e.id}" value="${escapeHtml(e.startAt || "")}" /></td>
        <td><input type="datetime-local" class="ev-end" data-id="${e.id}" value="${escapeHtml(e.endAt || "")}" /></td>
        <td><button class="reward-toggle ev-active ${e.active ? "on" : ""}" data-id="${e.id}" title="진행중으로 표시 (여러 행사 동시 가능). QR 없이 접속하면 진행중인 행사 중에서 선택하게 됩니다."></button></td>
        <td><input type="text" class="ev-missions" data-id="${e.id}" value="${normalizeMissionOrder(e.missionOrder).join(",")}"
              style="width:90px" title="사용할 미션 번호를 순서대로 입력 (예: 1,2,3 또는 3,1)" /></td>
        <td>${count}</td>
        <td>
          <button class="btn btn-secondary ev-qr" data-id="${e.id}">QR</button>
          <button class="btn btn-secondary ev-save" data-id="${e.id}">저장</button>
          <button class="btn btn-danger ev-del" data-id="${e.id}">삭제</button>
        </td>
      </tr>`;
    })
    .join("");

  body.querySelectorAll(".ev-qr").forEach((btn) =>
    btn.addEventListener("click", () => {
      const id = btn.dataset.id;
      openQrModal(`${eventNameById(id)} 전용 QR`, siteUrlFor(id));
    })
  );

  body.querySelectorAll(".ev-save").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const name = body.querySelector(`.ev-name[data-id="${id}"]`).value.trim();
      const startAt = body.querySelector(`.ev-start[data-id="${id}"]`).value;
      const endAt = body.querySelector(`.ev-end[data-id="${id}"]`).value;
      const missionOrder = parseMissionOrder(body.querySelector(`.ev-missions[data-id="${id}"]`).value);
      if (!name) return alert("행사명을 입력하세요.");
      if (!missionOrder) {
        return alert("미션 구성은 1~3 사이 번호를 중복 없이 순서대로 입력하세요. (예: 1,2,3 또는 3,1)");
      }
      if (startAt && endAt && new Date(startAt) > new Date(endAt)) {
        return alert("종료 일시가 시작 일시보다 빠릅니다.");
      }
      btn.disabled = true;
      try {
        await updateDoc(doc(db, "events", id), { name, startAt, endAt, missionOrder });
      } catch (err) {
        console.error(err);
        alert("저장 실패: " + err.message);
      }
      btn.disabled = false;
    })
  );

  body.querySelectorAll(".ev-active").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const turningOn = !btn.classList.contains("on");
      btn.disabled = true;
      try {
        // 여러 행사를 동시에 진행할 수 있다.
        // 진행중인 행사가 2개 이상이면 QR 없이 접속한 참가자에게 선택 화면이 표시된다.
        await updateDoc(doc(db, "events", id), { active: turningOn });
      } catch (err) {
        console.error(err);
        alert("변경 실패: " + err.message);
      }
      btn.disabled = false;
    })
  );

  body.querySelectorAll(".ev-del").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const count = allRows.filter((r) => rowEventId(r) === id).length;
      if (count > 0) {
        return alert(
          `이 행사에는 참가자 기록이 ${count}건 있습니다.\n기록을 먼저 정리한 뒤 삭제하세요.`
        );
      }
      if (!confirm(`행사 "${eventNameById(id)}"를 삭제할까요?`)) return;
      btn.disabled = true;
      try {
        await deleteDoc(doc(db, "events", id));
      } catch (err) {
        console.error(err);
        alert("삭제 실패: " + err.message);
      }
      btn.disabled = false;
    })
  );
}

document.getElementById("eventFilter").addEventListener("change", (e) => {
  selectedEventId = e.target.value;
  renderEventsTable();
  renderAll();
});

document.getElementById("btnAddEvent").addEventListener("click", async () => {
  const nameEl = document.getElementById("newEventName");
  const startEl = document.getElementById("newEventStart");
  const endEl = document.getElementById("newEventEnd");
  const name = nameEl.value.trim();
  if (!name) return alert("행사명을 입력하세요.");
  if (startEl.value && endEl.value && new Date(startEl.value) > new Date(endEl.value)) {
    return alert("종료 일시가 시작 일시보다 빠릅니다.");
  }
  // QR URL을 짧게 유지하기 위해 짧은 ID 사용
  const id = "ev" + Math.random().toString(36).slice(2, 8);
  const btn = document.getElementById("btnAddEvent");
  btn.disabled = true;
  try {
    await setDoc(doc(db, "events", id), {
      name,
      startAt: startEl.value || "",
      endAt: endEl.value || "",
      missionOrder: [1, 2, 3], // 기본은 미션 3개 전부
      active: allEvents.length === 0, // 첫 행사는 기본 활성
      createdAt: serverTimestamp(),
    });
    nameEl.value = "";
    startEl.value = "";
    endEl.value = "";
  } catch (err) {
    console.error(err);
    alert("행사 추가 실패: " + err.message);
  }
  btn.disabled = false;
});

// 참가자 접속 URL — 행사 ID를 주면 해당 행사 전용 링크(?event=<ID>)
function siteUrlFor(eventId) {
  const base = document.getElementById("siteUrlInput").value.trim();
  if (!base) return "";
  if (!eventId) return base;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}${EVENT_PARAM}=${eventId}`;
}

// 접이식 "접속 주소 설정" 요약에 현재 기본 주소를 짧게 표시
function updateQrTargetInfo() {
  const preview = document.getElementById("siteUrlPreview");
  if (!preview) return;
  const base = siteUrlFor(null);
  preview.textContent = base ? `· ${base}` : "· 주소를 입력하세요";
}

// QR 팝업 열기 (행사별 또는 기본 주소)
function openQrModal(title, url) {
  if (!url) {
    alert("먼저 '접속 주소 설정'에서 참가자용 페이지 URL을 입력하세요.");
    return;
  }
  document.getElementById("qrModalTitle").textContent = title;
  document.getElementById("qrModalUrl").textContent = url;
  const holder = document.getElementById("qrCanvasHolder");
  holder.innerHTML = "";
  // eslint-disable-next-line no-undef
  new QRCode(holder, { text: url, width: 180, height: 180 });
  document.getElementById("qrModal").style.display = "flex";
}

function closeQrModal() {
  document.getElementById("qrModal").style.display = "none";
}

document.getElementById("btnCloseQr").addEventListener("click", closeQrModal);
document.getElementById("qrModal").addEventListener("click", (e) => {
  if (e.target.id === "qrModal") closeQrModal(); // 바깥 클릭 시 닫기
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeQrModal();
});
document.getElementById("btnCopyQrUrl").addEventListener("click", async () => {
  const url = document.getElementById("qrModalUrl").textContent;
  const btn = document.getElementById("btnCopyQrUrl");
  try {
    await navigator.clipboard.writeText(url);
    const prev = btn.textContent;
    btn.textContent = "복사됨!";
    setTimeout(() => (btn.textContent = prev), 1500);
  } catch (err) {
    alert("복사에 실패했습니다. 주소를 직접 선택해 복사하세요.");
  }
});
document.getElementById("btnGenBaseQr").addEventListener("click", () =>
  openQrModal("기본 주소 QR", siteUrlFor(null))
);

function renderStats(rows) {
  const total = rows.length;
  const completed = rows.filter((r) => r.completedAt).length;
  const reward = rows.filter((r) => r.rewardGiven).length;
  const rate = total ? Math.round((completed / total) * 100) : 0;
  document.getElementById("statTotal").textContent = total;
  document.getElementById("statCompleted").textContent = completed;
  document.getElementById("statReward").textContent = reward;
  document.getElementById("statRate").textContent = rate + "%";
}

function missionCell(m) {
  if (!m) return '<span class="done-no">-</span>';
  return `<span class="done-yes">${m.score}pt</span>`;
}

function escapeHtml(str) {
  return String(str).replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

function renderTable(rows) {
  const body = document.getElementById("participantsBody");
  if (rows.length === 0) {
    body.innerHTML =
      '<tr><td colspan="10" style="text-align:center;color:var(--text-muted)">데이터가 없습니다</td></tr>';
    updateDeleteBtn();
    return;
  }
  body.innerHTML = rows
    .map((r) => {
      const completedAt =
        r.completedAt && r.completedAt.toDate ? r.completedAt.toDate().toLocaleString("ko-KR") : "-";
      return `<tr data-id="${r.id}">
        <td><input type="checkbox" class="row-check" data-id="${r.id}" /></td>
        <td>${escapeHtml(r.nickname || "-")}</td>
        <td>${escapeHtml(r.certCode || "-")}</td>
        <td>${missionCell(r.mission1)}</td>
        <td>${missionCell(r.mission2)}</td>
        <td>${missionCell(r.mission3)}</td>
        <td>${r.totalScore || 0}</td>
        <td>${((r.totalTimeMs || 0) / 1000).toFixed(1)}</td>
        <td>${completedAt}</td>
        <td><button class="reward-toggle ${r.rewardGiven ? "on" : ""}" data-id="${r.id}"></button></td>
      </tr>`;
    })
    .join("");

  body.querySelectorAll(".reward-toggle").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.id;
      const current = btn.classList.contains("on");
      btn.disabled = true;
      try {
        await updateDoc(doc(db, "participants", id), { rewardGiven: !current });
      } catch (e) {
        console.error(e);
        alert("업데이트 실패: " + e.message);
      }
      btn.disabled = false;
    });
  });

  body.querySelectorAll(".row-check").forEach((cb) => {
    cb.addEventListener("change", updateDeleteBtn);
  });

  // 전체선택 체크박스 상태 동기화
  document.getElementById("checkAll").checked = false;
  updateDeleteBtn();
}

document.getElementById("searchInput").addEventListener("input", renderAll);

// 전체 선택 체크박스
document.getElementById("checkAll").addEventListener("change", (e) => {
  document.querySelectorAll(".row-check").forEach((cb) => {
    cb.checked = e.target.checked;
  });
  updateDeleteBtn();
});

// 선택삭제 버튼 표시 갱신
function updateDeleteBtn() {
  const checked = document.querySelectorAll(".row-check:checked");
  const btn = document.getElementById("btnDeleteSelected");
  const countEl = document.getElementById("selectedCount");
  countEl.textContent = checked.length;
  btn.style.display = checked.length > 0 ? "inline-flex" : "none";
}

// 선택 삭제 실행
document.getElementById("btnDeleteSelected").addEventListener("click", async () => {
  const checked = [...document.querySelectorAll(".row-check:checked")];
  if (checked.length === 0) return;
  const ids = checked.map((cb) => cb.dataset.id);
  const nicknames = ids.map((id) => {
    const row = allRows.find((r) => r.id === id);
    return row ? row.nickname : id;
  });
  if (!confirm(`선택한 ${ids.length}명의 기록을 삭제합니다:\n${nicknames.join(", ")}\n\n계속하시겠습니까?`)) return;

  const btn = document.getElementById("btnDeleteSelected");
  btn.disabled = true;
  btn.textContent = "삭제 중...";
  try {
    const batch = writeBatch(db);
    ids.forEach((id) => batch.delete(doc(db, "participants", id)));
    await batch.commit();
    document.getElementById("checkAll").checked = false;
  } catch (e) {
    console.error(e);
    alert("삭제 중 오류: " + e.message);
  }
  btn.disabled = false;
  updateDeleteBtn();
});

// ---------------------------------------------------------------------
// CSV 다운로드
// ---------------------------------------------------------------------
// CSV 셀 인코딩 + 수식 인젝션 방어:
// =, +, -, @, 탭, 캐리지리턴으로 시작하는 값은 엑셀에서 수식으로 해석될 수 있으므로
// 작은따옴표를 앞에 붙여 무력화한 뒤 따옴표로 감싼다.
function csvCell(v) {
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return `"${s.replace(/"/g, '""')}"`;
}

document.getElementById("btnExportCsv").addEventListener("click", () => {
  const header = [
    "행사", "닉네임", "인증코드", "M1점수", "M1시간ms", "M2점수", "M2시간ms",
    "M3점수", "M3시간ms", "총점", "총시간ms", "완료시각", "기념품지급",
  ];
  const lines = [header.join(",")];
  // 화면에서 선택한 행사 범위만 내보낸다
  rowsForSelectedEvent().forEach((r) => {
    const completedAt = r.completedAt && r.completedAt.toDate ? r.completedAt.toDate().toISOString() : "";
    const row = [
      eventNameById(rowEventId(r)),
      r.nickname || "",
      r.certCode || "",
      r.mission1 ? r.mission1.score : "",
      r.mission1 ? r.mission1.timeMs : "",
      r.mission2 ? r.mission2.score : "",
      r.mission2 ? r.mission2.timeMs : "",
      r.mission3 ? r.mission3.score : "",
      r.mission3 ? r.mission3.timeMs : "",
      r.totalScore || 0,
      r.totalTimeMs || 0,
      completedAt,
      r.rewardGiven ? "Y" : "N",
    ];
    lines.push(row.map(csvCell).join(","));
  });
  const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `avsec_participants_${Date.now()}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

// 참가자용 URL: 저장해 둔 값 → 없으면 현재 관리자 페이지 주소에서 추론
const SITE_URL_KEY = "avsec_admin_site_url";

function guessSiteUrl() {
  // .../admin.html → .../ (참가자 페이지)
  return location.href.split("?")[0].split("#")[0].replace(/admin\.html$/, "");
}

function initSiteUrlInput() {
  const el = document.getElementById("siteUrlInput");
  if (!el) return;
  el.value = localStorage.getItem(SITE_URL_KEY) || guessSiteUrl();
  updateQrTargetInfo();
}

document.getElementById("siteUrlInput").addEventListener("input", (e) => {
  localStorage.setItem(SITE_URL_KEY, e.target.value.trim());
  updateQrTargetInfo();
});

// ---------------------------------------------------------------------
// 데이터 초기화 (현재 "보기 대상" 행사 범위)
// ---------------------------------------------------------------------
document.getElementById("btnReset").addEventListener("click", async () => {
  const targets = rowsForSelectedEvent();
  const scopeLabel =
    selectedEventId === "all" ? "모든 행사" : eventNameById(selectedEventId);
  if (targets.length === 0) return alert(`삭제할 참가자 기록이 없습니다. (${scopeLabel})`);
  if (!confirm(`"${scopeLabel}"의 참가자 기록 ${targets.length}건을 삭제하시겠습니까?`)) return;
  if (!confirm("다시 한 번 확인합니다. 삭제 후 복구할 수 없습니다. 진행하시겠습니까?")) return;

  const btn = document.getElementById("btnReset");
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "삭제 중...";
  try {
    const chunkSize = 400;
    for (let i = 0; i < targets.length; i += chunkSize) {
      const batch = writeBatch(db);
      targets.slice(i, i + chunkSize).forEach((r) => batch.delete(doc(db, "participants", r.id)));
      await batch.commit();
    }
    alert("삭제가 완료되었습니다.");
  } catch (e) {
    console.error(e);
    alert("삭제 중 오류: " + e.message);
  }
  btn.disabled = false;
  btn.textContent = label;
});
