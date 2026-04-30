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
  const MALL_ID =
    (window.CAFE24 && (CAFE24?.SHOP?.MALL_ID || CAFE24?.GLOBAL_INFO?.mall_id)) ||
    location.hostname.replace('.cafe24.com', '').split('.')[0];

  // ── 상품 상세 페이지인지 확인 ────────────────
  const path = location.pathname;
  const isSeoProduct = /^\/product\/[^/]+\/\d+\//.test(path);
  const isPDP = window.__CHAMELEON_DEMO ||
                path.includes('/product/detail.html') ||
                (path.includes('/product/') && location.search.includes('product_no')) ||
                isSeoProduct;

  // ── 1. 신호 수집 ─────────────────────────────
  function collectSignals() {
    const params    = new URLSearchParams(location.search);
    const utmSource = params.get('utm_source') || '';
    const utmCampaign = params.get('utm_campaign') || '';
    const visitKey  = `chameleon_visit_${MALL_ID}`;
    const isReturn  = !!localStorage.getItem(visitKey);
    localStorage.setItem(visitKey, Date.now());
    const searchQuery = sessionStorage.getItem('chameleon_search') ||
                        new URLSearchParams(document.referrer.split('?')[1] || '').get('keyword') || '';
    const seoMatch = location.pathname.match(/^\/product\/[^/]+\/(\d+)\//);
    const productNo = params.get('product_no') || seoMatch?.[1] || '';
    return { mallId: MALL_ID, productNo, referrer: document.referrer, utmSource, utmCampaign, isReturn, searchQuery };
  }

  // ── 2. 현재 상품 정보 DOM에서 읽기 ─────────────
  function getProductInfo() {
    const name  = document.querySelector('.xans-product-detail .product-name, [class*="product-name"]')?.textContent?.trim() || '';
    const price = document.querySelector('[id*="price_text"], .product-price')?.textContent?.trim() || '';
    const code  = document.querySelector('.product-code, [class*="product-code"]')?.textContent?.trim() || '';
    const desc  = document.querySelector('[class*="product-desc"] p, .product-desc p, .xans-product-detail p')?.textContent?.trim() || '';
    return { name, price, code, desc };
  }

  // ── 3. 상품별 AI 콘텐츠 로딩 ────────────────────
  async function fetchPdpContent(productNo, productName, productDesc) {
    try {
      const res = await fetch(`${CHAMELEON_SERVER}/api/pdp-content`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mallId: MALL_ID, productNo, productName, productDesc }),
      });
      const data = await res.json();
      return data;
    } catch { return null; }
  }

  // ── 4. 패널 HTML 생성 ──────────────────────────
  function buildPanelHTML(content, config) {
    const t = config?.theme || {};
    const accentColor = content?.accentColor || t.accentColor || '#C0392B';
    const cssVars = `
      --cml-accent: ${accentColor};
      --cml-bg: color-mix(in srgb, ${accentColor} 5%, white);
      --cml-border: color-mix(in srgb, ${accentColor} 18%, white);
      --cml-radius: ${t.borderRadius || '10px'};
      --cml-font: ${t.fontFamily || "'Noto Sans KR', sans-serif"};
    `;
    const badge = content?.badge || 'AI 쇼핑 도우미';
    const title = content?.title || '';
    const body  = content?.body  || '';
    // 칩 풀에서 3개 무작위 선택 — 새로고침마다 다른 조합
    const allChips = (content?.chips?.length >= 3)
      ? content.chips.slice().sort(() => Math.random() - 0.5).slice(0, 3)
      : (content?.chips || ['소재가 어떻게 되나요?', '사이즈 선택 어떻게 하나요?', '어떤 상황에 어울려요?']);
    return `
      <div class="cml-panel" id="cml-panel" style="${cssVars}">
        <div class="cml-badge"><span class="cml-dot"></span>${badge}</div>
        ${title || body ? `
        <div class="cml-card">
          ${title ? `<div class="cml-card-header"><span class="cml-card-icon"></span><span class="cml-card-title">${title}</span></div>` : ''}
          ${body  ? `<div class="cml-card-body">${body.replace(/\n/g, '<br>')}</div>` : ''}
        </div>` : ''}
        <div class="cml-chips-label">클릭하면 AI가 바로 답해드려요 →</div>
        <div class="cml-chips">
          ${allChips.map(c => `<button class="cml-chip" data-q="${c}">${c}</button>`).join('')}
        </div>
      </div>
    `;
  }

  // ── 6. body 스타일 주입 (page-shift + PDP 패널 CSS) ─────
  // 사이드바 CSS는 Shadow DOM 안에 주입 (renderFab 참고)
  function injectStyles() {
    if (document.getElementById('cml-styles')) return;
    const style = document.createElement('style');
    style.id = 'cml-styles';
    style.textContent = `
      /* ── body margin 방식 page-shift ── */
      body {
        transition: margin-right 0.28s cubic-bezier(0.4,0,0.2,1);
        box-sizing: border-box;
      }
      body.cml-page-shift {
        margin-right: var(--cml-shift-width, 600px) !important;
      }
      body.cml-resizing { transition: none !important; }
      body.cml-page-shift :is(
        .cart-drawer, .mini-cart, .drawer,
        .dropdown-menu, .site-nav__dropdown,
        .predictive-search, .header__submenu,
        [role="dialog"], [role="menu"], [role="listbox"]
      ) {
        max-width: calc(100vw - var(--cml-shift-width, 600px)) !important;
        box-sizing: border-box;
      }
      @media (max-width: 767px) {
        body.cml-page-shift { margin-right: 0 !important; }
      }

      /* ── PDP 인라인 패널 ── */
      .cml-panel {
        margin-top: 20px;
        border-top: 1px solid #E8E8E4;
        padding-top: 18px;
        animation: cmlFadeUp 0.35s ease;
        font-family: 'Noto Sans KR', 'Apple SD Gothic Neo', sans-serif;
        font-size: 14px;
      }
      @keyframes cmlFadeUp {
        from { opacity: 0; transform: translateY(8px); }
        to   { opacity: 1; transform: translateY(0); }
      }
      .cml-badge {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 4px 12px; border-radius: 999px;
        font-size: 12px; letter-spacing: 0.06em; margin-bottom: 12px;
      }
      .cml-dot { width: 6px; height: 6px; border-radius: 50%; display: inline-block; flex-shrink: 0; }
      .cml-panel .cml-badge  { background: color-mix(in srgb, var(--cml-accent) 10%, white); color: var(--cml-accent); }
      .cml-panel .cml-dot    { background: var(--cml-accent); }
      .cml-panel .cml-card   { border-color: var(--cml-border); background: var(--cml-bg); font-family: var(--cml-font); border-radius: var(--cml-radius); }
      .cml-panel .cml-card-title { color: var(--cml-accent); }
      .cml-panel .cml-card-icon  { border-color: var(--cml-accent); }
      .cml-card { border: 1px solid; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; }
      .cml-card-header { display: flex; align-items: center; gap: 7px; margin-bottom: 8px; }
      .cml-card-icon { width: 13px; height: 13px; border-radius: 50%; border: 2px solid; flex-shrink: 0; }
      .cml-card-title { font-size: 14px; font-weight: 600; letter-spacing: 0.02em; }
      .cml-card-body { font-size: 13px; line-height: 1.85; color: #444; letter-spacing: 0.02em; }
      .cml-chips-label {
        font-size: 11px; color: #999; letter-spacing: 0.04em; margin-bottom: 8px;
      }
      .cml-chips { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: 4px; }
      .cml-chip {
        border: 1px solid #D0D0CC; border-radius: 999px; padding: 7px 14px;
        font-size: 12px; letter-spacing: 0.02em; color: #444; background: #fff;
        cursor: pointer; transition: all 0.15s; font-family: inherit;
      }
      .cml-chip:hover { border-color: var(--cml-accent); color: var(--cml-accent); background: var(--cml-bg); }
      .cml-answer {
        background: #fff; border: 1px solid #E8E8E4; border-radius: 8px;
        padding: 12px 14px; font-size: 13px; line-height: 1.85; color: #333;
        letter-spacing: 0.02em; margin-bottom: 10px; white-space: pre-wrap;
      }
      .cml-answer.loading { color: #aaa; font-style: italic; }
      .cml-product-cards { display: flex; flex-direction: column; gap: 8px; margin-bottom: 10px; }
      .cml-product-card {
        display: flex; align-items: center; justify-content: space-between;
        background: #fff; border: 1px solid #E8E8E4; border-radius: 8px;
        padding: 10px 14px; text-decoration: none; color: inherit;
        transition: border-color 0.15s, box-shadow 0.15s;
      }
      .cml-product-card:hover { border-color: var(--cml-accent); box-shadow: 0 2px 8px rgba(0,0,0,0.06); }
      .cml-product-card-info { flex: 1; min-width: 0; }
      .cml-product-card-name {
        font-size: 13px; font-weight: 500; color: #222; letter-spacing: 0.02em;
        margin-bottom: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      }
      .cml-product-card-price { font-size: 13px; color: #555; }
      .cml-product-card-badge {
        font-size: 12px; color: var(--cml-accent);
        background: color-mix(in srgb, var(--cml-accent) 10%, white);
        border-radius: 999px; padding: 2px 10px; flex-shrink: 0; margin-left: 8px;
      }
      .cml-ask {
        display: flex; align-items: center; gap: 6px;
        border: 1px solid #D0D0CC; border-radius: 999px;
        padding: 6px 6px 6px 14px; background: #fff; transition: border-color 0.15s;
      }
      .cml-ask:focus-within { border-color: var(--cml-accent); }
      .cml-ask-input {
        flex: 1; border: none; outline: none; font-size: 13px; color: #333;
        background: transparent; font-family: inherit; letter-spacing: 0.02em;
      }
      .cml-ask-input::placeholder { color: #aaa; }
      .cml-ask-btn {
        width: 26px; height: 26px; border-radius: 50%; background: var(--cml-accent);
        color: #fff; border: none; cursor: pointer; display: flex; align-items: center;
        justify-content: center; flex-shrink: 0; transition: opacity 0.15s;
      }
      .cml-ask-btn:hover { opacity: 0.85; }
      .cml-ask-btn:disabled { opacity: 0.4; cursor: default; }
    `;
    document.head.appendChild(style);
  }

  // ── 사이드바 Shadow DOM용 CSS ─────────────────────────
  const SIDEBAR_CSS = `
    :host { all: initial; }

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
    .cml-sidebar-tab-icon { width: 22px; height: 22px; color: #111; }
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
      top: 0; right: 0;
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
    .cml-chat-header-left { display: flex; align-items: center; gap: 10px; }
    .cml-chat-header-logo { height: 28px; width: auto; display: block; }
    .cml-chat-header-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: #22C55E; flex-shrink: 0;
    }
    .cml-chat-header-title { font-size: 16px; font-weight: 700; color: #111; letter-spacing: 0.01em; }
    .cml-chat-header-actions { display: flex; align-items: center; gap: 2px; }
    .cml-chat-close,
    .cml-chat-refresh {
      background: none; border: none; color: #AAA; cursor: pointer;
      line-height: 1; padding: 7px; border-radius: 7px;
      transition: color 0.15s, background 0.15s;
      display: flex; align-items: center; justify-content: center;
    }
    .cml-chat-close { font-size: 18px; }
    .cml-chat-refresh svg { width: 16px; height: 16px; }
    .cml-chat-close:hover,
    .cml-chat-refresh:hover { color: #333; background: #F4F4F2; }

    /* ── 히어로 영역 ── */
    .cml-chat-hero { flex-shrink: 0; position: relative; overflow: hidden; }
    .cml-chat-hero-img { width: 100%; height: 180px; object-fit: cover; display: block; }
    .cml-chat-hero-overlay {
      position: absolute; inset: 0;
      background: linear-gradient(to bottom, rgba(0,0,0,0.08), rgba(0,0,0,0.52));
      display: flex; flex-direction: column; justify-content: flex-end; padding: 20px 24px;
    }
    .cml-chat-hero-title {
      font-size: 22px; font-weight: 700; color: #fff;
      line-height: 1.3; letter-spacing: -0.01em; margin-bottom: 4px;
    }
    .cml-chat-hero-body { font-size: 13px; color: rgba(255,255,255,0.85); line-height: 1.5; }
    .cml-chat-hero-text-only { padding: 20px 24px 0; flex-shrink: 0; }
    .cml-chat-hero-text-only .cml-chat-hero-title {
      font-size: 20px; font-weight: 700; color: #111; margin-bottom: 4px;
    }
    .cml-chat-hero-text-only .cml-chat-hero-body { font-size: 13px; color: #666; }

    /* ── 메시지 영역 ── */
    .cml-chat-messages {
      flex: 1; overflow-y: auto;
      padding: 16px 20px 8px;
      display: flex; flex-direction: column; gap: 10px;
    }
    .cml-chat-bubble {
      max-width: 82%;
      padding: 12px 16px;
      border-radius: 14px;
      font-size: 15px;
      line-height: 1.75;
      letter-spacing: 0.01em;
      white-space: pre-wrap;
    }
    .cml-chat-bubble strong { font-weight: 700; font-size: 16px; }
    .cml-chat-bubble.user {
      align-self: flex-end; background: #111; color: #fff; border-bottom-right-radius: 4px;
    }
    .cml-chat-bubble.assistant {
      align-self: flex-start; background: #F4F4F2; color: #222; border-bottom-left-radius: 4px;
    }
    .cml-chat-bubble.loading { color: #aaa; font-style: italic; }

    /* ── 추천 상품 카루셀 ── */
    .cml-product-shelf {
      border-top: 1px solid #EBEBEB;
      background: #FAFAF9;
      flex-shrink: 0;
    }
    .cml-product-shelf-header {
      padding: 10px 16px 6px;
      font-size: 11px; font-weight: 600; color: #999;
      letter-spacing: 0.05em; text-transform: uppercase;
    }
    #cml-product-shelf-list {
      display: flex;
      flex-direction: row;
      overflow-x: auto;
      gap: 10px;
      padding: 0 16px 14px;
      scroll-snap-type: x mandatory;
      -webkit-overflow-scrolling: touch;
    }
    #cml-product-shelf-list::-webkit-scrollbar { height: 3px; }
    #cml-product-shelf-list::-webkit-scrollbar-track { background: transparent; }
    #cml-product-shelf-list::-webkit-scrollbar-thumb { background: #DDD; border-radius: 2px; }
    .cml-shelf-card {
      flex: 0 0 172px;
      background: #fff;
      border: 1px solid #EBEBEB;
      border-radius: 10px;
      overflow: hidden;
      scroll-snap-align: start;
      display: flex;
      flex-direction: column;
      transition: box-shadow 0.15s;
    }
    .cml-shelf-card:hover { box-shadow: 0 4px 16px rgba(0,0,0,0.09); }
    .cml-shelf-card-img-wrap {
      position: relative;
      width: 172px;
      height: 229px;
      flex-shrink: 0;
    }
    .cml-shelf-card-img {
      width: 100%; height: 100%; object-fit: cover; display: block;
    }
    .cml-shelf-card-img-placeholder {
      width: 100%; height: 100%; background: #F0F0EE;
      display: flex; align-items: center; justify-content: center;
      color: #CCC; font-size: 11px;
    }
    .cml-shelf-card-num {
      position: absolute; top: 8px; left: 8px;
      width: 22px; height: 22px;
      background: rgba(0,0,0,0.60); color: #fff;
      font-size: 11px; font-weight: 700; border-radius: 50%;
      display: flex; align-items: center; justify-content: center;
    }
    .cml-shelf-card-info {
      flex: 1; padding: 10px 10px 8px;
      display: flex; flex-direction: column; gap: 3px;
    }
    .cml-shelf-card-name {
      font-size: 13px; font-weight: 600; color: #111;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
      overflow: hidden; line-height: 1.4;
    }
    .cml-shelf-card-price { font-size: 13px; color: #444; }
    .cml-shelf-card-reason {
      font-size: 11px; color: #BABAB6; font-weight: 300;
      line-height: 1.4; letter-spacing: 0.01em;
    }
    .cml-shelf-card-btns { display: flex; flex-direction: column; gap: 4px; margin-top: 6px; }
    .cml-shelf-card-btn {
      padding: 6px 8px; border-radius: 6px; font-size: 11px; font-weight: 500;
      cursor: pointer; border: none; font-family: inherit; text-decoration: none;
      display: block; transition: opacity 0.15s; text-align: center; white-space: nowrap;
    }
    .cml-shelf-card-btn:hover { opacity: 0.82; }
    .cml-shelf-card-btn.primary { background: #111; color: #fff; }
    .cml-shelf-card-btn.secondary { background: #EEEEEC; color: #333; }

    /* ── 드래그 리사이즈 핸들 ── */
    .cml-resize-handle {
      position: absolute; left: 0; top: 0;
      width: 5px; height: 100%;
      cursor: col-resize; z-index: 10;
      border-radius: 0 3px 3px 0;
      transition: background 0.15s;
    }
    .cml-resize-handle:hover,
    .cml-resize-handle.cml-dragging { background: rgba(0,0,0,0.10); }

    /* ── 옵션 선택 패널 ── */
    .cml-option-panel { margin-top: 8px; display: flex; flex-direction: column; gap: 5px; }
    .cml-option-select {
      width: 100%; border: 1px solid #D8D8D4; border-radius: 6px;
      padding: 6px 8px; font-size: 11px; color: #333; background: #fff;
      font-family: inherit; outline: none; cursor: pointer; appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%23999' stroke-width='1.2' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
      background-repeat: no-repeat; background-position: right 8px center; padding-right: 24px;
    }
    .cml-option-select:focus { border-color: #111; }
    .cml-option-select.cml-error { border-color: #C0392B; }
    .cml-cart-confirm-btn {
      width: 100%; padding: 7px 0; border-radius: 6px; font-size: 11px; font-weight: 600;
      cursor: pointer; border: none; background: #111; color: #fff;
      font-family: inherit; transition: opacity 0.15s; letter-spacing: 0.03em;
    }
    .cml-cart-confirm-btn:hover { opacity: 0.82; }
    .cml-cart-confirm-btn:disabled { opacity: 0.4; cursor: default; }

    /* ── 토스트 ── */
    .cml-toast {
      position: fixed;
      bottom: 80px; left: 50%;
      transform: translateX(-50%) translateY(10px);
      background: #111; color: #fff; font-size: 13px;
      font-family: 'Noto Sans KR', 'Apple SD Gothic Neo', sans-serif;
      padding: 10px 20px; border-radius: 999px; white-space: nowrap;
      z-index: 999999; opacity: 0;
      transition: opacity 0.2s, transform 0.2s; pointer-events: none;
    }
    .cml-toast.cml-toast-show { opacity: 1; transform: translateX(-50%) translateY(0); }

    /* ── 입력창 ── */
    .cml-chat-input-row {
      padding: 14px 20px 32px; border-top: 1px solid #F0F0EE;
      display: flex; gap: 10px; align-items: center; background: #fff;
    }
    .cml-chat-input {
      flex: 1; border: 1.5px solid #E0E0DC; border-radius: 999px;
      padding: 13px 22px; font-size: 16px; outline: none; font-family: inherit;
      color: #333; background: #FAFAF9; transition: border-color 0.15s;
    }
    .cml-chat-input:focus { border-color: #111; }
    .cml-chat-input::placeholder { color: #bbb; }
    .cml-chat-send {
      width: 42px; height: 42px; border-radius: 50%; background: #111; color: #fff;
      border: none; cursor: pointer; display: flex; align-items: center;
      justify-content: center; flex-shrink: 0; transition: opacity 0.15s;
    }
    .cml-chat-send:hover { opacity: 0.8; }
    .cml-chat-send:disabled { opacity: 0.35; cursor: default; }

    /* ── 스타터 칩 ── */
    .cml-chat-starter-chips {
      display: flex; flex-wrap: wrap; gap: 8px; padding: 0 20px 14px;
    }
    .cml-chat-starter-chip {
      border: 1px solid #D8D8D4; border-radius: 999px; padding: 10px 20px;
      font-size: 14px; color: #555; background: #fff; cursor: pointer;
      font-family: inherit; transition: border-color 0.12s, color 0.12s;
    }
    .cml-chat-starter-chip:hover { border-color: #888; color: #111; }

    /* ── backdrop (overlay 모드) ── */
    #cml-backdrop {
      display: none; position: fixed; inset: 0;
      background: rgba(0,0,0,0.3); z-index: 9998; transition: opacity 0.28s;
    }

    /* ── SneakPeek 말풍선 ── */
    .cml-sneak-peek {
      position: fixed; right: 62px; top: 50%; transform: translateY(-50%);
      background: #fff; border: 1px solid #E4E4E0; border-radius: 12px;
      padding: 10px 14px; font-size: 13px; color: #333;
      font-family: 'Noto Sans KR', 'Apple SD Gothic Neo', sans-serif;
      line-height: 1.55; z-index: 99998;
      box-shadow: -2px 4px 16px rgba(0,0,0,0.10); max-width: 180px;
      opacity: 0; transition: opacity 0.35s; pointer-events: none;
    }
    .cml-sneak-peek.cml-sneak-show { opacity: 1; }
    .cml-sneak-peek::after {
      content: ''; position: absolute; right: -6px; top: 50%;
      transform: translateY(-50%) rotate(45deg);
      width: 10px; height: 10px; background: #fff;
      border-right: 1px solid #E4E4E0; border-top: 1px solid #E4E4E0;
    }

    /* ── 모바일 (≤767px) ── */
    @media (max-width: 767px) {
      .cml-chat-panel { width: 100vw !important; }
      .cml-sidebar-tab {
        top: auto; bottom: 20px; right: 16px; transform: none;
        border-radius: 999px; flex-direction: row; padding: 12px 18px; gap: 8px;
        border-right: 1px solid #E4E4E0;
      }
      .cml-sidebar-tab-label {
        writing-mode: initial; text-orientation: initial;
        font-size: 13px; letter-spacing: 0.04em;
      }
      .cml-sneak-peek {
        top: auto; bottom: 76px; right: 16px; transform: none; max-width: 220px;
      }
      .cml-sneak-peek::after {
        top: auto; bottom: -6px; right: 24px; transform: rotate(135deg);
      }
    }
  `;

  // ── 7. 패널 삽입 위치 찾기 (config 기반) ──────────────
  function findInsertTarget(config) {
    if (config?.insert?.selector) {
      const el = document.querySelector(config.insert.selector);
      if (el) { console.log(`[Chameleon] 삽입 위치 (config): ${config.insert.selector}`); return el; }
    }
    const fallbacks = [
      '.xans-product-detail .infoArea .xans-product-action',
      '.xans-product-action', '.xans-product-buy', '.prd-add-info',
      'form[name="product_order_info"]', '.product-info',
    ];
    for (const sel of fallbacks) {
      const el = document.querySelector(sel);
      if (el) { console.log(`[Chameleon] 삽입 위치 (fallback): ${sel}`); return el; }
    }
    return null;
  }

  // ── 8. 패널 렌더링 (PDP 인라인) ──────────────────────
  function renderPanel(content, config, productCtx) {
    document.getElementById('cml-panel')?.remove();
    const target = findInsertTarget(config);
    if (!target) { console.warn('[Chameleon] 삽입 위치를 찾지 못했습니다.'); return; }

    const wrapper = document.createElement('div');
    wrapper.innerHTML = buildPanelHTML(content, config);
    const panel = wrapper.firstElementChild;

    const position = config?.insert?.position || 'afterend';
    target.insertAdjacentElement(position, panel);

    // 칩 클릭 → 사이드바 열기 + 이 상품에 특정된 Q&A 요청
    panel.querySelector('.cml-chips').addEventListener('click', e => {
      const chip = e.target.closest('.cml-chip');
      if (!chip) return;
      document.dispatchEvent(new CustomEvent('chameleon:ask', {
        detail: {
          query: chip.dataset.q,
          mode: 'product_qa',                      // 일반 추천이 아닌 상품 특정 Q&A
          productNo:   productCtx?.productNo   || '',
          productName: productCtx?.productName || '',
        },
      }));
    });
  }

  // ── 10. 사이드바 채팅 (Shadow DOM 격리) ──────────────
  function renderFab(config) {
    // 중복 초기화 방지
    if (document.getElementById('cml-host')) return;

    // ── Shadow DOM 설정 ──
    const host = document.createElement('div');
    host.id = 'cml-host';
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: 'open' });

    // 위젯 CSS → Shadow 내부에 주입 (쇼핑몰 CSS와 완전 격리)
    const styleEl = document.createElement('style');
    styleEl.textContent = SIDEBAR_CSS;
    shadow.appendChild(styleEl);

    // ── 설정 값 추출 ──
    const branding    = config?.branding || {};
    const chatName    = branding.chatName    || 'AI 쇼핑 도우미';
    const buttonLabel = branding.buttonLabel || 'AI 도우미';
    const logoUrl     = branding.logoUrl     || null;
    const heroImage   = branding.heroImage   || null;
    const welcomeTitle = branding.welcomeTitle || null;
    const welcomeBody  = branding.welcomeBody  || null;

    // ── 사이드바 탭 (트리거) ──
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
    shadow.appendChild(tab);

    // ── 히어로 HTML ──
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

    // ── 헤더 왼쪽 ──
    const headerLeftHtml = logoUrl
      ? `<img class="cml-chat-header-logo" src="${logoUrl}" alt="${chatName}">`
      : `<span class="cml-chat-header-dot"></span><span class="cml-chat-header-title">${chatName}</span>`;

    // ── 사이드바 패널 ──
    const panel = document.createElement('div');
    panel.id = 'cml-chat-panel';
    panel.className = 'cml-chat-panel';
    // ── 스타터 칩 (config 또는 기본값) ──
    const defaultChips = [
      { label: '요즘 트렌드', query: '요즘 트렌디한 아이템 뭐 있어요?' },
      { label: '소개팅 룩',  query: '소개팅에 입기 좋은 옷 추천해주세요' },
      { label: '여름 아이템', query: '여름에 시원하게 입을 수 있는 옷 있나요?' },
      { label: '선물 추천',  query: '친구한테 선물하기 좋은 거 있어요?' },
    ];
    const starterChips = branding.starterChips || defaultChips;
    const starterChipsHtml = starterChips
      .map(c => `<button class="cml-chat-starter-chip" data-q="${c.query}">${c.label}</button>`)
      .join('');

    panel.innerHTML = `
      <div class="cml-resize-handle" id="cml-resize-handle"></div>
      <div class="cml-chat-header">
        <div class="cml-chat-header-left">${headerLeftHtml}</div>
        <div class="cml-chat-header-actions">
          <button class="cml-chat-refresh" id="cml-chat-refresh" aria-label="대화 초기화" title="대화 초기화">
            <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
              <path d="M2.5 8a5.5 5.5 0 1 1 1.1 3.3"/>
              <polyline points="1 5.5 2.5 8 5 6.5"/>
            </svg>
          </button>
          <button class="cml-chat-close" id="cml-chat-close" aria-label="닫기">✕</button>
        </div>
      </div>
      ${heroHtml}
      <div class="cml-chat-messages" id="cml-chat-messages">
        <div class="cml-chat-bubble assistant">안녕하세요! 원하시는 스타일이나 상황을 말씀해주시면 딱 맞는 아이템 찾아드릴게요 :)</div>
      </div>
      <div class="cml-chat-starter-chips" id="cml-chat-starters">
        ${starterChipsHtml}
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
    shadow.appendChild(panel);

    const closeBtn   = panel.querySelector('#cml-chat-close');
    const refreshBtn = panel.querySelector('#cml-chat-refresh');
    const messagesEl = panel.querySelector('#cml-chat-messages');
    const inputEl    = panel.querySelector('#cml-chat-input');
    const sendBtn    = panel.querySelector('#cml-chat-send');
    const startChips = panel.querySelectorAll('.cml-chat-starter-chip');

    const chatHistory = [];
    let lastProducts  = [];

    // ── 세션 유지 ──
    const SESSION_KEY = `cml_session_${MALL_ID}`;
    const messageLog  = [];

    function saveSession(products) {
      try {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify({
          messages: messageLog, history: chatHistory, products: products || [],
        }));
      } catch (e) {}
    }

    function clearSession() {
      try { sessionStorage.removeItem(SESSION_KEY); } catch (e) {}
    }

    function restoreSession() {
      try {
        const raw = sessionStorage.getItem(SESSION_KEY);
        if (!raw) return;
        const { messages, history, products } = JSON.parse(raw);
        messagesEl.innerHTML = '';
        panel.querySelector('#cml-chat-starters').style.display = 'none';
        (messages || []).forEach(m => {
          const div = document.createElement('div');
          div.className = `cml-chat-bubble ${m.role}`;
          if (m.role === 'assistant') div.innerHTML = parseMd(m.text);
          else div.textContent = m.text;
          messagesEl.appendChild(div);
        });
        messagesEl.scrollTop = messagesEl.scrollHeight;
        (history || []).forEach(h => chatHistory.push(h));
        messageLog.push(...(messages || []));
        if (products?.length) addProductCards(products);
      } catch (e) {}
    }

    // ── mall별 장바구니 설정 ──
    const cartConfig    = config?.cart || {};
    const CART_ENDPOINT = cartConfig.endpoint || '/exec/front/Order/Cart';
    const CART_FIELDS   = cartConfig.fields   || { product_no: 'product_no', option_code: 'option_code', quantity: 'quantity' };
    const PANEL_MODE    = config?.panel?.mode || 'push';
    const SIDEBAR_W     = 600;

    // overlay 모드용 backdrop
    let backdrop = null;
    if (PANEL_MODE === 'overlay') {
      backdrop = document.createElement('div');
      backdrop.id = 'cml-backdrop';
      shadow.appendChild(backdrop);
      backdrop.addEventListener('click', closeSidebar);
    }

    function openSidebar() {
      panel.classList.add('cml-open');
      tab.classList.add('cml-hidden');
      const isMobile = window.innerWidth < 768;
      if (PANEL_MODE === 'push' && !isMobile) {
        document.body.style.setProperty('--cml-shift-width', `${SIDEBAR_W}px`);
        document.body.classList.add('cml-page-shift');
      } else if (backdrop) {
        backdrop.style.display = 'block';
      }
      inputEl.focus();
    }
    function closeSidebar() {
      panel.classList.remove('cml-open');
      tab.classList.remove('cml-hidden');
      if (PANEL_MODE === 'push') {
        document.body.classList.remove('cml-page-shift');
      } else {
        if (backdrop) backdrop.style.display = 'none';
      }
    }

    // ── 드래그 리사이즈 ──
    const resizeHandle = panel.querySelector('#cml-resize-handle');
    let isResizing = false;
    let rsStartX = 0;
    let rsStartW = SIDEBAR_W;

    resizeHandle.addEventListener('mousedown', e => {
      isResizing = true;
      rsStartX = e.clientX;
      rsStartW = panel.offsetWidth;
      resizeHandle.classList.add('cml-dragging');
      document.body.classList.add('cml-resizing');
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!isResizing) return;
      const newW = Math.min(Math.max(rsStartW + (rsStartX - e.clientX), 320), window.innerWidth * 0.92);
      panel.style.width = `${newW}px`;
      if (PANEL_MODE === 'push' && window.innerWidth >= 768) {
        document.body.style.setProperty('--cml-shift-width', `${newW}px`);
      }
    });
    document.addEventListener('mouseup', () => {
      if (!isResizing) return;
      isResizing = false;
      resizeHandle.classList.remove('cml-dragging');
      document.body.classList.remove('cml-resizing');
    });

    tab.addEventListener('click', openSidebar);
    closeBtn.addEventListener('click', closeSidebar);
    refreshBtn.addEventListener('click', () => {
      clearSession();
      messageLog.splice(0);
      chatHistory.splice(0);
      lastProducts = [];
      messagesEl.innerHTML = '<div class="cml-chat-bubble assistant">안녕하세요! 원하시는 스타일이나 상황을 말씀해주시면 딱 맞는 아이템 찾아드릴게요 :)</div>';
      panel.querySelector('#cml-chat-starters').style.display = '';
      const _shelf = panel.querySelector('#cml-product-shelf');
      const _shelfList = panel.querySelector('#cml-product-shelf-list');
      _shelf.style.display = 'none';
      _shelfList.innerHTML = '';
    });

    function parseMd(text) {
      return text
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    }

    function addBubble(role, text) {
      const div = document.createElement('div');
      div.className = `cml-chat-bubble ${role}`;
      if (role === 'assistant') div.innerHTML = parseMd(text);
      else div.textContent = text;
      messagesEl.appendChild(div);
      messagesEl.scrollTop = messagesEl.scrollHeight;
      if (role === 'user' || role === 'assistant') {
        messageLog.push({ role, text });
        saveSession(lastProducts);
      }
      return div;
    }

    function addProductCards(products) {
      lastProducts = products || [];
      const shelf     = panel.querySelector('#cml-product-shelf');
      const shelfList = panel.querySelector('#cml-product-shelf-list');
      if (!products?.length) {
        shelf.style.display = 'none';
        shelfList.innerHTML = '';
        saveSession([]);
        return;
      }
      const pdpBase = '/product/detail.html?product_no=';
      shelfList.innerHTML = products.map((p, idx) => {
        const pdpUrl = `${pdpBase}${p.id}`;
        const imgInner = p.image_url
          ? `<img class="cml-shelf-card-img" src="${p.image_url}" alt="${p.name}" loading="lazy">`
          : `<div class="cml-shelf-card-img-placeholder">No img</div>`;
        const priceHtml = p.price
          ? `<div class="cml-shelf-card-price">₩${Number(p.price).toLocaleString()}</div>` : '';
        const reasonHtml = p.reason
          ? `<div class="cml-shelf-card-reason">${p.reason}</div>` : '';
        return `
          <div class="cml-shelf-card" data-product-id="${p.id}">
            <div class="cml-shelf-card-img-wrap">
              ${imgInner}
              <div class="cml-shelf-card-num">${idx + 1}</div>
            </div>
            <div class="cml-shelf-card-info">
              <div class="cml-shelf-card-name">${p.name}</div>
              ${priceHtml}
              ${reasonHtml}
              <div class="cml-shelf-card-btns">
                <a class="cml-shelf-card-btn primary" href="${pdpUrl}">자세히 보기</a>
                <button class="cml-shelf-card-btn secondary cml-add-cart-btn">장바구니 담기</button>
              </div>
              <div class="cml-option-panel" style="display:none"></div>
            </div>
          </div>`;
      }).join('');
      shelf.style.display = 'block';
      saveSession(lastProducts);
    }

    // ── 토스트 ──
    let toastEl = null;
    let toastTimer = null;
    function showToast(msg) {
      if (!toastEl) {
        toastEl = document.createElement('div');
        toastEl.className = 'cml-toast';
        shadow.appendChild(toastEl);
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
      } catch { return { options: [], variants: [] }; }
    }

    // ── 장바구니 담기 ──
    async function submitCart(productId, variantCode) {
      try {
        const body = new URLSearchParams();
        body.append(CART_FIELDS.product_no, String(productId));
        body.append(CART_FIELDS.quantity, '1');
        if (variantCode) body.append(CART_FIELDS.option_code, variantCode);
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
        if (res.ok || res.type === 'opaqueredirect' || res.status === 0 || res.status === 302) {
          showToast('장바구니에 담겼어요');
        } else {
          showToast('담기에 실패했어요. 상품 페이지에서 시도해주세요.');
        }
      } catch { showToast('담기에 실패했어요. 상품 페이지에서 시도해주세요.'); }
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
      `).join('') + `<button class="cml-cart-confirm-btn">담기 확인</button>`;
      optPanel.style.display = 'flex';
    }

    // ── 장바구니 버튼 이벤트 위임 ──
    const shelfList = panel.querySelector('#cml-product-shelf-list');
    shelfList.addEventListener('click', async (e) => {
      const cartBtn = e.target.closest('.cml-add-cart-btn');
      if (cartBtn) {
        const card = cartBtn.closest('.cml-shelf-card');
        const productId = card.dataset.productId;
        const optPanel = card.querySelector('.cml-option-panel');
        if (optPanel.style.display !== 'none') { optPanel.style.display = 'none'; return; }
        cartBtn.textContent = '불러오는 중...';
        cartBtn.disabled = true;
        const result = await fetchProductOptions(productId);
        const { options, variants } = result;
        cartBtn.textContent = '장바구니 담기';
        cartBtn.disabled = false;
        if (result.error === 'no_token') {
          showToast('상품 페이지에서 옵션을 선택해주세요.');
          window.location.href = `/product/detail.html?product_no=${productId}`;
          return;
        }
        if (!options.length) { await submitCart(productId, null); }
        else { showOptionPanel(card, options, variants); }
        return;
      }
      const confirmBtn = e.target.closest('.cml-cart-confirm-btn');
      if (confirmBtn) {
        const card = confirmBtn.closest('.cml-shelf-card');
        const productId = card.dataset.productId;
        const selects = card.querySelectorAll('.cml-option-select');
        let allSelected = true;
        selects.forEach(sel => {
          sel.classList.remove('cml-error');
          if (!sel.value) { allSelected = false; sel.classList.add('cml-error'); }
        });
        if (!allSelected) return;
        const selected = {};
        selects.forEach(sel => { selected[Number(sel.dataset.optionNo)] = Number(sel.value); });
        const variants = JSON.parse(card.dataset.variants || '[]');
        const variant = variants.find(v =>
          (v.options || []).length === Object.keys(selected).length &&
          (v.options || []).every(o => selected[o.option_no] === o.option_value_no)
        );
        if (!variant) { showToast('해당 옵션 조합을 찾을 수 없어요.'); return; }
        confirmBtn.textContent = '담는 중...';
        confirmBtn.disabled = true;
        await submitCart(productId, variant.variant_code);
        confirmBtn.textContent = '담기 확인';
        confirmBtn.disabled = false;
        card.querySelector('.cml-option-panel').style.display = 'none';
      }
    });

    // ── 채팅 전송 ──
    async function sendChat(query) {
      if (!query.trim()) return;
      panel.querySelector('#cml-chat-starters').style.display = 'none';
      addBubble('user', query);
      const loadingBubble = addBubble('assistant loading', '추천을 찾고 있어요...');
      sendBtn.disabled = true;
      try {
        const res = await fetch(`${CHAMELEON_SERVER}/api/recommend`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
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

    sendBtn.addEventListener('click', () => { const q = inputEl.value; inputEl.value = ''; sendChat(q); });
    inputEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.isComposing) { const q = inputEl.value; inputEl.value = ''; sendChat(q); }
    });
    startChips.forEach(chip => { chip.addEventListener('click', () => sendChat(chip.dataset.q)); });

    // ── 상품 특정 Q&A (PDP 칩 클릭 전용) ──
    async function sendProductQA(query, productNo, productName) {
      if (!query.trim()) return;
      panel.querySelector('#cml-chat-starters').style.display = 'none';
      addBubble('user', query);
      const loadingBubble = addBubble('assistant loading', '이 상품에 대해 알아보는 중...');
      sendBtn.disabled = true;
      try {
        const res = await fetch(`${CHAMELEON_SERVER}/api/ask`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mallId: MALL_ID, productNo, productName, question: query }),
        });
        const data = await res.json();
        loadingBubble.remove();
        addBubble('assistant', data.answer || '죄송해요, 다시 시도해주세요.');
        chatHistory.push({ role: 'user', content: query });
        chatHistory.push({ role: 'assistant', content: data.answer || '' });
        if (chatHistory.length > 20) chatHistory.splice(0, 2);
      } catch {
        loadingBubble.remove();
        addBubble('assistant', '네트워크 오류가 발생했어요. 잠시 후 다시 시도해주세요.');
      } finally {
        sendBtn.disabled = false;
        inputEl.focus();
      }
    }

    // PDP 인라인 패널의 질문 칩 클릭 이벤트 수신
    document.addEventListener('chameleon:ask', e => {
      openSidebar();
      const { query, mode, productNo, productName } = e.detail;
      if (mode === 'product_qa') {
        // 이 상품에 특정된 Q&A → /api/ask
        setTimeout(() => sendProductQA(query, productNo, productName), 160);
      } else {
        // 일반 추천 플로우 → /api/recommend
        setTimeout(() => sendChat(query), 160);
      }
    });

    // 패널 생성 후 세션 복원
    restoreSession();

    // ── SneakPeek: 이전 세션 없을 때만 4초 후 말풍선 표시 ──
    if (!sessionStorage.getItem(SESSION_KEY)) {
      const sneakText = branding.sneakPeekText || '소개팅, 출장, 선물...\n어떤 스타일 찾으세요?';
      const sneakEl = document.createElement('div');
      sneakEl.className = 'cml-sneak-peek';
      sneakEl.textContent = sneakText;
      shadow.appendChild(sneakEl);

      let sneakShowTimer, sneakHideTimer;
      sneakShowTimer = setTimeout(() => {
        sneakEl.classList.add('cml-sneak-show');
        sneakHideTimer = setTimeout(() => sneakEl.classList.remove('cml-sneak-show'), 5000);
      }, 4000);

      const dismissSneak = () => {
        clearTimeout(sneakShowTimer);
        clearTimeout(sneakHideTimer);
        sneakEl.remove();
      };
      tab.addEventListener('click', dismissSneak, { once: true });
    }
  }

  // ── 11. 실행 ────────────────────────────────────
  async function init() {
    injectStyles();

    const config = await fetch(`${CHAMELEON_SERVER}/api/config/${MALL_ID}`)
      .then(r => r.json()).catch(() => null);

    renderFab(config);

    if (isPDP) {
      const signals = collectSignals();
      const productInfo = getProductInfo();
      const pdpContent = await fetchPdpContent(signals.productNo, productInfo.name, productInfo.desc);
      console.log('[Chameleon] PDP content:', pdpContent);
      renderPanel(pdpContent, config, { productNo: signals.productNo, productName: productInfo.name });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
