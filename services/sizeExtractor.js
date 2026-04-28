/**
 * sizeExtractor.js — 상품 사이즈 데이터 추출 파이프라인
 *
 * 우선순위:
 *   1. 상품 페이지 HTML에서 <table> 직접 파싱  ← 가장 정확
 *   2. 카페24 API description HTML에서 파싱    ← 두 번째
 *   3. 사이즈가이드 이미지 → Gemini Vision OCR ← 폴백
 *
 * 추출 후 LLM 정규화:
 *   수치 → 핏/슬리브/계절/스타일 라벨 + embedding_text 생성
 */

const axios = require('axios');

const GEMINI_URL = () =>
  `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${process.env.GOOGLE_AI_API_KEY}`;

// 사이즈 관련 한/영 키워드
const SIZE_KEYWORDS = ['어깨', '가슴', '허리', '소매', '기장', '힙', '허벅지', '밑위', 'shoulder', 'chest', 'sleeve', 'length'];

/**
 * 메인 오케스트레이터
 *
 * @param {object} productInfo - 카페24 API 상품 데이터
 *   - name: string
 *   - description: string (HTML 포함 가능)
 *   - material: string
 *   - sizeGuideImageUrl: string | null  ← 사이즈가이드 이미지 URL
 * @param {string} [pageHtml] - 상품 상세페이지 전체 HTML (선택)
 * @returns {object|null} 정규화된 사이즈 데이터
 */
async function extractSizeData(productInfo, pageHtml = '') {
  const candidates = [];

  // 1. 상품 페이지 HTML에서 추출 (가장 신뢰도 높음)
  if (pageHtml) {
    const result = await extractFromHtml(pageHtml);
    if (result) candidates.push({ source: 'page_html', data: result });
  }

  // 2. description 필드 HTML에서 추출
  if (productInfo.description && candidates.length === 0) {
    const result = await extractFromHtml(productInfo.description);
    if (result) candidates.push({ source: 'description', data: result });
  }

  // 3. 사이즈가이드 이미지 → Vision OCR
  if (productInfo.sizeGuideImageUrl && candidates.length === 0) {
    const result = await extractFromImage(productInfo.sizeGuideImageUrl);
    if (result) candidates.push({ source: 'image_ocr', data: result });
  }

  if (candidates.length === 0) {
    return null; // 사이즈 정보 없음
  }

  // 가장 풍부한 데이터 선택 (sizes 항목 수 기준)
  const best = candidates.sort(
    (a, b) => Object.keys(b.data.sizes || {}).length - Object.keys(a.data.sizes || {}).length
  )[0];

  console.log(`[SizeExtractor] source=${best.source}, sizes=${Object.keys(best.data.sizes || {}).length}개`);

  // 4. LLM 정규화 — 수치 → 핏/계절/스타일 도출
  const normalized = await normalizeWithLLM(best.data, productInfo);
  return { ...normalized, _source: best.source };
}

// ─────────────────────────────────────────────────────────────
// 소스 1 & 2: HTML에서 사이즈 테이블 추출
// ─────────────────────────────────────────────────────────────

/**
 * HTML(또는 description)에서 사이즈 테이블을 찾아 추출
 */
async function extractFromHtml(html) {
  // 사이즈 정보가 있는지 빠르게 확인
  const hasSizeKeyword = SIZE_KEYWORDS.some(k => html.includes(k));
  if (!hasSizeKeyword) return null;

  // 사이즈 테이블 섹션만 추출 (토큰 절약)
  const section = extractSizeSection(html);
  if (!section) return null;

  const prompt = `다음 HTML에서 상의/하의/신발 등의 사이즈 치수 표를 추출해 JSON으로 반환하세요.

HTML:
${section}

반환 형식:
{
  "found": true,
  "unit": "cm",
  "sizes": {
    "44": { "어깨": 45.0, "가슴": 49.0, "소매": 24.0, "기장": 68.0 },
    "S":  { "어깨": 45.0, "가슴": 49.0 },
    ...
  }
}

규칙:
- 사이즈 라벨: 테이블 그대로 사용 (S/M/L/XL 또는 44/46/48 등)
- 측정 항목명은 한국어로 통일 (shoulder→어깨, chest→가슴, sleeve→소매, length→기장 등)
- 숫자만 추출, 단위(cm/mm) 제거 후 unit 필드에 표기
- 사이즈 테이블이 없으면 { "found": false }
- 반드시 JSON만 반환 (설명 없이)`;

  try {
    const text = await callGeminiText(prompt);
    const json = parseJson(text);
    if (!json || json.found === false || !json.sizes || Object.keys(json.sizes).length === 0) {
      return null;
    }
    return json;
  } catch (err) {
    console.error('[SizeExtractor] HTML extraction error:', err.message);
    return null;
  }
}

/**
 * HTML에서 사이즈 관련 <table> 섹션만 추출
 * 전체 HTML을 LLM에 보내면 토큰 낭비 → 관련 부분만 잘라냄
 */
