/**
 * Chameleon — Cafe24 Adaptive PDP Server
 *
 * 담당 역할:
 * 1. /install          → 운영자를 Cafe24 OAuth 인증 페이지로 리다이렉트
 * 2. /auth/callback    → OAuth 코드 → 액세스 토큰 교환 → Scripttag 등록
 * 3. /api/intent       → 방문자 신호 수신 → 페르소나 판정 → 응답
 * 4. /public/widget.js → 브라우저에 위젯 서빙
 */

require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const axios   = require('axios');
const path    = require('path');
const crypto  = require('crypto');
const { Pool } = require('pg');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const app = express();
app.use(cors());

// ── Gemini 폴백 체인 (503 → 다음 모델, 429 → 재시도) ──
// v1beta = preview/experimental, v1 = stable
const GEMINI_CHAIN = [
  { model: 'gemini-2.5-flash', api: 'v1beta' },
  { model: 'gemini-2.0-flash', api: 'v1beta' },
  { model: 'gemini-1.5-flash', api: 'v1'     },
];
async function callGemini(body) {
  for (const { model, api } of GEMINI_CHAIN) {
    const url = `https://generativelanguage.googleapis.com/${api}/models/${model}:generateContent?key=${process.env.GOOGLE_AI_API_KEY}`;
    for (let retry = 0; retry < 2; retry++) {
      try {
        const res = await axios.post(url, body);
        if (model !== GEMINI_CHAIN[0].model) console.log(`[Gemini] fallback 성공: ${model} (${api})`);
        return res;
      } catch (e) {
        const status = e.response?.status;
        if (status === 429) {
          await new Promise(r => setTimeout(r, (retry + 1) * 5000));
        } else if (status === 503 || status === 404) {
          console.warn(`[Gemini] ${model} ${status}, 다음 모델 시도...`);
          break;
        } else { throw e; }
      }
    }
  }
  throw new Error('All Gemini models unavailable');
}
app.use(express.json({ limit: '3mb' }));
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
  },
}));

// widget.js 명시적 라우트 — Cafe24 CORS 검증용
app.get('/widget.js', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.sendFile(path.join(__dirname, 'public', 'widget.js'));
});

const {
  CAFE24_CLIENT_ID,
  CAFE24_CLIENT_SECRET,
  CAFE24_MALL_ID,
  APP_BASE_URL,
  PORT = 3000,
} = process.env;

// 토큰 저장소 (메모리 + Supabase 영속화)
const tokenStore = {};

async function saveTokenToDb(mallId, access_token, refresh_token) {
  try {
    await supabase.from('store_tokens').upsert(
      { store_id: mallId, access_token, refresh_token, updated_at: new Date().toISOString() },
      { onConflict: 'store_id' }
    );
  } catch (e) {
    console.warn('[Token] DB 저장 실패 (store_tokens 테이블 없을 수 있음):', e.message);
  }
}

async function loadTokensFromDb() {
  try {
    const { data } = await supabase.from('store_tokens').select('store_id, access_token, refresh_token');
    (data || []).forEach(row => {
      tokenStore[row.store_id] = { access_token: row.access_token, refresh_token: row.refresh_token };
    });
    console.log(`[Token] DB에서 ${(data || []).length}개 스토어 토큰 로드`);
  } catch (e) {
    console.warn('[Token] DB 로드 실패 (store_tokens 테이블 없을 수 있음):', e.message);
  }
}

async function refreshTokenIfNeeded(mallId) {
  const stored = tokenStore[mallId];
  if (!stored?.refresh_token) return null;
  try {
    const res = await axios.post(
      `https://${mallId}.cafe24api.com/api/v2/oauth/token`,
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: stored.refresh_token }),
      { auth: { username: CAFE24_CLIENT_ID, password: CAFE24_CLIENT_SECRET },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    const { access_token, refresh_token } = res.data;
    tokenStore[mallId] = { access_token, refresh_token };
    await saveTokenToDb(mallId, access_token, refresh_token);
    console.log(`[Token] ${mallId} 토큰 갱신 완료`);
    return access_token;
  } catch (e) {
    console.error('[Token] 갱신 실패:', e.message);
    return null;
  }
}

// 유효한 액세스 토큰 반환 (만료 시 자동 갱신)
async function getValidToken(mallId) {
  const token = tokenStore[mallId]?.access_token;
  if (!token) return null;
  // 간단한 검증: API 호출 실패(401)시 상위에서 refresh 처리
  return token;
}

// ─────────────────────────────────────────────
// [Supabase 필수 테이블 — SQL Editor에서 실행]
//
// CREATE TABLE IF NOT EXISTS chat_logs (
//   id               bigserial PRIMARY KEY,
//   store_id         text NOT NULL,
//   query            text,
//   intent_situation text,
//   intent_needs     text,
//   result_type      text,          -- 'recommendation' | 'clarification' | 'no_results'
//   product_count    int DEFAULT 0,
//   product_ids      text[],
//   created_at       timestamptz DEFAULT now()
// );
// CREATE INDEX ON chat_logs (store_id, created_at DESC);
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// 스토어별 위젯 설정 (우리가 운영하는 config)
// 고객사 온보딩 시 이 값을 세팅해주면 됨
// ─────────────────────────────────────────────
const storeConfigs = {
  tndbsrkd: {
    insert: {
      selector: '.xans-product-detail .infoArea .xans-product-action',
      position: 'afterend',
    },
    theme: {
      accentColor: '#C0392B',
      backgroundColor: '#FEF8F7',
      borderColor: '#F9DDD8',
      borderRadius: '10px',
      fontFamily: "'Noto Sans KR', sans-serif",
    },
    cart: {
      endpoint: '/exec/front/Order/Cart',
      fields: { product_no: 'product_no', option_code: 'option_code', quantity: 'quantity' },
    },
    panel: {
      // 'push'    → 사이트를 좁히고 옆에 AI 패널 (현재 방식)
      // 'overlay' → 사이트 위에 덮어서 표시 (Macy's 방식)
      mode: 'push',
    },
    branding: {
      chatName:      'AI 쇼핑 도우미',
      buttonLabel:   'AI 도우미',
      logoUrl:       null,
      heroImage:     null,
      welcomeTitle:  '안녕하세요! 무엇을 찾고 있으신가요?',
      welcomeBody:   '상품 검색을 위해 질문하거나, 아래의 질문을 골라보세요',
      sneakPeekText: null,
      starterChips: [
        { label: '여름에 시원하게 입기 좋은 아이템 추천해주세요',      query: '여름에 시원하게 입기 좋은 아이템 추천해주세요' },
        { label: '데님 스커트랑 어울리는 상의 같이 골라줄 수 있어요?', query: '데님 스커트랑 어울리는 상의 같이 골라줄 수 있어요?' },
        { label: '매일 캐주얼하게 입기 좋은 기본템 뭐가 있어요?',      query: '매일 캐주얼하게 입기 좋은 기본템 뭐가 있어요?' },
        { label: '소개팅에 입고 나가기 좋은 깔끔한 룩 추천해줘요',     query: '소개팅에 입고 나가기 좋은 깔끔한 룩 추천해줘요' },
      ],
    },
  },
  // 다른 고객사 추가 예시:
  // othermall: {
  //   insert: { selector: '.product-description', position: 'beforebegin' },
  //   theme: { accentColor: '#2563EB', ... },
  //   cart: {
  //     endpoint: '/custom/cart/add',
  //     fields: { product_no: 'prdNo', option_code: 'optCode', quantity: 'qty' },
  //   },
  // },
};

// 기본 config (등록 안 된 스토어에 fallback)
const defaultConfig = {
  insert: {
    selector: '.xans-product-action',
    position: 'afterend',
  },
  theme: {
    accentColor: '#C0392B',
    backgroundColor: '#FEF8F7',
    borderColor: '#F9DDD8',
    borderRadius: '10px',
    fontFamily: "'Noto Sans KR', sans-serif",
  },
  cart: {
    endpoint: '/exec/front/Order/Cart',
    fields: { product_no: 'product_no', option_code: 'option_code', quantity: 'quantity' },
  },
  panel: { mode: 'push' },
  branding: {
    chatName: 'AI 쇼핑 도우미',
    buttonLabel: 'AI 도우미',
    logoUrl: null,
    heroImage: null,
    welcomeTitle: null,
    welcomeBody: null,
    sneakPeekText: null,
    starterChips: null,
  },
};

