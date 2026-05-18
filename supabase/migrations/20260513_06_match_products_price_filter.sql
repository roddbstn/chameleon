-- ============================================================
-- Migration 06: match_products RPC 가격 필터 추가
-- filter_price_max / filter_price_min 을 선택적 파라미터로 추가
-- NULL이면 필터 미적용 (기존 동작 유지)
-- ============================================================

CREATE OR REPLACE FUNCTION match_products(
  query_embedding  text,
  match_store_id   text,
  match_count      int,
  filter_price_max int DEFAULT NULL,
  filter_price_min int DEFAULT NULL
)
RETURNS TABLE (
  product_id text,
  name       text,
  embed_text text,
  price      int,
  attributes jsonb,
  similarity float
)
LANGUAGE plpgsql
AS $$
BEGIN
  RETURN QUERY
  SELECT
    p.product_id,
    p.name,
    p.embed_text,
    p.price,
    p.attributes,
    1 - (pe.embedding <=> query_embedding::vector) AS similarity
  FROM product_embeddings pe
  JOIN products p
    ON pe.store_id = p.store_id AND pe.product_id = p.product_id
  WHERE pe.store_id = match_store_id
    AND p.status = 'active'
    AND (filter_price_max IS NULL OR p.price <= filter_price_max)
    AND (filter_price_min IS NULL OR p.price >= filter_price_min)
  ORDER BY pe.embedding <=> query_embedding::vector
  LIMIT match_count;
END;
$$;
