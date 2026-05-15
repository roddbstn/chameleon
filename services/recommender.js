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
  { model: 'gemini-2.5-flash',          api: 'v1beta' },
  { model: 'gemini-2.0-flash',          api: 'v1'     },
  { model: 'gemini-2.0-flash-lite',     api: 'v1'     },
  { model: 'gemini-1.5-flash',          api: 'v1'     },
];
const EMBED_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent';

// OpenAI fallback — text-only 요청을 Gemini 응답 포맷으로 래핑
async function callOpenAIFallback(body) {
  if (!process.env.OPENAI_API_KEY) throw new Error('OPENAI_API_KEY not set');
  const textPart = body.contents?.[0]?.parts?.find(p => p.text);
  if (!textPart) throw new Error('No text content for OpenAI fallback');
  const maxTokens = Math.min(body.generationConfig?.maxOutputTokens || 1024, 16000);
  const r = await axios.post('https://api.openai.com/v1/chat/completions', {
    model: 'gpt-4o-mini',
    messages: [{ role: 'user', content: textPart.text }],
    max_tokens: maxTokens,
  }, {
    headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    timeout: 30000,
  });
  const text = r.data.choices?.[0]?.message?.content || '';
  console.log('[AI] OpenAI gpt-4o-mini fallback 성공');
  return { data: { candidates: [{ content: { parts: [{ text }] } }] } };
}

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
  // Gemini 전체 실패 → OpenAI 폴백
  try {
    return await callOpenAIFallback(body);
  } catch (openAiErr) {
    console.error('[AI] OpenAI fallback 실패:', openAiErr.message);
    throw new Error('All AI models unavailable');
  }
}

// ─────────────────────────────────────────────
// Gemini 스트리밍 — SSE 방식, onChunk 콜백으로 청크 전달
// ─────────────────────────────────────────────
async function callGeminiStream(body, onChunk) {
  for (const { model, api } of GEMINI_CHAIN) {
    const url = `https://generativelanguage.googleapis.com/${api}/models/${model}:streamGenerateContent?alt=sse&key=${process.env.GOOGLE_AI_API_KEY}`;
    try {
      const res = await axios.post(url, body, { responseType: 'stream', timeout: 60000 });
      let fullText = '';
      let sseBuffer = '';
      await new Promise((resolve, reject) => {
        res.data.on('data', chunk => {
          sseBuffer += chunk.toString('utf8');
          const lines = sseBuffer.split('\n');
          sseBuffer = lines.pop(); // 불완전한 마지막 줄 보류
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            const payload = line.slice(6).trim();
            if (!payload || payload === '[DONE]') continue;
            try {
              const parsed = JSON.parse(payload);
              const text = parsed.candidates?.[0]?.content?.parts?.[0]?.text || '';
              if (text) { fullText += text; onChunk(text); }
            } catch {}
          }
        });
        res.data.on('end', () => { onChunk.flush?.(); resolve(); });
        res.data.on('error', reject);
      });
      if (model !== GEMINI_CHAIN[0].model) console.log(`[Gemini Stream] fallback 성공: ${model}`);
      return fullText;
    } catch (e) {
      const status = e.response?.status;
      if (status === 503 || status === 404) {
        console.warn(`[Gemini Stream] ${model} ${status}, 다음 모델 시도...`);
        continue;
      }
      throw e;
    }
  }
  // Gemini 전부 실패 → OpenAI 폴백 (비스트리밍)
  const fallbackRes = await callOpenAIFallback(body);
  const text = fallbackRes.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
  onChunk(text);
  return text;
}

