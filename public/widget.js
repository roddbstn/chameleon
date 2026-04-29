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

      /* ── 사이드바 패널 ── */
      .cml-chat-panel {
        position: fixed;
        top: 0;
        right: 0;
        width: 600px;
        max-width: 100vw;
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
        box-shadow: -8px 0 40px rgba(0,0,0,0.10);
      }
      .cml-chat-panel.cml-open { transform: translateX(0); }

      .cml-chat-header {
        padding: 18px 24px;
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
        gap: 10px;
      }
      .cml-chat-header-logo {
        height: 28px;
        width: auto;
        display: block;
      }
      .cml-chat-header-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #22C55E;
        flex-shrink: 0;
      }
      .cml-chat-header-title {
        font-size: 16px;
        font-weight: 700;
        color: #111;
        letter-spacing: 0.01em;
      }
      .cml-chat-close {
        background: none;
        border: none;
        color: #AAA;
        cursor: pointer;
        font-size: 20px;
        line-height: 1;
        padding: 6px;
        border-radius: 6px;
        transition: color 0.15s, background 0.15s;
      }
      .cml-chat-close:hover { color: #333; background: #F4F4F2; }

      /* ── 히어로 영역 ── */
      .cml-chat-hero {
        flex-shrink: 0;
        position: relative;
        overflow: hidden;
      }
      .cml-chat-hero-img {
        width: 100%;
        height: 180px;
        object-fit: cover;
        display: block;
      }
      .cml-chat-hero-overlay {
        position: absolute;
        inset: 0;
        background: linear-gradient(to bottom, rgba(0,0,0,0.08), rgba(0,0,0,0.52));
        display: flex;
        flex-direction: column;
        justify-content: flex-end;
        padding: 20px 24px;
      }
      .cml-chat-hero-title {
        font-size: 22px;
        font-weight: 700;
        color: #fff;
        line-height: 1.3;
        letter-spacing: -0.01em;
        margin-bottom: 4px;
      }
      .cml-chat-hero-body {
        font-size: 13px;
        color: rgba(255,255,255,0.85);
        line-height: 1.5;
      }
      /* 히어로 없이 텍스트만 있을 때 */
      .cml-chat-hero-text-only {
        padding: 20px 24px 0;
        flex-shrink: 0;
      }
      .cml-chat-hero-text-only .cml-chat-hero-title {
        font-size: 20px;
        font-weight: 700;
        color: #111;
        margin-bottom: 4px;
      }
      .cml-chat-hero-text-only .cml-chat-hero-body {
        font-size: 13px;
        color: #666;
      }

      .cml-chat-messages {
        flex: 1;
        overflow-y: auto;
        padding: 16px 20px 8px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .cml-chat-bubble {
        max-width: 82%;
        padding: 12px 16px;
        border-radius: 14px;
        font-size: 14px;
        line-height: 1.75;
        letter-spacing: 0.01em;
        white-space: pre-wrap;
      }
      .cml-chat-bubble strong {
        font-weight: 700;
        font-size: 15px;
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
      /* ── 추천 상품 선반 (입력창 위 고정 영역) ── */
      .cml-product-shelf {
        border-top: 1px solid #EBEBEB;
        background: #FAFAF9;
        flex-shrink: 0;
        max-height: 260px;
        overflow-y: auto;
      }
      .cml-product-shelf-header {
        padding: 8px 14px 4px;
        font-size: 11px;
        font-weight: 600;
        color: #999;
        letter-spacing: 0.05em;
        text-transform: uppercase;
      }
      .cml-shelf-card {
        display: flex;
        align-items: stretch;
        background: #fff;
        border-bottom: 1px solid #F2F2F0;
        transition: background 0.12s;
        min-height: 90px;
      }
      .cml-shelf-card:last-child { border-bottom: none; }
      .cml-shelf-card:hover { background: #F8F8F6; }
      .cml-shelf-card-info {
        flex: 1;
        padding: 10px 8px 10px 14px;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        min-width: 0;
      }
      .cml-shelf-card-name {
        font-size: 12px;
        font-weight: 600;
        color: #111;
        margin-bottom: 3px;
        display: -webkit-box;
        -webkit-line-clamp: 2;
        -webkit-box-orient: vertical;
        overflow: hidden;
        line-height: 1.4;
      }
      .cml-shelf-card-price {
        font-size: 12px;
        color: #444;
        margin-bottom: 8px;
      }
      .cml-shelf-card-btns {
        display: flex;
        gap: 5px;
      }
      .cml-shelf-card-btn {
        padding: 5px 10px;
        border-radius: 5px;
        font-size: 11px;
        font-weight: 500;
        cursor: pointer;
        border: none;
        font-family: inherit;
        text-decoration: none;
        display: inline-block;
        transition: opacity 0.15s;
        text-align: center;
        white-space: nowrap;
      }
      .cml-shelf-card-btn:hover { opacity: 0.82; }
      .cml-shelf-card-btn.primary { background: #111; color: #fff; }
      .cml-shelf-card-btn.secondary { background: #EEEEEC; color: #333; }
      .cml-shelf-card-img {
        width: 75px;
        height: 100px;
        object-fit: cover;
        flex-shrink: 0;
        display: block;
        align-self: center;
        margin: 8px 8px 8px 0;
        border-radius: 6px;
      }
      .cml-shelf-card-img-placeholder {
        width: 75px;
        height: 100px;
        flex-shrink: 0;
        background: #F0F0EE;
        display: flex;
        align-items: center;
        justify-content: center;
        color: #CCC;
        font-size: 10px;
        margin: 8px 8px 8px 0;
        border-radius: 6px;
      }
      .cml-shelf-card-reason {
        font-size: 10px;
        color: #BABAB6;
        font-weight: 300;
        line-height: 1.45;
        margin-top: 4px;
        letter-spacing: 0.01em;
      }

      /* ── 옵션 선택 패널 ── */
      .cml-option-panel {
        margin-top: 8px;
        display: flex;
        flex-direction: column;
        gap: 5px;
      }
      .cml-option-select {
        width: 100%;
        border: 1px solid #D8D8D4;
        border-radius: 6px;
        padding: 6px 8px;
        font-size: 11px;
        color: #333;
        background: #fff;
        font-family: inherit;
        outline: none;
        cursor: pointer;
        appearance: none;
        background-image: url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23999' stroke-width='1.2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
        background-repeat: no-repeat;
        background-position: right 8px center;
        padding-right: 24px;
      }
      .cml-option-select:focus { border-color: #111; }
      .cml-option-select.cml-error { border-color: #C0392B; }
      .cml-cart-confirm-btn {
        width: 100%;
        padding: 7px 0;
        border-radius: 6px;
        font-size: 11px;
        font-weight: 600;
        cursor: pointer;
        border: none;
        background: #111;
        color: #fff;
        font-family: inherit;
        transition: opacity 0.15s;
        letter-spacing: 0.03em;
      }
      .cml-cart-confirm-btn:hover { opacity: 0.82; }
      .cml-cart-confirm-btn:disabled { opacity: 0.4; cursor: default; }

      /* ── 토스트 ── */
      .cml-toast {
        position: fixed;
        bottom: 80px;
        left: 50%;
        transform: translateX(-50%) translateY(10px);
        background: #111;
        color: #fff;
        font-size: 13px;
        font-family: 'Noto Sans KR', 'Apple SD Gothic Neo', sans-serif;
        padding: 10px 20px;
        border-radius: 999px;
        white-space: nowrap;
        z-index: 999999;
        opacity: 0;
        transition: opacity 0.2s, transform 0.2s;
        pointer-events: none;
      }
      .cml-toast.cml-toast-show {
        opacity: 1;
        transform: translateX(-50%) translateY(0);
      }
      .cml-chat-input-row {
        padding: 10px 12px;
        border-top: 1px solid #F0F0EE;
        display: flex;
        gap: 6px;
        align-items: center;
      }
      .cml-chat-input-row {
        padding: 14px 20px;
        border-top: 1px solid #F0F0EE;
        display: flex;
        gap: 10px;
        align-items: center;
        background: #fff;
      }
      .cml-chat-input {
        flex: 1;
        border: 1.5px solid #E0E0DC;
        border-radius: 999px;
        padding: 13px 22px;
        font-size: 15px;
        outline: none;
        font-family: inherit;
        color: #333;
        background: #FAFAF9;
        transition: border-color 0.15s;
      }
      .cml-chat-input:focus { border-color: #111; }
      .cml-chat-input::placeholder { color: #bbb; }
      .cml-chat-send {
        width: 42px;
        height: 42px;
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
        gap: 8px;
        padding: 0 20px 14px;
      }
      .cml-chat-starter-chip {
        border: 1px solid #D8D8D4;
        border-radius: 999px;
        padding: 9px 18px;
        font-size: 13px;
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

      const pdpBase = '/product/detail.html?product_no=';
      cardsEl = document.createElement('div');
      cardsEl.className = 'cml-product-cards';
      cardsEl.innerHTML = products.map(p => {
        const pdpUrl = `${pdpBase}${p.id}`;
        const imgHtml = p.image_url
          ? `<img class="cml-chat-product-img" src="${p.image_url}" alt="${p.name}" loading="lazy">`
          : `<div class="cml-chat-product-img-placeholder">이미지 없음</div>`;
        const priceHtml = p.price
          ? `<div class="cml-chat-product-price">₩${Number(p.price).toLocaleString()}</div>` : '';
        return `
          <div class="cml-chat-product-card">
            ${imgHtml}
            <div class="cml-chat-product-body">
              <div class="cml-chat-product-name">${p.name}</div>
              ${priceHtml}
              <div class="cml-chat-product-btns">
                <a class="cml-chat-product-btn primary" href="${pdpUrl}">자세히 보기</a>
                <a class="cml-chat-product-btn secondary" href="${pdpUrl}">장바구니 담기</a>
              </div>
            </div>
          </div>`;
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
    const branding    = config?.branding || {};
    const chatName    = branding.chatName    || 'AI 쇼핑 도우미';
    const buttonLabel = branding.buttonLabel || 'AI 도우미';
    const logoUrl     = branding.logoUrl     || null;
    const heroImage   = branding.heroImage   || null;
    const welcomeTitle = branding.welcomeTitle || null;
    const welcomeBody  = branding.welcomeBody  || null;

    // 사이드바 탭 (트리거)
    const tab = document.createElement('div');
    tab.id = 'cml-sidebar-tab';
    tab.className = 'cml-sidebar-tab';
    tab.setAttribute('role', 'button');
    tab.setAttribute('aria-label', `${chatName} 열기`);
    tab.innerHTML = `
      <svg class="cml-sidebar-tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
      </svg>
      <span class="cml-sidebar-tab-label">${buttonLabel}</span>
    `;
    document.body.appendChild(tab);

    // 히어로 영역 HTML 조립
    let heroHtml = '';
    if (heroImage) {
      heroHtml = `
        <div class="cml-chat-hero">
          <img class="cml-chat-hero-img" src="${heroImage}" alt="">
          ${(welcomeTitle || welcomeBody) ? `
            <div class="cml-chat-hero-overlay">
              ${welcomeTitle ? `<div class="cml-chat-hero-title">${welcomeTitle}</div>` : ''}
              ${welcomeBody  ? `<div class="cml-chat-hero-body">${welcomeBody}</div>`   : ''}
            </div>` : ''}
        </div>`;
    } else if (welcomeTitle || welcomeBody) {
      heroHtml = `
        <div class="cml-chat-hero-text-only">
          ${welcomeTitle ? `<div class="cml-chat-hero-title">${welcomeTitle}</div>` : ''}
          ${welcomeBody  ? `<div class="cml-chat-hero-body">${welcomeBody}</div>`   : ''}
        </div>`;
    }

    // 헤더 왼쪽: 로고 or dot + 이름
    const headerLeftHtml = logoUrl
      ? `<img class="cml-chat-header-logo" src="${logoUrl}" alt="${chatName}">`
      : `<span class="cml-chat-header-dot"></span><span class="cml-chat-header-title">${chatName}</span>`;

    // 사이드바 패널
    const panel = document.createElement('div');
    panel.id = 'cml-chat-panel';
    panel.className = 'cml-chat-panel';
    panel.innerHTML = `
      <div class="cml-chat-header">
        <div class="cml-chat-header-left">${headerLeftHtml}</div>
        <button class="cml-chat-close" id="cml-chat-close" aria-label="닫기">✕</button>
      </div>
      ${heroHtml}
      <div class="cml-chat-messages" id="cml-chat-messages">
        <div class="cml-chat-bubble assistant">안녕하세요! 원하시는 스타일이나 상황을 말씀해주시면 딱 맞는 아이템 찾아드릴게요 :)</div>
      </div>
      <div class="cml-chat-starter-chips" id="cml-chat-starters">
        <button class="cml-chat-starter-chip" data-q="요즘 트렌디한 아이템 뭐 있어요?">요즘 트렌드</button>
        <button class="cml-chat-starter-chip" data-q="소개팅에 입기 좋은 옷 추천해주세요">소개팅 룩</button>
        <button class="cml-chat-starter-chip" data-q="여름에 시원하게 입을 수 있는 옷 있나요?">여름 아이템</button>
        <button class="cml-chat-starter-chip" data-q="친구한테 선물하기 좋은 거 있어요?">선물 추천</button>
      </div>
      <div class="cml-product-shelf" id="cml-product-shelf" style="display:none">
        <div class="cml-product-shelf-header">추천 상품</div>
        <div id="cml-product-shelf-list"></div>
      </div>
      <div class="cml-chat-input-row">
        <input class="cml-chat-input" id="cml-chat-input" type="text" placeholder="원하는 스타일, 상황을 말해보세요" autocomplete="off" />
        <button class="cml-chat-send" id="cml-chat-send" aria-label="전송">
          <svg width="18" height="18" viewBox="0 0 14 14" fill="none">
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

    // mall별 장바구니 설정
    const cartConfig = config?.cart || {};
    const CART_ENDPOINT = cartConfig.endpoint || '/exec/front/Order/Cart';
    const CART_FIELDS   = cartConfig.fields   || { product_no: 'product_no', option_code: 'option_code', quantity: 'quantity' };

    // 패널 모드: 'push'(사이트 좁히기) | 'overlay'(사이트 위에 덮기)
    const PANEL_MODE = config?.panel?.mode || 'push';

    const SIDEBAR_W = 600;
    const EASE = 'cubic-bezier(0.4,0,0.2,1)';

    // overlay 모드용 backdrop
    let backdrop = null;
    if (PANEL_MODE === 'overlay') {
      backdrop = document.createElement('div');
      backdrop.id = 'cml-backdrop';
      backdrop.style.cssText = `
        display:none; position:fixed; inset:0;
        background:rgba(0,0,0,0.3); z-index:9998;
        transition:opacity 0.28s;
      `;
      document.body.appendChild(backdrop);
      backdrop.addEventListener('click', closeSidebar);
    }

    function openSidebar() {
      panel.classList.add('cml-open');
      tab.classList.add('cml-hidden');
      if (PANEL_MODE === 'push') {
        const t = `width 0.28s ${EASE}, max-width 0.28s ${EASE}`;
        document.documentElement.style.transition = t;
        document.body.style.transition = t;
        document.documentElement.style.maxWidth = `calc(100vw - ${SIDEBAR_W}px)`;
        document.documentElement.style.overflowX = 'hidden';
        document.body.style.width = '100%';
      } else {
        // overlay: 배경 딤 처리만, 페이지 건드리지 않음
        if (backdrop) { backdrop.style.display = 'block'; }
      }
      inputEl.focus();
    }
    function closeSidebar() {
      panel.classList.remove('cml-open');
      tab.classList.remove('cml-hidden');
      if (PANEL_MODE === 'push') {
        document.documentElement.style.maxWidth = '';
        document.documentElement.style.overflowX = '';
      } else {
        if (backdrop) { backdrop.style.display = 'none'; }
      }
    }
    tab.addEventListener('click', openSidebar);
    closeBtn.addEventListener('click', closeSidebar);

    function parseMd(text) {
      return text
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    }

    function addBubble(role, text) {
      const div = document.createElement('div');
      div.className = `cml-chat-bubble ${role}`;
      if (role === 'assistant') {
        div.innerHTML = parseMd(text);
      } else {
        div.textContent = text;
      }
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      return div;
    }

    function addProductCards(products) {
      const shelf = panel.querySelector('#cml-product-shelf');
      const shelfList = panel.querySelector('#cml-product-shelf-list');
      if (!products?.length) {
        shelf.style.display = 'none';
        shelfList.innerHTML = '';
        return;
      }
      const pdpBase = '/product/detail.html?product_no=';
      shelfList.innerHTML = products.map(p => {
        const pdpUrl = `${pdpBase}${p.id}`;
        const imgHtml = p.image_url
          ? `<img class="cml-shelf-card-img" src="${p.image_url}" alt="${p.name}" loading="lazy">`
          : `<div class="cml-shelf-card-img-placeholder">No img</div>`;
        const priceHtml = p.price
          ? `<div class="cml-shelf-card-price">₩${Number(p.price).toLocaleString()}</div>` : '';
        const reasonHtml = p.reason
          ? `<div class="cml-shelf-card-reason">${p.reason}</div>` : '';
        return `
          <div class="cml-shelf-card" data-product-id="${p.id}">
            <div class="cml-shelf-card-info">
              <div>
                <div class="cml-shelf-card-name">${p.name}</div>
                ${priceHtml}
                ${reasonHtml}
              </div>
              <div class="cml-shelf-card-btns">
                <a class="cml-shelf-card-btn primary" href="${pdpUrl}">자세히 보기</a>
                <button class="cml-shelf-card-btn secondary cml-add-cart-btn">장바구니 담기</button>
              </div>
              <div class="cml-option-panel" style="display:none"></div>
            </div>
            ${imgHtml}
          </div>`;
      }).join('');
      shelf.style.display = 'block';
    }

    // ── 토스트 ──
    let toastEl = null;
    let toastTimer = null;
    function showToast(msg) {
      if (!toastEl) {
        toastEl = document.createElement('div');
        toastEl.className = 'cml-toast';
        document.body.appendChild(toastEl);
      }
      toastEl.textContent = msg;
      toastEl.classList.add('cml-toast-show');
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toastEl.classList.remove('cml-toast-show'), 2500);
    }

    // ── 옵션 조회 ──
    async function fetchProductOptions(productId) {
      try {
        const res = await fetch(`${CHAMELEON_SERVER}/api/options?mallId=${MALL_ID}&productNo=${productId}`);
        return await res.json();
      } catch {
        return { options: [], variants: [] };
      }
    }

    // ── 장바구니 담기 (mall별 cart config 사용) ──
    async function submitCart(productId, variantCode) {
      try {
        const body = new URLSearchParams();
        body.append(CART_FIELDS.product_no, String(productId));
        body.append(CART_FIELDS.quantity, '1');
        if (variantCode) body.append(CART_FIELDS.option_code, variantCode);

        // endpoint가 절대 URL이면 그대로, 상대 경로면 mall 도메인으로 resolve
        const url = CART_ENDPOINT.startsWith('http')
          ? CART_ENDPOINT
          : `https://${MALL_ID}.cafe24.com${CART_ENDPOINT}`;

        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
          credentials: 'include',
          redirect: 'manual',
        });
        // 302 redirect 또는 opaque response = 성공으로 처리
        if (res.ok || res.type === 'opaqueredirect' || res.status === 0 || res.status === 302) {
          showToast('장바구니에 담겼어요');
        } else {
          showToast('담기에 실패했어요. 상품 페이지에서 시도해주세요.');
        }
      } catch {
        showToast('담기에 실패했어요. 상품 페이지에서 시도해주세요.');
      }
    }

    // ── 옵션 패널 표시 ──
    function showOptionPanel(card, options, variants) {
      const optPanel = card.querySelector('.cml-option-panel');
      card.dataset.variants = JSON.stringify(variants);

      optPanel.innerHTML = options.map(opt => `
        <select class="cml-option-select" data-option-no="${opt.option_no}">
          <option value="">-- ${opt.option_name} 선택 --</option>
          ${(opt.option_value || []).map(v =>
            `<option value="${v.option_value_no}">${v.option_text}</option>`
          ).join('')}
        </select>
      `).join('') + `
        <button class="cml-cart-confirm-btn">담기 확인</button>
      `;
      optPanel.style.display = 'flex';
    }

    // ── 장바구니 버튼 클릭 이벤트 위임 ──
    const shelfList = panel.querySelector('#cml-product-shelf-list');
    shelfList.addEventListener('click', async (e) => {
      // "장바구니 담기" 버튼
      const cartBtn = e.target.closest('.cml-add-cart-btn');
      if (cartBtn) {
        const card = cartBtn.closest('.cml-shelf-card');
        const productId = card.dataset.productId;
        const optPanel = card.querySelector('.cml-option-panel');

        // 이미 열려있으면 닫기
        if (optPanel.style.display !== 'none') {
          optPanel.style.display = 'none';
          return;
        }

        cartBtn.textContent = '불러오는 중...';
        cartBtn.disabled = true;

        const result = await fetchProductOptions(productId);
        const { options, variants } = result;

        cartBtn.textContent = '장바구니 담기';
        cartBtn.disabled = false;

        if (result.error === 'no_token') {
          // 서버 토큰 없음: PDP로 이동 안내
          showToast('상품 페이지에서 옵션을 선택해주세요.');
          window.location.href = `/product/detail.html?product_no=${productId}`;
          return;
        }

        if (!options.length) {
          // 옵션 없는 상품: 바로 담기
          await submitCart(productId, null);
        } else {
          showOptionPanel(card, options, variants);
        }
        return;
      }

      // "담기 확인" 버튼
      const confirmBtn = e.target.closest('.cml-cart-confirm-btn');
      if (confirmBtn) {
        const card = confirmBtn.closest('.cml-shelf-card');
        const productId = card.dataset.productId;
        const selects = card.querySelectorAll('.cml-option-select');

        // 미선택 옵션 체크
        let allSelected = true;
        selects.forEach(sel => {
          sel.classList.remove('cml-error');
          if (!sel.value) { allSelected = false; sel.classList.add('cml-error'); }
        });
        if (!allSelected) return;

        // 선택된 옵션 값 수집
        const selected = {};
        selects.forEach(sel => { selected[Number(sel.dataset.optionNo)] = Number(sel.value); });

        // 매칭 variant 찾기
        const variants = JSON.parse(card.dataset.variants || '[]');
        const variant = variants.find(v =>
          (v.options || []).length === Object.keys(selected).length &&
          (v.options || []).every(o => selected[o.option_no] === o.option_value_no)
        );

        if (!variant) {
          showToast('해당 옵션 조합을 찾을 수 없어요.');
          return;
        }

        confirmBtn.textContent = '담는 중...';
        confirmBtn.disabled = true;
        await submitCart(productId, variant.variant_code);
        confirmBtn.textContent = '담기 확인';
        confirmBtn.disabled = false;
        card.querySelector('.cml-option-panel').style.display = 'none';
      }
    });

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
