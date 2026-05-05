const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

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

const GEMINI_CHAIN = [
  { model: 'gemini-2.5-flash', api: 'v1beta' },
  { model: 'gemini-1.5-flash', api: 'v1'     },
];
const EMBED_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent';

// generateContent 전용 — 429 재시도, 503/404 다음 모델 폴백
async function callGemini(body) {
  for (const { model, api } of GEMINI_CHAIN) {
    const endpoint = `https://generativelanguage.googleapis.com/${api}/models/${model}:generateContent?key=${process.env.GOOGLE_AI_API_KEY}`;
    for (let retry = 0; retry < 2; retry++) {
      try {
        const res = await axios.post(endpoint, body);
        if (model !== GEMINI_CHAIN[0].model) console.log(`[Gemini] fallback 성공: ${model} (${api})`);
        return res;
      } catch (e) {
        const status = e.response?.status;
        if (status === 429) {
          await new Promise(r => setTimeout(r, (retry + 1) * 5000));
        } else if (status === 503 || status === 404) {
          console.warn(`[Gemini] ${model} ${status}, 다음 모델 시도...`);
          break;
        } else {
          throw e;
        }
      }
    }
  }
  throw new Error('All Gemini models unavailable');
}

// ─────────────────────────────────────────────
// 유저 쿼리 → 벡터 (embedding은 fallback 체인 없이 직접 호출)
// ─────────────────────────────────────────────
async function embedQuery(text) {
  const url = `${EMBED_URL}?key=${process.env.GOOGLE_AI_API_KEY}`;
  const res = await axios.post(url, { model: 'models/gemini-embedding-001', content: { parts: [{ text }] } });
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

  // 대화 히스토리에서 성별 언급 여부 확인
  const fullHistory = conversationHistory.map(m => m.content || '').join(' ');
  const genderKnown = /남성|여성|남자|여자|남|여|men|women|man|woman|he|she/i.test(fullHistory + ' ' + query);
  // 이미 질문을 한 번이라도 했으면 다시는 묻지 않음
  const alreadyAsked = conversationHistory.some(m => m.role === 'assistant' && m.content?.includes('?'));

  const prompt = `${historyText}유저 메시지: "${query}"

당신은 패션 쇼핑몰의 인텐트 분석 전문가입니다.
유저가 말한 것에서 다음을 JSON으로 추출하세요:

{
  "intent_type": "specific | discovery | refinement",
  "situation": "유저가 처한 상황",
  "needs": "진짜 필요한 것",
  "constraints": "제약 조건 (없으면 null)",
  "assumptions": "합리적으로 추측할 수 있는 것들",
  "search_query": "벡터 검색에 최적화된 검색 쿼리 (한국어, 최대 200자)",
  "color_filter": {
    "include": ["원하는 색상 키워드. 없으면 빈 배열"],
    "exclude": ["피하는 색상. 없으면 빈 배열"]
  },
  "clarification_needed": false,
  "clarification_question": null
}

intent_type 판단 기준:
- "specific": 소재·카테고리·색상·상황·상품명 등 구체적 단서가 있음 (예: "뱀피 상의", "검정 팬츠", "소개팅 코디")
- "discovery": 자기 스타일을 모르거나 막연하게 탐색 중 (예: "뭘 사야 할지 모르겠어", "요즘 유행하는 게 뭐야", "어떤 옷이 어울릴까", "옷 추천해줘" 처럼 카테고리·소재·상황 단서가 전혀 없음)
- "refinement": 이전 추천에 대한 반응·수정 요청 (예: "이런 거 말고", "더 캐주얼하게", "비슷한데 다른 색으로")

${alreadyAsked ? '이미 이 대화에서 질문을 했으므로 clarification_needed는 항상 false.' : ''}
clarification_needed는 항상 false, clarification_question은 항상 null.
search_query는 상황·스타일·소재·핏·계절 등을 포함해 풍부하게 작성.
color_filter.exclude: "밝은 색" 요청이면 블랙/차콜/네이비/다크 계열 추가.

JSON만 응답하세요.`;

  const res = await callGemini({
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
// Discovery 모드 — 스타일 버킷별 병렬 벡터 검색
// 스타일이 서로 다른 3개 방향에서 각 1~2개 상품을 가져와
// 유저가 "이게 좋아요/싫어요"로 반응할 수 있는 팔레트를 구성
// ─────────────────────────────────────────────
const STYLE_BUCKETS = [
  { label: '미니멀/클린',   query: '미니멀 베이직 클린 심플 모던 뉴트럴 톤 깔끔한 실루엣' },
  { label: '캐주얼/스트릿', query: '캐주얼 스트릿 오버핏 루즈 편안한 데일리 후드 맨투맨' },
  { label: '트렌디/유니크', query: '트렌디 포인트 유니크 개성 프린트 컬러 감각적인 시즌' },
];

async function discoverySearch(mallId) {
  // 3개 스타일 버킷 병렬 임베딩 + 검색
  const results = await Promise.all(
    STYLE_BUCKETS.map(async (bucket) => {
      try {
        const embedding = await embedQuery(bucket.query);
        const hits = await vectorSearch(embedding, mallId, 4);
        return { bucket: bucket.label, hits };
      } catch {
        return { bucket: bucket.label, hits: [] };
      }
    })
  );

  // 버킷별 상위 2개씩, 전체 중복 제거
  const seen = new Set();
  const palette = [];
  for (const { bucket, hits } of results) {
    let count = 0;
    for (const p of hits) {
      if (seen.has(p.product_id)) continue;
      seen.add(p.product_id);
      palette.push({ ...p, styleBucket: bucket });
      if (++count >= 2) break;
    }
  }
  return palette; // 최대 6개, 3가지 스타일 방향
}

// ─────────────────────────────────────────────
// Agent 2 — 추천 생성
// ─────────────────────────────────────────────
async function generateRecommendation(query, intent, products, brandProfile = null, mode = 'specific') {
  const brandTone = brandProfile?.system_prompt || '고급 패션 매장의 숙련된 어드바이저처럼, 정중하고 섬세하며 따뜻한 존댓말로 응대하세요. 유머나 가벼운 말투는 금지이며, 신뢰감 있는 전문가 톤을 유지하세요.';

  const productList = products.slice(0, 5).map((p, i) => {
    const attrs = p.attributes || {};
    const text = (p.name + ' ' + (p.embed_text || '')).toLowerCase();
    // 상품명·설명에서 성별 타겟 자동 추론
    const genderHint =
      /여성|우먼|women|girl|lady|she/.test(text) ? '여성 타겟' :
      /남성|맨즈|men|guy|man\b|he\b/.test(text) ? '남성 타겟' : '남녀공용';
    return `${i + 1}. ${p.name}
가격: ${p.price?.toLocaleString()}원
성별 타겟: ${genderHint}
소재/핏: ${attrs.material || ''}
설명: ${p.embed_text?.slice(0, 300) || ''}
유사도: ${(p.similarity * 100).toFixed(0)}%`;
  }).join('\n\n');

  const isDiscovery = mode === 'discovery';
  const isRefinement = mode === 'refinement';

  const modeInstruction = isDiscovery ? `
【스타일 발견 모드】
유저가 자신의 스타일을 모르는 상태입니다. 말로 설명하게 하지 말고, 스타일이 서로 다른 실제 상품을 보여줘서 반응을 이끌어내세요.

응답 형식:
1. "스타일이 다른 몇 가지를 가져왔어요. 어떤 느낌이 끌리시는지 반응해주시면 바로 좁혀드릴게요." (한 문장)
2. 상품 3개를 각각 다른 스타일로 소개:
   - 스타일 방향 레이블 표시 (예: **미니멀/클린**, **캐주얼/스트릿**, **트렌디/유니크**)
   - 상품명 정확히 포함
   - 이 스타일이 어떤 사람/상황에 어울리는지 2문장 이내로
3. 마지막: "마음에 드는 방향이 있으신가요, 아니면 다른 느낌을 원하세요?" (한 문장)
` : isRefinement ? `
【취향 반영 모드】
유저가 이전 추천에 반응하거나 방향을 수정 중입니다. 그 피드백을 정확히 반영해 새 추천을 주세요.

응답 형식:
1. 유저의 피드백을 한 문장으로 반영 ("더 캐주얼한 방향으로 골라봤어요." 등)
2. 수정된 방향의 상품 2~3개
3. 필요하면 짧은 후속 질문 1개 (없어도 됨)
` : `
【구체적 추천 모드】
응답 형식:
1. 유저 니즈를 한 문장으로 짚기 (인사말 없이 바로 시작)
2. 상품 2~3개 추천, 각각:
   - 1., 2. 등 번호로 시작
   - 상품명을 정확히 포함할 것
   - 성별 타겟 정보를 활용해 맥락에 맞게 설명
   - 이 상황에 왜 이 상품인지 구체적 이유
   - 소재·핏·착용감 등 실질적 정보
3. 마지막에 — 로 이어지는 짧은 자연스러운 후속 질문 1개 (선택사항, 추천을 좁혀줄 수 있는 경우만)
`;

  const prompt = `당신은 패션 확신이 있는 쇼핑 어드바이저입니다.
${modeInstruction}

브랜드 톤 가이드: ${brandTone}

유저 상황 분석:
- 상황: ${intent.situation || ''}
- 진짜 니즈: ${intent.needs || ''}
- 제약 조건: ${intent.constraints || '없음'}
- 가정: ${intent.assumptions || ''}

유저 메시지: "${query}"

검색된 상품들:
${productList}

★ 모든 모드에서 절대 금지:
- 추천보다 질문을 먼저 하는 것
- "어떤 스타일이 좋으세요?", "코디 스타일이 있으신가요?" 같은 추상적 취향 역질문
- 2개 이상의 질문 나열

말투 규칙:
- "안녕하세요", "야", "안녕" 같은 인사로 절대 시작하지 말 것
- 존댓말 사용: "~해요", "~거예요", "~답니다" (부드럽고 자연스럽게)
- "~하시면 됩니다", "~해주시기 바랍니다" 같은 사무적 표현 금지
- 유머, 이모지, 가볍거나 친구 같은 말투 금지 — 신뢰감 있는 전문가 톤
- 문장을 반드시 완성해서 끝낼 것

응답 텍스트 맨 끝(줄바꿈 후)에 반드시 아래 두 줄을 추가하세요:
PRODUCTS:[추천한 상품 번호를 응답에 나온 순서대로, 예: 2,1,3]
REASONS:{"1":"응답에서 첫 번째로 소개한 상품의 핵심 이유 (형용사 포함, 40자 이내)","2":"두 번째 상품 이유","3":"세 번째 상품 이유(있는 경우만)"}
(PRODUCTS, REASONS 줄은 UI에서 파싱 후 제거되며 대화에 노출되지 않습니다)`;

  const res = await callGemini({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 1000, thinkingConfig: { thinkingBudget: 0 } },
  });

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

  // 모드 결정: discovery / refinement / specific
  const mode = intent.intent_type || 'specific';

  // ── Discovery 모드: 스타일 팔레트 병렬 검색 ──
  if (mode === 'discovery') {
    const palette = await discoverySearch(mallId);
    if (!palette.length) {
      return { type: 'no_results', message: '등록된 상품을 불러오는 데 문제가 생겼어요. 잠시 후 다시 시도해주세요.', products: [] };
    }

    // 이미지·가격 보강
    const palIds = palette.map(p => p.product_id);
    const { data: palRows } = await supabase.from('products').select('product_id, price, raw_data').in('product_id', palIds);
    const palImgMap = {}, palPriceMap = {};
    (palRows || []).forEach(r => {
      palImgMap[r.product_id] = r.raw_data?.list_image || r.raw_data?.detail_image || null;
      if (r.price) palPriceMap[r.product_id] = r.price;
    });
    const enrichedPalette = palette.map(p => ({
      ...p,
      price: palPriceMap[p.product_id] || p.price,
      image: palImgMap[p.product_id] || null,
      url: p.product_id ? `/product/detail.html?product_no=${p.product_id}` : null,
    }));

    const { data: brandProfile } = await supabase.from('brand_profiles').select('system_prompt, tone_keywords').eq('store_id', mallId).single();
    const rawMessage = await generateRecommendation(query, intent, enrichedPalette, brandProfile, 'discovery');
    await logApiCost(mallId, 'response_generation', 3000, 600);

    let message = rawMessage.replace(/\n?PRODUCTS:\[?[^\]\n]*\]?/g, '').replace(/\n?REASONS:\{[^\n]+\}/g, '').trim();
    const msgLower = message.toLowerCase();
    const mentionedProducts = enrichedPalette
      .filter(p => msgLower.includes(p.name.toLowerCase()))
      .sort((a, b) => msgLower.indexOf(a.name.toLowerCase()) - msgLower.indexOf(b.name.toLowerCase()));
    const recommendedProducts = mentionedProducts.length ? mentionedProducts : enrichedPalette.slice(0, 3);

    Promise.resolve(supabase.from('chat_logs').insert({ store_id: mallId, query, result_type: 'discovery', product_count: recommendedProducts.length })).catch(() => {});
    return { type: 'recommendation', message, products: recommendedProducts };
  }

  // ── Specific / Refinement 모드: 일반 벡터 검색 ──
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

  // 이미지 URL + 가격 일괄 조회
  const productIds = products.map(p => p.product_id);
  const { data: imgRows } = await supabase
    .from('products')
    .select('product_id, price, raw_data')
    .in('product_id', productIds);
  const imgMap = {};
  const priceMap = {};
  (imgRows || []).forEach(r => {
    imgMap[r.product_id] = r.raw_data?.list_image || r.raw_data?.detail_image || null;
    if (r.price) priceMap[r.product_id] = r.price;
  });

  // 브랜드 프로필 조회
  const { data: brandProfile } = await supabase
    .from('brand_profiles')
    .select('system_prompt, tone_keywords')
    .eq('store_id', mallId)
    .single();

  // Agent 2: 추천 생성
  const rawMessage = await generateRecommendation(query, intent, products, brandProfile, mode);
  await logApiCost(mallId, 'response_generation', 3000, 600);

  // REASONS 태그 파싱 & 메시지에서 제거
  let reasons = {};
  let message = rawMessage;

  const reasonsMatch = message.match(/\nREASONS:(\{[^\n]+\})/);
  if (reasonsMatch) {
    try { reasons = JSON.parse(reasonsMatch[1]); } catch {}
    message = message.replace(reasonsMatch[0], '').trim();
  }

  // PRODUCTS 태그는 메시지에서 제거만 (표시 안 함)
  // AI가 PRODUCTS:[1,2,3] 또는 PRODUCTS:1,2 등 다양한 형태로 출력
  message = message.replace(/\n?PRODUCTS:\[?[^\]\n]*\]?/g, '').trim();
  // Goodbye, REASONS 뒤 남은 잔여물도 제거
  message = message.replace(/\n?Goodbye\.?$/i, '').trim();

  // ★ 핵심: AI 메시지 텍스트에서 실제로 언급된 상품명을 벡터 풀에서 직접 매칭
  // → PRODUCTS 태그 의존을 제거하여 텍스트-카드 불일치 방지
  const msgLower = message.toLowerCase();
  const mentionedByName = products
    .filter(p => msgLower.includes(p.name.toLowerCase()))
    .sort((a, b) =>
      msgLower.indexOf(a.name.toLowerCase()) - msgLower.indexOf(b.name.toLowerCase())
    );

  // fallback: 메시지에 이름이 없으면 줄 시작 숫자 파싱 → 그것도 없으면 상위 3개
  let recommendedProducts;
  if (mentionedByName.length) {
    recommendedProducts = mentionedByName;
  } else {
    const indexedFallback = [...new Set(
      [...message.matchAll(/^(\d+)\./gm)]
        .map(m => parseInt(m[1]) - 1)
        .filter(i => i >= 0 && i < products.length)
    )].map(i => products[i]);
    recommendedProducts = indexedFallback.length ? indexedFallback : products.slice(0, 3);
  }

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
      price:      priceMap[p.product_id] ?? p.price ?? null,
      similarity: p.similarity,
      attributes: p.attributes,
      image_url:  imgMap[p.product_id] || null,
      reason:     reasons[String(displayIdx + 1)] || null,
    })),
    intent,
  };
}

module.exports = { recommend };
