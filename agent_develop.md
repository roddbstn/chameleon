# Chameleon AI Agent — 개발 기록

> 카페24 쇼핑몰에 삽입되는 AI 쇼핑 어드바이저 에이전트의 설계·구현·개선 과정 전체 기록.

---

## 1. 프로젝트 개요

### 무엇을 만들었나

**Chameleon**은 카페24 쇼핑몰에 스크립트 태그 한 줄로 삽입되는 AI 쇼핑 어드바이저 위젯이다. 상품 상세 페이지(PDP)에서 유저의 자연어 질문을 받아, 벡터 검색으로 관련 상품을 찾고, LLM이 상황에 맞는 추천 메시지를 생성해 반환한다.

### 핵심 가치

- 유저가 말하는 것 그대로 이해하고 즉시 상품을 보여준다
- 스타일을 모르는 유저도 대화를 통해 자신의 취향을 발견할 수 있다
- 쇼핑몰 운영자는 코드 없이 삽입만 하면 된다

### 기술 스택

| 레이어 | 기술 |
|---|---|
| 위젯 (프론트) | Vanilla JS, Shadow DOM (CSS 격리) |
| 서버 | Node.js + Express, Railway 배포 |
| AI | Google Gemini (gemini-2.5-flash / 1.5-flash 폴백) |
| 벡터 DB | Supabase (pgvector) + `match_products` RPC |
| 임베딩 | gemini-embedding-001 |
| 상품 DB | Supabase `products` 테이블 |

---

## 2. 시스템 아키텍처

### 전체 흐름

```
유저 입력
    ↓
[Widget.js — Shadow DOM]
    ↓ POST /api/recommend
[서버 — recommender.js]
    ├── Agent 1: analyzeIntent()   → intent_type, search_query, color_filter
    ├── Vector Search              → Supabase match_products RPC
    ├── 모드 라우팅                → specific / discovery / refinement
    └── Agent 2: generateRecommendation() → 추천 메시지
    ↓
[Widget.js]
    ├── 인라인 카드 (메시지 사이사이)
    └── 하단 Shelf (가로 스크롤 카드 리스트)
```

### 파일 구조

```
chameleon/
├── server.js                  # Express 라우터, /api/recommend 엔드포인트
├── services/
│   └── recommender.js         # AI 에이전트 파이프라인 전체
└── public/
    ├── widget.js              # 브라우저에서 실행되는 위젯 (Shadow DOM)
    └── demo.html              # 로컬 데모 페이지
```

---

## 3. AI 에이전트 파이프라인 상세

### 3-1. Agent 1: 인텐트 분석 (`analyzeIntent`)

유저의 자연어 메시지에서 구조화된 의도를 추출한다.

**출력 JSON 구조:**

```json
{
  "intent_type": "specific | discovery | refinement",
  "situation": "유저가 처한 상황",
  "needs": "진짜 필요한 것",
  "constraints": "제약 조건",
  "assumptions": "합리적으로 추측할 수 있는 것들",
  "search_query": "벡터 검색용 확장 쿼리 (최대 200자)",
  "color_filter": {
    "include": ["원하는 색상"],
    "exclude": ["피하는 색상"]
  },
  "clarification_needed": false,
  "clarification_question": null
}
```

**`intent_type` 판단 기준:**

| 타입 | 조건 | 예시 |
|---|---|---|
| `specific` | 소재·카테고리·색상·상황 등 구체적 단서 존재 | "뱀피 상의 추천해줘", "검정 팬츠", "소개팅 코디" |
| `discovery` | 아무 단서 없이 탐색 중 | "뭘 사야 할지 모르겠어", "옷 추천해줘", "어떤 게 유행해?" |
| `refinement` | 이전 추천에 대한 반응·수정 | "이런 거 말고", "더 캐주얼하게", "비슷한데 다른 색으로" |

**대화 상태 추적:**
- `genderKnown`: 전체 대화 히스토리에서 성별 언급 여부 감지
- `alreadyAsked`: 이미 질문을 한 번이라도 했으면 이후 모든 clarification 차단

