// =====================================================================
// 미션 콘텐츠 설정 — 참가자 앱(app.js·missions.js)과 관리자 앱(admin.js) 공용
//
// 문구·항목·제한시간은 Firestore(settings/missions)에서 편집할 수 있고,
// 문서가 없거나 일부 값이 비어 있으면 아래 기본값이 사용된다.
// (배점 공식은 점수 일관성을 위해 코드에 고정 — missions.js 참고)
// =====================================================================

// LMS 통합: LMS의 관리자 전용 settings 컬렉션과 충돌하지 않도록 별도 컬렉션 사용.
export const MISSION_SETTINGS_PATH = { collection: "scfeSettings", docId: "missions" };

export const DEFAULT_MISSION_CONFIG = {
  mission1: {
    name: "보안검색요원",
    cardDesc: "위험물품을 찾아 제거하라",
    title: "위험물을 찾아라!",
    line1: "기내 반입 금지물품(위험물)만 빠르게 탭하세요.",
    line2: "안전한 물품을 누르면 <strong>감점</strong>됩니다.",
    durationSec: 20,
    // d: true = 위험물(정답), false = 안전물품
    items: [
      { e: "🔪", l: "칼", d: true },
      { e: "✂️", l: "가위", d: true },
      { e: "🔥", l: "라이터", d: true },
      { e: "🔨", l: "망치", d: true },
      { e: "🪚", l: "톱", d: true },
      { e: "💣", l: "폭발물(모형)", d: true },
      { e: "🧪", l: "인화성 액체", d: true },
      { e: "📱", l: "휴대폰", d: false },
      { e: "👛", l: "지갑", d: false },
      { e: "🧸", l: "인형", d: false },
      { e: "📖", l: "책", d: false },
      { e: "☂️", l: "우산", d: false },
      { e: "🎧", l: "헤드폰", d: false },
      { e: "🕶️", l: "안경", d: false },
      { e: "🧦", l: "양말", d: false },
    ],
  },
  mission2: {
    name: "폭발물처리요원",
    cardDesc: "해체 시퀀스를 기억하라",
    title: "해체 순서를 기억하라!",
    line1: "화면에 표시되는 배선 순서를 기억한 뒤,",
    line2: "같은 순서로 정확히 눌러 해체하세요.",
    seqLen: 6, // 기억해야 하는 배선 개수
  },
  mission3: {
    name: "공항 직업 커넥트",
    cardDesc: "직업과 설명을 짝지어라",
    title: "직업을 짝지어라!",
    line1: "직업 아이콘과 그 직업의 설명을 짝지어 모두 연결하세요.",
    line2: "같은 짝을 찾아 <strong>두 번 탭</strong>하면 매칭됩니다.",
    durationSec: 60,
    pairs: [
      { id: "pilot", emoji: "✈️", label: "조종사", duty: "비행기를 조종하는 하늘 위의 리더" },
      { id: "atc", emoji: "🗼", label: "관제사", duty: "이륙·착륙 순서를 지정하고 안전한 길을 안내해요" },
      { id: "fire", emoji: "🚒", label: "공항소방대", duty: "공항 내 사고에 신속히 출동해 인명을 구조해요" },
      { id: "security", emoji: "🛂", label: "보안검색요원", duty: "기내 반입 물품을 X-ray로 확인해요" },
      { id: "eod", emoji: "💣", label: "폭발물처리요원", duty: "특수 장비로 의심물의 형태·성분을 확인해요" },
      { id: "mech", emoji: "🔧", label: "항공정비사", duty: "항공기가 안전하게 날 수 있도록 이착륙 전후 점검하고 수리해요" },
    ],
  },
  mission4: {
    name: "항공 낱말 탐정",
    cardDesc: "가로세로 낱말 퍼즐을 풀어라",
    title: "낱말 퍼즐을 완성하라!",
    line1: "열쇠(문제)를 누르고 정답 낱말을 입력하세요.",
    line2: "제한시간은 없지만 <strong>빨리 풀수록</strong> 점수가 높아요. 힌트를 쓰면 감점!",
    placeCount: 10, // 판에 올릴 낱말 수(8~12). 같은 행사 참가자는 모두 같은 판을 푼다.
    // a: 정답(띄어쓰기 없이), c: 열쇠
    words: [
      { a: "항공보안", c: "하늘길의 안전을 지키는 일, 네 글자" },
      { a: "보안검색", c: "비행기 타기 전, 위험한 물건이 없는지 확인하는 절차" },
      { a: "검색대", c: "가방을 올려 엑스레이로 검사하는 곳" },
      { a: "물어보안", c: "항공보안 정보를 알려 주는 카카오톡 챗봇 이름" },
      { a: "폭발물", c: "처리요원이 특수장비와 로봇으로 안전하게 없애는 위험물" },
      { a: "수하물", c: "비행기에 싣는 여행 짐" },
      { a: "금속탐지기", c: "문처럼 생긴 곳을 지나가면 몸의 금속을 찾아내요" },
      { a: "비행기", c: "하늘을 나는 탈것" },
      { a: "기장", c: "비행기를 책임지는 조종사의 대장" },
      { a: "조종사", c: "비행기를 조종하는 하늘 위의 리더" },
      { a: "관제사", c: "관제탑에서 비행기의 이륙·착륙 순서를 정해 줘요" },
      { a: "관제탑", c: "공항에서 가장 높은 건물, 관제사가 일하는 곳" },
      { a: "탑승권", c: "비행기를 탈 때 꼭 보여 줘야 하는 표" },
      { a: "승무원", c: "비행기 안에서 승객의 안전을 돌봐요" },
      { a: "항공정비사", c: "비행 전후 비행기를 점검하고 고쳐요" },
      { a: "공항소방대", c: "공항 사고 현장에 가장 먼저 출동해요" },
    ],
  },
  mission5: {
    name: "공항 하늘 방어",
    cardDesc: "날아드는 위험물을 막아라",
    title: "공항 하늘을 지켜라!",
    line1: "화면을 끌어 보안 드론을 움직이세요. 스캔 빔은 자동으로 나가요.",
    line2: "위험물만 맞히세요. <strong>안전물품</strong>(휴대폰·책 등)을 맞히면 감점!",
    durationSec: 90,
  },
};

