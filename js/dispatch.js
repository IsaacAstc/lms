// 출강 목록(출강요청 공문용). 선택한 달의 시간표를 강사유형별로 묶어
// 그 달에 실제 출강하는 강사만, 일시·과정·과목과 함께 보여준다.
// 읽기 전용 — 시간표(sessions)·강사 마스터를 그대로 읽어 표시만 한다.
import {
  collection, getDocs, query, where,
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "./firebase.js";
import { escapeHtml } from "./app.js";
import { getInstructorById, resolveInstructorAt } from "./instructors.js";
import { getHiddenCourseIds, coursesCache } from "./courses.js";
import { TEACHER_KINDS } from "./constants.js";
import { fmtDot, kstToday } from "./time.js";

export function initDispatch() {
  const input = document.getElementById("dispatch-month");
  if (!input) return;
  input.value = kstToday().slice(0, 7);
  document.getElementById("dispatch-run").addEventListener("click", () => render(input.value));
  document.getElementById("dispatch-print").addEventListener("click", () => window.print());
  // 탭을 처음 열 때 이번 달을 자동으로 보여준다.
  let loaded = false;
  document.addEventListener("tabshown", (e) => {
    if (e.detail !== "dispatch" || loaded) return;
    loaded = true;
    render(input.value);
  });
}

async function fetchMonthSessions(ym) {
  const q = query(collection(db, "sessions"),
    where("date", ">=", `${ym}-01`), where("date", "<=", `${ym}-31`));
  const [snap, hiddenIds] = await Promise.all([getDocs(q), getHiddenCourseIds()]);
  // 숨김 처리된 차수는 출강 요청 대상이 아니다.
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }))
    .filter((s) => s.instructorId && !hiddenIds.has(s.courseId));
}

function courseLabel(courseId) {
  const c = coursesCache.find((x) => x.id === courseId);
  if (!c) return "(삭제된 차수)";
  return `${c.name || ""}${c.round ? ` ${c.round}차수` : ""}`;
}

const ymLabel = (ym) => `${ym.slice(0, 4)}년 ${Number(ym.slice(5, 7))}월`;

const timeRange = (s) => (s.startTime && s.endTime ? `${s.startTime}-${s.endTime}` : (s.startTime || ""));

async function render(ym) {
  const box = document.getElementById("dispatch-root");
  const note = document.getElementById("dispatch-note");
  if (!/^\d{4}-\d{2}$/.test(ym || "")) { box.innerHTML = `<p class="empty">조회할 월을 선택하세요.</p>`; note.textContent = ""; return; }
  box.innerHTML = `<p class="empty">불러오는 중…</p>`;
  note.textContent = "";

  let sessions;
  try {
    sessions = await fetchMonthSessions(ym);
  } catch (e) {
    box.innerHTML = `<p class="empty">불러오지 못했습니다: ${escapeHtml(e.message)}</p>`;
    return;
  }

  // 강사 × 강사유형으로 묶는다. 유형이 이력에 따라 바뀌면 강의 일자 기준으로 판단한다.
  const byKey = {};
  for (const s of sessions) {
    const inst = getInstructorById(s.instructorId);
    // 마스터에서 지워진 강사도 시간표에 남은 이름으로 표시한다(누락 방지).
    const eff = inst ? resolveInstructorAt(inst, s.date) : { instructorType: "" };
    const kind = eff.instructorType || "(유형 미지정)";
    const name = inst?.name || s.instructor || "(강사 미상)";
    const key = `${kind}|${s.instructorId}`;
    const g = (byKey[key] = byKey[key] || { kind, name, affil: inst?.affiliation || "", items: [] });
    g.items.push(s);
  }

  const groups = Object.values(byKey);
  if (!groups.length) {
    box.innerHTML = `<p class="empty">${ymLabel(ym)}에 등록된 출강 시간표가 없습니다.</p>`;
    return;
  }
  groups.forEach((g) => g.items.sort((a, b) =>
    (a.date || "").localeCompare(b.date || "") || (a.startTime || "").localeCompare(b.startTime || "")));

  // 강사유형 순서는 기준값과 동일하게, 목록에 없는 유형은 뒤에 붙인다.
  const kinds = [...TEACHER_KINDS, ...new Set(groups.map((g) => g.kind).filter((k) => !TEACHER_KINDS.includes(k)))];
  let html = "";
  let totalInst = 0, totalSessions = 0;
  for (const kind of kinds) {
    const inKind = groups.filter((g) => g.kind === kind).sort((a, b) => a.name.localeCompare(b.name));
    if (!inKind.length) continue; // 그 달에 출강이 없는 유형은 아예 내보내지 않는다.
    totalInst += inKind.length;
    html += `<section class="dispatch-group">
      <h3>${escapeHtml(kind)} <small>${inKind.length}명</small></h3>`;
    for (const g of inKind) {
      totalSessions += g.items.length;
      html += `<div class="dispatch-inst">
        <h4>${escapeHtml(g.name)}${g.affil ? ` <small>${escapeHtml(g.affil)}</small>` : ""} <small>${g.items.length}건</small></h4>
        <div class="table-wrap"><table>
          <thead><tr><th>일시</th><th>과정</th><th>과목</th></tr></thead>
          <tbody>${g.items.map((s) => `<tr>
            <td>${escapeHtml(fmtDot(s.date))}${timeRange(s) ? ` <small>${escapeHtml(timeRange(s))}</small>` : ""}</td>
            <td>${escapeHtml(courseLabel(s.courseId))}</td>
            <td>${escapeHtml(s.subject || "")}</td>
          </tr>`).join("")}</tbody>
        </table></div>
      </div>`;
    }
    html += `</section>`;
  }
  box.innerHTML = html;
  note.textContent = `${ymLabel(ym)} · 강사 ${totalInst}명 · 출강 ${totalSessions}건`;
}