// PRODUCTS:/REASONS:/CHIPS: 태그 이전 텍스트만 스트림 콜백으로 전달하는 래퍼
function makeTagFilter(streamCallback) {
  if (!streamCallback) return null;
  let buf = '', sentTo = 0, tagHit = false;
  function onChunk(chunk) {
    buf += chunk;
    if (tagHit) return;
    const tagIdx = buf.indexOf('\nPRODUCTS:');
    if (tagIdx >= 0) {
      tagHit = true;
      const safe = buf.slice(sentTo, tagIdx);
      if (safe.trim()) streamCallback(safe);
      return;
    }
    const safeEnd = buf.length - 15; // 태그 경계가 청크에 걸릴 수 있으므로 15자 버퍼
    if (safeEnd > sentTo) { streamCallback(buf.slice(sentTo, safeEnd)); sentTo = safeEnd; }
  }
  // 스트림 종료 시 남은 버퍼 flush (PRODUCTS 태그 없는 경우 포함)
  onChunk.flush = () => {
    if (tagHit) return;
    const tagIdx = buf.indexOf('\nPRODUCTS:');
    const end = tagIdx >= 0 ? tagIdx : buf.length;
    const safe = buf.slice(sentTo, end);
    if (safe.trim()) streamCallback(safe);
    sentTo = end;
  };
  return onChunk;
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
async function vectorSearch(embedding, mallId, count = 8, priceFilter = {}) {
  const params = {
    query_embedding: JSON.stringify(embedding),
    match_store_id:  mallId,
    match_count:     count,
  };
  // RPC 레벨 가격 필터 — 후보군 자체를 좁혀 품질 향상
  if (priceFilter.price_max) params.filter_price_max = priceFilter.price_max;
  if (priceFilter.price_min) params.filter_price_min = priceFilter.price_min;

  const { data, error } = await supabase.rpc('match_products', params);
  if (error) throw new Error(error.message);
  return data || [];
}

// ─────────────────────────────────────────────
// 인텐트 캐시 — sessionId + query 기반, 5분 TTL
// ─────────────────────────────────────────────
const intentCache = new Map();
const INTENT_CACHE_TTL = 5 * 60 * 1000; // 5분

function getCachedIntent(sessionId, query) {
  if (!sessionId) return null;
  const key = `${sessionId}::${query}`;
  const entry = intentCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > INTENT_CACHE_TTL) {
    intentCache.delete(key);
    return null;
  }
  return entry.intent;
}

