-- ============================================================
-- Migration 09: products 테이블에 pdp_content 캐시 컬럼 추가
-- /api/pdp-content 결과를 서버 재시작과 무관하게 영구 보존
-- Depends: Migration 02 (products)
-- ============================================================

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS pdp_content      JSONB,
  ADD COLUMN IF NOT EXISTS pdp_content_at   TIMESTAMPTZ;

COMMENT ON COLUMN products.pdp_content    IS 'Gemini가 생성한 PDP 콘텐츠 (badge, title, body, chips, accentColor)';
COMMENT ON COLUMN products.pdp_content_at IS 'pdp_content 최종 생성 시각 — NULL이면 미분석 상태';

-- 미분석 상품 빠른 조회용 인덱스 (analyze 배치에서 사용)
CREATE INDEX IF NOT EXISTS idx_products_pdp_content_null
  ON products (store_id)
  WHERE pdp_content IS NULL AND status = 'active';
