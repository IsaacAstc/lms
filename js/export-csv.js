// 탭별 CSV 내보내기 버튼(선언적). 버튼에 data-target(표/컨테이너 선택자)·data-name(파일명).
import { tableToCsv, downloadCsv } from "./csv.js";

export function initExportButtons() {
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".csv-export");
    if (!btn) return;
    const el = document.querySelector(btn.dataset.target);
    if (!el) return alert("내보낼 표가 없습니다.");
    // 컨테이너 안의 표 전부 내보내기(표 사이 빈 줄로 구분). TABLE 자체면 그 표만.
    const tables = el.tagName === "TABLE"
      ? [el]
      : [...el.querySelectorAll("table")].concat(el.closest("table") ? [el.closest("table")] : []);
    const valid = tables.filter((t) => t && t.rows.length);
    if (!valid.length) return alert("내보낼 데이터가 없습니다. 먼저 조회하세요.");
    const stamp = new Date().toISOString().slice(0, 10);
    const csv = valid.map((t) => tableToCsv(t)).join("\r\n\r\n");
    downloadCsv(`${btn.dataset.name || "export"}_${stamp}.csv`, csv);
  });
}