function setCachedIntent(sessionId, query, intent) {
  if (!sessionId) return;
  const key = `${sessionId}::${query}`;
  intentCache.set(key, { intent, ts: Date.now() });
  // 1000개 초과 시 오래된 것부터 정리
  if (intentCache.size > 1000) {
    const oldest = [...intentCache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
    intentCache.delete(oldest[0]);
  }
}

// ─────────────────────────────────────────────
// Agent 1 — 인텐트 분석 (Who/What/Why 3레이어 + 하드/소프트 필터 분리)
// ─────────────────────────────────────────────
async function analyzeIntent(query, conversationHistory = [], userPreferences = null) {
  const historyText = conversationHistory.length
    ? '이전 대화:\n' + conversationHistory.map(m => `${m.role}: ${m.content}`).join('\n') + '\n\n'
    : '';

  const prefText = userPreferences && userPreferences.interaction_count > 0 ? `
## 이 고객의 누적 취향 데이터 (${userPreferences.interaction_count}회 상호작용 기반)
${userPreferences.style_keywords?.length ? `- 선호 스타일: ${userPreferences.style_keywords.join(', ')}` : ''}
${userPreferences.fit ? `- 선호 핏: ${userPreferences.fit}` : ''}
${userPreferences.fabric?.length ? `- 선호 소재: ${userPreferences.fabric.join(', ')}` : ''}
${userPreferences.occasions?.length ? `- 주로 찾는 상황: ${userPreferences.occasions.join(', ')}` : ''}
→ 현재 요청에 명시적 단서가 없으면 이 취향을 soft_preferences 기본값으로 활용하세요.
` : '';

  const prompt = `${historyText}${prefText}유저 메시지: "${query}"

당신은 커머스 고객 인텐트 분석 전문가입니다.
고객 메시지에서 의도를 분석해 아래 JSON 형식으로만 응답하세요.

{
  "intent_type": "specific | discovery | refinement | size_guide | faq",
  "situation": "고객이 처한 TPO (상황/장소/행사). 없으면 null",
  "needs": "진짜 필요한 것 (기능, 감정, 사회적 맥락)",
  "search_query": "벡터 검색용 쿼리. 상황·스타일·소재·핏·계절을 연상 확장해 풍부하게. 최대 250자",
  "hard_filters": {
    "price_max": null,
    "price_min": null,
    "colors_exclude": [],
    "colors_include": [],
    "category": null
  },
  "soft_preferences": {
    "fit": null,
    "fabric": [],
    "style_keywords": [],
    "occasion": null
  },
  "inference_log": [],
  "intent_keywords": [],
  "clarification_needed": false
}

## 필드 작성 규칙

intent_type:
- "specific": 소재·카테고리·색상·상황 등 구체적 단서 있음
- "discovery": 막연한 탐색, 단서 거의 없음 (이전 대화가 있어도 지금 메시지에 단서가 없으면 discovery)
- "refinement": 이전 추천에 반응하거나 방향을 수정하는 요청. 스타일 탐색 칩 클릭("미니멀로 더", "캐주얼한 방향") 도 refinement로 분류.
  → 이때 soft_preferences.style_keywords에 해당 스타일 방향을 반드시 추가할 것.
- "size_guide": 사이즈·핏·체형 관련 질문
- "faq": 배송·교환·반품·정책 질문

hard_filters (절대 위반 불가):
- price_max: "5만원대" → 59000, "10만원 이하" → 100000. 숫자만.
- price_min: "3만원 이상" → 30000. 없으면 null.
- colors_exclude: "밝은색" → ["화이트","베이지","아이보리","크림"]. "어두운색 제외" → ["블랙","차콜","네이비"]. 피하는 색상만.
- colors_include: 반드시 포함해야 하는 색상. 없으면 [].
- category: "반바지만", "니트로" 등 카테고리 강제. 없으면 null.

soft_preferences (선호도 — 벡터 재정렬에만 사용):
- fit: "통풍성 좋은" → "루즈핏", "슬림하게" → "슬림핏". 없으면 null.
- fabric: ["린넨","면"] 등. "시원한" → ["린넨","면","시어서커"]. 없으면 [].
- style_keywords: ["미니멀","캐주얼","포멀"] 등. 없으면 [].
- occasion: "데이트","직장","캠핑" 등. 없으면 null.

inference_log: 암묵적 단서에서 추론한 것을 배열로. 예: ["'통풍성 좋은' → 루즈핏 + 린넨/면 추론", "성인 남성 대학생 → 20대 캐주얼 스타일"].

search_query: 상황(바닷가→휴양지 여름 시원한)·스타일·소재·핏·시즌을 연상 확장해 풍부하게.
★ 코디 요청 주의: "A랑 어울리는 B 추천"이면 검색 대상은 B이지 A가 아님. A(이미 가진 아이템)는 제외하고 B(찾아야 할 아이템) 중심으로 쿼리 작성. 예: "데님 스커트랑 어울리는 상의" → search_query는 "여성 캐주얼 상의 니트 블라우스 티셔츠"로 작성 (데님 스커트 제외).

clarification_needed: 항상 false. 단서가 부족해도 합리적으로 추론해 검색하라.
  → 질문 금지. 정보가 부족하면 가장 일반적인 가정을 하면 됨.

JSON만 응답하세요.`;

  const res = await callGemini({
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 8192 },
  });

  const text = res.data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
  try {
    const cleaned = text.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const parsed = JSON.parse(cleaned);
    // 항상 clarification_needed = false 강제
    parsed.clarification_needed = false;
    return parsed;
  } catch {
    return {
      search_query: query,
      clarification_needed: false,
      intent_keywords: [],
      hard_filters: {},
      soft_preferences: {},
      inference_log: [],
    };
  }
}

