// =====================================================================
// 가로세로 낱말 퍼즐 판 생성기 — 한 칸에 한 글자(한글 음절).
// 참가자 앱(미션4)과 관리자 앱(저장 전 배치 확인)이 함께 쓴다.
//
// 같은 seed(행사 ID)면 언제나 같은 판이 나온다 — 같은 행사의 참가자가 모두
// 같은 문제를 풀어야 순위가 공정하다.
// =====================================================================

export const CW_MAX_SIZE = 11; // 휴대폰 세로 화면에서 칸이 너무 작아지지 않는 최대 가로·세로 칸 수

// 문자열 seed → 결정적 난수(mulberry32)
function rngFrom(seed) {
  let h = 2166136261;
  for (const ch of String(seed || "default")) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  let a = h >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffleWith(arr, rnd) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function normAnswer(s) {
  return String(s || "").replace(/\s+/g, "").trim();
}

// 판 상태(불변처럼 복제해 쓴다 — 단어가 십수 개라 복제 비용은 무시할 만하다)
const key = (r, c) => r + "," + c;
function emptyBoard() { return { cells: new Map(), placed: [], minR: 0, maxR: 0, minC: 0, maxC: 0 }; }
function cloneBoard(b) {
  const cells = new Map();
  for (const [k, v] of b.cells) cells.set(k, { ch: v.ch, dirs: new Set(v.dirs) });
  return { cells, placed: [...b.placed], minR: b.minR, maxR: b.maxR, minC: b.minC, maxC: b.maxC };
}

// 배치 가능 여부. 가능하면 교차 글자 수, 아니면 -1.
function fits(b, w, r, c, dir) {
  const chars = [...w.a];
  const dr = dir === "down" ? 1 : 0, dc = dir === "across" ? 1 : 0;
  // 앞뒤 칸은 비어 있어야(다른 단어와 이어 붙지 않게)
  if (b.cells.has(key(r - dr, c - dc)) || b.cells.has(key(r + dr * chars.length, c + dc * chars.length))) return -1;
  let cross = 0;
  for (let i = 0; i < chars.length; i++) {
    const rr = r + dr * i, cc = c + dc * i;
    const cell = b.cells.get(key(rr, cc));
    if (cell) {
      if (cell.ch !== chars[i] || cell.dirs.has(dir)) return -1;
      cross++;
    } else if (b.cells.has(key(rr + dc, cc + dr)) || b.cells.has(key(rr - dc, cc - dr))) {
      return -1; // 새 글자 옆은 비어 있어야 — 의도치 않은 낱말이 생기지 않게
    }
  }
  const nMinR = Math.min(b.minR, r), nMaxR = Math.max(b.maxR, r + dr * (chars.length - 1));
  const nMinC = Math.min(b.minC, c), nMaxC = Math.max(b.maxC, c + dc * (chars.length - 1));
  if (nMaxR - nMinR + 1 > CW_MAX_SIZE || nMaxC - nMinC + 1 > CW_MAX_SIZE) return -1;
  return cross;
}
function put(b, w, r, c, dir) {
  const chars = [...w.a];
  const dr = dir === "down" ? 1 : 0, dc = dir === "across" ? 1 : 0;
  for (let i = 0; i < chars.length; i++) {
    const k = key(r + dr * i, c + dc * i);
    const cell = b.cells.get(k) || { ch: chars[i], dirs: new Set() };
    cell.dirs.add(dir);
    b.cells.set(k, cell);
  }
  b.minR = Math.min(b.minR, r); b.maxR = Math.max(b.maxR, r + dr * (chars.length - 1));
  b.minC = Math.min(b.minC, c); b.maxC = Math.max(b.maxC, c + dc * (chars.length - 1));
  b.placed.push({ ...w, r, c, dir, len: chars.length });
}
function placementsFor(b, w) {
  const chars = [...w.a];
  const out = [];
  for (const [k, cell] of b.cells) {
    const [r0, c0] = k.split(",").map(Number);
    chars.forEach((ch, i) => {
      if (ch !== cell.ch) return;
      for (const dir of ["across", "down"]) {
        if (cell.dirs.has(dir)) continue;
        const r = dir === "down" ? r0 - i : r0, c = dir === "across" ? c0 - i : c0;
        if (fits(b, w, r, c, dir) > 0) out.push({ r, c, dir });
      }
    });
  }
  return out;
}

// 무작위 탐욕 배치를 여러 번 되풀이해 가장 좋은 판을 고른다(재시작 탐색).
// 한 번의 시도: 첫 단어를 두고, 남은 단어 중 놓을 수 있는 것을 하나씩 골라 붙인다.
// 교차가 많은 자리를 우선하되 무작위성을 섞어 시도마다 다른 판을 만든다.
function search(words, target, rnd, tries) {
  let best = null;
  const area = (b) => (b.maxR - b.minR + 1) * (b.maxC - b.minC + 1);
  for (let t = 0; t < tries; t++) {
    const order = shuffleWith(words, rnd);
    const b = emptyBoard();
    put(b, order[0], 0, 0, rnd() < 0.5 ? "across" : "down");
    let rest = order.slice(1);
    while (b.placed.length < target && rest.length) {
      const cands = [];
      for (const w of rest) {
        for (const o of placementsFor(b, w)) cands.push({ w, ...o, s: fits(b, w, o.r, o.c, o.dir) + rnd() * 1.5 });
      }
      if (!cands.length) break;
      cands.sort((x, y) => y.s - x.s);
      const pick = cands[Math.floor(rnd() * Math.min(3, cands.length))];
      put(b, pick.w, pick.r, pick.c, pick.dir);
      rest = rest.filter((x) => x !== pick.w);
    }
    if (!best || b.placed.length > best.placed.length
      || (b.placed.length === best.placed.length && area(b) < area(best))) best = b;
    if (best.placed.length >= target && t > 40) break;
  }
  return best;
}

// 판 생성: 여러 번 시도해 가장 많이 배치되고, 그다음 가장 작은 판을 고른다.
export function buildCrossword(wordList, target, seed) {
  const words = [];
  const seen = new Set();
  for (const w of wordList || []) {
    const a = normAnswer(w && w.a);
    if (!a || [...a].length < 2 || [...a].length > CW_MAX_SIZE || seen.has(a)) continue;
    seen.add(a);
    words.push({ a, clue: String(w.c || "").trim() }); // 열쇠는 clue — c는 열(칸) 좌표로 쓴다
  }
  if (words.length < 2) return null;
  const want = Math.min(target, words.length);
  const rnd = rngFrom(seed);
  const best = search(words, want, rnd, 400);
  best.rows = best.maxR - best.minR + 1; best.cols = best.maxC - best.minC + 1;
  // 좌표 정규화 + 번호 매기기(위→아래, 왼쪽→오른쪽)
  const entries = best.placed.map((p) => ({ ...p, r: p.r - best.minR, c: p.c - best.minC }));
  const starts = [...new Set(entries.map((e) => e.r * 100 + e.c))].sort((x, y) => x - y);
  entries.forEach((e) => { e.num = starts.indexOf(e.r * 100 + e.c) + 1; });
  entries.sort((x, y) => (x.dir === y.dir ? x.num - y.num : x.dir === "across" ? -1 : 1));
  return { rows: best.rows, cols: best.cols, entries, requested: want };
}
