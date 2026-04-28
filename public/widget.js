/**
 * Chameleon Widget — Cafe24 Adaptive PDP
 *
 * 이 파일은 Scripttag API를 통해 카페24 상점의 상품 상세 페이지(PDP)에
 * 자동으로 로드됩니다. 브라우저에서 실행되며 페이지를 수정하지 않고
 * Adaptive 패널만 DOM에 추가합니다.
 */
(function () {
  'use strict';

  // ── 설정 ───────────────────────────────────
  const CHAMELEON_SERVER = 'https://chameleon-production-7bf7.up.railway.app';
  // 카페24 전역 객체에서 mall_id 추출, 없으면 hostname에서 추출
  const MALL_ID =
    (window.CAFE24 && (CAFE24?.SHOP?.MALL_ID || CAFE24?.GLOBAL_INFO?.mall_id)) ||
    location.hostname.replace('.cafe24.com', '').split('.')[0];

  // ── 상품 상세 페이지인지 확인 ────────────────
  // 카페24 PDP URL 두 가지 형식 모두 지원:
  // 1. /product/detail.html?product_no=17  (기본형)
  // 2. /product/[상품명]/17/category/50/   (SEO형 - 숫자 세그먼트로 판별)
  const path = location.pathname;
  const isSeoProduct = /^\/product\/[^/]+\/\d+\//.test(path);
  const isPDP = path.includes('/product/detail.html') ||
                (path.includes('/product/') && location.search.includes('product_no')) ||
                isSeoProduct;

  // ── 1. 신호 수집 ─────────────────────────────
  function collectSignals() {
    const params    = new URLSearchParams(location.search);
    const utmSource = params.get('utm_source') || '';
    const utmCampaign = params.get('utm_campaign') || '';

    // 재방문 여부: 이전 방문 기록을 localStorage에서 확인
    const visitKey  = `chameleon_visit_${MALL_ID}`;
    const isReturn  = !!localStorage.getItem(visitKey);
    localStorage.setItem(visitKey, Date.now()); // 방문 기록 갱신

    // 사이트 내 검색어: 카페24는 URL에 q= 파라미터로 전달
    const searchQuery = sessionStorage.getItem('chameleon_search') ||
                        new URLSearchParams(document.referrer.split('?')[1] || '').get('keyword') || '';

    // SEO URL에서 product_no 추출: /product/[이름]/17/category/...
    const seoMatch = location.pathname.match(/^\/product\/[^/]+\/(\d+)\//);
    const productNo = params.get('product_no') || seoMatch?.[1] || '';

    return {
      mallId:      MALL_ID,
      productNo,
      referrer:    document.referrer,
      utmSource,
      utmCampaign,
      isReturn,
      searchQuery,
    };
  }

  // ── 2. 현재 상품 정보 DOM에서 읽기 ─────────────
  function getProductInfo() {
    // 카페24 PDP의 공통 셀렉터들
    const name  = document.querySelector('.xans-product-detail .product-name, [class*="product-name"]')?.textContent?.trim() || '';
    const price = document.querySelector('[id*="price_text"], .product-price')?.textContent?.trim() || '';
    const code  = document.querySelector('.product-code, [class*="product-code"]')?.textContent?.trim() || '';
    return { name, price, code };
  }

  // ── 3. Intent API 호출 ─────────────────────────
  async function fetchPersona(signals) {
    try {
      const res = await fetch(`${CHAMELEON_SERVER}/api/intent`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(signals),
      });
      const data = await res.json();
      return data.persona || 'fashion';
    } catch {
      return 'fashion'; // 서버 오류 시 기본값
    }
  }

  // ── 4. 페르소나별 컨텐츠 ─────────────────────────
  const PERSONA_DATA = {
    fashion: {
      theme:     'cml-theme-fashion',
      badge:     '시즌 키 아이템',
      title:     '이번 시즌 룩을 완성하는 아이템',
      body:      '테리 패브릭의 리치한 텍스처와 밴딩 디테일이 만들어내는 구조적인 실루엣. 일본산 원단 특유의 중량감이 캐주얼과 세미포멀의 경계를 허문다.\n스타일링 만족도 4.7/5.',
      chips:     ['어떤 상의와 매칭해요?', '일본 원단 퀄리티는?', '세탁 후 수축 있나요?'],
      upsell:    '이 상품과 함께 구매한 고객: 블랙 크루 삭스 + 모노 슬립온',
    },
    gift: {
      theme:     'cml-theme-gift',
      badge:     '선물 추천',
      title:     '받는 사람이 더 좋아할 선물',
      body:      '무난한 블랙 컬러에 고급스러운 테리 소재 — 취향을 타지 않아요. 밴딩 핏이라 사이즈 걱정 없이 고를 수 있습니다.\n2일 이내 배송 · 브랜드 쇼핑백 포함 · 60일 교환 보장.',
      chips:     ['사이즈 교환 되나요?', '선물 포장 가능한가요?', '영수증 없이 교환 되나요?'],
      upsell:    '선물세트로 구성하기: 상품 + 솔리드홈므 에코백 (+₩18,000)',
    },
    repeat: {
      theme:     'cml-theme-repeat',
      badge:     '재방문 고객',
      title:     '지난 시즌 쇼츠의 업데이트 버전입니다',
      body:      '기존 핏 그대로 — 소재만 일본산으로 업그레이드되었습니다. 현재 30, 32 사이즈 재고 있음.\n재구매 시 무료배송 + 로열티 포인트 2배 적립.',
      chips:     ['이전 버전과 핏 같나요?', '포인트 적립 언제 되나요?', '같은 시즌 다른 아이템은?'],
      upsell:    '이전 구매 고객 검증 완료 — 동일 핏으로 리오더하기',
    },
  };

  // ── 5. 패널 HTML 생성 ──────────────────────────
  function buildPanelHTML(persona, config) {
    const p = PERSONA_DATA[persona];
    const t = config?.theme || {};
    // CSS 변수로 theme 색상 주입
    const cssVars = `
      --cml-accent: ${t.accentColor || '#C0392B'};
      --cml-bg: ${t.backgroundColor || '#FEF8F7'};
      --cml-border: ${t.borderColor || '#F9DDD8'};
      --cml-radius: ${t.borderRadius || '10px'};
      --cml-font: ${t.fontFamily || "'Noto Sans KR', sans-serif"};
    `;
    return `
      <div class="cml-panel ${p.theme}" id="cml-panel" style="${cssVars}">
        <div class="cml-badge">
          <span class="cml-dot"></span>${p.badge}
        </div>
        <div class="cml-card">
          <div class="cml-card-header">
            <span class="cml-card-icon"></span>
            <span class="cml-card-title">${p.title}</span>
          </div>
          <div class="cml-card-body">${p.body.replace(/\n/g, '<br>')}</div>
        </div>
        <div class="cml-chips">
          ${p.chips.map(c => `<button class="cml-chip" data-q="${c}">${c}</button>`).join('')}
        </div>
        <div class="cml-upsell">💡 ${p.upsell}</div>
        <div class="cml-answer" id="cml-answer" style="display:none;"></div>
        <div class="cml-ask">
          <input class="cml-ask-input" id="cml-ask-input" type="text" placeholder="원하는 스타일이나 상황을 말해보세요" autocomplete="off" />
          <button class="cml-ask-btn" id="cml-ask-btn" aria-label="질문하기">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M1 7h12M7 1l6 6-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
        </div>
      </div>
    `;
  }

  // ── 6. 스타일 주입 ─────────────────────────────
  function injectStyles() {
    if (document.getElementById('cml-styles')) return;
    const style = document.createElement('style');
    style.id = 'cml-styles';
    style.textContent = `
      .cml-panel {
        margin-top: 20px;
        border-top: 1px solid #E8E8E4;
        padding-top: 18px;
        animation: cmlFadeUp 0.35s ease;
        font-family: 'Noto Sans KR', 'Apple SD Gothic Neo', sans-serif;
        font-size: 12px;
      }
      @keyframes cmlFadeUp {
        from { opacity: 0; transform: translateY(8px); }
        to   { opacity: 1; transform: translateY(0); }
      }

      /* ── 배지 ── */
      .cml-badge {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 4px 10px;
        border-radius: 999px;
        font-size: 10px;
        letter-spacing: 0.06em;
        margin-bottom: 12px;
      }
      .cml-dot {
        width: 6px; height: 6px;
        border-radius: 50%;
        display: inline-block;
        flex-shrink: 0;
      }

      /* ── 테마 색상 — CSS 변수 기반 (서버 config로 제어) ── */
      .cml-panel .cml-badge  { background: color-mix(in srgb, var(--cml-accent) 10%, white); color: var(--cml-accent); }
      .cml-panel .cml-dot    { background: var(--cml-accent); }
      .cml-panel .cml-card   { border-color: var(--cml-border); background: var(--cml-bg); font-family: var(--cml-font); border-radius: var(--cml-radius); }
      .cml-panel .cml-card-title { color: var(--cml-accent); }
      .cml-panel .cml-card-icon  { border-color: var(--cml-accent); }

      /* ── 카드 ── */
      .cml-card {
        border: 1px solid;
        border-radius: 10px;
        padding: 14px 16px;
        margin-bottom: 12px;
      }
      .cml-card-header {
        display: flex;
        align-items: center;
        gap: 7px;
        margin-bottom: 8px;
      }
      .cml-card-icon {
        width: 13px; height: 13px;
        border-radius: 50%;
        border: 2px solid;
        flex-shrink: 0;
      }
      .cml-card-title {
        font-size: 12px;
        font-weight: 500;
        letter-spacing: 0.04em;
      }
      .cml-card-body {
        font-size: 11px;
        line-height: 1.85;
        color: #444;
        letter-spacing: 0.03em;
      }

      /* ── FAQ 칩 ── */
      .cml-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-bottom: 12px;
      }
      .cml-chip {
        border: 1px solid #D0D0CC;
        border-radius: 999px;
        padding: 5px 12px;
        font-size: 10px;
        letter-spacing: 0.03em;
        color: #555;
        background: #fff;
        cursor: pointer;
        transition: all 0.15s;
        font-family: inherit;
      }
      .cml-chip:hover { border-color: #888; color: #222; }

      /* ── 업셀 ── */
      .cml-upsell {
        background: #F8F8F6;
        border-radius: 8px;
        padding: 10px 14px;
        font-size: 10px;
        letter-spacing: 0.04em;
        color: #555;
        line-height: 1.6;
        margin-bottom: 12px;
      }

      /* ── AI 응답 영역 ── */
      .cml-answer {
        background: #fff;
        border: 1px solid #E8E8E4;
        border-radius: 8px;
        padding: 12px 14px;
        font-size: 11px;
        line-height: 1.85;
        color: #333;
        letter-spacing: 0.03em;
        margin-bottom: 10px;
        white-space: pre-wrap;
      }
      .cml-answer.loading {
        color: #aaa;
        font-style: italic;
      }

      /* ── 추천 상품 카드 ── */
      .cml-product-cards {
        display: flex;
        flex-direction: column;
        gap: 8px;
        margin-bottom: 10px;
      }
      .cml-product-card {
        display: flex;
        align-items: center;
        justify-content: space-between;
        background: #fff;
        border: 1px solid #E8E8E4;
        border-radius: 8px;
        padding: 10px 14px;
        text-decoration: none;
        color: inherit;
        transition: border-color 0.15s, box-shadow 0.15s;
      }
      .cml-product-card:hover {
        border-color: var(--cml-accent);
        box-shadow: 0 2px 8px rgba(0,0,0,0.06);
      }
      .cml-product-card-info { flex: 1; min-width: 0; }
      .cml-product-card-name {
        font-size: 11px;
        font-weight: 500;
        color: #222;
        letter-spacing: 0.03em;
        margin-bottom: 2px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .cml-product-card-price {
        font-size: 11px;
        color: #555;
      }
      .cml-product-card-badge {
        font-size: 10px;
        color: var(--cml-accent);
        background: color-mix(in srgb, var(--cml-accent) 10%, white);
        border-radius: 999px;
        padding: 2px 8px;
        flex-shrink: 0;
        margin-left: 8px;
      }

      /* ── 질문 입력창 ── */
      .cml-ask {
        display: flex;
        align-items: center;
        gap: 6px;
        border: 1px solid #D0D0CC;
        border-radius: 999px;
        padding: 6px 6px 6px 14px;
        background: #fff;
        transition: border-color 0.15s;
      }
      .cml-ask:focus-within {
        border-color: var(--cml-accent);
      }
      .cml-ask-input {
        flex: 1;
        border: none;
        outline: none;
        font-size: 11px;
        color: #333;
        background: transparent;
        font-family: inherit;
        letter-spacing: 0.03em;
      }
      .cml-ask-input::placeholder { color: #aaa; }
      .cml-ask-btn {
        width: 26px; height: 26px;
        border-radius: 50%;
        background: var(--cml-accent);
        color: #fff;
        border: none;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        transition: opacity 0.15s;
      }
      .cml-ask-btn:hover { opacity: 0.85; }
      .cml-ask-btn:disabled { opacity: 0.4; cursor: default; }

      /* ── 사이드바 탭 (닫혔을 때 트리거) ── */
      .cml-sidebar-tab {
        position: fixed;
        top: 50%;
        right: 0;
        transform: translateY(-50%);
        z-index: 99999;
        display: flex;
        flex-direction: column;
        align-items: center;
        gap: 10px;
        background: #fff;
        border: 1px solid #E4E4E0;
        border-right: none;
        border-radius: 12px 0 0 12px;
        padding: 16px 10px;
        cursor: pointer;
        box-shadow: -4px 0 16px rgba(0,0,0,0.07);
        transition: opacity 0.2s, box-shadow 0.2s;
        user-select: none;
        font-family: 'Noto Sans KR', 'Apple SD Gothic Neo', sans-serif;
      }
      .cml-sidebar-tab:hover { box-shadow: -6px 0 20px rgba(0,0,0,0.12); }
      .cml-sidebar-tab.cml-hidden { opacity: 0; pointer-events: none; }
      .cml-sidebar-tab-icon {
        width: 22px;
        height: 22px;
        color: #111;
      }
      .cml-sidebar-tab-label {
        writing-mode: vertical-rl;
        text-orientation: mixed;
        font-size: 11px;
        font-weight: 500;
        color: #333;
        letter-spacing: 0.12em;
      }

      /* ── 사이드바 패널 (오버레이 없이 페이지 옆에 붙음) ── */
      .cml-chat-panel {
        position: fixed;
        top: 0;
        right: 0;
        width: 340px;
        height: 100dvh;
        background: #fafafa;
        border-left: 1px solid #E8E8E4;
        display: flex;
        flex-direction: column;
        z-index: 9999;
        font-family: 'Noto Sans KR', 'Apple SD Gothic Neo', sans-serif;
        font-size: 13px;
        transform: translateX(100%);
        transition: transform 0.28s cubic-bezier(0.4,0,0.2,1);
      }
      .cml-chat-panel.cml-open { transform: translateX(0); }

      .cml-chat-header {
        padding: 16px 20px;
        background: #fff;
        border-bottom: 1px solid #EBEBEB;
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-shrink: 0;
      }
      .cml-chat-header-left {
        display: flex;
        align-items: center;
        gap: 8px;
      }
      .cml-chat-header-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #22C55E;
        flex-shrink: 0;
      }
      .cml-chat-header-title {
        font-size: 14px;
        font-weight: 600;
        color: #111;
        letter-spacing: 0.01em;
      }
      .cml-chat-close {
        background: none;
        border: none;
        color: #AAA;
        cursor: pointer;
        font-size: 18px;
        line-height: 1;
        padding: 4px;
        border-radius: 4px;
        transition: color 0.15s, background 0.15s;
      }
      .cml-chat-close:hover { color: #333; background: #F4F4F2; }
      .cml-chat-messages {
        flex: 1;
        overflow-y: auto;
        padding: 14px 14px 8px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .cml-chat-bubble {
        max-width: 85%;
        padding: 10px 14px;
        border-radius: 12px;
        font-size: 13px;
        line-height: 1.75;
        letter-spacing: 0.01em;
        white-space: pre-wrap;
      }
      .cml-chat-bubble.user {
        align-self: flex-end;
        background: #111;
        color: #fff;
        border-bottom-right-radius: 4px;
      }
      .cml-chat-bubble.assistant {
        align-self: flex-start;
        background: #F4F4F2;
        color: #222;
        border-bottom-left-radius: 4px;
      }
      .cml-chat-bubble.loading {
        color: #aaa;
        font-style: italic;
      }
      .cml-chat-products {
        display: flex;
        flex-direction: column;
        gap: 6px;
        align-self: flex-start;
        width: 85%;
      }
      .cml-chat-product-card {
        display: flex;
        align-items: center;
        justify-content: space-between;
        background: #fff;
        border: 1px solid #E8E8E4;
        border-radius: 8px;
        padding: 8px 12px;
        text-decoration: none;
        color: inherit;
        font-size: 11px;
        transition: border-color 0.15s;
      }
      .cml-chat-product-card:hover { border-color: #111; }
      .cml-chat-product-name {
        font-weight: 500;
        color: #222;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        flex: 1;
        min-width: 0;
      }
      .cml-chat-product-price {
        font-size: 10px;
        color: #777;
        margin-top: 1px;
      }
      .cml-chat-product-sim {
        font-size: 10px;
        color: #111;
        background: #F0F0EE;
        border-radius: 999px;
        padding: 2px 7px;
        margin-left: 8px;
        flex-shrink: 0;
      }
      .cml-chat-input-row {
        padding: 10px 12px;
        border-top: 1px solid #F0F0EE;
        display: flex;
        gap: 6px;
        align-items: center;
      }
      .cml-chat-input {
        flex: 1;
        border: 1px solid #E0E0DC;
        border-radius: 999px;
        padding: 9px 16px;
        font-size: 13px;
        outline: none;
        font-family: inherit;
        color: #333;
        background: #FAFAF9;
      }
      .cml-chat-input:focus { border-color: #111; }
      .cml-chat-input::placeholder { color: #bbb; }
      .cml-chat-send {
        width: 28px;
        height: 28px;
        border-radius: 50%;
        background: #111;
        color: #fff;
        border: none;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        transition: opacity 0.15s;
      }
      .cml-chat-send:hover { opacity: 0.8; }
      .cml-chat-send:disabled { opacity: 0.35; cursor: default; }
      .cml-chat-starter-chips {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        padding: 0 14px 10px;
      }
      .cml-chat-starter-chip {
        border: 1px solid #D8D8D4;
        border-radius: 999px;
        padding: 7px 14px;
        font-size: 12px;
        color: #555;
        background: #fff;
        cursor: pointer;
        font-family: inherit;
        transition: border-color 0.12s, color 0.12s;
      }
      .cml-chat-starter-chip:hover { border-color: #888; color: #111; }
    `;
    document.head.appendChild(style);
  }

  // ── 7. 패널 삽입 위치 찾기 (config 기반) ──────────────
  function findInsertTarget(config) {
    // 1순위: 서버 config에서 지정한 셀렉터
    if (config?.insert?.selector) {
      const el = document.querySelector(config.insert.selector);
      if (el) {
        console.log(`[Chameleon] 삽입 위치 (config): ${config.insert.selector}`);
        return el;
      }
    }
    // 2순위: 범용 fallback
    const fallbacks = [
      '.xans-product-detail .infoArea .xans-product-action',
      '.xans-product-action',
      '.xans-product-buy',
      '.prd-add-info',
      'form[name="product_order_info"]',
      '.product-info',
    ];
    for (const sel of fallbacks) {
      const el = document.querySelector(sel);
      if (el) {
        console.log(`[Chameleon] 삽입 위치 (fallback): ${sel}`);
        return el;
      }
    }
    return null;
  }

  // ── 8. 패널 렌더링 ──────────────────────────────
  function renderPanel(persona, config) {
    document.getElementById('cml-panel')?.remove();

    const target = findInsertTarget(config);
    if (!target) {
      console.warn('[Chameleon] 삽입 위치를 찾지 못했습니다.');
      return;
    }

    const wrapper = document.createElement('div');
    wrapper.innerHTML = buildPanelHTML(persona, config);
    const panel = wrapper.firstElementChild;

    // config에서 position 읽기 (기본: afterend)
    const position = config?.insert?.position || 'afterend';
    target.insertAdjacentElement(position, panel);

    const answerEl = panel.querySelector('#cml-answer');
    const inputEl  = panel.querySelector('#cml-ask-input');
    const btnEl    = panel.querySelector('#cml-ask-btn');

    // 대화 히스토리 (멀티턴)
    const conversationHistory = [];

    // 추천 상품 카드 렌더링
    function renderProductCards(products) {
      let cardsEl = panel.querySelector('.cml-product-cards');
      if (cardsEl) cardsEl.remove();
      if (!products || !products.length) return;

      cardsEl = document.createElement('div');
      cardsEl.className = 'cml-product-cards';
      cardsEl.innerHTML = products.map(p => {
        const url = `/product/detail.html?product_no=${p.id}`;
        const price = p.price ? `₩${Number(p.price).toLocaleString()}` : '';
        const sim = p.similarity ? `${Math.round(p.similarity * 100)}% 일치` : '';
        return `
          <a class="cml-product-card" href="${url}">
            <div class="cml-product-card-info">
              <div class="cml-product-card-name">${p.name}</div>
              ${price ? `<div class="cml-product-card-price">${price}</div>` : ''}
            </div>
            ${sim ? `<span class="cml-product-card-badge">${sim}</span>` : ''}
          </a>
        `;
      }).join('');

      answerEl.insertAdjacentElement('afterend', cardsEl);
    }

    // FAQ 칩 → /api/ask (상품 Q&A)
    async function askProductQuestion(question) {
      if (!question.trim()) return;
      answerEl.textContent = '답변을 생성하고 있어요...';
      answerEl.className = 'cml-answer loading';
      answerEl.style.display = 'block';
      btnEl.disabled = true;
      panel.querySelector('.cml-product-cards')?.remove();

      try {
        const res = await fetch(`${CHAMELEON_SERVER}/api/ask`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mallId:    MALL_ID,
            productNo: collectSignals().productNo,
            question,
          }),
        });
        const data = await res.json();
        answerEl.textContent = data.answer || '죄송해요, 다시 시도해주세요.';
        answerEl.className = 'cml-answer';
      } catch {
        answerEl.textContent = '네트워크 오류가 발생했어요.';
        answerEl.className = 'cml-answer';
      } finally {
        btnEl.disabled = false;
      }
    }

    // 자유 입력 → /api/recommend (AI 추천, 멀티턴)
    async function sendRecommend(query) {
      if (!query.trim()) return;
      answerEl.textContent = '추천을 찾고 있어요...';
      answerEl.className = 'cml-answer loading';
      answerEl.style.display = 'block';
      btnEl.disabled = true;
      panel.querySelector('.cml-product-cards')?.remove();

      try {
        const res = await fetch(`${CHAMELEON_SERVER}/api/recommend`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mallId: MALL_ID,
            query,
            conversationHistory,
          }),
        });
        const data = await res.json();

        if (data.type === 'clarification') {
          answerEl.textContent = data.message;
          answerEl.className = 'cml-answer';
          // 대화 히스토리에 추가 (clarification은 assistant 턴)
          conversationHistory.push({ role: 'user', content: query });
          conversationHistory.push({ role: 'assistant', content: data.message });
        } else if (data.type === 'recommendation') {
          answerEl.textContent = data.message;
          answerEl.className = 'cml-answer';
          renderProductCards(data.products);
          conversationHistory.push({ role: 'user', content: query });
          conversationHistory.push({ role: 'assistant', content: data.message });
          // 히스토리 최대 10턴 유지
          if (conversationHistory.length > 20) conversationHistory.splice(0, 2);
        } else if (data.type === 'no_results') {
          answerEl.textContent = data.message;
          answerEl.className = 'cml-answer';
        } else {
          answerEl.textContent = data.message || data.error || '죄송해요, 다시 시도해주세요.';
          answerEl.className = 'cml-answer';
        }
      } catch {
        answerEl.textContent = '네트워크 오류가 발생했어요. 잠시 후 다시 시도해주세요.';
        answerEl.className = 'cml-answer';
      } finally {
        btnEl.disabled = false;
      }
    }

    // FAQ 칩 클릭 → 상품 Q&A (이벤트 위임: 동적 교체 후에도 작동)
    panel.querySelector('.cml-chips').addEventListener('click', e => {
      const chip = e.target.closest('.cml-chip');
      if (!chip) return;
      inputEl.value = chip.dataset.q;
      askProductQuestion(chip.dataset.q);
    });

    // 입력창 제출 → AI 추천
    btnEl.addEventListener('click', () => {
      const q = inputEl.value;
      inputEl.value = '';
      sendRecommend(q);
    });
    inputEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.isComposing) {
        const q = inputEl.value;
        inputEl.value = '';
        sendRecommend(q);
      }
    });
  }

  // ── 9. 동적 FAQ 칩 교체 ─────────────────────────
  async function fetchDynamicChips(productNo, persona) {
    try {
      const res = await fetch(`${CHAMELEON_SERVER}/api/chips`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mallId: MALL_ID, productNo, persona }),
      });
      const data = await res.json();
      if (!data.chips?.length) return;

      const chipsEl = document.querySelector('#cml-panel .cml-chips');
      if (!chipsEl) return;
      chipsEl.innerHTML = data.chips
        .map(c => `<button class="cml-chip" data-q="${c}">${c}</button>`)
        .join('');
    } catch { /* 실패해도 기본 칩 유지 */ }
  }

  // ── 10. 사이드바 채팅 ──────────────────────────
  function renderFab(config) {
    if (document.getElementById('cml-sidebar-tab')) return;

    const accentColor = config?.theme?.accentColor || '#111';

    // 사이드바 탭 (트리거)
    const tab = document.createElement('div');
    tab.id = 'cml-sidebar-tab';
    tab.className = 'cml-sidebar-tab';
    tab.setAttribute('role', 'button');
    tab.setAttribute('aria-label', 'AI 쇼핑 어시스턴트 열기');
    tab.innerHTML = `
      <svg class="cml-sidebar-tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
      <span class="cml-sidebar-tab-label">AI 도우미</span>
    `;
    document.body.appendChild(tab);


    // 사이드바 패널
    const panel = document.createElement('div');
    panel.id = 'cml-chat-panel';
    panel.className = 'cml-chat-panel';
    panel.innerHTML = `
      <div class="cml-chat-header">
        <div class="cml-chat-header-left">
          <span class="cml-chat-header-dot"></span>
          <span class="cml-chat-header-title">AI 쇼핑 도우미</span>
        </div>
        <button class="cml-chat-close" id="cml-chat-close" aria-label="닫기">✕</button>
      </div>
      <div class="cml-chat-messages" id="cml-chat-messages">
        <div class="cml-chat-bubble assistant">안녕하세요! 원하시는 스타일이나 상황을 말씀해주시면 딱 맞는 아이템 찾아드릴게요 :)</div>
      </div>
      <div class="cml-chat-starter-chips" id="cml-chat-starters">
        <button class="cml-chat-starter-chip" data-q="요즘 트렌디한 아이템 뭐 있어요?">요즘 트렌드</button>
        <button class="cml-chat-starter-chip" data-q="소개팅에 입기 좋은 옷 추천해주세요">소개팅 룩</button>
        <button class="cml-chat-starter-chip" data-q="여름에 시원하게 입을 수 있는 옷 있나요?">여름 아이템</button>
        <button class="cml-chat-starter-chip" data-q="친구한테 선물하기 좋은 거 있어요?">선물 추천</button>
      </div>
      <div class="cml-chat-input-row">
        <input class="cml-chat-input" id="cml-chat-input" type="text" placeholder="원하는 스타일, 상황을 말해보세요" autocomplete="off" />
        <button class="cml-chat-send" id="cml-chat-send" aria-label="전송">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path d="M1 7h12M7 1l6 6-6 6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>
    `;
    document.body.appendChild(panel);

    const closeBtn   = panel.querySelector('#cml-chat-close');
    const messagesEl = panel.querySelector('#cml-chat-messages');
    const inputEl    = panel.querySelector('#cml-chat-input');
    const sendBtn    = panel.querySelector('#cml-chat-send');
    const startChips = panel.querySelectorAll('.cml-chat-starter-chip');

    const chatHistory = [];

    const SIDEBAR_W = 340;
    const EASE = 'cubic-bezier(0.4,0,0.2,1)';

    function openSidebar() {
      panel.classList.add('cml-open');
      tab.classList.add('cml-hidden');
      const t = `width 0.28s ${EASE}, max-width 0.28s ${EASE}`;
      document.documentElement.style.transition = t;
      document.body.style.transition = t;
      document.documentElement.style.maxWidth = `calc(100vw - ${SIDEBAR_W}px)`;
      document.documentElement.style.overflowX = 'hidden';
      document.body.style.width = '100%';
      inputEl.focus();
    }
    function closeSidebar() {
      panel.classList.remove('cml-open');
      tab.classList.remove('cml-hidden');
      document.documentElement.style.maxWidth = '';
      document.documentElement.style.overflowX = '';
    }
    tab.addEventListener('click', openSidebar);
    closeBtn.addEventListener('click', closeSidebar);

    function addBubble(role, text) {
      const div = document.createElement('div');
      div.className = `cml-chat-bubble ${role}`;
      div.textContent = text;
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return div;
    }

    function addProductCards(products) {
      if (!products?.length) return;
      const wrap = document.createElement('div');
      wrap.className = 'cml-chat-products';
      wrap.innerHTML = products.map(p => `
        <a class="cml-chat-product-card" href="/product/detail.html?product_no=${p.id}">
          <div>
            <div class="cml-chat-product-name">${p.name}</div>
            ${p.price ? `<div class="cml-chat-product-price">₩${Number(p.price).toLocaleString()}</div>` : ''}
          </div>
          ${p.similarity ? `<span class="cml-chat-product-sim">${Math.round(p.similarity * 100)}%</span>` : ''}
        </a>
      `).join('');
      messagesEl.appendChild(wrap);
      messagesEl.scrollTop = messagesEl.scrollHeight;
    }

    async function sendChat(query) {
      if (!query.trim()) return;

      // 스타터 칩 숨기기
      panel.querySelector('#cml-chat-starters').style.display = 'none';

      addBubble('user', query);
      const loadingBubble = addBubble('assistant loading', '추천을 찾고 있어요...');
      sendBtn.disabled = true;

      try {
        const res = await fetch(`${CHAMELEON_SERVER}/api/recommend`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mallId: MALL_ID, query, conversationHistory: chatHistory }),
        });
        const data = await res.json();

        loadingBubble.remove();
        const msg = data.message || data.error || '죄송해요, 다시 시도해주세요.';
        addBubble('assistant', msg);

        if (data.type === 'recommendation') {
          addProductCards(data.products);
          chatHistory.push({ role: 'user', content: query });
          chatHistory.push({ role: 'assistant', content: msg });
          if (chatHistory.length > 20) chatHistory.splice(0, 2);
        } else if (data.type === 'clarification') {
          chatHistory.push({ role: 'user', content: query });
          chatHistory.push({ role: 'assistant', content: msg });
        }
      } catch {
        loadingBubble.remove();
        addBubble('assistant', '네트워크 오류가 발생했어요. 잠시 후 다시 시도해주세요.');
      } finally {
        sendBtn.disabled = false;
        inputEl.focus();
      }
    }

    sendBtn.addEventListener('click', () => {
      const q = inputEl.value; inputEl.value = ''; sendChat(q);
    });
    inputEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.isComposing) { const q = inputEl.value; inputEl.value = ''; sendChat(q); }
    });
    startChips.forEach(chip => {
      chip.addEventListener('click', () => sendChat(chip.dataset.q));
    });
  }

  // ── 10. 실행 ────────────────────────────────────
  async function init() {
    injectStyles();

    const [config, signals] = await Promise.all([
      fetch(`${CHAMELEON_SERVER}/api/config/${MALL_ID}`).then(r => r.json()).catch(() => null),
      Promise.resolve(collectSignals()),
    ]);

    // 모든 페이지: 플로팅 채팅 버튼
    renderFab(config);

    // PDP 전용: Adaptive 패널
    if (isPDP) {
      signals.scrollDepth = Math.round(
        (window.scrollY / (document.body.scrollHeight - window.innerHeight)) * 100
      );
      const persona = await fetchPersona(signals);
      console.log('[Chameleon] Persona:', persona);
      renderPanel(persona, config);
      // 패널 렌더 후 비동기로 칩 교체 (블로킹 없음)
      fetchDynamicChips(signals.productNo, persona);
    }
  }

  // DOM 준비 후 실행
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
