-- ============================================================
-- Migration 10: store_tokens에 토큰 만료 시각 컬럼 추가
-- 사전 갱신(proactive refresh)으로 API 호출 실패 방지
-- Depends: Migration 01 (store_tokens)
-- ============================================================

ALTER TABLE store_tokens
  ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMPTZ;

COMMENT ON COLUMN store_tokens.token_expires_at IS 'access_token 만료 시각 — 5분 전 갱신 트리거';