// ─────────────────────────────────────────────
// 1. INSTALL — Authorization Code 흐름 시작
// ─────────────────────────────────────────────
app.get('/install', (req, res) => {
  const mallId = req.query.mall_id || CAFE24_MALL_ID;

  if (!mallId) {
    return res.status(400).send('mall_id가 필요합니다.');
  }

  // 앱(Application) 읽기+쓰기 → mall.read_application, mall.write_application
  // 상품(Product) 읽기 → mall.read_product
  const scope = 'mall.read_application,mall.write_application,mall.read_product';

  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     CAFE24_CLIENT_ID,
    redirect_uri:  `${APP_BASE_URL}/auth/callback`,
    scope,
    state:         mallId,
  });

  const authUrl = `https://${mallId}.cafe24api.com/api/v2/oauth/authorize?${params}`;
  console.log(`[Install] OAuth URL: ${authUrl}`);
  res.redirect(authUrl);
});

// ─────────────────────────────────────────────
// 2. OAuth CALLBACK — Cafe24가 코드와 함께 리다이렉트해줌
// ─────────────────────────────────────────────
app.get('/auth/callback', async (req, res) => {
  const { code, state: mallId, error, error_description } = req.query;

  // Cafe24가 에러를 리턴한 경우 — 원인을 그대로 보여줌
  if (error) {
    console.error(`[OAuth Error from Cafe24] ${error}: ${error_description}`);
    return res.status(400).send(`
      <html><body style="font-family:sans-serif;padding:40px;">
        <h2>❌ Cafe24 OAuth 오류</h2>
        <p><strong>error:</strong> ${error}</p>
        <p><strong>description:</strong> ${decodeURIComponent(error_description || '')}</p>
        <p style="color:#888;font-size:12px;">서버 터미널 로그도 확인하세요.</p>
      </body></html>
    `);
  }

  if (!code || !mallId) {
    return res.status(400).send('OAuth 응답이 올바르지 않습니다.');
  }

  try {
    // ① 코드 → 액세스 토큰 교환
    const tokenRes = await axios.post(
      `https://${mallId}.cafe24api.com/api/v2/oauth/token`,
      new URLSearchParams({
        grant_type:   'authorization_code',
        code,
        redirect_uri: `${APP_BASE_URL}/auth/callback`,
      }),
      {
        auth: { username: CAFE24_CLIENT_ID, password: CAFE24_CLIENT_SECRET },
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }
    );

    const { access_token, refresh_token } = tokenRes.data;
    tokenStore[mallId] = { access_token, refresh_token };
    await saveTokenToDb(mallId, access_token, refresh_token);
    console.log(`[OAuth] Token saved for ${mallId}`);

    // ② Scripttag 등록 — 위젯 JS를 스토어 모든 페이지에 자동 삽입
    await registerScripttag(mallId, access_token);

    res.send(`
      <html>
        <body style="font-family:sans-serif; padding:40px; text-align:center;">
          <h2>✅ Chameleon 설치 완료</h2>
          <p>쇼핑몰 <strong>${mallId}.cafe24.com</strong>에 Adaptive PDP 위젯이 연결되었습니다.</p>
          <p style="color:#888; font-size:13px;">이제 상품 상세 페이지를 방문하면 위젯이 작동합니다.</p>
          <a href="https://${mallId}.cafe24.com" style="
            display:inline-block; margin-top:20px;
            background:#000; color:#fff; padding:12px 28px;
            text-decoration:none; font-size:13px; letter-spacing:0.05em;
          ">쇼핑몰 확인하기</a>
        </body>
      </html>
    `);
  } catch (err) {
    console.error('[OAuth Error]', err.response?.data || err.message);
    res.status(500).send(`OAuth 처리 중 오류: ${JSON.stringify(err.response?.data)}`);
  }
});

// ─────────────────────────────────────────────
// Scripttag 등록 헬퍼
// widget.js를 카페24 스토어의 지정 페이지에 자동 삽입
// ─────────────────────────────────────────────
async function registerScripttag(mallId, accessToken) {
  const widgetUrl = `${APP_BASE_URL}/widget.js`;
  const apiHeaders = { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' };

  // 기존 scripttag 전부 삭제 (이전 URL 충돌 방지)
  const listRes = await axios.get(
    `https://${mallId}.cafe24api.com/api/v2/admin/scripttags`,
    { headers: apiHeaders }
  );
  const existing = listRes.data.scripttags || [];
  for (const tag of existing) {
    await axios.delete(
      `https://${mallId}.cafe24api.com/api/v2/admin/scripttags/${tag.script_no}`,
      { headers: apiHeaders }
    );
    console.log(`[Scripttag] Deleted old tag: ${tag.src}`);
  }

  // 새 URL로 등록
  const res = await axios.post(
    `https://${mallId}.cafe24api.com/api/v2/admin/scripttags`,
    {
      request: {
        src: widgetUrl,
        display_location: ['MAIN', 'PRODUCT_LIST', 'PRODUCT_DETAIL'],
      },
    },
    { headers: apiHeaders }
  );

  console.log(`[Scripttag] Registered: ${widgetUrl} on ${mallId}`);
  return res.data;
}

// ─────────────────────────────────────────────
// 3. CONFIG API — 위젯이 로드될 때 스토어 설정을 fetch
// ─────────────────────────────────────────────
app.get('/api/config/:mallId', async (req, res) => {
  const { mallId } = req.params;
  // Supabase shops 테이블 우선 확인 (온보딩 페이지로 저장된 설정)
  try {
    const { data } = await supabase.from('shops').select('theme_config').eq('mall_id', mallId).single();
    if (data?.theme_config && Object.keys(data.theme_config).length > 0) {
      // DB의 theme/branding 우선, hardcoded의 insert/cart 설정 병합
      const hardcoded = storeConfigs[mallId] || {};
      return res.json({
        insert: hardcoded.insert,
        cart:   hardcoded.cart,
        ...data.theme_config,
      });
    }
  } catch {}
  // DB에 설정 없으면 하드코딩 storeConfigs 폴백
  res.json(storeConfigs[mallId] || defaultConfig);
});

// ─────────────────────────────────────────────
// 4. INTENT API — 위젯이 방문자 신호를 보내면 페르소나 판정
//
// Request body:
// {
//   mallId:      "tndbsrkd",
//   productNo:   "5573",
//   referrer:    "https://www.instagram.com/...",
//   utmSource:   "instagram",
//   utmCampaign: "gift_2025",
//   isReturn:    true,         ← 이전 방문/구매 이력
//   scrollDepth: 45,           ← 퍼센트
//   timeOnPage:  12,           ← 초
//   searchQuery: "선물"        ← 사이트 내 검색어 (있을 경우)
// }
//
// Response: { persona: "fashion" | "gift" | "repeat" }
// ─────────────────────────────────────────────
app.post('/api/intent', (req, res) => {
  const persona = classifyIntent(req.body);
  console.log(`[Intent] ${req.body.mallId} product:${req.body.productNo} → ${persona}`);

  // 이벤트 로그 (추후 대시보드용)
  logEvent({ ...req.body, persona, timestamp: new Date().toISOString() });

  res.json({ persona });
});

// 페르소나 분류 로직 (MVP: 규칙 기반 / 추후 Claude API로 고도화)
function classifyIntent(signals) {
  const {
    referrer    = '',
    utmSource   = '',
    utmCampaign = '',
    searchQuery = '',
    isReturn    = false,
  } = signals;

  const all = [referrer, utmSource, utmCampaign, searchQuery].join(' ').toLowerCase();

  // 1순위: 선물 구매자 신호
  const giftKeywords = ['선물', 'gift', '생일', 'birthday', '기념일', 'anniversary', '이벤트'];
  if (giftKeywords.some(k => all.includes(k))) return 'gift';

  // 3순위: 패션 피플 (기본값)
  return 'fashion';
}

// 이벤트 로그 (MVP: 콘솔 출력 / 추후 DB 연동)
const eventLog = [];
function logEvent(event) {
  eventLog.push(event);
  // 최근 100개만 유지
  if (eventLog.length > 100) eventLog.shift();
}

// ─────────────────────────────────────────────
// 5-A. CHIPS API — 상품별 동적 FAQ 질문 생성
// POST /api/chips  { mallId, productNo, persona }
// ─────────────────────────────────────────────
app.post('/api/chips', async (req, res) => {
  const { mallId, productNo, persona } = req.body;
  if (!mallId || !productNo) return res.json({ chips: [] });

  try {
    const { data: product } = await supabase
      .from('products')
      .select('name, attributes, embed_text')
      .eq('store_id', mallId)
      .eq('product_id', String(productNo))
      .single();

    if (!product) return res.json({ chips: [] });

    const personaContext = {
      fashion: '패션에 관심 있는 일반 쇼퍼',
      gift:    '선물을 구매하려는 고객',
      repeat:  '이전에 구매한 적 있는 재방문 고객',
    }[persona] || '일반 쇼퍼';

    const prompt = `상품: ${product.name}
소재: ${product.attributes?.material || ''}
설명: ${(product.embed_text || '').slice(0, 500)}
구매자 유형: ${personaContext}

이 상품을 보고 있는 "${personaContext}"가 구매를 결정하기 전에 실제로 궁금해할 질문 3개를 만들어주세요.

규칙:
- 반드시 이 상품의 실제 특성(소재, 핏, 관리법, 착용 상황 등)에서 나온 질문
- 누구나 실제로 물어볼 법한 것 (뻔한 일반 질문 금지)
- 한 질문당 15자 이내로 짧게
- JSON 배열만 응답: ["질문1", "질문2", "질문3"]`;

    const geminiRes = await callGemini({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 120 },
    });

    const raw = geminiRes.data.candidates?.[0]?.content?.parts?.[0]?.text || '[]';
    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const chips = JSON.parse(cleaned);
    console.log(`[Chips] ${mallId} product:${productNo} persona:${persona} →`, chips);
    res.json({ chips });
  } catch (err) {
    console.error('[Chips Error]', err.message);
    res.json({ chips: [] });
  }
});

