import { unzipSync, strFromU8 } from 'fflate';
import { normalizeAr } from './catalog.js';

/**
 * ملفات إنياد اللي المدير بيبعتها (Excel): تاريخ المبيعات، العملاء، الموردين (والمخزون في inventory.js).
 * إنياد مابيدّيش المبيعات ولا الحسابات في الـ API العام — فبنقرا الملفات ونحفظها:
 *   sales:YYYY-MM  → فواتير الشهر (بتتجمّع من كل ملف، ومتتكررش برقم التذكرة)
 *   sales:covered  → الفترات اللي عندنا ملفات ليها (عشان نفرّق بين "يوم مفيهوش بيع" و"يوم مالوش ملف")
 *   acct:customers / acct:suppliers → آخر حسابات (أخذت / أعطيت)
 */

const unesc = (s) =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'");

/** أول شيت في الملف → صفوف {عمود: قيمة}. */
export function readSheet(bytes) {
  const files = unzipSync(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), {
    filter: (f) => f.name === 'xl/sharedStrings.xml' || f.name === 'xl/worksheets/sheet1.xml',
  });
  const ssXml = files['xl/sharedStrings.xml'] ? strFromU8(files['xl/sharedStrings.xml']) : '';
  const sheet = files['xl/worksheets/sheet1.xml'] ? strFromU8(files['xl/worksheets/sheet1.xml']) : '';
  if (!sheet) throw new Error('الملف مش شيت Excel مفهوم');
  const strings = [];
  for (const m of ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    let t = '';
    for (const x of m[1].matchAll(/<t[^>]*>([^<]*)<\/t>/g)) t += x[1];
    strings.push(unesc(t));
  }
  const rows = [];
  for (const chunk of sheet.split('</row>')) {
    if (!chunk.includes('<v>') && !chunk.includes('<is>')) continue;
    const body = chunk.slice(chunk.lastIndexOf('<row'));
    const cells = {};
    for (const c of body.matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const inner = c[3] || '';
      let v = (inner.match(/<v>([^<]*)<\/v>/) || [])[1];
      if (/t="s"/.test(c[2]) && v != null) v = strings[Number(v)];
      else if (/t="inlineStr"/.test(c[2])) v = [...inner.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((x) => x[1]).join('');
      if (v != null) cells[c[1]] = unesc(String(v)).replace(/[‎‏؜]/g, '').trim();
    }
    rows.push(cells);
  }
  return rows;
}

/** نوع الملف من العناوين. */
export function detectKind(rows) {
  for (const r of rows.slice(0, 12)) {
    const vals = Object.values(r);
    if (vals.includes('رقم التذكرة')) return 'sales';
    if (r.B === 'عميل' && vals.includes('أخذت')) return 'customers';
    if (r.B === 'مورد' && vals.includes('أخذت')) return 'suppliers';
    if (vals.includes('منتج') && vals.some((v) => /الكمي/.test(v))) return 'inventory';
  }
  return null;
}

