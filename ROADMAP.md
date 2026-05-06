# Chameleon — B2B 에이전트 콘솔 개발 로드맵

> **최종 수정**: 2026-05-07
> **작성 목적**: Antigravity · Claude Code 공통 참조 문서
> **가상 고객사 시나리오**: 패션 브랜드 "대시(Dash)" 가 카페24 앱스토어에서 Chameleon을 발견하고,
> 간편로그인 → 무료체험 → 자사 쇼핑몰 도입까지의 여정을 기준으로 작성.

---

## 🧠 사업 핵심 이해

### 문제의식
> "상품 페이지는 왜 모든 사람에게 똑같이 생겼는가"

- PDP(상품 상세 페이지)는 **구매 의도가 가장 높은 순간**이다
- 그러나 2010년이나 지금이나 — 모든 사람에게 **동일한 화면**을 보여준다
- 유저는 "나한테 맞는 건지 모르겠다"는 불확실성에 이탈한다

### 해결책
- **Adaptive PDP**: 상품 페이지 내부(상품명/가격 아래)에 직접 침투, 해당 상품에 특화된 구매전환 질문 버튼을 선제적으로 노출
- **Intent Engine**: 대화가 쌓일수록 유저 프로파일이 정교해지고 → 추천이 개인화되는 데이터 플라이휠 구축

### 젠투와의 차별점
| | 젠투 | Chameleon |
|---|---|---|
| 진입점 | 사이드 패널 플로팅 버튼 (유저가 능동적으로 클릭) | **PDP 내부 침투** (페이지가 먼저 말을 걺) |
| 추천 | 키워드 룰 기반 | **유저 Intent 누적 학습** → 개인화 |
| 개인화 | 없음 | **"나를 아네"** 경험 설계 |
| 장기 가치 | 챗봇 SaaS | **브랜드의 고객 이해 두뇌** |

### Ideal Conclusion
> 유저가 쇼핑몰에 들어갔을 때 에이전트가 "나를 알고 있다"고 느끼는 경험.
> 브랜드 입장에서는 → 가장 강력한 리텐션 도구이자 고객 인사이트 플랫폼.

---

## 📍 전체 여정 Overview

```
카페24 앱스토어 발견
    │
    ▼
앱 설치 + 카페24 OAuth 간편로그인
    │
    ▼
온보딩 페이지 (브랜드 설정 → 스크립트 자동 삽입)
    │
    ▼
웹 기반 에이전트 콘솔 (/console)
  ├─ 에이전트 빌더     (말투 / 가이드라인 / 페르소나)
  ├─ 위젯 외관 설정    (색상 / 로고 / 환영문구 / 칩)
  ├─ Adaptive PDP 설정 (상품 페이지 침투 위젯) ← 핵심 차별점 #1
  ├─ 추천 로직 설계    (키워드-상품 매핑)
  └─ 대시보드          (대화수 / 전환율 / 클릭률)
    │
    ▼
쇼핑몰 상품 페이지에 위젯 Live
    │
    ▼
Intent Engine 고도화 (유저 프로파일 학습 → 개인화) ← 핵심 차별점 #2
```

---

## ✅ Phase 0 — 완료

| 항목 | 상태 |
|---|---|
| 온보딩 페이지 (`/onboarding`) | ✅ |
| 브랜드 색상 / 로고(파일업로드+URL) / 환영문구 / 칩 설정 | ✅ |
| 말풍선 색상 / 테두리 설정 | ✅ |
| 사이드탭 돋보기 컬러 설정 | ✅ |
| 패널 타이틀 제거 (로고만) | ✅ |
| 환영문구 히어로 형식 + 칩 티커 스크롤 | ✅ |
| GNB 제거, 설정 패널 로고 이동 | ✅ |
| `theme_config` DB 저장 (`/api/shop-config`) | ✅ |
| 기본 Widget (`widget.js`) 삽입 | ✅ |
| 미리보기 실시간 반영 (풀사이즈) | ✅ |

