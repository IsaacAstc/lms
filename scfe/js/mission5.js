// =====================================================================
// 미션 5: 공항 하늘 방어 — 위험물 막기 슈팅 (원작: dreamccm/air-fight)
//
// 원작의 설계 원칙을 따른다: 빌드·의존성 없음, 이미지·음원 파일 없음
// (Canvas 도형·이모지 글자 + Web Audio 합성), 세로 화면 드래그 + 자동 발사,
// 소리는 '시작하기' 조작 이후, localStorage 접근은 try/catch.
// 히어로 미션에 맞춰 바꾼 점: 끝없는 생존 → 정해진 시간(기본 90초) 한 판,
// 게임오버 없음(맞으면 감점·잠깐 무적), 점수 0~100으로 환산해 다른 미션과 합산.
//
// startMission5(onComplete, cfg) → onComplete({ score, timeMs })
// =====================================================================

const THREATS = [
  { e: "🔪", hp: 1 }, { e: "✂️", hp: 1 }, { e: "🔥", hp: 1 },
  { e: "🧪", hp: 2 }, { e: "💣", hp: 2 }, { e: "🔨", hp: 2 },
];
const SAFE = ["📱", "📖", "🧸", "👛", "🎧", "☂️"];
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

// ---------------------------------------------------------------- 점수
// 막은 위협 비율 60 + 수상한 드론 25 + 무사고 15 − 안전물품 3점씩. 끝까지 하면 최소 40점.
export function m5Score(s) {
  const ratio = s.spawned ? s.stopped / s.spawned : 0;
  const boss = s.bossMax ? 25 * (1 - Math.max(0, s.bossHp) / s.bossMax) : 0;
  const safe = Math.max(0, 15 - s.hits * 3);
  const v = Math.round(60 * ratio + boss + safe - s.safeShot * 3);
  return clamp(v, 40, 100);
}

// ---------------------------------------------------------------- 소리(Web Audio 합성)
const SOUND_KEY = "avsec_m5_sound";
let actx = null, master = null;
let soundOn = true;
try { soundOn = localStorage.getItem(SOUND_KEY) !== "0"; } catch (e) { /* 사생활 보호 모드 */ }

function initAudio() {
  if (actx) return;
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    actx = new AC();
    master = actx.createGain();
    master.gain.value = soundOn ? 0.9 : 0;
    master.connect(actx.destination);
  } catch (e) { actx = null; }
}
function tone(o) {
  if (!actx || !soundOn) return;
  const t0 = o.time ?? actx.currentTime, dur = o.dur ?? 0.12;
  const osc = actx.createOscillator(), g = actx.createGain();
  osc.type = o.type || "square";
  osc.frequency.setValueAtTime(o.freq, t0);
  if (o.slideTo) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.slideTo), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(o.vol ?? 0.04, t0 + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g); g.connect(master);
  osc.start(t0); osc.stop(t0 + dur + 0.02);
}
const seq = (notes, type, vol, gap, dur) => {
  if (!actx) return;
  notes.forEach((f, i) => tone({ freq: f, type, vol, dur, time: actx.currentTime + i * gap }));
};
const SFX = {
  shoot: () => tone({ freq: 1250, slideTo: 800, dur: 0.05, vol: 0.012 }),
  pop: () => tone({ freq: 420, slideTo: 140, dur: 0.18, type: "triangle", vol: 0.06 }),
  wrong: () => seq([330, 247], "sawtooth", 0.05, 0.12, 0.16),
  hurt: () => tone({ freq: 300, slideTo: 90, dur: 0.3, type: "sawtooth", vol: 0.06 }),
  item: () => seq([659, 880, 1175], "square", 0.03, 0.05, 0.12),
  warn: () => seq([220, 220, 196], "sawtooth", 0.06, 0.22, 0.3),
  win: () => seq([523, 659, 784, 1047], "square", 0.04, 0.09, 0.18),
};
function sfx(n) { try { SFX[n] && SFX[n](); } catch (e) { /* 소리 실패는 게임을 막지 않는다 */ } }
function setSound(on) {
  soundOn = on;
  try { localStorage.setItem(SOUND_KEY, on ? "1" : "0"); } catch (e) { /* 무시 */ }
  if (master) master.gain.value = on ? 0.9 : 0;
}

