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

  return { aiTestProvider, aiAnalyzeFreetext };
};

// 단위 시험용(함수 배포와 무관).
module.exports._test = { maskPII, extractJson, normBaseUrl, chat, classifyMessages, summaryMessages };