// ─────────────────────────────────────────────
// 5-B. PDP CONTENT API — 상품별 AI UX 라이팅 생성
// POST /api/pdp-content  { mallId, productNo, productName, productDesc }
// ─────────────────────────────────────────────
const pdpContentCache = new Map(); // 상품별 캐시 (재시작 전까지 유효)

app.post('/api/pdp-content', async (req, res) => {
  const { mallId, productNo, productName, productDesc } = req.body;

  // 캐시 확인
  const cacheKey = `${mallId}__${productNo}__${productName}`;
  if (pdpContentCache.has(cacheKey)) {
    return res.json(pdpContentCache.get(cacheKey));
  }

  // Supabase에서 상품 정보 보강 (없으면 DOM에서 받은 정보 사용)
  let enrichedName = productName || '';
  let enrichedDesc = productDesc || '';
  if (mallId && productNo) {
    try {
      const { data: product } = await supabase
        .from('products')
        .select('name, attributes, embed_text')
        .eq('store_id', mallId)
        .eq('product_id', String(productNo))
        .single();
      if (product) {
        enrichedName = product.name || enrichedName;
        enrichedDesc = product.embed_text || enrichedDesc;
      }
    } catch {}
  }

  if (!enrichedName && !enrichedDesc) {
    return res.json({
      badge: 'AI 쇼핑 도우미',
      title: '',
      body: '',
      chips: ['소재가 어떻게 되나요?', '사이즈 선택 어떻게 하나요?', '어떤 상황에 어울려요?'],
      accentColor: '#2C3E50',
    });
  }

  const prompt = `당신은 한국 패션 브랜드의 시니어 UX 라이터입니다.

상품명: ${enrichedName}
상품 설명: ${enrichedDesc.slice(0, 600)}

이 상품을 보고 있는 고객이 구매를 결정하도록 유도하는 콘텐츠를 작성하세요.

규칙:
- 이 상품만의 고유한 특성(소재·디자인·용도·착용감)에서 출발할 것
- '추천', '좋아요', '좋은' 같은 모호한 단어 금지
- 구체적이고 감각적인 언어로 구매 욕구를 직접 자극할 것
- chips는 이 상품을 보는 고객이 실제로 구매 전에 궁금해할 질문으로 구성
- accentColor는 상품의 분위기(소재·색상·용도)에 어울리는 HEX 색상

반드시 아래 JSON만 응답 (다른 텍스트 없이):
{
  "badge": "15자 이내, 구매 행동을 유도하는 강렬한 배지",
  "title": "20자 이내, 이 상품의 핵심 가치를 담은 헤드라인",
  "body": "2~3문장, 소재·핏·착용 상황을 감각적으로 묘사하여 구매 욕구 자극",
  "chips": ["질문1", "질문2", "질문3", "질문4", "질문5", "질문6", "질문7"],
  "accentColor": "#HEX"
}

chips 작성 규칙:
- 반드시 7개 작성 (매 페이지 로드마다 3개씩 무작위 노출됨)
- 각 질문은 15자 이내
- 이 상품을 구매할지 고민 중인 고객이 실제로 물어볼 질문만
- 소재·핏·착용감·세탁·코디·재고·사이즈 등 다양한 각도로 구성
- 답변을 들으면 구매를 결정할 수 있는 질문 우선`;

  try {
    const geminiRes = await callGemini({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 500 },
    });
    const raw = geminiRes.data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    const content = JSON.parse(cleaned);
    console.log(`[PdpContent] ${mallId} product:${productNo} → ${content.badge} chips:${content.chips?.length}`);
    pdpContentCache.set(cacheKey, content);
    res.json(content);
  } catch (err) {
    console.error('[PdpContent Error]', err.message);
    res.json({
      badge: '이 상품 알아보기',
      title: enrichedName,
      body: enrichedDesc.slice(0, 120),
      chips: ['소재가 어떻게 되나요?', '사이즈 선택 어떻게 하나요?', '어떤 상황에 어울려요?'],
      accentColor: '#2C3E50',
    });
  }
});

// ─────────────────────────────────────────────
// 5. ASK API — 상품 관련 자유 질문 → Claude 응답
// ─────────────────────────────────────────────
app.post('/api/ask', async (req, res) => {
  const { mallId, productNo, productName: domProductName, question, sessionId, pageUrl } = req.body;
  if (!question) return res.status(400).json({ error: 'question required' });

  if (!process.env.GOOGLE_AI_API_KEY) {
    return res.json({
      answer: `"${question}"에 대한 답변 기능은 준비 중입니다. 곧 연결될 예정이에요!`,
    });
  }

  console.log(`[Ask] mallId=${mallId} productNo=${productNo} question="${question}"`);

  try {
    // Supabase에서 실제 상품 데이터 조회
    let productContext = '';
    if (mallId && productNo) {
      const { data: product } = await supabase
        .from('products')
        .select('name, price, attributes, embed_text')
        .eq('store_id', mallId)
        .eq('product_id', String(productNo))
        .single();

      if (product) {
        const attrs = product.attributes || {};
        productContext = `
상품명: ${product.name}
가격: ${product.price?.toLocaleString()}원
소재: ${attrs.material || '정보 없음'}
상품 설명: ${product.embed_text?.slice(0, 800) || ''}
`.trim();
      }
    }

    // DOM에서 받은 상품명을 Supabase 데이터가 없을 때 fallback으로 사용
    if (!productContext && domProductName) {
      productContext = `상품명: ${domProductName}`;
    }

    const prompt = `당신은 고급 패션 매장의 숙련된 어드바이저입니다. 고객이 편안하게 느낄 수 있도록 정중하고 섬세하게 응대하되, 지나치게 격식적이거나 딱딱하지 않게 따뜻한 존댓말을 사용하세요.

${productContext ? `[현재 고객이 보고 계신 상품]\n${productContext}\n` : ''}
고객 질문: "${question}"

이 상품에 대한 질문에 직접 답변해 드리세요. 다른 상품을 추천하거나 "어떤 상황에 입으실 건가요?" 같은 역질문은 절대 하지 마세요.

규칙:
- 인사말 없이 바로 핵심 답변으로 시작할 것 — '안녕하세요', '고객님', '보고 계신' 같은 도입부 금지
- 반드시 이 상품에 대해서만 답변할 것 — 다른 상품 추천 절대 금지
- 상품 정보를 근거로 구체적으로 답변할 것
- 존댓말 사용: "~해요", "~거예요", "~답니다" (부드럽고 자연스럽게)
- "~하시면 됩니다", "~해주시기 바랍니다" 같은 딱딱하거나 사무적인 표현 금지
- 유머나 가벼운 말투 금지 — 신뢰감 있는 전문가 톤 유지
- 다른 페이지나 링크로 안내하지 말 것 — 지금 이 자리에서 바로 답변할 것
- 정보가 없을 경우에도 소재·디자인에서 추론하여 솔직하게 안내할 것
- 2~3문장, 간결하게`;

    const geminiRes = await callGemini({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: 450 },
    });

    const answer = geminiRes.data.candidates?.[0]?.content?.parts?.[0]?.text
      || '죄송해요, 다시 시도해주세요.';
    Promise.resolve(supabase.from('chat_logs').insert({
      store_id: mallId, query: question, result_type: 'pdp_qa', product_count: 1,
      product_ids: productNo ? [String(productNo)] : null,
      session_id: sessionId || null, page_url: pageUrl || null,
    })).catch(() => {});
    res.json({ answer });
  } catch (err) {
    console.error('[Ask API Error]', err.response?.data || err.message);
    res.status(500).json({ answer: '죄송해요, 지금 답변을 생성할 수 없어요. 잠시 후 다시 시도해주세요.' });
  }
});

