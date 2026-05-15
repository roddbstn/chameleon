const axios  = require('axios');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const EMBED_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent';

// ─────────────────────────────────────────────
// 키워드 → 벡터 검색 쿼리 매핑 테이블
// AI 답변에서 이 키워드가 발견되면 해당 쿼리로 벡터 검색
// ─────────────────────────────────────────────
const COMPANION_CATEGORY_MAP = [
  // 상의 계열
  { keywords: ['티셔츠', '반팔', '라운드넥', '반팔 티'],   query: '캐주얼 티셔츠 반팔 라운드넥 기본',        label: '함께 코디하면 좋은 티셔츠', category: 'top' },
  { keywords: ['린넨 셔츠', '린넨셔츠'],                   query: '린넨 셔츠 시원한 여름 캐주얼 내추럴',      label: '함께 코디하면 좋은 린넨 셔츠', category: 'top' },
  { keywords: ['셔츠', '반소매 셔츠', '오픈칼라'],          query: '캐주얼 셔츠 반소매 오버핏 루즈핏',        label: '함께 코디하면 좋은 셔츠', category: 'top' },
  { keywords: ['크롭', '크롭 기장', '크롭 상의', '크롭탑'], query: '크롭 상의 숏 기장 반팔 여성 캐주얼',      label: '함께 코디하면 좋은 크롭 상의', category: 'top' },
  { keywords: ['니트', '스웨터', '니트 상의'],             query: '베이직 니트 스웨터 간절기 캐주얼',         label: '함께 코디하면 좋은 니트', category: 'top' },
  { keywords: ['후드', '후드티', '스웨트'],                 query: '후드 스웨트셔츠 캐주얼 오버핏',           label: '함께 코디하면 좋은 후드', category: 'top' },
  { keywords: ['블라우스'],                                query: '블라우스 여성 캐주얼 여름 봄',             label: '함께 코디하면 좋은 블라우스', category: 'top' },
  // 아우터 계열
  { keywords: ['자켓', '재킷', '블레이저'],                 query: '자켓 재킷 캐주얼 세미포멀 아우터',        label: '함께 코디하면 좋은 자켓', category: 'outer' },
  { keywords: ['가디건'],                                  query: '가디건 니트 아우터 간절기 베이직',         label: '함께 코디하면 좋은 가디건', category: 'outer' },
  // 신발 계열
  { keywords: ['스니커즈', '운동화', '캔버스화'],            query: '스니커즈 캐주얼 운동화 데일리',           label: '함께 코디하면 좋은 스니커즈', category: 'shoes' },
  { keywords: ['샌들', '슬리퍼', '뮬'],                    query: '샌들 여름 오픈토 캐주얼 데일리',          label: '함께 코디하면 좋은 샌들', category: 'shoes' },
  { keywords: ['로퍼', '슬립온'],                          query: '로퍼 슬립온 캐주얼 클린 데일리',          label: '함께 코디하면 좋은 로퍼', category: 'shoes' },
  // 가방/액세서리 계열
  { keywords: ['가방', '백', '토트백', '숄더백', '크로스백'], query: '캐주얼 가방 토트 숄더 데일리',          label: '함께 코디하면 좋은 가방', category: 'bag' },
  { keywords: ['모자', '캡', '버킷햇'],                    query: '모자 캡 버킷햇 캐주얼 데일리',            label: '함께 어울리는 모자', category: 'acc' },
];

// 질문이 스타일링/코디 관련인지 감지하는 패턴
const QUESTION_TRIGGER_RE = /코디|스타일|어울|입|매치|같이|함께|세트|조합|룩|맞|착장/;

// AI 답변에서 크로스셀 기회가 있는지 감지하는 패턴
const ANSWER_TRIGGER_KEYWORDS = [
  '코디', '스타일링', '어울리', '매치', '조합', '함께 입',
  '티셔츠', '셔츠', '니트', '상의', '크롭', '블라우스', '후드',
  '자켓', '재킷', '가디건', '아우터',
  '스니커즈', '샌들', '슬리퍼', '로퍼', '신발',
  '가방', '백', '모자',
];

/**
 * AI Q&A 컨텍스트에서 크로스셀 기회를 감지
 * @param {string} answer  - AI 답변 텍스트
 * @param {string} question - 유저 질문
 * @returns {boolean}
 */
function detectCrossSellOpportunity(answer, question) {
  const isStyleQuestion = QUESTION_TRIGGER_RE.test(question);
  const answerHasStylingContent = ANSWER_TRIGGER_KEYWORDS.some(kw => answer.includes(kw));
  return isStyleQuestion && answerHasStylingContent;
}

/**
 * AI 답변에서 언급된 보조 상품 카테고리 항목 추출 (최대 2개)
 * 더 구체적인 키워드(예: "린넨 셔츠")가 일반 키워드("셔츠")보다 우선
 * @param {string} answer
 * @returns {Array<{query, label, category}>}
 */