---

### 3-2. 벡터 검색

#### Specific / Refinement 모드 — 단일 쿼리 검색

```
analyzeIntent → search_query → embedQuery() → vectorSearch(mallId, count=8)
```

Supabase `match_products` RPC를 호출한다. `mall_id`로 쇼핑몰별 격리.

#### Discovery 모드 — 스타일 버킷 병렬 검색 (`discoverySearch`)

스타일이 서로 다른 3개의 쿼리를 **병렬**로 임베딩 + 검색해, 각 스타일 방향의 대표 상품 2개씩 총 최대 6개를 반환한다.

```javascript
const STYLE_BUCKETS = [
  { label: '미니멀/클린',   query: '미니멀 베이직 클린 심플 모던 뉴트럴 톤 깔끔한 실루엣' },
  { label: '캐주얼/스트릿', query: '캐주얼 스트릿 오버핏 루즈 편안한 데일리 후드 맨투맨' },
  { label: '트렌디/유니크', query: '트렌디 포인트 유니크 개성 프린트 컬러 감각적인 시즌' },
];
```

**왜 이렇게 설계했나:**  
유저에게 "어떤 스타일이 좋으세요?"라고 추상적으로 물으면 대답하기 어렵다. 반면 실제 상품 3개를 보여주고 "어떤 느낌이 끌리세요?"라고 하면 누구나 반응할 수 있다. 말로 설명하지 못해도, 보고 반응하는 것만으로 스타일을 찾아갈 수 있다.

---

### 3-3. 색상 필터링

인텐트 분석에서 추출한 `color_filter`로 검색 결과를 후처리 필터링한다.

- `exclude` 색상이 상품명/설명에 포함된 상품 제거 (필터 후 2개 이상 남을 때만 적용)
- `include` 색상이 매칭되는 상품 우선 (3개 이상 남을 때만 적용)
- "밝은 색" → 블랙/차콜/네이비 자동 exclude
- "어두운 색" → 화이트/크림/베이지 자동 exclude

---

### 3-4. Agent 2: 추천 생성 (`generateRecommendation`)

모드에 따라 프롬프트가 달라진다.

#### Specific 모드 프롬프트 구조

```
1. 유저 니즈를 한 문장으로 짚기 (인사말 없이 바로 시작)
2. 상품 2~3개 추천
   - 상품명 정확히 포함 (카드 매칭에 사용)
   - 성별 타겟 정보 활용
   - 이 상황에 왜 이 상품인지 구체적 이유
3. 마지막에 — 로 이어지는 짧은 후속 질문 1개 (선택)
```

#### Discovery 모드 프롬프트 구조

```
1. "스타일이 다른 몇 가지를 가져왔어요." (한 문장)
2. 상품 3개를 각각 다른 스타일로 소개
   - **미니멀/클린**, **캐주얼/스트릿**, **트렌디/유니크** 레이블 표시
   - 이 스타일이 어떤 사람/상황에 어울리는지 2문장 이내
3. "마음에 드는 방향이 있으신가요?" (한 문장)
```

#### Refinement 모드 프롬프트 구조

```
1. 유저의 피드백을 한 문장으로 반영
2. 수정된 방향의 상품 2~3개
3. 짧은 후속 질문 (없어도 됨)
```

**상품 성별 타겟 자동 추론:**  
상품명·설명 텍스트에서 키워드로 판단한다.

```javascript
const genderHint =
  /여성|우먼|women|girl|lady/.test(text) ? '여성 타겟' :
  /남성|맨즈|men|man\b/.test(text)       ? '남성 타겟' : '남녀공용';
```

---

### 3-5. 상품 카드 매칭 — PRODUCTS 태그 방식의 문제와 해결

**초기 방식 (문제 있음):**  
LLM에게 `PRODUCTS:[1,2,3]` 태그를 응답 끝에 붙이도록 지시. LLM이 텍스트에선 A를 추천하면서 태그엔 B를 적는 불일치 문제가 반복 발생.