// ─────────────────────────────────────────────
// 하드 필터 — 절대 위반 불가 조건 적용
// 조건을 적용했을 때 결과가 2개 미만이면 해당 조건 건너뜀 (결과 보존 우선)
// ─────────────────────────────────────────────
function applyHardFilters(products, hardFilters = {}) {
  let result = [...products];

  // 가격 상한
  if (hardFilters.price_max) {
    const filtered = result.filter(p => !p.price || p.price <= hardFilters.price_max);
    if (filtered.length >= 2) result = filtered;
    else console.log(`[HardFilter] price_max=${hardFilters.price_max} 적용 시 결과 부족 — 건너뜀`);
  }
  // 가격 하한
  if (hardFilters.price_min) {
    const filtered = result.filter(p => !p.price || p.price >= hardFilters.price_min);
    if (filtered.length >= 2) result = filtered;
    else console.log(`[HardFilter] price_min=${hardFilters.price_min} 적용 시 결과 부족 — 건너뜀`);
  }
  // 색상 제외
  const excludeColors = (hardFilters.colors_exclude || []).map(c => c.toLowerCase());
  if (excludeColors.length) {
    const filtered = result.filter(p => {
      const t = ((p.name || '') + ' ' + (p.embed_text || '')).toLowerCase();
      return !excludeColors.some(c => t.includes(c));
    });
    if (filtered.length >= 2) result = filtered;
    else console.log(`[HardFilter] colors_exclude 적용 시 결과 부족 — 건너뜀`);
  }
  // 색상 포함
  const includeColors = (hardFilters.colors_include || []).map(c => c.toLowerCase());
  if (includeColors.length) {
    const matched = result.filter(p => {
      const t = ((p.name || '') + ' ' + (p.embed_text || '')).toLowerCase();
      return includeColors.some(c => t.includes(c));
    });
    if (matched.length >= 2) result = matched;
    else console.log(`[HardFilter] colors_include 적용 시 결과 부족 — 건너뜀`);
  }
  // 카테고리 강제
  if (hardFilters.category) {
    const cat = hardFilters.category.toLowerCase();
    const filtered = result.filter(p => {
      const t = ((p.name || '') + ' ' + (p.embed_text || '')).toLowerCase();
      return t.includes(cat);
    });
    if (filtered.length >= 2) result = filtered;
    else console.log(`[HardFilter] category="${hardFilters.category}" 적용 시 결과 부족 — 건너뜀`);
  }

  return result;
}

// ─────────────────────────────────────────────
// 소프트 선호 재정렬 — 유사도 60% + 선호도 매칭 40%
// ─────────────────────────────────────────────
function calcSoftScore(product, softPrefs = {}) {
  const t = ((product.name || '') + ' ' + (product.embed_text || '')).toLowerCase();
  let score = 0;
  if (softPrefs.fit) {
    const fit = softPrefs.fit.toLowerCase();
    if (t.includes(fit)) score += 0.40;
    // 유사 표현 보너스
    const fitAliases = {
      '루즈핏': ['루즈', '오버핏', '와이드', '박시'],
      '슬림핏': ['슬림', '타이트', '스키니'],
      '크롭':   ['크롭', '숏'],
    };
    for (const [key, aliases] of Object.entries(fitAliases)) {
      if (fit.includes(key) && aliases.some(a => t.includes(a))) score += 0.20;
    }
  }
  (softPrefs.fabric || []).forEach(f => {
    if (t.includes(f.toLowerCase())) score += 0.25;
  });
  (softPrefs.style_keywords || []).forEach(s => {
    if (t.includes(s.toLowerCase())) score += 0.15;
  });
  if (softPrefs.occasion && t.includes(softPrefs.occasion.toLowerCase())) score += 0.20;
  return Math.min(score, 1.0);
}

