-- ============================================================
-- Migration 05: 구독·청구 및 일별 사용량 스키마
-- 고객사 구독 플랜, 인보이스, 일별 사용 집계
-- Depends: Migration 01 (store_tokens)
-- ============================================================

-- ────────────────────────────────────────────
-- 5-1. subscriptions: 고객사 구독 플랜
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS subscriptions (
  id             BIGSERIAL    PRIMARY KEY,
  store_id       TEXT         NOT NULL UNIQUE REFERENCES store_tokens(store_id) ON DELETE CASCADE,
  plan           TEXT         NOT NULL DEFAULT 'trial'
                              CHECK (plan IN ('trial', 'starter', 'growth', 'enterprise')),
  status         TEXT         NOT NULL DEFAULT 'active'
                              CHECK (status IN ('active', 'paused', 'cancelled', 'expired')),
  -- 플랜 한도
  monthly_req_limit   INTEGER  DEFAULT 1000,    -- 월간 API 요청 한도
  -- 청구
  billing_cycle       TEXT     DEFAULT 'monthly' CHECK (billing_cycle IN ('monthly', 'annual')),
  current_period_start TIMESTAMPTZ DEFAULT now(),
  current_period_end   TIMESTAMPTZ DEFAULT (now() + interval '1 month'),
  -- 메타
  created_at     TIMESTAMPTZ  DEFAULT now(),
  updated_at     TIMESTAMPTZ  DEFAULT now()
);

COMMENT ON TABLE  subscriptions                  IS '고객사 구독 플랜 관리';
COMMENT ON COLUMN subscriptions.plan             IS 'trial | starter | growth | enterprise';
COMMENT ON COLUMN subscriptions.monthly_req_limit IS '월간 API 요청 허용 횟수 (요금제 한도)';

-- ────────────────────────────────────────────
-- 5-2. daily_usage: 일별 사용량 집계
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS daily_usage (
  id              BIGSERIAL    PRIMARY KEY,
  store_id        TEXT         NOT NULL,
  date            DATE         NOT NULL,          -- YYYY-MM-DD
  -- 세션 / 이벤트
  total_sessions  INTEGER      DEFAULT 0,
  total_events    INTEGER      DEFAULT 0,
  -- AI 요청
  intent_calls    INTEGER      DEFAULT 0,         -- /api/recommend 호출 수
  embedding_calls INTEGER      DEFAULT 0,         -- 임베딩 생성 수
  ask_calls       INTEGER      DEFAULT 0,         -- /api/ask 호출 수
  chips_calls     INTEGER      DEFAULT 0,         -- /api/chips 호출 수
  -- 전환
  cart_adds       INTEGER      DEFAULT 0,
  purchases       INTEGER      DEFAULT 0,
  -- 원가
  total_cost_usd  NUMERIC(10,4) DEFAULT 0,

  UNIQUE (store_id, date)
);

CREATE INDEX IF NOT EXISTS idx_daily_usage_store ON daily_usage (store_id, date DESC);

COMMENT ON TABLE daily_usage IS '고객사별 일별 사용량 집계 (청구·대시보드용)';

-- ────────────────────────────────────────────
-- 5-3. invoices: 월간 인보이스
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS invoices (
  id             BIGSERIAL    PRIMARY KEY,
  store_id       TEXT         NOT NULL,
  period_start   DATE         NOT NULL,
  period_end     DATE         NOT NULL,
  -- 청구 내역
  plan           TEXT         NOT NULL,
  base_fee_krw   INTEGER      DEFAULT 0,          -- 기본 구독료 (원)
  usage_fee_krw  INTEGER      DEFAULT 0,          -- 초과 사용 요금 (원)
  total_krw      INTEGER      DEFAULT 0,          -- 합계
  -- API 원가 (내부)
  api_cost_usd   NUMERIC(10,4) DEFAULT 0,
  -- 상태
  status         TEXT         DEFAULT 'pending'
                              CHECK (status IN ('pending', 'paid', 'overdue')),
  created_at     TIMESTAMPTZ  DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_invoices_store ON invoices (store_id, period_start DESC);

COMMENT ON TABLE invoices              IS '월간 인보이스 (청구 기록)';
COMMENT ON COLUMN invoices.base_fee_krw IS '플랜 고정 구독료';
COMMENT ON COLUMN invoices.usage_fee_krw IS '한도 초과분 추가 요금';
COMMENT ON COLUMN invoices.api_cost_usd IS '해당 기간 Gemini API 원가 (내부 마진 계산용)';