const num = (v) => {
  const n = Number(String(v ?? '').replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
};
const r2 = (n) => Math.round(n * 100) / 100;

const MONTHS = {
  يناير: 1, فبراير: 2, مارس: 3, ابريل: 4, أبريل: 4, إبريل: 4, مايو: 5, يونيو: 6, يونيه: 6, يوليو: 7, يوليه: 7,
  اغسطس: 8, أغسطس: 8, سبتمبر: 9, اكتوبر: 10, أكتوبر: 10, نوفمبر: 11, ديسمبر: 12,
};
const pad = (n) => String(n).padStart(2, '0');

/** "27 سبتمبر 2026" أو "27/09/2026" → "2026-09-27". */
function isoDate(s) {
  const t = String(s || '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
  let m = t.match(/(\d{1,2})\s+(\S+)\s+(\d{4})/);
  if (m && MONTHS[m[2]]) return `${m[3]}-${pad(MONTHS[m[2]])}-${pad(m[1])}`;
  m = t.match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return `${m[3]}-${pad(m[2])}-${pad(m[1])}`;
  return null;
}

/** "2× شفره اكسسز صغيره ،3× ريموت بني" → [{qty, name}] */
function parseItems(s) {
  return String(s || '')
    .split(/\s*[،,]\s*(?=\d)/)
    .map((x) => x.match(/^(\d+(?:\.\d+)?)\s*[×x]\s*(.+)$/))
    .filter(Boolean)
    .map((m) => ({ qty: Number(m[1]), name: m[2].trim() }));
}

export function parseSales(rows) {
  const hi = rows.findIndex((r) => Object.values(r).includes('رقم التذكرة'));
  if (hi < 0) throw new Error('مش لاقي عمود "رقم التذكرة"');
  const col = (re) => Object.entries(rows[hi]).find(([, v]) => re.test(v))?.[0];
  const c = {
    id: col(/رقم التذكرة/), date: col(/^التاريخ$/), time: col(/الساعة/), user: col(/المستخدم/), customer: col(/^العميل$/),
    items: col(/المنتجات/), gross: col(/إجمالي المبيعات/), discount: col(/الخصم/), refund: col(/الاسترداد$/),
    total: col(/^المجموع$/), pay: col(/وسيلة الدفع/), cost: col(/الكلفة/), margin: col(/هامش الربح/),
  };
  const range = {};
  for (const r of rows.slice(0, hi)) {
    if (r.B === 'من') range.from = isoDate(r.E);
    if (r.B === 'إلى') range.to = isoDate(r.E);
  }
  const tickets = [];
  for (const r of rows.slice(hi + 1)) {
    const id = r[c.id];
    const date = isoDate(r[c.date]);
    if (!id || !date) continue;
    tickets.push({
      id,
      date,
      time: r[c.time] || '',
      user: (r[c.user] || '').trim(),
      customer: (r[c.customer] || '').trim(),
      items: r[c.items] || '',
      gross: num(r[c.gross]),
      discount: num(r[c.discount]),
      refund: num(r[c.refund]),
      total: num(r[c.total]),
      pay: (r[c.pay] || '').trim(),
      cost: num(r[c.cost]),
      margin: num(r[c.margin]),
    });
  }
  if (!tickets.length) throw new Error('الملف مفيهوش فواتير');
  const dates = tickets.map((t) => t.date).sort();
  return { from: range.from || dates[0], to: range.to || dates[dates.length - 1], tickets };
}

/** ملف العملاء/الموردين: أخذت / أعطيت لكل اسم. */
export function parseAccounts(rows, kind) {
  const hi = rows.findIndex((r) => r.B === (kind === 'suppliers' ? 'مورد' : 'عميل'));
  if (hi < 0) throw new Error('مش لاقي عمود الاسم');
  const h = rows[hi];
  const col = (re) => Object.entries(h).find(([, v]) => re.test(v))?.[0];
  const c = { took: col(/^أخذت$/), gave: col(/^أعطيت$/), phone: col(/الهاتف/), buys: col(/إجمالي المشتريات/), visits: col(/عدد الزيارات/), last: col(/آخر زيارة/), note: col(/ملحوظة/) };
  const totals = {};
  for (const r of rows.slice(0, hi)) {
    if (r.B === 'أخذت') totals.took = num(r.C);
    if (r.B === 'أعطيت') totals.gave = num(r.C);
  }
  const list = [];
  for (const r of rows.slice(hi + 1)) {
    const name = (r.B || '').trim();
    if (!name || /^test$/i.test(name)) continue;
    const v = (k) => (r[c[k]] && r[c[k]] !== '-' ? r[c[k]] : '');
    list.push({
      name,
      took: num(v('took')),
      gave: num(v('gave')),
      phone: v('phone').replace(/\s/g, ''),
      buys: num(v('buys')),
      visits: num(v('visits')),
      last: v('last'),
      note: v('note'),
    });
  }
  return { totals, list };
}

/* ---------- الحفظ ---------- */

export async function saveSales(env, data) {
  const kv = env.MEMORY;
  const byMonth = {};
  for (const t of data.tickets) (byMonth[t.date.slice(0, 7)] ||= []).push(t);
  let added = 0;
  for (const [month, list] of Object.entries(byMonth)) {
    const old = (await kv.get(`sales:${month}`, 'json')) || [];
    const map = new Map(old.map((t) => [t.id, t]));
    for (const t of list) {
      if (!map.has(t.id)) added++;
      map.set(t.id, t);
    }
    await kv.put(`sales:${month}`, JSON.stringify([...map.values()]));
  }
  const covered = (await kv.get('sales:covered', 'json')) || [];
  covered.push([data.from, data.to]);
  await kv.put('sales:covered', JSON.stringify(mergeRanges(covered)));
  return { added, total: data.tickets.length };
}

function mergeRanges(ranges) {
  const next = (d) => {
    const x = new Date(`${d}T00:00:00Z`);
    x.setUTCDate(x.getUTCDate() + 1);
    return x.toISOString().slice(0, 10);
  };
  const s = ranges.filter((r) => r[0] && r[1]).sort((a, b) => a[0].localeCompare(b[0]));
  const out = [];
  for (const [a, b] of s) {
    const last = out[out.length - 1];
    if (last && a <= next(last[1])) last[1] = b > last[1] ? b : last[1];
    else out.push([a, b]);
  }
  return out;
}

export async function saveAccounts(env, kind, data) {
  await env.MEMORY.put(`acct:${kind}`, JSON.stringify({ ...data, at: Date.now() }));
}

/* ---------- الفترات ---------- */

const DAY = 86400000;
const iso = (d) => d.toISOString().slice(0, 10);
const cairoToday = () => iso(new Date(Date.now() + 3 * 3600000)); // مصر +3 (توقيت صيفي) — كفاية لتحديد اليوم
const addDays = (s, n) => iso(new Date(new Date(`${s}T00:00:00Z`).getTime() + n * DAY));
const AR_DAY = (s) => new Date(`${s}T12:00:00Z`).toLocaleDateString('ar-EG', { weekday: 'long', day: 'numeric', month: 'long' });

/** "النهارده" / "امبارح" / "الأسبوع ده" / "الشهر اللي فات" / "آخر 7 أيام" / "يوم 20" / "20/9" / "شهر 9" → {from, to, label} */
export function parsePeriod(text, today = cairoToday()) {
  const raw = String(text || '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
  const t = normalizeAr(raw);
  const [Y, M] = today.split('-').map(Number);
  let m;
  if ((m = raw.match(/(\d{1,2})\s*[\/\-]\s*(\d{1,2})(?:\s*[\/\-]\s*(\d{4}))?/))) {
    const d = `${m[3] || Y}-${pad(m[2])}-${pad(m[1])}`;
    return { from: d, to: d, label: AR_DAY(d) };
  }
  if ((m = t.match(/اخر\s*(\d{1,3})\s*(?:يوم|ايام)/))) return { from: addDays(today, 1 - Number(m[1])), to: today, label: `آخر ${m[1]} يوم` };
  if (/اول\s*امبارح|اول\s*امس/.test(t)) { const d = addDays(today, -2); return { from: d, to: d, label: `أول امبارح (${AR_DAY(d)})` }; }
  if (/امبارح|امس/.test(t)) { const d = addDays(today, -1); return { from: d, to: d, label: `امبارح (${AR_DAY(d)})` }; }
  if (/(الاسبوع|الاسبوع)\s*(اللي\s*فات|الماضي)/.test(t)) {
    const dow = (new Date(`${today}T12:00:00Z`).getUTCDay() + 1) % 7; // الأسبوع بيبدأ السبت
    const start = addDays(today, -dow - 7);
    return { from: start, to: addDays(start, 6), label: 'الأسبوع اللي فات' };
  }
  if (/الاسبوع|الاسبوع ده|الجمعه دي/.test(t)) {
    const dow = (new Date(`${today}T12:00:00Z`).getUTCDay() + 1) % 7;
    return { from: addDays(today, -dow), to: today, label: 'الأسبوع ده (من السبت)' };
  }
  const monthName = Object.keys(MONTHS).find((k) => t.includes(normalizeAr(k)));
  if ((m = t.match(/شهر\s*(\d{1,2})/)) || monthName) {
    const mo = m ? Number(m[1]) : MONTHS[monthName];
    const y = mo > M ? Y - 1 : Y;
    const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    return { from: `${y}-${pad(mo)}-01`, to: `${y}-${pad(mo)}-${pad(last)}`, label: `شهر ${mo}` };
  }
  if (/الشهر\s*(اللي\s*فات|الماضي)/.test(t)) {
    const mo = M === 1 ? 12 : M - 1;
    const y = M === 1 ? Y - 1 : Y;
    const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    return { from: `${y}-${pad(mo)}-01`, to: `${y}-${pad(mo)}-${pad(last)}`, label: 'الشهر اللي فات' };
  }
  if (/الشهر/.test(t)) return { from: `${Y}-${pad(M)}-01`, to: today, label: 'الشهر ده' };
  if ((m = t.match(/يوم\s*(\d{1,2})/))) {
    const d = `${Y}-${pad(M)}-${pad(m[1])}`;
    const dd = d > today ? `${M === 1 ? Y - 1 : Y}-${pad(M === 1 ? 12 : M - 1)}-${pad(m[1])}` : d;
    return { from: dd, to: dd, label: AR_DAY(dd) };
  }
  if (/النهارده|النهاردة|اليوم|انهارده/.test(t)) return { from: today, to: today, label: `النهارده (${AR_DAY(today)})` };
  return null;
}

/* ---------- التقارير ---------- */

const fmt = (n) => r2(n).toLocaleString('en-US');

async function ticketsIn(env, from, to) {
  const months = new Set();
  for (let d = from.slice(0, 7); d <= to.slice(0, 7); ) {
    months.add(d);
    const [y, m] = d.split('-').map(Number);
    d = m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
  }
  const out = [];
  for (const mo of months) for (const t of (await env.MEMORY.get(`sales:${mo}`, 'json')) || []) if (t.date >= from && t.date <= to) out.push(t);
  return out.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
}

/** رسالة عن الأيام اللي مالهاش ملف في الفترة دي (أو null لو كله متغطي). */
async function coverageNote(env, from, to) {
  const covered = (await env.MEMORY.get('sales:covered', 'json')) || [];
  if (!covered.length) return 'لسه مفيش ملف مبيعات عندي. ابعتلي "تاريخ المبيعات" Excel من إنياد.';
  const lastTo = covered.map((c) => c[1]).sort().pop();
  const inside = covered.some(([a, b]) => a <= from && b >= to);
  if (inside) return null;
  return `⚠️ آخر بيانات مبيعات عندي لحد ${AR_DAY(lastTo)} — اللي بعده مش عندي. ابعتلي ملف "تاريخ المبيعات" الجديد من إنياد وأنا أكمّل.`;
}

/**
 * تقرير مبيعات: عدد الفواتير، الإجمالي، التكلفة، المكسب، وسيلة الدفع، البياعين، أكتر الأصناف.
 * @param {'summary'|'list'} mode list = قايمة الفواتير نفسها
 */
export async function salesReport(env, period, mode = 'summary') {
  const ts = await ticketsIn(env, period.from, period.to);
  const note = await coverageNote(env, period.from, period.to);
  if (!ts.length) return `📊 ${period.label}: مفيش فواتير عندي.${note ? `\n\n${note}` : ''}`;

  const sum = (f) => ts.reduce((s, t) => s + f(t), 0);
  const total = sum((t) => t.total);
  const margin = sum((t) => t.margin);
  const cost = sum((t) => t.cost);
  const lines = [`📊 *مبيعات ${period.label}*`, `🧾 عدد الفواتير: ${ts.length}`, `💵 إجمالي المبيعات: ${fmt(total)} ج.م`];
  const disc = sum((t) => t.discount);
  const refund = sum((t) => t.refund);
  if (disc) lines.push(`🏷️ خصومات: ${fmt(disc)} ج.م`);
  if (refund) lines.push(`↩️ مرتجعات: ${fmt(refund)} ج.م`);
  lines.push(`📦 التكلفة: ${fmt(cost)} ج.م`, `✅ *المكسب: ${fmt(margin)} ج.م*${total ? ` (${Math.round((margin / total) * 100)}%)` : ''}`);

  const group = (key) => {
    const m = new Map();
    for (const t of ts) {
      const k = key(t) || '—';
      const e = m.get(k) || { n: 0, total: 0, margin: 0 };
      e.n++;
      e.total += t.total;
      e.margin += t.margin;
      m.set(k, e);
    }
    return [...m.entries()].sort((a, b) => b[1].total - a[1].total);
  };
  lines.push('', '💳 طرق الدفع:', ...group((t) => t.pay).map(([k, e]) => `• ${k}: ${fmt(e.total)} (${e.n} فاتورة)`));
  const users = group((t) => t.user);
  if (users.length > 1) lines.push('', '👤 البيّاعين:', ...users.map(([k, e]) => `• ${k}: ${fmt(e.total)} — مكسب ${fmt(e.margin)} (${e.n} فاتورة)`));

  if (mode === 'list' || period.from === period.to) {
    lines.push('', `🧾 الفواتير${ts.length > 25 ? ` (آخر 25 من ${ts.length})` : ''}:`);
    for (const t of ts.slice(-25))
      lines.push(`• ${period.from === period.to ? '' : `${t.date.slice(8)}/${t.date.slice(5, 7)} `}${t.time} — ${fmt(t.total)} (${t.pay}${t.customer ? ` — ${t.customer}` : ''}) مكسب ${fmt(t.margin)}\n   ${t.items.slice(0, 90)}`);
  } else {
    const prods = new Map();
    for (const t of ts) for (const it of parseItems(t.items)) prods.set(it.name, (prods.get(it.name) || 0) + it.qty);
    const top = [...prods.entries()].sort((a, b) => b[1] - a[1]).slice(0, 7);
    if (top.length) lines.push('', '🔥 أكتر أصناف اتباعت:', ...top.map(([n, q]) => `• ${n}: ${r2(q)}`));
    const custs = group((t) => t.customer).filter(([k]) => k !== '—').slice(0, 5);
    if (custs.length) lines.push('', '🤝 أكتر عملاء:', ...custs.map(([k, e]) => `• ${k}: ${fmt(e.total)} (${e.n} فاتورة)`));
  }
  if (note) lines.push('', note);
  return lines.join('\n').slice(0, 4000);
}

/* ---------- حسابات العملاء والموردين ---------- */

// في دفتر إنياد: "أعطيت" = ادّيناه (بضاعة/فلوس) فهو عليه لينا، "أخذت" = خدنا منه فاحنا علينا له
const balanceLine = (a) => {
  const net = r2(a.gave - a.took);
  const state = net > 0 ? `عليه لينا *${fmt(net)}* ج.م` : net < 0 ? `ليه عندنا *${fmt(-net)}* ج.م` : 'حسابه خالص ✅';
  return `• ${a.name}: ${state}${a.buys ? ` — اشترى بـ ${fmt(a.buys)}` : ''}${a.last ? ` — آخر تعامل ${a.last}` : ''}`;
};

export async function accountLookup(env, who, kind) {
  const kinds = kind === 'supplier' ? ['suppliers'] : kind === 'customer' ? ['customers'] : ['customers', 'suppliers'];
  const key = normalizeAr(who).replace(/^(ال)?(حاج|استاذ|الاستاذ|ا\/|م\/|مهندس|الشيخ|شيخ)\s+/, '');
  const words = key.split(' ').filter((w) => w.length >= 2);
  const out = [];
  let any = false;
  for (const k of kinds) {
    const data = await env.MEMORY.get(`acct:${k}`, 'json');
    if (!data) continue;
    any = true;
    const hits = data.list.filter((a) => words.length && words.every((w) => normalizeAr(a.name).includes(w)));
    if (hits.length) out.push(`${k === 'suppliers' ? '🏭 الموردين' : '👥 العملاء'} (حسب ملف ${new Date(data.at).toLocaleDateString('ar-EG')}):`, ...hits.slice(0, 8).map(balanceLine));
  }
  if (!any) return 'لسه مفيش ملف حسابات عندي. ابعتلي ملف "العملاء" و"الموردين" Excel من إنياد.';
  return out.length ? out.join('\n') : `مش لاقي "${who}" في العملاء ولا الموردين 🤔 جرّب جزء تاني من الاسم.`;
}

/** أكتر ناس عليهم فلوس لينا (عملاء)، أو أكتر موردين لهم عندنا. */
export async function topBalances(env, kind) {
  const data = await env.MEMORY.get(`acct:${kind}`, 'json');
  if (!data) return `لسه مفيش ملف ${kind === 'suppliers' ? 'الموردين' : 'العملاء'} عندي. ابعته Excel من إنياد.`;
  const withNet = data.list.map((a) => ({ ...a, net: a.gave - a.took }));
  const owe = withNet.filter((a) => a.net > 0).sort((a, b) => b.net - a.net);
  const owed = withNet.filter((a) => a.net < 0).sort((a, b) => a.net - b.net);
  const sumNet = (arr) => fmt(Math.abs(arr.reduce((s, a) => s + a.net, 0)));
  const title = kind === 'suppliers' ? '🏭 حسابات الموردين' : '👥 حسابات العملاء';
  const lines = [`${title} (ملف ${new Date(data.at).toLocaleDateString('ar-EG')}):`];
  if (kind === 'suppliers') {
    lines.push('', `احنا علينا للموردين: *${sumNet(owed)}* ج.م (${owed.length} مورد)`, ...owed.slice(0, 15).map(balanceLine));
    if (owe.length) lines.push('', `موردين عليهم لينا: ${sumNet(owe)} ج.م`, ...owe.slice(0, 5).map(balanceLine));
  } else {
    lines.push('', `عملاء عليهم فلوس لينا: *${sumNet(owe)}* ج.م (${owe.length} عميل)`, ...owe.slice(0, 15).map(balanceLine));
    if (owed.length) lines.push('', `عملاء ليهم عندنا (دافعين مقدم): ${sumNet(owed)} ج.م`, ...owed.slice(0, 5).map(balanceLine));
  }
  return lines.join('\n').slice(0, 4000);
}

/* ---------- تحليل الديون (لينا وعلينا) ---------- */

/** "14 أبريل 2026" → عدد الأيام من ساعتها (أو null). */
function daysSince(s, today) {
  const d = isoDate(s);
  return d ? Math.round((new Date(`${today}T00:00:00Z`) - new Date(`${d}T00:00:00Z`)) / DAY) : null;
}

/**
 * صورة الديون بالأرقام: اللي لينا (بأعمار الديون)، اللي علينا، والبيع الآجل الأخير.
 * @returns {Promise<{text:string, facts:string}|null>} text = للمدير، facts = للمساعد عشان يدّي أفكار
 */
export async function debtAnalysis(env) {
  const cus = await env.MEMORY.get('acct:customers', 'json');
  const sup = await env.MEMORY.get('acct:suppliers', 'json');
  if (!cus && !sup) return null;
  const today = cairoToday();
  const L = [];
  const F = [];

  let recv = 0;
  if (cus) {
    const owe = cus.list
      .map((a) => ({ ...a, net: a.gave - a.took, days: daysSince(a.last, today) }))
      .filter((a) => a.net > 0)
      .sort((a, b) => b.net - a.net);
    recv = owe.reduce((s, a) => s + a.net, 0);
    const prepaid = cus.list.filter((a) => a.took > a.gave).reduce((s, a) => s + (a.took - a.gave), 0);
    const bucket = (lo, hi) => owe.filter((a) => a.days != null && a.days >= lo && a.days < hi);
    const groups = [
      ['🟢 اتعاملوا آخر شهر', bucket(0, 30)],
      ['🟡 من 1 لـ 3 شهور', bucket(30, 90)],
      ['🟠 من 3 لـ 6 شهور', bucket(90, 180)],
      ['🔴 أكتر من 6 شهور (ديون نايمة)', bucket(180, 1e9)],
      ['⚪ من غير تاريخ تعامل', owe.filter((a) => a.days == null)],
    ];
    const sum = (arr) => arr.reduce((s, a) => s + a.net, 0);
    const top5 = sum(owe.slice(0, 5));
    L.push(`💰 *لينا بره: ${fmt(recv)} ج.م* عند ${owe.length} عميل`);
    for (const [label, arr] of groups) if (arr.length) L.push(`${label}: ${fmt(sum(arr))} (${arr.length} عميل)`);
    L.push(`أكبر 5 عملاء شايلين ${Math.round((top5 / recv) * 100)}% من الديون.`);
    if (prepaid) L.push(`عملاء دافعين مقدم (ليهم عندنا): ${fmt(prepaid)} ج.م`);
    const old = bucket(180, 1e9).slice(0, 6);
    if (old.length) L.push('', '🔴 أكبر ديون نايمة:', ...old.map((a) => `• ${a.name}: ${fmt(a.net)} — آخر تعامل من ${Math.round(a.days / 30)} شهر`));
    F.push(
      `إجمالي لينا عند العملاء ${fmt(recv)} عند ${owe.length} عميل. أكبر 5 = ${Math.round((top5 / recv) * 100)}%.`,
      ...groups.map(([l, arr]) => `${l}: ${fmt(sum(arr))} (${arr.length})`),
      `أكبر 10 مدينين: ${owe.slice(0, 10).map((a) => `${a.name} ${fmt(a.net)}${a.days != null ? ` (آخر تعامل من ${a.days} يوم، اشترى إجمالي ${fmt(a.buys)})` : ' (من غير تاريخ)'}`).join('؛ ')}`,
      `ديون صغيرة أقل من 1000: ${owe.filter((a) => a.net < 1000).length} عميل بإجمالي ${fmt(sum(owe.filter((a) => a.net < 1000)))}.`,
    );
  }
  let pay = 0;
  if (sup) {
    const owed = sup.list.map((a) => ({ ...a, net: a.took - a.gave })).filter((a) => a.net > 0).sort((a, b) => b.net - a.net);
    pay = owed.reduce((s, a) => s + a.net, 0);
    L.push('', `🏭 *علينا للموردين: ${fmt(pay)} ج.م* لـ ${owed.length} مورد`);
    if (owed[0]) L.push(`أكبرهم ${owed[0].name}: ${fmt(owed[0].net)} (${Math.round((owed[0].net / pay) * 100)}%)`);
    F.push(`علينا للموردين ${fmt(pay)}: ${owed.slice(0, 6).map((a) => `${a.name} ${fmt(a.net)}`).join('؛ ')}.`);
  }
  if (cus && sup) {
    const net = recv - pay;
    L.push('', net >= 0 ? `⚖️ الصافي: لينا أكتر من علينا بـ ${fmt(net)} ج.م` : `⚖️ الصافي: علينا أكتر من لينا بـ ${fmt(-net)} ج.م`);
    F.push(`الصافي (لينا - علينا) = ${fmt(net)}.`);
  }
  // البيع الآجل في آخر 30 يوم من ملف المبيعات
  const ts = await ticketsIn(env, addDays(today, -30), today);
  if (ts.length) {
    const credit = ts.filter((t) => /آجل/.test(t.pay));
    const all = ts.reduce((s, t) => s + t.total, 0);
    const cr = credit.reduce((s, t) => s + t.total, 0);
    const byC = new Map();
    for (const t of credit) byC.set(t.customer || '—', (byC.get(t.customer || '—') || 0) + t.total);
    L.push('', `🧾 آخر 30 يوم (من الملفات): ${Math.round((cr / all) * 100)}% من المبيعات آجل (${fmt(cr)} من ${fmt(all)})`);
    F.push(
      `آخر 30 يوم: مبيعات ${fmt(all)}، منها آجل ${fmt(cr)} (${Math.round((cr / all) * 100)}%). أكبر الشاريين آجل: ` +
        [...byC.entries()].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${fmt(v)}`).join('؛ '),
    );
  }
  const date = cus?.at || sup?.at;
  return {
    text: `📒 *لينا وعلينا* (ملف ${new Date(date).toLocaleDateString('ar-EG')}):\n\n${L.join('\n')}`.slice(0, 3500),
    facts: F.join('\n'),
  };
}
