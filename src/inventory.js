import { unzipSync, strFromU8 } from 'fflate';
import { normalizeAr } from './catalog.js';

/**
 * الكميات من ملف جرد إنياد (Excel: "مخزون_محل.xlsx") — إنياد مش بيدّي الكمية في الـ API،
 * فالمدير بيبعت الملف للبوت على واتساب وبنحفظ الكميات (inv:data) لحد الملف الجاي.
 * أعمدة الملف: منتج | منتج فرعي | ... | تكلفة الشراء | الكمية الإجمالية | وحدة | قيمة المخزون
 */

const INV_KEY = 'inv:data';

/** @returns {{date: string|null, items: Array<{name, variant, qty, cost}>}} */
export function parseInventoryXlsx(bytes) {
  // بنفك الملفين اللي محتاجينهم بس (الشيت فيه آلاف الصفوف الفاضية)
  const files = unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), {
    filter: (f) => f.name === 'xl/sharedStrings.xml' || f.name === 'xl/worksheets/sheet1.xml',
  });
  const ssXml = files['xl/sharedStrings.xml'] ? strFromU8(files['xl/sharedStrings.xml']) : '';
  const sheet = files['xl/worksheets/sheet1.xml'] ? strFromU8(files['xl/worksheets/sheet1.xml']) : '';
  if (!sheet) throw new Error('الملف مش شيت Excel مفهوم');

  const unesc = (s) =>
    s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  const strings = [];
  for (const m of ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    let t = '';
    for (const x of m[1].matchAll(/<t[^>]*>([^<]*)<\/t>/g)) t += x[1];
    strings.push(unesc(t));
  }

  const rows = [];
  // split أسرع بكتير من regex على 4 ميجا (الشيت فيه آلاف الصفوف الفاضية بتنسيق بس)
  for (const chunk of sheet.split('</row>')) {
    if (!chunk.includes('<v>') && !chunk.includes('<is>')) continue; // صف فاضي
    const body = chunk.slice(chunk.lastIndexOf('<row'));
    const cells = {};
    for (const c of body.matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const inner = c[3] || '';
      let v = (inner.match(/<v>([^<]*)<\/v>/) || [])[1];
      if (/t="s"/.test(c[2]) && v != null) v = strings[Number(v)];
      else if (/t="inlineStr"/.test(c[2])) v = [...inner.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((x) => x[1]).join('');
      if (v != null) cells[c[1]] = unesc(String(v)).trim();
    }
    rows.push(cells);
  }

  // صف العناوين (فيه "منتج" و"الكمية")
  const hi = rows.findIndex((r) => Object.values(r).includes('منتج') && Object.values(r).some((v) => /الكمي/.test(v)));
  if (hi < 0) throw new Error('مش لاقي عمود "منتج" و"الكمية" في الملف');
  const col = (re) => Object.entries(rows[hi]).find(([, v]) => re.test(v))?.[0];
  const cName = col(/^منتج$/);
  const cVar = col(/فرعي/);
  const cQty = col(/الكمي/);
  const cCost = col(/تكلف|الشراء/);

  let date = null;
  for (const r of rows.slice(0, hi)) {
    for (const v of Object.values(r)) {
      const d = v.replace(/[‎‏؜]/g, '').match(/\d{1,2}\/\d{1,2}\/\d{4}/);
      if (d) date = d[0];
    }
  }

  const items = [];
  for (const r of rows.slice(hi + 1)) {
    const name = r[cName];
    if (!name) continue;
    const qty = Number(r[cQty]);
    if (!Number.isFinite(qty)) continue;
    const variant = cVar && r[cVar] && r[cVar] !== '-' ? r[cVar] : null;
    const cost = Number(r[cCost]);
    items.push({ name, variant, qty: Math.round(qty * 100) / 100, cost: Number.isFinite(cost) ? cost : null });
  }
  if (!items.length) throw new Error('الملف مفيهوش منتجات');
  return { date, items };
}

export async function saveInventory(env, inv) {
  await env.MEMORY.put(INV_KEY, JSON.stringify({ ...inv, savedAt: Date.now() }));
}

export async function getInventory(env) {
  return (env?.MEMORY && (await env.MEMORY.get(INV_KEY, 'json'))) || null;
}

/** كمية منتج (بالاسم زي إنياد). @returns {{qty, date}|null} */
export function findQty(inv, name) {
  if (!inv?.items?.length || !name) return null;
  const key = normalizeAr(name);
  const matches = inv.items.filter((i) => normalizeAr(i.name) === key);
  if (!matches.length) return null;
  const qty = matches.reduce((s, i) => s + i.qty, 0);
  return { qty: Math.round(qty * 100) / 100, date: inv.date };
}

/** ملخص: عدد الأصناف وإجمالي القطع. */
export function inventoryTotals(inv) {
  if (!inv?.items?.length) return null;
  const qty = inv.items.reduce((s, i) => s + Math.max(0, i.qty), 0);
  return {
    count: inv.items.length,
    qty: Math.round(qty),
    zero: inv.items.filter((i) => i.qty <= 0).length,
    date: inv.date,
  };
}
