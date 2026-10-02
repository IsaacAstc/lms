// 인쇄(PDF): 지정한 내용만 새 창으로 열어 print — 관리자 화면의 전역 CSS·탭·버튼이
// 섞이지 않게 한다. 운영 보고서와 강사료 집계가 같은 양식을 쓴다.
export function openPrintWindow(title, bodyHtml) {
  const w = window.open("", "_blank");
  if (!w) return alert("팝업이 차단되었습니다. 팝업을 허용하세요.");
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
  w.document.write(`<!doctype html><html lang="ko"><head><meta charset="utf-8">
    <title>${esc(title)}</title>
    <style>
      body{font-family:'Malgun Gothic',sans-serif;margin:24px;color:#111;font-size:12px;}
      h1{font-size:18px;} h3{font-size:14px;margin-top:18px;border-bottom:2px solid #333;padding-bottom:4px;}
      h4{font-size:12px;margin:8px 0 4px;}
      table{border-collapse:collapse;width:100%;margin:6px 0;}
      th,td{border:1px solid #999;padding:4px 6px;font-size:11px;}
      th{background:#eee;} .sum-row{background:#f6f6f6;font-weight:bold;} .grp-row{background:#e9eef5;}
      .report-narr{white-space:pre-wrap;border:1px solid #ccc;padding:8px;min-height:32px;}
      .warn{color:#a30;} .empty{color:#888;} .raw-free{white-space:pre-wrap;}
      .muted{color:#666;}
      tr{break-inside:avoid;page-break-inside:avoid;}
    </style></head><body>${bodyHtml}</body></html>`);
  w.document.close();
  w.focus();
  // onload와 보조 타이머가 둘 다 실행돼 인쇄창이 두 번 뜨지 않도록 1회 가드.
  let printed = false;
  const printOnce = () => {
    if (printed) return;
    printed = true;
    try { w.print(); } catch { /* */ }
  };
  w.onload = printOnce;
  // onload가 이미 지났을 수 있어 보조 호출(가드로 중복 방지).
  setTimeout(printOnce, 300);
}
