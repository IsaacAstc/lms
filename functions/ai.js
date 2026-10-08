// AI(LLM) 연동 — 주관식 원문 분석.
//
// ■ 모델 비종속 구조
//   특정 모델·회사 SDK를 쓰지 않고 'OpenAI 호환 Chat Completions' 규격 하나로만 호출한다.
//   이 규격은 Ollama·vLLM·LM Studio(자체 구축), OpenRouter, Upstage(Solar), HyperCLOVA X
//   (CLOVA Studio OpenAI 호환 API), 행정안전부 AI 공통기반 등 대부분이 지원한다.
//   → 모델 교체 = 관리자 화면에서 '접속 주소(baseUrl) + 모델명 + 키'만 바꾸면 끝(코드·배포 불필요).
//
// ■ 개인정보
//   설문은 익명이지만 주관식에 이름·연락처를 적는 경우가 있다. LLM으로 보내기 전에
//   서버에서 가림 처리하고(원문은 함수 밖으로 나가지 않는다), 화면에는 '보낸 그대로'를 보여준다.
//   실행 기록(aiRuns)에는 원문·가림본 모두 남기지 않고 모델·소요시간·결과만 남긴다.
//
// ■ 키 관리
//   API 키는 aiKeys/{providerId}에 두며 보안규칙상 클라이언트가 읽을 수 없다(쓰기는 마스터만).
//   함수만 Admin SDK로 읽어 쓴다.
//
// ■ 사람 검토
//   함수는 분석 결과를 '돌려주기만' 한다. 분류 반영·시사점 저장은 관리자가 화면에서 확인 후 적용한다.

const CALL_TIMEOUT_MS = 90 * 1000;
const MAX_ITEMS = 400;          // 한 달 주관식 상한(초과분은 분석 제외 — 화면에 표시)
const CLASSIFY_CHUNK = 60;      // 분류 요청 1회당 원문 수(소형 모델 컨텍스트 고려)
const SUMMARY_SAMPLE = 120;     // 시사점 작성에 보낼 원문 수
const MAX_TEXT = 300;           // 원문 1건 최대 길이(초과분 자름)

// ── 개인정보 가림 ──
// 직함·호칭 앞 이름으로 볼 수 없는 일반 명사(오탐 방지).
const NOT_NAME = new Set([
  "강사", "교수", "교관", "선생", "담당", "담당자", "직원", "교육생", "수강생", "관리자", "센터",
  "운영", "부서", "팀", "과", "본부", "공항", "기관", "모든", "여러", "외부", "내부", "전임",
  "사내", "사외", "현장", "초빙", "주강사", "보조", "모두", "다른", "해당",
]);
const TITLES = "강사|교수|교관|선생|팀장|과장|부장|차장|대리|주임|실장|센터장|님|씨";

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// knownNames: 강사 마스터 등에서 가져온 실명 목록(정확히 일치하면 무조건 가림).
function maskPII(text, knownNames = []) {
  let t = String(text || "");
  let n = 0;
  const sub = (re, rep) => { t = t.replace(re, (...m) => { n++; return typeof rep === "function" ? rep(...m) : rep; }); };
  sub(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[이메일]");
  sub(/\b\d{6}\s*-\s*[1-4]\d{6}\b/g, "[주민번호]");
  sub(/(?:\+?82[-\s]?)?0\d{1,2}[-\s.)]?\d{3,4}[-\s.]?\d{4}/g, "[전화번호]");
  for (const nm of knownNames) {
    if (nm && nm.length >= 2) sub(new RegExp(escapeRe(nm), "g"), "[이름]");
  }
  sub(new RegExp(`([가-힣]{2,4})(\\s?)(${TITLES})`, "g"), (m, name, sp, title) =>
    (NOT_NAME.has(name) || name.endsWith("강사") ? (n--, m) : `[이름]${sp}${title}`));
  return { text: t, count: n };
}

// ── OpenAI 호환 호출 ──
function normBaseUrl(u) { return String(u || "").trim().replace(/\/+$/, "").replace(/\/chat\/completions$/, ""); }

