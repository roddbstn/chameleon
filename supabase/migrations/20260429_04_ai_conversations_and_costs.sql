-- ============================================================
-- Migration 04: AI 대화·추천·원가 추적 스키마
-- 채팅 대화 히스토리, 추천 로그, 전환 추적
-- Depends: Migration 02 (products), Migration 03 (user_sessions)
-- ============================================================

-- ────────────────────────────────────────────
-- 4-1. conversations: AI 대화 히스토리
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS conversations (
  id           BIGSERIAL    PRIMARY KEY,
  session_id   TEXT         NOT NULL REFERENCES user_sessions(session_id) ON DELETE CASCADE,
  store_id     TEXT         NOT NULL,
  role         TEXT         NOT NULL CHECK (role IN ('user', 'assistant')),
  content      TEXT         NOT NULL,            -- 대화 메시지 텍스트
  -- 의도 분석 결과 (assistant 턴에만 저장)
  intent_data  JSONB        DEFAULT '{}',        -- situation, style, constraints, searchQuery 등
  created_at   TIMESTAMPTZ  DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_conversations_session ON conversations (session_id, created_at);
CREATE INDEX IF NOT EXISTS idx_conversations_store   ON conversations (store_id, created_at DESC);

COMMENT ON TABLE  conversations            IS 'AI 채팅 대화 히스토리';
COMMENT ON COLUMN conversations.intent_data IS 'Understanding Agent 구조화 출력 (JSON)';

-- ────────────────────────────────────────────
-- 4-2. recommendation_logs: 추천 이력 + 성과 추적
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS recommendation_logs (
  id               BIGSERIAL    PRIMARY KEY,
  session_id       TEXT         NOT NULL REFERENCES user_sessions(session_id) ON DELETE CASCADE,
  store_id         TEXT         NOT NULL,
  query            TEXT,                         -- 검색에 사용된 쿼리
  recommended_ids  TEXT[]       DEFAULT '{}',    -- 추천된 product_id 배열
  clicked_id       TEXT,                         -- 클릭된 product_id
  purchased_id     TEXT,                         -- 구매된 product_id
  -- 응답 품질 메타
  retrieval_score  NUMERIC(5,4),                 -- 최상위 cosine 유사도 점수
  llm_model        TEXT         DEFAULT 'gemini-2.5-flash',
  latency_ms       INTEGER,                      -- 전체 응답 소요 시간
  created_at       TIMESTAMPTZ  DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_rec_logs_session   ON recommendation_logs (session_id);
CREATE INDEX IF NOT EXISTS idx_rec_logs_store     ON recommendation_logs (store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_rec_logs_purchased ON recommendation_logs (store_id, purchased_id)
  WHERE purchased_id IS NOT NULL;

COMMENT ON TABLE  recommendation_logs               IS '추천 로그 및 구매 전환 추적';
COMMENT ON COLUMN recommendation_logs.recommended_ids IS 'Hybrid Search 최종 추천 상품 ID 배열';
COMMENT ON COLUMN recommendation_logs.retrieval_score IS '벡터 검색 최상위 cosine 유사도';

-- ────────────────────────────────────────────
-- 4-3. api_cost_logs: LLM API 원가 추적
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS api_cost_logs (
  id           BIGSERIAL    PRIMARY KEY,
  store_id     TEXT         NOT NULL,
  api_type     TEXT         NOT NULL,            -- 'intent' | 'embedding' | 'rerank' | 'response' | 'chips'
  model        TEXT         NOT NULL,
  input_tokens  INTEGER     DEFAULT 0,
  output_tokens INTEGER     DEFAULT 0,
  -- 원가 계산 (USD 기준, Gemini 가격 기준)
  cost_usd     NUMERIC(10,6) DEFAULT 0,
  created_at   TIMESTAMPTZ  DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_cost_store   ON api_cost_logs (store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_cost_type    ON api_cost_logs (store_id, api_type);

COMMENT ON TABLE  api_cost_logs          IS 'Gemini API 호출 원가 추적 (고객사별 청구 계산용)';
COMMENT ON COLUMN api_cost_logs.api_type IS 'intent | embedding | rerank | response | chips';
COMMENT ON COLUMN api_cost_logs.cost_usd IS 'input+output 토큰 기준 USD 환산 비용';
