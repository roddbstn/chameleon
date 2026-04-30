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

const GEMINI_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.0-flash',
  'gemini-1.5-flash',
];
const EMBED_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent';

function geminiUrl(model) {
  return `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
}

// 429 → 재시도, 503 → 다음 모델로 폴백
async function callGemini(url, body) {
  // url에서 모델 추출해 fallback 체인 시작점 결정
  const urlModel = url.match(/models\/([^:]+)/)?.[1] || GEMINI_MODELS[0];
  const startIdx = GEMINI_MODELS.indexOf(urlModel);
  const models   = GEMINI_MODELS.slice(startIdx < 0 ? 0 : startIdx);

  for (const model of models) {
    const endpoint = geminiUrl(model) + '?key=' + process.env.GOOGLE_AI_API_KEY;
    for (let retry = 0; retry < 2; retry++) {
      try {
        const res = await axios.post(endpoint, body);
        if (model !== urlModel) console.log(`[Gemini] fallback 성공: ${model}`);
        return res;
      } catch (e) {
        const status = e.response?.status;
        if (status === 429) {
          const wait = (retry + 1) * 5000;
          console.log(`[Gemini] ${model} 429, ${wait/1000}초 후 재시도...`);
          await new Promise(r => setTimeout(r, wait));
        } else if (status === 503) {
          console.warn(`[Gemini] ${model} 503, 다음 모델 시도...`);
          break; // 이 모델 포기, 다음 모델로
        } else {
          throw e;
        }
      }
    }
  }
  throw new Error('All Gemini models unavailable');
}

// GEMINI_URL은 하위 호환용 (callGemini가 모델 체인 처리)
const GEMINI_URL = geminiUrl(GEMINI_MODELS[0]);

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
  "color_filter": {
    "include": ["유저가 원하는 색상 키워드 배열 (예: 화이트, 베이지, 라이트 블루). 색상 언급 없으면 빈 배열"],
    "exclude": ["유저가 명시적으로 피하거나, 밝은 색 요청 시 어두운 색 계열 키워드 (예: 블랙, 네이비, 다크). 없으면 빈 배열"]
  },
  "clarification_needed": true/false,
  "clarification_question": "꼭 필요한 경우에만 질문 1개 (아니면 null)"
}

규칙:
- clarification_needed는 정말 모호해서 추천 자체가 불가능할 때만 true
- 가정을 세울 수 있다면 질문 없이 추천하는 쪽을 선택
- search_query는 상황, 감정, 스타일, 소재, 핏, 계절 등을 모두 포함해 풍부하게 작성
- color_filter.exclude: "밝은 색" 요청이면 블랙/차콜/네이비/다크 계열 추가, "어두운 색" 요청이면 화이트/크림/베이지 계열 추가

JSON만 응답하세요.`;

  const res = await callGemini(
    `${GEMINI_URL}?key=${process.env.GOOGLE_AI_API_KEY}`,
    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 500, thinkingConfig: { thinkingBudget: 0 } },
    }
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
  const brandTone = brandProfile?.system_prompt || '고급 패션 매장의 숙련된 어드바이저처럼, 정중하고 섬세하며 따뜻한 존댓말로 응대하세요. 유머나 가벼운 말투는 금지이며, 신뢰감 있는 전문가 톤을 유지하세요.';

  const productList = products.slice(0, 5).map((p, i) => {
    const attrs = p.attributes || {};
    return `${i + 1}. ${p.name}
가격: ${p.price?.toLocaleString()}원
소재/핏: ${attrs.material || ''}
설명: ${p.embed_text?.slice(0, 300) || ''}
유사도: ${(p.similarity * 100).toFixed(0)}%`;
  }).join('\n\n');

  const prompt = `당신은 패션을 잘 아는 쇼핑 어드바이저입니다.
유저의 말 뒤에 숨은 진짜 니즈를 이해하고, "나를 제대로 이해해 주었어"라는 반응이 나오도록 추천해주세요.

브랜드 톤 가이드: ${brandTone}

유저 상황 분석:
- 상황: ${intent.situation || ''}
- 진짜 니즈: ${intent.needs || ''}
- 제약 조건: ${intent.constraints || '없음'}
- 가정: ${intent.assumptions || ''}

유저 메시지: "${query}"

검색된 상품들:
${productList}

응답 형식:
1. 유저 상황을 한 문장으로 공감 (인사말 없이 바로 시작)
2. 상품 2~3개 추천, 각각:
   - 1., 2. 등 번호로 시작
   - 이 상황에 왜 이 상품인지 구체적 이유
   - 솔직한 장단점
3. 마지막에 짧은 한 마디 (필요한 경우에만 질문 1개)

말투 규칙:
- "안녕하세요", "야", "안녕" 같은 인사로 절대 시작하지 말 것
- 존댓말 사용: "~해요", "~거예요", "~답니다" (부드럽고 자연스럽게)
- "~하시면 됩니다", "~해주시기 바랍니다" 같은 사무적·딱딱한 표현 금지
- 유머, 이모지, 가볍거나 친구 같은 말투 금지 — 신뢰감 있는 전문가 톤 유지
- 문장을 반드시 완성해서 끝낼 것 — 중간에 절대 끊기지 말 것
- 모든 상품 나열 금지, 진짜 맞는 것만

응답 텍스트 맨 끝(줄바꿈 후)에 반드시 아래 두 줄을 추가하세요:
PRODUCTS:[추천한 상품 번호를 응답에 나온 순서대로, 예: 2,1,3]
REASONS:{"1":"응답에서 첫 번째로 소개한 상품의 핵심 이유 (형용사 포함, 40자 이내)","2":"두 번째 상품 이유","3":"세 번째 상품 이유(있는 경우만)"}
(PRODUCTS, REASONS 줄은 UI에서 파싱 후 제거되며 대화에 노출되지 않습니다)`;

  const res = await callGemini(
    `${GEMINI_URL}?key=${process.env.GOOGLE_AI_API_KEY}`,
    {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 1000, thinkingConfig: { thinkingBudget: 0 } },
    }
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
    Promise.resolve(supabase.from('chat_logs').insert({ store_id: mallId, query, result_type: 'clarification', product_count: 0 })).catch(() => {});
    return {
      type: 'clarification',
      message: intent.clarification_question,
      products: [],
    };
  }

  // 벡터 검색
  const searchQuery = intent.search_query || query;
  const queryEmbedding = await embedQuery(searchQuery);
  const rawProducts = await vectorSearch(queryEmbedding, mallId);

  // product_id 기준 중복 제거
  const seen = new Set();
  let products = rawProducts.filter(p => {
    if (seen.has(p.product_id)) return false;
    seen.add(p.product_id);
    return true;
  });

  if (!products.length) {
    Promise.resolve(supabase.from('chat_logs').insert({ store_id: mallId, query, result_type: 'no_results', product_count: 0 })).catch(() => {});
    return {
      type: 'no_results',
      message: '아직 등록된 상품 중에서는 딱 맞는 걸 못 찾았어요. 다르게 설명해주시면 다시 찾아볼게요!',
      products: [],
    };
  }

  // 색상 필터링: 제외 색상 키워드가 있으면 상품명/설명에서 필터링
  const colorFilter = intent.color_filter || {};
  const excludeColors = (colorFilter.exclude || []).map(c => c.toLowerCase());
  const includeColors = (colorFilter.include || []).map(c => c.toLowerCase());

  if (excludeColors.length) {
    const filtered = products.filter(p => {
      const text = ((p.name || '') + ' ' + (p.embed_text || '')).toLowerCase();
      return !excludeColors.some(c => text.includes(c));
    });
    // 필터링 후 상품이 2개 이상이면 적용, 아니면 원본 유지 (너무 많이 걸러지면 무시)
    if (filtered.length >= 2) products = filtered;
  }

  if (includeColors.length && products.length > 3) {
    const matched = products.filter(p => {
      const text = ((p.name || '') + ' ' + (p.embed_text || '')).toLowerCase();
      return includeColors.some(c => text.includes(c));
    });
    if (matched.length >= 2) products = matched;
  }

  // 이미지 URL 일괄 조회 (raw_data.list_image)
  const productIds = products.map(p => p.product_id);
  const { data: imgRows } = await supabase
    .from('products')
    .select('product_id, raw_data')
    .in('product_id', productIds);
  const imgMap = {};
  (imgRows || []).forEach(r => {
    imgMap[r.product_id] = r.raw_data?.list_image || r.raw_data?.detail_image || null;
  });

  // 브랜드 프로필 조회
  const { data: brandProfile } = await supabase
    .from('brand_profiles')
    .select('system_prompt, tone_keywords')
    .eq('store_id', mallId)
    .single();

  // Agent 2: 추천 생성
  const rawMessage = await generateRecommendation(query, intent, products, brandProfile);
  await logApiCost(mallId, 'response_generation', 3000, 600);

  // PRODUCTS + REASONS 파싱 & 메시지에서 제거
  let reasons = {};
  let message = rawMessage;

  const reasonsMatch = message.match(/\nREASONS:(\{[^\n]+\})/);
  if (reasonsMatch) {
    try { reasons = JSON.parse(reasonsMatch[1]); } catch {}
    message = message.replace(reasonsMatch[0], '').trim();
  }

  // PRODUCTS:[2,1,3] — LLM이 실제로 선택한 상품 번호(1-based)를 순서대로 명시
  let selectedIndices = [];
  const productsMatch = message.match(/\nPRODUCTS:\[([^\]]+)\]/);
  if (productsMatch) {
    selectedIndices = productsMatch[1]
      .split(',')
      .map(n => parseInt(n.trim()) - 1)
      .filter(i => i >= 0 && i < products.length);
    message = message.replace(productsMatch[0], '').trim();
  }

  // PRODUCTS 파싱 실패 시 fallback: 응답 텍스트의 줄 시작 숫자 파싱
  if (!selectedIndices.length) {
    selectedIndices = [...new Set(
      [...message.matchAll(/^(\d+)\./gm)]
        .map(m => parseInt(m[1]) - 1)
        .filter(i => i >= 0 && i < products.length)
    )];
  }

  const recommendedProducts = selectedIndices.length
    ? selectedIndices.map(i => products[i])
    : products.slice(0, 3);

  // 대화 로그 저장
  Promise.resolve(supabase.from('chat_logs').insert({
    store_id:          mallId,
    query,
    intent_situation:  intent.situation || null,
    intent_needs:      intent.needs || null,
    result_type:       'recommendation',
    product_count:     recommendedProducts.length,
    product_ids:       recommendedProducts.map(p => String(p.product_id)),
  })).catch(() => {});

  return {
    type: 'recommendation',
    message,
    products: recommendedProducts.map((p, displayIdx) => ({
      id:         p.product_id,
      name:       p.name,
      price:      p.price,
      similarity: p.similarity,
      attributes: p.attributes,
      image_url:  imgMap[p.product_id] || null,
      reason:     reasons[String(displayIdx + 1)] || null,
    })),
    intent,
  };
}

module.exports = { recommend };
