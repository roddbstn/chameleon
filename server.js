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
const axios   = require('axios');
const path    = require('path');

const app = express();
app.use(express.json());

// 카페24 스토어 브라우저에서 우리 서버로 오는 모든 요청에 CORS 허용
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
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

// 토큰 임시 저장 (MVP: 메모리. 실제 서비스에서는 DB 사용)
const tokenStore = {};

// ─────────────────────────────────────────────
// 스토어별 위젯 설정 (우리가 운영하는 config)
// 고객사 온보딩 시 이 값을 세팅해주면 됨
// ─────────────────────────────────────────────
const storeConfigs = {
  tndbsrkd: {
    insert: {
      selector: '.xans-product-detail .infoArea .xans-product-action',
      position: 'afterend',    // 관심상품/장바구니/바로구매 버튼 바로 아래
    },
    theme: {
      accentColor: '#C0392B',
      backgroundColor: '#FEF8F7',
      borderColor: '#F9DDD8',
      borderRadius: '10px',
      fontFamily: "'Noto Sans KR', sans-serif",
    },
  },
  // 다른 고객사 추가 예시:
  // othermall: {
  //   insert: { selector: '.product-description', position: 'beforebegin' },
  //   theme: { accentColor: '#2563EB', ... },
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

  // 기존 태그 중복 방지: 먼저 목록 조회 후 같은 src 있으면 스킵
  const listRes = await axios.get(
    `https://${mallId}.cafe24api.com/api/v2/admin/scripttags`,
    { headers: { Authorization: `Bearer ${accessToken}` } }
  );

  const existing = listRes.data.scripttags || [];
  const alreadyRegistered = existing.some(t => t.src === widgetUrl);

  if (alreadyRegistered) {
    console.log(`[Scripttag] Already registered for ${mallId}`);
    return;
  }

  // 등록
  const res = await axios.post(
    `https://${mallId}.cafe24api.com/api/v2/admin/scripttags`,
    {
      request: {
        src: widgetUrl,
        display_location: ['PRODUCT_DETAIL'], // 상품 상세 페이지에만 로드
      },
    },
    { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } }
  );

  console.log(`[Scripttag] Registered: ${widgetUrl} on ${mallId}`);
  return res.data;
}

// ─────────────────────────────────────────────
// 3. CONFIG API — 위젯이 로드될 때 스토어 설정을 fetch
// ─────────────────────────────────────────────
app.get('/api/config/:mallId', (req, res) => {
  const config = storeConfigs[req.params.mallId] || defaultConfig;
  res.json(config);
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

  // 1순위: 재방문 고객
  if (isReturn) return 'repeat';

  // 2순위: 선물 구매자 신호
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
// 5. ASK API — 상품 관련 자유 질문 → Claude 응답
// ─────────────────────────────────────────────
app.post('/api/ask', async (req, res) => {
  const { mallId, productNo, question } = req.body;
  if (!question) return res.status(400).json({ error: 'question required' });

  if (!process.env.GOOGLE_AI_API_KEY) {
    return res.json({
      answer: `"${question}"에 대한 답변 기능은 준비 중입니다. 곧 연결될 예정이에요!`,
    });
  }

  try {
    const geminiRes = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GOOGLE_AI_API_KEY}`,
      {
        contents: [{
          parts: [{
            text: `당신은 쇼핑몰 상품 전문 어시스턴트입니다.
쇼핑몰: ${mallId}, 상품번호: ${productNo}

고객 질문: ${question}

친절하고 간결하게 2-3문장으로 답변해주세요. 모르는 정보는 솔직하게 말하고, 구매에 도움이 되는 방향으로 답변하세요.`,
          }],
        }],
        generationConfig: { maxOutputTokens: 300 },
      }
    );

    const answer = geminiRes.data.candidates?.[0]?.content?.parts?.[0]?.text
      || '죄송해요, 다시 시도해주세요.';
    res.json({ answer });
  } catch (err) {
    console.error('[Ask API Error]', err.response?.data || err.message);
    res.status(500).json({ answer: '죄송해요, 지금 답변을 생성할 수 없어요. 잠시 후 다시 시도해주세요.' });
  }
});

// ─────────────────────────────────────────────
// 6. 간단한 대시보드 — 수집된 이벤트 확인용
// ─────────────────────────────────────────────
app.get('/dashboard', (req, res) => {
  const summary = eventLog.reduce((acc, e) => {
    acc[e.persona] = (acc[e.persona] || 0) + 1;
    return acc;
  }, {});

  res.json({
    total_events: eventLog.length,
    persona_breakdown: summary,
    recent: eventLog.slice(-10).reverse(),
  });
});

// ─────────────────────────────────────────────
// Start
// ─────────────────────────────────────────────
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
