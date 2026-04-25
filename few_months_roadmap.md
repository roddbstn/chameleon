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
