-- Migration: chat_logs companion tracking columns
-- 2026-05-15 | Cross-sell PDP Q&A 기능 — companion 노출 및 클릭 추적용 컬럼 추가
--
-- companion_shown  : 해당 Q&A 응답에서 보조 상품 카드가 노출되었는지 여부
-- companion_ids    : 노출된 보조 상품의 product_id 배열

ALTER TABLE chat_logs
  ADD COLUMN IF NOT EXISTS companion_shown BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS companion_ids   TEXT[];

-- 인덱스: companion 전환율 분석 (companion_shown = true인 대화 필터링용)
CREATE INDEX IF NOT EXISTS idx_chat_logs_companion_shown
  ON chat_logs (store_id, companion_shown, created_at DESC)
  WHERE companion_shown = TRUE;

-- widget_events에 companion 관련 이벤트 타입 허용 (이미 text 타입이므로 별도 제약 불필요)
-- companion_impression : 카드 뷰포트 노출
-- companion_click      : "자세히 보기" 클릭
-- (기존 event_type 컬럼에 자연스럽게 추가됨)

COMMENT ON COLUMN chat_logs.companion_shown IS
  'Q&A 응답에서 크로스셀 보조 상품 카드가 노출되었는지 여부';
COMMENT ON COLUMN chat_logs.companion_ids IS
  '노출된 보조 상품의 product_id 배열 (클릭/전환 역추적용)';
