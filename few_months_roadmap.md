# Chameleon AI 추천 엔진 — 개발 로드맵

## 전체 구조

```
[카페24 상품 DB] → [수집/임베딩] → [Vector DB]
                                ↕
[유저 대화] → [Intent 분석] → [검색/랭킹] → [LLM 생성] → [추천 결과]
                  ↕
            [유저 프로파일]
```

---

## Phase 0 — 환경 세팅

**목표**: 개발 인프라 확정

### 스택 결정

| 역할 | 선택 | 이유 |
|---|---|---|
| Vector DB | Supabase (pgvector) | 무료, PostgreSQL 기반, 관계형 DB도 같이 씀 |
| Embedding | Gemini text-embedding-004 | 무료, 한국어 성능 좋음 |
| LLM | Gemini 2.0 Flash | 이미 세팅됨, 무료 |
| 상품 수집 | Cafe24 REST API | 이미 access token 있음 |
| 서버 | Node.js (현재) | 유지 |
| 스키마 관리 | Supabase Dashboard | SQL 직접 작성 |

### 할 일

```bash
# Supabase 프로젝트 생성
# supabase.com → New project → 무료 플랜

npm install @supabase/supabase-js
```

`.env` 추가:
```
SUPABASE_URL=https://xxx.supabase.co
SUPABASE_SERVICE_KEY=eyJ...
```

---

## Phase 1 — 상품 DB 수집 파이프라인 (Week 1~2)

**목표**: 카페24 상품 전체를 Vector DB에 적재

### 1-1. Supabase 테이블 설계

```sql
-- 상품 테이블
create table products (
  id          bigserial primary key,
  mall_id     text not null,
  product_no  text not null,
  name        text,
  description text,
  price       integer,
  category    text,
  tags        text[],
  image_url   text,
  raw_data    jsonb,
  updated_at  timestamptz default now(),
  unique(mall_id, product_no)
);

-- 임베딩 테이블
create extension if not exists vector;

create table product_embeddings (
  id          bigserial primary key,
  mall_id     text not null,
  product_no  text not null,
  content     text,
  embedding   vector(768),
  unique(mall_id, product_no)
);

-- 벡터 검색 인덱스
create index on product_embeddings
  using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);
```

### 1-2. 수집 API

```
GET /admin/sync/:mallId   → 해당 몰 전체 상품 수집 시작
GET /admin/sync-status    → 진행 상황 확인
```

수집 로직:
```
카페24 GET /api/v2/admin/products (페이지네이션)
  → 상품별 name + description + category + tags 조합
  → 임베딩용 텍스트 생성
  → Gemini embedding API 호출
  → Supabase에 upsert
```

### 1-3. 임베딩용 텍스트 포맷 (핵심)

```
상품명: 테리 와이드 팬츠
카테고리: 하의 > 팬츠
가격: 89,000원
설명: 일본산 테리 원단, 밴딩 허리, 루즈 와이드 핏
태그: 캐주얼, 세미포멀, 남여공용, 봄여름
```

### 1-4. 증분 업데이트

```
카페24 GET /api/v2/admin/products?updated_start_date=어제
  → 변경분만 re-embed (매일 새벽 실행)
```

---

## Phase 2 — 유저 Intent 분석 (Week 3)

**목표**: 유저 대화에서 5가지 핵심 정보 추출

### 추출 구조

```javascript
// 유저: "남자친구 생일 선물인데 캐주얼하게 입을 수 있는 거 추천해줘"
{
  situation:   "선물",
  recipient:   "남자친구",
  occasion:    "생일",
  style:       ["캐주얼"],
  constraints: [],
  implicit:    ["남성용", "실용적"]
}
```

### 구현 — LLM 구조화 출력

```javascript
const intentPrompt = `
다음 고객 메시지에서 구매 의도를 분석해 JSON으로 반환하세요.

고객 메시지: "${userMessage}"
대화 히스토리: ${JSON.stringify(history.slice(-4))}

반환 형식:
{
  "situation": "선물|자기구매|기타",
  "recipient": "본인|남자친구|여자친구|부모님|...",
  "occasion": "생일|기념일|일상|출근|데이트|...",
  "style": ["캐주얼", "포멀", ...],
  "priceRange": { "min": null, "max": null },
  "constraints": ["색상:검정", "사이즈:M", ...],
  "searchQuery": "벡터 검색에 쓸 핵심 쿼리 문장"
}
`;
```

`searchQuery` 필드가 핵심 — LLM이 검색에 최적화된 쿼리를 직접 생성.

