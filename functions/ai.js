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

async function chat(provider, key, messages, { json = true, maxTokens = 2000 } = {}) {
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

module.exports = function makeAi({ db, onCall, HttpsError, requireAdmin }) {
  async function loadProvider(providerId) {
    const cfg = (await db.doc("settings/ai").get()).data() || {};
    const list = Array.isArray(cfg.providers) ? cfg.providers : [];
    const id = providerId || cfg.defaultId || list[0]?.id;
    const p = list.find((x) => x.id === id);
    if (!p) throw new HttpsError("failed-precondition", "AI 연결이 설정되지 않았습니다. 설정 → AI 연결에서 모델을 등록하세요.");
    if (!p.baseUrl || !p.model) throw new HttpsError("failed-precondition", `'${p.name || p.id}'의 접속 주소·모델명이 비어 있습니다.`);
    const k = await db.doc(`aiKeys/${p.id}`).get();
    return { provider: p, key: k.exists ? String(k.data().key || "") : "" };
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
      const { provider, key } = await loadProvider(String(req.data?.providerId || ""));
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

  return { aiTestProvider, aiAnalyzeFreetext, aiReportNarrative, aiExtractActions, aiDraftDocument };
};

// 단위 시험용(함수 배포와 무관).
module.exports._test = { maskPII, extractJson, normBaseUrl, chat, classifyMessages, summaryMessages, reportMessages, unverifiedNumbers, docMessages };
