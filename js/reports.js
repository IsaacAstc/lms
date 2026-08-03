// 설문 집계 대시보드 (#7). 원문(surveyResponses) 우선, 없으면 파기 스냅샷(surveyAggregates)으로 렌더.
// 무료 한도 보호: 선택 기간만 조회(getDocs).
import {
  collection, getDocs, getDoc, doc, query, where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./firebase.js";
import { escapeHtml } from "./app.js";
import {
  computeAgg, deserializeAgg, renderEduHTML, renderInstHTML, EDU_ITEMS,
} from "./agg.js";
import { fmtDot } from "./time.js";
import { onCoursesChange, coursesCache } from "./courses.js";

// 원응답은 버튼 클릭 시에만 표시(불필요한 렌더·오해 방지).
let rawState = { responses: [], purged: false };

export function initReports() {
  const now = new Date();
  document.getElementById("rep-period").value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  document.getElementById("rep-run").addEventListener("click", run);
  // 과정 필터 — 과정명 단위(모든 차수 포함). 선택값은 목록 갱신 시에도 유지.
  onCoursesChange((courses) => {
    const sel = document.getElementById("rep-course");
    const prev = sel.value;
    // 같은 과정명은 하나로 묶고, 가장 최근 시작일 기준으로 정렬.
    const latest = new Map();
    for (const c of courses) {
      const name = (c.name || "").trim();
      if (!name) continue;
      if ((c.startDate || "") > (latest.get(name) || "")) latest.set(name, c.startDate || "");
    }
    const opts = [...latest.keys()]
      .sort((a, b) => (latest.get(b) || "").localeCompare(latest.get(a) || ""))
      .map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`)
      .join("");
    sel.innerHTML = `<option value="">전체 과정</option>` + opts;
    sel.value = [...sel.options].some((o) => o.value === prev) ? prev : "";
  });
  document.getElementById("rep-raw-btn").addEventListener("click", showRaw);
  document.addEventListener("tabshown", (e) => { if (e.detail === "reports") run(); });
}

function resetRaw(state) {
  rawState = state;
  document.getElementById("rep-raw").innerHTML = "";
}
function showRaw() {
  const box = document.getElementById("rep-raw");
  if (rawState.purged) { box.innerHTML = `<p class="empty">이 기간의 원문은 파기되었습니다. 집계 결과만 보존됩니다.</p>`; return; }
  if (!rawState.responses.length) { box.innerHTML = `<p class="empty">표시할 원응답이 없습니다.</p>`; return; }
  renderRaw(rawState.responses);
}

async function run() {
  const type = document.getElementById("rep-period-type").value;
  const month = document.getElementById("rep-period").value;
  const courseSel = document.getElementById("rep-course");
  const courseName = courseSel.value;
  // 과정명 → 해당하는 모든 차수의 courseId 집합(응답은 courseId로 저장됨).
  const courseIds = courseName
    ? new Set(coursesCache.filter((c) => (c.name || "").trim() === courseName).map((c) => c.id))
    : null;
  const total = document.getElementById("rep-total");
  total.textContent = "조회 중…";

  let responses = null;
  if (type === "month" && month) {
    const snap = await getDocs(query(collection(db, "surveyResponses"),
      where("collectedDate", ">=", `${month}-01`), where("collectedDate", "<=", `${month}-31`)));
    responses = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  } else {
    if (!confirm("전체 기간을 조회하면 응답이 많을 경우 읽기량이 커집니다. 계속할까요?")) { total.textContent = ""; return; }
    const snap = await getDocs(collection(db, "surveyResponses"));
    responses = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
  }

  // 과정 필터는 조회 후 클라이언트에서 적용(복합 인덱스 불필요, 기간으로 이미 좁혀짐).
  const fetched = responses.length;
  if (courseIds) responses = responses.filter((r) => courseIds.has(r.courseId));
  const courseLabel = courseName ? ` · ${courseName}` : "";

  if (responses.length) {
    const agg = computeAgg(responses);
    total.textContent = `총 응답 ${responses.length}건 (원문)${courseLabel}`;
    document.getElementById("rep-edu").innerHTML = renderEduHTML(agg);
    document.getElementById("rep-inst").innerHTML = renderInstHTML(agg);
    resetRaw({ responses, purged: false });
    return;
  }

  // 과정 필터로 0건이 된 경우(원문 자체는 있음) — 스냅샷으로 넘어가지 않고 명확히 안내.
  if (courseName && fetched) {
    total.textContent = `총 응답 0건${courseLabel}`;
    const msg = `<p class="empty">해당 기간에 선택한 과정의 응답이 없습니다.</p>`;
    document.getElementById("rep-edu").innerHTML = msg;
    document.getElementById("rep-inst").innerHTML = msg;
    resetRaw({ responses: [], purged: false });
    return;
  }

  // 원문이 없으면 해당 월의 파기 스냅샷 조회.
  if (type === "month" && month) {
    const sdoc = await getDoc(doc(db, "surveyAggregates", month));
    if (sdoc.exists()) {
      // 스냅샷은 월 단위 합산이라 과정별로 나눌 수 없다.
      if (courseName) {
        total.textContent = "집계 스냅샷 (원문 파기됨)";
        const msg = `<p class="empty">이 달의 원문은 파기되어 과정별 집계를 만들 수 없습니다. ‘전체 과정’을 선택하면 월 스냅샷을 표시합니다.</p>`;
        document.getElementById("rep-edu").innerHTML = msg;
        document.getElementById("rep-inst").innerHTML = msg;
        resetRaw({ responses: [], purged: true });
        return;
      }
      const agg = deserializeAgg(sdoc.data());
      total.textContent = `집계 스냅샷 (원문 파기됨, 응답 ${agg.count}건 기준)`;
      document.getElementById("rep-edu").innerHTML = renderEduHTML(agg);
      document.getElementById("rep-inst").innerHTML = renderInstHTML(agg);
      resetRaw({ responses: [], purged: true });
      return;
    }
  }
  total.textContent = `총 응답 0건${courseLabel}`;
  document.getElementById("rep-edu").innerHTML = `<p class="empty">해당 기간 응답이 없습니다.</p>`;
  document.getElementById("rep-inst").innerHTML = `<p class="empty">해당 기간 응답이 없습니다.</p>`;
  resetRaw({ responses: [], purged: false });
}

// 설문 원응답(raw) — 개별 익명 응답.
function renderRaw(responses) {
  const box = document.getElementById("rep-raw");
  // 문항 수는 응답 스냅샷 기준(문항 개정 시 과거 응답이 어긋나지 않도록).
  const items = responses.find((r) => Array.isArray(r.eduItems) && r.eduItems.length)?.eduItems || EDU_ITEMS;
  const eduHead = items.map((_, i) => `<th>교${i + 1}</th>`).join("");
  const when = (r) => r.collectedAt || r.collectedDate || "";
  const rows = responses
    .slice().sort((a, b) => when(b).localeCompare(when(a)))
    .map((r) => {
      const edu = items.map((_, i) => `<td>${r.edu?.[`q${i}`] ?? ""}</td>`).join("");
      const inst = (r.instructors || [])
        .map((it) => `${escapeHtml(it.subject)}/${escapeHtml(it.instructorName)}: ${[0, 1, 2].map((i) => it[`q${i}`] ?? "-").join("·")}`)
        .join("<br>");
      return `<tr>
        <td>${escapeHtml(fmtDot(when(r)))}</td>
        <td>${escapeHtml(r.courseType || "")}</td>
        ${edu}
        <td class="raw-inst">${inst || "-"}</td>
        <td class="raw-free">${escapeHtml(r.freeDissatisfied || "")}</td>
        <td class="raw-free">${escapeHtml(r.freeSuggestion || "")}</td>
      </tr>`;
    }).join("");
  box.innerHTML = `<table><thead><tr><th>수집일시</th><th>과정유형</th>${eduHead}<th>강사평가(준비·질의·전반)</th><th>불만족</th><th>제안·개선</th></tr></thead><tbody>${rows}</tbody></table>`;
}
