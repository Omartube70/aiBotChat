import { config } from './config.js';

/**
 * طبقة الوصول لمنتجات المتجر عبر Inyad Storefront API.
 * نقطة النهاية المكتشفة من موقع المتجر:
 *   GET {apiBase}/items/filter?sortBy=category&direction=asc&page=0[&keyword=...]
 *   Headers:
 *     Authorization: api-key <INYAD_API_KEY>
 *     Store: <STORE_SLUG>
 *   الرد: { page, size, data: [...], next_page, total_pages, total_elements }
 *   ملاحظة: السعر موجود في variations[].price فقط (مفيش سعر على مستوى المنتج).
 */

function apiHeaders() {
  return {
    Accept: 'application/json, text/plain, */*',
    Authorization: `api-key ${config.store.apiKey}`,
    Store: config.store.slug,
  };
}

function inStockOf(status) {
  return String(status || '').toUpperCase() !== 'OUT_OF_STOCK';
}

function normalizeProduct(raw) {
  const name = (raw.name || '').trim();

  const variations = (raw.variations || [])
    .filter((v) => !v.deleted && !v.excluded_from_sales)
    .map((v) => ({
      name: (v.name || '').trim(),
      price: Number(v.price),
      inStock: inStockOf(v.inventory_status),
    }))
    .filter((v) => Number.isFinite(v.price));

  const prices = variations.map((v) => v.price);
  const minPrice = prices.length ? Math.min(...prices) : null;
  const maxPrice = prices.length ? Math.max(...prices) : null;

  // نعرض قائمة الأنواع فقط لو فيه أكتر من نوع فعلي (أسماء أو أسعار مختلفة)
  const hasRealVariants =
    variations.length > 1 &&
    (new Set(variations.map((v) => v.name)).size > 1 ||
      new Set(prices).size > 1);

  return {
    id: raw.id,
    uuid: raw.uuid,
    name,
    description: (raw.description || '').trim(),
    category: (raw.category_name || '').trim(),
    price: minPrice,
    priceMax: maxPrice,
    currency: config.store.currency,
    inStock: variations.length ? variations.some((v) => v.inStock) : true,
    variations: hasRealVariants ? variations : [],
  };
}