---

## 🔧 Phase 1 — 카페24 앱스토어 입점 & 인증 플로우

**목표**: 대시가 카페24 앱스토어에서 Chameleon 설치 → 자동 로그인 → 온보딩 진입

### 1-1. 카페24 OAuth 연동

**플로우**:
```
카페24 앱스토어 "설치" 클릭
    │
    ▼
카페24 OAuth Authorization URL
https://{{mall_id}}.cafe24api.com/api/v2/oauth/authorize
    │
    ▼  (사용자 승인)
GET /auth/cafe24/callback?code=XXX&state=mall_id
    │
    ▼
서버: access_token + refresh_token 교환 → DB 저장
    │
    ▼
/onboarding?mall_id={{mall_id}} 자동 리다이렉트
```

**개발 항목**:
- [ ] 카페24 파트너센터 앱 등록 → `client_id`, `client_secret` 발급
- [ ] `GET /auth/cafe24` — OAuth 시작 엔드포인트 (server.js)
- [ ] `GET /auth/cafe24/callback` — 콜백 처리 + 토큰 저장
- [ ] Supabase `shop_tokens` 테이블 생성
  ```sql
  CREATE TABLE shop_tokens (
    mall_id      TEXT PRIMARY KEY,
    access_token TEXT,
    refresh_token TEXT,
    expires_at   TIMESTAMPTZ,
    scope        TEXT,
    created_at   TIMESTAMPTZ DEFAULT now()
  );
  ```
- [ ] 토큰 자동 갱신 (access_token 만료 시 refresh)

### 1-2. 스크립트 자동 설치 (Scripttag API)

온보딩 "저장하기" 완료 시 자동 삽입:

```js
// POST /api/install-script
POST https://{mallId}.cafe24api.com/api/v2/scripttags
Authorization: Bearer {accessToken}
{
  "scripttag": {
    "event": "onload",
    "src": "https://chameleon-production-7bf7.up.railway.app/widget.js",
    "display_location": "PRODUCT_DETAIL"
  }
}
```

**개발 항목**:
- [ ] 온보딩 저장 후 Scripttag 자동 등록
- [ ] 중복 설치 방지 (기존 scripttag 확인 후 skip/update)
- [ ] 설치 완료 후 `/console?mall_id=` 리다이렉트

### 1-3. 무료체험 플로우

```
온보딩 저장 완료
    │
    ▼
trial 기록 (mall_id, started_at, plan: 'free_trial')
    │
    ▼
/console 접근 시 "D-14 무료체험" 배너 표시
    │
    ▼
만료 시 위젯 비활성화 + 업그레이드 유도
```

**개발 항목**:
- [ ] Supabase `subscriptions` 테이블 (trial / paid 구분)
- [ ] 만료 체크 미들웨어 (widget.js에서 config fetch 시 검증)

---

## 🖥️ Phase 2 — 웹 에이전트 콘솔 MVP

**목표**: 대시가 콘솔에서 에이전트를 자기 브랜드에 맞게 커스터마이징

### 콘솔 구조

```
/console
├── /builder      에이전트 빌더 (말투 / 가이드라인 / 페르소나)
├── /appearance   위젯 외관 설정 (온보딩 설정 이전 + 확장)
├── /pdp          Adaptive PDP 설정          ← Phase 3
├── /recommend    추천 로직 설계             ← Phase 4
├── /dashboard    성과 분석                  ← Phase 5
└── /settings     플랜 / 청구 / 계정
```

### 2-1. 에이전트 빌더 (`/console/builder`)

**기능**:
- [ ] 에이전트 이름 설정 (예: "다이 (Dai)")
- [ ] 말투 선택: 친근체 / 존댓말 / 감성체 / 전문가체
- [ ] 회사 소개 텍스트
- [ ] 가이드라인 작성 (직접 작성 / 파일 업로드)
- [ ] **패션 특화 템플릿** 제공:
  - 사이즈 안내 / 소재·세탁 안내 / 반품·교환 정책 / 스타일링 제안
