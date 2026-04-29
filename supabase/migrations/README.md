# Chameleon — Supabase 마이그레이션

## 파일 구조

```
supabase/migrations/
  01_store_tokens.sql              # 카페24 OAuth 토큰
  02_products_and_embeddings.sql   # 상품 + pgvector 임베딩
  03_user_sessions_and_events.sql  # 세션 + 행동 이벤트
  04_ai_conversations_and_costs.sql # 대화 히스토리 + API 원가
  05_subscriptions_and_billing.sql  # 구독 + 청구
  run_all.sql                       # 전체 한번에 실행
```

## 테이블 의존성

```
store_tokens (01)
    ├── products           (02)
    │     └── product_embeddings (02)
    ├── user_sessions      (03)
    │     ├── behavior_events    (03)
    │     ├── conversations      (04)
    │     └── recommendation_logs (04)
    ├── api_cost_logs      (04)
    └── subscriptions      (05)
          ├── daily_usage  (05)
          └── invoices     (05)
```

## 새 환경에서 세팅하는 법

### 방법 A: Supabase SQL Editor에서 (가장 쉬움)
각 파일을 **번호 순서대로** 복붙해서 실행.

### 방법 B: psql로 한번에 실행
```bash
psql "$DATABASE_URL" -f supabase/migrations/run_all.sql
```

### 방법 C: Supabase CLI (권장, 추후)
```bash
supabase db push
```

## 주의사항
- `02_products_and_embeddings.sql`은 `CREATE EXTENSION IF NOT EXISTS vector` 포함
- Supabase에서 pgvector는 기본 활성화되어 있음
- `run_all.sql`의 `\i` 명령은 psql에서만 동작 (SQL Editor 불가)