---

## Phase 3 — 검색 + 랭킹 엔진 (Week 4~5)

**목표**: intent → 정확한 상품 추출

### 3-1. Hybrid Search

```
① Semantic Search (벡터)
   "캐주얼하게 입을 수 있는 남성 하의"
   → embedding → pgvector cosine similarity
   → 상위 20개 후보

② Keyword Filter (SQL)
   WHERE price <= 100000
   AND tags @> ARRAY['남성']
   AND category LIKE '하의%'

③ 교집합 후 Re-rank → 최종 상위 3~5개
```

### 3-2. Supabase 검색 함수

```sql
create or replace function search_products(
  p_mall_id    text,
  p_embedding  vector(768),
  p_max_price  integer default null,
  p_tags       text[]  default null,
  p_limit      int     default 5
)
returns table (
  product_no text,
  name       text,
  price      integer,
  similarity float
)
language sql as $$
  select
    p.product_no, p.name, p.price,
    1 - (e.embedding <=> p_embedding) as similarity
  from product_embeddings e
  join products p using (mall_id, product_no)
  where e.mall_id = p_mall_id
    and (p_max_price is null or p.price <= p_max_price)
    and (p_tags is null or p.tags && p_tags)
  order by similarity desc
  limit p_limit;
$$;
```

### 3-3. Re-ranking

```
벡터 검색 후보 5개 → LLM에 "이 중 이 상황에 가장 맞는 건?"
→ 순위 재조정 + 추천 이유 생성
```

---

## Phase 4 — 유저 프로파일링 (Week 6)

**목표**: 대화가 쌓일수록 더 정확해지는 개인화

### 테이블

```sql
create table user_profiles (
  id           bigserial primary key,
  mall_id      text,
  session_id   text,
  inferred     jsonb,
  history      jsonb[],
  updated_at   timestamptz default now()
);
```

### 프로파일 구조

```javascript
{
  gender:     "남성",
  ageGroup:   "20대",
  styles:     ["캐주얼", "스트릿"],
  priceRange: "5~10만원",
  pastLikes:  ["product_no:17", "product_no:23"],
  occasions:  ["선물", "데이트"]
}
```

대화 턴마다 LLM이 새로운 정보 있으면 프로파일 업데이트.

---

## Phase 5 — 응답 생성 (Week 7~8)

**목표**: 검색 결과 → 자연스러운 추천 멘트

### 최종 LLM 프롬프트 구조

```javascript
`
당신은 ${mallId} 쇼핑몰의 전문 스타일리스트입니다.

[고객 정보]
${JSON.stringify(userProfile)}

[고객 질문]
${userMessage}

[검색된 상품 후보]
${JSON.stringify(candidateProducts)}

위 상품 중 이 고객에게 가장 적합한 1~2개를 추천하고,
왜 이 고객에게 맞는지 2문장으로 설명하세요.
응답은 JSON으로:
{
  "recommendations": [
    {
      "product_no": "17",
      "reason": "남자친구 생일 선물로 무난한 블랙 컬러에..."
    }
  ],
  "followUp": "사이즈는 어떻게 되시나요?"
}
`
```

---

## 전체 타임라인

| 기간 | Phase | 목표 |
|---|---|---|
| Week 1~2 | Phase 0 + 1 | Supabase 세팅 + 상품 수집 파이프라인 |
| Week 3 | Phase 2 | Intent 분석 (JSON 구조화 출력) |
| Week 4~5 | Phase 3 | Vector 검색 + Hybrid re-ranking |
| Week 6 | Phase 4 | 유저 프로파일 축적 |
| Week 7~8 | Phase 5 | 응답 생성 + UI 통합 |
| Week 9~10 | 테스트 | 실제 브랜드 상품 DB로 정확도 검증 |

---

## 다음 스텝

1. `supabase.com` → New project 생성 (무료)
2. Project URL + service_role key 확보
3. Phase 1 상품 수집 파이프라인 개발 시작



(질문)
근데 데이터베이스를 미리 고정시켜놓고 가도 돼? 사이트마다 상품을 분류하는
데이터베이스 구조나, 상품 특성을 표기하는 방식, 카테고리, 상품 종류, 다 다른데
어떻게 하나하나 다 대응하지?

