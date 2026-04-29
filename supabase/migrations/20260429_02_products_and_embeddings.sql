-- ============================================================
-- Migration 02: 상품 및 임베딩 스키마
-- 카페24 상품 원본 + Gemini 벡터 임베딩
-- Depends: Migration 01 (store_tokens — store_id 참조 없음, 단독 실행 가능)
-- ============================================================

-- pgvector 익스텐션 활성화 (Supabase에서 기본 제공)
CREATE EXTENSION IF NOT EXISTS vector;

-- ────────────────────────────────────────────
-- 2-1. products: 카페24 상품 원본 + 정규화 데이터
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS products (
  id          BIGSERIAL    PRIMARY KEY,
  store_id    TEXT         NOT NULL,              -- 카페24 mall_id
  product_id  TEXT         NOT NULL,              -- 카페24 product_no (문자열)
  name        TEXT         NOT NULL,
  category    TEXT,
  price       INTEGER      NOT NULL DEFAULT 0,    -- 원(KRW)
  status      TEXT         NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active', 'deleted')),
  attributes  JSONB        DEFAULT '{}',          -- material, retail_price, options 등
  raw_data    JSONB        DEFAULT '{}',          -- 카페24 API 원본 응답 전체
  embed_text  TEXT,                               -- 임베딩 생성에 사용된 텍스트
  synced_at   TIMESTAMPTZ  DEFAULT now(),

  UNIQUE (store_id, product_id)
);

-- 인덱스
CREATE INDEX IF NOT EXISTS idx_products_store    ON products (store_id);
CREATE INDEX IF NOT EXISTS idx_products_status   ON products (store_id, status);
CREATE INDEX IF NOT EXISTS idx_products_category ON products (store_id, category);

COMMENT ON TABLE  products              IS '카페24에서 동기화된 상품 데이터';
COMMENT ON COLUMN products.store_id    IS '카페24 mall_id';
COMMENT ON COLUMN products.product_id  IS '카페24 product_no';
COMMENT ON COLUMN products.attributes  IS 'LLM 정규화 결과: material, options, fit 등';
COMMENT ON COLUMN products.raw_data    IS '카페24 API 원본 응답 (변경 추적용)';
COMMENT ON COLUMN products.embed_text  IS '벡터 임베딩 생성에 사용된 최종 텍스트';

-- ────────────────────────────────────────────
-- 2-2. product_embeddings: Gemini 768차원 벡터
-- ────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS product_embeddings (
  id          BIGSERIAL   PRIMARY KEY,
  store_id    TEXT        NOT NULL,
  product_id  TEXT        NOT NULL,
  embedding   vector(768) NOT NULL,              -- Gemini text-embedding-004
  embedded_at TIMESTAMPTZ DEFAULT now(),

  UNIQUE (store_id, product_id)
);

-- HNSW 인덱스: cosine 유사도 벡터 검색
CREATE INDEX IF NOT EXISTS idx_product_embeddings_hnsw
  ON product_embeddings
  USING hnsw (embedding vector_cosine_ops);

COMMENT ON TABLE  product_embeddings           IS 'Gemini 임베딩 벡터 (768차원)';
COMMENT ON COLUMN product_embeddings.embedding IS 'Gemini text-embedding-004 출력값';
