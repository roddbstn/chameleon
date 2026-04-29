-- ============================================================
-- Migration 03: 유저 세션 및 행동 이벤트 스키마
-- 방문자 신호 수집, 세션 관리, 행동 로그
-- Depends: Migration 02 (products)
-- ============================================================

-- ────────────────────────────────────────────
-- 3-1. user_sessions: 방문 세션
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS user_sessions (
  id            BIGSERIAL    PRIMARY KEY,
  session_id    TEXT         NOT NULL UNIQUE,     -- UUID (localStorage 기반)
  store_id      TEXT         NOT NULL,
  -- 유입 컨텍스트 신호 (Level 1)
  referrer      TEXT,
  utm_source    TEXT,
  utm_medium    TEXT,
  utm_campaign  TEXT,
  utm_content   TEXT,
  -- 초기 세그먼트 판정
  persona       TEXT         DEFAULT 'fashion'
                             CHECK (persona IN ('fashion', 'gift', 'repeat', 'price_sensitive', 'ai_traffic')),
  -- 디바이스
  device_type   TEXT         CHECK (device_type IN ('mobile', 'desktop', 'tablet')),
  -- 타임스탬프
  created_at    TIMESTAMPTZ  DEFAULT now(),
  updated_at    TIMESTAMPTZ  DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_sessions_store     ON user_sessions (store_id);
CREATE INDEX IF NOT EXISTS idx_sessions_persona   ON user_sessions (store_id, persona);
CREATE INDEX IF NOT EXISTS idx_sessions_created   ON user_sessions (created_at DESC);

COMMENT ON TABLE  user_sessions            IS '방문자 세션 (익명 UUID 기반)';
COMMENT ON COLUMN user_sessions.persona    IS 'classifyIntent() 판정 결과';
COMMENT ON COLUMN user_sessions.session_id IS 'localStorage에서 생성·유지되는 UUID';

-- ────────────────────────────────────────────
-- 3-2. behavior_events: 행동 이벤트 로그
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS behavior_events (
  id           BIGSERIAL    PRIMARY KEY,
  session_id   TEXT         NOT NULL REFERENCES user_sessions(session_id) ON DELETE CASCADE,
  store_id     TEXT         NOT NULL,
  event_type   TEXT         NOT NULL,            -- 'page_view' | 'scroll' | 'click' | 'chat_open' | 'cart_add' | 'purchase'
  product_id   TEXT,                             -- 이벤트 관련 상품 (있는 경우)
  payload      JSONB        DEFAULT '{}',        -- 이벤트별 추가 데이터
  created_at   TIMESTAMPTZ  DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_events_session   ON behavior_events (session_id);
CREATE INDEX IF NOT EXISTS idx_events_store     ON behavior_events (store_id, event_type);
CREATE INDEX IF NOT EXISTS idx_events_created   ON behavior_events (created_at DESC);

COMMENT ON TABLE  behavior_events            IS '방문자 행동 이벤트 로그 (클릭, 스크롤, 구매 등)';
COMMENT ON COLUMN behavior_events.event_type IS 'page_view | scroll | click | chat_open | cart_add | purchase';
COMMENT ON COLUMN behavior_events.payload    IS 'scroll_depth, time_on_page 등 이벤트별 메타데이터';