**현재 방식 (이름 매칭):**  
LLM 응답 텍스트에서 실제로 언급된 상품명을 검색 결과 풀에서 직접 매칭한다.

```javascript
const mentionedByName = products
  .filter(p => msgLower.includes(p.name.toLowerCase()))
  .sort((a, b) =>
    msgLower.indexOf(a.name.toLowerCase()) - msgLower.indexOf(b.name.toLowerCase())
  );
```

텍스트에 이름이 없으면 번호 순서 파싱 → 없으면 상위 3개 폴백.

---

### 3-6. Gemini API 버전 관리

안정 모델과 프리뷰 모델이 서로 다른 엔드포인트를 사용한다.

```javascript
const GEMINI_CHAIN = [
  { model: 'gemini-2.5-flash', api: 'v1beta' },  // 프리뷰 → v1beta
  { model: 'gemini-1.5-flash', api: 'v1' },       // 안정   → v1
];
```

- 429 (Rate Limit): 지수 백오프 후 재시도
- 503 / 404: 다음 모델로 폴백

---

### 3-7. 비용 한도 관리

월 API 비용이 설정한 한도를 초과하면 추천 자체를 차단한다.

```javascript
const limit = parseFloat(process.env.MONTHLY_COST_LIMIT_USD || '1.0');
// Supabase api_events 테이블에서 이번 달 누적 비용 조회
// 초과 시 에러 throw → 서버가 429 응답
```

모든 Gemini 호출 후 토큰 수 기반으로 비용을 Supabase에 로깅한다.

---

## 4. 대화 설계 — 반복된 실패와 개선

### 4-1. 문제: 역질문 루프

**실제 발생한 시나리오:**

```
유저: 뱀피가 들어간 상의 추천해줘
AI:  성별이 어떻게 되세요?
유저: 남성이요
AI:  혹시 선호하는 코디 스타일이 있으신가요? 셔츠나 니트에 슬랙스 조합이 좋으신지...
유저: 그걸 알려주는 게 너의 존재 이유라 생각해
AI:  혹시 선호하는 상의와 하의 스타일이 있으신가요?
→ 유저 이탈, 검색창으로 이동
```

**근본 원인:**

1. `analyzeIntent`의 `clarification_needed` 플래그가 너무 쉽게 `true`로 설정됨
2. `generateRecommendation` 프롬프트에 "필요한 경우 질문 1개" 지시가 있어 LLM이 매번 질문을 붙임
3. 대화 상태를 추적하지 않아 같은 유형의 질문이 반복됨

**해결:**

| 변경 사항 | 내용 |
|---|---|
| `clarification_needed` 기본값 | 항상 `false`. 성별 포함 모든 사전 질문 제거 |
| 후속 질문 규칙 변경 | 추천 **후에** 한 문장 (추천 **전에** 질문 금지) |
| `alreadyAsked` 가드 | 이미 질문했으면 이후 대화에서 다시 묻지 않음 |
| 스타일/코디 질문 완전 차단 | 파이프라인 레벨에서 `isStyleQuestion` 정규식으로 차단 |

---

### 4-2. 올바른 대화 설계 원칙 (정립된 규칙)

**추천 전에 허용되는 것:**
- 없음. 항상 추천이 먼저.

**추천 후에 허용되는 것:**
- "— 어떤 분께 드리실 건가요?" 같이 추천을 더 좁혀줄 수 있는 질문 1개
- 선물 받는 분의 성별, 연령대, 상황 등 구체적인 정보

**절대 금지:**
- "어떤 스타일이 좋으세요?" (추상적 취향 질문)
- "선호하시는 핏이 있나요?" (유저를 생각하게 만드는 질문)
- 2개 이상의 질문 나열
- 같은 유형의 질문 반복

**핵심 철학:**  
유저가 AI에게 추천을 요청했다는 것은, 스스로 생각하는 수고를 덜기 위해서다. 에이전트가 역질문으로 유저를 생각하게 만들면 검색창과 다를 바가 없다.

---

### 4-3. Discovery 플로우 — 스타일을 모르는 유저를 위한 설계

