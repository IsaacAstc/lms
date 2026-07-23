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

export function initReports() {
  const now = new Date();
  document.getElementById("rep-period").value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  document.getElementById("rep-run").addEventListener("click", run);
  document.addEventListener("tabshown", (e) => { if (e.detail === "reports") run(); });
}

async function run() {
  const type = document.getElementById("rep-period-type").value;
  const month = document.getElementById("rep-period").value;
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

  if (responses.length) {
    const agg = computeAgg(responses);
    total.textContent = `총 응답 ${responses.length}건 (원문)`;
    document.getElementById("rep-edu").innerHTML = renderEduHTML(agg);
    document.getElementById("rep-inst").innerHTML = renderInstHTML(agg);
    renderRaw(responses);
    return;
  }

  // 원문이 없으면 해당 월의 파기 스냅샷 조회.
  if (type === "month" && month) {
    const sdoc = await getDoc(doc(db, "surveyAggregates", month));
    if (sdoc.exists()) {
      const agg = deserializeAgg(sdoc.data());
      total.textContent = `집계 스냅샷 (원문 파기됨, 응답 ${agg.count}건 기준)`;
      document.getElementById("rep-edu").innerHTML = renderEduHTML(agg);
      document.getElementById("rep-inst").innerHTML = renderInstHTML(agg);
      document.getElementById("rep-raw").innerHTML = `<p class="empty">이 기간의 원문은 파기되었습니다. 집계 결과만 보존됩니다.</p>`;
      return;
    }
  }
  total.textContent = "총 응답 0건";
  document.getElementById("rep-edu").innerHTML = `<p class="empty">해당 기간 응답이 없습니다.</p>`;
  document.getElementById("rep-inst").innerHTML = `<p class="empty">해당 기간 응답이 없습니다.</p>`;
  document.getElementById("rep-raw").innerHTML = `<p class="empty">해당 기간 응답이 없습니다.</p>`;
}

// 설문 원응답(raw) — 개별 익명 응답.
function renderRaw(responses) {
  const box = document.getElementById("rep-raw");
  const eduHead = EDU_ITEMS.map((_, i) => `<th>교${i + 1}</th>`).join("");
  const rows = responses
    .slice().sort((a, b) => (b.collectedDate || "").localeCompare(a.collectedDate || ""))
    .map((r) => {
      const edu = EDU_ITEMS.map((_, i) => `<td>${r.edu?.[`q${i}`] ?? ""}</td>`).join("");
      const inst = (r.instructors || [])
        .map((it) => `${escapeHtml(it.subject)}/${escapeHtml(it.instructorName)}: ${[0, 1, 2].map((i) => it[`q${i}`] ?? "-").join("·")}`)
        .join("<br>");
      return `<tr>
        <td>${escapeHtml(r.collectedDate || "")}</td>
        <td>${escapeHtml(r.courseType || "")}</td>
        ${edu}
        <td class="raw-inst">${inst || "-"}</td>
        <td class="raw-free">${escapeHtml(r.freeDissatisfied || "")}</td>
        <td class="raw-free">${escapeHtml(r.freeSuggestion || "")}</td>
      </tr>`;
    }).join("");
  box.innerHTML = `<table><thead><tr><th>수집일</th><th>과정유형</th>${eduHead}<th>강사평가(준비·질의·전반)</th><th>불만족</th><th>제안·개선</th></tr></thead><tbody>${rows}</tbody></table>`;
}
