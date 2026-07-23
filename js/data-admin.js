// 원문(surveyResponses) 현황 모니터링 + 관리자 수동 범위 파기(집계 스냅샷 저장 후 삭제).
import {
  collection, getDocs, getDoc, doc, setDoc, query, where, writeBatch, getCountFromServer,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./firebase.js";
import { computeAgg, mergeAgg, serializeAgg, deserializeAgg } from "./agg.js";

const DEFAULT_THRESHOLD = 100000;
let threshold = DEFAULT_THRESHOLD;

export function initDataAdmin() {
  document.getElementById("raw-refresh").addEventListener("click", refreshStatus);
  document.getElementById("threshold-save").addEventListener("click", saveThreshold);
  document.getElementById("purge-btn").addEventListener("click", purge);
  loadThreshold().then(refreshStatus);
  document.addEventListener("tabshown", (e) => { if (e.detail === "data") refreshStatus(); });
}

async function loadThreshold() {
  try {
    const d = await getDoc(doc(db, "settings", "dataPolicy"));
    threshold = d.exists() && Number.isFinite(d.data().rawThreshold) ? d.data().rawThreshold : DEFAULT_THRESHOLD;
  } catch { threshold = DEFAULT_THRESHOLD; }
  document.getElementById("threshold-input").value = threshold;
}

async function saveThreshold() {
  const v = Number(document.getElementById("threshold-input").value);
  if (!Number.isFinite(v) || v <= 0) return alert("임계값은 1 이상의 숫자여야 합니다.");
  try {
    await setDoc(doc(db, "settings", "dataPolicy"), { rawThreshold: v }, { merge: true });
    threshold = v;
    alert("임계값을 저장했습니다.");
    refreshStatus();
  } catch (e) { alert("저장 실패: " + e.message); }
}

// 원문 문서 수를 count 집계로 저비용 측정.
async function refreshStatus() {
  const box = document.getElementById("raw-status");
  box.textContent = "조회 중…";
  try {
    const snap = await getCountFromServer(collection(db, "surveyResponses"));
    const n = snap.data().count;
    const pct = threshold ? Math.round((n / threshold) * 100) : 0;
    const warn = n >= threshold;
    box.innerHTML = `현재 원문 <b>${n.toLocaleString()}</b>건 / 임계값 ${threshold.toLocaleString()}건 (${pct}%) ` +
      (warn ? `<span class="warn">⚠ 임계값 도달 — 오래된 기간 원문 파기를 검토하세요.</span>`
            : `<span style="color:#3a3">여유 있음</span>`);
  } catch (e) { box.textContent = "현황 조회 실패: " + e.message; }
}

// 수집일 [start,end] 범위 원문 파기: 월별 집계 스냅샷 저장 → 원문 삭제.
async function purge() {
  const start = document.getElementById("purge-start").value;
  const end = document.getElementById("purge-end").value;
  const log = document.getElementById("purge-log");
  if (!start || !end) return alert("파기할 시작일과 종료일을 지정하세요.");
  if (end < start) return alert("종료일은 시작일 이후여야 합니다.");
  if (!confirm(`수집일 ${start} ~ ${end} 범위의 설문 원문을 파기합니다.\n(삭제 전 월별 집계 스냅샷은 보존됩니다)\n되돌릴 수 없습니다. 계속할까요?`)) return;

  const btn = document.getElementById("purge-btn");
  btn.disabled = true;
  log.textContent = "원문 조회 중…\n";
  try {
    const snap = await getDocs(query(collection(db, "surveyResponses"),
      where("collectedDate", ">=", start), where("collectedDate", "<=", end)));
    const docs = snap.docs;
    if (!docs.length) { log.textContent = "해당 범위에 원문이 없습니다."; btn.disabled = false; return; }

    // 월별 그룹.
    const byMonth = {};
    for (const d of docs) {
      const r = { id: d.id, ...d.data() };
      const ym = (r.collectedDate || "").slice(0, 7);
      (byMonth[ym] = byMonth[ym] || []).push(r);
    }

    // 1) 월별 집계 스냅샷 저장(기존 스냅샷과 병합).
    log.textContent += `대상 ${docs.length}건, ${Object.keys(byMonth).length}개월. 집계 스냅샷 저장 중…\n`;
    for (const [ym, list] of Object.entries(byMonth)) {
      let agg = computeAgg(list);
      const existing = await getDoc(doc(db, "surveyAggregates", ym));
      if (existing.exists()) agg = mergeAgg(deserializeAgg(existing.data()), agg);
      // merge:true → 주관식 시사점·피드백 반영계획(summary/actionTaken/categories) 등 서술 필드 보존.
      await setDoc(doc(db, "surveyAggregates", ym), { yearMonth: ym, ...serializeAgg(agg), updatedAtMs: Date.now() }, { merge: true });
      log.textContent += `  ${ym}: 스냅샷 저장(누적 ${agg.count}건)\n`;
    }

    // 2) 원문 삭제(배치 450개씩).
    log.textContent += "원문 삭제 중…\n";
    for (let i = 0; i < docs.length; i += 450) {
      const batch = writeBatch(db);
      docs.slice(i, i + 450).forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
    log.textContent += `완료: 원문 ${docs.length}건 파기, 집계 스냅샷 보존.`;
    refreshStatus();
  } catch (e) {
    log.textContent += "실패: " + e.message;
  } finally {
    btn.disabled = false;
  }
}