⏺ 핵심을 찌른 거야. 좋은 질문인데 사실 두 가지 이유로 생각보다 문제가 작아.

  ---
  이유 1 — 카페24 API는 이미 스키마가 통일되어 있어

  모든 카페24 스토어는 같은 REST API를 씀. 어느 브랜드든 상품 조회하면 항상 같은
  구조로 옴:

  {
    "product_no": 17,
    "product_name": "테리 와이드 팬츠",
    "price": "89000",
    "description": "...",
    "category_no": 24,
    "detail_image": "..."
  }

  DB 스키마를 브랜드마다 다르게 짤 필요가 없어. 카페24가 이미 표준화해줌.

  ---
  이유 2 — Vector Embedding은 스키마를 안 봐

  진짜 핵심은 여기야.

  RDB 방식이었으면 네 말이 맞음:
  -- A 브랜드: "소재" 컬럼
  -- B 브랜드: "원단" 컬럼
  -- C 브랜드: 아예 없음
  -- → 다 따로 대응해야 함 ❌

  하지만 우리 방식은:
  A 브랜드 상품 → 텍스트로 변환 → 임베딩 → 벡터 공간에 점 하나
  B 브랜드 상품 → 텍스트로 변환 → 임베딩 → 벡터 공간에 점 하나

  "린넨 소재" = "리넨 원단" = "linen fabric"
  → 벡터 공간에서 거의 같은 위치 ✅

  의미가 같으면 표기 방식이 달라도 가까이 뭉침.

  ---
  남는 문제 — description 내용이 지저분한 경우

  실제로 브랜드마다 description 품질이 천차만별이야:

  A 브랜드: "일본산 테리 원단, 루즈 와이드핏, 밴딩 허리"  ← 깔끔
  B 브랜드: "<p style='color:red'>★신상★</p><br>감성적인..." ← HTML 떡칠
  C 브랜드: "상품 문의는 DM으로"  ← 정보 없음

  이건 LLM 정규화 레이어로 해결:

  카페24 원본 데이터 (어떤 형태든)
          ↓
    LLM에 던짐: "이 상품 정보를 읽고 아래 형식으로 정리해줘"
          ↓
    {
      "소재": "일본산 테리",
      "핏": "루즈 와이드",
      "스타일": ["캐주얼", "세미포멀"],
      "계절": ["봄", "여름"],
      "성별": "남여공용"
    }
          ↓
    이 정규화된 텍스트를 임베딩

  어떤 브랜드의 어떤 형식이든 LLM이 읽고 통일된 포맷으로 변환. LLM이 어댑터 역할.

  ---
  정리

  ┌───────────────────────────────┬───────────────────────────────────────────┐
  │             문제               │                 해결 방법                 │
  ├───────────────────────────────┼───────────────────────────────────────────┤
  │ 브랜드마다 API 응답 구조 다름       │ 카페24 API가 이미 통일                    │
  ├───────────────────────────────┼───────────────────────────────────────────┤
  │ 카테고리명, 태그 표기 방식          │ 벡터 임베딩이 의미 기준으로 처리          │
  │ 다름                           │                                           │
  ├───────────────────────────────┼───────────────────────────────────────────┤
  │ description 형식 지저분함        │ LLM 정규화 레이어                         │
  ├───────────────────────────────┼───────────────────────────────────────────┤
  │ 아예 정보가 없는 상품              │ 이미지 → Vision 모델로 설명 추출 (나중  단계)   |
  │                               │                                      │
  └───────────────────────────────┴───────────────────────────────────────────┘

  DB 스키마는 고정해도 됨. 변하는 건 스키마가 아니라 임베딩 전 전처리 파이프라인 하나야.



(질문)
https://solidhomme.com/product/detail.html?product_no=5534&cate_no=47&display_g
roup=1

https://solidhomme.com/product/detail.html?product_no=5533&cate_no=47&display_gro
up=1

그러면 솔리드옴므에 올라온 사이트에 해당 2가지 상품만 올라와 있다고 가정해놓고,
한번 시나리오대로 구현 계획을 말해봐. 지금 구현하진 말고.

(answer)

⏺ 페이지 내용 먼저 확인하고 구체적인 시나리오 짤게.

⏺ Fetch(https://solidhomme.com/product/detail.html?product_no=5534&cate_no=47&disp
       lay_group=1)
  ⎿  Received 204.8KB (200 OK)

⏺ Fetch(https://solidhomme.com/product/detail.html?product_no=5533&cate_no=47&disp
       lay_group=1)
  ⎿  Received 199.8KB (200 OK)

