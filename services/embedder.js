const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const GEMINI_EMBEDDING_URL =
  'https://generativelanguage.googleapis.com/v1beta/models/text-embedding-004:embedContent';

async function embedText(text) {
  const res = await axios.post(
    `${GEMINI_EMBEDDING_URL}?key=${process.env.GOOGLE_AI_API_KEY}`,
    {
      model: 'models/text-embedding-004',
      content: { parts: [{ text }] },
    }
  );
  return res.data.embedding.values; // 768차원 배열
}

async function runEmbedding(mallId) {
  // 임베딩이 없는 상품만 조회
  const { data: products, error } = await supabase
    .from('products')
    .select('id, embed_text')
    .eq('store_id', mallId)
    .eq('status', 'active')
    .not('embed_text', 'is', null);

  if (error) throw new Error(error.message);
  if (!products.length) return { embedded: 0, skipped: 0 };

  // 이미 임베딩된 product_id 목록 조회
  const productIds = products.map(p => p.id);
  const { data: existing } = await supabase
    .from('product_embeddings')
    .select('product_id')
    .in('product_id', productIds);

  const existingIds = new Set((existing || []).map(e => e.product_id));

  let embedded = 0;
  let skipped = 0;
  let failed = 0;

  for (const product of products) {
    if (existingIds.has(product.id)) {
      skipped++;
      continue;
    }

    try {
      const vector = await embedText(product.embed_text);

      const { error: upsertError } = await supabase
        .from('product_embeddings')
        .upsert({
          product_id:  product.id,
          embedding:   JSON.stringify(vector),
          embed_text:  product.embed_text,
          embed_model: 'gemini-embedding-004',
        }, { onConflict: 'product_id' });

      if (upsertError) {
        console.error(`[Embed] Failed ${product.id}:`, upsertError.message);
        failed++;
      } else {
        embedded++;
        console.log(`[Embed] ${embedded}/${products.length - skipped} 완료`);
      }

      // Gemini free tier 분당 1500 req 제한 — 안전하게 딜레이
      await new Promise(r => setTimeout(r, 200));

    } catch (e) {
      console.error(`[Embed] Error on ${product.id}:`, e.response?.data || e.message);
      failed++;
    }
  }

  return { embedded, skipped, failed };
}

module.exports = { runEmbedding };
