-- ============================================================
-- Chameleon — 전체 스키마 한번에 실행 (순서 보장)
-- 새 환경 세팅 시 이 파일 하나만 실행하면 됩니다.
--
-- 실행 순서:
--   01_store_tokens
--   02_products_and_embeddings
--   03_user_sessions_and_events
--   04_ai_conversations_and_costs
--   05_subscriptions_and_billing
--   06_match_products_price_filter
--   07_user_preferences
--   08_companion_tracking
-- ============================================================

\i 20260429_01_store_tokens.sql
\i 20260429_02_products_and_embeddings.sql
\i 20260429_03_user_sessions_and_events.sql
\i 20260429_04_ai_conversations_and_costs.sql
\i 20260429_05_subscriptions_and_billing.sql
\i 20260513_06_match_products_price_filter.sql
\i 20260513_07_user_preferences.sql
\i 20260515_08_companion_tracking.sql

-- 완료 확인
SELECT
  schemaname,
  tablename,
  tableowner
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;
