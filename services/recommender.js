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
// 브랜드 DNA → AI 시스템 프롬프트 조립
// agent_config(shops 테이블)의 structured 필드를 사용
// ─────────────────────────────────────────────
function buildSystemPrompt(agentConfig = {}, brandName = '') {
  const name       = agentConfig.agentName      || brandName || 'AI 쇼핑 도우미';
  const tone       = agentConfig.tone           || 'friendly';
  const guidelines = agentConfig.guidelines     || '';
  const persona    = agentConfig.targetPersona  || '';
  const styleCodes = agentConfig.styleCodes     || '';
  const priceTier  = agentConfig.priceTier      || '';
  const prohibited = agentConfig.prohibitedExpressions || '';
  const seasonFocus = agentConfig.seasonFocus   || '';

  const toneGuide = {
    friendly: '친근하고 따뜻한 말투. "~해요", "~거예요" 체. 자연스러운 대화 흐름.',
    formal:   '격식 있고 정중한 말투. "~습니다", "~드립니다" 체. 신뢰감 있는 전문가 톤.',
    expert:   '정보 중심, 간결하고 핵심만. 소재·스펙·수치를 우선 제시. "~해요" 체 사용.',
    sensory:  '분위기 중심, 서정적이고 감성적인 묘사. 시각·촉각적 언어를 풍부하게. "~해요" 체.',
  }[tone] || '친근하고 따뜻한 말투.';

  return `당신은 ${brandName || '이 쇼핑몰'}의 전담 AI 쇼핑 어드바이저 "${name}"입니다.

## 브랜드 컨텍스트
${priceTier    ? `가격대: ${priceTier}` : ''}
${styleCodes   ? `브랜드 스타일 코드: ${styleCodes}` : ''}
${seasonFocus  ? `이번 시즌 강조 포인트: ${seasonFocus}` : ''}
${persona      ? `\n## 주요 고객 페르소나\n${persona}` : ''}
${guidelines   ? `\n## 브랜드 가이드라인\n${guidelines}` : ''}

## 응대 톤
${toneGuide}

## 절대 금지
${prohibited ? prohibited + '\n' : ''}- "안녕하세요", "안녕" 등 인사로 시작
- 2개 이상의 질문 나열
- "어떤 스타일이 좋으세요?" 같은 추상적 취향 역질문
- 추천보다 질문을 먼저 하는 것`.trim();
}

// ─────────────────────────────────────────────
// 유저 쿼리 → 벡터 임베딩
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
// Agent 1 — 인텐트 분석 (Who/What/Why 3레이어)
// ─────────────────────────────────────────────
async function analyzeIntent(query, conversationHistory = []) {
  const historyText = conversationHistory.length
    ? '이전 대화:\n' + conversationHistory.map(m => `${m.role}: ${m.content}`).join('\n') + '\n\n'
    : '';

  const fullHistory = conversationHistory.map(m => m.content || '').join(' ');
  const alreadyAsked = conversationHistory.some(m => m.role === 'assistant' && m.content?.includes('?'));

  const prompt = `${historyText}유저 메시지: "${query}"

당신은 커머스 고객 인텐트 분석 전문가입니다.
고객의 메시지 속에 숨겨진 3가지 레이어를 분석하세요.

{
  "intent_type": "specific | discovery | refinement | pdp_context | after_cart | size_guide | faq",
  "situation": "고객이 처한 TPO (상황/장소/행사)",
  "needs": "진짜 필요한 것 (기능, 감정, 사회적 맥락)",
  "constraints": "제약 조건 (예산, 체형 고민, 소재 기피 등. 없으면 null)",
  "assumptions": "문맥상 합리적으로 추론 가능한 정보",
  "search_query": "벡터 검색 최적화 쿼리 (TPO·스타일·소재·핏·계절 풍부하게 포함, 한국어, 최대 250자)",
  "color_filter": {
    "include": ["원하는 색상. 없으면 빈 배열"],
    "exclude": ["피하는 색상. 없으면 빈 배열"]
  },
  "intent_keywords": ["의도를 대표하는 핵심 키워드 3~5개. 예: 팔뚝커버, 하객룩, 결혼식"],
  "clarification_needed": false,
  "clarification_question": null
}

intent_type 판단:
- "specific": 소재·카테고리·색상·상황·상품명 등 구체적 단서 있음
- "discovery": 막연한 탐색, 스타일 모름 (단서 전혀 없음)
- "refinement": 이전 추천에 대한 반응/수정 요청
- "size_guide": "사이즈", "핏", "크게", "작게", "키", "몸무게" 언급
- "faq": 배송·교환·반품·정책 관련 질문
- "pdp_context"와 "after_cart"는 시스템이 직접 설정하므로 여기선 사용 안 함

${alreadyAsked ? 'clarification_needed는 항상 false.' : ''}
search_query: 질문 속 상황(예: 바닷가→휴양지 여름 시원한)·스타일·소재·핏·시즌을 연상 확장해 풍부하게.
color_filter.exclude: "밝은 색" 요청이면 블랙/차콜/네이비/다크 계열 추가.
intent_keywords: 이 대화 의도의 핵심 태그 (나중에 의도 데이터 분석에 사용됨).

JSON만 응답하세요.`;

  const res = await callGemini({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 600 },
  });

  const text = res.data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  try {
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return { search_query: query, clarification_needed: false, intent_keywords: [] };
  }
}

// ─────────────────────────────────────────────
// Discovery 모드 — 스타일 버킷별 병렬 벡터 검색
// ─────────────────────────────────────────────
const STYLE_BUCKETS = [
  { label: '미니멀/클린',   query: '미니멀 베이직 클린 심플 모던 뉴트럴 톤 깔끔한 실루엣' },
  { label: '캐주얼/스트릿', query: '캐주얼 스트릿 오버핏 루즈 편안한 데일리 후드 맨투맨' },
  { label: '트렌디/유니크', query: '트렌디 포인트 유니크 개성 프린트 컬러 감각적인 시즌' },
];

async function discoverySearch(mallId) {
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
  return palette;
}

// ─────────────────────────────────────────────
// 상품 카드 포맷터 — AI 프롬프트용 텍스트 생성
// ─────────────────────────────────────────────
function formatProductForPrompt(p, index) {
  const attrs = p.attributes || {};
  const text = (p.name + ' ' + (p.embed_text || '')).toLowerCase();
  const genderHint =
    /여성|우먼|women|girl|lady/.test(text) ? '여성 타겟' :
    /남성|맨즈|men|guy/.test(text)         ? '남성 타겟' : '남녀공용';

  return `${index + 1}. [${p.styleBucket || ''}] ${p.name}
가격: ${p.price?.toLocaleString() || '미정'}원 | 성별: ${genderHint}
소재/핏: ${attrs.material || attrs.fit || '-'}
설명: ${(p.embed_text || '').slice(0, 350)}
유사도: ${p.similarity ? (p.similarity * 100).toFixed(0) + '%' : '-'}`;
}

// ─────────────────────────────────────────────
// Agent 2 — 추천 생성
// systemPrompt: buildSystemPrompt()로 조립된 브랜드 DNA
// context: { pdpProduct, mode }
// ─────────────────────────────────────────────
async function generateRecommendation(query, intent, products, systemPrompt, mode = 'specific', context = {}) {
  const productList = products.slice(0, 5).map((p, i) => formatProductForPrompt(p, i)).join('\n\n');

  // ── PDP 컨텍스트 블록 ──
  const pdpBlock = context.pdpProduct ? `
## 고객이 현재 보고 있는 상품
상품명: ${context.pdpProduct.name}
설명: ${(context.pdpProduct.embed_text || '').slice(0, 200)}
→ 이 상품을 기준으로 "함께 코디하면 좋은" 또는 "이 상품 대신 고려할" 상품을 추천하세요.
` : '';

  // ── 모드별 응답 지침 ──
  const modeInstruction = {
    discovery: `
【스타일 발견 모드】
고객이 막연하게 탐색 중입니다. 설명을 묻지 말고, 서로 다른 스타일의 실제 상품 3개를 보여줘 반응을 이끌어내세요.

응답 형식:
1. "스타일이 다른 몇 가지를 가져왔어요. 어떤 느낌이 끌리시는지 반응해주시면 바로 좁혀드릴게요." (한 문장)
2. 상품 3개 — 각각 스타일 레이블(**미니멀/클린**, **캐주얼/스트릿**, **트렌디/유니크**)과 함께 2문장 이내 소개
3. "마음에 드는 방향이 있으신가요, 아니면 다른 느낌을 원하세요?" (한 문장)`,

    refinement: `
【취향 반영 모드】
고객이 이전 추천에 피드백을 주었습니다. 그 피드백을 정확히 반영해 새 추천을 주세요.

응답 형식:
1. 피드백 반영 한 문장 ("더 캐주얼한 방향으로 골라봤어요." 등)
2. 수정된 방향의 상품 2~3개 (각 상품마다 이 상황에 왜 적합한지 구체적 이유)
3. 짧은 후속 질문 1개 (필요시만)`,

    pdp_context: `
【상품 페이지 컨텍스트 모드】
고객이 특정 상품 페이지에서 위젯을 열었습니다.${context.pdpProduct ? ' 현재 보는 상품 정보가 위에 제공됩니다.' : ''}

응답 형식:
1. 현재 상품 관련 짧은 코멘트 (1문장, "이 상품과 잘 어울리는" 또는 "비슷한 스타일로")
2. 연관 상품 2~3개 — 코디 조합 관점에서 왜 잘 맞는지 구체적으로
3. 짧은 후속 질문 1개 (필요시만)`,

    after_cart: `
【장바구니 추가 후 모드 — Cross-sell】
고객이 방금 상품을 장바구니에 담았습니다. 구매를 이미 결정한 상태이므로 압박하지 않고, 자연스럽게 코디 완성을 도와주세요.

응답 형식:
1. "담으셨군요! 이 상품과 함께 코디하면 좋은 아이템도 가져왔어요." (1문장, 자연스럽게)
2. 연관 상품 2개 — "함께 입으면 어떤 룩이 완성되는지" 관점에서 구체적으로
3. 선택지: "전체 코디로 완성하시겠어요, 아니면 다른 게 필요하신가요?" (1문장)`,

    size_guide: `
【사이즈/핏 가이드 모드】
고객이 사이즈나 핏에 대해 궁금해하고 있습니다.

응답 형식:
1. 질문한 상품의 핏 특성 설명 (1~2문장)
2. 사이즈 선택 기준 제시 (키/체형/착용감 기준으로)
3. 구체적 상품 추천 1~2개 (핏이 잘 맞는 이유 포함)`,

    specific: `
【구체적 추천 모드】
응답 형식:
1. 고객 니즈를 한 문장으로 짚기 (인사말 없이 바로 시작)
2. 상품 2~3개 — 각각:
   - 번호(1., 2.)로 시작
   - 상품명 정확히 포함
   - 이 상황에 왜 이 상품인지 구체적 이유 (소재·핏·착용감 포함)
   - **핵심 셀링포인트 1개** 굵게 강조 (예: **구김 없는 소재**, **팔뚝 커버**)
3. 짧은 후속 질문 1개 (선택사항)`,
  }[mode] || `【구체적 추천 모드】
1. 고객 니즈 한 문장 짚기
2. 상품 2~3개 (상품명 정확히, 이유 구체적으로)
3. 후속 질문 1개 (선택사항)`;

  const prompt = `${systemPrompt}

---
${pdpBlock}
${modeInstruction}

## 고객 인텐트 분석 결과
- 상황(TPO): ${intent.situation || '-'}
- 진짜 니즈: ${intent.needs || '-'}
- 제약 조건: ${intent.constraints || '없음'}
- 추론한 맥락: ${intent.assumptions || '-'}
- 핵심 의도 키워드: ${(intent.intent_keywords || []).join(', ') || '-'}

## 고객 메시지
"${query}"

## 검색된 상품 후보
${productList}

---
★ 공통 규칙:
- 문장을 반드시 완성해서 끝낼 것
- 이모지 금지
- 상품 설명 시 **굵게** 핵심 셀링포인트 1개 반드시 포함

응답 맨 끝(줄바꿈 후) 반드시 추가:
PRODUCTS:[응답에 나온 순서대로 번호, 예: 2,1,3]
REASONS:{"1":"첫 번째 상품 핵심 이유 (40자 이내)","2":"두 번째","3":"세 번째(있는 경우만)"}
(PRODUCTS, REASONS는 UI 파싱 후 제거됨)`;

  const res = await callGemini({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 1100 },
  });

  return res.data.candidates?.[0]?.content?.parts?.[0]?.text || '죄송해요, 다시 시도해주세요.';
}

// ─────────────────────────────────────────────
// 상품 이미지·가격 일괄 보강
// ─────────────────────────────────────────────
async function enrichProducts(products) {
  if (!products.length) return products;
  const ids = products.map(p => p.product_id);
  const { data: rows } = await supabase
    .from('products')
    .select('product_id, price, raw_data')
    .in('product_id', ids);

  const imgMap = {}, priceMap = {};
  (rows || []).forEach(r => {
    imgMap[r.product_id]   = r.raw_data?.list_image || r.raw_data?.detail_image || null;
    priceMap[r.product_id] = r.price;
  });

  return products.map(p => ({
    ...p,
    price: priceMap[p.product_id] ?? p.price ?? null,
    image: imgMap[p.product_id]   ?? null,
    url:   p.product_id ? `/product/detail.html?product_no=${p.product_id}` : null,
  }));
}

// ─────────────────────────────────────────────
// AI 응답에서 추천 상품 매칭
// ─────────────────────────────────────────────
function matchProductsFromMessage(message, products) {
  const msgLower = message.toLowerCase();

  // 1순위: 상품명 직접 언급
  const byName = products
    .filter(p => msgLower.includes(p.name.toLowerCase()))
    .sort((a, b) => msgLower.indexOf(a.name.toLowerCase()) - msgLower.indexOf(b.name.toLowerCase()));
  if (byName.length) return byName;

  // 2순위: 줄 시작 숫자 파싱
  const indexed = [...new Set(
    [...message.matchAll(/^(\d+)\./gm)]
      .map(m => parseInt(m[1]) - 1)
      .filter(i => i >= 0 && i < products.length)
  )].map(i => products[i]);
  if (indexed.length) return indexed;

  // 3순위: 상위 3개
  return products.slice(0, 3);
}

// ─────────────────────────────────────────────
// 메시지 정제 — 파싱 태그 제거
// ─────────────────────────────────────────────
function cleanMessage(raw) {
  return raw
    .replace(/\n?PRODUCTS:\[?[^\]\n]*\]?/g, '')
    .replace(/\n?REASONS:\{[^\n]+\}/g, '')
    .replace(/\n?Goodbye\.?$/i, '')
    .trim();
}

// ─────────────────────────────────────────────
// REASONS 태그 파싱
// ─────────────────────────────────────────────
function parseReasons(raw) {
  const match = raw.match(/\nREASONS:(\{[^\n]+\})/);
  if (!match) return {};
  try { return JSON.parse(match[1]); } catch { return {}; }
}

// ─────────────────────────────────────────────
// 메인 추천 파이프라인
// ─────────────────────────────────────────────
async function recommend({ mallId, query, conversationHistory = [], context = {} }) {
  await checkCostLimit();

  // ── 브랜드 DNA 로드 (shops.agent_config) ──
  const { data: shopData } = await supabase
    .from('shops')
    .select('brand_name, agent_config')
    .eq('mall_id', mallId)
    .single();

  const agentConfig = shopData?.agent_config || {};
  const brandName   = shopData?.brand_name   || '';
  const systemPrompt = buildSystemPrompt(agentConfig, brandName);

  // ── PDP 컨텍스트 감지: pageUrl에서 product_no 파싱 ──
  let pdpProduct = null;
  const productNoMatch = (context.pageUrl || '').match(/product_no=(\d+)/);
  if (productNoMatch && context.mode !== 'after_cart') {
    const productNo = productNoMatch[1];
    const { data: pdpRows } = await supabase
      .from('products')
      .select('product_id, name, embed_text, price')
      .eq('store_id', mallId)
      .eq('product_id', productNo)
      .single();
    if (pdpRows) {
      pdpProduct = pdpRows;
      // PDP 모드로 자동 전환 (단, 이미 대화가 있으면 유지)
      if (!conversationHistory.length && !context.mode) {
        context = { ...context, mode: 'pdp_context' };
      }
    }
  }

  // ── 인텐트 분석 ──
  const intent = await analyzeIntent(query, conversationHistory);
  await logApiCost(mallId, 'intent_analysis', 2000, 500);

  // ── 모드 결정 ──
  // context.mode (after_cart, pdp_context 등) > intent.intent_type
  const mode = context.mode || intent.intent_type || 'specific';

  // ── FAQ 모드: 벡터 검색 없이 직접 답변 ──
  if (mode === 'faq') {
    const faqPrompt = `${systemPrompt}

고객 질문: "${query}"
이 쇼핑몰의 정책 관련 질문입니다. 알고 있는 일반적인 커머스 정책 기준으로 답변하되, "정확한 내용은 고객센터나 공지사항을 확인해주세요"라고 마무리하세요. 2~3문장.`;

    const faqRes = await callGemini({
      contents: [{ parts: [{ text: faqPrompt }] }],
      generationConfig: { maxOutputTokens: 300 },
    });
    const faqMsg = faqRes.data.candidates?.[0]?.content?.parts?.[0]?.text || '고객센터로 문의해주세요.';
    await logApiCost(mallId, 'faq', 1000, 200);
    Promise.resolve(supabase.from('chat_logs').insert({
      store_id: mallId, query, result_type: 'faq', product_count: 0,
      intent_keywords: intent.intent_keywords || [],
      session_id: context.sessionId || null, page_url: context.pageUrl || null, persona: context.persona || null,
    })).catch(() => {});
    return { type: 'faq', message: faqMsg, products: [], intent };
  }

  // ── Discovery 모드 ──
  if (mode === 'discovery') {
    const palette = await discoverySearch(mallId);
    if (!palette.length) {
      return { type: 'no_results', message: '등록된 상품을 불러오는 데 문제가 생겼어요. 잠시 후 다시 시도해주세요.', products: [] };
    }

    const enriched = await enrichProducts(palette);
    const rawMessage = await generateRecommendation(query, intent, enriched, systemPrompt, 'discovery', { pdpProduct });
    await logApiCost(mallId, 'response_generation', 3000, 700);

    const message = cleanMessage(rawMessage);
    const recommended = matchProductsFromMessage(message, enriched);

    Promise.resolve(supabase.from('chat_logs').insert({
      store_id: mallId, query, result_type: 'discovery',
      intent_keywords: intent.intent_keywords || [],
      product_count: recommended.length, product_ids: recommended.map(p => String(p.product_id)),
      session_id: context.sessionId || null, page_url: context.pageUrl || null, persona: context.persona || null,
    })).catch(() => {});

    return { type: 'recommendation', message, products: recommended, intent };
  }

  // ── Specific / Refinement / PDP / after_cart / size_guide 모드 ──
  const searchQuery = intent.search_query || query;

  // after_cart: 장바구니 담은 상품과 코디 가능한 상품 검색
  // pdp_context: 현재 보는 상품 기반으로 연관 상품 검색
  const searchBase = pdpProduct
    ? `${pdpProduct.name} ${pdpProduct.embed_text?.slice(0, 100) || ''} 코디 어울리는`
    : searchQuery;

  const queryEmbedding = await embedQuery(searchBase);
  const rawProducts = await vectorSearch(queryEmbedding, mallId);

  const seen = new Set();
  let products = rawProducts.filter(p => {
    if (seen.has(p.product_id)) return false;
    // PDP/after_cart 모드: 현재 상품 자체는 제외
    if (pdpProduct && p.product_id === pdpProduct.product_id) return false;
    seen.add(p.product_id);
    return true;
  });

  if (!products.length) {
    Promise.resolve(supabase.from('chat_logs').insert({
      store_id: mallId, query, result_type: 'no_results', product_count: 0,
      session_id: context.sessionId || null, page_url: context.pageUrl || null,
    })).catch(() => {});
    return { type: 'no_results', message: '아직 등록된 상품 중에서는 딱 맞는 걸 못 찾았어요. 다르게 설명해주시면 다시 찾아볼게요!', products: [] };
  }

  // ── 색상 필터 ──
  const colorFilter  = intent.color_filter || {};
  const excludeColors = (colorFilter.exclude || []).map(c => c.toLowerCase());
  const includeColors = (colorFilter.include || []).map(c => c.toLowerCase());

  if (excludeColors.length) {
    const filtered = products.filter(p => {
      const t = ((p.name || '') + ' ' + (p.embed_text || '')).toLowerCase();
      return !excludeColors.some(c => t.includes(c));
    });
    if (filtered.length >= 2) products = filtered;
  }
  if (includeColors.length && products.length > 3) {
    const matched = products.filter(p => {
      const t = ((p.name || '') + ' ' + (p.embed_text || '')).toLowerCase();
      return includeColors.some(c => t.includes(c));
    });
    if (matched.length >= 2) products = matched;
  }

  // ── 상품 이미지·가격 보강 ──
  const enriched = await enrichProducts(products);

  // ── 추천 생성 ──
  const rawMessage = await generateRecommendation(
    query, intent, enriched, systemPrompt, mode, { pdpProduct }
  );
  await logApiCost(mallId, 'response_generation', 3000, 700);

  const reasons  = parseReasons(rawMessage);
  const message  = cleanMessage(rawMessage);
  const recommended = matchProductsFromMessage(message, enriched);

  // ── 의도 데이터 저장 (intent_keywords 포함) ──
  Promise.resolve(supabase.from('chat_logs').insert({
    store_id:         mallId,
    query,
    intent_situation: intent.situation     || null,
    intent_needs:     intent.needs         || null,
    intent_keywords:  intent.intent_keywords || [],
    result_type:      mode === 'pdp_context' ? 'pdp_context' :
                      mode === 'after_cart'  ? 'after_cart'  : 'recommendation',
    product_count:    recommended.length,
    product_ids:      recommended.map(p => String(p.product_id)),
    session_id:       context.sessionId || null,
    page_url:         context.pageUrl   || null,
    persona:          context.persona   || null,
  })).catch(() => {});

  return {
    type: 'recommendation',
    message,
    products: recommended.map((p, i) => ({
      id:         p.product_id,
      name:       p.name,
      price:      p.price ?? null,
      similarity: p.similarity,
      attributes: p.attributes,
      image_url:  p.image ?? null,
      url:        p.url   ?? null,
      reason:     reasons[String(i + 1)] || null,
    })),
    intent,
    mode,
  };
}

module.exports = { recommend };
