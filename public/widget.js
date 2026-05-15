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

  // ── 0. 트래킹 헬퍼 (fire-and-forget) ──────────
  function track(eventType, extra) {
    const sid = sessionStorage.getItem('cml_sid') || (() => {
      const id = Math.random().toString(36).slice(2);
      sessionStorage.setItem('cml_sid', id);
      return id;
    })();
    fetch(`${CHAMELEON_SERVER}/api/track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mallId:    MALL_ID,
        eventType,
        productNo: extra?.productNo || null,
        chipLabel: extra?.chipLabel || null,
        sessionId: sid,
      }),
    }).catch(() => {}); // 추적 실패가 위젯 동작에 영향 없도록 silent
  }

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
    const accentColor = content?.accentColor || t.accentColor || '#5E4637';
    const chipSpeed    = config?.chipScrollSpeed || 5;
    const chipDuration = `${(11 - chipSpeed) * 3}s`;
    const cssVars = `
      --cml-accent: ${accentColor};
      --cml-bg: ${t.backgroundColor || `color-mix(in srgb, ${accentColor} 5%, white)`};
      --cml-border: color-mix(in srgb, ${accentColor} 18%, white);
      --cml-radius: ${t.borderRadius || '10px'};
      --cml-font: ${t.fontFamily || "'Noto Sans KR', sans-serif"};
      --cml-chips-duration: ${chipDuration};
      ${t.chipBgColor     ? `--cml-chip-bg:     ${t.chipBgColor};`     : ''}
      ${t.chipTextColor   ? `--cml-chip-text:   ${t.chipTextColor};`   : ''}
      ${t.chipBorderColor ? `--cml-chip-border: ${t.chipBorderColor};` : ''}
      ${t.userBubbleBg    ? `--cml-user-bg:     ${t.userBubbleBg};`    : ''}
      ${t.userBubbleText  ? `--cml-user-text:   ${t.userBubbleText};`  : ''}
      ${t.aiBubbleBg      ? `--cml-ai-bg:       ${t.aiBubbleBg};`      : ''}
      ${t.aiBubbleText    ? `--cml-ai-text:     ${t.aiBubbleText};`    : ''}
    `;
    const badge = content?.badge || 'AI 쇼핑 도우미';
    const title = content?.title || '';
    const body  = content?.body  || '';
    // 칩 개수 config 기반 제한
    const chipLimit = config?.adaptivePdp?.chipCount || 4;
    const rawChips = content?.chips?.length
      ? content.chips
      : ['소재가 어떻게 되나요?', '사이즈 선택 어떻게 하나요?', '어떤 상황에 어울려요?'];
    const allChips = rawChips.slice(0, chipLimit);
    const chipsHTML = allChips.map(c => `<button class="cml-chip" data-q="${c}">${c}</button>`).join('');
    return `
      <div class="cml-panel" id="cml-panel" style="${cssVars}">
        <div class="cml-badge"><span class="cml-dot"></span>${badge}</div>
        ${title || body ? `
        <div class="cml-card">
          ${title ? `<div class="cml-card-header"><span class="cml-card-icon"></span><span class="cml-card-title">${title}</span></div>` : ''}
          ${body  ? `<div class="cml-card-body">${body.replace(/\n/g, '<br>')}</div>` : ''}
        </div>` : ''}
        <div class="cml-chips-label">원하는 질문을 클릭하세요 →</div>
        <div class="cml-chips-wrap">
          <div class="cml-chips-track">
            <div class="cml-chips-set">${chipsHTML}</div>
            <div class="cml-chips-set" aria-hidden="true">${allChips.map(c => `<button class="cml-chip" data-q="${c}" tabindex="-1">${c}</button>`).join('')}</div>
          </div>
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
      /* ── push: body padding-right로 오른쪽만 줄임 — 왼쪽 기준점 유지 ── */
      body {
        transition: padding-right 0.32s cubic-bezier(0.4,0,0.2,1) !important;
      }
      html.cml-push {
        overflow-x: hidden !important;
      }
      /* padding-right + border-box: 왼쪽 좌표 전혀 안 변하고 오른쪽만 좁혀짐 */
      html.cml-push body {
        padding-right: var(--cml-shift-width, 380px) !important;
        box-sizing: border-box !important;
        min-width: 0 !important;
      }
      html.cml-push #wrap,
      html.cml-push #container,
      html.cml-push #contents,
      html.cml-push .inner,
      html.cml-push [class*="layout-"] {
        min-width: 0 !important;
      }
      body.cml-resizing, body.cml-resizing * { transition: none !important; }

      @media (max-width: 767px) {
        html.cml-push body {
          padding-right: 0 !important;
        }
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
      .cml-chips-wrap {
        overflow: hidden; margin-bottom: 4px;
        -webkit-mask-image: linear-gradient(to right, transparent, #000 18px, #000 calc(100% - 18px), transparent);
        mask-image: linear-gradient(to right, transparent, #000 18px, #000 calc(100% - 18px), transparent);
      }
      .cml-chips-track {
        display: flex; width: max-content;
        animation: cml-chips-scroll var(--cml-chips-duration, 18s) linear infinite;
      }
      .cml-chips-wrap:hover .cml-chips-track { animation-play-state: paused; }
      .cml-chips-set { display: flex; gap: 7px; padding-right: 7px; }
      @keyframes cml-chips-scroll {
        from { transform: translateX(0); }
        to   { transform: translateX(-50%); }
      }
      .cml-chip {
        border: 1px solid var(--cml-chip-border, #D0D0CC); border-radius: 999px; padding: 7px 14px;
        font-size: 12px; letter-spacing: 0.02em;
        color: var(--cml-chip-text, #444); background: var(--cml-chip-bg, #fff);
        cursor: pointer; transition: all 0.15s; font-family: inherit;
        white-space: nowrap; flex-shrink: 0;
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
    @import url('https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@1,600&display=swap');
    :host { all: initial; }

    /* ── 사이드바 탭 (닫혔을 때 트리거) ── */
    .cml-sidebar-tab {
      position: fixed;
      top: 50%;
      right: 0;
      transform: translateY(-50%);
      z-index: 99999;
      display: flex;
      flex-direction: row;
      align-items: center;
      background: #fff;
      border: 1px solid rgba(94,70,55,0.15);
      border-right: none;
      border-radius: 24px 0 0 24px;
      padding: 12px;
      cursor: pointer;
      box-shadow: -4px 0 16px rgba(94,70,55,0.08);
      transition: max-width 0.28s cubic-bezier(0.4,0,0.2,1), padding 0.28s cubic-bezier(0.4,0,0.2,1), box-shadow 0.2s;
      user-select: none;
      font-family: 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif;
      overflow: hidden;
      white-space: nowrap;
      max-width: 48px;
    }
    .cml-sidebar-tab:hover {
      max-width: 240px;
      padding: 12px 18px 12px 12px;
      box-shadow: -6px 0 22px rgba(94,70,55,0.14);
    }
    .cml-sidebar-tab.cml-hidden { opacity: 0; pointer-events: none; }
    .cml-sidebar-tab-icon { width: 22px; height: 22px; color: #5E4637; flex-shrink: 0; }
    .cml-sidebar-tab-label {
      font-size: 13px;
      font-weight: 500;
      color: #5E4637;
      letter-spacing: 0.02em;
      margin-left: 10px;
      opacity: 0;
      transition: opacity 0.15s 0.1s;
    }
    .cml-sidebar-tab:hover .cml-sidebar-tab-label { opacity: 1; }

    /* ── 사이드바 패널 ── */
    .cml-chat-panel {
      position: fixed;
      top: 0; right: 0;
      width: 380px;
      max-width: 100vw;
      height: 100dvh;
      background: #fff;
      border-left: 1px solid rgba(94,70,55,0.10);
      display: flex;
      flex-direction: column;
      z-index: 999999;
      font-family: 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif;
      font-size: 13px;
      transform: translateX(100%);
      transition: transform 0.32s cubic-bezier(0.4,0,0.2,1), width 0.32s cubic-bezier(0.4,0,0.2,1);
      box-shadow: -8px 0 40px rgba(94,70,55,0.10);
    }
    .cml-chat-panel.cml-open { transform: translateX(0); }

    .cml-chat-header {
      padding: 16px 20px;
      background: var(--cml-header-bg, #F0E4D3);
      border-bottom: 1px solid rgba(0,0,0,0.06);
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
    .cml-chat-header-title { font-size: 16px; font-weight: 700; color: var(--cml-header-text, #333); letter-spacing: 0.01em; }
    .cml-chat-header-actions { display: flex; align-items: center; gap: 2px; }
    .cml-chat-close,
    .cml-chat-refresh {
      background: none; border: none; color: var(--cml-header-icon, rgba(0,0,0,0.4)); cursor: pointer;
      line-height: 1; padding: 7px; border-radius: 7px;
      transition: color 0.15s, background 0.15s;
      display: flex; align-items: center; justify-content: center;
    }
    .cml-chat-close { font-size: 18px; }
    .cml-chat-refresh svg { width: 16px; height: 16px; }
    .cml-chat-close:hover,
    .cml-chat-refresh:hover { color: var(--cml-header-text, #111); background: rgba(0,0,0,0.06); }

    /* ── 히어로 영역 (이미지 배경 있을 때) ── */
    .cml-chat-hero { flex-shrink: 0; position: relative; overflow: hidden; }
    .cml-chat-hero-img { width: 100%; height: 180px; object-fit: cover; display: block; }
    .cml-chat-hero-overlay {
      position: absolute; inset: 0;
      background: linear-gradient(to bottom, rgba(0,0,0,0.08), rgba(0,0,0,0.52));
      display: flex; flex-direction: column; justify-content: flex-end; padding: 20px 24px;
    }
    .cml-chat-hero-title { font-size: 22px; font-weight: 700; color: #fff; line-height: 1.3; letter-spacing: -0.01em; margin-bottom: 4px; }
    .cml-chat-hero-body  { font-size: 13px; color: rgba(255,255,255,0.85); line-height: 1.5; }

    /* ── 통합 스크롤 영역 (웰컴 + 메시지 함께) ── */
    .cml-chat-scroll-area {
      flex: 1; overflow-y: auto;
      display: flex; flex-direction: column;
      background: var(--cml-bg, #fff);
    }
    .cml-chat-scroll-area::-webkit-scrollbar { width: 4px; }
    .cml-chat-scroll-area::-webkit-scrollbar-thumb { background: #DDD; border-radius: 4px; }

    /* ── 웰컴 화면 (스크롤 영역 상단에 항상 존재) ── */
    .cml-chat-welcome {
      flex-shrink: 0;
      display: flex; flex-direction: column;
      align-items: center; justify-content: center;
      min-height: 100%;
      padding: 40px 28px 36px;
      text-align: center;
      box-sizing: border-box;
    }
    .cml-chat-welcome-spark {
      font-size: 30px; line-height: 1; margin-bottom: 20px;
      color: var(--cml-accent, #5E4637); opacity: 0.35;
    }
    .cml-chat-welcome-title {
      font-size: 21px; font-weight: 700; color: #111;
      line-height: 1.35; letter-spacing: -0.02em; margin-bottom: 10px;
    }
    .cml-chat-welcome-body {
      font-size: 14px; color: #999; line-height: 1.65; margin-bottom: 32px;
    }
    .cml-welcome-chips {
      display: flex; flex-wrap: wrap; gap: 9px; justify-content: center;
    }
    .cml-welcome-chip {
      border: 1.5px solid rgba(0,0,0,0.13); border-radius: 999px;
      padding: 10px 18px; font-size: 13px; font-weight: 500; color: #333;
      background: #fff; cursor: pointer; font-family: inherit;
      transition: border-color 0.15s, color 0.15s, background 0.15s;
      white-space: nowrap;
    }
    .cml-welcome-chip:hover {
      border-color: var(--cml-accent, #5E4637);
      color: var(--cml-accent, #5E4637);
      background: color-mix(in srgb, var(--cml-accent, #5E4637) 5%, white);
    }

    /* ── 메시지 영역 (스크롤 영역 하단) ── */
    .cml-chat-messages {
      flex-shrink: 0;
      padding: 4px 20px 16px;
      display: flex; flex-direction: column; gap: 10px;
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
    .cml-chat-bubble strong { font-weight: 700; font-size: 15px; }
    .cml-chat-bubble.user {
      align-self: flex-end;
      background: var(--cml-user-bg, #5E4637); color: var(--cml-user-text, #fff);
      border-bottom-right-radius: 4px;
    }
    .cml-chat-bubble.assistant {
      align-self: flex-start;
      background: var(--cml-ai-bg, #F7F5F3); color: var(--cml-ai-text, #222);
      border-bottom-left-radius: 4px;
      border: 1px solid rgba(94,70,55,0.08);
    }
    .cml-chat-bubble.loading { color: #A08070; font-style: italic; }

    /* ── 스켈레톤 로딩 카드 ── */
    .cml-skeleton {
      align-self: flex-start; max-width: 88%;
      background: var(--cml-ai-bg, #F7F5F3);
      border: 1px solid rgba(94,70,55,0.08);
      border-radius: 14px; border-bottom-left-radius: 4px;
      padding: 14px 18px;
    }
    .cml-skeleton-top {
      display: flex; align-items: center; gap: 9px; margin-bottom: 14px;
    }
    .cml-skeleton-spinner {
      width: 15px; height: 15px; flex-shrink: 0;
      border: 2.5px solid rgba(0,0,0,0.08);
      border-top-color: var(--cml-accent, #5E4637);
      border-radius: 50%;
      animation: cml-spin 0.75s linear infinite;
    }
    @keyframes cml-spin { to { transform: rotate(360deg); } }
    .cml-skeleton-label { font-size: 12px; color: #999; letter-spacing: 0.01em; }
    .cml-skeleton-bar {
      height: 10px; border-radius: 6px;
      background: rgba(0,0,0,0.07);
      margin-bottom: 7px;
      animation: cml-shimmer 1.5s ease-in-out infinite;
    }
    .cml-skeleton-bar:last-child { margin-bottom: 0; }
    @keyframes cml-shimmer {
      0%, 100% { opacity: 0.4; }
      50%       { opacity: 0.85; }
    }


    /* ── 인라인 추천 상품 카드 ── */
    .cml-inline-card {
      border: 1px solid rgba(94,70,55,0.14); border-radius: 10px;
      overflow: hidden; margin: 6px 0 10px;
      background: #fff; font-family: 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif;
    }
    .cml-inline-card-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 12px 14px; cursor: pointer; user-select: none;
      transition: background 0.12s;
    }
    .cml-inline-card-header:hover { background: #FAFAF9; }
    .cml-inline-card-header-left { flex: 1; min-width: 0; }
    .cml-inline-card-name {
      font-size: 14px; font-weight: 700; color: #111;
      white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
      margin-bottom: 2px;
    }
    .cml-inline-card-price { font-size: 14px; color: #333; font-weight: 600; }
    .cml-inline-card-toggle {
      width: 28px; height: 28px; border-radius: 50%;
      border: 1px solid #E4E4E0; background: #F5F5F3;
      display: flex; align-items: center; justify-content: center;
      flex-shrink: 0; margin-left: 10px;
    }
    .cml-inline-card-toggle svg { transition: transform 0.25s; }
    .cml-inline-card-toggle.open svg { transform: rotate(180deg); }
    .cml-inline-card-body {
      display: flex; overflow: hidden;
      max-height: 0; transition: max-height 0.3s ease;
      border-top: 0px solid #F0F0EE;
    }
    .cml-inline-card-body.open {
      max-height: 220px;
      border-top-width: 1px;
    }
    .cml-inline-card-img-wrap {
      width: 116px; flex-shrink: 0; background: #F0F0EE; align-self: stretch;
    }
    .cml-inline-card-img { width: 116px; height: 100%; object-fit: cover; display: block; }
    .cml-inline-card-img-placeholder {
      width: 100%; height: 100%; min-height: 160px;
      display: flex; align-items: center; justify-content: center;
      color: #CCC; font-size: 11px;
    }
    .cml-inline-card-info {
      flex: 1; padding: 11px 13px;
      display: flex; flex-direction: column; gap: 7px; min-width: 0;
    }
    .cml-inline-card-reason {
      font-size: 12px; color: #888; line-height: 1.5;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .cml-inline-card-chips { display: flex; flex-wrap: wrap; gap: 5px; }
    .cml-inline-card-chip {
      border: 1px solid #E0E0DC; border-radius: 999px;
      padding: 4px 10px; font-size: 11px; color: #555;
      background: #FAFAF9; cursor: pointer; font-family: inherit;
      white-space: nowrap; transition: border-color 0.12s, color 0.12s;
    }
    .cml-inline-card-chip:hover { border-color: #999; color: #111; }
    .cml-inline-card-btns { display: flex; gap: 6px; margin-top: auto; }
    .cml-inline-card-btn {
      flex: 1; padding: 9px 6px; border-radius: 8px;
      font-size: 13px; font-weight: 600; cursor: pointer;
      border: none; font-family: inherit; text-decoration: none;
      display: flex; align-items: center; justify-content: center;
      transition: opacity 0.15s; white-space: nowrap;
    }
    .cml-inline-card-btn:hover { opacity: 0.82; }
    .cml-inline-card-btn.primary { background: #111; color: #fff; }
    .cml-inline-card-btn.secondary { background: #EEEEEC; color: #333; }
    .cml-inline-option-panel {
      margin-top: 6px; display: none; flex-direction: column; gap: 5px;
    }
    .cml-inline-option-panel.open { display: flex; }

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
      padding: 14px 20px 10px; border-top: 1px solid #F0F0EE;
      background: #fff;
    }
    .cml-chat-input-wrap {
      position: relative; display: flex; align-items: center;
    }
    .cml-powered-by {
      text-align: center; padding: 10px 0 20px;
      font-size: 10px; color: #C8C8C4; letter-spacing: 0.05em;
      flex-shrink: 0; background: #fff;
    }
    .cml-powered-logo {
      font-family: 'Cormorant Garamond', 'Georgia', serif;
      font-style: italic; font-weight: 600;
      font-size: 13px; color: #AAAAA6; letter-spacing: 0.01em;
    }
    .cml-chat-input {
      width: 100%; border: 1.5px solid rgba(94,70,55,0.18); border-radius: 16px;
      padding: 13px 56px 13px 18px; font-size: 14px; outline: none; font-family: inherit;
      color: #333; background: #fff; transition: border-color 0.15s;
      box-sizing: border-box;
    }
    .cml-chat-input:focus { border-color: rgba(94,70,55,0.45); }
    .cml-chat-input::placeholder { color: #C0A898; }
    .cml-chat-send {
      position: absolute; right: 6px;
      width: 36px; height: 36px; border-radius: 10px;
      background: #F0EBE5; color: #5E4637;
      border: none; cursor: pointer; display: flex; align-items: center;
      justify-content: center; flex-shrink: 0; transition: background 0.15s, opacity 0.15s;
    }
    .cml-chat-send:hover { background: #E8DDD4; }
    .cml-chat-send:disabled { opacity: 0.35; cursor: default; }


    /* ── PDP 웰컴 칩 트레이 (상품 상세 진입 시 자동 표시) ── */
    .cml-pdp-welcome-tray {
      flex-shrink: 0;
      overflow: hidden;
      padding: 6px 0 10px;
      border-bottom: 1px solid #F0F0EE;
    }
    .cml-pdp-welcome-scroll {
      display: flex;
      gap: 8px;
      padding: 4px 16px 2px;
      overflow-x: auto;
      scrollbar-width: none;
      white-space: nowrap;
    }
    .cml-pdp-welcome-scroll::-webkit-scrollbar { display: none; }
    .cml-pdp-welcome-chip {
      flex: 0 0 auto;
      border: 1px solid rgba(94,70,55,0.20);
      border-radius: 999px;
      padding: 8px 16px;
      font-size: 13px;
      color: #5E4637;
      white-space: nowrap;
      cursor: pointer;
      background: #fff;
      font-family: inherit;
      transition: border-color 0.15s, background 0.15s;
    }
    .cml-pdp-welcome-chip:hover { border-color: #5E4637; background: rgba(94,70,55,0.05); }

    /* ── 팔로업 질문 트레이 ── */
    .cml-follow-chips-tray {
      flex-shrink: 0;
      padding: 10px 0 6px;
      border-top: 1px solid #F0F0EE;
    }
    .cml-follow-chips-scroll {
      display: flex;
      overflow-x: auto;
      scroll-snap-type: x mandatory;
      -webkit-overflow-scrolling: touch;
      gap: 8px;
      padding: 2px 16px 4px;
      scrollbar-width: none;
    }
    .cml-follow-chips-scroll::-webkit-scrollbar { display: none; }
    .cml-follow-chip {
      flex: 0 0 auto;
      scroll-snap-align: start;
      border: 1px solid rgba(94,70,55,0.20);
      border-radius: 999px;
      padding: 8px 16px;
      font-size: 13px;
      color: #5E4637;
      white-space: nowrap;
      cursor: pointer;
      background: #fff;
      font-family: inherit;
      transition: border-color 0.15s, background 0.15s;
    }
    .cml-follow-chip:hover { border-color: #5E4637; background: rgba(94,70,55,0.05); }

    /* ── backdrop (overlay 모드) ── */
    #cml-backdrop {
      display: none; position: fixed; inset: 0;
      background: rgba(0,0,0,0.3); z-index: 9998; transition: opacity 0.28s;
    }

    /* ── SneakPeek 말풍선 ── */
    .cml-sneak-peek {
      position: fixed; right: 62px; top: 50%; transform: translateY(-50%);
      background: #fff; border: 1px solid rgba(94,70,55,0.15); border-radius: 12px;
      padding: 10px 14px; font-size: 13px; color: #5E4637;
      font-family: 'Apple SD Gothic Neo', 'Noto Sans KR', sans-serif;
      line-height: 1.55; z-index: 99998;
      box-shadow: -2px 4px 16px rgba(94,70,55,0.10); max-width: 180px;
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
        border-radius: 999px; padding: 12px 18px;
        border-right: 1px solid rgba(94,70,55,0.15);
        max-width: 220px; overflow: visible;
      }
      .cml-sidebar-tab-label {
        opacity: 1; margin-left: 8px;
        font-size: 13px; letter-spacing: 0.04em;
      }
      .cml-sneak-peek {
        top: auto; bottom: 76px; right: 16px; transform: none; max-width: 220px;
      }
      .cml-sneak-peek::after {
        top: auto; bottom: -6px; right: 24px; transform: rotate(135deg);
      }
    }

    /* ── 메시지 내 인라인 상품 카드 (가로 나열) ── */
    .cml-msg-products {
      display: flex; flex-direction: row; gap: 8px;
      margin: 6px 0 10px; width: 100%;
      align-items: stretch;
    }
    .cml-msg-product-card {
      flex: 1; min-width: 0;
      display: flex; flex-direction: column;
      background: #fff; border: 1px solid rgba(94,70,55,0.12);
      border-radius: 10px; overflow: hidden;
      transition: box-shadow 0.15s, border-color 0.15s;
      text-decoration: none;
    }
    .cml-msg-product-card:hover {
      box-shadow: 0 2px 10px rgba(94,70,55,0.10);
      border-color: rgba(94,70,55,0.28);
    }
    .cml-msg-product-img-wrap {
      width: 100%; aspect-ratio: 1 / 1;
      overflow: hidden; background: #EEEEED; flex-shrink: 0;
    }
    .cml-msg-product-img {
      width: 100%; height: 100%; object-fit: cover; display: block;
    }
    .cml-msg-product-img-placeholder {
      width: 100%; height: 100%; min-height: 80px;
      display: flex; align-items: center; justify-content: center;
      color: #CCC; font-size: 10px;
    }
    .cml-msg-product-info {
      padding: 8px 8px 9px;
      display: flex; flex-direction: column; gap: 2px;
      flex: 1;
    }
    .cml-msg-product-name {
      font-size: 11px; font-weight: 600; color: #111;
      line-height: 1.35; letter-spacing: -0.01em;
      display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
      overflow: hidden;
    }
    .cml-msg-product-price {
      font-size: 11px; color: #5E4637; font-weight: 600;
    }
    .cml-msg-product-btn-wrap { margin-top: auto; padding-top: 6px; }
    .cml-msg-product-btn {
      display: block; width: 100%; padding: 7px 0; border-radius: 7px;
      font-size: 11px; font-weight: 600; text-align: center;
      cursor: pointer; border: none; font-family: inherit; text-decoration: none;
      background: #111; color: #fff; transition: opacity 0.15s;
      box-sizing: border-box;
    }
    .cml-msg-product-btn:hover { opacity: 0.82; }

    /* ── 추천 정제 칩 바 (결과 아래 리파인 옵션) ── */
    .cml-refine-bar {
      overflow: hidden;
      padding: 10px 0 4px;
      -webkit-mask-image: linear-gradient(to right, transparent, #000 16px, #000 calc(100% - 16px), transparent);
      mask-image: linear-gradient(to right, transparent, #000 16px, #000 calc(100% - 16px), transparent);
    }
    .cml-refine-track {
      display: flex; width: max-content; gap: 8px;
      animation: cml-chips-scroll 24s linear infinite;
    }
    .cml-refine-bar:hover .cml-refine-track,
    .cml-refine-bar.cml-paused .cml-refine-track { animation-play-state: paused; }
    .cml-refine-set { display: flex; gap: 8px; padding-right: 8px; }
    .cml-refine-chip {
      border: 1px solid rgba(94,70,55,0.22); border-radius: 999px;
      padding: 8px 16px; font-size: 13px; color: #5E4637;
      white-space: nowrap; cursor: pointer; flex-shrink: 0;
      background: #fff; font-family: inherit;
      transition: border-color 0.15s, background 0.15s, color 0.15s;
    }
    .cml-refine-chip:hover {
      border-color: var(--cml-accent, #5E4637);
      background: color-mix(in srgb, var(--cml-accent, #5E4637) 6%, white);
    }
    .cml-refine-chip.cml-active {
      border-color: var(--cml-accent, #5E4637);
      background: color-mix(in srgb, var(--cml-accent, #5E4637) 12%, white);
      font-weight: 600; color: var(--cml-accent, #5E4637);
    }
    @keyframes cml-chips-scroll {
      from { transform: translateX(0); }
      to   { transform: translateX(-50%); }
    }
  `;

  // ── 7. 패널 삽입 위치 찾기 (config 기반) ──────────────
  function findInsertTarget(config) {
    // DB에서 설정된 selector 우선 (콘솔에서 고객사가 지정)
    const dbSelector = config?.adaptivePdp?.selector;
    if (dbSelector) {
      const el = document.querySelector(dbSelector);
      if (el) { console.log(`[Chameleon] 삽입 위치 (DB): ${dbSelector}`); return el; }
    }
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

    const position = config?.adaptivePdp?.position || config?.insert?.position || 'afterend';
    target.insertAdjacentElement(position, panel);

    // PDP 칩 클릭 → pdp_chip_click 이벤트 + 사이드바 열기
    panel.querySelector('.cml-chips-wrap').addEventListener('click', e => {
      const chip = e.target.closest('.cml-chip');
      if (!chip) return;
      track('pdp_chip_click', { chipLabel: chip.dataset.q, productNo: productCtx?.productNo || null });
      document.dispatchEvent(new CustomEvent('chameleon:ask', {
        detail: {
          query: chip.dataset.q,
          mode: 'product_qa',
          productNo:   productCtx?.productNo   || '',
          productName: productCtx?.productName || '',
          fullChips:   content?.chips          || [],
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
    const logoMode     = branding.logoMode    || null;
    const fontFamily   = branding.fontFamily  || null;
    const fontWeight   = branding.fontWeight  || 700;
    const letterSpacing= branding.letterSpacing || '0';

    // ── Google Font 주입 (Shadow DOM 안에 @import) ──
    if (logoMode === 'text' && fontFamily) {
      const fontStyle = document.createElement('style');
      fontStyle.textContent = `@import url('https://fonts.googleapis.com/css2?family=${encodeURIComponent(fontFamily)}:wght@${fontWeight}&display=swap');
        .cml-chat-header-text-logo {
          font-family: '${fontFamily}', sans-serif;
          font-weight: ${fontWeight};
          letter-spacing: ${letterSpacing};
          font-size: 15px;
          color: var(--cml-header-text, #333);
          line-height: 1;
        }`;
      shadow.appendChild(fontStyle);
    }

    // ── 사이드바 탭 (트리거) ──
    const tab = document.createElement('div');
    tab.id = 'cml-sidebar-tab';
    tab.className = 'cml-sidebar-tab';
    tab.setAttribute('role', 'button');
    tab.setAttribute('aria-label', `${chatName} 열기`);
    tab.innerHTML = `
      <svg class="cml-sidebar-tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="11" cy="11" r="8"/>
        <line x1="21" y1="21" x2="16.65" y2="16.65"/>
      </svg>
      <span class="cml-sidebar-tab-label">무엇이든 물어보세요</span>
    `;
    shadow.appendChild(tab);

    // ── 히어로 HTML (이미지 배경 있을 때만) ──
    const heroHtml = heroImage ? `
      <div class="cml-chat-hero">
        <img class="cml-chat-hero-img" src="${heroImage}" alt="">
        ${(welcomeTitle || welcomeBody) ? `
          <div class="cml-chat-hero-overlay">
            ${welcomeTitle ? `<div class="cml-chat-hero-title">${welcomeTitle}</div>` : ''}
            ${welcomeBody  ? `<div class="cml-chat-hero-body">${welcomeBody}</div>`   : ''}
          </div>` : ''}
      </div>` : '';

    // ── 헤더 왼쪽 ──
    const headerLeftHtml = logoMode === 'text' && fontFamily
      ? `<span class="cml-chat-header-text-logo">${chatName}</span>`
      : logoUrl
        ? `<img class="cml-chat-header-logo" src="${logoUrl}" alt="${chatName}">`
        : `<span class="cml-chat-header-dot"></span><span class="cml-chat-header-title">${chatName}</span>`;

    // ── 사이드바 패널 ──
    const panel = document.createElement('div');
    panel.id = 'cml-chat-panel';
    panel.className = 'cml-chat-panel';

    // ── CSS 변수 주입 헬퍼 ──
    function mixHex(hex, alpha) {
      if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) return null;
      const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
      return `rgb(${Math.round(r*alpha+255*(1-alpha))},${Math.round(g*alpha+255*(1-alpha))},${Math.round(b*alpha+255*(1-alpha))})`;
    }
    function isDarkHex(hex) {
      if (!/^#[0-9A-Fa-f]{6}$/.test(hex)) return false;
      const r=parseInt(hex.slice(1,3),16),g=parseInt(hex.slice(3,5),16),b=parseInt(hex.slice(5,7),16);
      return (0.299*r+0.587*g+0.114*b)<128;
    }
    function applyCssVars(theme) {
      const t = theme || {};
      const accent = t.accentColor || '#5E4637';
      const hdrBg  = mixHex(accent, 0.18) || '#F0E4D3'; // 18% = same as admin preview
      const dark   = isDarkHex(accent);
      panel.style.setProperty('--cml-accent',      accent);
      panel.style.setProperty('--cml-header-bg',   hdrBg);
      panel.style.setProperty('--cml-header-text',  dark ? '#fff' : '#111');
      panel.style.setProperty('--cml-header-icon',  dark ? 'rgba(255,255,255,0.6)' : 'rgba(0,0,0,0.4)');
      panel.style.setProperty('--cml-bg',           t.backgroundColor || '#ffffff');
      if (t.chipBgColor)      panel.style.setProperty('--cml-chip-bg',     t.chipBgColor);
      if (t.chipTextColor)    panel.style.setProperty('--cml-chip-text',   t.chipTextColor);
      if (t.chipBorderColor)  panel.style.setProperty('--cml-chip-border', t.chipBorderColor);
      if (t.userBubbleBg)     panel.style.setProperty('--cml-user-bg',     t.userBubbleBg);
      if (t.userBubbleText)   panel.style.setProperty('--cml-user-text',   t.userBubbleText);
      if (t.aiBubbleBg)       panel.style.setProperty('--cml-ai-bg',       t.aiBubbleBg);
      if (t.aiBubbleText)     panel.style.setProperty('--cml-ai-text',     t.aiBubbleText);
    }
    applyCssVars(config?.theme);

    // ── 스타터 칩 (config 또는 기본값) ──
    const defaultChips = [
      { label: '여름에 시원하게 입기 좋은 아이템 추천해주세요', query: '여름에 시원하게 입기 좋은 아이템 추천해주세요' },
      { label: '데님 스커트랑 어울리는 상의 같이 골라줄 수 있어요?', query: '데님 스커트랑 어울리는 상의 같이 골라줄 수 있어요?' },
      { label: '매일 캐주얼하게 입기 좋은 기본템 뭐가 있어요?', query: '매일 캐주얼하게 입기 좋은 기본템 뭐가 있어요?' },
      { label: '소개팅에 입고 나가기 좋은 깔끔한 룩 추천해줘요', query: '소개팅에 입고 나가기 좋은 깔끔한 룩 추천해줘요' },
    ];
    const starterChips = branding.starterChips?.length ? branding.starterChips : defaultChips;

    // ── 웰컴 칩 HTML (flex-wrap, 스크롤 없음) ──
    const welcomeChipsHtml = starterChips
      .map(c => `<button class="cml-welcome-chip" data-q="${c.query || c.label}">${c.label}</button>`)
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
      <!-- 웰컴 + 메시지를 하나의 스크롤 영역에 통합 -->
      <div class="cml-chat-scroll-area" id="cml-chat-scroll-area">
        <div class="cml-chat-welcome" id="cml-chat-welcome">
          <div class="cml-chat-welcome-spark">✦</div>
          <div class="cml-chat-welcome-title">${welcomeTitle || '안녕하세요! 무엇을 찾고 있으신가요?'}</div>
          <div class="cml-chat-welcome-body">${welcomeBody || '상품 검색을 위해 질문하거나, 아래의 질문을 골라보세요'}</div>
          <div class="cml-welcome-chips" id="cml-welcome-chips">${welcomeChipsHtml}</div>
        </div>
        <div class="cml-chat-messages" id="cml-chat-messages"></div>
      </div>
      <div class="cml-pdp-welcome-tray" id="cml-pdp-welcome-tray" style="display:none">
        <div class="cml-pdp-welcome-scroll" id="cml-pdp-welcome-scroll"></div>
      </div>
      <div class="cml-follow-chips-tray" id="cml-follow-chips-tray" style="display:none">
        <div class="cml-follow-chips-scroll" id="cml-follow-chips-scroll"></div>
      </div>
      <div class="cml-chat-input-row">
        <div class="cml-chat-input-wrap">
          <input class="cml-chat-input" id="cml-chat-input" type="text" placeholder="무엇을 도와드릴까요?" autocomplete="off" />
          <button class="cml-chat-send" id="cml-chat-send" aria-label="전송">
            <svg width="16" height="16" viewBox="0 0 14 14" fill="none">
              <path d="M7 13V1M1 7l6-6 6 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
        </div>
      </div>
      <div class="cml-powered-by">Powered by <span class="cml-powered-logo">Chameleon</span></div>
    `;
    shadow.appendChild(panel);

    const closeBtn   = panel.querySelector('#cml-chat-close');
    const refreshBtn = panel.querySelector('#cml-chat-refresh');
    const welcomeEl  = panel.querySelector('#cml-chat-welcome');
    const messagesEl = panel.querySelector('#cml-chat-messages');
    const scrollArea = panel.querySelector('#cml-chat-scroll-area');
    const inputEl    = panel.querySelector('#cml-chat-input');
    const sendBtn    = panel.querySelector('#cml-chat-send');

    function scrollToBottom() { scrollArea.scrollTop = scrollArea.scrollHeight; }
    // 웰컴 화면은 항상 스크롤 영역 상단에 존재 — hide/show 대신 스크롤로 전환
    function showWelcome()  { messagesEl.innerHTML = ''; scrollArea.scrollTop = 0; }
    function hideWelcome()  { /* no-op: welcome stays visible at top */ }

    const chatHistory = [];
    let lastProducts  = [];
    let _refineBar    = null;
    let _lastChips    = [];   // 마지막 추천의 정제 칩 레이블 (세션 저장용)

    // PDP 칩 풀 + 컨텍스트 (product_qa 모드 전용)
    let _pdpChips      = [];
    let _pdpProductNo  = '';
    let _pdpProductName = '';
    let _stopAutoScroll = null;

    // ── 팔로업 칩 트레이 ──
    const followTray   = panel.querySelector('#cml-follow-chips-tray');
    const followScroll = panel.querySelector('#cml-follow-chips-scroll');

    function startChipAutoScroll(el) {
      let paused = false;
      const pause  = () => { paused = true; };
      const resume = () => { setTimeout(() => { paused = false; }, 1500); };
      el.addEventListener('touchstart', pause,  { passive: true });
      el.addEventListener('mousedown',  pause);
      el.addEventListener('touchend',  resume,  { passive: true });
      el.addEventListener('mouseup',   resume);
      let rafId;
      function tick() {
        if (!paused) {
          const max = el.scrollWidth - el.clientWidth;
          if (el.scrollLeft < max) el.scrollLeft += 0.45;
        }
        rafId = requestAnimationFrame(tick);
      }
      rafId = requestAnimationFrame(tick);
      return () => cancelAnimationFrame(rafId);
    }

    function showFollowUpChips(askedQuery) {
      const remaining = _pdpChips.filter(c => c !== askedQuery);
      if (!remaining.length) { followTray.style.display = 'none'; return; }
      followScroll.innerHTML = remaining.map(c =>
        `<button class="cml-follow-chip" data-q="${c}">${c}</button>`
      ).join('');
      followTray.style.display = 'block';
      followScroll.scrollLeft = 0;
      if (_stopAutoScroll) { _stopAutoScroll(); _stopAutoScroll = null; }
      _stopAutoScroll = startChipAutoScroll(followScroll);
    }

    followScroll.addEventListener('click', e => {
      const chip = e.target.closest('.cml-follow-chip');
      if (!chip) return;
      const q = chip.dataset.q;
      showFollowUpChips(q);
      sendProductQA(q, _pdpProductNo, _pdpProductName);
    });

    // ── 세션 유지 ──
    const SESSION_KEY = `cml_session_${MALL_ID}`;
    const messageLog  = [];

    function saveSession(products) {
      try {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify({
          messages: messageLog, history: chatHistory,
          products: products || [], chips: _lastChips || [],
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
        const { messages, history, chips, products } = JSON.parse(raw);
        if (!(messages?.length)) return;
        messagesEl.innerHTML = '';
        hideWelcome();
        (messages || []).forEach(m => {
          const div = document.createElement('div');
          div.className = `cml-chat-bubble ${m.role}`;
          if (m.role === 'assistant') div.innerHTML = parseMd(m.text);
          else div.textContent = m.text;
          messagesEl.appendChild(div);
        });
        // 마지막 추천 상품 카드 복원
        if (products?.length) {
          lastProducts = products;
          const container = document.createElement('div');
          container.className = 'cml-msg-products';
          products.forEach((p, i) => container.appendChild(createMsgProductCard(p, i + 1)));
          messagesEl.appendChild(container);
        }
        // 마지막 정제 칩 복원
        if (chips?.length) {
          _lastChips = chips;
          _refineBar = renderRefinementChips(chips);
          if (_refineBar) messagesEl.appendChild(_refineBar);
        }
        scrollArea.scrollTop = scrollArea.scrollHeight;
        (history || []).forEach(h => chatHistory.push(h));
        messageLog.push(...(messages || []));
      } catch (e) {}
    }

    // ── mall별 장바구니 설정 ──
    const cartConfig    = config?.cart || {};
    const CART_ENDPOINT = cartConfig.endpoint || '/exec/front/Order/Cart';
    const CART_FIELDS   = cartConfig.fields   || { product_no: 'product_no', option_code: 'option_code', quantity: 'quantity' };
    // 항상 push 모드 — 사이트를 좁히면서 옆에 붙는 방식
    const PANEL_MODE = 'push';
    const SIDEBAR_W  = config?.panel?.width || 380;
    const backdrop   = null; // overlay 모드 사용 안 함

    // position:fixed 헤더 선택자 (Cafe24 + 일반)
    const FIXED_HDR_SEL = [
      'header', '#header', '.header',
      '.xans-layout-header', '.fixed_header',
      '[class*="gnb"]', '[class*="GNB"]',
      '.sticky-header', '.fixed-header',
    ].join(',');

    function applyFixedHeaderWidth(_px) {
      // 헤더 레이아웃은 건드리지 않음 — 패널이 z-index로 위를 덮음
      // (width/right 조정 시 내부 요소가 세로 배치되는 부작용 발생)
    }

    function openSidebar() {
      panel.classList.add('cml-open');
      tab.classList.add('cml-hidden');
      const isMobile = window.innerWidth < 768;
      if (!isMobile) {
        document.documentElement.style.setProperty('--cml-shift-width', `${SIDEBAR_W}px`);
        document.documentElement.classList.add('cml-push');
        applyFixedHeaderWidth(SIDEBAR_W);
      }
      inputEl.focus();
      // 세션당 1회만 chat_start 기록
      if (!sessionStorage.getItem('cml_chat_started')) {
        sessionStorage.setItem('cml_chat_started', '1');
        track('chat_start');
      }
    }
    function closeSidebar() {
      panel.classList.remove('cml-open');
      tab.classList.remove('cml-hidden');
      document.documentElement.classList.remove('cml-push');
      applyFixedHeaderWidth(null);
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
      if (window.innerWidth >= 768) {
        document.documentElement.style.setProperty('--cml-shift-width', `${newW}px`);
        applyFixedHeaderWidth(newW);
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
      messagesEl.innerHTML = '';
      followTray.style.display = 'none';
      followScroll.innerHTML = '';
      if (_stopAutoScroll) { _stopAutoScroll(); _stopAutoScroll = null; }
      _refineBar = null; _lastChips = []; // already removed by innerHTML = ''
      showWelcome();
    });

    function parseMd(text) {
      return text
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    }

    // ── 쿼리 내용에 따른 로딩 텍스트 ──
    function getLoadingText(query) {
      const q = (query || '').toLowerCase();
      if (/선물|gift/.test(q))                      return '선물에 딱 맞는 상품을 찾고 있어요...';
      if (/사이즈|핏|크게|작게|키|몸무게/.test(q))      return '사이즈 정보를 분석하고 있어요...';
      if (/코디|어울|매치|세트|함께|같이/.test(q))      return '어울리는 코디를 찾고 있어요...';
      if (/배송|교환|반품|환불|정책/.test(q))           return '답변을 준비하고 있어요...';
      if (/여름|봄|가을|겨울|시즌|계절/.test(q))        return '시즌 아이템을 찾고 있어요...';
      if (/트렌드|인기|베스트|핫|요즘/.test(q))         return '트렌드 상품을 분석하고 있어요...';
      if (/소개팅|데이트|파티|결혼식|하객/.test(q))      return '룩을 구성하고 있어요...';
      return '상품을 찾고 있어요...';
    }

    function addSkeletonLoader(query) {
      const el = document.createElement('div');
      el.className = 'cml-skeleton';
      el.innerHTML = `
        <div class="cml-skeleton-top">
          <div class="cml-skeleton-spinner"></div>
          <span class="cml-skeleton-label">${getLoadingText(query)}</span>
        </div>
        <div class="cml-skeleton-bar" style="width:83%"></div>
        <div class="cml-skeleton-bar" style="width:64%"></div>
        <div class="cml-skeleton-bar" style="width:48%"></div>
      `;
      messagesEl.appendChild(el);
      scrollToBottom();
      return el;
    }

    function addBubble(role, text) {
      const div = document.createElement('div');
      div.className = `cml-chat-bubble ${role}`;
      if (role === 'assistant') div.innerHTML = parseMd(text);
      else div.textContent = text;
      messagesEl.appendChild(div);
      scrollToBottom();
      if (role === 'user' || role === 'assistant') {
        messageLog.push({ role, text });
        saveSession(lastProducts);
      }
      return div;
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
          track('cart_add', { productNo: String(productId) });
        } else {
          showToast('담기에 실패했어요. 상품 페이지에서 시도해주세요.');
        }
      } catch { showToast('담기에 실패했어요. 상품 페이지에서 시도해주세요.'); }
    }

    // ── 추천 메시지 → 텍스트+카드 인라인 렌더링 ──
    function parseRecommendationSegments(message) {
      const segments = [];
      // ① 줄바꿈 + 번호 패턴으로 분할 (기존) + 메시지 첫 줄이 번호인 경우도 포함
      const parts = message.split(/(?=(?:^|\n)\d+[.)]\s)/);
      parts.forEach(part => {
        const trimmed = part.replace(/^\n/, '').trim();
        if (!trimmed) return;
        const match = trimmed.match(/^(\d+)[.)]\s/);
        if (match) {
          segments.push({ type: 'product', idx: parseInt(match[1]) - 1, content: trimmed });
        } else {
          segments.push({ type: 'text', content: trimmed });
        }
      });

      console.log('[Chameleon] Parsed segments:', segments.map(s =>
        ({ type: s.type, idx: s.idx, snippet: s.content?.slice(0, 60) })));

      return segments;
    }

    // 각 product 세그먼트에 어떤 상품이 속하는지 결정
    // 전략: ① 세그먼트 번호(1., 2., 3.) → products 배열 순서 매핑
    //       ② 이름 기반 매칭 보조
    //       ③ 남은 상품은 빈 product 세그먼트에 순서대로 배분
    function matchProductsToSegments(segments, products) {
      const productSegments = segments.map(() => []);
      const usedProductIndices = new Set();
      const assignedSegIndices = new Set();

      // ① 세그먼트 idx 기반 매핑 (가장 우선)
      // AI 응답의 "1.", "2.", "3."은 products 배열의 순서와 대응
      segments.forEach((seg, sIdx) => {
        if (seg.type !== 'product') return;
        const productIdx = seg.idx; // 0-based (parseRecommendationSegments에서 -1 처리됨)
        if (productIdx >= 0 && productIdx < products.length && !usedProductIndices.has(productIdx)) {
          productSegments[sIdx].push(products[productIdx]);
          usedProductIndices.add(productIdx);
          assignedSegIndices.add(sIdx);
        }
      });

      // ② 이름 매칭 보조 (idx 매핑에서 빠진 세그먼트)
      segments.forEach((seg, sIdx) => {
        if (seg.type !== 'product' || assignedSegIndices.has(sIdx)) return;
        const cleanText = seg.content.replace(/\*\*/g, '').replace(/\*/g, '').replace(/\s+/g, ' ').toLowerCase();
        let bestMatch = -1;
        let bestScore = 0;
        products.forEach((p, pIdx) => {
          if (usedProductIndices.has(pIdx)) return;
          const words = p.name.split(/[\s()[\]/·,]+/).filter(w => w.length > 1);
          if (!words.length) return;
          const matchCount = words.filter(w => cleanText.includes(w.toLowerCase())).length;
          const score = matchCount / words.length;
          if (score > bestScore && score >= 0.4) {
            bestScore = score;
            bestMatch = pIdx;
          }
        });
        if (bestMatch >= 0) {
          productSegments[sIdx].push(products[bestMatch]);
          usedProductIndices.add(bestMatch);
          assignedSegIndices.add(sIdx);
        }
      });

      // ③ 남은 상품 → 아직 비어있는 product 세그먼트에 순서대로 배분
      const emptyProductSegIdxs = segments
        .map((s, i) => (s.type === 'product' && !assignedSegIndices.has(i) ? i : -1))
        .filter(i => i !== -1);
      let cur = 0;
      products.forEach((p, pIdx) => {
        if (!usedProductIndices.has(pIdx) && cur < emptyProductSegIdxs.length) {
          productSegments[emptyProductSegIdxs[cur++]].push(p);
        }
      });

      console.log('[Chameleon] Product-segment matching:', {
        segments: segments.map(s => ({ type: s.type, idx: s.idx, snippet: s.content?.slice(0, 50) })),
        products: products.map(p => p.name),
        result: productSegments.map((ps, i) => ({ seg: i, products: ps.map(p => p.name) })),
      });

      return productSegments;
    }

    function createInlineCard(product) {
      const pdpBase = '/product/detail.html?product_no=';
      const pdpUrl  = `${pdpBase}${product.id}`;
      const priceText = product.price ? `₩${Number(product.price).toLocaleString()}` : '';
      const imgHtml = product.image_url
        ? `<img class="cml-inline-card-img" src="${product.image_url}" alt="${product.name}" loading="lazy">`
        : `<div class="cml-inline-card-img-placeholder">이미지 없음</div>`;
      const reasonHtml = product.reason
        ? `<div class="cml-inline-card-reason">${product.reason}</div>` : '';
      const chipLabels = ['소재가 어떻게 되나요?', '핏이 어떤가요?', '다른 색상도 있나요?'];
      const chipsHtml = chipLabels.map(c =>
        `<button class="cml-inline-card-chip"
           data-q="${c}" data-pid="${product.id}" data-pname="${product.name}">${c}</button>`
      ).join('');

      const card = document.createElement('div');
      card.className = 'cml-inline-card';
      card.dataset.productId = product.id;
      card.innerHTML = `
        <div class="cml-inline-card-header">
          <div class="cml-inline-card-header-left">
            <div class="cml-inline-card-name">${product.name}</div>
            ${priceText ? `<div class="cml-inline-card-price">${priceText}</div>` : ''}
          </div>
          <div class="cml-inline-card-toggle open">
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M2 5l5 5 5-5" stroke="#666" stroke-width="1.6"
                stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
        </div>
        <div class="cml-inline-card-body open">
          <div class="cml-inline-card-img-wrap">${imgHtml}</div>
          <div class="cml-inline-card-info">
            ${reasonHtml}
            <div class="cml-inline-card-chips">${chipsHtml}</div>
            <div class="cml-inline-card-btns">
              <a class="cml-inline-card-btn primary" href="${pdpUrl}">자세히 보기</a>
              <button class="cml-inline-card-btn secondary cml-inline-cart-btn">장바구니</button>
            </div>
            <div class="cml-inline-option-panel"></div>
          </div>
        </div>`;

      // 헤더 클릭 → 열기/닫기
      const header = card.querySelector('.cml-inline-card-header');
      const toggle = card.querySelector('.cml-inline-card-toggle');
      const body   = card.querySelector('.cml-inline-card-body');
      header.addEventListener('click', () => {
        const isOpen = body.classList.toggle('open');
        toggle.classList.toggle('open', isOpen);
      });

      // "자세히 보기" 클릭 → 상품 클릭 추적
      card.querySelector('.cml-inline-card-btn.primary')?.addEventListener('click', () => {
        track('product_click', { productNo: String(product.id) });
      });

      // 칩 클릭 → 사이드바 Q&A
      card.querySelectorAll('.cml-inline-card-chip').forEach(chip => {
        chip.addEventListener('click', e => {
          e.stopPropagation();
          document.dispatchEvent(new CustomEvent('chameleon:ask', {
            detail: {
              query: chip.dataset.q,
              mode: 'product_qa',
              productNo:   chip.dataset.pid,
              productName: chip.dataset.pname,
              fullChips:   chipLabels,
            },
          }));
        });
      });

      // 장바구니 버튼
      const cartBtn   = card.querySelector('.cml-inline-cart-btn');
      const optPanel  = card.querySelector('.cml-inline-option-panel');
      cartBtn.addEventListener('click', async e => {
        e.stopPropagation();
        if (optPanel.classList.contains('open')) { optPanel.classList.remove('open'); return; }
        cartBtn.textContent = '불러오는 중...'; cartBtn.disabled = true;
        const result = await fetchProductOptions(product.id);
        cartBtn.textContent = '장바구니'; cartBtn.disabled = false;
        if (result.error === 'no_token') {
          showToast('상품 페이지에서 옵션을 선택해주세요.');
          window.location.href = pdpUrl; return;
        }
        if (!result.options?.length) { await submitCart(product.id, null); return; }
        // 옵션 셀렉트 렌더
        optPanel.innerHTML = result.options.map(opt => `
          <select class="cml-option-select" data-option-no="${opt.option_no}">
            <option value="">-- ${opt.option_name} 선택 --</option>
            ${(opt.option_value || []).map(v =>
              `<option value="${v.option_value_no}">${v.option_text}</option>`
            ).join('')}
          </select>`).join('') +
          `<button class="cml-cart-confirm-btn">담기 확인</button>`;
        optPanel.dataset.variants = JSON.stringify(result.variants);
        optPanel.classList.add('open');
        optPanel.querySelector('.cml-cart-confirm-btn')?.addEventListener('click', async () => {
          const selects = optPanel.querySelectorAll('.cml-option-select');
          let allSelected = true;
          selects.forEach(s => { s.classList.remove('cml-error'); if (!s.value) { allSelected = false; s.classList.add('cml-error'); } });
          if (!allSelected) return;
          const selected = {};
          selects.forEach(s => { selected[Number(s.dataset.optionNo)] = Number(s.value); });
          const variants = JSON.parse(optPanel.dataset.variants || '[]');
          const variant = variants.find(v =>
            (v.options || []).length === Object.keys(selected).length &&
            (v.options || []).every(o => selected[o.option_no] === o.option_value_no)
          );
          if (!variant) { showToast('해당 옵션 조합을 찾을 수 없어요.'); return; }
          await submitCart(product.id, variant.variant_code);
          optPanel.classList.remove('open');
        });
      });

      return card;
    }

    // ── 메시지 내 인라인 상품 카드 (세로, 가로 배열용) ──
    function createMsgProductCard(product, badgeNum) {
      const pdpUrl = `/product/detail.html?product_no=${product.id}`;
      const priceText = product.price
        ? `${Number(product.price).toLocaleString()}원` : '';
      const card = document.createElement('div');
      card.className = 'cml-msg-product-card';
      card.dataset.productId = String(product.id);

      const hasImage = !!product.image_url;
      card.innerHTML = `
        <div class="cml-msg-product-img-wrap">
          ${hasImage
            ? `<img class="cml-msg-product-img" src="${product.image_url}" alt="${product.name}" loading="lazy">`
            : `<div class="cml-msg-product-img-placeholder">이미지 없음</div>`}
        </div>
        <div class="cml-msg-product-info">
          <div class="cml-msg-product-name">${product.name}</div>
          ${priceText ? `<div class="cml-msg-product-price">${priceText}</div>` : ''}
          <div class="cml-msg-product-btn-wrap">
            <a class="cml-msg-product-btn" href="${pdpUrl}">자세히 보기</a>
          </div>
        </div>`;

      // 이미지 로드 실패 시 플레이스홀더로 교체
      if (hasImage) {
        const img = card.querySelector('.cml-msg-product-img');
        img.addEventListener('error', () => {
          const wrap = img.parentElement;
          wrap.innerHTML = '<div class="cml-msg-product-img-placeholder">이미지 없음</div>';
        }, { once: true });
      }

      card.querySelector('.cml-msg-product-btn')?.addEventListener('click', () => {
        track('product_click', { productNo: String(product.id) });
      });
      return card;
    }

    function renderMsgProductCards(products, globalOffset) {
      const container = document.createElement('div');
      container.className = 'cml-msg-products';
      products.forEach((p, i) => {
        container.appendChild(createMsgProductCard(p, globalOffset + i + 1));
      });
      return container;
    }

    function renderRefinementChips(chips) {
      if (!chips || !chips.length) return null;

      function makeSet(ariaHidden) {
        const set = document.createElement('div');
        set.className = 'cml-refine-set';
        if (ariaHidden) set.setAttribute('aria-hidden', 'true');
        chips.forEach(label => {
          const btn = document.createElement('button');
          btn.className = 'cml-refine-chip';
          btn.textContent = label;
          if (ariaHidden) btn.tabIndex = -1;
          btn.addEventListener('click', () => {
            bar.classList.add('cml-paused');
            bar.querySelectorAll('.cml-refine-chip').forEach(c => c.classList.remove('cml-active'));
            bar.querySelectorAll('.cml-refine-chip').forEach(c => {
              if (c.textContent === label) c.classList.add('cml-active');
            });
            track('refine_chip_click', { chipLabel: label });
            sendRefinement(label, bar);
          });
          set.appendChild(btn);
        });
        return set;
      }

      const bar = document.createElement('div');
      bar.className = 'cml-refine-bar';
      const track = document.createElement('div');
      track.className = 'cml-refine-track';
      track.appendChild(makeSet(false));
      track.appendChild(makeSet(true));
      bar.appendChild(track);
      return bar;
    }

    async function consumeRecommendStream(fetchBody, { loadingBubble, onDone }) {
      const res = await fetch(`${CHAMELEON_SERVER}/api/recommend`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(fetchBody),
      });
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = '';
      let streamBubble = null;
      let streamRaw = '';
      let loadingGone = false;

      const removeLoading = () => { if (!loadingGone) { loadingBubble.remove(); loadingGone = true; } };

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        sseBuffer += decoder.decode(value, { stream: true });
        const events = sseBuffer.split('\n\n');
        sseBuffer = events.pop();

        for (const event of events) {
          if (!event.startsWith('data: ')) continue;
          let data;
          try { data = JSON.parse(event.slice(6)); } catch { continue; }

          if (data.type === 'chunk') {
            removeLoading();
            streamRaw += data.text;
            if (!streamBubble) {
              streamBubble = document.createElement('div');
              streamBubble.className = 'cml-chat-bubble assistant';
              messagesEl.appendChild(streamBubble);
            }
            streamBubble.innerHTML = parseMd(streamRaw);
            scrollToBottom();
          } else if (data.type === 'done' || data.type === 'error') {
            removeLoading();
            const msg = data.message || streamRaw || '죄송해요, 다시 시도해주세요.';
            if (streamBubble) streamBubble.innerHTML = parseMd(msg);
            else addBubble('assistant', msg);
            messageLog.push({ role: 'assistant', text: msg });

            if (data.type === 'done') onDone(data, msg);
          }
        }
      }
      if (!loadingGone) loadingBubble.remove();
    }

    async function sendRefinement(query, bar) {
      addBubble('user', query);
      const loadingBubble = addSkeletonLoader(query);
      sendBtn.disabled = true;
      try {
        await consumeRecommendStream({
          mallId: MALL_ID, query, conversationHistory: chatHistory,
          sessionId: sessionStorage.getItem('cml_sid') || '',
          pageUrl: location.href,
        }, {
          loadingBubble,
          onDone: (data, msg) => {
            if (data.products?.length) renderInlineRecommendation(msg, data.products, data.refinement_chips);
            if (bar) messagesEl.appendChild(bar);
            chatHistory.push({ role: 'user', content: query });
            chatHistory.push({ role: 'assistant', content: msg });
            if (chatHistory.length > 20) chatHistory.splice(0, 2);
          },
        });
      } catch {
        loadingBubble.remove();
        addBubble('assistant', '네트워크 오류가 발생했어요. 잠시 후 다시 시도해주세요.');
      } finally {
        sendBtn.disabled = false;
        scrollToBottom();
        inputEl.focus();
      }
    }

    function renderInlineRecommendation(message, products, chips) {
      // 메시지 전체를 하나의 버블로 표시 (1. 2. 3. 넘버링 포함)
      lastProducts = products || [];
      addBubble('assistant', message);

      // 상품 카드 전체를 가로 1행으로 나열
      if (products.length) {
        const container = document.createElement('div');
        container.className = 'cml-msg-products';
        container.dataset.products = JSON.stringify(products);
        products.forEach((p, i) => container.appendChild(createMsgProductCard(p, i + 1)));
        messagesEl.appendChild(container);
        scrollToBottom();
      }

      // 리파인 칩 바
      if (chips && chips.length) {
        _lastChips = chips;
        if (_refineBar) _refineBar.remove();
        _refineBar = renderRefinementChips(chips);
        if (_refineBar) { messagesEl.appendChild(_refineBar); scrollToBottom(); }
        saveSession(lastProducts);
      }
    }

    // ── 채팅 전송 ──
    async function sendChat(query) {
      if (!query.trim()) return;
      if (_refineBar) { _refineBar.remove(); _refineBar = null; }
      _lastChips = [];
      addBubble('user', query);
      const loadingBubble = addSkeletonLoader(query);
      sendBtn.disabled = true;
      const pendingMode = _pendingMode; _pendingMode = null;
      try {
        await consumeRecommendStream({
          mallId: MALL_ID, query, conversationHistory: chatHistory,
          sessionId: sessionStorage.getItem('cml_sid') || '',
          pageUrl: location.href,
          mode: pendingMode || undefined,
        }, {
          loadingBubble,
          onDone: (data, msg) => {
            if (data.products?.length) {
              lastProducts = data.products;
              const container = document.createElement('div');
              container.className = 'cml-msg-products';
              data.products.forEach((p, i) => container.appendChild(createMsgProductCard(p, i + 1)));
              messagesEl.appendChild(container);
              scrollToBottom();
            }
            if (data.refinement_chips?.length) {
              _lastChips = data.refinement_chips;
              if (_refineBar) _refineBar.remove();
              _refineBar = renderRefinementChips(data.refinement_chips);
              if (_refineBar) { messagesEl.appendChild(_refineBar); scrollToBottom(); }
            }
            chatHistory.push({ role: 'user', content: query });
            chatHistory.push({ role: 'assistant', content: msg });
            if (chatHistory.length > 20) chatHistory.splice(0, 2);
            saveSession(lastProducts);
          },
        });
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
    panel.querySelector('#cml-welcome-chips').addEventListener('click', e => {
      const chip = e.target.closest('.cml-welcome-chip');
      if (!chip) return;
      track('chip_click', { chipLabel: chip.dataset.q, productNo: chip.dataset.pid || null });
      if (chip.dataset.pid) {
        openSidebar();
        setTimeout(() => sendProductQA(chip.dataset.q, chip.dataset.pid, chip.dataset.pname), 100);
      } else {
        sendChat(chip.dataset.q);
      }
    });

    // ── 상품 특정 Q&A (PDP 칩 클릭 전용) ──
    async function sendProductQA(query, productNo, productName) {
      if (!query.trim()) return;
      addBubble('user', query);
      const loadingBubble = addSkeletonLoader('이 상품에 대해');
      sendBtn.disabled = true;
      try {
        const res = await fetch(`${CHAMELEON_SERVER}/api/ask`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mallId: MALL_ID, productNo, productName, question: query, sessionId: sessionStorage.getItem('cml_sid') || '', pageUrl: location.href }),
        });
        const data = await res.json();
        loadingBubble.remove();
        addBubble('assistant', data.answer || '죄송해요, 다시 시도해주세요.');
        chatHistory.push({ role: 'user', content: query });
        chatHistory.push({ role: 'assistant', content: data.answer || '' });
        if (chatHistory.length > 20) chatHistory.splice(0, 2);
        // 답변 후 팔로업 질문 트레이 표시
        showFollowUpChips(query);
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
      const { query, mode, productNo, productName, fullChips } = e.detail;
      track('chip_click', { chipLabel: query, productNo: productNo || null });
      if (mode === 'product_qa') {
        // 이 상품 전용 컨텍스트 저장
        _pdpProductNo   = productNo   || '';
        _pdpProductName = productName || '';
        _pdpChips       = fullChips   || [];
        // 팔로업 트레이 초기화
        followTray.style.display = 'none';
        followScroll.innerHTML   = '';
        if (_stopAutoScroll) { _stopAutoScroll(); _stopAutoScroll = null; }
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

    // ── PDP 웰컴 UX ──
    // 세션 없을 때만: 인사말 변경 + 칩 자동스크롤 + 사이드바 자동 오픈
    // ── PDP 칩 개인화 선택 ──
    // allChips에서 count개를 랜덤 선택, 이미 대화한 주제는 뒤로 밀기
    function selectPdpChips(allChips, count) {
      if (!allChips?.length) return [];
      const historyText = messageLog.map(m => m.text || '').join(' ').toLowerCase();
      const scored = allChips.map(c => ({
        c,
        // 이미 비슷한 단어가 대화에 나왔다면 우선순위 낮춤
        score: historyText.includes(c.slice(0, 5).toLowerCase())
          ? Math.random() * 0.35
          : 0.4 + Math.random() * 0.6,
      }));
      scored.sort((a, b) => b.score - a.score);
      return scored.slice(0, count).map(s => s.c);
    }

    function setupPdpWelcome(productName, chips, productNo) {
      // 웰컴 타이틀 PDP 전용으로 교체 (세션 복원 여부와 무관하게 항상 갱신)
      const welcomeTitleEl = welcomeEl?.querySelector('.cml-chat-welcome-title');
      if (welcomeTitleEl) {
        // 받침 여부에 따라 을/를 선택
        const last = productName.charCodeAt(productName.length - 1);
        const particle = (last >= 0xAC00 && last <= 0xD7A3 && (last - 0xAC00) % 28 !== 0) ? '을' : '를';
        welcomeTitleEl.innerHTML = `<strong>${productName}</strong>${particle} 보고 있군요`;
      }

      // 웰컴 바디 텍스트 교체
      const welcomeBodyEl = welcomeEl?.querySelector('.cml-chat-welcome-body');
      if (welcomeBodyEl) {
        welcomeBodyEl.textContent = '상품에 대해 마음껏 질문하거나, 아래의 질문을 골라보세요';
      }

      if (messageLog.length > 0) return; // 기존 대화가 있으면 칩 교체는 건드리지 않음

      const chipPool = chips?.length ? chips : ['소재가 어떻게 되나요?', '사이즈 선택 어떻게 하나요?', '어떤 상황에 어울려요?', '관리 방법이 어떻게 되나요?'];

      // 웰컴 칩을 상품 특화 칩으로 교체 (이력 기반 개인화)
      const welcomeChipsEl = panel.querySelector('#cml-welcome-chips');
      if (welcomeChipsEl) {
        const selected = selectPdpChips(chipPool, 4);
        welcomeChipsEl.innerHTML = selected.map(c =>
          `<button class="cml-welcome-chip" data-q="${c}" data-pid="${productNo}" data-pname="${productName}">${c}</button>`
        ).join('');
      }

      // PDP 웰컴 칩 트레이 구성 (입력창 아래 자동 스크롤)
      const tray = panel.querySelector('#cml-pdp-welcome-tray');
      const scroll = panel.querySelector('#cml-pdp-welcome-scroll');
      // 칩 2벌 이어붙여 무한 스크롤처럼 보이게
      const doubled = [...chipPool, ...chipPool];
      scroll.innerHTML = doubled.map(c =>
        `<button class="cml-pdp-welcome-chip" data-q="${c}" data-pid="${productNo}" data-pname="${productName}">${c}</button>`
      ).join('');
      tray.style.display = 'block';

      // 칩 클릭 → product_qa
      scroll.addEventListener('click', e => {
        const chip = e.target.closest('.cml-pdp-welcome-chip');
        if (!chip) return;
        document.dispatchEvent(new CustomEvent('chameleon:ask', {
          detail: {
            query:       chip.dataset.q,
            mode:        'product_qa',
            productNo:   chip.dataset.pid,
            productName: chip.dataset.pname,
            fullChips:   chipPool,
          },
        }));
      });

      // rAF 기반 좌측 자동스크롤 (0.4px/frame, 터치/클릭 시 일시정지)
      let paused = false;
      let rafId;
      const speed = 0.4;
      let half = 0; // 패널이 열린 후 첫 프레임에서 측정
      const raf = () => {
        if (!paused) {
          if (!half) half = scroll.scrollWidth / 2; // lazy: 레이아웃 완료 후 측정
          scroll.scrollLeft += speed;
          if (half > 0 && scroll.scrollLeft >= half) scroll.scrollLeft = 0;
        }
        rafId = requestAnimationFrame(raf);
      };
      rafId = requestAnimationFrame(raf);
      scroll.addEventListener('mouseenter', () => { paused = true; });
      scroll.addEventListener('mouseleave', () => { paused = false; });
      scroll.addEventListener('touchstart',  () => { paused = true; }, { passive: true });
      scroll.addEventListener('touchend',    () => { paused = false; });

      // SneakPeek 억제 후 사이드바 자동 오픈
      setTimeout(() => openSidebar(), 600);
    }

    function updateConfig(newConfig) {
      applyCssVars(newConfig?.theme);
    }

    return { setupPdpWelcome, updateConfig };
  }

  // ── after_cart 모드용 1회성 모드 플래그 ──
  let _pendingMode = null;

  // ── 장바구니 이벤트 감지 → after_cart 모드 트리거 ──
  function setupCartDetection() {
    // Cafe24 표준 장바구니 버튼 셀렉터들
    const CART_BTN_SEL = [
      '.btnCartAdd', '#cartAddBtn', '.cart-add', '[data-action="cart"]',
      'button[onclick*="cart"]', 'input[onclick*="cart"]',
      '.xans-product-detail .btn-cart', '#frmView .btn-primary',
    ].join(',');

    // MutationObserver로 동적 렌더된 버튼도 감지
    let cartBtns = [];

    function attachCartListeners() {
      document.querySelectorAll(CART_BTN_SEL).forEach(btn => {
        if (btn._cmlCartTracked) return;
        btn._cmlCartTracked = true;
        btn.addEventListener('click', () => {
          // 장바구니 추가 확인 딜레이 (페이지가 반응하는 시간 고려)
          setTimeout(() => {
            track('cart_add');
            _pendingMode = 'after_cart';
            // 사이드바가 닫혀 있으면 열기
            const chatPanel = document.querySelector('#cml-chat-panel') ||
                              document.querySelector('.cml-chat-panel');
            if (chatPanel && chatPanel.style.display !== 'none') {
              // 이미 열려 있으면 자동 메시지 전송
              const autoQuery = '장바구니에 담은 상품이랑 코디하면 좋은 거 추천해줘';
              const inputEl = chatPanel.querySelector('#cml-chat-input') ||
                              chatPanel.querySelector('input[type="text"]');
              const sendEl  = chatPanel.querySelector('#cml-chat-send');
              if (inputEl && sendEl) {
                inputEl.value = autoQuery;
                sendEl.click();
              }
            } else {
              // 닫혀 있으면 탭을 sneak peek처럼 살짝 강조 (자동 열기는 안 함 — UX 침해)
              const tab = document.querySelector('#cml-sidebar-tab') ||
                          document.querySelector('.cml-sidebar-tab');
              if (tab) {
                tab.style.boxShadow = '-4px 0 20px rgba(94,70,55,0.25)';
                setTimeout(() => { tab.style.boxShadow = ''; }, 3000);
              }
            }
          }, 600);
        });
      });
    }

    attachCartListeners();
    // DOM 변화 감시 (SPA, AJAX 렌더링 대응)
    const obs = new MutationObserver(() => attachCartListeners());
    obs.observe(document.body, { childList: true, subtree: true });
  }

  // ── 11. 실행 ────────────────────────────────────
  async function init() {
    injectStyles();
    track('impression'); // 페이지 로드 = 위젯 노출
    setupCartDetection(); // 장바구니 이벤트 감지 시작

    // config + pdpContent 요청을 동시에 시작 (직렬 await 제거)
    const configPromise = fetch(`${CHAMELEON_SERVER}/api/config/${MALL_ID}`)
      .then(r => r.json()).catch(() => null);

    // FAB: config 로드 후 렌더 (브랜딩 텍스트·색상 모두 정확하게)
    // config 요청은 보통 <200ms이므로 탭 출현 지연이 체감되지 않음
    let fab = null;
    configPromise.then(config => { fab = renderFab(config); });

    if (isPDP) {
      const signals     = collectSignals();
      const productInfo = getProductInfo();

      // PHASE 1 — 즉시 렌더 (<50ms): AI 콘텐츠 없이 기본 칩으로 패널 표시
      renderPanel(null, null, { productNo: signals.productNo, productName: productInfo.name });

      // PHASE 2 — config + AI 콘텐츠 병렬 대기 후 패널 교체
      const pdpPromise = fetchPdpContent(signals.productNo, productInfo.name, productInfo.desc);
      Promise.all([configPromise, pdpPromise]).then(([config, pdpContent]) => {
        // adaptivePdp 비활성화 시 패널 제거
        if (config?.adaptivePdp?.enabled === false) {
          document.getElementById('cml-panel')?.remove();
          return;
        }
        if (!config && !pdpContent) return; // 둘 다 없으면 기본 패널 유지
        const panel = document.getElementById('cml-panel');
        if (panel) { panel.style.transition = 'opacity 0.2s'; panel.style.opacity = '0'; }
        requestAnimationFrame(() => {
          renderPanel(pdpContent, config, { productNo: signals.productNo, productName: productInfo.name });
          const updated = document.getElementById('cml-panel');
          if (updated) { updated.style.transition = 'opacity 0.2s'; updated.style.opacity = '1'; }
          const nameForWelcome = pdpContent?.productName || productInfo.name;
          if (fab?.setupPdpWelcome && nameForWelcome) {
            fab.setupPdpWelcome(nameForWelcome, pdpContent?.chips || [], signals.productNo);
          }
        });
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