- [ ] 실시간 대화창 미리보기 (우측 패널)
- [ ] Supabase `agent_guidelines` 테이블 저장

### 2-2. 위젯 외관 (`/console/appearance`)

현재 `/onboarding` 설정 이전 + 확장:
- [ ] 기존 온보딩 설정값 로드
- [ ] 위젯 위치 설정 (우하단 / 좌하단)
- [ ] 플로팅 버튼 모양 선택
- [ ] 모바일 / 데스크탑 미리보기 전환

---

## 📌 Phase 3 — Adaptive PDP (핵심 차별점 #1)

**목표**: 상품 페이지 내부(상품명/가격 아래)에 구매전환 촉진 UI 삽입

### 동작 원리

```
유저가 상품 상세 페이지 진입
    │
    ▼
widget.js: 카페24 상품 페이지 URL 감지
(/product/detail.html?product_no=XXX)
    │
    ▼
/api/pdp-questions?mall_id=&product_no= 호출
→ 상품 정보(카테고리, 소재, 태그) 기반 GPT 질문 생성 (캐싱)
    │
    ▼
상품명 아래 DOM에 질문 버튼 카드 삽입
예) "이 자켓 어떤 체형에 잘 맞아?" / "안에 뭐 입으면 어울려?"
    │
    ▼
버튼 클릭 → 사이드 패널 열림 + 해당 질문 자동 전송
```

### 콘솔 `/pdp` 설정 기능

- [ ] PDP 위젯 ON/OFF 토글
- [ ] 삽입 위치 선택 (상품명 아래 / 가격 아래 / 구매버튼 위)
- [ ] CSS Selector 직접 입력 (고급 옵션)
- [ ] 질문 버튼 개수 설정 (2~4개)
- [ ] 카테고리별 기본 질문 템플릿 설정
- [ ] 가상 PDP 미리보기

### 기술 구현 포인트

```js
// widget.js — AdaptivePDP class
class AdaptivePDP {
  async detect() {
    const productNo = new URLSearchParams(location.search).get('product_no');
    if (!productNo) return;
    const questions = await this.fetchQuestions(productNo);
    this.inject(questions);
  }
  async fetchQuestions(productNo) {
    // GET /api/pdp-questions?mall_id=xxx&product_no=xxx
    // 서버: 상품 정보 fetch → GPT 질문 생성 → 캐싱 반환
  }
  inject(questions) {
    const target = document.querySelector(this.config.pdpSelector);
    target.insertAdjacentElement('afterend', this.renderCard(questions));
  }
}
```

**API 개발 항목**:
- [ ] `GET /api/pdp-questions` — 질문 생성 (카페24 상품 API + GPT + 캐싱)
- [ ] `POST /api/pdp-click` — 클릭 이벤트 기록

---

## 🧬 Phase 4 — Intent Engine (핵심 차별점 #2)

**목표**: 대화가 쌓일수록 "나를 아네"라고 느끼게 하는 개인화 추천 엔진

### 유저 Intent 수집 흐름

```
대화 1회: "린넨 소재 찾아요"
    → intent_tags: ['소재:린넨', '계절:여름']

대화 누적 →
    user_profile: {
      style: 'minimalist',
      fit: ['slim', 'regular'],
      color_pref: ['black', 'navy'],
      material_pref: ['linen', 'cotton'],
      price_range: '50000~100000'
    }
```

### DB 스키마

```sql
CREATE TABLE user_sessions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mall_id       TEXT NOT NULL,
  session_id    TEXT NOT NULL,         -- 익명 유저 식별자
  intent_tags   JSONB DEFAULT '[]',    -- 누적 인텐트 태그
  profile       JSONB DEFAULT '{}',    -- 학습된 프로파일
  message_count INT DEFAULT 0,
  last_active   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ DEFAULT now()
);
```

### 콘솔 `/recommend` 설정