⏺ 확인했어. 두 상품 정리:

  - 5534: 아이보리 니트 카라넥 숏슬리브 셔츠 — ₩398,000 / 일본 원단 / 린넨56%+코튼38%
  - 5533: 베이지 오버사이즈 체크 셔츠 — ₩698,000 / 이탈리안 원단 / 루즈핏

  이걸 기준으로 전체 시나리오 설명할게.

  ---
 실제 데이터 정리

  5534 — 아이보리 니트 카라넥 숏슬리브 셔츠 / ₩398,000

  ┌────────┬──────┬────────────┬────────┬────────┐
  │ 사이즈 │ 어깨 │ 가슴(반신) │  소매  │  기장  │
  ├────────┼──────┼────────────┼────────┼────────┤
  │ 46     │ 49cm │ 60.5cm     │ 24.5cm │ 71.5cm │
  ├────────┼──────┼────────────┼────────┼────────┤
  │ 48     │ 51cm │ 63cm       │ 25.5cm │ 73.5cm │
  ├────────┼──────┼────────────┼────────┼────────┤
  │ 50     │ 53cm │ 65.5cm     │ 26.5cm │ 75.5cm │
  ├────────┼──────┼────────────┼────────┼────────┤
  │ 52     │ 55cm │ 68cm       │ 27.5cm │ 77.5cm │
  └────────┴──────┴────────────┴────────┴────────┘

  5533 — 베이지 오버사이즈 체크 셔츠 / ₩698,000

  ┌────────┬──────┬────────────┬────────┬──────┐
  │ 사이즈 │ 어깨 │ 가슴(반신) │  소매  │ 기장 │
  ├────────┼──────┼────────────┼────────┼──────┤
  │ 46     │ 54cm │ 65.5cm     │ 61.7cm │ 77cm │
  ├────────┼──────┼────────────┼────────┼──────┤
  │ 48     │ 56cm │ 68cm       │ 63cm   │ 79cm │
  ├────────┼──────┼────────────┼────────┼──────┤
  │ 50     │ 58cm │ 70.5cm     │ 64.3cm │ 81cm │
  ├────────┼──────┼────────────┼────────┼──────┤
  │ 52     │ 60cm │ 73cm       │ 65.6cm │ 83cm │
  └────────┴──────┴────────────┴────────┴──────┘

  ---
  Step 1. 데이터 수집

  두 소스를 병행:

  ① 카페24 API
     → 상품명, 가격, 소재, 색상 옵션, 재고 현황

  ② HTML 스크래핑
     → 사이즈 테이블 (팝업 내 숨겨진 HTML)
     → 배송/교환/반품 안내
     → 혜택 정보

  이 둘을 합쳐서 하나의 raw 데이터로 만듦.

  ---
  Step 2. 수치 기반 LLM 정규화

  핵심 원칙: 라벨을 먼저 붙이지 않는다. 수치가 라벨을 증명한다.

  5534에 대해 LLM이 받는 입력:
  소매 24.5cm → 숏슬리브
  가슴 반신 60.5cm → 전체 121cm → 한국 성인 남성 평균(92cm) 대비 +29cm 여유
  어깨 49cm → 보통
  기장 71.5cm → 보통 기장
  소재: 린넨 56% + 일본 원단
  디자인: 니트 카라넥, 플라켓 디테일

  LLM 출력:
  {
    "sleeve_type": "숏슬리브",
    "fit": "세미오버 (여유 +29cm)",
    "length": "보통",
    "breathability": "높음 (린넨 56%)",
    "thickness": "얇음",
    "season": ["봄", "여름"],
    "color": ["아이보리", "블랙"],
    "style_derived": ["미니멀", "세미캐주얼", "여름 포인트룩"],
    "NOT": ["오버사이즈", "긴팔", "겨울용"]
  }

  5533에 대해:
  소매 61.7cm → 긴팔 확정
  가슴 반신 65.5cm → 전체 131cm → 평균 대비 +39cm 여유
  어깨 54cm → 넓음
  기장 77cm → 긴 기장
  소재: 린넨 56% + 이탈리안 원단
  디자인: 체크 패턴

  LLM 출력:
  {
    "sleeve_type": "긴팔",
    "fit": "오버사이즈 (여유 +39cm)",
    "length": "롱",
    "breathability": "중간 (린넨이지만 긴팔)",
    "thickness": "얇음",
    "season": ["봄", "가을"],
    "color": ["베이지"],
    "style_derived": ["오버사이즈 캐주얼", "체크 스트릿", "루즈핏"],
    "NOT": ["숏슬리브", "슬림핏", "여름 단독착용"]
  }

  NOT 필드가 중요해 — 검색 오매칭 방지용.

  ---
  Step 3. 임베딩용 텍스트 생성

  수치 + 도출된 라벨을 합쳐서 하나의 문장으로:

  # 5534
  "숏슬리브 셔츠. 린넨 56% 일본 원단, 얇고 통풍 좋음. 봄여름용.
   세미오버핏 (가슴 여유 29cm). 보통 기장 71cm. 아이보리/블랙.
   니트 카라넥 포인트. 미니멀 세미캐주얼 스타일. 398,000원.
   가슴 반신 60.5~68cm, 어깨 49~55cm."

  # 5533
  "긴팔 오버사이즈 셔츠. 린넨 56% 이탈리안 원단. 봄가을용.
   오버사이즈핏 (가슴 여유 39cm). 롱 기장 77cm. 베이지 체크 패턴.
   루즈 스트릿 캐주얼 스타일. 698,000원.
   가슴 반신 65.5~73cm, 어깨 54~60cm."

  → Gemini text-embedding-004로 각각 768차원 벡터로 변환
  → Supabase에 저장

  ---
  Step 4. 유저 시나리오 3가지

  시나리오 A — "더운 날 시원하게 입을 셔츠 찾아요"

  Intent 추출:
    season: "여름"
    priority: "통풍"

  벡터 검색:
    5534 유사도 0.93 ← 숏슬리브 + 린넨 + 봄여름
    5533 유사도 0.61 ← 긴팔이라 여름 단독착용 부적합 (NOT 필드 반영)

  응답:
    "숏슬리브에 린넨 56% 일본 원단이라 여름에 가장 적합해요.
     통풍이 잘 되는 소재예요. 사이즈는 어떻게 되시나요?"

  시나리오 B — "남자친구 생일 선물인데 평소 오버사이즈 좋아해요"

  Intent 추출:
    situation: "선물"
    style: ["오버사이즈"]
    recipient: "남자친구"

  벡터 검색:
    5533 유사도 0.95 ← 오버사이즈 +39cm, 체크 캐주얼
    5534 유사도 0.58 ← 세미오버 +29cm, 오버사이즈 아님

  응답:
    "베이지 체크 패턴에 가슴 여유가 39cm라 확실한 오버사이즈예요.
     남자친구 분 평소 사이즈가 어떻게 되세요?
     사이즈 맞춰서 추천해드릴게요."

  유저: "보통 M이요, 키는 180cm"
  → 키 180cm, M 사이즈 기준 추정 가슴둘레 ~95cm
  → 5533 사이즈 46 가슴 전체 131cm → 여유 +36cm → 오버사이즈 연출 가능
  → 단, 어깨 54cm로 넓으므로 핏 확인 권장

  응답:
    "46 사이즈 추천드려요. 가슴 여유가 넉넉하게 나오고
     키 180cm에 기장 77cm로 적당해요.
     어깨가 54cm로 넓게 나오는 게 이 상품 특징이에요."

  시나리오 C — "둘 다 린넨인데 어떻게 달라요?"

  → 벡터 검색 없이 두 상품 직접 비교 모드

  응답:
    "소재 비율은 같지만 원단 산지가 달라요.
     5534는 일본 원단 숏슬리브라 여름 전용이고,
     5533은 이탈리안 원단 긴팔이라 봄가을에 더 맞아요.
     핏 차이도 커요 — 5534는 여유 29cm 세미오버,
     5533은 여유 39cm 오버사이즈예요."

  ---
  핵심 차이 — 이전 계획 대비

  ┌───────────────┬────────────────┬─────────────────────────┐
  │               │   이전 계획      │ 개선된 계획       │
  ├───────────────┼────────────────┼─────────────────────────┤
  │ 스타일 라벨      │ LLM이 추측       │ 수치에서 도출           │
  ├───────────────┼────────────────┼─────────────────────────┤
  │ 사이즈 데이터    │ 없음             │ 4개 사이즈 × 4개 측정값 │
  ├───────────────┼────────────────┼─────────────────────────┤
  │ 사이즈 추천      │ 불가            │ 유저 체형 기반 매칭     │
  ├───────────────┼────────────────┼─────────────────────────┤
  │ 오매칭 방지      │ 없음            │ NOT 필드로 차단         │
  ├───────────────┼────────────────┼─────────────────────────┤
  │ 계절 판단       │ 태그 기반 추측     │ 소매 길이 + 소재로 도출 │
  └───────────────┴────────────────┴─────────────────────────┘

  이 구조 기반으로 구현 시작할까?