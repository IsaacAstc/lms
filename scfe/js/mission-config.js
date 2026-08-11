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
};

// 저장된 설정을 기본값 위에 덮어쓴다.
// 값이 비어 있거나 목록이 빈 배열이면 기본값을 유지해, 잘못된 설정으로 게임이 깨지지 않게 한다.
export function mergeMissionConfig(saved) {
  const out = JSON.parse(JSON.stringify(DEFAULT_MISSION_CONFIG));
  if (!saved || typeof saved !== "object") return out;

  ["mission1", "mission2", "mission3"].forEach((key) => {
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
    if (Array.isArray(s.pairs) && s.pairs.length > 0 && d.pairs) {
      const pairs = s.pairs.filter((p) => p && p.emoji && p.label && p.duty);
      if (pairs.length >= 2) {
        d.pairs = pairs.map((p, i) => ({ ...p, id: p.id || `pair${i}` }));
      }
    }
  });
  return out;
}
