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
  const CHAMELEON_SERVER = 'https://brave-geography-function-lens.trycloudflare.com';
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

  if (!isPDP) return;

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
          <input class="cml-ask-input" id="cml-ask-input" type="text" placeholder="상품에 대해 무엇이든 물어보세요" autocomplete="off" />
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

    // 질문 전송 공통 함수
    const answerEl = panel.querySelector('#cml-answer');
    const inputEl  = panel.querySelector('#cml-ask-input');
    const btnEl    = panel.querySelector('#cml-ask-btn');

    async function askQuestion(question) {
      if (!question.trim()) return;
      answerEl.textContent = '답변을 생성하고 있어요...';
      answerEl.className = 'cml-answer loading';
      answerEl.style.display = 'block';
      btnEl.disabled = true;

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
        answerEl.textContent = '네트워크 오류가 발생했어요. 잠시 후 다시 시도해주세요.';
        answerEl.className = 'cml-answer';
      } finally {
        btnEl.disabled = false;
      }
    }

    // FAQ 칩 클릭 → 질문 전송
    panel.querySelectorAll('.cml-chip').forEach(chip => {
      chip.addEventListener('click', () => {
        const q = chip.dataset.q;
        inputEl.value = q;
        askQuestion(q);
      });
    });

    // 입력창 제출
    btnEl.addEventListener('click', () => {
      askQuestion(inputEl.value);
      inputEl.value = '';
    });
    inputEl.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        askQuestion(inputEl.value);
        inputEl.value = '';
      }
    });
  }

  // ── 9. 실행 ────────────────────────────────────
  async function init() {
    injectStyles();

    // 스토어 config와 신호 수집을 병렬로
    const [config, signals] = await Promise.all([
      fetch(`${CHAMELEON_SERVER}/api/config/${MALL_ID}`).then(r => r.json()).catch(() => null),
      Promise.resolve(collectSignals()),
    ]);

    const product = getProductInfo();
    console.log('[Chameleon] Config:', config);
    console.log('[Chameleon] Signals:', signals);
    console.log('[Chameleon] Product:', product);

    await new Promise(r => setTimeout(r, 3000));
    signals.scrollDepth = Math.round(
      (window.scrollY / (document.body.scrollHeight - window.innerHeight)) * 100
    );

    const persona = await fetchPersona(signals);
    console.log('[Chameleon] Persona:', persona);

    renderPanel(persona, config);
  }

  // DOM 준비 후 실행
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