**문제 인식:**  
스타일을 모르는 유저에게 "어떤 스타일이 좋으세요?"라고 물으면 대답할 수 없다. 그렇다고 아무 추천이나 보여주면 맥락이 없다.

**해결 방향:**  
말로 설명하게 하는 대신, **실제 상품 3개를 보여주고 반응을 이끌어낸다**. "이게 좋아요 / 이건 아닌 것 같아요"는 누구나 할 수 있다.

**구현:**

```
유저: "뭘 사야 할지 모르겠어" → intent_type = "discovery"
         ↓
3가지 스타일 버킷 병렬 검색
(미니멀/클린 | 캐주얼/스트릿 | 트렌디/유니크)
         ↓
각 스타일 대표 상품 2개씩 → 최대 6개 팔레트
         ↓
AI가 스타일 레이블과 함께 3개 제시
"마음에 드는 방향이 있으신가요?"
         ↓
유저 반응 → intent_type = "refinement" → 좁혀서 추천
```

---

## 5. 위젯 UI 구현

### 5-1. 구조

위젯은 Shadow DOM으로 쇼핑몰 CSS와 완전 격리된다. 두 가지 UI 영역:

**사이드바 패널:**
- 고정 우측 탭 → 클릭/호버 시 380px 패널 슬라이드인
- 채팅 메시지 영역
- 하단 추천 상품 Shelf (드래그로 높이 조절)
- 하단 입력창 (위쪽 화살표 전송 버튼 입력창 내부 삽입)

**PDP 인라인 패널:**
- 상품 상세 페이지의 장바구니 버튼 아래 자동 삽입
- AI가 생성한 상품 소개 카드 + 질문 칩

### 5-2. 인라인 추천 카드 매칭

AI 메시지를 세그먼트로 파싱해, 상품 언급 직후에 해당 상품 카드를 삽입한다.

```
텍스트 세그먼트 → 카드 → 텍스트 세그먼트 → 카드 → ...
```

초기에는 `PRODUCTS:[1,2,3]` 태그 파싱 방식을 썼으나 텍스트-카드 불일치가 반복되어, 상품명 직접 매칭 방식으로 교체했다.

### 5-3. 페이지 리플로우 (push vs reflow)

**초기 방식 (문제):**  
`body`에 `margin-right: 380px` + `width: calc(100% - 380px)` 적용 → 콘텐츠가 왼쪽으로 밀리는 현상. 카페24 테마의 `min-width` 고정값이 있어 실제로 좁혀지지 않고 왼쪽으로 오버플로우됨.

**개선 방식:**  
`margin-right` 제거, `width: calc(100vw - 380px)` + `min-width: 0` 적용. `html`에도 `overflow-x: hidden` 추가. 카페24 내부 컨테이너(`#wrap`, `.inner` 등)에도 `min-width: 0` 강제 적용.

```css
body.cml-page-shift {
  width: calc(100vw - var(--cml-shift-width, 380px)) !important;
  min-width: 0 !important;
  overflow-x: hidden !important;
}
html.cml-page-shift-active {
  overflow-x: hidden !important;
}
body.cml-page-shift #wrap,
body.cml-page-shift .inner {
  min-width: 0 !important;
  max-width: 100% !important;
}
```

결과: 브라우저 창을 좁힌 것처럼 콘텐츠가 실제로 리플로우됨.

### 5-4. Shelf 드래그 핸들

- `SHELF_MIN = 55px`: 최소 높이. 핸들이 항상 보여야 다시 열 수 있음
- `DRAG_THRESHOLD = 4px`: 클릭과 드래그 구분
- 클릭: 완전히 열림 ↔ 최소 높이 토글
- 드래그: 자유롭게 높이 조절

---

## 6. 카페24 CSS 커스터마이징

### 적용 방법

카페24 스마트디자인 편집기 → `/layout/basic/css/custom.css` 맨 아래에 추가.

### 핵심 선택자 (PRO 브랜드 강조형 테마 기준)