async function fetchPage(page, keyword) {
  const url = new URL(`${config.store.apiBase}/items/filter`);
  url.searchParams.set('sortBy', 'category');
  url.searchParams.set('direction', 'asc');
  url.searchParams.set('page', String(page));
  if (keyword) url.searchParams.set('keyword', keyword);

  const res = await fetch(url, { headers: apiHeaders() });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Inyad API ${res.status}: ${body.slice(0, 300)}`);
  }
  const json = await res.json();
  const list = Array.isArray(json) ? json : json.data || [];
  return {
    products: list.map(normalizeProduct),
    nextPage: json.next_page ?? null,
    totalPages: json.total_pages ?? null,
  };
}

async function fetchAllPages(keyword, hardCap = 40) {
  const all = [];
  let page = 0;
  for (let i = 0; i < hardCap; i++) {
    const { products, nextPage, totalPages } = await fetchPage(page, keyword);
    all.push(...products);
    const hasNext =
      nextPage != null && nextPage !== page
        ? nextPage
        : totalPages != null && page + 1 < totalPages
          ? page + 1
          : null;
    if (hasNext == null || products.length === 0) break;
    page = hasNext;
  }
  return all;
}

/** جلب كل المنتجات (كل الصفحات) — يُستخدم للكاش والمزامنة. */
export async function fetchAllProducts() {
  return fetchAllPages(undefined);
}

/** بحث مباشر بكلمة مفتاحية عبر الـ API. */
export async function apiSearch(keyword) {
  return fetchAllPages(keyword, 6);
}

/* ----------------------------- الكاش ----------------------------- */

let cache = { products: [], fetchedAt: 0, loading: null };

async function ensureCache() {
  const fresh = Date.now() - cache.fetchedAt < config.catalogTtlMs;
  if (fresh && cache.products.length) return cache.products;
  if (cache.loading) return cache.loading;

  cache.loading = (async () => {
    try {
      const products = await fetchAllProducts();
      cache = { products, fetchedAt: Date.now(), loading: null };
      console.log(`[catalog] تم تحميل ${products.length} منتج في الكاش`);
      return products;
    } catch (err) {
      cache.loading = null;
      if (cache.products.length) {
        console.warn('[catalog] فشل التحديث، هنكمل بالكاش القديم:', err.message);
        return cache.products;
      }
      throw err;
    }
  })();

  return cache.loading;
}

/** توحيد النص العربي: harmzat الألف، التاء المربوطة، الياء، التطويل، والتشكيل. */
function normalizeAr(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[ً-ْـ]/g, '') // تشكيل + تطويل
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/[ىي]/g, 'ي')
    .replace(/ؤ/g, 'و')
    .replace(/ئ/g, 'ي')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ') // شيل علامات الترقيم (؟ ، . ! ...)
    .replace(/\s+/g, ' ')
    .trim();
}

// كلمات شائعة منستبعدهاش كـ term بحث لوحدها
const STOP = new Set([
  'عايز', 'عاوز', 'عوز', 'سعر', 'بكام', 'كام', 'المنتج', 'منتج', 'من', 'في', 'ال',
  'على', 'ايه', 'هو', 'هي', 'ممكن', 'لو', 'سمحت', 'مش', 'موجود', 'عندكم', 'عندك',
  'حاجه', 'محتاج', 'اطلب', 'اشتري', 'كده', 'ده', 'دي', 'يا', 'باشا', 'حضرتك',
  'اسم', 'نوع', 'او', 'مع', 'بتاع', 'بتاعت', 'خالص', 'برضو', 'كمان',
]);

/** يشيل "ال" التعريف من أول الكلمة لتحسين المطابقة. */
function stripAl(t) {
  return t.length > 4 && t.startsWith('ال') ? t.slice(2) : t;
}

/** مسافة تعديل بسيطة (Levenshtein) بحد أقصى 2 — للمطابقة التقريبية. */
function editDistance(a, b) {
  if (Math.abs(a.length - b.length) > 2) return 3;
  const dp = Array.from({ length: a.length + 1 }, (_, i) => i);
  for (let j = 1; j <= b.length; j++) {
    let prev = dp[0];
    dp[0] = j;
    for (let i = 1; i <= a.length; i++) {
      const tmp = dp[i];
      dp[i] = Math.min(
        dp[i] + 1,
        dp[i - 1] + 1,
        prev + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      prev = tmp;
    }
  }
  return dp[a.length];
}

/**
 * درجة التطابق التقريبي لكلمة t مع أقرب كلمة في الاسم.
 * @returns {number} 0 = لا يوجد، 2 = تقريبي، 3 = شبه مطابق (كلمة طويلة بفرق حرف واحد)
 */
function fuzzyScore(nameWords, t) {
  if (t.length < 5) return 0;
  let best = 0;
  for (const w of nameWords) {
    if (w.length < 4) continue;
    const d = editDistance(w, t);
    if (d <= 1 && Math.min(w.length, t.length) >= 6) best = Math.max(best, 3);
    else if (d <= 1) best = Math.max(best, 2);
    else if (d === 2 && Math.min(w.length, t.length) >= 7) best = Math.max(best, 2);
  }
  return best;
}

function scoreMatch(product, terms) {
  const name = normalizeAr(product.name);
  const nameWords = name.split(' ');
  const hay = normalizeAr(`${product.name} ${product.description} ${product.category}`);
  let score = 0;
  for (const raw of terms) {
    const t = stripAl(raw);
    if (!t) continue;
    if (name.includes(t) || name.includes(raw)) score += 3;
    else if (hay.includes(t) || hay.includes(raw)) score += 1;
    else score += fuzzyScore(nameWords, t);
  }
  // مكافأة لو الاسم/الوصف يحتوي كل الكلمات
  if (terms.length > 1 && terms.every((t) => hay.includes(stripAl(t)))) score += 2;
  return score;
}

/**
 * البحث الذي يستدعيه الموديل.
 * يجرّب بحث الـ API بالجملة كاملة + بكل كلمة على حدة، يدمج النتائج،
 * ثم يرتّبها محلياً على كلمات المستخدم. لو مفيش تطابق حقيقي يرجّع [].
 * @returns {Promise<Array>} أعلى النتائج تطابقاً (مختصرة للموديل)
 */
export async function searchProducts(query, limit = 8) {
  const q = (query || '').trim();
  if (!q) return [];

  const rawTerms = normalizeAr(q).split(' ').filter(Boolean);
  const terms = rawTerms.filter((t) => t.length >= 3 && !STOP.has(t));
  const searchTerms = terms.length ? terms : rawTerms.filter((t) => t.length >= 2);
  if (searchTerms.length === 0) return [];

  // نجمع pool من عدة عمليات بحث بالـ API (مع dedupe بالـ uuid)
  const byUuid = new Map();
  // نبحث بالجملة، وبكل كلمة، وبكل كلمة من غير "ال"
  const queries = [q];
  for (const t of searchTerms.slice(0, 3)) {
    queries.push(t);
    const s = stripAl(t);
    if (s !== t) queries.push(s);
  }
  const tried = new Set();

  for (const term of queries) {
    const key = normalizeAr(term);
    if (!key || tried.has(key)) continue;
    tried.add(key);
    try {
      const res = await apiSearch(term);
      for (const p of res) byUuid.set(p.uuid, p);
    } catch (err) {
      console.warn(`[catalog] بحث "${term}" فشل:`, err.message);
    }
  }

  let pool = [...byUuid.values()];
  const fromApi = pool.length > 0;

  // آخر حل: فلترة الكاش الكامل محلياً
  if (pool.length === 0) {
    try {
      pool = await ensureCache();
    } catch (err) {
      console.warn('[catalog] الكاش مش متاح:', err.message);
      return [];
    }
  }

  // من الكاش الكامل بنبقى أصرم في العتبة (عشان نتجنب تطابق حرفي عرضي)
  const minScore = fromApi ? 1 : 3;

  const ranked = pool
    .map((p) => ({ p, s: scoreMatch(p, searchTerms) }))
    .filter((x) => x.s >= minScore)
    .sort((a, b) => b.s - a.s)
    .slice(0, limit)
    .map((x) => x.p);

  // لو مفيش تطابق نصّي حقيقي بس الـ API رجّع نتيجة/اتنين فقط، نعتبرها مقبولة؛
  // غير كده نرجّع [] عشان البوت يقول "مش لاقي المنتج".
  const result =
    ranked.length > 0
      ? ranked
      : fromApi && byUuid.size > 0 && byUuid.size <= 2
        ? [...byUuid.values()]
        : [];

  return result.map(compactForModel);
}

function priceLabel(p) {
  if (p.price == null) return 'السعر غير محدد — اسأل المحل';
  if (p.priceMax != null && p.priceMax !== p.price) {
    return `من ${p.price} إلى ${p.priceMax} ${p.currency}`;
  }
  return `${p.price} ${p.currency}`;
}

function compactForModel(p) {
  return {
    الاسم: p.name,
    السعر: priceLabel(p),
    متوفر: p.inStock ? 'نعم' : 'غير متوفر حالياً',
    الوصف: p.description || undefined,
    التصنيف: p.category || undefined,
    الأنواع: p.variations.length
      ? p.variations.map(
          (v) => `${v.name}: ${v.price} ${p.currency}${v.inStock ? '' : ' (غير متوفر)'}`,
        )
      : undefined,
  };
}

export async function catalogStats() {
  const products = await ensureCache();
  return { count: products.length, fetchedAt: new Date(cache.fetchedAt).toISOString() };
}
