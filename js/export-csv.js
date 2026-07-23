// 탭별 CSV 내보내기 버튼(선언적). 버튼에 data-target(표/컨테이너 선택자)·data-name(파일명).
import { tableToCsv, downloadCsv } from "./csv.js";

export function initExportButtons() {
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".csv-export");
    if (!btn) return;
    const el = document.querySelector(btn.dataset.target);
    if (!el) return alert("내보낼 표가 없습니다.");
    const table = el.tagName === "TABLE" ? el : (el.querySelector("table") || el.closest("table"));
    if (!table || !table.rows.length) return alert("내보낼 데이터가 없습니다. 먼저 조회하세요.");
    const stamp = new Date().toISOString().slice(0, 10);
    downloadCsv(`${btn.dataset.name || "export"}_${stamp}.csv`, tableToCsv(table));
  });
}