| 요소 | 실제 선택자 |
|---|---|
| 상품 목록 컨테이너 | `ul.prdList` |
| 개별 상품 아이템 | `ul.prdList > li` |
| 썸네일 래퍼 | `ul.prdList li .thumbnail` |
| 이미지 | `ul.prdList li .thumbnail .prdImg img` |
| 상품명 | `ul.prdList li .description a.name` |
| 판매가 | `ul.prdList li ul.spec li.sale_price span` |

**초기 실수:** 테마 문서에 나온 `.prdList__item`, `strong.name.deco_title`, `li.deco_price` 등을 썼으나 실제 DOM엔 없었음. 실제 HTML 소스 확인 후 정확한 선택자로 수정.

### 디자인 토큰

```css
:root {
  --ow-brown:  #5E4637;   /* 브랜드 갈색 */
  --ow-latte:  #F0E4D3;   /* 헤더 라떼 배경 */
  --ow-text:   #111111;
  --ow-sub:    #888888;
  --ow-bg-card: #F7F5F3;
}
```

---

## 7. 향후 발전 방향

### 단기 (프롬프트/로직 레벨)

- [ ] `refinement` 모드에서 이전 추천 상품 목록을 컨텍스트로 전달 (지금은 새 검색)
- [ ] 유저 반응 데이터 (어떤 상품 카드 클릭했는지) 로깅 → 개인화 신호로 활용
- [ ] 상품 데이터에 `gender_target`, `style_bucket` 필드 추가해 임베딩 품질 향상

### 중기 (아키텍처 레벨)

- [ ] **LangGraph 도입**: 현재 선형 2-에이전트 파이프라인을 조건 분기 그래프로 전환
  - `인텐트 분류 → (specific | discovery | refinement | compare | qa)` 라우팅
  - 상품 비교, 가격 필터, 재고 확인 등 Tool Use 추가
- [ ] **대화 상태 영속화**: 세션을 DB에 저장해 유저 재방문 시 이전 취향 기억
- [ ] **Implicit feedback 루프**: 클릭, 장바구니 담기 이벤트를 유저 선호 신호로 수집

### 장기 (Fine-tuning 시점)

파인튜닝은 데이터가 수천 건 이상 쌓인 후 고려한다. 현재 단계에서는 프롬프트 엔지니어링이 투자 대비 효과가 훨씬 크다.

파인튜닝이 의미 있어지는 시점:
- 특정 쇼핑몰의 브랜드 톤이 일반 LLM으로 구현하기 어려울 때
- 특정 상품 카테고리(예: 한복, 골프웨어)에 대한 도메인 지식이 부족할 때
- 추천 품질 개선이 프롬프트 수정만으로 더 이상 나아지지 않을 때

---

## 8. 개발하며 배운 것들

**LLM은 지시를 정확히 따르지 않는다**  
"clarification_needed는 꼭 필요한 경우에만 true"라고 써도 LLM은 true를 리턴한다. 원칙이 아닌 구체적인 예시와 금지 목록으로 명시해야 한다.

**추상적 질문보다 구체적 선택지**  
"어떤 스타일이 좋으세요?"는 나쁜 UX다. "이 세 가지 중 어떤 느낌이 끌리세요?"는 좋은 UX다. AI 에이전트 설계는 UI/UX 설계다.

**상품 카드 매칭은 LLM에 맡기지 말 것**  
LLM이 텍스트에선 A를 추천하면서 태그엔 B를 적는 불일치가 반드시 발생한다. 매칭 로직은 텍스트 파싱으로 코드에서 결정해야 한다.

**API 버전 관리는 모델별로 다르다**  
Gemini 안정 모델은 `v1`, 프리뷰 모델은 `v1beta`. 같은 폴백 체인에 동일한 엔드포인트를 쓰면 404가 난다.

**CSS 선택자는 반드시 실제 DOM으로 확인할 것**  
공식 문서나 테마 설명에 적힌 클래스명이 실제 HTML과 다른 경우가 많다. DevTools 또는 실제 페이지 소스 확인이 필수다.
