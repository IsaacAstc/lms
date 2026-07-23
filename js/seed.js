// 초기 데이터 일괄 등록(일회성). 이미 있으면 건너뜀.
import {
  collection, getDocs, writeBatch, doc, setDoc,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./firebase.js";
import {
  SEED_ROOMS, SEED_INSTRUCTORS, SEED_PROGRAMS, SEED_FEE_RATES, SEED_TRAVEL_RATES,
} from "./seed-data.js";

async function isEmpty(name) {
  const snap = await getDocs(collection(db, name));
  return snap.empty;
}

async function seedCollection(name, rows) {
  if (!(await isEmpty(name))) return `${name}: 이미 데이터가 있어 건너뜀`;
  const batch = writeBatch(db);
  for (const row of rows) batch.set(doc(collection(db, name)), row);
  await batch.commit();
  return `${name}: ${rows.length}건 등록`;
}

export function initSeed() {
  const btn = document.getElementById("seed-btn");
  const log = document.getElementById("seed-log");
  btn.addEventListener("click", async () => {
    if (!confirm("초기 데이터(강의실·강사·과정 커리큘럼·강사료/여비 기준)를 등록합니다.\n이미 있는 항목은 건너뜁니다. 진행할까요?")) return;
    btn.disabled = true;
    log.textContent = "등록 중...\n";
    try {
      const results = [];
      results.push(await seedCollection("rooms", SEED_ROOMS));
      results.push(await seedCollection("instructors", SEED_INSTRUCTORS));
      results.push(await seedCollection("programs", SEED_PROGRAMS));
      // 설정 문서(기준값)는 없을 때만 생성.
      const settingsSnap = await getDocs(collection(db, "settings"));
      const existing = new Set(settingsSnap.docs.map((d) => d.id));
      if (!existing.has("feeRates")) {
        await setDoc(doc(db, "settings", "feeRates"), { rates: SEED_FEE_RATES });
        results.push("settings/feeRates: 등록");
      } else results.push("settings/feeRates: 이미 있음");
      if (!existing.has("travelRates")) {
        await setDoc(doc(db, "settings", "travelRates"), { rates: SEED_TRAVEL_RATES });
        results.push("settings/travelRates: 등록");
      } else results.push("settings/travelRates: 이미 있음");
      log.textContent = results.join("\n") + "\n\n완료.";
    } catch (e) {
      log.textContent += "실패: " + e.message;
    } finally {
      btn.disabled = false;
    }
  });
}
