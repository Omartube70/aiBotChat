import { config } from './config.js';
import { getOverrides } from './priceOverrides.js';

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
      cost: Number(v.purchase_cost),
      inStock: inStockOf(v.inventory_status),
      // IN_STOCK / LOW_STOCK / OUT_OF_STOCK — إنياد مش بيدّي الكمية بالعدد، بس المستوى
      stock: String(v.inventory_status || '').toUpperCase(),
      lowAt: Number(v.low_inventory_alert_threshold) || null,
    }))
    .filter((v) => Number.isFinite(v.price));

  const prices = variations.map((v) => v.price);
  const minPrice = prices.length ? Math.min(...prices) : null;
  const maxPrice = prices.length ? Math.max(...prices) : null;

  // متوسط سعر الشراء الفعلي (تكلفتنا) — مرجع داخلي للتفاوض مع الموردين، مش بيتقالش لحد
  const costs = variations.map((v) => v.cost).filter((c) => Number.isFinite(c) && c > 0);
  const avgCost = costs.length ? Math.round(costs.reduce((a, b) => a + b, 0) / costs.length) : null;

  // نعرض قائمة الأنواع فقط لو فيه أكتر من نوع فعلي (أسماء أو أسعار مختلفة)
  const hasRealVariants =
    variations.length > 1 &&
    (new Set(variations.map((v) => v.name)).size > 1 ||
      new Set(prices).size > 1);

  const imgPath = (raw.image_path || '').trim();

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
    // مستوى المخزون للمدير: أحسن مستوى في الأنواع + حد التنبيه ("قليل" = الحد ده أو أقل)
    stock: variations.some((v) => v.stock === 'IN_STOCK')
      ? 'IN_STOCK'
      : variations.some((v) => v.stock === 'LOW_STOCK')
        ? 'LOW_STOCK'
        : variations.length
          ? 'OUT_OF_STOCK'
          : 'UNKNOWN',
    lowAt: Math.max(0, ...variations.map((v) => v.lowAt || 0)) || null,
    stockVariants: variations.map((v) => ({ name: v.name, stock: v.stock, lowAt: v.lowAt })),
    variations: hasRealVariants ? variations : [],
    imageUrl: imgPath ? `${config.store.imageBase}/${imgPath}` : null,
    ourCost: avgCost,
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

/**
 * بيجيب كل الصفحات. صفحة 0 الأول لوحدها (عشان نعرف total_pages)، والباقي
 * **بالتوازي** مش تسلسلي — ده كان بيسبب بطء شديد (وأحيانًا timeout لكل الرد)
 * لما الكاش يبرد على isolate جديد ويحتاج يجيب كل المنتجات.
 */
