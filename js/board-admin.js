// 공개 현황 보드 관리(관리자): 전체 동기화 + 신청 안내 문구 편집 + 공개 주소 안내.
import {
  collection, getDocs, getDoc, doc, setDoc, writeBatch,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./firebase.js";
import { boardFields } from "./courses.js";

export function initBoardAdmin() {
  document.getElementById("board-sync").addEventListener("click", () => syncAll(true));
  document.getElementById("board-apply-save").addEventListener("click", saveApply);
  document.getElementById("board-url-copy").addEventListener("click", () => {
    navigator.clipboard?.writeText(document.getElementById("board-url").value);
    document.getElementById("board-url-copy").textContent = "복사됨";
  });
  document.addEventListener("tabshown", (e) => { if (e.detail === "board") load(); });
}

async function load() {
  const base = location.origin + location.pathname.replace(/[^/]*$/, "");
  document.getElementById("board-url").value = `${base}board.html`;
  document.getElementById("board-open").href = `${base}board.html`;
  try {
    const d = await getDoc(doc(db, "publicBoard", "__config"));
    document.getElementById("board-apply-input").value = d.exists() ? (d.data().applyInfo || "") : "";
  } catch { /* */ }
  // 탭 진입 시 차이만 자동 동기화(변경 없으면 쓰기 없음). CSV 대량등록·시드분 자동 반영.
  autoSync();
}

// 보드 미러 필드 비교(updatedAtMs 제외).
function boardDiffers(a, b) {
  const keys = ["code", "name", "courseType", "round", "startDate", "endDate", "venue", "capacity", "appliedCount", "remaining", "hasEvaluation"];
  return keys.some((k) => (a?.[k] ?? "") !== (b[k] ?? ""));
}

// 미게시/변경된 차수만 게시 + 삭제분 정리(조용히). 상태 표시.
async function autoSync() {
  const log = document.getElementById("board-sync-log");
  log.textContent = "현황 확인 중…";
  try {
    const [csnap, bsnap] = await Promise.all([
      getDocs(collection(db, "courses")),
      getDocs(collection(db, "publicBoard")),
    ]);
    const boardById = {};
    bsnap.docs.forEach((d) => { if (!d.id.startsWith("__")) boardById[d.id] = d.data(); });
    const courseIds = new Set(csnap.docs.map((d) => d.id));
    const toWrite = csnap.docs.filter((d) => { const cur = boardById[d.id]; return !cur || boardDiffers(cur, boardFields(d.data())); });
    const stale = bsnap.docs.filter((d) => !d.id.startsWith("__") && !courseIds.has(d.id));
    for (let i = 0; i < toWrite.length; i += 450) {
      const batch = writeBatch(db);
      toWrite.slice(i, i + 450).forEach((d) => batch.set(doc(db, "publicBoard", d.id), boardFields(d.data())));
      await batch.commit();
    }
    for (let i = 0; i < stale.length; i += 450) {
      const batch = writeBatch(db);
      stale.slice(i, i + 450).forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
    log.textContent = `게시 ${csnap.size}건` +
      (toWrite.length || stale.length ? ` · 자동 반영: 갱신 ${toWrite.length}건${stale.length ? `, 정리 ${stale.length}건` : ""}` : " · 최신 상태");
  } catch (e) { log.textContent = "현황 확인 실패: " + e.message; }
}

async function saveApply() {
  const v = document.getElementById("board-apply-input").value.trim();
  try {
    await setDoc(doc(db, "publicBoard", "__config"), { applyInfo: v, updatedAtMs: Date.now() }, { merge: true });
    alert("신청 안내 문구를 저장했습니다.");
  } catch (e) { alert("저장 실패: " + e.message); }
}

async function syncAll(force) {
  const log = document.getElementById("board-sync-log");
  const btn = document.getElementById("board-sync");
  btn.disabled = true;
  log.textContent = "동기화 중…";
  try {
    const [csnap, bsnap] = await Promise.all([
      getDocs(collection(db, "courses")),
      getDocs(collection(db, "publicBoard")),
    ]);
    // 모든 차수 게시(미러).
    for (let i = 0; i < csnap.docs.length; i += 450) {
      const batch = writeBatch(db);
      csnap.docs.slice(i, i + 450).forEach((d) => batch.set(doc(db, "publicBoard", d.id), boardFields(d.data())));
      await batch.commit();
    }
    // 삭제된 차수의 잔여 보드 항목 정리(__config 제외).
    const courseIds = new Set(csnap.docs.map((d) => d.id));
    const stale = bsnap.docs.filter((d) => !d.id.startsWith("__") && !courseIds.has(d.id));
    for (let i = 0; i < stale.length; i += 450) {
      const batch = writeBatch(db);
      stale.slice(i, i + 450).forEach((d) => batch.delete(d.ref));
      await batch.commit();
    }
    log.textContent = `동기화 완료: 게시 ${csnap.size}건` + (stale.length ? `, 정리 ${stale.length}건` : "");
  } catch (e) { log.textContent = "동기화 실패: " + e.message; }
  finally { btn.disabled = false; }
}