function extractSizeSection(html) {
  // 사이즈 키워드가 포함된 <table> 요소 추출
  const tablePattern = /<table[\s\S]*?<\/table>/gi;
  const tables = [...html.matchAll(tablePattern)].map(m => m[0]);
  const sizeTables = tables.filter(t =>
    SIZE_KEYWORDS.some(k => t.toLowerCase().includes(k.toLowerCase()))
  );

  if (sizeTables.length > 0) {
    return sizeTables.join('\n').slice(0, 8000);
  }

  // 테이블 없으면 키워드 주변 텍스트 섹션
  for (const keyword of SIZE_KEYWORDS) {
    const idx = html.indexOf(keyword);
    if (idx > -1) {
      return html.slice(Math.max(0, idx - 300), idx + 3000);
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────
// 소스 3: 사이즈가이드 이미지 → Gemini Vision OCR
// ─────────────────────────────────────────────────────────────

/**
 * 이미지 URL에서 사이즈 표 추출 (Gemini Vision)
 */
async function extractFromImage(imageUrl) {
  let base64, mimeType;

  try {
    const imgRes = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0' },
    });
    base64 = Buffer.from(imgRes.data).toString('base64');
    mimeType = imgRes.headers['content-type']?.split(';')[0] || 'image/jpeg';
  } catch (err) {
    console.error('[SizeExtractor] Image download failed:', err.message);
    return null;
  }

  const prompt = `이 이미지에서 상품 사이즈 치수 표를 추출해 JSON으로 반환하세요.

반환 형식:
{
  "found": true,
  "unit": "cm",
  "sizes": {
    "S": { "어깨": 45.0, "가슴": 49.0, "소매": 60.0, "기장": 70.0 },
    "M": { ... },
    ...
  }
}

규칙:
- 측정 항목명은 한국어로 통일 (shoulder→어깨, chest→가슴, sleeve→소매, length→기장, waist→허리, hip→힙)
- 숫자만 추출, 단위는 unit 필드에
- 이미지에 사이즈 표가 없으면 { "found": false }
- 반드시 JSON만 반환`;

  try {
    const body = {
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: mimeType, data: base64 } },
        ],
      }],
      generationConfig: { maxOutputTokens: 1000 },
    };

    const res = await axios.post(GEMINI_URL(), body);
    const text = res.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const json = parseJson(text);

    if (!json || json.found === false || !json.sizes || Object.keys(json.sizes).length === 0) {
      return null;
    }
    return json;
  } catch (err) {
    console.error('[SizeExtractor] Vision OCR error:', err.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────
// LLM 정규화 — 수치 → 핏/계절/스타일 라벨 + embedding_text
// ─────────────────────────────────────────────────────────────

/**
 * 추출된 사이즈 수치를 의미 있는 라벨로 정규화
 * "수치가 라벨을 증명한다" 원칙
 */
async function normalizeWithLLM(sizeData, productInfo) {
  const prompt = `다음 상품의 사이즈 데이터를 분석해 JSON으로 반환하세요.

상품명: ${productInfo.name || ''}
소재: ${productInfo.material || '정보 없음'}
설명: ${stripHtml(productInfo.description || '').slice(0, 400)}
사이즈 데이터 (단위: ${sizeData.unit || 'cm'}):
${JSON.stringify(sizeData.sizes, null, 2)}

분석 기준:
- 가슴 여유량 = (가슴_반신 × 2) - 평균체형(남성 92cm / 여성 82cm)
- 핏 기준: 여유 <10cm=슬림, 10~20=레귤러, 20~30=세미오버, 30+=오버사이즈
- 슬리브 기준: 소매 <30cm=숏슬리브, 30~50=반팔, 50+=긴팔 (cm 기준)
- 계절은 소재 + 슬리브 길이 + 기장으로 도출

반환 형식:
{
  "sleeve_type": "숏슬리브|반팔|긴팔|민소매|불명",
  "fit": "슬림|레귤러|세미오버|오버사이즈|불명",
  "fit_surplus_cm": 25,
  "length_type": "크롭|보통|롱|불명",
  "season": ["봄", "여름"],
  "breathability": "높음|중간|낮음",
  "recommended_size": {
    "S": { "height_cm": "165-170", "chest_cm": "82-88" },
    "M": { ... }
  },
  "NOT": ["오버사이즈", "겨울용"],
  "embedding_text": "핵심 정보를 담은 임베딩용 한 문단 (100자 내외)"
}

반드시 JSON만 반환.`;

  try {
    const text = await callGeminiText(prompt);
    const json = parseJson(text);
    if (!json) return { raw: sizeData };
    return { ...json, raw: sizeData };
  } catch (err) {
    console.error('[SizeExtractor] LLM normalization error:', err.message);
    return { raw: sizeData };
  }
}

// ─────────────────────────────────────────────────────────────
// 헬퍼
// ─────────────────────────────────────────────────────────────

async function callGeminiText(prompt) {
  const res = await axios.post(GEMINI_URL(), {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { maxOutputTokens: 1000 },
  });
  return res.data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

function parseJson(text) {
  try {
    const cleaned = text
      .replace(/```json\s*/g, '')
      .replace(/```\s*/g, '')
      .trim();
    return JSON.parse(cleaned);
  } catch {
    // JSON 블록 안에 있는 경우 재시도
    const match = text.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { return null; }
    }
    return null;
  }
}

function stripHtml(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

module.exports = {
  extractSizeData,
  extractFromHtml,
  extractFromImage,
  normalizeWithLLM,
};