// ─────────────────────────────────────────────
// 6. SIZE EXTRACT API — 상품 사이즈 추출 파이프라인
//
// 3가지 소스 자동 시도 (우선순위 순):
//   ① pageUrl로 HTML 직접 스크래핑
//   ② 카페24 API description HTML
//   ③ 사이즈가이드 이미지 Vision OCR
//
// Request body (최소 하나 필요):
// {
//   "mallId":            "solidhomme",
//   "productNo":         "5534",
//   "pageUrl":           "https://solidhomme.com/product/detail.html?product_no=5534",
//   "sizeGuideImageUrl": "https://cdn.../size_guide.jpg"   ← 선택
// }
// ─────────────────────────────────────────────
const { extractSizeData } = require('./services/sizeExtractor');
const { runEmbedding }   = require('./services/embedder');
const { recommend }      = require('./services/recommender');

app.post('/api/extract-size', async (req, res) => {
  const { mallId, productNo, pageUrl, sizeGuideImageUrl } = req.body;

  if (!pageUrl && !mallId) {
    return res.status(400).json({ error: 'pageUrl 또는 mallId+productNo 필요' });
  }

  try {
    // ① 상품 페이지 HTML 수집
    let pageHtml = '';
    const targetUrl = pageUrl ||
      `https://${mallId}.cafe24.com/product/detail.html?product_no=${productNo}`;

    try {
      const pageRes = await axios.get(targetUrl, {
        timeout: 15000,
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ChameleonBot/1.0)' },
      });
      pageHtml = pageRes.data;
    } catch (e) {
      console.warn(`[ExtractSize] Page fetch failed (${e.message}), description만 사용`);
    }

    // ② 카페24 API에서 상품 정보 수집 (토큰 있는 경우)
    let productInfo = { name: '', description: '', material: '', sizeGuideImageUrl };
    const token = mallId && tokenStore[mallId]?.access_token;
    if (token && productNo) {
      try {
        const apiRes = await axios.get(
          `https://${mallId}.cafe24api.com/api/v2/admin/products/${productNo}`,
          { headers: { Authorization: `Bearer ${token}` } }
        );
        const p = apiRes.data.product;
        productInfo = {
          name:               p.product_name,
          description:        p.description || '',
          material:           p.material_name || '',
          sizeGuideImageUrl:  sizeGuideImageUrl || null,
        };
      } catch (e) {
        console.warn('[ExtractSize] Cafe24 API call failed:', e.message);
      }
    }

    // ③ 사이즈 추출 파이프라인 실행
    const result = await extractSizeData(productInfo, pageHtml);

    if (!result) {
      return res.json({ success: false, message: '사이즈 정보를 찾을 수 없습니다.' });
    }

    res.json({ success: true, mallId, productNo, result });

  } catch (err) {
    console.error('[ExtractSize] Error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// 7. ADMIN SYNC — 카페24 상품 → Supabase upsert
//
// POST /admin/sync/:mallId
// 카페24 상품 전체를 가져와 products 테이블에 저장
// ─────────────────────────────────────────────
function stripHtml(html) {
  return (html || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

app.post('/admin/sync/:mallId', async (req, res) => {
  const { mallId } = req.params;
  const token = tokenStore[mallId]?.access_token;

  if (!token) {
    return res.status(401).json({ error: `${mallId} 토큰 없음. /install 먼저 실행하세요.` });
  }

  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  let offset = 0;
  const limit = 100;
  let totalSynced = 0;
  let totalFailed = 0;

  try {
    while (true) {
      // 카페24 상품 목록 페이지네이션
      const listRes = await axios.get(
        `https://${mallId}.cafe24api.com/api/v2/admin/products`,
        { headers, params: { limit, offset, embed: 'options' } }
      );

      const products = listRes.data.products || [];
      if (products.length === 0) break;

      for (const p of products) {
        try {
          // 상품 상세 개별 호출 (list API는 description 미포함)
          let description = '';
          let material = p.product_material || '';
          try {
            const detailRes = await axios.get(
              `https://${mallId}.cafe24api.com/api/v2/admin/products/${p.product_no}`,
              { headers }
            );
            const detail = detailRes.data.product;
            description = stripHtml(detail.description || '');
            material = detail.product_material || material;
          } catch (e) {
            console.warn(`[Sync] detail fetch failed for ${p.product_no}:`, e.message);
          }

          // embed_text: 임베딩에 쓸 텍스트 조합
          const embedText = [
            p.product_name,
            material,
            description,
          ].filter(Boolean).join(' | ').slice(0, 3000);

          const row = {
            store_id:   mallId,
            product_id: String(p.product_no),
            name:       p.product_name,
            category:   p.categories?.[0]?.category_name || null,
            price:      parseInt(p.price) || 0,
            status:     p.display === 'T' ? 'active' : 'deleted',
            attributes: {
              material:     material || null,
              retail_price: parseInt(p.retail_price) || null,
              options:      p.options || [],
            },
            raw_data:   p,
            embed_text: embedText,
            synced_at:  new Date().toISOString(),
          };

          const { error } = await supabase
            .from('products')
            .upsert(row, { onConflict: 'store_id,product_id' });

          if (error) {
            console.error(`[Sync] Failed ${p.product_no}:`, error.message);
            totalFailed++;
          } else {
            totalSynced++;
          }
        } catch (e) {
          console.error(`[Sync] Error on product ${p.product_no}:`, e.message);
          totalFailed++;
        }
      }

      console.log(`[Sync] offset=${offset} 처리완료: ${products.length}개`);
      if (products.length < limit) break;
      offset += limit;
    }

    res.json({
      success: true,
      mallId,
      synced: totalSynced,
      failed: totalFailed,
      message: `${totalSynced}개 상품 동기화 완료`,
    });

  } catch (err) {
    console.error('[Sync Error]', err.response?.data || err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// 8-B. OPTIONS API — 상품 옵션 + 바리안트 조회 (위젯 장바구니용)
//
// GET /api/options?mallId=X&productNo=Y
// Returns: { options: [...], variants: [...] }
// ─────────────────────────────────────────────
app.get('/api/options', async (req, res) => {
  const { mallId, productNo } = req.query;
  if (!mallId || !productNo) return res.json({ options: [], variants: [], error: 'params_missing' });

  let token = await getValidToken(mallId);
  if (!token) return res.json({ options: [], variants: [], error: 'no_token' });

  async function fetchOptions(tok) {
    const headers = { Authorization: `Bearer ${tok}` };
    const [optRes, varRes] = await Promise.all([
      axios.get(`https://${mallId}.cafe24api.com/api/v2/admin/products/${productNo}/options`, { headers }),
      axios.get(`https://${mallId}.cafe24api.com/api/v2/admin/products/${productNo}/variants`, { headers }),
    ]);
    return {
      options:  optRes.data.options  || [],
      variants: varRes.data.variants || [],
    };
  }

  try {
    const data = await fetchOptions(token);
    res.json(data);
  } catch (err) {
    // 401이면 토큰 갱신 후 재시도
    if (err.response?.status === 401) {
      const newToken = await refreshTokenIfNeeded(mallId);
      if (newToken) {
        try {
          res.json(await fetchOptions(newToken));
          return;
        } catch (e2) {
          console.error('[Options] 갱신 후 재시도 실패:', e2.message);
        }
      }
    }
    console.error('[Options]', err.message);
    res.json({ options: [], variants: [], error: err.message });
  }
});

// ─────────────────────────────────────────────
// 9. RECOMMEND API — 유저 상황/니즈 → AI 추천
//
// POST /api/recommend
// { mallId, query, conversationHistory? }
// ─────────────────────────────────────────────
app.post('/api/recommend', async (req, res) => {
  const { mallId, query, conversationHistory, sessionId, pageUrl, mode } = req.body;
  if (!mallId || !query) return res.status(400).json({ error: 'mallId, query 필요' });

  console.log(`[Recommend] mallId=${mallId} mode=${mode || 'auto'} query="${query}"`);

  try {
    const result = await recommend({
      mallId, query, conversationHistory,
      context: { sessionId, pageUrl, mode },
    });
    res.json(result);
  } catch (err) {
    console.error('[Recommend Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// 8. ADMIN EMBED — products → Gemini 임베딩 → product_embeddings
//
// POST /admin/embed/:mallId
// ─────────────────────────────────────────────
app.post('/admin/embed/:mallId', async (req, res) => {
  const { mallId } = req.params;

  try {
    console.log(`[Embed] ${mallId} 임베딩 시작...`);
    const result = await runEmbedding(mallId);
    res.json({
      success: true,
      mallId,
      ...result,
      message: `${result.embedded}개 임베딩 완료 (스킵: ${result.skipped}, 실패: ${result.failed})`,
    });
  } catch (err) {
    console.error('[Embed Error]', err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─────────────────────────────────────────────
// 6. ADMIN 대시보드 UI
// ─────────────────────────────────────────────
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// ─────────────────────────────────────────────
// 6-A. STATS API — 어드민 대시보드용 통계
// GET /api/stats?mallId=tndbsrkd
// ─────────────────────────────────────────────
app.get('/api/stats', async (req, res) => {
  const { mallId } = req.query;
  const monthStart = new Date();
  monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);

  try {
    // 이번 달 API 비용
    let costQ = supabase.from('api_events').select('cost_usd').gte('occurred_at', monthStart.toISOString());
    if (mallId) costQ = costQ.eq('store_id', mallId);
    const { data: costData } = await costQ;
    const totalCost = (costData || []).reduce((s, r) => s + (r.cost_usd || 0), 0);

    // 이번 달 대화 수 + 최근 로그
    let logQ = supabase.from('chat_logs').select('*').order('created_at', { ascending: false }).limit(50);
    if (mallId) logQ = logQ.eq('store_id', mallId);
    const { data: logData } = await logQ;

    // 이번 달 분만 카운트
    const monthLogs = (logData || []).filter(l => new Date(l.created_at) >= monthStart);

    // 등록 상품 수
    let prodQ = supabase.from('products').select('product_id', { count: 'exact', head: true }).eq('status', 'active');
    if (mallId) prodQ = prodQ.eq('store_id', mallId);
    const { count: productCount } = await prodQ;

    // 결과 유형별 집계
    const byType = monthLogs.reduce((acc, l) => {
      acc[l.result_type] = (acc[l.result_type] || 0) + 1;
      return acc;
    }, {});

    res.json({
      period: `${monthStart.toISOString().slice(0, 10)} ~ 오늘`,
      total_cost_usd: parseFloat(totalCost.toFixed(4)),
      chat_count: monthLogs.length,
      product_count: productCount || 0,
      by_type: byType,
      recent_chats: logData || [],
    });
  } catch (e) {
    console.error('[Stats]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// 6-B. PRODUCT WEBHOOK — 카페24 상품 변경 시 자동 동기화
// POST /api/webhook/product
// Cafe24 → 상품 생성/수정/삭제 이벤트 수신 → DB upsert + 임베딩
// ─────────────────────────────────────────────
app.post('/api/webhook/product', express.raw({ type: '*/*' }), async (req, res) => {
  // 서명 검증 (CAFE24_WEBHOOK_SECRET 설정 시)
  const secret = process.env.CAFE24_WEBHOOK_SECRET;
  const sig    = req.headers['x-cafe24-signature'];
  if (secret && sig) {
    const expected = crypto.createHmac('sha256', secret).update(req.body).digest('hex');
    if (!sig.includes(expected)) return res.status(401).json({ error: 'invalid signature' });
  }

  let body;
  try { body = JSON.parse(req.body); } catch { return res.status(400).json({ error: 'invalid json' }); }

  const { resource_id: productNo, mall_id: mallId } = body;
  console.log(`[Webhook] ${mallId} product:${productNo} event received`);
  res.json({ received: true }); // 즉시 200 응답

  // 비동기 처리 (webhook timeout 방지)
  setImmediate(async () => {
    try {
      const token = tokenStore[mallId]?.access_token;
      if (!token || !productNo) return;

      const pRes = await axios.get(
        `https://${mallId}.cafe24api.com/api/v2/admin/products/${productNo}`,
        { headers: { Authorization: `Bearer ${token}` } }
      );
      const p = pRes.data.product;
      const description = stripHtml(p.description || '');
      const material    = p.product_material || '';
      const embedText   = [p.product_name, material, description].filter(Boolean).join(' | ').slice(0, 3000);

      // products 테이블 upsert
      await supabase.from('products').upsert({
        store_id:   mallId,
        product_id: String(p.product_no),
        name:       p.product_name,
        price:      parseInt(p.price) || 0,
        status:     p.display === 'T' ? 'active' : 'deleted',
        attributes: { material: material || null },
        raw_data:   p,
        embed_text: embedText,
        synced_at:  new Date().toISOString(),
      }, { onConflict: 'store_id,product_id' });

      // 임베딩 재생성 (해당 상품만)
      const { data: row } = await supabase.from('products').select('id').eq('store_id', mallId).eq('product_id', String(productNo)).single();
      if (row?.id && embedText) {
        const embedRes = await axios.post(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:embedContent?key=${process.env.GOOGLE_AI_API_KEY}`,
          { model: 'models/gemini-embedding-001', content: { parts: [{ text: embedText }] } }
        );
        const embedding = embedRes.data.embedding.values;
        await supabase.from('product_embeddings').upsert(
          { product_id: row.id, store_id: mallId, embedding: JSON.stringify(embedding), updated_at: new Date().toISOString() },
          { onConflict: 'product_id' }
        );
      }

      console.log(`[Webhook] ${mallId} product:${productNo} synced + embedded`);
    } catch (e) {
      console.error('[Webhook] Error:', e.message);
    }
  });
});

// ─────────────────────────────────────────────
// SHOP CONFIG API — 고객사 브랜드/테마 설정
// ─────────────────────────────────────────────

// 온보딩 페이지 서빙
app.get('/onboarding', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'onboarding.html'));
});

// ─────────────────────────────────────────────
// 에이전트 콘솔
// ─────────────────────────────────────────────
app.get('/console', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'console.html'));
});

// 설정 조회
app.get('/api/shop-config/:mallId', async (req, res) => {
  const { mallId } = req.params;
  try {
    const { data } = await supabase
      .from('shops').select('*').eq('mall_id', mallId).single();
    if (!data) return res.status(404).json({ error: 'not_found' });
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 설정 저장 (upsert) — theme_config + agent_config 통합
app.post('/api/shop-config', async (req, res) => {
  const { mallId, brandName, theme_config, agent_config } = req.body;
  if (!mallId) return res.status(400).json({ error: 'mallId required' });
  try {
    const upsertData = {
      mall_id:    mallId,
      updated_at: new Date().toISOString(),
    };
    if (brandName   !== undefined) upsertData.brand_name   = brandName;
    if (theme_config !== undefined) upsertData.theme_config = theme_config;
    if (agent_config !== undefined) upsertData.agent_config = agent_config;

    const { error } = await supabase.from('shops').upsert(
      upsertData,
      { onConflict: 'mall_id' }
    );
    if (error) throw error;
    console.log(`[ShopConfig] ${mallId} 설정 저장 완료`);
    res.json({ success: true });
  } catch (e) {
    console.error('[ShopConfig] 저장 실패:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// 10b. LOGO UPLOAD API — 브랜드 로고 Supabase Storage 업로드
// POST /api/upload-logo
// { mallId, fileBase64, fileName, mimeType }
// → { url } (Supabase Storage public URL)
// 허용 포맷: image/svg+xml, image/png, image/webp
// 최대 크기: 2MB
// ─────────────────────────────────────────────
const ALLOWED_LOGO_TYPES = new Set(['image/svg+xml', 'image/png', 'image/webp']);
const LOGO_EXT = { 'image/svg+xml': 'svg', 'image/png': 'png', 'image/webp': 'webp' };

app.post('/api/upload-logo', express.json({ limit: '3mb' }), async (req, res) => {
  const { mallId, fileBase64, fileName, mimeType } = req.body;
  if (!mallId || !fileBase64 || !mimeType) {
    return res.status(400).json({ error: 'mallId, fileBase64, mimeType required' });
  }
  if (!ALLOWED_LOGO_TYPES.has(mimeType)) {
    return res.status(400).json({ error: 'SVG, PNG, WebP 파일만 업로드 가능합니다.' });
  }

  try {
    const ext    = LOGO_EXT[mimeType];
    const buffer = Buffer.from(fileBase64, 'base64');

    if (buffer.byteLength > 2 * 1024 * 1024) {
      return res.status(400).json({ error: '파일 크기는 2MB 이하여야 합니다.' });
    }

    const storagePath = `${mallId}/${Date.now()}.${ext}`;
    const { error: uploadError } = await supabase.storage
      .from('logos')
      .upload(storagePath, buffer, { contentType: mimeType, upsert: true });

    if (uploadError) throw uploadError;

    const { data: { publicUrl } } = supabase.storage
      .from('logos')
      .getPublicUrl(storagePath);

    console.log(`[Logo] ${mallId} 로고 업로드 완료: ${storagePath}`);
    res.json({ url: publicUrl });
  } catch (e) {
    console.error('[Logo] 업로드 실패:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// 10. TRACK API — 위젯 이벤트 수집 (노출/칩클릭/장바구니/구매)
// POST /api/track
// { mallId, eventType, productNo?, chipLabel?, sessionId? }
// eventType: 'impression'|'chat_start'|'chip_click'|'product_click'|'cart_add'|'purchase'
// ─────────────────────────────────────────────
app.post('/api/track', async (req, res) => {
  const { mallId, eventType, productNo, chipLabel, sessionId } = req.body;
  if (!mallId || !eventType) return res.json({ ok: false });
  try {
    await supabase.from('widget_events').insert({
      store_id:    mallId,
      event_type:  eventType,
      product_no:  productNo  || null,
      chip_label:  chipLabel  || null,
      session_id:  sessionId  || null,
      occurred_at: new Date().toISOString(),
    });
  } catch (e) {
    console.warn('[Track]', e.message);
  }
  res.json({ ok: true }); // 트래킹 실패여도 위젯 동작 방해 안 함
});

// ─────────────────────────────────────────────
// 11. METRICS API — 콘솔 대시보드용 집계
// GET /api/metrics?mallId=X&period=today|7d|30d
// ─────────────────────────────────────────────
app.get('/api/metrics', async (req, res) => {
  const { mallId, period = '30d' } = req.query;
  if (!mallId) return res.status(400).json({ error: 'mallId required' });

  const now  = new Date();
  const from = new Date(now);
  if      (period === 'today') from.setHours(0, 0, 0, 0);
  else if (period === '7d')    from.setDate(from.getDate() - 7);
  else                         from.setDate(from.getDate() - 30);

  try {
    const { data: events } = await supabase
      .from('widget_events')
      .select('event_type, product_no, occurred_at')
      .eq('store_id', mallId)
      .gte('occurred_at', from.toISOString());

    const totals = { impression: 0, chat_start: 0, chip_click: 0, pdp_chip_click: 0, product_click: 0, cart_add: 0, purchase: 0 };
    const byProduct = {};
    const daily = {};

    (events || []).forEach(e => {
      if (totals[e.event_type] !== undefined) totals[e.event_type]++;

      if (e.product_no) {
        if (!byProduct[e.product_no]) byProduct[e.product_no] = { impression: 0, chat_start: 0, product_click: 0, cart_add: 0, purchase: 0 };
        if (byProduct[e.product_no][e.event_type] !== undefined) byProduct[e.product_no][e.event_type]++;
      }

      const day = e.occurred_at.slice(0, 10);
      if (!daily[day]) daily[day] = { chat_start: 0, cart_add: 0, purchase: 0 };
      if (daily[day][e.event_type] !== undefined) daily[day][e.event_type]++;
    });

    res.json({ period, from: from.toISOString(), totals, by_product: byProduct, daily });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// 12. CONVERSATIONS API — 상품별 대화 기록 조회
// GET /api/conversations?mallId=X&productNo=Y&limit=50&offset=0
// ─────────────────────────────────────────────
app.get('/api/conversations', async (req, res) => {
  const { mallId, productNo, limit = 50, offset = 0 } = req.query;
  if (!mallId) return res.status(400).json({ error: 'mallId required' });
  try {
    let q = supabase.from('chat_logs')
      .select('*')
      .eq('store_id', mallId)
      .order('created_at', { ascending: false })
      .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

    if (productNo) q = q.contains('product_ids', [productNo]);

    const { data, error } = await q;
    if (error) throw error;

    const rows = data || [];

    // session_id가 있는 row들에 대해 최종 액션 조회
    const sessionIds = [...new Set(rows.map(r => r.session_id).filter(Boolean))];
    let eventMap = {}; // session_id → final action event_type
    if (sessionIds.length) {
      const { data: events } = await supabase
        .from('widget_events')
        .select('session_id, event_type, occurred_at')
        .eq('store_id', mallId)
        .in('session_id', sessionIds)
        .order('occurred_at', { ascending: false });

      const priority = { purchase: 4, cart_add: 3, product_click: 2, pdp_chip_click: 1, chip_click: 1 };
      (events || []).forEach(e => {
        const cur = eventMap[e.session_id];
        if (!cur || (priority[e.event_type] || 0) > (priority[cur] || 0)) {
          eventMap[e.session_id] = e.event_type;
        }
      });
    }

    const enriched = rows.map(r => ({
      ...r,
      final_action: r.session_id ? (eventMap[r.session_id] || null) : null,
    }));

    res.json({ conversations: enriched, total: enriched.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── AI 사이트 색상 분석 ──────────────────────────────────────────────────────
app.post('/api/analyze-site-colors', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'url required' });

  // 1. HTML 페치
  let html = '';
  try {
    const r = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' },
      maxRedirects: 5,
    });
    html = typeof r.data === 'string' ? r.data : JSON.stringify(r.data);
  } catch (e) {
    return res.status(502).json({ error: `사이트를 가져올 수 없습니다: ${e.message}` });
  }

  // ── 헬퍼 ──
  function toHex6(h) {
    h = h.replace('#','');
    if (h.length === 3) h = h.split('').map(c=>c+c).join('');
    return '#' + h.toUpperCase();
  }
  function rgbToHex(r,g,b) {
    return '#' + [r,g,b].map(v => Math.min(255,parseInt(v)).toString(16).padStart(2,'0')).join('').toUpperCase();
  }
  function luminance(hex) {
    const rv = parseInt(hex.slice(1,3),16)/255;
    const gv = parseInt(hex.slice(3,5),16)/255;
    const bv = parseInt(hex.slice(5,7),16)/255;
    return 0.2126*rv + 0.7152*gv + 0.0722*bv;
  }
  function saturation(hex) {
    const r = parseInt(hex.slice(1,3),16);
    const g = parseInt(hex.slice(3,5),16);
    const b = parseInt(hex.slice(5,7),16);
    const max = Math.max(r,g,b), min = Math.min(r,g,b);
    return max === 0 ? 0 : (max-min)/max;
  }

  // 흔한 링크/기본 브라우저 색 블랙리스트
  const LINK_BLACKLIST = new Set([
    '#226699','#0066CC','#0000FF','#0000EE','#551A8B','#336699',
    '#003366','#004080','#0055B3','#1A0DAB','#4A90D9','#2A6EBB',
    '#FFFF00','#FF0000', // 기본 경고색
  ]);

  // 2. 시맨틱 가중치 기반 색상 추출
  const score = {}; // hex → weighted score

  function addColor(hex, weight) {
    const k = toHex6(hex);
    if (LINK_BLACKLIST.has(k)) return;
    score[k] = (score[k] || 0) + weight;
  }

  // (A) meta theme-color — 최고 가중치
  const themeColors = [];
  const metaThemeRe = /name=["']theme-color["'][^>]*content=["']([^"']+)["']|content=["']([^"']+)["'][^>]*name=["']theme-color["']/gi;
  let mt;
  while ((mt = metaThemeRe.exec(html)) !== null) {
    const v = (mt[1] || mt[2] || '').trim();
    if (v.startsWith('#')) { addColor(v, 200); themeColors.push(toHex6(v)); }
  }

  // (B) CSS 변수(브랜드 컬러) — 높은 가중치
  const cssVarRe = /--(color|brand|primary|accent|main|key|theme|point)[\w-]*\s*:\s*(#[0-9A-Fa-f]{3,6}|rgb\([^)]+\))/gi;
  let cv;
  while ((cv = cssVarRe.exec(html)) !== null) {
    const v = cv[2].trim();
    if (v.startsWith('#')) addColor(v, 80);
    else { const m = v.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i); if (m) addColor(rgbToHex(m[1],m[2],m[3]), 80); }
  }

  // (C) <style> 블록 안 background-color / background / border-color — 중간 가중치
  const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1]).join('\n');
  const bgRe     = /background(?:-color)?\s*:\s*(#[0-9A-Fa-f]{3,6}|rgb\([^)]+\))/gi;
  const borderRe = /border(?:-color|-top|-right|-bottom|-left|-block|-inline)?(?:-color)?\s*:\s*(#[0-9A-Fa-f]{3,6}|rgb\([^)]+\))/gi;
  const colorRe  = /(?:^|[;{])\s*color\s*:\s*(#[0-9A-Fa-f]{3,6}|rgb\([^)]+\))/gim;

  function extractFromCss(src, weight) {
    let m2;
    const reList = [[bgRe, weight], [borderRe, weight * 0.4], [colorRe, weight * 0.3]];
    for (const [re, w] of reList) {
      re.lastIndex = 0;
      while ((m2 = re.exec(src)) !== null) {
        const v = m2[1].trim();
        if (v.startsWith('#')) addColor(v, w);
        else { const rm = v.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i); if (rm) addColor(rgbToHex(rm[1],rm[2],rm[3]), w); }
      }
    }
  }
  extractFromCss(styleBlocks, 15);

  // (D) 인라인 style= 속성의 background-color — 중간 가중치
  const inlineRe = /style=["'][^"']*background(?:-color)?\s*:\s*(#[0-9A-Fa-f]{3,6}|rgb\([^)]+\))[^"']*/gi;
  let il;
  while ((il = inlineRe.exec(html)) !== null) {
    const v = il[1].trim();
    if (v.startsWith('#')) addColor(v, 10);
    else { const m3 = v.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i); if (m3) addColor(rgbToHex(m3[1],m3[2],m3[3]), 10); }
  }

  // (E) 나머지 hex (낮은 가중치, 단 링크 블랙리스트 제외)
  const hexRe = /#([0-9A-Fa-f]{6}|[0-9A-Fa-f]{3})\b/g;
  let hm;
  while ((hm = hexRe.exec(html)) !== null) addColor(hm[0], 1);

  // 3. 필터: 무채색·너무 연한 색 제거 → 상위 12개
  const colored = Object.entries(score)
    .filter(([h]) => {
      const sat = saturation(h);
      const lum = luminance(h);
      return sat > 0.1 && lum > 0.03 && lum < 0.93;
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([hex, sc]) => ({ hex, score: Math.round(sc) }));

  console.log('[analyze-site-colors] top palette:', colored.slice(0,6).map(c=>`${c.hex}(${c.score})`).join(', '));

  if (!colored.length) {
    return res.json({ accentColor: '#3D2B1F', backgroundColor: '#FAF8F5', rationale: '유채색을 찾지 못해 기본값을 반환합니다.' });
  }

  // 4. Gemini로 최적 색상 조합 결정
  const paletteStr = colored.map(c => `${c.hex}(점수:${c.score})`).join(', ');
  const prompt = `You are a professional UI/UX designer specializing in e-commerce.

Website: ${url}
${themeColors.length ? `Meta theme-color (highest priority): ${themeColors.join(', ')}` : ''}
Extracted color palette (by semantic weight — background/CSS-var colors scored higher than generic hex):
${paletteStr}

Choose the best colors for an AI chat widget sidebar that feels native to this brand.
Rules:
- accentColor: the brand's primary/signature color used for buttons & header. Must have contrast ratio ≥ 4.5:1 on white. Prefer dark/rich tones over pale ones.
- backgroundColor: a very light, warm or neutral tint that harmonizes with accentColor. Usually near-white with a slight hue from the brand palette.
- Do NOT pick generic link blue (#226699, #0066cc etc.) unless it clearly dominates the brand palette with high score.
- Prioritize colors with high scores (they came from background-color or CSS variables).

Return ONLY this JSON, no markdown, no explanation:
{"accentColor":"#RRGGBB","backgroundColor":"#RRGGBB","rationale":"한 문장 한국어 설명"}`;

  try {
    const r = await callGemini({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0.2, maxOutputTokens: 300, responseMimeType: 'application/json' },
    });
    const raw = (r.data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
    const jsonMatch = raw.match(/\{[\s\S]*?\}/);
    if (!jsonMatch) throw new Error('JSON not found: ' + raw.slice(0, 100));
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.accentColor || !parsed.backgroundColor) throw new Error('Missing color fields');
    return res.json({ ...parsed, palette: colored.slice(0, 8) });
  } catch (e) {
    console.error('[analyze-site-colors] Gemini error:', e.message);
    // 폴백: 점수 1위 색을 accentColor로, 매우 연한 버전을 bg로
    const accent = colored[0].hex;
    // accent의 매우 연한 버전 계산 (luminance 90% 근처로)
    const r2 = parseInt(accent.slice(1,3),16);
    const g2 = parseInt(accent.slice(3,5),16);
    const b2 = parseInt(accent.slice(5,7),16);
    const bgHex = '#' + [r2,g2,b2].map(c => Math.round(c + (255-c)*0.88).toString(16).padStart(2,'0')).join('').toUpperCase();
    return res.json({ accentColor: accent, backgroundColor: bgHex, rationale: '사이트 대표 배경/브랜드 색상 기반 적용', palette: colored.slice(0,8) });
  }
});

// ─────────────────────────────────────────────
// LOGO FONT ANALYSIS — Gemini Vision으로 로고 폰트 분석
// POST /api/chameleon-admin/analyze-logo
// { fileBase64, mimeType } → { brandName, fontFamily, fontWeight, letterSpacing, textTransform, fontStyle }
// ─────────────────────────────────────────────
app.post('/api/chameleon-admin/analyze-logo', requireAdminAuth, async (req, res) => {
  const { fileBase64, mimeType } = req.body;
  if (!fileBase64 || !mimeType) return res.status(400).json({ error: 'fileBase64, mimeType required' });

  const prompt = `You are a typography expert. Analyze this brand logo image and identify the font used for the main brand name text.

Return ONLY valid JSON with these fields:
{
  "brandName": "the exact brand name text as shown in the logo (uppercase if shown uppercase)",
  "fontFamily": "the closest matching Google Font name (must be a real font available on fonts.google.com)",
  "fontWeight": 700,
  "letterSpacing": "0.05em",
  "textTransform": "uppercase",
  "fontStyle": "normal"
}

Rules:
- fontFamily MUST be a real Google Font (e.g. "Lilita One", "Bebas Neue", "Montserrat", "Raleway", "Oswald", "Anton", "Black Han Sans", "Noto Sans KR", etc.)
- fontWeight: 400, 500, 600, 700, 800, or 900
- letterSpacing: CSS value like "0", "0.05em", "0.1em", "-0.02em"
- textTransform: "uppercase", "lowercase", or "none"
- fontStyle: "normal" or "italic"
- If the logo uses a highly custom/display typeface, choose the closest Google Font match for the overall visual feel (weight, width, style)

Return ONLY the JSON object, no markdown, no explanation.`;

  try {
    const r = await callGemini({
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType, data: fileBase64 } },
          { text: prompt },
        ],
      }],
      // responseMimeType 제거 — 이미지 입력과 함께 쓰면 Gemini가 거부하는 케이스 있음
      generationConfig: { temperature: 0.1, maxOutputTokens: 500 },
    });
    const raw = (r.data.candidates?.[0]?.content?.parts?.[0]?.text || '').trim();
    console.log('[analyze-logo] raw response:', raw.slice(0, 300));
    // 마크다운 코드블록 제거 후 JSON 추출
    const cleaned = raw.replace(/```(?:json)?/gi, '').replace(/```/g, '');
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('JSON not found in response: ' + raw.slice(0, 150));
    const parsed = JSON.parse(jsonMatch[0]);
    if (!parsed.brandName || !parsed.fontFamily) throw new Error('Missing required fields: ' + JSON.stringify(parsed));
    res.json(parsed);
  } catch (e) {
    console.error('[analyze-logo]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// 기존 대시보드 (이전 버전 호환)
app.get('/dashboard', (req, res) => res.redirect('/admin'));

// ─────────────────────────────────────────────
// CHAMELEON INTERNAL ADMIN
// /chameleon-admin — 내부 전용 관리 패널
// ─────────────────────────────────────────────
const ADMIN_PASSWORD = process.env.CHAMELEON_ADMIN_PASSWORD || 'chameleon2025';

function requireAdminAuth(req, res, next) {
  const auth = req.headers['x-admin-password'];
  if (auth !== ADMIN_PASSWORD) return res.status(401).json({ error: 'unauthorized' });
  next();
}

app.get('/chameleon-admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'chameleon-admin.html'));
});

// GET /api/chameleon-admin/shops — 모든 샵 + 통계
app.get('/api/chameleon-admin/shops', requireAdminAuth, async (req, res) => {
  try {
    const { data: shops, error } = await supabase
      .from('shops').select('*').order('created_at', { ascending: false });
    if (error) throw error;

    // 각 샵의 상품 수 + 채팅 수를 병렬로 조회
    const enriched = await Promise.all((shops || []).map(async (shop) => {
      const mallId = shop.mall_id;
      const [prodRes, chatRes] = await Promise.all([
        supabase.from('products').select('product_id', { count: 'exact', head: true }).eq('store_id', mallId).eq('status', 'active'),
        supabase.from('chat_logs').select('id', { count: 'exact', head: true }).eq('store_id', mallId),
      ]);
      return {
        ...shop,
        product_count: prodRes.count || 0,
        chat_count:    chatRes.count || 0,
      };
    }));

    res.json(enriched);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/chameleon-admin/shop/:mallId/logs — 대화 로그
app.get('/api/chameleon-admin/shop/:mallId/logs', requireAdminAuth, async (req, res) => {
  const { mallId } = req.params;
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const offset = parseInt(req.query.offset) || 0;
  try {
    const { data, error } = await supabase
      .from('chat_logs')
      .select('*')
      .eq('store_id', mallId)
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (error) throw error;
    res.json(data || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/chameleon-admin/shop/:mallId/theme — 테마 설정 (Chameleon 전용)
app.post('/api/chameleon-admin/shop/:mallId/theme', requireAdminAuth, async (req, res) => {
  const { mallId } = req.params;
  const { theme_config } = req.body;
  if (!theme_config) return res.status(400).json({ error: 'theme_config required' });
  try {
    // 기존 설정 조회 후 테마만 병합
    const { data: existing } = await supabase.from('shops').select('theme_config').eq('mall_id', mallId).single();
    const merged = { ...(existing?.theme_config || {}), ...theme_config };
    const { error } = await supabase.from('shops').upsert(
      { mall_id: mallId, theme_config: merged, updated_at: new Date().toISOString() },
      { onConflict: 'mall_id' }
    );
    if (error) throw error;
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────
// ─────────────────────────────────────────────
// 자동 마이그레이션 (DATABASE_URL 환경변수 필요)
// Supabase Dashboard → Project Settings → Database → URI
// ─────────────────────────────────────────────
const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS chat_logs (
    id               bigserial PRIMARY KEY,
    store_id         text NOT NULL,
    query            text,
    intent_situation text,
    intent_needs     text,
    result_type      text,
    product_count    int DEFAULT 0,
    product_ids      text[],
    created_at       timestamptz DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS chat_logs_store_created_idx
    ON chat_logs (store_id, created_at DESC)`,
  `CREATE TABLE IF NOT EXISTS shops (
    mall_id      text PRIMARY KEY,
    brand_name   text,
    theme_config jsonb NOT NULL DEFAULT '{}',
    created_at   timestamptz DEFAULT now(),
    updated_at   timestamptz DEFAULT now()
  )`,
  `CREATE TABLE IF NOT EXISTS widget_events (
    id          bigserial PRIMARY KEY,
    store_id    text NOT NULL,
    event_type  text NOT NULL,
    product_no  text,
    chip_label  text,
    session_id  text,
    occurred_at timestamptz DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS widget_events_store_occurred_idx
    ON widget_events (store_id, occurred_at DESC)`,
  `ALTER TABLE chat_logs ADD COLUMN IF NOT EXISTS session_id      text`,
  `ALTER TABLE chat_logs ADD COLUMN IF NOT EXISTS page_url        text`,
  `ALTER TABLE chat_logs ADD COLUMN IF NOT EXISTS persona         text`,
  `ALTER TABLE chat_logs ADD COLUMN IF NOT EXISTS referrer        text`,
  `ALTER TABLE chat_logs ADD COLUMN IF NOT EXISTS intent_keywords text[]`,
  `ALTER TABLE shops     ADD COLUMN IF NOT EXISTS agent_config    jsonb NOT NULL DEFAULT '{}'`,
  `CREATE INDEX IF NOT EXISTS chat_logs_session_idx     ON chat_logs (session_id)`,
  `CREATE INDEX IF NOT EXISTS chat_logs_keywords_idx    ON chat_logs USING gin(intent_keywords)`,
];

async function runMigrations() {
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    console.warn('[Migration] DATABASE_URL 미설정 — chat_logs 테이블 자동 생성 건너뜀');
    console.warn('[Migration] Supabase Dashboard → Project Settings → Database → URI 복사 후 Railway 환경변수에 추가하세요.');
    return;
  }
  const pool = new Pool({ connectionString: dbUrl, ssl: { rejectUnauthorized: false } });
  try {
    for (const sql of MIGRATIONS) {
      await pool.query(sql);
    }
    console.log('[Migration] ✅ chat_logs 테이블 준비 완료');
  } catch (e) {
    console.error('[Migration] 오류:', e.message);
  } finally {
    await pool.end();
  }
}

// 시작 시 DB에서 토큰 복원
loadTokensFromDb().catch(() => {});
runMigrations().catch(() => {});

// Supabase Storage: logos 버킷 없으면 자동 생성 (public)
(async () => {
  try {
    const { data: buckets } = await supabase.storage.listBuckets();
    const exists = buckets?.some(b => b.name === 'logos');
    if (!exists) {
      const { error } = await supabase.storage.createBucket('logos', { public: true });
      if (error) console.warn('[Storage] logos 버킷 생성 실패:', error.message);
      else console.log('[Storage] logos 버킷 생성 완료 (public)');
    }
  } catch (e) {
    console.warn('[Storage] 버킷 확인 실패:', e.message);
  }
})();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔══════════════════════════════════════════╗
║  Chameleon Server running on port ${PORT}   ║
╠══════════════════════════════════════════╣
║  Install URL:                            ║
║  ${APP_BASE_URL}/install?mall_id=tndbsrkd
╚══════════════════════════════════════════╝
  `);
});