async function fetchAllPages(keyword, hardCap = 40) {
  const first = await fetchPage(0, keyword);
  const all = [...first.products];
  if (first.products.length === 0) return all;

  if (first.totalPages != null) {
    const lastPage = Math.min(first.totalPages, hardCap) - 1;
    if (lastPage >= 1) {
      const pages = Array.from({ length: lastPage }, (_, i) => i + 1);
      const results = await Promise.all(pages.map((p) => fetchPage(p, keyword)));
      for (const r of results) all.push(...r.products);
    }
    return all;
  }

  // مفيش total_pages من الـ API — نمشي تسلسلي عادي على nextPage
  let page = first.nextPage;
  for (let i = 1; i < hardCap && page != null; i++) {
    const { products, nextPage } = await fetchPage(page, keyword);
    all.push(...products);
    if (products.length === 0) break;
    page = nextPage;
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

// نتايج البحث بالكلمة بتتحفظ لنفس مدة الكاش (منقول من البوت القديم) —
// نفس السؤال ("كالون"، "طرمبة") بيتكرر كتير فبيرد على طول من غير نداء API.
const searchCache = new Map();
function cachedApiSearch(term) {
  const key = normalizeAr(term);
  const hit = searchCache.get(key);
  if (hit && Date.now() - hit.at < config.catalogTtlMs) return hit.promise;
  const promise = apiSearch(term);
  promise.catch(() => searchCache.delete(key));
  if (searchCache.size > 500) searchCache.clear();
  searchCache.set(key, { at: Date.now(), promise });
  return promise;
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
export function normalizeAr(s) {
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

// حروف بتتلخبط في الكتابة أو في سماع الفويس (صالون/كالون، قالون، طرنبه...) → حرف واحد
const LOOSE = { ص: 'س', ث: 'س', ق: 'ك', ذ: 'ز', ظ: 'ض', ط: 'ت', ض: 'د', غ: 'ع' };

/** شكل "مرن" للكلمة: من غير ال/بال/وال/لل، الحروف المتشابهة موحّدة، والحرف المكرر مرة واحدة. */
function loose(w) {
  return w
    .replace(/^(?:وال|بال|لل|ال)(?=.{3})/, '')
    .replace(/[صثقذظطضغ]/g, (c) => LOOSE[c])
    .replace(/(.)\1+/g, '$1');
}

// جمع تكسير/أسماء شائعة → اسم المنتج في الكتالوج
const SYNONYMS = {
  كوالين: 'كالون', كوالون: 'كالون', مكاين: 'ماكينه', مكن: 'ماكينه', ماكينات: 'ماكينه',
  كروت: 'كارت', كرت: 'كارت', ابواب: 'باب', اسلاك: 'سلك', كابلات: 'كبل', كيبل: 'كبل',
  كابل: 'كبل', وير: 'واير', wire: 'واير', طلمبه: 'طرمبه', طلمبات: 'طرمبه', مواتير: 'موتور',
  زراير: 'زرار', ازرار: 'زرار', حبال: 'حبل', كراسي: 'كرسي',
};

// نفس الجدول بس المفاتيح بالشكل "المرن" (طلمبه → تلمبه) عشان تتقارن بـ loose()
const LOOSE_SYN = Object.fromEntries(Object.entries(SYNONYMS).map(([k, v]) => [loose(k), v]));

/** "الوايرات" → "واير"، "طرمبات" → "ترمب"، "ماكينه" → "ماكين": من غير ال والجمع والتأنيث. */
function stem(w) {
  let s = loose(w);
  if (LOOSE_SYN[s]) s = loose(LOOSE_SYN[s]);
  for (const suf of ['ات', 'ين', 'ون', 'ان', 'ه', 'ي']) {
    if (s.endsWith(suf) && s.length - suf.length >= 3) {
      s = s.slice(0, -suf.length);
      break;
    }
  }
  // "ويرات" → "وير" → "واير"
  if (LOOSE_SYN[s]) s = loose(LOOSE_SYN[s]);
  return s;
}

/** نفس الكلمة؟ (بالجذر من الناحيتين — "ماكين" = "ماكينه"، "الوايرات" = "واير") */
function sameWord(a, b) {
  const sa = stem(a);
  const sb = stem(b);
  if (sa.length < 3 || sb.length < 3) return false;
  return sa === sb || sa === loose(b) || loose(a) === sb;
}

/** هيكل الكلمة من غير حروف المد والهاء الأخيرة: ماكنه=ماكينه، كلون=كالون، حبال=حبل، زراير=زرار. */
function skeleton(w) {
  return loose(w).replace(/[اوي]/g, '').replace(/ه$/, '');
}

/**
 * درجة التطابق التقريبي لكلمة t مع أقرب كلمة في الاسم.
 * @returns {number} 0 = لا يوجد، 2 = تقريبي، 3 = شبه مطابق (نفس الكلمة بكتابة مختلفة)
 */
function fuzzyScore(nameWords, t) {
  if (t.length < 3) return 0;
  const tl = loose(t);
  const ts = skeleton(t);
  let best = 0;
  for (const w of nameWords) {
    if (w.length < 3) continue;
    const wl = loose(w);
    if (wl === tl || (ts.length >= 2 && skeleton(w) === ts)) return 3;
    const d = editDistance(wl, tl);
    const len = Math.min(wl.length, tl.length);
    if (d <= 1 && len >= 4) best = Math.max(best, len >= 6 ? 3 : 2);
    else if (d === 2 && len >= 7) best = Math.max(best, 2);
  }
  return best;
}

/** @returns {{s: number, exact: boolean}} exact = كلمة واحدة على الأقل اتطابقت حرفيًا (مش تقريبي) */
function scoreMatch(product, terms) {
  const name = normalizeAr(product.name);
  const nameWords = name.split(' ');
  const hay = normalizeAr(`${product.name} ${product.description} ${product.category}`);
  let score = 0;
  let exact = false;
  for (const raw of terms) {
    const t = stripAl(raw);
    if (!t) continue;
    if (name.includes(t) || name.includes(raw)) {
      score += 3;
      exact = true;
    } else if (nameWords.some((w) => sameWord(w, t))) {
      // نفس الكلمة بس بـ"ال" أو جمع أو تاء مربوطة زيادة/ناقصة → مطابقة كاملة مش تقريبية
      score += 3;
      exact = true;
    } else if (hay.includes(t) || hay.includes(raw)) {
      score += 1;
      exact = true;
    } else score += fuzzyScore(nameWords, t);
  }
  // مكافأة لو الاسم/الوصف يحتوي كل الكلمات
  if (terms.length > 1 && terms.every((t) => hay.includes(stripAl(t)))) score += 2;
  // الاسم بيبدأ بالكلمة المطلوبة ("ماكينه اكيش" قبل "زيت ماكينه")
  if (score && terms.some((t) => skeleton(stripAl(t)) === skeleton(nameWords[0]))) score += 1;
  return { s: score, exact };
}

/**
 * البحث الذي يستدعيه الموديل.
 * يجرّب بحث الـ API بالجملة كاملة + بكل كلمة على حدة، يدمج النتائج،
 * ثم يرتّبها محلياً على كلمات المستخدم. لو مفيش تطابق حقيقي يرجّع [].
 * @returns {Promise<Array>} أعلى النتائج تطابقاً (مختصرة للموديل)
 */
export async function searchProducts(query, limit = 8, { raw = false } = {}) {
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
    // "الوايرات" → بحث بـ"واير" كمان، و"كوالين" → "كالون"
    const syn = LOOSE_SYN[loose(t)];
    if (syn) queries.push(syn);
    const st = stem(t);
    if (st.length >= 3 && st !== s) queries.push(st);
  }
  // نستبعد التكرار، وبعدين نبعت كل الاستعلامات بالتوازي (مش تسلسلي) — أسرع بكتير
  const tried = new Set();
  const uniqueQueries = [];
  for (const term of queries) {
    const key = normalizeAr(term);
    if (!key || tried.has(key)) continue;
    tried.add(key);
    uniqueQueries.push(term);
  }

  const results = await Promise.all(
    uniqueQueries.map((term) =>
      cachedApiSearch(term).catch((err) => {
        console.warn(`[catalog] بحث "${term}" فشل:`, err.message);
        return [];
      }),
    ),
  );
  for (const res of results) for (const p of res) byUuid.set(p.uuid, p);

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

  const rank = (list, min) =>
    list
      .map((p) => ({ p, ...scoreMatch(p, searchTerms) }))
      .filter((x) => x.s >= min)
      .sort((a, b) => b.s - a.s);

  // من الكاش الكامل بنبقى أصرم في العتبة (عشان نتجنب تطابق حرفي عرضي)
  let hits = rank(pool, fromApi ? 1 : 3);

  // مفيش تطابق → بحث تقريبي في الكتالوج كله (حرف ناقص/زيادة، "ال"، صالون=كالون...)
  // بناخد أقرب المنتجات بس، والبوت بيسأل العميل "تقصد كذا؟"
  if (!hits.length) {
    try {
      const all = rank(await ensureCache(), 2);
      if (all.length) hits = all.filter((x) => x.s >= all[0].s - 1);
    } catch (err) {
      console.warn('[catalog] الكاش مش متاح:', err.message);
    }
  }

  const approx = new Set(hits.filter((x) => !x.exact).map((x) => x.p));
  const ranked = hits.slice(0, limit).map((x) => x.p);

  // لو مفيش تطابق نصّي حقيقي بس الـ API رجّع نتيجة/اتنين فقط، نعتبرها مقبولة؛
  // غير كده نرجّع [] عشان البوت يقول "مش لاقي المنتج".
  const result =
    ranked.length > 0
      ? ranked
      : fromApi && byUuid.size > 0 && byUuid.size <= 2
        ? [...byUuid.values()]
        : [];

  // تعديلات السعر اليدوية (لو موظف غيّر سعر بيع/شراء عبر واتساب) بتتطبّق هنا
  // فوق سعر إنياد — مرة واحدة لكل استدعاء، مش لكل منتج.
  const overrides = await getOverrides();
  // raw: بيانات كاملة للمدير (سعر الشراء وحالة المخزون) — مش للموديل ولا للعملاء
  if (raw) return result.map((p) => ({ ...p, override: overrides[normalizeAr(p.name)] || null }));
  return result.map((p) => ({
    ...compactForModel(p, overrides[normalizeAr(p.name)]),
    // العميل غالبًا كتب الاسم غلط أو الفويس اتسمع غلط — البوت يسأله "تقصد كذا؟"
    تقريبي: approx.has(p) || undefined,
  }));
}

/** ملخص المخزون للمدير: عدد المنتجات، المتاح، والخلصان. */
export async function stockSummary() {
  const products = await ensureCache();
  const out = products.filter((p) => p.stock === 'OUT_OF_STOCK');
  const low = products.filter((p) => p.stock === 'LOW_STOCK');
  return {
    total: products.length,
    inStock: products.length - out.length - low.length,
    low: low.length,
    outOfStock: out.length,
    outNames: out.map((p) => p.name),
    lowNames: low.map((p) => `${p.name}${p.lowAt ? ` (${p.lowAt} أو أقل)` : ''}`),
  };
}

function priceLabel(price, priceMax, currency) {
  if (price == null) return 'السعر غير محدد — اسأل المحل';
  if (priceMax != null && priceMax !== price) {
    return `من ${price} إلى ${priceMax} ${currency}`;
  }
  return `${price} ${currency}`;
}

// حالة التوفر مش بتتبعت لـ Gemini خالص ولا بتتذكر للعميل — السعر والتفاصيل بس
// (طلب صاحب المتجر: البوت ميقولش "غير متوفر" حتى لو المخزون صفر)
function compactForModel(p, override) {
  // لو فيه سعر بيع معدّل يدويًا، بيبقى سعر ثابت (بيلغي مدى "من...إلى" الأصلي)
  const price = override?.sale ?? p.price;
  const priceMax = override?.sale != null ? override.sale : p.priceMax;
  const ourCost = override?.cost ?? p.ourCost;
  return {
    الاسم: p.name,
    السعر: priceLabel(price, priceMax, p.currency),
    الوصف: p.description || undefined,
    التصنيف: p.category || undefined,
    الأنواع:
      p.variations.length && override?.sale == null
        ? p.variations.map((v) => `${v.name}: ${v.price} ${p.currency}`)
        : undefined,
    // تكلفة الشراء الفعلية — مرجع سرّي للموديل لما يفاصل مع مورّد، ممنوع تمامًا يفصح عنه لأي حد
    تكلفتنا_سرية_للمفاوضة_فقط: ourCost ?? undefined,
    // مفاتيح داخلية للـ worker بس — بتتشال قبل الإرسال لـ Gemini
    imageUrl: p.imageUrl || undefined,
    _price: price ?? undefined, // أقل سعر رقمي (للفاتورة)
    _priceMax: priceMax ?? undefined,
  };
}

export async function catalogStats() {
  const products = await ensureCache();
  return { count: products.length, fetchedAt: new Date(cache.fetchedAt).toISOString() };
}
