// 화면 표(table)를 CSV로 내보내는 공용 유틸. 외부 라이브러리 없음.
function csvCell(v) {
  const s = String(v ?? "").replace(/ /g, " ").trim();
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// 셀 텍스트 추출: 입력/선택 값 우선, 없으면 버튼 제거 후 텍스트.
function cellText(c) {
  const fields = c.querySelectorAll("input, select, textarea");
  if (fields.length) {
    return [...fields]
      .map((f) => (f.type === "checkbox" ? (f.checked ? "Y" : "") : (f.value || "")))
      .filter((x) => x !== "").join(" ");
  }
  const clone = c.cloneNode(true);
  clone.querySelectorAll("button").forEach((b) => b.remove());
  return clone.textContent.replace(/\s+/g, " ").trim();
}

// 표를 2차원 배열로(간단한 rowspan 반영) → CSV 문자열.
export function tableToCsv(table) {
  const out = [];
  const pending = []; // {col, value, rem}
  for (const tr of table.rows) {
    const cellEls = [...tr.cells];
    const result = [];
    let col = 0, idx = 0;
    while (idx < cellEls.length || pending.some((p) => p.rem > 0 && p.col === col)) {
      const carried = pending.find((p) => p.rem > 0 && p.col === col);
      if (carried) { result[col] = carried.value; carried.rem--; col++; continue; }
      if (idx >= cellEls.length) break;
      const c = cellEls[idx++];
      const text = cellText(c);
      result[col] = text;
      if ((c.rowSpan || 1) > 1) pending.push({ col, value: text, rem: c.rowSpan - 1 });
      col++;
    }
    out.push(result);
  }
  return out.map((r) => Array.from(r, (v) => csvCell(v)).join(",")).join("\r\n");
}

// UTF-8 BOM 포함 CSV 다운로드(엑셀 한글 깨짐 방지).
export function downloadCsv(filename, text) {
  const blob = new Blob(["﻿" + text], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}
