const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

// ─────────────────────────────────────────────
// 월 비용 한도 체크
// ─────────────────────────────────────────────
async function checkCostLimit() {
  const limit = parseFloat(process.env.MONTHLY_COST_LIMIT_USD || '1.0');
  const monthStart = new Date();
  monthStart.setDate(1);
  monthStart.setHours(0, 0, 0, 0);

  const { data } = await supabase
    .from('api_events')
    .select('cost_usd')
    .gte('occurred_at', monthStart.toISOString());

  const total = (data || []).reduce((sum, r) => sum + (r.cost_usd || 0), 0);
  if (total >= limit) {
    throw new Error(`월 API 비용 한도($${limit}) 초과. 현재 누적: $${total.toFixed(4)}`);
  }
  return total;
}

async function logApiCost(storeId, agentType, tokensIn, tokensOut) {
  const costUsd = (tokensIn * 0.10 + tokensOut * 0.40) / 1_000_000;
  await supabase.from('api_events').insert({
    store_id:    storeId,
    agent_type:  agentType,
    tokens_in:   tokensIn,
    tokens_out:  tokensOut,
    cost_usd:    costUsd,
  });
}

async function callGemini(url, body, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const res = await axios.post(url, body);
      return res;
    } catch (e) {
      if (e.response?.status === 429 && i < retries - 1) {
        const wait = (i + 1) * 5000;
        console.log(`[Gemini] 429 rate limit, ${wait/1000}초 후 재시도...`);
        await new Promise(r => setTimeout(r, wait));
      } else {
        throw e;
      }
    }
  }
}

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const GEMINI_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent';
const EMBED_URL  = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent';

// ─────────────────────────────────────────────
// 유저 쿼리 → 벡터
// ─────────────────────────────────────────────
async function embedQuery(text) {
  const res = await callGemini(
    `${EMBED_URL}?key=${process.env.GOOGLE_AI_API_KEY}`,
    { model: 'models/gemini-embedding-001', content: { parts: [{ text }] } }
  );
  return res.data.embedding.values;
}

// ─────────────────────────────────────────────
// Supabase 벡터 검색
// ─────────────────────────────────────────────
async function vectorSearch(embedding, mallId, count = 8) {
  const { data, error } = await supabase.rpc('match_products', {
    query_embedding: JSON.stringify(embedding),
    match_store_id:  mallId,
    match_count:     count,
  });
  if (error) throw new Error(error.message);
  return data || [];
}

// ─────────────────────────────────────────────
// Agent 1 — 인텐트 분석
// 유저가 말한 것의 진짜 의미를 파악
// ─────────────────────────────────────────────
async function analyzeIntent(query, conversationHistory = []) {
  const historyText = conversationHistory.length
    ? '이전 대화:\n' + conversationHistory.map(m => `${m.role}: ${m.content}`).join('\n') + '\n\n'
    : '';

  const prompt = `${historyText}유저 메시지: "${query}"

당신은 패션 쇼핑몰의 인텐트 분석 전문가입니다.
유저가 말한 것에서 다음을 JSON으로 추출하세요:

{
  "situation": "유저가 처한 상황 (예: 소개팅, 출장, 일상, 선물 구매 등)",
  "needs": "진짜 필요한 것 (외모, 기능, 감정적 니즈 포함)",
  "constraints": "제약 조건 (예산, 사이즈, 색상, 제외 조건 등)",
  "assumptions": "합리적으로 추측할 수 있는 것들",
  "search_query": "벡터 검색에 최적화된 확장된 검색 쿼리 (한국어, 최대 200자)",
  "clarification_needed": true/false,
  "clarification_question": "꼭 필요한 경우에만 질문 1개 (아니면 null)"
}

규칙:
- clarification_needed는 정말 모호해서 추천 자체가 불가능할 때만 true
- 가정을 세울 수 있다면 질문 없이 추천하는 쪽을 선택
- search_query는 상황, 감정, 스타일, 소재, 핏, 계절 등을 모두 포함해 풍부하게 작성

JSON만 응답하세요.`;

  const res = await callGemini(
    `${GEMINI_URL}?key=${process.env.GOOGLE_AI_API_KEY}`,
    { contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 500 } }
  );

  const text = res.data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  try {
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return { search_query: query, clarification_needed: false };
  }
}