- [ ] 키워드-상품 매핑 룰 작성 (예: "린넨" → 린넨 카테고리 우선)
- [ ] 카페24 상품 자동 인덱싱 (주기적 동기화)
- [ ] 추천 로직 테스트 (질문 입력 → 예상 추천 상품 미리보기)

### 추천 엔진 로직

```
유저 메시지: "여름에 입기 좋은 슬랙스 추천해줘"
    ├─ 1단계: 키워드 추출 (여름, 슬랙스)
    ├─ 2단계: 유저 프로파일 참조 (선호 색상, 핏)
    ├─ 3단계: 상품 DB 매칭 (카테고리 + 태그 + 재고 여부)
    └─ 4단계: 랭킹 스코어링 → Top 3 추천
```

### 개인화 인트로 메시지 (대화 5회 이상)

> *"지난번에 린넨 소재 좋아하신다고 하셨죠? 이번 여름 신상 린넨 팬츠 들어왔어요 👀"*

---

## 📊 Phase 5 — 대시보드 & 분석

**목표**: 대시의 마케터가 성과를 확인하고 ROI를 판단

### 핵심 지표

| 지표 | 설명 |
|---|---|
| 위젯 노출수 | 상품 페이지 방문 중 위젯 노출 횟수 |
| 대화 시작률 | 노출 대비 첫 메시지 전송 비율 |
| PDP 버튼 클릭률 | Adaptive PDP 질문 버튼 클릭률 |
| 추천 클릭률 | 추천 상품 클릭 비율 |
| 전환 기여 | 위젯 대화 후 24시간 내 구매 |
| 평균 대화 길이 | 세션당 주고받은 메시지 수 |

---

## 💳 Phase 6 — 플랜 & 청구 (수익화)

### 플랜 구조

| 플랜 | 가격 | 대화 수 | 핵심 기능 |
|---|---|---|---|
| Free Trial | 무료 14일 | 500회 | 기본 위젯 + 온보딩 |
| Starter | ₩29,000/월 | 2,000회 | + 에이전트 빌더 |
| Growth | ₩79,000/월 | 10,000회 | + Adaptive PDP + 대시보드 |
| Pro | ₩199,000/월 | 무제한 | + Intent Engine + API |

---

## 🗓️ 타임라인

```
Week  1~2   Phase 1   카페24 OAuth + Scripttag 자동설치
Week  3~4   Phase 2   콘솔 MVP (에이전트 빌더 + 외관 설정)
Week  5~6   Phase 3   Adaptive PDP (PDP 위젯 + 질문 생성)
Week  7~8   Phase 4   Intent Engine v1 (태그 수집 + 키워드 추천)
Week  9     Phase 5   대시보드 기본 지표
Week  10    Phase 6   플랜 & 결제 (토스페이먼츠)
```

---

## 🚀 Next Actions (지금 당장)

1. **카페24 파트너센터 앱 등록** → `client_id` / `client_secret` 발급
2. **`GET /auth/cafe24`** OAuth 시작 엔드포인트 구현 (server.js)
3. **`GET /auth/cafe24/callback`** 콜백 + 토큰 저장 구현
4. **`/console` 라우팅** 기본 뼈대 (`public/console.html`) 생성
5. **대시 계정 E2E 테스트**
   - 카페24 앱 설치 시뮬레이션 → 온보딩 → 스크립트 설치 → 상품 페이지 위젯 확인

---

## 📁 프로젝트 주요 파일 구조

```
chameleon/
├── ROADMAP.md              ← 이 문서 (공통 참조)
├── server.js               ← Express 서버 (API + OAuth)
├── public/
│   ├── onboarding.html     ← 브랜드 온보딩 설정 페이지 ✅
│   ├── console.html        ← 에이전트 콘솔 메인 (예정)
│   └── widget.js           ← 쇼핑몰에 삽입되는 위젯
├── services/               ← 서비스 레이어
└── supabase/               ← DB 스키마 및 마이그레이션
```