// 저장된 설정을 기본값 위에 덮어쓴다.
// 값이 비어 있거나 목록이 빈 배열이면 기본값을 유지해, 잘못된 설정으로 게임이 깨지지 않게 한다.
export function mergeMissionConfig(saved) {
  const out = JSON.parse(JSON.stringify(DEFAULT_MISSION_CONFIG));
  if (!saved || typeof saved !== "object") return out;

  ["mission1", "mission2", "mission3", "mission4", "mission5"].forEach((key) => {
    const s = saved[key];
    if (!s || typeof s !== "object") return;
    const d = out[key];
    ["name", "cardDesc", "title", "line1", "line2"].forEach((f) => {
      if (typeof s[f] === "string" && s[f].trim()) d[f] = s[f];
    });
    if (Number.isFinite(s.durationSec) && s.durationSec > 0 && "durationSec" in d) {
      d.durationSec = s.durationSec;
    }
    if (Number.isFinite(s.seqLen) && s.seqLen >= 3 && "seqLen" in d) {
      d.seqLen = Math.min(12, Math.round(s.seqLen));
    }
    if (Array.isArray(s.items) && s.items.length > 0 && d.items) {
      const items = s.items.filter((it) => it && it.e && it.l);
      // 미션1은 위험물·안전물품이 각각 최소 1개씩 있어야 성립
      if (items.some((it) => it.d) && items.some((it) => !it.d)) d.items = items;
    }
    if (Number.isFinite(s.placeCount) && "placeCount" in d) {
      d.placeCount = Math.max(8, Math.min(12, Math.round(s.placeCount)));
    }
    if (Array.isArray(s.words) && d.words) {
      const words = s.words
        .map((w) => ({ a: String((w && w.a) || "").replace(/\s+/g, ""), c: String((w && w.c) || "").trim() }))
        .filter((w) => w.a.length >= 2 && w.c);
      if (words.length >= 4) d.words = words;
    }
    if (Array.isArray(s.pairs) && s.pairs.length > 0 && d.pairs) {
      const pairs = s.pairs.filter((p) => p && p.emoji && p.label && p.duty);
      if (pairs.length >= 2) {
        d.pairs = pairs.map((p, i) => ({ ...p, id: p.id || `pair${i}` }));
      }
    }
  });
  return out;
}