async function chatOnce(provider, key, messages, { json = true, maxTokens = 2000 } = {}) {
  const url = `${normBaseUrl(provider.baseUrl)}/chat/completions`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CALL_TIMEOUT_MS);
  const headers = { "Content-Type": "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  const body = { model: provider.model, messages, temperature: 0.2, max_tokens: maxTokens };
  // response_format 은 지원하지 않는 서버가 있어 기본으로 보내지 않는다(provider.jsonMode 로 선택).
  if (json && provider.jsonMode) body.response_format = { type: "json_object" };
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal: ctrl.signal });
  } catch (e) {
    throw new Error(e.name === "AbortError" ? `응답 시간 초과(${CALL_TIMEOUT_MS / 1000}초)` : `접속 실패: ${e.message}`);
  } finally { clearTimeout(timer); }
  const raw = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw.slice(0, 300)}`);
  let data;
  try { data = JSON.parse(raw); } catch { throw new Error(`응답이 JSON이 아닙니다: ${raw.slice(0, 200)}`); }
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== "string") throw new Error(`응답 형식이 OpenAI 호환 규격과 다릅니다: ${raw.slice(0, 200)}`);
  return { content, ms: Date.now() - t0, usage: data.usage || null, servedModel: data.model || provider.model };
}

// 모델 자동 대체: 기본 모델이 실패하면(혼잡 429·서버 오류·시간 초과·접속 실패 등)
// 등록된 다른 모델로 차례로 다시 시도한다. provider._fallbacks 는 loadProvider 가 채운다.
async function chat(provider, key, messages, opts = {}) {
  try {
    return await chatOnce(provider, key, messages, opts);
  } catch (e) {
    const fbs = provider._fallbacks || [];
    let last = e;
    for (const fb of fbs) {
      try {
        const r = await chatOnce(fb.provider, fb.key, messages, opts);
        return { ...r, fallbackFrom: provider.name || provider.model, fallbackTo: fb.provider.name || fb.provider.model,
          fallbackReason: String(e.message || e).slice(0, 120) };
      } catch (e2) { last = e2; }
    }
    if (fbs.length) throw new Error(`${e.message} (대체 모델 ${fbs.length}개도 실패: ${String(last.message || last).slice(0, 120)})`);
    throw e;
  }
}

// 모델마다 JSON을 코드펜스로 감싸거나 앞뒤 설명을 붙이는 버릇이 달라 관대하게 꺼낸다.
function extractJson(s) {
  let t = String(s || "").trim();
  t = t.replace(/<think>[\s\S]*?<\/think>/gi, "").trim(); // 추론형 모델의 사고 과정 제거
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) t = fence[1].trim();
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("모델 응답에서 JSON을 찾지 못했습니다.");
  return JSON.parse(t.slice(a, b + 1));
}

// ── 프롬프트 ──
function classifyMessages(categories, items) {
  return [
    { role: "system", content:
      "너는 공공기관 교육 만족도 설문의 주관식 응답을 분류하는 보조자다. " +
      "반드시 주어진 분류 목록 중 하나만 고른다. 목록에 없는 분류를 만들지 않는다. " +
      "의미 없는 응답(예: '없음', '-', '감사합니다')은 '기타'가 목록에 있으면 '기타'로 분류한다. " +
      "출력은 JSON 하나만: {\"items\":[{\"i\":번호,\"cat\":\"분류\"}]} — 설명·코드펜스 금지." },
    { role: "user", content:
      `분류 목록: ${JSON.stringify(categories)}\n\n` +
      `응답(번호|종류|과정|내용):\n${items.map((x) => `${x.i}|${x.kind}|${x.course}|${x.text}`).join("\n")}` },
  ];
}

function summaryMessages(month, counts, samples) {
  return [
    { role: "system", content:
      "너는 공공기관 교육훈련센터의 운영 결과 보고서 작성을 돕는다. " +
      "주관식 응답을 근거로 [시사점]과 [피드백 반영계획] 초안을 쓴다. " +
      "규칙: 개인·특정 강사를 지목하지 않는다. 응답에 없는 사실을 지어내지 않는다. " +
      "시사점은 3~5개 항목, 반영계획은 시사점에 대응하는 실행 가능한 조치 3~5개. 각 항목은 한 문장, '- '로 시작. " +
      "출력은 JSON 하나만: {\"summary\":\"...\",\"action\":\"...\"} — 각 값은 줄바꿈(\\n)으로 항목 구분, 코드펜스 금지." },
    { role: "user", content:
      `대상 기간: ${month}\n분류별 건수: ${JSON.stringify(counts)}\n\n` +
      `주관식 응답(종류|과정|내용):\n${samples.map((x) => `${x.kind}|${x.course}|${x.text}`).join("\n")}` },
  ];
}

function reportMessages(month, metrics, samples) {
  return [
    { role: "system", content:
      "너는 공공기관 교육훈련센터의 월간 '교육 운영 결과 보고서' 작성을 돕는다. " +
      "주어진 지표(JSON)와 주관식 응답을 근거로 [총평]·[시사점]·[피드백 반영계획] 초안을 쓴다.\n" +
      "규칙:\n" +
      "1) 숫자는 지표 JSON에 있는 값만 그대로 쓴다. 새로 계산하거나 반올림을 바꾸거나 추정하지 않는다(증감도 지표의 delta 값만).\n" +
      "2) 개인·특정 강사를 지목하지 않는다. 지표·응답에 없는 사실을 지어내지 않는다.\n" +
      "3) 총평은 3~5문장의 한 단락(전반 만족도 수준, 전월 대비 변화, 눈에 띄는 과정·항목, 운영 실적).\n" +
      "4) 시사점 3~5개, 반영계획은 시사점에 대응하는 실행 가능한 조치 3~5개. 각 항목은 한 문장, '- '로 시작.\n" +
      "출력은 JSON 하나만: {\"overview\":\"...\",\"summary\":\"...\",\"action\":\"...\"} — 항목 구분은 줄바꿈(\\n), 코드펜스 금지." },
    { role: "user", content:
      `대상 기간: ${month}\n지표(JSON):\n${JSON.stringify(metrics)}\n\n` +
      `주관식 응답(종류|과정|내용):\n${samples.map((x) => `${x.kind}|${x.course}|${x.text}`).join("\n") || "(없음)"}` },
  ];
}

// 초안 속 숫자가 지표에 실제로 있는지 대조(모델의 숫자 지어내기 감지).
// 날짜·월(2026, 09 등)·항목 번호 같은 작은 정수는 오탐이 많아 제외한다.
function numbersIn(text) {
  return (String(text || "").match(/\d[\d,]*(?:\.\d+)?/g) || []).map((x) => x.replace(/,/g, ""));
}
function unverifiedNumbers(texts, metrics, month) {
  const known = new Set();
  const walk = (v) => {
    if (typeof v === "number" && Number.isFinite(v)) {
      known.add(String(v));
      known.add(String(Math.round(v)));
      known.add(v.toFixed(1)); known.add(v.toFixed(2));
      known.add(String(Math.abs(v))); known.add(Math.abs(v).toFixed(1)); known.add(Math.abs(v).toFixed(2));
    } else if (typeof v === "string") numbersIn(v).forEach((n) => known.add(n));
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(metrics);
  const [y, m] = month.split("-");
  [y, m, String(Number(m))].forEach((n) => known.add(n));
  const out = new Set();
  for (const t of texts) for (const n of numbersIn(t)) {
    const num = Number(n);
    if (!Number.isFinite(num) || (Number.isInteger(num) && num <= 12)) continue;
    if (!known.has(n) && !known.has(String(num))) out.add(n);
  }
  return [...out];
}

function actionMessages(categories, actionText) {
  return [
    { role: "system", content:
      "너는 교육 운영 개선 조치를 정리하는 보조자다. 피드백 반영계획 글에서 '실행할 조치'만 뽑아 각각 하나의 분류를 붙인다.\n" +
      "규칙: 1) 조치는 글에 있는 내용만, 한 문장(30자 안팎)으로 다듬는다. 새 조치를 지어내지 않는다. " +
      "2) 분류는 반드시 주어진 목록 중 하나. 3) 같은 조치를 중복해 뽑지 않는다. " +
      "출력은 JSON 하나만: {\"actions\":[{\"action\":\"...\",\"category\":\"...\"}]} — 코드펜스 금지." },
    { role: "user", content: `분류 목록: ${JSON.stringify(categories)}\n\n피드백 반영계획:\n${actionText}` },
  ];
}

// 공문·안내문 초안. 사실(facts)은 화면이 데이터로 만들어 넘기고, 모델은 문장만 쓴다.
const DOC_KINDS = {
  dispatch: { label: "출강 요청 공문", guide:
    "한 소속기관(affiliation)에 보내는 그 달 출강 요청 공문(그 기관 강사들의 일정을 한 문서로). 구성: 제목, 1. 관련, " +
    "2. 요청 취지(대상 월, 과정 교육을 위한 강사 출강 요청), 3. 출강 일정(강사별로 묶어 일자·시간·과정명·차수·과목·강의실을 항목으로), " +
    "4. 협조 요청(강의자료 사전 송부 등 일반 문구), '끝.'. 강사 이름은 자료의 강사 표기(○○○ 강사A 등)를 그대로 쓴다." },
  notice: { label: "교육 안내 공문", guide:
    "교육 대상 기관에 보내는 그 달 교육 실시 안내 공문. 구성: 제목, 1. 관련, 2. 교육 개요(대상 월), " +
    "3. 교육 일정(과정별로 과정명·차수·기간·장소·정원·주요 과목을 항목으로), 4. 협조 사항(대상자 선발·입과 안내 등 일반 문구), '끝.'." },
  result: { label: "결과 보고 본문", guide:
    "내부 결재용 월간 교육 결과 보고 본문. 구성: 제목, 1. 교육 개요(대상 월, 운영 차수 수), 2. 운영 결과(과정별 정원·신청·이수 인원과 합계 — 자료의 totals 값 그대로), " +
    "3. 만족도 결과(자료에 있는 과정만, 100점 환산값 그대로), 4. 향후 조치(일반 문구 1~2개). " +
    "만족도 응답자가 10명 미만인 과정은 '응답 표본이 적어 참고용'임을 밝힌다." },
};
function docMessages(kind, facts) {
  const k = DOC_KINDS[kind];
  return [
    { role: "system", content:
      `너는 한국 공공기관(교육훈련센터)의 ${k.label} 초안 작성을 돕는다. 공문서 문체(개조식, '~함', '~바람', 날짜는 2026. 10. 6. 형식)를 쓴다.\n` +
      `${k.guide}\n` +
      "규칙: 1) 일자·시간·인원·점수 등 사실은 주어진 자료(JSON)에 있는 것만 그대로 쓴다. 없는 사실(연락처·담당자·문서번호·예산 등)은 지어내지 말고 '○○○' 자리로 둔다. " +
      "2) 개인 식별정보를 쓰지 않는다. " +
      "출력은 JSON 하나만: {\"title\":\"제목\",\"body\":\"본문(줄바꿈 \\n)\"} — 코드펜스 금지." },
    { role: "user", content: `자료(JSON):\n${JSON.stringify(facts)}` },
  ];
}

module.exports = function makeAi({ db, onCall, HttpsError, requireAdmin, onSchedule, mail }) {
  async function loadProvider(providerId, { fallback = true } = {}) {
    const cfg = (await db.doc("settings/ai").get()).data() || {};
    const list = Array.isArray(cfg.providers) ? cfg.providers : [];
    const id = providerId || cfg.defaultId || list[0]?.id;
    const p = list.find((x) => x.id === id);
    if (!p) throw new HttpsError("failed-precondition", "AI 연결이 설정되지 않았습니다. 설정 → AI 연결에서 모델을 등록하세요.");
    if (!p.baseUrl || !p.model) throw new HttpsError("failed-precondition", `'${p.name || p.id}'의 접속 주소·모델명이 비어 있습니다.`);
    const k = await db.doc(`aiKeys/${p.id}`).get();
    const provider = { ...p };
    // 자동 대체(설정에서 끌 수 있음 — 기본 켬): 나머지 등록 모델을 순서대로 예비로 둔다.
    if (fallback && cfg.autoFallback !== false) {
      const others = list.filter((x) => x.id !== p.id && x.baseUrl && x.model);
      const keys = await Promise.all(others.map((x) => db.doc(`aiKeys/${x.id}`).get()));
      provider._fallbacks = others.map((x, i) => ({ provider: x, key: keys[i].exists ? String(keys[i].data().key || "") : "" }));
    }
    return { provider, key: k.exists ? String(k.data().key || "") : "" };
  }

  // 그 달 주관식을 모아 가림 처리한다(원문은 이 함수 밖으로 나가지 않는다).
  async function collectFreetext(month) {
    const [snap, catDoc, instSnap, courseSnap] = await Promise.all([
      db.collection("surveyResponses").where("collectedDate", ">=", `${month}-01`).where("collectedDate", "<=", `${month}-31`).get(),
      db.doc("settings/surveyCategories").get(),
      db.collection("instructors").get(),
      db.collection("courses").get(),
    ]);
    const categories = (catDoc.exists && Array.isArray(catDoc.data().list) && catDoc.data().list.length)
      ? catDoc.data().list.map(String)
      : ["현업 활용", "강의 방식", "교재/자료", "시설/환경", "운영/진행", "기타"];
    const knownNames = instSnap.docs.map((d) => String(d.data().name || "").trim()).filter((n) => n.length >= 2);
    const courseName = Object.fromEntries(courseSnap.docs.map((d) => [d.id, String(d.data().name || "")]));

    // 분석 대상: 분류 칸이 있는 불만족·제안개선(분류 대상) + 그 밖의 주관식(시사점 참고용).
    const items = [];
    let masked = 0;
    for (const d of snap.docs) {
      const r = d.data();
      const course = courseName[r.courseId] || "-";
      const add = (kind, field, raw) => {
        if (!raw || !String(raw).trim()) return;
        const m = maskPII(String(raw).slice(0, MAX_TEXT), knownNames);
        masked += m.count;
        items.push({ rid: d.id, field, kind, course, text: m.text.replace(/\s+/g, " ").trim() });
      };
      add("불만족", "catDissatisfied", r.freeDissatisfied);
      add("제안개선", "catSuggestion", r.freeSuggestion);
      for (const t of r.freeExtra || []) add("추가주관식", "", t?.text);
      for (const t of r.fuTexts || []) add("조건부", "", t?.text);
    }
    return { items, masked, categories };
  }

  async function logRun(doc) {
    try { await db.collection("aiRuns").add({ ...doc, at: Date.now() }); } catch { /* 기록 실패는 무시 */ }
  }

  // 연결 테스트: 짧은 질문 1회 + JSON 응답 확인.
  const aiTestProvider = onCall(
    { region: "asia-northeast3", memory: "256MiB", timeoutSeconds: 120, maxInstances: 3 },
    async (req) => {
      const email = await requireAdmin(req, "settings");
      const { provider, key } = await loadProvider(String(req.data?.providerId || ""), { fallback: false });
      try {
        const r = await chat(provider, key, [
          { role: "system", content: "JSON 하나만 출력한다. 코드펜스 금지." },
          { role: "user", content: "다음 형식으로 답하라: {\"ok\":true,\"model\":\"너의 모델 이름\",\"hello\":\"한국어 인사 한 문장\"}" },
        ], { maxTokens: 200 });
        const parsed = (() => { try { return extractJson(r.content); } catch { return null; } })();
        await logRun({ kind: "test", by: email, providerId: provider.id, providerName: provider.name || "", model: provider.model, servedModel: r.servedModel, ok: true, elapsedMs: r.ms });
        return { ok: true, elapsedMs: r.ms, servedModel: r.servedModel, jsonOk: !!parsed, reply: r.content.slice(0, 300) };
      } catch (e) {
        await logRun({ kind: "test", by: email, providerId: provider.id, providerName: provider.name || "", model: provider.model, ok: false, error: String(e.message).slice(0, 300) });
        return { ok: false, error: String(e.message) };
      }
    });

  // 주관식 원문 분석: 가림 처리 → 분류 → 시사점·반영계획 초안. 저장은 하지 않는다.
  const aiAnalyzeFreetext = onCall(
    { region: "asia-northeast3", memory: "512MiB", timeoutSeconds: 540, maxInstances: 3 },
    async (req) => {
      const email = await requireAdmin(req, "freetext");
      const month = String(req.data?.month || "");
      if (!/^\d{4}-\d{2}$/.test(month)) throw new HttpsError("invalid-argument", "기간(월)이 올바르지 않습니다.");
      const { provider, key } = await loadProvider(String(req.data?.providerId || ""));
      const t0 = Date.now();

      const { items, masked, categories } = await collectFreetext(month);
      if (!items.length) throw new HttpsError("failed-precondition", "이 달에는 주관식 응답이 없습니다.");
      const skipped = Math.max(0, items.length - MAX_ITEMS);
      const target = items.slice(0, MAX_ITEMS).map((x, i) => ({ ...x, i: i + 1 }));
      const classifiable = target.filter((x) => x.field);

      let calls = 0, modelMs = 0, servedModel = provider.model;
      try {
        // 1) 분류(나눠서)
        const catOf = {};
        for (let s = 0; s < classifiable.length; s += CLASSIFY_CHUNK) {
          const chunk = classifiable.slice(s, s + CLASSIFY_CHUNK);
          const r = await chat(provider, key, classifyMessages(categories, chunk), { maxTokens: 40 * chunk.length + 200 });
          calls++; modelMs += r.ms; servedModel = r.servedModel;
          const out = extractJson(r.content);
          for (const it of out.items || []) {
            const cat = String(it.cat || "").trim();
            if (categories.includes(cat)) catOf[Number(it.i)] = cat; // 목록 밖 답은 버린다(미분류로 남김)
          }
        }
        const counts = {};
        for (const x of classifiable) { const c = catOf[x.i]; if (c) counts[c] = (counts[c] || 0) + 1; }

        // 2) 시사점·반영계획(의미 없는 짧은 응답 제외 후 표본)
        const meaningful = target.filter((x) => x.text.replace(/[\s.!~]/g, "").length > 3 && !/^(없(음|습니다)|감사합니다|-)$/.test(x.text.trim()));
        const samples = meaningful.slice(0, SUMMARY_SAMPLE);
        const r2 = await chat(provider, key, summaryMessages(month, counts, samples), { maxTokens: 1500 });
        calls++; modelMs += r2.ms; servedModel = r2.servedModel;
        const nar = extractJson(r2.content);

        const result = {
          ok: true,
          provider: { id: provider.id, name: provider.name || "", model: provider.model, servedModel },
          month, categories,
          items: target.map((x) => ({ rid: x.rid, field: x.field, kind: x.kind, course: x.course, text: x.text, cat: x.field ? (catOf[x.i] || "") : "" })),
          counts,
          classified: Object.keys(catOf).length, classifiable: classifiable.length,
          summary: String(nar.summary || "").trim(),
          action: String(nar.action || "").trim(),
          maskedCount: masked, skipped, calls, modelMs, elapsedMs: Date.now() - t0,
        };
        await logRun({ kind: "freetext", by: email, month, providerId: provider.id, providerName: provider.name || "", model: provider.model, servedModel, ok: true,
          elapsedMs: result.elapsedMs, modelMs, calls, itemCount: target.length, classified: result.classified, classifiable: result.classifiable,
          maskedCount: masked, counts, summary: result.summary, action: result.action });
        return result;
      } catch (e) {
        await logRun({ kind: "freetext", by: email, month, providerId: provider.id, providerName: provider.name || "", model: provider.model, ok: false,
          error: String(e.message || e).slice(0, 300), calls, elapsedMs: Date.now() - t0 });
        if (e instanceof HttpsError) throw e;
        throw new HttpsError("internal", `AI 분석 실패(${provider.name || provider.model}): ${e.message || e}`);
      }
    });

  // 운영 결과 보고서 총평·시사점·반영계획 초안. 수치는 화면이 계산해 넘긴 지표만 쓴다.
  const aiReportNarrative = onCall(
    { region: "asia-northeast3", memory: "512MiB", timeoutSeconds: 300, maxInstances: 3 },
    async (req) => {
      const email = await requireAdmin(req, "reportdoc");
      const month = String(req.data?.month || "");
      if (!/^\d{4}-\d{2}$/.test(month)) throw new HttpsError("invalid-argument", "기간(월)이 올바르지 않습니다.");
      const metrics = req.data?.metrics;
      if (!metrics || typeof metrics !== "object") throw new HttpsError("invalid-argument", "지표가 없습니다. 보고서를 먼저 생성하세요.");
      if (JSON.stringify(metrics).length > 30000) throw new HttpsError("invalid-argument", "지표가 너무 큽니다.");
      const { provider, key } = await loadProvider(String(req.data?.providerId || ""));
      const t0 = Date.now();
      const { items, masked } = await collectFreetext(month);
      const samples = items
        .filter((x) => x.text.replace(/[\s.!~]/g, "").length > 3 && !/^(없(음|습니다)|감사합니다|-)$/.test(x.text.trim()))
        .slice(0, 80);
      try {
        const r = await chat(provider, key, reportMessages(month, metrics, samples), { maxTokens: 1800 });
        const out = extractJson(r.content);
        const overview = String(out.overview || "").trim();
        const summary = String(out.summary || "").trim();
        const action = String(out.action || "").trim();
        const unverified = unverifiedNumbers([overview, summary, action], metrics, month);
        const result = {
          ok: true,
          provider: { id: provider.id, name: provider.name || "", model: provider.model, servedModel: r.servedModel },
          month, overview, summary, action, unverified,
          sampleCount: samples.length, maskedCount: masked, elapsedMs: Date.now() - t0,
        };
        await logRun({ kind: "report", by: email, month, providerId: provider.id, providerName: provider.name || "", model: provider.model,
          servedModel: r.servedModel, ok: true, elapsedMs: result.elapsedMs, maskedCount: masked, unverified, overview, summary, action });
        return result;
      } catch (e) {
        await logRun({ kind: "report", by: email, month, providerId: provider.id, providerName: provider.name || "", model: provider.model, ok: false,
          error: String(e.message || e).slice(0, 300), elapsedMs: Date.now() - t0 });
        if (e instanceof HttpsError) throw e;
        throw new HttpsError("internal", `AI 보고서 작성 실패(${provider.name || provider.model}): ${e.message || e}`);
      }
    });

  // 피드백 반영계획 → 개선 조치 항목(분류 포함) 추출. 저장은 화면에서 사람이 고른 것만.
  const aiExtractActions = onCall(
    { region: "asia-northeast3", memory: "256MiB", timeoutSeconds: 180, maxInstances: 3 },
    async (req) => {
      const email = await requireAdmin(req, "improve");
      const month = String(req.data?.month || "");
      if (!/^\d{4}-\d{2}$/.test(month)) throw new HttpsError("invalid-argument", "기간(월)이 올바르지 않습니다.");
      const [aggDoc, catDoc] = await Promise.all([db.doc(`surveyAggregates/${month}`).get(), db.doc("settings/surveyCategories").get()]);
      const actionText = String(aggDoc.exists ? (aggDoc.data().actionTaken || "") : "").trim();
      if (!actionText) throw new HttpsError("failed-precondition", `${month}의 피드백 반영계획이 비어 있습니다. 주관식 원문 탭이나 운영 보고서에서 먼저 작성하세요.`);
      const categories = (catDoc.exists && Array.isArray(catDoc.data().list) && catDoc.data().list.length)
        ? catDoc.data().list.map(String)
        : ["현업 활용", "강의 방식", "교재/자료", "시설/환경", "운영/진행", "기타"];
      const { provider, key } = await loadProvider(String(req.data?.providerId || ""));
      const t0 = Date.now();
      try {
        const r = await chat(provider, key, actionMessages(categories, actionText.slice(0, 4000)), { maxTokens: 1200 });
        const out = extractJson(r.content);
        const seen = new Set();
        const actions = (Array.isArray(out.actions) ? out.actions : [])
          .map((x) => ({ action: String(x?.action || "").trim().slice(0, 120), category: String(x?.category || "").trim() }))
          .filter((x) => x.action && !seen.has(x.action) && seen.add(x.action))
          .map((x) => ({ ...x, category: categories.includes(x.category) ? x.category : "" })); // 목록 밖 분류는 비워 사람이 고르게
        await logRun({ kind: "actions", by: email, month, providerId: provider.id, providerName: provider.name || "", model: provider.model,
          servedModel: r.servedModel, ok: true, elapsedMs: Date.now() - t0, count: actions.length });
        return { ok: true, month, categories, actions, provider: { name: provider.name || "", model: provider.model, servedModel: r.servedModel }, elapsedMs: Date.now() - t0 };
      } catch (e) {
        await logRun({ kind: "actions", by: email, month, providerId: provider.id, providerName: provider.name || "", model: provider.model, ok: false,
          error: String(e.message || e).slice(0, 300), elapsedMs: Date.now() - t0 });
        if (e instanceof HttpsError) throw e;
        throw new HttpsError("internal", `조치 추출 실패(${provider.name || provider.model}): ${e.message || e}`);
      }
    });

  const aiDraftDocument = onCall(
    { region: "asia-northeast3", memory: "256MiB", timeoutSeconds: 240, maxInstances: 3 },
    async (req) => {
      const email = await requireAdmin(req, "docdraft");
      const kind = String(req.data?.kind || "");
      if (!DOC_KINDS[kind]) throw new HttpsError("invalid-argument", "문서 종류가 올바르지 않습니다.");
      const facts = req.data?.facts;
      if (!facts || typeof facts !== "object") throw new HttpsError("invalid-argument", "자료가 없습니다.");
      if (JSON.stringify(facts).length > 40000) throw new HttpsError("invalid-argument", "자료가 너무 큽니다.");
      const { provider, key } = await loadProvider(String(req.data?.providerId || ""));
      const t0 = Date.now();
      const month = String(facts.month || "");
      try {
        const r = await chat(provider, key, docMessages(kind, facts), { maxTokens: 3500 });
        const out = extractJson(r.content);
        const title = String(out.title || "").trim();
        const body = String(out.body || "").trim();
        const unverified = unverifiedNumbers([title, body], facts, /^\d{4}-\d{2}$/.test(month) ? month : "2000-01");
        await logRun({ kind: "doc", docKind: kind, by: email, providerId: provider.id, providerName: provider.name || "", model: provider.model,
          servedModel: r.servedModel, ok: true, elapsedMs: Date.now() - t0, unverified });
        return { ok: true, kind, label: DOC_KINDS[kind].label, title, body, unverified,
          provider: { name: provider.name || "", model: provider.model, servedModel: r.servedModel }, elapsedMs: Date.now() - t0 };
      } catch (e) {
        await logRun({ kind: "doc", docKind: kind, by: email, providerId: provider.id, providerName: provider.name || "", model: provider.model, ok: false,
          error: String(e.message || e).slice(0, 300), elapsedMs: Date.now() - t0 });
        if (e instanceof HttpsError) throw e;
        throw new HttpsError("internal", `초안 작성 실패(${provider.name || provider.model}): ${e.message || e}`);
      }
    });


  // ================================================================
  // 운영 질의 비서: 관리자가 자연어로 묻으면 모델이 '정해진 조회 도구' 중 무엇을 쓸지 고르고,
  // 계산은 시스템(아래 함수)이 하며, 모델은 그 결과로 답을 쓴다. 숫자는 결과와 대조한다.
  // 개인 식별정보(강사 실명 등)는 도구 결과에 넣지 않는다(강사는 '강사#n' 익명 표기).
  // ================================================================
  const EDU_LABELS = ["현업(현장) 활용여부", "전문지식 향상여부", "교육내용", "교재/기타 강의자재", "담당직원 교육 준비성", "강의실 쾌적성/청결성"];
  const kstToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Seoul" }).format(new Date());
  const r1 = (v) => (v == null || !Number.isFinite(v) ? null : Math.round(v * 10) / 10);
  const avg20 = (a) => (a.length ? r1((a.reduce((x, y) => x + y, 0) / a.length) * 20) : null);
  const okDate = (v) => /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""));
  const okMonth = (v) => /^\d{4}-\d{2}$/.test(String(v || ""));
  const courseLabel = (c) => `${c.name || "-"}${c.round != null && c.round !== "" ? ` ${c.round}차` : ""}`;

  async function liveCourses() {
    const snap = await db.collection("courses").get();
    return snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((c) => !c.hidden);
  }
  const OPS_TOOLS = {
    courses_in_range: {
      desc: "기간(from~to, YYYY-MM-DD)에 진행되는 차수 목록: 과정명·차수·유형·기간·교육장·정원·신청·잔여",
      args: "{from, to}",
      async run({ from, to }) {
        if (!okDate(from) || !okDate(to)) throw new Error("from/to 날짜 형식 오류");
        const list = (await liveCourses()).filter((c) => (c.startDate || "") <= to && (c.endDate || c.startDate || "") >= from)
          .sort((a, b) => (a.startDate || "").localeCompare(b.startDate || ""));
        return { from, to, count: list.length, courses: list.slice(0, 60).map((c) => ({
          course: courseLabel(c), type: c.courseType || "", start: c.startDate || "", end: c.endDate || "",
          venue: c.venue || "", capacity: c.capacity ?? null, applied: c.appliedCount ?? 0,
          remaining: c.capacity != null ? Math.max(0, c.capacity - (c.appliedCount || 0)) : null, planned: !!c.planned })) };
      },
    },
    capacity_alerts: {
      desc: "기간 안에 시작하는 차수 중 마감 임박(잔여 3석 이하 또는 신청률 90% 이상)과 신청 저조(신청률 30% 미만) 차수",
      args: "{from, to}",
      async run({ from, to }) {
        if (!okDate(from) || !okDate(to)) throw new Error("from/to 날짜 형식 오류");
        const list = (await liveCourses()).filter((c) => (c.startDate || "") >= from && (c.startDate || "") <= to && c.capacity > 0);
        const row = (c) => ({ course: courseLabel(c), start: c.startDate, capacity: c.capacity, applied: c.appliedCount || 0,
          ratePercent: Math.round(((c.appliedCount || 0) / c.capacity) * 100) });
        return {
          from, to,
          nearlyFull: list.filter((c) => c.capacity - (c.appliedCount || 0) <= 3 || (c.appliedCount || 0) / c.capacity >= 0.9).map(row),
          lowApplication: list.filter((c) => (c.appliedCount || 0) / c.capacity < 0.3).map(row),
        };
      },
    },
    schedule_conflicts: {
      desc: "기간 안 시간표에서 같은 시간 같은 강의실 또는 같은 강사가 겹친 일정",
      args: "{from, to}",
      async run({ from, to }) {
        if (!okDate(from) || !okDate(to)) throw new Error("from/to 날짜 형식 오류");
        const [ss, courses] = await Promise.all([
          db.collection("sessions").where("date", ">=", from).where("date", "<=", to).get(), liveCourses()]);
        const byId = Object.fromEntries(courses.map((c) => [c.id, c]));
        const rows = ss.docs.map((d) => d.data()).filter((x) => byId[x.courseId]);
        const anon = {}; let n = 0;
        const instLabel = (x) => { const k = x.instructorId || x.instructor || ""; if (!k) return ""; if (!anon[k]) anon[k] = `강사#${++n}`; return anon[k]; };
        const overlap = (a, b) => a.date === b.date && (a.startTime || "") < (b.endTime || "") && (b.startTime || "") < (a.endTime || "");
        const out = [];
        for (let i = 0; i < rows.length; i++) for (let j = i + 1; j < rows.length; j++) {
          const a = rows[i], b = rows[j];
          if (!overlap(a, b) || a.courseId === b.courseId) continue;
          const pair = [courseLabel(byId[a.courseId]), courseLabel(byId[b.courseId])];
          if (a.room && a.room === b.room) out.push({ kind: "강의실", date: a.date, time: `${a.startTime}~${a.endTime}`, room: a.room, courses: pair });
          if ((a.instructorId || a.instructor) && (a.instructorId || a.instructor) === (b.instructorId || b.instructor)) {
            out.push({ kind: "강사", date: a.date, time: `${a.startTime}~${a.endTime}`, instructor: instLabel(a), courses: pair });
          }
          if (out.length >= 40) break;
        }
        return { from, to, sessionsChecked: rows.length, conflicts: out };
      },
    },
    satisfaction: {
      desc: "월(YYYY-MM) 설문 만족도(100점 환산): 전체·교육·강사 평균, 과정유형별, 교육 6문항별, 차수별 낮은 순 5개. 응답 10명 미만은 참고용",
      args: "{month}",
      async run({ month }) {
        if (!okMonth(month)) throw new Error("month 형식 오류");
        const [snap, courses] = await Promise.all([
          db.collection("surveyResponses").where("collectedDate", ">=", `${month}-01`).where("collectedDate", "<=", `${month}-31`).get(), liveCourses()]);
        const byId = Object.fromEntries(courses.map((c) => [c.id, c]));
        const all = { edu: [], inst: [] }, byType = {}, byCourse = {}, items = EDU_LABELS.map(() => []);
        for (const d of snap.docs) {
          const r = d.data();
          const c = byId[r.courseId];
          const type = (c && c.courseType) || r.courseType || "기타";
          const t = byType[type] = byType[type] || { n: 0, edu: [], inst: [] };
          const k = byCourse[r.courseId] = byCourse[r.courseId] || { n: 0, vals: [] };
          t.n++; k.n++;
          Object.entries(r.edu || {}).forEach(([q, v]) => {
            if (!Number.isFinite(v)) return;
            all.edu.push(v); t.edu.push(v); k.vals.push(v);
            const i = Number(String(q).replace(/\D/g, "")); if (items[i]) items[i].push(v);
          });
          (r.instructors || []).forEach((it) => [0, 1, 2].forEach((i) => {
            const v = it[`q${i}`]; if (Number.isFinite(v)) { all.inst.push(v); t.inst.push(v); k.vals.push(v); }
          }));
        }
        return {
          month, responses: snap.size,
          overall: avg20([...all.edu, ...all.inst]), education: avg20(all.edu), instructor: avg20(all.inst),
          byCourseType: Object.entries(byType).map(([type, g]) => ({ type, responses: g.n, education: avg20(g.edu), instructor: avg20(g.inst) })),
          educationItems: EDU_LABELS.map((label, i) => ({ item: label, score: avg20(items[i]) })),
          lowestCourses: Object.entries(byCourse).map(([id, g]) => ({ course: byId[id] ? courseLabel(byId[id]) : "-", responses: g.n, score: avg20(g.vals) }))
            .filter((x) => x.score != null).sort((a, b) => a.score - b.score).slice(0, 5),
        };
      },
    },
    feedback_categories: {
      desc: "월(YYYY-MM) 주관식 분류별 건수(불만족·제안개선). 분류는 관리자가 적용한 것만",
      args: "{month}",
      async run({ month }) {
        if (!okMonth(month)) throw new Error("month 형식 오류");
        const snap = await db.collection("surveyResponses").where("collectedDate", ">=", `${month}-01`).where("collectedDate", "<=", `${month}-31`).get();
        const dis = {}, sug = {}; let withText = 0;
        for (const d of snap.docs) {
          const r = d.data();
          if (r.freeDissatisfied || r.freeSuggestion) withText++;
          if (r.catDissatisfied) dis[r.catDissatisfied] = (dis[r.catDissatisfied] || 0) + 1;
          if (r.catSuggestion) sug[r.catSuggestion] = (sug[r.catSuggestion] || 0) + 1;
        }
        return { month, responses: snap.size, withFreeText: withText, dissatisfied: dis, suggestion: sug };
      },
    },
    improvements_status: {
      desc: "개선 조치(피드백 반영계획) 목록과 상태별 건수(계획·진행·완료)",
      args: "{}",
      async run() {
        const snap = await db.collection("improvements").get();
        const list = snap.docs.map((d) => d.data());
        const counts = {};
        list.forEach((x) => { counts[x.status || "계획"] = (counts[x.status || "계획"] || 0) + 1; });
        return { total: list.length, counts, open: list.filter((x) => x.status !== "완료").slice(0, 30)
          .map((x) => ({ action: x.action, category: x.category, status: x.status || "계획", planMonth: x.planMonth || "" })) };
      },
    },
  };

  function opsSystem(today) {
    const toolList = Object.entries(OPS_TOOLS).map(([n, t]) => `- ${n} ${t.args}: ${t.desc}`).join("\n");
    return "너는 공공기관 교육훈련센터 운영 담당자를 돕는 '운영 질의 비서'다. 오늘은 " + today + "(KST)이다.\n" +
      "질문에 답하려면 아래 조회 도구를 쓴다. 도구가 계산한 값만 근거로 답하고, 숫자를 새로 계산하거나 지어내지 않는다.\n" +
      "'이번 주', '다음 달' 같은 표현은 오늘 날짜로 기간을 정해 도구에 넘긴다(주는 월~일).\n" +
      "도구:\n" + toolList + "\n" +
      "한 번에 하나씩, JSON 하나만 출력한다(코드펜스 금지).\n" +
      "도구를 쓸 때: {\"tool\":\"도구이름\",\"args\":{...}}\n" +
      "답할 때: {\"answer\":\"한국어 답변(핵심 먼저, 필요하면 '- ' 항목)\"}\n" +
      "도구로 알 수 없는 질문(개인정보·시스템 밖 정보 등)은 도구 없이 할 수 없다고 답한다. 특정 강사를 평가·지목하지 않는다.";
  }

  const aiAskOps = onCall(
    { region: "asia-northeast3", memory: "512MiB", timeoutSeconds: 300, maxInstances: 3 },
    async (req) => {
      const email = await requireAdmin(req, "assistant");
      const question = String(req.data?.question || "").trim().slice(0, 500);
      if (!question) throw new HttpsError("invalid-argument", "질문을 입력하세요.");
      const history = (Array.isArray(req.data?.history) ? req.data.history : []).slice(-4)
        .map((h) => ({ q: String(h?.q || "").slice(0, 300), a: String(h?.a || "").slice(0, 800) }));
      const { provider, key } = await loadProvider(String(req.data?.providerId || ""));
      const t0 = Date.now();
      const today = kstToday();
      const messages = [{ role: "system", content: opsSystem(today) }];
      history.forEach((h) => { messages.push({ role: "user", content: h.q }); messages.push({ role: "assistant", content: JSON.stringify({ answer: h.a }) }); });
      messages.push({ role: "user", content: question });
      const steps = [], results = [];
      let answer = "", servedModel = provider.model, fallback = null;
      try {
        for (let i = 0; i < 5 && !answer; i++) {
          const r = await chat(provider, key, messages, { maxTokens: 1200 });
          servedModel = r.servedModel;
          if (r.fallbackTo) fallback = { from: r.fallbackFrom, to: r.fallbackTo, reason: r.fallbackReason };
          let out;
          try { out = extractJson(r.content); } catch { answer = String(r.content || "").replace(/<think>[\s\S]*?<\/think>/gi, "").trim(); break; }
          if (out.answer) { answer = String(out.answer).trim(); break; }
          const tool = OPS_TOOLS[out.tool];
          messages.push({ role: "assistant", content: JSON.stringify(out) });
          if (!tool) { messages.push({ role: "user", content: `알 수 없는 도구입니다: ${out.tool}. 목록의 도구만 쓰거나 답하세요.` }); continue; }
          let data;
          try { data = await tool.run(out.args || {}); } catch (e) { data = { error: String(e.message || e) }; }
          steps.push({ tool: out.tool, args: out.args || {} });
          results.push(data);
          messages.push({ role: "user", content: `도구 결과(${out.tool}):\n${JSON.stringify(data).slice(0, 12000)}\n\n더 필요하면 도구를 쓰고, 충분하면 answer로 답하라.` });
        }
        if (!answer) answer = "질문에 필요한 정보를 정리하지 못했습니다. 기간이나 대상을 더 구체적으로 물어봐 주세요.";
        const unverified = results.length ? unverifiedNumbers([answer], results, today.slice(0, 7)) : [];
        await logRun({ kind: "ask", by: email, providerId: provider.id, providerName: provider.name || "", model: provider.model,
          servedModel, ok: true, elapsedMs: Date.now() - t0, tools: steps.map((x) => x.tool), unverified, fallback });
        return { ok: true, answer, steps, results, unverified, fallback,
          provider: { name: provider.name || "", model: provider.model, servedModel }, elapsedMs: Date.now() - t0 };
      } catch (e) {
        await logRun({ kind: "ask", by: email, providerId: provider.id, providerName: provider.name || "", model: provider.model, ok: false,
          error: String(e.message || e).slice(0, 300), elapsedMs: Date.now() - t0 });
        if (e instanceof HttpsError) throw e;
        throw new HttpsError("internal", `AI 비서 응답 실패(${provider.name || provider.model}): ${e.message || e}`);
      }
    });


  // ================================================================
  // 주간 AI 운영 브리핑: 매주 월요일 아침 AI가 먼저 담당자에게 메일로 알린다.
  // 사실(일정·정원·충돌·설문·조치)은 위 조회 도구로 시스템이 계산하고, 모델은 요약·우선순위만 쓴다.
  // 모델이 실패해도(대체 모델까지) 계산된 사실만으로 된 기본 브리핑을 보낸다.
  // ================================================================
  const addDays = (ymd, n) => { const d = new Date(ymd + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  async function briefingFacts(today) {
    const dow = (new Date(today + "T00:00:00Z").getUTCDay() + 6) % 7; // 월=0
    const mon = addDays(today, -dow), sun = addDays(mon, 6);
    const last7 = addDays(today, -7), yest = addDays(today, -1);
    const [week, cap, conf, imp, fb] = await Promise.all([
      OPS_TOOLS.courses_in_range.run({ from: mon, to: sun }),
      OPS_TOOLS.capacity_alerts.run({ from: today, to: addDays(today, 28) }),
      OPS_TOOLS.schedule_conflicts.run({ from: today, to: addDays(today, 13) }),
      OPS_TOOLS.improvements_status.run(),
      db.collection("surveyResponses").where("collectedDate", ">=", last7).where("collectedDate", "<=", yest).get(),
    ]);
    const vals = [], dis = {};
    let withText = 0;
    fb.docs.forEach((d) => {
      const r = d.data();
      Object.values(r.edu || {}).forEach((v) => Number.isFinite(v) && vals.push(v));
      (r.instructors || []).forEach((it) => [0, 1, 2].forEach((i) => Number.isFinite(it[`q${i}`]) && vals.push(it[`q${i}`])));
      if (r.freeDissatisfied) withText++;
      if (r.catDissatisfied) dis[r.catDissatisfied] = (dis[r.catDissatisfied] || 0) + 1;
    });
    return {
      today, thisWeek: { from: mon, to: sun, courses: week.courses },
      capacity: { from: cap.from, to: cap.to, nearlyFull: cap.nearlyFull, lowApplication: cap.lowApplication },
      conflicts: { from: conf.from, to: conf.to, items: conf.conflicts },
      lastWeekSurvey: { from: last7, to: yest, responses: fb.size, overall: avg20(vals), dissatisfiedWithText: withText, dissatisfiedCategories: dis },
      improvements: { counts: imp.counts, open: imp.open.slice(0, 10) },
    };
  }
  function briefingMessages(f) {
    return [
      { role: "system", content:
        "너는 공공기관 교육훈련센터의 '주간 운영 브리핑'을 쓰는 비서다. 주어진 사실(JSON)만으로 담당자가 월요일 아침 1분 안에 읽을 브리핑을 쓴다.\n" +
        "규칙: 1) 숫자·과정명·날짜는 JSON에 있는 그대로만. 계산·추정 금지. 2) 개인·특정 강사를 지목하지 않는다. " +
        "3) 구성: [이번 주 한눈에] 2~3문장 → [먼저 챙길 일] 우선순위 순 '- ' 항목(시간표 충돌, 마감 임박·신청 저조, 미완료 조치) → [지난주 설문] 1~2문장. 해당 사항이 없으면 '없음'. " +
        "4) 존댓말, 간결하게. 출력은 JSON 하나만: {\"subject\":\"메일 제목(25자 이내)\",\"body\":\"본문(줄바꿈 \\n)\"} — 코드펜스 금지." },
      { role: "user", content: `사실(JSON):\n${JSON.stringify(f).slice(0, 20000)}` },
    ];
  }
  // 모델 없이도 보낼 수 있는 기본 브리핑(사실 나열).
  function plainBriefing(f) {
    const L = [];
    L.push(`[이번 주 교육] ${f.thisWeek.from} ~ ${f.thisWeek.to} · ${f.thisWeek.courses.length}개 차수`);
    f.thisWeek.courses.slice(0, 15).forEach((c) => L.push(`- ${c.course} (${c.start}~${c.end}, ${c.venue || "-"}, 신청 ${c.applied}/${c.capacity ?? "-"})`));
    L.push("", "[먼저 챙길 일]");
    if (f.conflicts.items.length) f.conflicts.items.slice(0, 10).forEach((x) => L.push(`- ${x.kind} 중복: ${x.date} ${x.time} ${x.room || x.instructor || ""} — ${x.courses.join(" / ")}`));
    f.capacity.nearlyFull.forEach((x) => L.push(`- 마감 임박: ${x.course} (${x.start}, ${x.applied}/${x.capacity})`));
    f.capacity.lowApplication.forEach((x) => L.push(`- 신청 저조: ${x.course} (${x.start}, ${x.applied}/${x.capacity})`));
    if (L[L.length - 1] === "[먼저 챙길 일]") L.push("- 없음");
    L.push("", `[지난주 설문] 응답 ${f.lastWeekSurvey.responses}건${f.lastWeekSurvey.overall != null ? ` · 종합 ${f.lastWeekSurvey.overall}점` : ""}`);
    L.push("", `[개선 조치] ${Object.entries(f.improvements.counts).map(([k, v]) => `${k} ${v}`).join(" · ") || "없음"}`);
    return { subject: `주간 운영 브리핑 ${f.today}`, body: L.join("\n") };
  }
  async function makeBriefing(providerId) {
    const today = kstToday();
    const facts = await briefingFacts(today);
    let out = null, info = { ai: false };
    try {
      const { provider, key } = await loadProvider(providerId || "");
      const r = await chat(provider, key, briefingMessages(facts), { maxTokens: 1800 });
      const j = extractJson(r.content);
      if (j.body) {
        out = { subject: String(j.subject || "").slice(0, 60) || `주간 운영 브리핑 ${today}`, body: String(j.body).trim() };
        info = { ai: true, model: r.servedModel, provider: provider.name || provider.model, fallback: r.fallbackTo || null,
          unverified: unverifiedNumbers([out.subject, out.body], facts, today.slice(0, 7)) };
      }
    } catch (e) { info = { ai: false, error: String(e.message || e).slice(0, 200) }; }
    if (!out) out = plainBriefing(facts);
    return { ...out, facts, info, today };
  }
  async function sendBriefing(b, recipients) {
    const note = b.info.ai
      ? `\n\n— AI(${b.info.model}) 작성 · 숫자는 시스템 집계값입니다.${b.info.unverified && b.info.unverified.length ? ` (확인 안 된 숫자: ${b.info.unverified.join(", ")})` : ""}`
      : "\n\n— AI 응답이 없어 시스템 집계값으로 작성했습니다.";
    await mail({ to: recipients.join(","), subject: `[LMS] ${b.subject}`, text: b.body + note + "\n※ 이 메일은 교육 운영관리 시스템의 주간 브리핑 설정에 따라 자동 발송되었습니다." });
  }
  const okEmails = (a) => (Array.isArray(a) ? a : []).map((x) => String(x).trim()).filter((x) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x)).slice(0, 10);

  const aiBriefingPreview = onCall(
    { region: "asia-northeast3", memory: "512MiB", timeoutSeconds: 300, maxInstances: 2, secrets: mail.secrets },
    async (req) => {
      const email = await requireAdmin(req, "settings");
      const t0 = Date.now();
      const b = await makeBriefing(String(req.data?.providerId || ""));
      let sent = 0;
      if (req.data?.send) {
        const cfg = (await db.doc("settings/briefing").get()).data() || {};
        const to = okEmails(cfg.recipients);
        if (!to.length) throw new HttpsError("failed-precondition", "받는 사람을 먼저 저장하세요.");
        await sendBriefing(b, to);
        sent = to.length;
      }
      await logRun({ kind: "briefing", by: email, ok: true, model: b.info.model || "", servedModel: b.info.model || "",
        providerName: b.info.provider || "", ai: b.info.ai, sent, elapsedMs: Date.now() - t0, unverified: b.info.unverified || [] });
      return { subject: b.subject, body: b.body, facts: b.facts, info: b.info, sent };
    });

  // 예약 실행은 index.js 의 dailyMaintenance(매일 03:00)가 월요일에만 부른다.
  const weeklyBriefing = async () => {
      const cfg = (await db.doc("settings/briefing").get()).data() || {};
      const to = okEmails(cfg.recipients);
      if (!cfg.enabled || !to.length) return;
      const t0 = Date.now();
      try {
        const b = await makeBriefing(String(cfg.providerId || ""));
        await sendBriefing(b, to);
        await db.doc("settings/briefing").set({ lastSentAt: Date.now() }, { merge: true });
        await logRun({ kind: "briefing", by: "schedule", ok: true, model: b.info.model || "", servedModel: b.info.model || "",
          providerName: b.info.provider || "", ai: b.info.ai, sent: to.length, elapsedMs: Date.now() - t0, unverified: b.info.unverified || [] });
      } catch (e) {
        await logRun({ kind: "briefing", by: "schedule", ok: false, error: String(e.message || e).slice(0, 300), elapsedMs: Date.now() - t0 });
      }
    };

  return { aiTestProvider, aiAnalyzeFreetext, aiReportNarrative, aiExtractActions, aiDraftDocument, aiAskOps, aiBriefingPreview, weeklyBriefing };
};

// 단위 시험용(함수 배포와 무관).
module.exports._test = { maskPII, extractJson, normBaseUrl, chat, classifyMessages, summaryMessages, reportMessages, unverifiedNumbers, docMessages };
