-- ============================================================
-- Migration 07: 유저 취향 누적 학습 테이블
-- 세션별 소프트 선호도를 누적 → 다음 추천에 반영
-- ============================================================

CREATE TABLE IF NOT EXISTS user_preferences (
  store_id    TEXT         NOT NULL,
  session_id  TEXT         NOT NULL,
  preferences JSONB        NOT NULL DEFAULT '{}',
  -- preferences 구조:
  -- {
  --   "style_keywords": ["미니멀", "캐주얼"],
  --   "fit": "루즈핏",
  --   "fabric": ["린넨", "면"],
  --   "price_range": {"min": 30000, "max": 80000},
  --   "occasions": ["데이트"],
  --   "clicked_categories": ["니트", "팬츠"],
  --   "interaction_count": 5
  -- }
  updated_at  TIMESTAMPTZ  DEFAULT now(),

  PRIMARY KEY (store_id, session_id)
);

CREATE INDEX IF NOT EXISTS idx_user_prefs_store
  ON user_preferences (store_id, updated_at DESC);

COMMENT ON TABLE user_preferences IS '세션별 누적 취향 데이터 — 클릭/장바구니 신호로 자동 갱신';