function rerankBySoftPreferences(products, softPrefs = {}) {
  const hasPrefs = softPrefs && (
    softPrefs.fit ||
    (softPrefs.fabric || []).length ||
    (softPrefs.style_keywords || []).length ||
    softPrefs.occasion
  );
  if (!hasPrefs) return products;

  return [...products].sort((a, b) => {
    const scoreA = (a.similarity || 0) * 0.6 + calcSoftScore(a, softPrefs) * 0.4;
    const scoreB = (b.similarity || 0) * 0.6 + calcSoftScore(b, softPrefs) * 0.4;
    return scoreB - scoreA;
  });
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

  const bucketLabel = p.styleBucket ? `[${p.styleBucket}] ` : '';
  return `${index + 1}. ${bucketLabel}${p.name}
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
async function generateRecommendation(query, intent, products, systemPrompt, mode = 'specific', context = {}, onChunk = null) {
  const productList = products.map((p, i) => formatProductForPrompt(p, i)).join('\n\n');

  // ── PDP 컨텍스트 블록 ──
  const pdpBlock = context.pdpProduct ? `
## 고객이 현재 보고 있는 상품
상품명: ${context.pdpProduct.name}
설명: ${(context.pdpProduct.embed_text || '').slice(0, 200)}
→ 이 상품을 기준으로 "함께 코디하면 좋은" 또는 "이 상품 대신 고려할" 상품을 추천하세요.
` : '';

  // ── 이전 추천 상품 블록 (멀티턴) ──
  const prevProductsBlock = (context.previousProducts || []).length ? `
## 이번 대화에서 이미 추천한 상품 (중복 추천 피할 것)
${(context.previousProducts).map(p => `- ${p.name} (${p.price?.toLocaleString() || '미정'}원)`).join('\n')}
→ 위 상품들은 이미 보여줬습니다. 고객이 "다른 거"나 "더 저렴한 거"를 요청하면 이 목록 외 상품으로 추천하세요.
` : '';

  // ── 모드별 응답 지침 ──
  const modeInstruction = {
    discovery: `
【스타일 발견 모드】
고객이 막연하게 탐색 중입니다. 설명을 묻지 말고, 서로 다른 스타일의 실제 상품 3개를 바로 보여주세요.

응답 형식:
1. "스타일이 다른 몇 가지를 가져왔어요." (한 문장, 인사 없이)
2. 상품 3개 — 번호(1., 2., 3.)로 시작, 스타일 레이블(**미니멀/클린**, **캐주얼/스트릿**, **트렌디/유니크**)과 함께 2문장 이내 소개
※ 질문 금지. 아래 CHIPS로 대신 유도.`,

    refinement: `
【취향 반영 모드】
고객이 이전 추천에 피드백을 주었습니다. 그 피드백을 정확히 반영해 새 추천을 주세요.

응답 형식:
1. 피드백 반영 한 문장 ("더 캐주얼한 방향으로 골라봤어요." 등)
2. 수정된 방향의 상품 2~3개 — 각각 번호(1., 2.)로 시작, 상품명 정확히, 이유 구체적으로
※ 질문 금지. 아래 CHIPS로 대신 유도.`,

    pdp_context: `
【상품 페이지 컨텍스트 모드】
고객이 특정 상품 페이지에서 위젯을 열었습니다.${context.pdpProduct ? ' 현재 보는 상품 정보가 위에 제공됩니다.' : ''}

응답 형식:
1. 현재 상품 관련 짧은 코멘트 (1문장, "이 상품과 잘 어울리는" 또는 "비슷한 스타일로")
2. 연관 상품 2~3개 — 각각 번호(1., 2.)로 시작, 코디 조합 관점에서 왜 잘 맞는지 구체적으로
※ 질문 금지. 아래 CHIPS로 대신 유도.`,

    after_cart: `
【장바구니 추가 후 모드 — Cross-sell】
고객이 방금 상품을 장바구니에 담았습니다. 구매를 이미 결정한 상태이므로 압박하지 않고, 자연스럽게 코디 완성을 도와주세요.

응답 형식:
1. "담으셨군요! 이 상품과 함께 코디하면 좋은 아이템도 가져왔어요." (1문장)
2. 연관 상품 2개 — 각각 번호(1., 2.)로 시작, "함께 입으면 어떤 룩이 완성되는지" 구체적으로
※ 질문 금지. 아래 CHIPS로 대신 유도.`,

    size_guide: `
【사이즈/핏 가이드 모드】
고객이 사이즈나 핏에 대해 궁금해하고 있습니다.

응답 형식:
1. 질문한 상품의 핏 특성 설명 (1~2문장)
2. 사이즈 선택 기준 제시 (키/체형/착용감 기준으로)
3. 구체적 상품 추천 1~2개 — 각각 번호(1., 2.)로 시작, 핏이 잘 맞는 이유 포함
※ 질문 금지. 아래 CHIPS로 대신 유도.`,

    specific: `
【구체적 추천 모드】
응답 형식:
1. 고객 니즈를 한 문장으로 짚기 (인사말 없이 바로 시작)
2. 상품 2~3개 — 각각:
   - 번호(1., 2.)로 시작
   - 상품명 정확히 포함
   - 이 상황에 왜 이 상품인지 구체적 이유 (소재·핏·착용감 포함)
   - **핵심 셀링포인트 1개** 굵게 강조 (예: **구김 없는 소재**, **팔뚝 커버**)
※ 질문 금지. 아래 CHIPS로 대신 유도.`,
  }[mode] || `【구체적 추천 모드】
1. 고객 니즈 한 문장 짚기
2. 상품 2~3개 — 각각 번호(1., 2.)로 시작, 상품명 정확히, 이유 구체적으로
※ 질문 금지. 아래 CHIPS로 대신 유도.`;

  const hardFiltersText = (() => {
    const hf = intent.hard_filters || {};
    const parts = [];
    if (hf.price_max)            parts.push(`가격 상한 ${hf.price_max.toLocaleString()}원 이하`);
    if (hf.price_min)            parts.push(`가격 하한 ${hf.price_min.toLocaleString()}원 이상`);
    if (hf.colors_exclude?.length) parts.push(`색상 제외: ${hf.colors_exclude.join(', ')}`);
    if (hf.colors_include?.length) parts.push(`색상 포함: ${hf.colors_include.join(', ')}`);
    if (hf.category)             parts.push(`카테고리 강제: ${hf.category}`);
    return parts.length ? parts.join(' | ') : '없음';
  })();

  const softPrefsText = (() => {
    const sp = intent.soft_preferences || {};
    const parts = [];
    if (sp.fit)                     parts.push(`핏: ${sp.fit}`);
    if (sp.fabric?.length)          parts.push(`소재: ${sp.fabric.join(', ')}`);
    if (sp.style_keywords?.length)  parts.push(`스타일: ${sp.style_keywords.join(', ')}`);
    if (sp.occasion)                parts.push(`상황: ${sp.occasion}`);
    return parts.length ? parts.join(' | ') : '없음';
  })();

  const inferenceText = (intent.inference_log || []).length
    ? (intent.inference_log || []).map(l => `  · ${l}`).join('\n')
    : '  · (없음)';

  const prompt = `${systemPrompt}

---
${pdpBlock}${prevProductsBlock}
${modeInstruction}

## 고객 인텐트 분석 결과
- 상황(TPO): ${intent.situation || '-'}
- 진짜 니즈: ${intent.needs || '-'}
- 하드 필터 (반드시 지킬 것): ${hardFiltersText}
- 소프트 선호 (가중치): ${softPrefsText}
- AI 추론 내역:
${inferenceText}
- 핵심 의도 키워드: ${(intent.intent_keywords || []).join(', ') || '-'}

## 고객 메시지
"${query}"

## 검색된 상품 후보 (하드 필터 적용 + 소프트 선호 재정렬 완료)
${productList}

---
★ 공통 규칙:
- 문장을 반드시 완성해서 끝낼 것
- 이모지 금지
- 상품 설명은 상품당 최대 2문장 이내로 핵심만 — 길게 쓰지 말 것
- 상품 설명 시 **굵게** 핵심 셀링포인트 1개 반드시 포함
- 질문 절대 금지 — 궁금한 것은 CHIPS로만 유도

응답 맨 끝(줄바꿈 후) 반드시 추가:
PRODUCTS:[응답에 나온 순서대로 번호, 예: 2,1,3]
REASONS:{"1":"첫 번째 상품 핵심 이유 (40자 이내)","2":"두 번째","3":"세 번째(있는 경우만)"}
CHIPS:["질문1","질문2","질문3"]
(PRODUCTS, REASONS, CHIPS는 UI 파싱 후 제거됨)

${mode === 'discovery' ? `CHIPS 작성 규칙 (스타일 탐색 모드):
- 고객이 방금 한 질문 맥락 + 우리가 보여준 스타일들을 고려해, 고객이 실제로 다음에 물어볼 법한 완성형 질문 2~4개
- 방향을 바꾸거나 구체화하는 자연스러운 질문 형태로 작성 (예: "좀 더 캐주얼한 스타일 있나요?", "미니멀한 버전으로 보여주세요", "이거 다른 색상도 있나요?")
- 단어 조각(예: "캐주얼로", "다른 색상으로") 형태 금지 — 반드시 완성된 문장
- 각 20자 이내, 2~4개` : `CHIPS 작성 규칙:
- 고객이 방금 한 질문 맥락 + 우리가 추천한 상품들을 고려해, 고객이 실제로 다음에 물어볼 법한 완성형 질문 2~4개
- 이런 유형을 참고: 다른 조건으로 바꾸기("5만원대도 있나요?"), 스타일 변형("더 캐주얼한 버전도 있나요?"), 활용 상황("데이트 말고 데일리로도 입을 수 있나요?"), 특정 아이템 궁금증("1번 상품 다른 색상도 있나요?")
- 단어 조각(예: "캐주얼로", "다른 색상으로") 형태 금지 — 반드시 완성된 문장
- 각 22자 이내, 2~4개`}`;

  const reqBody = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 2048 },
  };

  if (onChunk) return await callGeminiStream(reqBody, onChunk);

  const res = await callGemini(reqBody);
  return res.data.candidates?.[0]?.content?.parts?.[0]?.text || '죄송해요, 다시 시도해주세요.';
}

// ─────────────────────────────────────────────
// 상품 이미지·가격 일괄 보강
// ─────────────────────────────────────────────
async function enrichProducts(products, mallId = null) {
  if (!products.length) return products;
  const ids = products.map(p => p.product_id);
  let query = supabase
    .from('products')
    .select('product_id, price, raw_data')
    .in('product_id', ids);
  if (mallId) query = query.eq('store_id', mallId);

  const { data: rows, error } = await query;
  if (error) console.warn(`[Enrich] error: ${error.message}`);

  const imgMap = {}, priceMap = {};
  (rows || []).forEach(r => {
    const rawImg = r.raw_data?.list_image || r.raw_data?.detail_image || null;
    // protocol-relative URL(//cdn...) → https: 보정
    imgMap[r.product_id]   = rawImg ? rawImg.replace(/^\/\//, 'https://') : null;
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
    .replace(/\n?CHIPS:\[[\s\S]*?\]/g, '')
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
// PRODUCTS 태그 파싱 — AI가 골라준 후보 인덱스 (1-based)
// ─────────────────────────────────────────────
function parseProductIndices(raw) {
  const match = raw.match(/\nPRODUCTS:\[([^\]]*)\]/);
  if (!match) return [];
  return match[1].split(',').map(s => parseInt(s.trim()) - 1).filter(i => !isNaN(i) && i >= 0);
}

// ─────────────────────────────────────────────
// CHIPS 태그 파싱
// ─────────────────────────────────────────────
function parseChips(raw) {
  const match = raw.match(/\nCHIPS:(\[[\s\S]*?\])/);
  if (!match) return [];
  try {
    const parsed = JSON.parse(match[1]);
    return Array.isArray(parsed) ? parsed.slice(0, 4) : [];
  } catch { return []; }
}

// ─────────────────────────────────────────────
// 메인 추천 파이프라인
// ─────────────────────────────────────────────
async function recommend({ mallId, query, conversationHistory = [], context = {} }, streamCallback = null) {
  // checkCostLimit + 브랜드 DNA 병렬 로드
  const [, shopResult] = await Promise.all([
    checkCostLimit(),
    supabase.from('shops').select('brand_name, agent_config').eq('mall_id', mallId).single(),
  ]);
  const shopData = shopResult.data;

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

  // ── 인텐트 분석 + 임베딩 병렬 실행 (캐시 우선) ──
  const sessionId = context.sessionId || null;
  const searchBase = pdpProduct
    ? `${pdpProduct.name} ${pdpProduct.embed_text?.slice(0, 100) || ''} 코디 어울리는`
    : (/* 임시 — intent 나온 후 search_query로 덮어씀 */ query);

  let intent = getCachedIntent(sessionId, query);
  let queryEmbedding;

  if (intent) {
    console.log(`[Cache] 인텐트 캐시 히트: session=${sessionId}`);
    queryEmbedding = await embedQuery(pdpProduct ? searchBase : (intent.search_query || query));
  } else {
    // 인텐트 분석과 임베딩을 병렬로 실행
    const [resolvedIntent, embeddingFromQuery] = await Promise.all([
      analyzeIntent(query, conversationHistory, context.userPreferences || null),
      embedQuery(searchBase),
    ]);
    intent = resolvedIntent;
    await logApiCost(mallId, 'intent_analysis', 2000, 500);
    setCachedIntent(sessionId, query, intent);
    // intent.search_query가 query와 다르면 다시 임베딩 (PDP가 아닌 경우)
    if (!pdpProduct && intent.search_query && intent.search_query !== query) {
      queryEmbedding = await embedQuery(intent.search_query);
    } else {
      queryEmbedding = embeddingFromQuery;
    }
  }

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
      generationConfig: { maxOutputTokens: 4096 },
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

    const enriched = await enrichProducts(palette, mallId);
    const rawMessage = await generateRecommendation(query, intent, enriched, systemPrompt, 'discovery', { pdpProduct }, makeTagFilter(streamCallback));
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
  // queryEmbedding은 위에서 이미 병렬로 생성됨
  // RPC 레벨 가격 필터 적용 + 하드 필터 여유분 확보를 위해 15개 요청
  const rawProducts = await vectorSearch(queryEmbedding, mallId, 15, {
    price_max: intent.hard_filters?.price_max || null,
    price_min: intent.hard_filters?.price_min || null,
  });

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

  // ── 하드 필터 (절대 준수) ──
  products = applyHardFilters(products, intent.hard_filters || {});

  // ── 소프트 선호 재정렬 ──
  products = rerankBySoftPreferences(products, intent.soft_preferences || {});

  console.log(`[Pipeline] 필터 후 후보: ${products.length}개`);

  // ── 상품 이미지·가격 보강 ──
  const enriched = await enrichProducts(products, mallId);

  // ── 추천 생성 (상위 6개만 AI에게 전달) ──
  const rawMessage = await generateRecommendation(
    query, intent, enriched.slice(0, 6), systemPrompt, mode, { pdpProduct }, makeTagFilter(streamCallback)
  );
  await logApiCost(mallId, 'response_generation', 3000, 700);

  const reasons  = parseReasons(rawMessage);
  const chips    = parseChips(rawMessage);
  const message  = cleanMessage(rawMessage);

  // PRODUCTS 태그 우선 → 이름 매칭 → 폴백
  const productIndices = parseProductIndices(rawMessage);
  const recommended = productIndices.length
    ? productIndices.map(i => enriched[i]).filter(Boolean)
    : matchProductsFromMessage(message, enriched);

  // ── 의도 데이터 저장 ──
  Promise.resolve(supabase.from('chat_logs').insert({
    store_id:         mallId,
    query,
    intent_situation: intent.situation        || null,
    intent_needs:     intent.needs            || null,
    intent_keywords:  intent.intent_keywords  || [],
    inference_log:    intent.inference_log    || [],
    hard_filters:     intent.hard_filters     || {},
    soft_preferences: intent.soft_preferences || {},
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
    refinement_chips: chips,
    intent,
    mode,
  };
}

module.exports = { recommend };
