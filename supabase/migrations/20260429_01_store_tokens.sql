-- ============================================================
-- Migration 01: 스토어 토큰 스키마
-- 카페24 OAuth 액세스/리프레시 토큰 영속화
-- Depends: (없음) — 첫 번째 실행
-- ============================================================

CREATE TABLE IF NOT EXISTS store_tokens (
  store_id      TEXT        PRIMARY KEY,          -- 카페24 mall_id (예: tndbsrkd)
  access_token  TEXT        NOT NULL,
  refresh_token TEXT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE  store_tokens               IS '카페24 OAuth 토큰 영속화 테이블';
COMMENT ON COLUMN store_tokens.store_id      IS '카페24 mall_id (서브도메인)';
COMMENT ON COLUMN store_tokens.access_token  IS 'Cafe24 Bearer 액세스 토큰';
COMMENT ON COLUMN store_tokens.refresh_token IS '만료 시 재발급용 리프레시 토큰';
COMMENT ON COLUMN store_tokens.updated_at    IS '마지막 갱신 일시';