// ---------------------------------------------------------------- 게임
export function startMission5(onComplete, cfg = {}) {
  const screen = document.getElementById("screen-m5");
  const canvas = document.getElementById("m5-canvas");
  const soundBtn = document.getElementById("m5-sound");
  const ctx = canvas.getContext("2d");
  const DURATION = clamp(Number(cfg.durationSec) || 90, 30, 300);
  const BOSS_AT = Math.max(10, DURATION - 20); // 마지막 20초에 수상한 드론

  let W = 0, H = 0, DPR = 1;
  function resize() {
    const r = screen.getBoundingClientRect();
    DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = Math.max(280, r.width); H = Math.max(420, r.height);
    canvas.style.width = W + "px"; canvas.style.height = H + "px";
    canvas.width = Math.floor(W * DPR); canvas.height = Math.floor(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  resize();
  window.addEventListener("resize", resize);

  initAudio();
  if (actx && actx.state === "suspended") actx.resume();
  const paintSound = () => { soundBtn.textContent = soundOn ? "🔊" : "🔇"; };
  paintSound();
  soundBtn.onclick = (ev) => { ev.stopPropagation(); setSound(!soundOn); paintSound(); };

  const p = { x: W / 2, y: H - 110, r: 18, power: 1, shield: 0, inv: 1.2, fireCd: 0 };
  const st = { spawned: 0, stopped: 0, hits: 0, safeShot: 0, bossHp: 0, bossMax: 0 };
  const bullets = [], drops = [], items = [], parts = [], texts = [];
  let boss = null, bossDone = false, t = 0, spawnT = 0.6, safeT = 3, last = performance.now(), raf = 0, ended = false, shake = 0;

  // 활주로 불빛(배경)
  const lights = Array.from({ length: 26 }, (_, i) => ({ y: (i / 26) * 1400, side: i % 2 }));

  // 조작: 화면 어디든 끌면 그만큼 움직인다(손가락이 기체를 가리지 않게)
  let drag = null;
  const pos = (ev) => { const r = canvas.getBoundingClientRect(); const s = ev.touches ? ev.touches[0] : ev; return { x: s.clientX - r.left, y: s.clientY - r.top }; };
  const down = (ev) => { ev.preventDefault(); const q = pos(ev); drag = { sx: q.x, sy: q.y, px: p.x, py: p.y }; };
  const move = (ev) => {
    if (!drag) return; ev.preventDefault();
    const q = pos(ev);
    p.x = clamp(drag.px + (q.x - drag.sx) * 1.2, 20, W - 20);
    p.y = clamp(drag.py + (q.y - drag.sy) * 1.2, H * 0.35, H - 40);
  };
  const up = () => { drag = null; };
  canvas.addEventListener("touchstart", down, { passive: false });
  canvas.addEventListener("touchmove", move, { passive: false });
  canvas.addEventListener("touchend", up);
  canvas.addEventListener("mousedown", down);
  window.addEventListener("mousemove", move);
  window.addEventListener("mouseup", up);

  function burst(x, y, color, n = 12) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.28, v = rand(60, 220);
      parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: rand(0.3, 0.7), color });
    }
  }
  function say(x, y, msg, color) { texts.push({ x, y, msg, color, life: 1 }); }

  function spawn() {
    const k = THREATS[Math.floor(Math.random() * THREATS.length)];
    st.spawned++;
    drops.push({ kind: "threat", e: k.e, hp: k.hp, x: rand(28, W - 28), y: -30, r: 20, vy: rand(55, 85) + t * 0.35, vx: rand(-20, 20) });
  }
  function spawnSafe() {
    drops.push({ kind: "safe", e: SAFE[Math.floor(Math.random() * SAFE.length)], hp: 1, x: rand(28, W - 28), y: -30, r: 20, vy: rand(50, 70), vx: 0 });
  }
  function spawnBoss() {
    const hp = 26 + p.power * 6;
    boss = { x: W / 2, y: -60, r: 42, hp, max: hp, vx: 70, enter: true, dropT: 2.5, hit: 0 };
    st.bossHp = hp; st.bossMax = hp;
    say(W / 2, H * 0.3, "⚠ 수상한 드론 접근!", "#ffb020");
    sfx("warn");
  }
  function hurt() {
    if (p.inv > 0) return;
    if (p.shield > 0) { p.shield = 0; p.inv = 0.8; say(p.x, p.y - 30, "실드 방어!", "#7dd3fc"); sfx("item"); return; }
    st.hits++; p.inv = 1.4; shake = 10;
    say(p.x, p.y - 30, "앗!", "#ff6b6b"); sfx("hurt");
    burst(p.x, p.y, "#ff9d5c", 14);
  }
  function pick(it) {
    if (it.kind === "power") { p.power = Math.min(3, p.power + 1); say(it.x, it.y, "스캔 빔 강화!", "#60a5fa"); }
    else if (it.kind === "shield") { p.shield = 1; say(it.x, it.y, "X-ray 실드!", "#7dd3fc"); }
    else { // 화면의 위협을 한 번에 정리
      for (const d of drops) if (d.kind === "threat") { st.stopped++; burst(d.x, d.y, "#ffd166", 10); }
      for (let i = drops.length - 1; i >= 0; i--) if (drops[i].kind === "threat") drops.splice(i, 1);
      if (boss) { boss.hp -= 8; boss.hit = 0.2; }
      say(W / 2, H * 0.45, "보안검색 완료!", "#ffd166"); shake = 8;
    }
    sfx("item");
  }

  function update(dt) {
    t += dt;
    if (p.inv > 0) p.inv -= dt;
    // 자동 발사(보안 스캔 빔)
    p.fireCd -= dt;
    if (p.fireCd <= 0) {
      p.fireCd = 0.2;
      const shot = (vx, ox) => bullets.push({ x: p.x + ox, y: p.y - 22, vx, vy: -560 });
      if (p.power === 1) shot(0, 0);
      else if (p.power === 2) { shot(0, -8); shot(0, 8); }
      else { shot(0, 0); shot(-110, -8); shot(110, 8); }
      sfx("shoot");
    }
    // 생성: 초등 3학년 기준으로 느리고 성기게
    spawnT -= dt;
    if (t < BOSS_AT + 2 && spawnT <= 0) { spawn(); spawnT = Math.max(0.75, 1.3 - t * 0.008); }
    safeT -= dt;
    if (safeT <= 0) { spawnSafe(); safeT = rand(4, 7); }
    if (!boss && !bossDone && t >= BOSS_AT) spawnBoss();

    for (let i = bullets.length - 1; i >= 0; i--) {
      const b = bullets[i];
      b.x += b.vx * dt; b.y += b.vy * dt;
      if (b.y < -20 || b.x < -20 || b.x > W + 20) { bullets.splice(i, 1); continue; }
      let used = false;
      for (let j = drops.length - 1; j >= 0 && !used; j--) {
        const d = drops[j];
        if (Math.hypot(d.x - b.x, d.y - b.y) < d.r + 4) {
          used = true;
          if (d.kind === "safe") {
            st.safeShot++; drops.splice(j, 1);
            say(d.x, d.y, "안전물품이에요! −3", "#ff8fa3"); sfx("wrong");
          } else if (--d.hp <= 0) {
            st.stopped++; drops.splice(j, 1);
            burst(d.x, d.y, "#ffd166"); say(d.x, d.y, "압수!", "#ffd166"); sfx("pop");
            if (Math.random() < 0.14) items.push({ x: d.x, y: d.y, kind: ["power", "shield", "clear"][Math.floor(Math.random() * 3)], vy: 80 });
          }
        }
      }
      if (!used && boss && !boss.enter && Math.hypot(boss.x - b.x, boss.y - b.y) < boss.r) {
        used = true; boss.hp--; boss.hit = 0.08;
        if (boss.hp <= 0) {
          burst(boss.x, boss.y, "#ffd166", 40); say(boss.x, boss.y, "드론 퇴치!", "#4ade80");
          st.bossHp = 0; boss = null; bossDone = true; sfx("win"); shake = 14;
        }
      }
      if (used) bullets.splice(i, 1);
    }
    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      d.x += d.vx * dt; d.y += d.vy * dt;
      if (d.x < 20 || d.x > W - 20) d.vx *= -1;
      if (d.kind === "threat" && Math.hypot(d.x - p.x, d.y - p.y) < d.r + p.r - 6) { drops.splice(i, 1); hurt(); continue; }
      if (d.y > H + 30) drops.splice(i, 1); // 놓친 위협은 감점 없이 비율에만 반영
    }
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      it.y += it.vy * dt;
      if (Math.hypot(it.x - p.x, it.y - p.y) < p.r + 16) { items.splice(i, 1); pick(it); continue; }
      if (it.y > H + 20) items.splice(i, 1);
    }
    if (boss) {
      if (boss.enter) { boss.y += 60 * dt; if (boss.y >= 110) boss.enter = false; }
      else {
        boss.x += boss.vx * dt;
        if (boss.x < 60 || boss.x > W - 60) boss.vx *= -1;
        boss.dropT -= dt;
        if (boss.dropT <= 0) { // 가끔 느린 위협만 떨어뜨린다(탄막 없음)
          boss.dropT = 2.2;
          st.spawned++;
          drops.push({ kind: "threat", e: "💣", hp: 1, x: boss.x, y: boss.y + 30, r: 20, vy: 70, vx: 0 });
        }
      }
      if (boss.hit > 0) boss.hit -= dt;
      st.bossHp = boss.hp;
    }
    for (let i = parts.length - 1; i >= 0; i--) {
      const q = parts[i]; q.x += q.vx * dt; q.y += q.vy * dt; q.life -= dt;
      if (q.life <= 0) parts.splice(i, 1);
    }
    for (let i = texts.length - 1; i >= 0; i--) { texts[i].y -= 30 * dt; texts[i].life -= dt; if (texts[i].life <= 0) texts.splice(i, 1); }
    if (shake > 0) shake = Math.max(0, shake - 40 * dt);
    if (t >= DURATION) end();
  }

  // ---------------------------------------------------------------- 그리기
  function drawDrone(x, y) {
    ctx.save(); ctx.translate(x, y);
    if (p.inv > 0 && Math.floor(t * 12) % 2) ctx.globalAlpha = 0.45;
    // 프로펠러 팔
    ctx.strokeStyle = "#9fb3c8"; ctx.lineWidth = 3;
    [[-16, -10], [16, -10], [-16, 12], [16, 12]].forEach(([dx, dy]) => {
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(dx, dy); ctx.stroke();
      ctx.fillStyle = "rgba(200,230,255,.55)";
      ctx.beginPath(); ctx.ellipse(dx, dy, 9, 2.5, (t * 30) % 6.28, 0, 6.28); ctx.fill();
    });
    // 방패 모양 몸체
    ctx.fillStyle = "#2f6fd0";
    ctx.beginPath(); ctx.moveTo(0, -16); ctx.lineTo(13, -9); ctx.lineTo(11, 7); ctx.lineTo(0, 16); ctx.lineTo(-11, 7); ctx.lineTo(-13, -9); ctx.closePath(); ctx.fill();
    ctx.fillStyle = "#eaf4ff"; ctx.font = "bold 11px sans-serif"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("AV", 0, 0);
    if (p.shield) { ctx.strokeStyle = "rgba(125,211,252,.85)"; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(0, 0, 26, 0, 6.28); ctx.stroke(); }
    ctx.restore();
  }
  function drawBoss(b) {
    ctx.save(); ctx.translate(b.x, b.y);
    ctx.fillStyle = b.hit > 0 ? "#fff" : "#3b3f4a";
    ctx.fillRect(-28, -12, 56, 24);
    ctx.strokeStyle = "#6b7280"; ctx.lineWidth = 5;
    [[-40, -22], [40, -22], [-40, 22], [40, 22]].forEach(([dx, dy]) => {
      ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(dx, dy); ctx.stroke();
      ctx.fillStyle = "rgba(255,255,255,.4)";
      ctx.beginPath(); ctx.ellipse(dx, dy, 16, 4, (t * 25) % 6.28, 0, 6.28); ctx.fill();
    });
    ctx.fillStyle = "#ff4757"; ctx.beginPath(); ctx.arc(0, 0, 6 + Math.sin(t * 8) * 2, 0, 6.28); ctx.fill();
    ctx.restore();
    const bw = Math.min(W - 60, 300), bx = (W - bw) / 2;
    ctx.fillStyle = "rgba(0,0,0,.5)"; ctx.fillRect(bx, 70, bw, 9);
    ctx.fillStyle = "#ff4d6d"; ctx.fillRect(bx, 70, bw * Math.max(0, b.hp / b.max), 9);
    ctx.fillStyle = "#ffd0d8"; ctx.font = "bold 12px sans-serif"; ctx.textAlign = "center"; ctx.fillText("수상한 드론", W / 2, 63);
  }
  const ITEM_LABEL = { power: "⚡", shield: "🛡️", clear: "🔍" };
  function render() {
    ctx.save();
    if (shake) ctx.translate(rand(-shake, shake) * 0.4, rand(-shake, shake) * 0.4);
    // 밤 공항 하늘 + 관제탑 실루엣 + 활주로 불빛
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#071226"); g.addColorStop(1, "#13284a");
    ctx.fillStyle = g; ctx.fillRect(-20, -20, W + 40, H + 40);
    ctx.fillStyle = "#0b1a33";
    ctx.fillRect(W * 0.08, H - 150, 14, 150); ctx.fillRect(W * 0.08 - 12, H - 168, 38, 18);
    ctx.fillStyle = "#1d3b66"; ctx.fillRect(W * 0.08 - 9, H - 164, 32, 8);
    for (const l of lights) {
      const y = (l.y + t * 120) % 1400 - 100;
      ctx.fillStyle = l.side ? "rgba(255,200,80,.5)" : "rgba(120,200,255,.45)";
      ctx.beginPath(); ctx.arc(l.side ? W * 0.3 : W * 0.7, y, 2.5, 0, 6.28); ctx.fill();
    }
    ctx.fillStyle = "#7dd3fc";
    for (const b of bullets) ctx.fillRect(b.x - 2, b.y - 8, 4, 14);
    ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.font = "30px sans-serif";
    for (const d of drops) {
      if (d.kind === "safe") { ctx.fillStyle = "rgba(74,222,128,.18)"; ctx.beginPath(); ctx.arc(d.x, d.y, 22, 0, 6.28); ctx.fill(); }
      else { ctx.fillStyle = "rgba(255,71,87,.18)"; ctx.beginPath(); ctx.arc(d.x, d.y, 22, 0, 6.28); ctx.fill(); }
      ctx.fillText(d.e, d.x, d.y);
    }
    ctx.font = "24px sans-serif";
    for (const it of items) {
      ctx.fillStyle = "rgba(255,255,255,.2)"; ctx.beginPath(); ctx.arc(it.x, it.y, 16, 0, 6.28); ctx.fill();
      ctx.fillText(ITEM_LABEL[it.kind], it.x, it.y);
    }
    if (boss) drawBoss(boss);
    drawDrone(p.x, p.y);
    for (const q of parts) { ctx.globalAlpha = Math.max(0, q.life * 1.6); ctx.fillStyle = q.color; ctx.fillRect(q.x - 2, q.y - 2, 4, 4); }
    ctx.globalAlpha = 1;
    ctx.font = "bold 16px sans-serif";
    for (const x of texts) { ctx.globalAlpha = Math.max(0, x.life); ctx.fillStyle = x.color; ctx.fillText(x.msg, x.x, x.y); }
    ctx.globalAlpha = 1;
    ctx.restore();
    // HUD
    const left = Math.max(0, Math.ceil(DURATION - t));
    ctx.fillStyle = "rgba(0,0,0,.35)"; ctx.fillRect(0, 0, W, 48);
    ctx.fillStyle = "#fff"; ctx.font = "bold 15px sans-serif"; ctx.textBaseline = "middle";
    ctx.textAlign = "left"; ctx.fillText(`🛡️ 막은 위협 ${st.stopped}`, 12, 24);
    ctx.textAlign = "center"; ctx.fillStyle = left <= 10 ? "#ff6b6b" : "#ffb020"; ctx.fillText(`⏱ ${left}초`, W / 2, 24);
  }

  function frame(now) {
    if (ended) return;
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    update(dt);
    if (!ended) { render(); raf = requestAnimationFrame(frame); }
  }
  function end() {
    if (ended) return;
    ended = true;
    cancelAnimationFrame(raf);
    window.removeEventListener("resize", resize);
    window.removeEventListener("mousemove", move);
    window.removeEventListener("mouseup", up);
    canvas.removeEventListener("touchstart", down);
    canvas.removeEventListener("touchmove", move);
    canvas.removeEventListener("touchend", up);
    canvas.removeEventListener("mousedown", down);
    soundBtn.onclick = null;
    render();
    onComplete({ score: m5Score(st), timeMs: Math.round(t * 1000) });
  }
  raf = requestAnimationFrame((n) => { last = n; frame(n); });
}