function extractCompanionCategories(answer) {
  const found = [];
  const usedCategories = new Set();

  // 긴 키워드(구체적) 먼저 매칭하기 위해 키워드 길이 기준 정렬
  const sortedMap = [...COMPANION_CATEGORY_MAP].sort((a, b) => {
    const maxLenA = Math.max(...a.keywords.map(k => k.length));
    const maxLenB = Math.max(...b.keywords.map(k => k.length));
    return maxLenB - maxLenA;
  });

  for (const entry of sortedMap) {
    if (usedCategories.has(entry.category)) continue; // 같은 카테고리 중복 방지
    const matched = entry.keywords.some(kw => answer.includes(kw));
    if (matched) {
      found.push({ query: entry.query, label: entry.label, category: entry.category });
      usedCategories.add(entry.category);
    }
    if (found.length >= 2) break; // 최대 2개 카테고리
  }
  return found;
}

/**
 * 텍스트 → Gemini 임베딩
 */
async function embedText(text) {
  const url = `${EMBED_URL}?key=${process.env.GOOGLE_AI_API_KEY}`;
  const res = await axios.post(url, {
    model: 'models/gemini-embedding-001',
    content: { parts: [{ text }] },
  });
  return res.data.embedding.values;
}

/**
 * 벡터 검색 + 상품 이미지/가격 보강
 * @param {string} mallId
 * @param {string} searchQuery
 * @param {string} excludeProductId - 현재 보고 있는 상품 제외
 * @returns {Array} 상위 2개 상품
 */
async function vectorSearchCompanion(mallId, searchQuery, excludeProductId) {
  const embedding = await embedText(searchQuery);

  const { data, error } = await supabase.rpc('match_products', {
    query_embedding: JSON.stringify(embedding),
    match_store_id:  mallId,
    match_count:     6, // 여유 있게 가져와서 필터 후 2개 선택
  });
  if (error) throw new Error(error.message);

  // 현재 상품 제외 + 상위 2개
  const results = (data || [])
    .filter(p => String(p.product_id) !== String(excludeProductId))
    .slice(0, 2);

  if (!results.length) return [];

  // 이미지/가격 보강
  const ids = results.map(p => p.product_id);
  const { data: rows } = await supabase
    .from('products')
    .select('product_id, price, raw_data')
    .eq('store_id', mallId)
    .in('product_id', ids);

  const imgMap = {}, priceMap = {};
  (rows || []).forEach(r => {
    const rawImg = r.raw_data?.list_image || r.raw_data?.detail_image || null;
    imgMap[r.product_id]   = rawImg ? rawImg.replace(/^\/\//, 'https://') : null;
    priceMap[r.product_id] = r.price;
  });

  return results.map(p => ({
    id:        p.product_id,
    name:      p.name,
    price:     priceMap[p.product_id] ?? p.price ?? null,
    image_url: imgMap[p.product_id]   ?? null,
    url:       `/product/detail.html?product_no=${p.product_id}`,
    similarity: p.similarity,
  }));
}

/**
 * 메인 Cross-sell 파이프라인
 *
 * @param {object} params
 * @param {string} params.mallId
 * @param {string} params.productNo     - 현재 보고 있는 상품 번호
 * @param {string} params.question      - 유저 질문
 * @param {string} params.answer        - AI 답변
 * @returns {{ companionProducts: Array, companionContext: string|null }}
 */
async function findCompanionProducts({ mallId, productNo, question, answer }) {
  // 1. 크로스셀 기회 감지
  if (!detectCrossSellOpportunity(answer, question)) {
    return { companionProducts: [], companionContext: null };
  }

  // 2. 답변에서 보조 상품 카테고리 추출
  const categories = extractCompanionCategories(answer);
  if (!categories.length) {
    return { companionProducts: [], companionContext: null };
  }

  // 3. 카테고리별 벡터 검색 (첫 번째 카테고리 우선)
  // 두 개 카테고리가 있으면 각각 1개씩, 하나면 2개
  try {
    let companions = [];
    const seen = new Set();

    for (const cat of categories) {
      const results = await vectorSearchCompanion(mallId, cat.query, productNo);
      for (const p of results) {
        if (!seen.has(p.id) && companions.length < 2) {
          seen.add(p.id);
          companions.push(p);
        }
      }
      if (companions.length >= 2) break;
    }

    if (!companions.length) {
      return { companionProducts: [], companionContext: null };
    }

    // 4. UI 표시 레이블 결정 (첫 번째 카테고리 기준)
    const companionContext = categories[0].label;

    console.log(`[CompanionSearch] ${mallId} question="${question.slice(0, 30)}" → ${categories.map(c => c.category).join(',')} → ${companions.length}개 추천`);

    return { companionProducts: companions, companionContext };
  } catch (err) {
    // companion 검색 실패는 조용히 무시 (핵심 답변 UX 방해 금지)
    console.warn('[CompanionSearch] 검색 실패 (무시):', err.message);
    return { companionProducts: [], companionContext: null };
  }
}

module.exports = { findCompanionProducts, detectCrossSellOpportunity };