// ─────────────────────────────────────────────
// Agent 2 — 추천 생성
// 검색 결과를 유저 상황에 맞게 재해석하고 설명
// ─────────────────────────────────────────────
async function generateRecommendation(query, intent, products, brandProfile = null) {
  const brandTone = brandProfile?.system_prompt || '친근하고 따뜻하게, 진짜 친구처럼 솔직하게 말해주세요.';

  const productList = products.slice(0, 5).map((p, i) => {
    const attrs = p.attributes || {};
    return `[${i + 1}] ${p.name}
가격: ${p.price?.toLocaleString()}원
소재/핏: ${attrs.material || ''}
설명: ${p.embed_text?.slice(0, 300) || ''}
유사도: ${(p.similarity * 100).toFixed(0)}%`;
  }).join('\n\n');

  const prompt = `당신은 유저를 진심으로 돕고 싶어하는, 패션을 잘 아는 친한 친구입니다.
유저의 말 뒤에 숨은 진짜 니즈를 이해하고, 단순한 상품 나열이 아니라
"나를 제대로 이해해 주었어"라는 말이 나오도록 추천해주세요.

브랜드 톤: ${brandTone}

유저 상황 분석:
- 상황: ${intent.situation || ''}
- 진짜 니즈: ${intent.needs || ''}
- 제약 조건: ${intent.constraints || '없음'}
- 가정: ${intent.assumptions || ''}

유저 메시지: "${query}"

검색된 상품들:
${productList}

다음 형식으로 응답하세요:

먼저 유저의 상황을 한 문장으로 공감해주세요.
그 다음 상품 2~3개를 추천하되, 각 상품마다:
- 왜 이 상황에 이 상품인지 구체적으로 설명
- 장단점 trade-off를 솔직하게
- 숫자([1], [2] 등)로 시작

마지막에 가볍게 한 줄 덧붙이거나, 꼭 필요한 경우에만 질문 1개.

규칙:
- 모든 상품을 나열하지 말 것. 진짜 맞는 것만
- "~하시면 됩니다" 같은 딱딱한 말투 금지
- 가격이 예산을 약간 초과해도 가치 있으면 솔직하게 말해줄 것
- 200자 이내로 간결하게`;

  const res = await callGemini(
    `${GEMINI_URL}?key=${process.env.GOOGLE_AI_API_KEY}`,
    { contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 600 } }
  );

  return res.data.candidates?.[0]?.content?.parts?.[0]?.text || '죄송해요, 다시 시도해주세요.';
}

// ─────────────────────────────────────────────
// 메인 추천 파이프라인
// ─────────────────────────────────────────────
async function recommend({ mallId, query, conversationHistory = [] }) {
  // 비용 한도 체크
  await checkCostLimit();

  // Agent 1: 인텐트 분석
  const intent = await analyzeIntent(query, conversationHistory);
  await logApiCost(mallId, 'intent_analysis', 2000, 500);

  // 명확화 질문이 필요한 경우 바로 반환
  if (intent.clarification_needed && intent.clarification_question) {
    return {
      type: 'clarification',
      message: intent.clarification_question,
      products: [],
    };
  }

  // 벡터 검색
  const searchQuery = intent.search_query || query;
  const queryEmbedding = await embedQuery(searchQuery);
  const products = await vectorSearch(queryEmbedding, mallId);

  if (!products.length) {
    return {
      type: 'no_results',
      message: '아직 등록된 상품 중에서는 딱 맞는 걸 못 찾았어요. 다르게 설명해주시면 다시 찾아볼게요!',
      products: [],
    };
  }

  // 브랜드 프로필 조회
  const { data: brandProfile } = await supabase
    .from('brand_profiles')
    .select('system_prompt, tone_keywords')
    .eq('store_id', mallId)
    .single();

  // Agent 2: 추천 생성
  const message = await generateRecommendation(query, intent, products, brandProfile);
  await logApiCost(mallId, 'response_generation', 3000, 600);

  // 추천에 언급된 상품 인덱스 파싱 ([1], [2], [3])
  const mentionedIndices = [...message.matchAll(/\[(\d+)\]/g)]
    .map(m => parseInt(m[1]) - 1)
    .filter(i => i >= 0 && i < products.length);

  const recommendedProducts = mentionedIndices.length
    ? mentionedIndices.map(i => products[i])
    : products.slice(0, 3);

  return {
    type: 'recommendation',
    message,
    products: recommendedProducts.map(p => ({
      id:         p.product_id,
      name:       p.name,
      price:      p.price,
      similarity: p.similarity,
      attributes: p.attributes,
    })),
    intent,
  };
}

module.exports = { recommend };
