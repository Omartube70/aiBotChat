/**
 * سيستم الصيانة (ويب) — نفس داتا البوت (maint:data في KV/D1).
 * صفحة واحدة + API تحت /maint. دخول بكود: كود إدارة (كتابة) وكود مشاهدة (قراءة بس).
 * بيشتغل أوفلاين (Service Worker + طابور رفع محلي يترفع أول ما النت يرجع).
 *
 * المسارات:
 *   GET  /maint                     صفحة السيستم
 *   GET  /maint/sw.js               Service Worker (تشغيل أوفلاين)
 *   GET  /maint/manifest.webmanifest
 *   POST /maint/api/login           { code } → { role, token }
 *   GET  /maint/api/summary         إجماليات الشهر الحالي + المناطق
 *   GET  /maint/api/buildings       قائمة مختصرة (كلها — الفلترة بتتعمل في المتصفح)
 *   GET  /maint/api/building        ?id=       ملف كامل
 *   GET  /maint/api/broadcast       أرقام رؤساء الاتحادات
 *   POST /maint/api/pay             { id, month, amount }           [إدارة]
 *   POST /maint/api/event           { id, type, text }             [إدارة]
 *   POST /maint/api/set             { id, field, value }           [إدارة]
 *   POST /maint/api/add             { num, value, paid, ... }      [إدارة]
 *   GET  /maint/api/photo           ?id=   بايتات الصورة
 *   POST /maint/api/photo           { bid, b64, mime, caption }    [إدارة]
 */
import { loadMaint, saveMaint, cairoNow, MONTHS_AR, monthsOf, setMonthY, yearsOf, yearNow } from './maintenance.js';
import { ICON_PNG_B64 } from './mainticon.js';

const PHOTO_KEY = (id) => `maint:photo:${id}`;
const TOKEN_TTL = 30 * 24 * 3600; // 30 يوم

/* ---------- أدوات ---------- */
const te = new TextEncoder();
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
function secretOf(env) {
  return env.MAINT_SECRET || env.DEBUG_KEY || 'maint-dev-secret-change-me';
}
function adminCode(env) {
  return env.MAINT_ADMIN_CODE || '2026';
}
function viewCode(env) {
  return env.MAINT_VIEW_CODE || '1000';
}
function mgrCode(env) {
  return env.MAINT_MANAGER_CODE || '0000';
}
/** الأكواد الحيّة: من KV لو المدير غيّرها، وإلا من البيئة. extra = أكواد موظفين إضافية بصلاحيات. */
async function maintCodes(env) {
  const c = (await env.MEMORY.get('maint:codes', 'json')) || {};
  return {
    admin: c.admin || adminCode(env), view: c.view || viewCode(env), manager: c.manager || mgrCode(env),
    extra: Array.isArray(c.extra) ? c.extra : [],
  };
}
/** يحدّد الدور من الكود (الأساسية + الإضافية). */
function roleForCode(cc, code) {
  if (!code) return null;
  if (code === cc.manager) return 'manager';
  if (code === cc.admin) return 'admin';
  if (code === cc.view) return 'view';
  const ex = (cc.extra || []).find((e) => String(e.code) === String(code));
  if (ex) return ['manager', 'admin', 'view'].includes(ex.role) ? ex.role : 'view';
  return null;
}
async function loadStaff(env) {
  const d = (await env.MEMORY.get('maint:staff', 'json')) || { seq: 0, emps: [] };
  if (!Array.isArray(d.emps)) d.emps = [];
  return d;
}
async function saveStaff(env, d) {
  await env.MEMORY.put('maint:staff', JSON.stringify(d));
}
/** أيام الشغل بين تاريخين (شاملة)، الجمعة إجازة مش محسوبة. */
function workDays(startIso, endIso) {
  if (!startIso) return 0;
  const s = new Date(String(startIso).slice(0, 10) + 'T12:00:00Z');
  const e = new Date(String(endIso || new Date().toISOString()).slice(0, 10) + 'T12:00:00Z');
  if (isNaN(s) || isNaN(e) || e < s) return 0;
  let n = 0, i = 0;
  for (const d = new Date(s); d <= e && i < 800; d.setUTCDate(d.getUTCDate() + 1), i++) {
    if (d.getUTCDay() !== 5) n++; // 5 = الجمعة
  }
  return n;
}
function empPeriodStart(e) { return e.periodStart || e.lastPaidAt || e.createdAt || null; }
function empNet(e) {
  const sal = Number(e.salary) || 0;
  const daily = sal / 24;
  const wd = workDays(empPeriodStart(e), cairoNow().iso);
  const gross = wd * daily;
  return Math.round(
    gross - (Number(e.absDays) || 0) * daily - (Number(e.advAmount) || 0) - (Number(e.dedAmount) || 0) + (Number(e.bonAmount) || 0),
  );
}
/** تكلفة منتج من كتالوج إنياد بالاسم (أقرب تطابق) — للـ "السعر الأساسي" في قطع الغيار. */
async function productCost(env, name) {
  const snap = await env.MEMORY.get('catalog:snapshot', 'json');
  const prods = (snap && snap.products) || [];
  const nn = (s) => String(s || '').toLowerCase().replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/[ىي]/g, 'ي').replace(/\s+/g, ' ').trim();
  const q = nn(name);
  if (!q) return null;
  let best = null;
  for (const p of prods) {
    const pn = nn(p.name);
    if (pn === q || pn.includes(q) || q.includes(pn)) {
      const cost = Number(p.ourCost) || null;
      if (cost) { best = { name: p.name, cost, price: p.price || null }; if (pn === q) break; }
    }
  }
  return best;
}
const EXP_KEY = 'maint:expenses';
async function hmacHex(secret, msg) {
  const key = await crypto.subtle.importKey('raw', te.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, te.encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function makeToken(role, env) {
  const exp = Math.floor(Date.now() / 1000) + TOKEN_TTL;
  const body = `${role}.${exp}`;
  return `${body}.${await hmacHex(secretOf(env), body)}`;
}
async function verifyToken(token, env) {
  if (!token) return null;
  const parts = String(token).split('.');
  if (parts.length !== 3) return null;
  const [role, exp, sig] = parts;
  if (!['admin', 'view', 'manager'].includes(role)) return null;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return null;
  const good = await hmacHex(secretOf(env), `${role}.${exp}`);
  if (good !== sig) return null;
  return role;
}
function bearer(request) {
  const h = request.headers.get('Authorization') || '';
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : '';
}
function b64ToBytes(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
function findById(data, id) {
  return data.buildings.find((b) => b.id === id || b.key === id);
}
function latinDigits(s) {
  return String(s == null ? '' : s)
    .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d));
}
function monthStatus(b, m, year) {
  return monthsOf(b, year || yearNow())[m] != null;
}
function hasOpenFault(b) {
  const faults = (b.events || []).filter((e) => e.type === 'fault');
  if (!faults.length) return false;
  const lastFault = faults[faults.length - 1].at;
  const lastFix = (b.events || []).filter((e) => e.type === 'maintenance').slice(-1)[0];
  return !lastFix || lastFix.at < lastFault;
}

/* ---------- المعالج ---------- */
export async function handleMaintWeb(request, url, env) {
  const { pathname } = url;
  const { method } = request;
  if (pathname === '/maint' || pathname === '/maint/') {
    return new Response(APP_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  if (pathname === '/maint/sw.js') {
    return new Response(SW_JS, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Service-Worker-Allowed': '/maint', 'Cache-Control': 'no-cache' } });
  }
  if (pathname === '/maint/manifest.webmanifest') {
    return new Response(MANIFEST, { headers: { 'Content-Type': 'application/manifest+json; charset=utf-8' } });
  }
  if (pathname === '/maint/icon.svg') {
    return new Response(ICON_SVG, { headers: { 'Content-Type': 'image/svg+xml; charset=utf-8', 'Cache-Control': 'public, max-age=86400' } });
  }
  if (pathname === '/maint/icon-512.png') {
    return new Response(b64ToBytes(ICON_PNG_B64), { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' } });
  }
  if (!pathname.startsWith('/maint/api/')) return null;

  // تسجيل الدخول
  if (pathname === '/maint/api/login' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const code = latinDigits(String(body.code || '').trim());
    const cc = await maintCodes(env);
    const role = roleForCode(cc, code);
    if (!role) return json({ ok: false, error: 'الكود غلط' }, 401);
    return json({ ok: true, role, token: await makeToken(role, env) });
  }

  // كل الباقي محتاج توكن صالح
  const role = await verifyToken(bearer(request), env);
  if (!role) return json({ ok: false, error: 'محتاج تسجيل دخول' }, 401);
  const isManager = role === 'manager';
  const canWrite = role === 'admin' || role === 'manager';
  const needWrite = () => json({ ok: false, error: 'صلاحيتك مشاهدة بس' }, 403);
  const needMgr = () => json({ ok: false, error: 'للمدير بس' }, 403);

  const data = await loadMaint(env);
  const now = cairoNow();

  if (pathname === '/maint/api/years' && method === 'GET') {
    return json({ ok: true, years: yearsOf(data), current: yearNow() });
  }

  if (pathname === '/maint/api/summary' && method === 'GET') {
    const active = data.buildings.filter((b) => b.active !== false);
    const yr = Number(url.searchParams.get('year')) || yearNow();
    const m = Number(url.searchParams.get('month')) || now.m;
    const expected = active.reduce((s, b) => s + (b.paid || 0), 0);
    const collected = active.reduce((s, b) => s + (monthsOf(b, yr)[m] || 0), 0);
    const unpaid = active.filter((b) => !monthStatus(b, m, yr));
    const zones = {};
    for (const b of active) zones[b.zone || '—'] = (zones[b.zone || '—'] || 0) + 1;
    return json({
      ok: true, role, year: yr, currentYear: yearNow(), currentMonth: now.m, month: m, monthName: MONTHS_AR[m - 1],
      total: active.length, expected, collected, due: expected - collected, unpaidCount: unpaid.length,
      faults: active.filter(hasOpenFault).length,
      zones: Object.keys(zones).sort().map((z) => ({ zone: z, count: zones[z] })),
    });
  }

  if (pathname === '/maint/api/buildings' && method === 'GET') {
    const yr = Number(url.searchParams.get('year')) || yearNow();
    const m = Number(url.searchParams.get('month')) || now.m;
    let list = data.buildings.filter((b) => b.active !== false);
    list = list.sort((a, b) => String(a.zone).localeCompare(String(b.zone), 'ar') || (a.number || 0) - (b.number || 0));
    return json({
      ok: true, year: yr, month: m,
      buildings: list.slice(0, 1000).map((b) => ({
        id: b.id, num: b.num, zone: b.zone, name: b.name || '', value: b.value, paid: b.paid,
        paidThisMonth: monthStatus(b, m, yr), fault: hasOpenFault(b),
      })),
    });
  }

  if (pathname === '/maint/api/building' && method === 'GET') {
    const b = findById(data, url.searchParams.get('id'));
    if (!b) return json({ ok: false, error: 'مش موجودة' }, 404);
    return json({ ok: true, role, building: b });
  }

  if (pathname === '/maint/api/pay' && method === 'POST') {
    if (!canWrite) return needWrite();
    const body = await request.json().catch(() => ({}));
    const b = findById(data, body.id);
    if (!b) return json({ ok: false, error: 'مش موجودة' }, 404);
    const m = Number(body.month) || now.m;
    const yr = Number(body.year) || yearNow();
    const amount = Number(body.amount);
    if (!Number.isFinite(amount)) return json({ ok: false, error: 'مبلغ غلط' }, 400);
    setMonthY(b, yr, m, amount);
    if (String(b.year) === String(yr)) { b.months = b.months || {}; b.months[m] = amount; }
    b.events = b.events || [];
    b.events.push({ type: 'payment', text: `اتحصّل ${amount} ج عن ${MONTHS_AR[m - 1]} ${yr}`, amount, month: m, year: yr, by: role, at: body.at || now.iso });
    b.updatedAt = now.iso;
    await saveMaint(env, data);
    return json({ ok: true, building: b });
  }

  if (pathname === '/maint/api/event' && method === 'POST') {
    if (!canWrite) return needWrite();
    const body = await request.json().catch(() => ({}));
    const b = findById(data, body.id);
    if (!b) return json({ ok: false, error: 'مش موجودة' }, 404);
    const type = ['fault', 'problem', 'measure', 'part', 'maintenance', 'pending', 'note'].includes(body.type) ? body.type : 'note';
    const text = String(body.text || '').trim();
    if (!text && type !== 'maintenance') return json({ ok: false, error: 'اكتب التفاصيل' }, 400);
    b.events = b.events || [];
    const ev = { type, text: text || 'اتعملت صيانة', by: role, at: body.at || now.iso };
    // قطع غيار / مقايسة / شغل خارجي: إيراد + تكلفة → مكسب
    if (['part', 'measure'].includes(type) && (body.revenue != null || body.cost != null)) {
      ev.revenue = Number(body.revenue) || 0;
      ev.cost = Number(body.cost) || 0;
      ev.profit = ev.revenue - ev.cost;
    }
    b.events.push(ev);
    b.updatedAt = now.iso;
    await saveMaint(env, data);
    return json({ ok: true, building: b });
  }

  if (pathname === '/maint/api/set' && method === 'POST') {
    if (!canWrite) return needWrite();
    const body = await request.json().catch(() => ({}));
    const b = findById(data, body.id);
    if (!b) return json({ ok: false, error: 'مش موجودة' }, 404);
    const allowed = ['name', 'address', 'collector', 'contacts', 'driveFolder', 'value', 'paid', 'active'];
    const f = body.field;
    if (!allowed.includes(f)) return json({ ok: false, error: 'حقل غير مسموح' }, 400);
    if (f === 'value' || f === 'paid') b[f] = Number(body.value) || 0;
    else if (f === 'active') b.active = !!body.value;
    else if (f === 'contacts') {
      b.contacts = (Array.isArray(body.value) ? body.value : [])
        .map((c) => ({ name: String(c.name || '').trim(), phone: String(c.phone || '').replace(/[^\d+]/g, '') }))
        .filter((c) => c.name || c.phone)
        .slice(0, 2);
    } else b[f] = String(body.value || '');
    if (b.value != null && b.paid != null) b.guard = b.value - b.paid;
    b.updatedAt = now.iso;
    await saveMaint(env, data);
    return json({ ok: true, building: b });
  }

  if (pathname === '/maint/api/add' && method === 'POST') {
    if (!canWrite) return needWrite();
    const body = await request.json().catch(() => ({}));
    const num = String(body.num || '').trim();
    if (!num) return json({ ok: false, error: 'اكتب رقم العملية' }, 400);
    const key = num.toLowerCase().replace(/[أإآ]/g, 'ا').replace(/\s+/g, '');
    if (data.buildings.some((b) => b.key === key)) return json({ ok: false, error: 'العملية موجودة' }, 409);
    const zm = num.replace(/[أإآ]/g, 'ا').match(/(\d+)\s*([ابتثجحخدذرزسشصضطظعغفقكلمنهوي])/);
    const b = {
      id: `b${++data.seq}`, key, num, number: zm ? Number(zm[1]) : null, zone: zm ? (zm[2] === 'ا' ? 'أ' : zm[2]) : '',
      name: body.name || '', address: body.address || '', value: Number(body.value) || 0, paid: Number(body.paid) || 0,
      guard: (Number(body.value) || 0) - (Number(body.paid) || 0), collector: body.collector || '',
      contacts: [], driveFolder: body.driveFolder || '', active: true, year: now.y, months: {}, events: [], photos: [],
      createdAt: now.iso, updatedAt: now.iso,
    };
    data.buildings.push(b);
    await saveMaint(env, data);
    return json({ ok: true, building: b });
  }

  if (pathname === '/maint/api/broadcast' && method === 'GET') {
    const contactsOf = (b) => (Array.isArray(b.contacts) && b.contacts.length ? b.contacts : (b.unionHead || b.unionPhone ? [{ name: b.unionHead, phone: b.unionPhone }] : []));
    const out = [];
    const seen = new Set();
    for (const b of data.buildings) {
      if (b.active === false) continue;
      for (const c of contactsOf(b)) {
        if (!c.phone) continue;
        const phone = String(c.phone).replace(/[^\d]/g, '').replace(/^0/, '20');
        if (seen.has(phone)) continue;
        seen.add(phone);
        out.push({ num: b.num, name: c.name || '', phone });
      }
    }
    return json({ ok: true, count: out.length, contacts: out });
  }

  /* ---------- الإعدادات: الأكواد والصلاحيات (المدير بس) ---------- */
  if (pathname === '/maint/api/settings' && method === 'GET') {
    if (!isManager) return needMgr();
    const cc = await maintCodes(env);
    return json({ ok: true, admin: cc.admin, view: cc.view, manager: cc.manager, extra: cc.extra });
  }
  if (pathname === '/maint/api/settings/code' && method === 'POST') {
    if (!isManager) return needMgr();
    const b = await request.json().catch(() => ({}));
    if (!['admin', 'view', 'manager'].includes(b.which)) return json({ ok: false, error: 'نوع غلط' }, 400);
    const val = String(b.value || '').replace(/\s/g, '');
    if (!val) return json({ ok: false, error: 'اكتب الكود' }, 400);
    const c = (await env.MEMORY.get('maint:codes', 'json')) || {};
    c[b.which] = val;
    await env.MEMORY.put('maint:codes', JSON.stringify(c));
    return json({ ok: true });
  }
  if (pathname === '/maint/api/settings/extra' && method === 'POST') {
    if (!isManager) return needMgr();
    const b = await request.json().catch(() => ({}));
    const code = String(b.code || '').replace(/\s/g, '');
    const name = String(b.name || '').trim();
    const r = ['manager', 'admin', 'view'].includes(b.role) ? b.role : 'view';
    if (!code || !name) return json({ ok: false, error: 'اكتب الاسم والكود' }, 400);
    const c = (await env.MEMORY.get('maint:codes', 'json')) || {};
    c.extra = (Array.isArray(c.extra) ? c.extra : []).filter((e) => String(e.code) !== code);
    c.extra.push({ name, code, role: r });
    await env.MEMORY.put('maint:codes', JSON.stringify(c));
    return json({ ok: true });
  }
  if (pathname === '/maint/api/settings/extra-remove' && method === 'POST') {
    if (!isManager) return needMgr();
    const b = await request.json().catch(() => ({}));
    const c = (await env.MEMORY.get('maint:codes', 'json')) || {};
    c.extra = (Array.isArray(c.extra) ? c.extra : []).filter((e) => String(e.code) !== String(b.code));
    await env.MEMORY.put('maint:codes', JSON.stringify(c));
    return json({ ok: true });
  }

  /* ---------- تكلفة منتج (للسعر الأساسي في قطع الغيار) ---------- */
  if (pathname === '/maint/api/product-cost' && method === 'GET') {
    if (!canWrite) return needWrite();
    const m = await productCost(env, url.searchParams.get('name') || '');
    return json({ ok: true, match: m });
  }

  /* ---------- نثريات (مصاريف) ---------- */
  if (pathname === '/maint/api/expenses' && method === 'GET') {
    if (!canWrite) return needWrite();
    const items = (await env.MEMORY.get(EXP_KEY, 'json')) || [];
    const from = url.searchParams.get('from') || '', to = url.searchParams.get('to') || '';
    const inR = (at) => (!from || at >= from) && (!to || at <= to + 'T23:59:59');
    const sel = items.filter((x) => inR(x.at));
    return json({ ok: true, items: sel.slice(-200).reverse(), total: sel.reduce((s, x) => s + (Number(x.amount) || 0), 0) });
  }
  if (pathname === '/maint/api/expenses/add' && method === 'POST') {
    if (!canWrite) return needWrite();
    const b = await request.json().catch(() => ({}));
    const items = (await env.MEMORY.get(EXP_KEY, 'json')) || [];
    items.push({ id: 'x' + Date.now().toString(36), amount: Number(b.amount) || 0, note: String(b.note || ''), by: role, at: now.iso });
    await env.MEMORY.put(EXP_KEY, JSON.stringify(items.slice(-2000)));
    return json({ ok: true });
  }

  /* ---------- تقرير الأرباح بفترة (المدير بس) ---------- */
  if (pathname === '/maint/api/profit' && method === 'GET') {
    if (!isManager) return needMgr();
    const from = url.searchParams.get('from') || '', to = url.searchParams.get('to') || '';
    const inR = (at) => at && (!from || at >= from) && (!to || at <= to + 'T23:59:59');
    let maintCollected = 0, partsRev = 0, partsCost = 0;
    for (const bld of data.buildings) {
      for (const e of bld.events || []) {
        if (!inR(e.at)) continue;
        if (e.type === 'payment') maintCollected += Number(e.amount) || 0;
        else if ((e.type === 'part' || e.type === 'measure') && (e.revenue != null || e.cost != null)) {
          partsRev += Number(e.revenue) || 0; partsCost += Number(e.cost) || 0;
        }
      }
    }
    const partsNet = partsRev - partsCost;
    const workersShare = Math.round(partsNet / 3);
    const shopPartsShare = partsNet - workersShare;
    const expItems = (await env.MEMORY.get(EXP_KEY, 'json')) || [];
    const petty = expItems.filter((x) => inR(x.at)).reduce((s, x) => s + (Number(x.amount) || 0), 0);
    const sd = await loadStaff(env);
    let payouts = 0;
    for (const e of sd.emps) for (const h of e.history || []) if (inR(h.paidAt)) payouts += Number(h.net) || 0;
    const shopNet = maintCollected + shopPartsShare - petty - payouts;
    return json({
      ok: true, from, to,
      maintCollected, partsRev, partsCost, partsNet, workersShare, shopPartsShare, petty, payouts, shopNet,
    });
  }

  /* ---------- الموظفين والرواتب ---------- */
  if (pathname === '/maint/api/staff' && method === 'GET') {
    const sd = await loadStaff(env);
    const emps = sd.emps.map((e) => {
      const base = { id: e.id, name: e.name, advAmount: Number(e.advAmount) || 0, absDays: Number(e.absDays) || 0, lastPaidAt: e.lastPaidAt || null };
      if (isManager) { base.salary = Number(e.salary) || 0; base.net = empNet(e); base.dayVal = Math.round((Number(e.salary) || 0) / 24); }
      return base;
    });
    return json({ ok: true, role, isManager, canWrite, emps });
  }
  if (pathname === '/maint/api/staff/detail' && method === 'GET') {
    const sd = await loadStaff(env);
    const e = sd.emps.find((x) => x.id === url.searchParams.get('id'));
    if (!e) return json({ ok: false, error: 'مش موجود' }, 404);
    const out = { id: e.id, name: e.name, advAmount: Number(e.advAmount) || 0, absDays: Number(e.absDays) || 0, dedAmount: Number(e.dedAmount) || 0, bonAmount: Number(e.bonAmount) || 0, events: e.events || [], history: e.history || [], lastPaidAt: e.lastPaidAt || null, periodStart: empPeriodStart(e) };
    if (isManager) {
      const wd = workDays(empPeriodStart(e), cairoNow().iso);
      out.salary = Number(e.salary) || 0; out.net = empNet(e); out.dayVal = Math.round((Number(e.salary) || 0) / 24);
      out.workDays = wd; out.gross = Math.round(wd * ((Number(e.salary) || 0) / 24));
    }
    return json({ ok: true, isManager, canWrite, emp: out });
  }
  if (pathname === '/maint/api/staff/add' && method === 'POST') {
    if (!isManager) return needMgr();
    const b = await request.json().catch(() => ({}));
    const name = String(b.name || '').trim();
    if (!name) return json({ ok: false, error: 'اكتب اسم الموظف' }, 400);
    const sd = await loadStaff(env);
    sd.emps.push({ id: `e${++sd.seq}`, name, salary: Number(b.salary) || 0, advAmount: 0, absDays: 0, dedAmount: 0, bonAmount: 0, events: [], history: [], periodStart: now.iso, createdAt: now.iso, updatedAt: now.iso });
    await saveStaff(env, sd);
    return json({ ok: true });
  }
  if (pathname === '/maint/api/staff/salary' && method === 'POST') {
    if (!isManager) return needMgr();
    const b = await request.json().catch(() => ({}));
    const sd = await loadStaff(env);
    const e = sd.emps.find((x) => x.id === b.id);
    if (!e) return json({ ok: false, error: 'مش موجود' }, 404);
    e.salary = Number(b.salary) || 0; e.updatedAt = now.iso;
    await saveStaff(env, sd);
    return json({ ok: true });
  }
  if (pathname.match(/^\/maint\/api\/staff\/(advance|absence|deduction|bonus)$/) && method === 'POST') {
    if (!canWrite) return needWrite();
    const kind = pathname.split('/').pop();
    const b = await request.json().catch(() => ({}));
    const sd = await loadStaff(env);
    const e = sd.emps.find((x) => x.id === b.id);
    if (!e) return json({ ok: false, error: 'مش موجود' }, 404);
    e.events = e.events || [];
    const note = String(b.note || '');
    if (kind === 'advance') { const a = Number(b.amount) || 0; e.advAmount = (Number(e.advAmount) || 0) + a; e.events.push({ type: 'advance', amount: a, text: note, by: role, at: now.iso }); }
    else if (kind === 'deduction') { const a = Number(b.amount) || 0; e.dedAmount = (Number(e.dedAmount) || 0) + a; e.events.push({ type: 'deduction', amount: a, text: note, by: role, at: now.iso }); }
    else if (kind === 'bonus') { const a = Number(b.amount) || 0; e.bonAmount = (Number(e.bonAmount) || 0) + a; e.events.push({ type: 'bonus', amount: a, text: note, by: role, at: now.iso }); }
    else { const d = Number(b.days) || 0; e.absDays = (Number(e.absDays) || 0) + d; e.events.push({ type: 'absence', days: d, text: note, by: role, at: now.iso }); }
    e.updatedAt = now.iso;
    await saveStaff(env, sd);
    return json({ ok: true });
  }
  if (pathname === '/maint/api/staff/paid' && method === 'POST') {
    if (!isManager) return needMgr();
    const b = await request.json().catch(() => ({}));
    const sd = await loadStaff(env);
    const e = sd.emps.find((x) => x.id === b.id);
    if (!e) return json({ ok: false, error: 'مش موجود' }, 404);
    e.history = e.history || [];
    e.history.push({ paidAt: now.iso, salary: Number(e.salary) || 0, advAmount: Number(e.advAmount) || 0, absDays: Number(e.absDays) || 0, dedAmount: Number(e.dedAmount) || 0, bonAmount: Number(e.bonAmount) || 0, net: empNet(e) });
    e.events = e.events || [];
    e.events.push({ type: 'paid', amount: empNet(e), text: 'تم القبض', by: role, at: now.iso });
    e.advAmount = 0; e.absDays = 0; e.dedAmount = 0; e.bonAmount = 0; e.lastPaidAt = now.iso; e.periodStart = now.iso; e.updatedAt = now.iso;
    await saveStaff(env, sd);
    return json({ ok: true });
  }
  if (pathname === '/maint/api/staff/period' && method === 'POST') {
    if (!isManager) return needMgr();
    const b = await request.json().catch(() => ({}));
    const sd = await loadStaff(env);
    const e = sd.emps.find((x) => x.id === b.id);
    if (!e) return json({ ok: false, error: 'مش موجود' }, 404);
    const dt = String(b.date || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dt)) return json({ ok: false, error: 'تاريخ غير صحيح' }, 400);
    e.periodStart = dt + 'T00:00:00.000Z'; e.updatedAt = now.iso;
    await saveStaff(env, sd);
    return json({ ok: true });
  }
  if (pathname === '/maint/api/staff/remove' && method === 'POST') {
    if (!isManager) return needMgr();
    const b = await request.json().catch(() => ({}));
    const sd = await loadStaff(env);
    sd.emps = sd.emps.filter((x) => x.id !== b.id);
    await saveStaff(env, sd);
    return json({ ok: true });
  }

  if (pathname === '/maint/api/photo' && method === 'GET') {
    const raw = await env.MEMORY.get(PHOTO_KEY(url.searchParams.get('id')), 'json');
    if (!raw) return new Response('not found', { status: 404 });
    return new Response(b64ToBytes(raw.b64), { headers: { 'Content-Type': raw.mime || 'image/jpeg', 'Cache-Control': 'private, max-age=86400' } });
  }

  if (pathname === '/maint/api/photo' && method === 'POST') {
    if (!canWrite) return needWrite();
    const body = await request.json().catch(() => ({}));
    const b = findById(data, body.bid);
    if (!b) return json({ ok: false, error: 'مش موجودة' }, 404);
    const b64 = String(body.b64 || '');
    if (!b64 || b64.length > 2200000) return json({ ok: false, error: 'الصورة كبيرة أو فاضية' }, 400);
    const pid = `p${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
    await env.MEMORY.put(PHOTO_KEY(pid), JSON.stringify({ b64, mime: body.mime || 'image/jpeg' }));
    b.photos = b.photos || [];
    b.photos.push({ id: pid, mime: body.mime || 'image/jpeg', caption: String(body.caption || ''), at: body.at || now.iso, by: role });
    while (b.photos.length > 20) { const old = b.photos.shift(); await env.MEMORY.delete(PHOTO_KEY(old.id)).catch(() => {}); }
    b.events = b.events || [];
    b.events.push({ type: 'photo', text: 'صورة' + (body.caption ? ' — ' + body.caption : ''), by: role, at: body.at || now.iso });
    b.updatedAt = now.iso;
    await saveMaint(env, data);
    return json({ ok: true, building: b });
  }

  return json({ ok: false, error: 'مسار غير معروف' }, 404);
}

/* ================= Service Worker + Manifest ================= */
const SW_JS = `const C='maint-v4';
self.addEventListener('install',function(e){self.skipWaiting();e.waitUntil(caches.open(C).then(function(c){return c.add('/maint');}));});
self.addEventListener('activate',function(e){e.waitUntil((async function(){var ks=await caches.keys();await Promise.all(ks.filter(function(k){return k!==C;}).map(function(k){return caches.delete(k);}));await self.clients.claim();})());});
self.addEventListener('fetch',function(e){
  var u=new URL(e.request.url);
  if(e.request.method!=='GET')return;
  if(u.pathname==='/maint'||u.pathname==='/maint/'){
    e.respondWith((async function(){try{var r=await fetch(e.request);var c=await caches.open(C);c.put('/maint',r.clone());return r;}catch(err){var m=await caches.match('/maint');return m||new Response('offline',{status:503});}})());
  }
});`;

const MANIFEST = JSON.stringify({
  name: 'صيانة توب باور', short_name: 'الصيانة', start_url: '/maint', scope: '/maint',
  display: 'standalone', background_color: '#0F6E56', theme_color: '#0F6E56', lang: 'ar', dir: 'rtl',
  icons: [
    { src: '/maint/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
    { src: '/maint/icon-512.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/maint/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
  ],
});

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
<rect width="512" height="512" rx="104" fill="#0F6E56"/>
<rect x="150" y="104" width="212" height="316" rx="12" fill="#E1F5EE"/>
<g fill="#0F6E56">
<rect x="182" y="140" width="40" height="40" rx="5"/><rect x="236" y="140" width="40" height="40" rx="5"/><rect x="290" y="140" width="40" height="40" rx="5"/>
<rect x="182" y="198" width="40" height="40" rx="5"/><rect x="236" y="198" width="40" height="40" rx="5"/><rect x="290" y="198" width="40" height="40" rx="5"/>
<rect x="182" y="256" width="40" height="40" rx="5"/><rect x="236" y="256" width="40" height="40" rx="5"/><rect x="290" y="256" width="40" height="40" rx="5"/>
<rect x="224" y="330" width="64" height="90" rx="6"/>
</g>
</svg>`;

/* ================= واجهة السيستم (صفحة واحدة) ================= */
const APP_HTML = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<meta name="theme-color" content="#0F6E56">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="الصيانة">
<link rel="manifest" href="/maint/manifest.webmanifest">
<link rel="icon" href="/maint/icon.svg">
<link rel="apple-touch-icon" href="/maint/icon-512.png">
<title>صيانة توب باور</title>
<style>
  :root{--g:#0F6E56;--gd:#085041;--gl:#E1F5EE;--red:#A32D2D;--redl:#FCEBEB;--amb:#854F0B;--ambl:#FAEEDA;--bg:#f4f5f3;--card:#fff;--line:#e5e5e0;--mut:#6b6b66;--txt:#1c1c1a}
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Tahoma,Arial,sans-serif;background:var(--bg);color:var(--txt);font-size:16px}
  .wrap{max-width:560px;margin:0 auto;min-height:100vh;background:var(--bg)}
  header{position:sticky;top:0;z-index:10;background:var(--g);color:var(--gl);padding:12px 16px;display:flex;align-items:center;justify-content:space-between}
  header .t{font-size:17px;font-weight:600}
  .badge{font-size:12px;background:var(--gd);padding:4px 10px;border-radius:20px}
  .netbar{font-size:13px;text-align:center;padding:7px 12px;display:none}
  .netbar.off{display:block;background:var(--ambl);color:var(--amb)}
  .netbar.pend{display:block;background:var(--gl);color:var(--g)}
  .pad{padding:14px 16px}
  .cards{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:14px}
  .c{background:var(--card);border-radius:12px;padding:12px}
  .c .l{font-size:12px;color:var(--mut)}
  .c .v{font-size:21px;font-weight:600;margin-top:2px}
  .green{color:var(--g)} .redc{color:var(--red)}
  .search{display:flex;align-items:center;gap:8px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:0 12px;margin-bottom:12px}
  .search input{border:0;outline:0;padding:11px 0;font-size:15px;width:100%;background:transparent;font-family:inherit}
  .chips{display:flex;gap:6px;overflow-x:auto;padding-bottom:6px;margin-bottom:12px}
  .chip{white-space:nowrap;font-size:14px;background:var(--card);border:1px solid var(--line);color:var(--mut);padding:6px 14px;border-radius:20px;cursor:pointer}
  .chip.on{background:var(--g);color:var(--gl);border-color:var(--g)}
  .row{display:flex;align-items:center;justify-content:space-between;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:11px 13px;margin-bottom:8px;cursor:pointer}
  .row .n{font-size:16px;font-weight:600}
  .row .s{font-size:12px;color:var(--mut);margin-top:2px}
  .tag{font-size:12px;padding:3px 9px;border-radius:20px;margin-right:6px;white-space:nowrap}
  .tg{background:var(--gl);color:var(--g)} .tr{background:var(--redl);color:var(--red)}
  .btn{display:inline-flex;align-items:center;gap:6px;justify-content:center;border:1px solid var(--g);background:var(--g);color:#fff;border-radius:10px;padding:10px 14px;font-size:15px;cursor:pointer;font-family:inherit}
  .btn.o{background:transparent;color:var(--g)}
  .btn.sm{padding:7px 10px;font-size:13px}
  .months{display:grid;grid-template-columns:repeat(4,1fr);gap:7px;margin:8px 0 16px}
  .mo{text-align:center;font-size:12px;border-radius:9px;padding:9px 0;background:#f0efe9;color:var(--mut);cursor:pointer;line-height:1.5}
  .mo.pd{background:var(--gl);color:var(--g)} .mo.un{background:var(--redl);color:var(--red);border:1px solid #f0a0a0}
  .ev{font-size:13px;border-radius:9px;padding:8px 11px;margin-bottom:6px;background:#f0efe9;color:var(--txt)}
  .ev.f{background:var(--redl);color:var(--red)}
  .sec{font-size:13px;color:var(--mut);margin:14px 0 7px;font-weight:600}
  .thumbs{display:flex;gap:8px;flex-wrap:wrap}
  .thumbs img{width:70px;height:70px;object-fit:cover;border-radius:10px;border:1px solid var(--line);cursor:pointer}
  .addp{width:70px;height:70px;border-radius:10px;border:1px dashed var(--line);display:flex;align-items:center;justify-content:center;color:var(--mut);font-size:26px;cursor:pointer;background:var(--card)}
  .overlay{position:fixed;inset:0;background:rgba(0,0,0,.4);display:none;z-index:50;align-items:flex-end;justify-content:center}
  .sheet{background:var(--bg);width:100%;max-width:560px;max-height:92vh;overflow-y:auto;border-radius:18px 18px 0 0}
  .center{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:24px}
  .login{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:26px 22px;width:100%;max-width:340px;text-align:center}
  .login input{width:100%;padding:12px;font-size:20px;text-align:center;letter-spacing:4px;border:1px solid var(--line);border-radius:10px;margin:14px 0;font-family:inherit}
  .err{color:var(--red);font-size:13px;min-height:18px}
  .actions{display:flex;gap:7px;flex-wrap:wrap;margin:4px 0}
  .muted{color:var(--mut);font-size:13px}
  .empty{text-align:center;color:var(--mut);padding:30px 0;font-size:14px}
  a{color:var(--g)}
</style>
</head>
<body>
<div class="wrap" id="app"><div class="empty">...</div></div>
<div class="overlay" id="ov"><div class="sheet" id="sheet"></div></div>
<script>
var T=localStorage.getItem('maint_token')||'', ROLE=localStorage.getItem('maint_role')||'';
var MONTH=0, SELMONTH=0, SELYEAR=0, CURYEAR=0, CURMONTH=0, YEARS=[], ZONE='', Q='', FAULTSONLY=false, CUR=null, SUM=null, LIST=[], DET={}, OFF=false;
var MON=['يناير','فبراير','مارس','ابريل','مايو','يونيو','يوليو','اغسطس','سبتمبر','اكتوبر','نوفمبر','ديسمبر'];
var MSH=['ينا','فبر','مار','ابر','ماي','يون','يول','اغس','سبت','اكت','نوف','ديس'];
var EVT={fault:'🔴 عطل',problem:'⚠️ مشكلة',measure:'📐 مقايسة',part:'🔩 قطعة غيار',maintenance:'🔧 صيانة اتعملت',pending:'📌 مطلوب',note:'📝 مذكرة',photo:'📷 صورة',payment:'💵 دفع'};
function esc(s){return String(s==null?'':s).replace(/[<>&"]/g,function(c){return {'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c];});}
function money(n){return (Math.round(Number(n)||0)).toLocaleString('en-US');}
function el(id){return document.getElementById(id);}
function dlabel(iso){try{var d=new Date(iso);return d.getUTCDate()+'/'+(d.getUTCMonth()+1);}catch(e){return '';}}
function lsGet(k){try{var v=localStorage.getItem(k);return v?JSON.parse(v):null;}catch(e){return null;}}
function lsSet(k,v){try{localStorage.setItem(k,JSON.stringify(v));return true;}catch(e){return false;}}
SELMONTH=lsGet('maint_selmonth')||0;SELYEAR=lsGet('maint_selyear')||0;
function monthsFor(b,y){y=String(y);if(b.monthsY&&b.monthsY[y])return b.monthsY[y];if(b.months&&String(b.year||CURYEAR)===y)return b.months;return {};}
function sha256(s){return crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)).then(function(buf){return Array.prototype.map.call(new Uint8Array(buf),function(b){return ('0'+b.toString(16)).slice(-2);}).join('');});}

function logout(){localStorage.removeItem('maint_token');localStorage.removeItem('maint_role');localStorage.removeItem('maint_pin');T='';ROLE='';renderLogin();}
function cw(){return ROLE==='admin'||ROLE==='manager';}
function mgr(){return ROLE==='manager';}

/* ---- شبكة ---- */
function apiGet(path){
  return fetch('/maint/api/'+path,{headers:{Authorization:'Bearer '+T}}).then(function(r){
    if(r.status===401){logout();throw new Error('login');}
    return r.json();
  });
}
/* طابور الكتابة (أوفلاين) */
function queue(){return lsGet('maint_q')||[];}
function setQueue(q){lsSet('maint_q',q);updateNet();}
function enqueue(path,body){var q=queue();q.push({path:path,body:body,ts:Date.now()});var ok=lsSet('maint_q',q);updateNet();flush();return ok;}
var flushing=false;
function flush(cb){
  if(flushing){if(cb)cb();return;}
  var q=queue();if(!q.length){OFF=false;updateNet();if(cb)cb();return;}
  flushing=true;var i=0;
  function step(){
    if(i>=q.length){flushing=false;setQueue([]);OFF=false;updateNet();if(cb)cb();return;}
    var it=q[i];
    fetch('/maint/api/'+it.path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+T},body:JSON.stringify(it.body)})
      .then(function(r){
        if(r.status===401){flushing=false;logout();return;}
        i++;step(); // 2xx أو 4xx: نعدّي (الغلط مننا مش من النت)
      })
      .catch(function(){ // مفيش نت: نسيب الباقي للمرة الجاية
        flushing=false;OFF=true;setQueue(q.slice(i));if(cb)cb();
      });
  }
  step();
}
function updateNet(){
  var bar=el('netbar');if(!bar)return;
  var n=queue().length;
  if(OFF||!navigator.onLine){bar.className='netbar off';bar.textContent='📴 مفيش نت — بتسجّل عادي، و'+(n?('هيترفع '+n+' حاجة'):'الرفع')+' أول ما النت يرجع';}
  else if(n){bar.className='netbar pend';bar.textContent='⏫ بيرفع '+n+' حاجة...';}
  else{bar.className='netbar';bar.textContent='';}
}

/* ---- دخول ---- */
function renderLogin(){
  el('app').innerHTML='<div class="center"><div class="login"><div style="font-size:20px;font-weight:600;color:var(--g)">🏢 صيانة توب باور</div><div class="muted" style="margin-top:6px">اكتب كود الدخول</div><input id="code" type="tel" inputmode="numeric" placeholder="كود" maxlength="8"><div class="err" id="lerr"></div><button class="btn" style="width:100%" id="loginBtn">دخول</button></div></div>';
  var i=el('code');i.focus();
  i.addEventListener('keydown',function(e){if(e.key==='Enter')doLogin();});
  el('loginBtn').addEventListener('click',doLogin);
}
function doLogin(){
  var code=el('code').value.trim();
  fetch('/maint/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:code})}).then(function(r){return r.json();}).then(function(d){
    if(!d.ok){el('lerr').textContent=d.error||'غلط';return;}
    T=d.token;ROLE=d.role;localStorage.setItem('maint_token',T);localStorage.setItem('maint_role',ROLE);
    sha256(code).then(function(h){localStorage.setItem('maint_pin',h);renderHome();});
  }).catch(function(){el('lerr').textContent='حصلت مشكلة، جرّب تاني';});
}
/* قفل: يطلب الكود كل مرة تفتح الأيقونة (بيشتغل أوفلاين كمان) */
function renderLock(){
  el('app').innerHTML='<div class="center"><div class="login"><div style="font-size:20px;font-weight:600;color:var(--g)">🔒 صيانة توب باور</div><div class="muted" style="margin-top:6px">اكتب الكود عشان تدخل</div><input id="code" type="tel" inputmode="numeric" placeholder="كود" maxlength="8"><div class="err" id="lerr"></div><button class="btn" style="width:100%" id="unlockBtn">فتح</button><div style="margin-top:10px"><a id="relog" style="font-size:12px;cursor:pointer">مستخدم تاني؟</a></div></div></div>';
  var i=el('code');i.focus();
  function go(){var code=el('code').value.trim();sha256(code).then(function(h){if(h===localStorage.getItem('maint_pin')){renderHome();}else{el('lerr').textContent='الكود غلط';}});}
  i.addEventListener('keydown',function(e){if(e.key==='Enter')go();});
  el('unlockBtn').addEventListener('click',go);
  el('relog').addEventListener('click',logout);
}

/* ---- الرئيسية ---- */
function renderHome(){
  FAULTSONLY=false;
  el('app').innerHTML='<header><div class="t">🏢 صيانة توب باور</div><span class="badge" id="mlabel">...</span></header><div class="netbar" id="netbar"></div><div class="pad" id="body"><div class="empty">بحمّل...</div></div>';
  updateNet();flush();
  var qp='?'+(SELMONTH?('month='+SELMONTH+'&'):'')+(SELYEAR?('year='+SELYEAR):'');
  Promise.all([apiGet('summary'+qp),apiGet('buildings'+qp),apiGet('years').catch(function(){return null;})]).then(function(res){
    SUM=res[0];LIST=res[1].buildings||[];MONTH=SUM.month;SELYEAR=SUM.year;CURYEAR=SUM.currentYear;CURMONTH=SUM.currentMonth;OFF=false;
    if(res[2]&&res[2].years){YEARS=res[2].years;lsSet('maint_years',YEARS);}
    lsSet('maint_sum',SUM);lsSet('maint_list',LIST);lsSet('maint_month',MONTH);lsSet('maint_selyear',SELYEAR);lsSet('maint_cur',{y:CURYEAR,m:CURMONTH});
    paintHome();
  }).catch(function(){
    SUM=lsGet('maint_sum');LIST=lsGet('maint_list')||[];MONTH=lsGet('maint_month')||1;YEARS=lsGet('maint_years')||[];var cc=lsGet('maint_cur')||{};CURYEAR=cc.y||MONTH&&new Date().getFullYear();CURMONTH=cc.m||1;SELYEAR=lsGet('maint_selyear')||CURYEAR;OFF=true;
    if(!SUM){el('body').innerHTML='<div class="empty">محتاج نت أول مرة بس — افتحه وإنت على النت مرة واحدة وبعدها هيشتغل أوفلاين.</div>';return;}
    paintHome();
  });
}
function recompute(){ // يحدّث أرقام الملخص من القائمة (عشان تعديلات الأوفلاين تبان)
  if(!SUM)return;
  var active=LIST.length;
  SUM.total=active;
  SUM.unpaidCount=LIST.filter(function(b){return !b.paidThisMonth;}).length;
  SUM.faults=LIST.filter(function(b){return b.fault;}).length;
  SUM.expected=LIST.reduce(function(s,b){return s+(Number(b.paid)||0);},0);
}
function paintHome(){
  recompute();
  el('mlabel').textContent=(SUM.monthName||'')+' '+(SELYEAR||'')+' ▾';el('mlabel').style.cursor='pointer';el('mlabel').onclick=changeMonth;updateNet();
  var h='<div class="cards">'+card('المطلوب',money(SUM.expected),'')+card('المتحصّل',money(SUM.collected),'green')+card('المتبقّي',money((SUM.expected||0)-(SUM.collected||0)),'redc')+card('ما دفعوش',SUM.unpaidCount,'redc')+'</div>';
  h+='<div class="actions"><button class="btn sm" id="faultsBtn">🔴 أعطال ('+SUM.faults+')</button><button class="btn sm o" id="staffBtn">👷 الموظفين</button>'+(cw()?'<button class="btn sm o" id="pettyBtn">🧾 نثريات</button>':'')+(mgr()?'<button class="btn sm o" id="profitBtn">💰 الأرباح</button><button class="btn sm o" id="setBtn">⚙️ إعدادات</button>':'')+(cw()?'<button class="btn sm o" id="bcBtn">📢 تحذير جماعي</button><button class="btn sm o" id="addBtn">+ عملية</button>':'')+'<button class="btn sm o" id="logoutBtn">خروج</button></div>';
  h+='<div class="search">🔎<input id="q" placeholder="دوّر على عمارة (زي 90ج)"></div>';
  h+='<div class="chips" id="chips"></div><div id="list"></div>';
  el('body').innerHTML=h;el('q').value=Q;
  el('logoutBtn').addEventListener('click',logout);
  el('faultsBtn').addEventListener('click',function(){FAULTSONLY=!FAULTSONLY;loadList();});
  el('staffBtn').addEventListener('click',openStaff);
  if(cw()){el('addBtn').addEventListener('click',addBuilding);el('bcBtn').addEventListener('click',broadcast);el('pettyBtn').addEventListener('click',openPetty);}
  if(mgr()){el('profitBtn').addEventListener('click',openProfit);el('setBtn').addEventListener('click',openSettings);}
  var zc={};LIST.forEach(function(b){zc[b.zone||'—']=(zc[b.zone||'—']||0)+1;});
  var zs=Object.keys(zc).sort();
  var chips='<span class="chip '+(ZONE===''?'on':'')+'" data-z="">الكل</span>';
  zs.forEach(function(z){chips+='<span class="chip '+(ZONE===z?'on':'')+'" data-z="'+esc(z)+'">'+esc(z)+' ('+zc[z]+')</span>';});
  el('chips').innerHTML=chips;
  el('chips').addEventListener('click',function(e){var c=e.target.closest('.chip');if(!c)return;ZONE=c.getAttribute('data-z');paintHome();});
  var qi=el('q'),t;qi.addEventListener('input',function(){clearTimeout(t);Q=qi.value;t=setTimeout(loadList,200);});
  el('list').addEventListener('click',function(e){var r=e.target.closest('.row');if(r)openB(r.getAttribute('data-id'));});
  loadList();
}
function card(l,v,cls){return '<div class="c"><div class="l">'+l+'</div><div class="v '+cls+'">'+v+'</div></div>';}
function changeMonth(){
  var years=YEARS&&YEARS.length?YEARS.slice():[String(CURYEAR||new Date().getFullYear())];
  if(years.indexOf(String(CURYEAR))<0)years.push(String(CURYEAR));
  years=years.filter(function(v,i,a){return a.indexOf(v)===i;}).sort();
  var h='<header><div class="t">اختار السنة والشهر</div><span class="badge" id="closeB" style="cursor:pointer">✕</span></header><div class="pad">';
  h+='<div class="sec">السنة</div><div class="chips" id="ypick">';
  years.forEach(function(y){h+='<span class="chip '+(Number(y)===SELYEAR?'on':'')+'" data-y="'+y+'">'+y+'</span>';});
  h+='</div><div class="sec">الشهر</div><div class="months" id="mpick">';
  for(var m=1;m<=12;m++){var on=(m===MONTH);h+='<div class="mo '+(on?'pd':'')+'" data-m="'+m+'" style="cursor:pointer;font-size:14px;padding:15px 0">'+MON[m-1]+'</div>';}
  h+='</div></div>';
  el('sheet').innerHTML=h;el('ov').style.display='flex';
  el('closeB').addEventListener('click',function(){el('ov').style.display='none';});
  el('ypick').addEventListener('click',function(e){var c=e.target.closest('.chip');if(!c)return;SELYEAR=Number(c.getAttribute('data-y'));lsSet('maint_selyear',SELYEAR);el('ov').style.display='none';renderHome();});
  el('mpick').addEventListener('click',function(e){var c=e.target.closest('.mo');if(!c)return;SELMONTH=Number(c.getAttribute('data-m'));lsSet('maint_selmonth',SELMONTH);el('ov').style.display='none';renderHome();});
}
function loadList(){
  var q=(Q||'').trim().toLowerCase();
  var list=LIST.filter(function(b){
    if(ZONE&&b.zone!==ZONE)return false;
    if(FAULTSONLY&&!b.fault)return false;
    if(q&&((b.num+' '+(b.name||'')).toLowerCase().indexOf(q)<0))return false;
    return true;
  });
  var elx=el('list');if(!elx)return;
  if(!list.length){elx.innerHTML='<div class="empty">مفيش عمليات</div>';return;}
  elx.innerHTML=list.map(function(b){
    var tags=(b.fault?'<span class="tag tr">🔴 عطل</span>':'')+(b.paidThisMonth?'<span class="tag tg">✓ دفع</span>':'<span class="tag tr">ما دفعش</span>');
    return '<div class="row" data-id="'+esc(b.id)+'"><div><div class="n">'+esc(b.num)+'</div><div class="s">منطقة '+esc(b.zone)+' · '+money(b.paid)+' ج'+(b.name?' · '+esc(b.name):'')+'</div></div><div style="display:flex;align-items:center">'+tags+'</div></div>';
  }).join('');
}

/* ---- عملية ---- */
function openB(id){
  apiGet('building?id='+encodeURIComponent(id)).then(function(d){
    if(!d.ok)throw new Error('x');DET[id]=d.building;lsSet('maint_det_'+id,d.building);renderB(d.building);
  }).catch(function(){
    var b=DET[id]||lsGet('maint_det_'+id);
    if(b)renderB(b);else alert('محتاج نت مرة واحدة تفتح بيها العملية دي الأول.');
  });
}
function renderB(b){
  CUR=b;var adm=cw();
  var cts=(b.contacts&&b.contacts.length)?b.contacts:((b.unionHead||b.unionPhone)?[{name:b.unionHead||'',phone:b.unionPhone||''}]:[]);
  var uni=cts.length?cts.map(function(c){var w=c.phone?(' <a class="btn sm" target="_blank" href="https://wa.me/'+String(c.phone).replace(/[^0-9]/g,'').replace(/^0/,'20')+'?text='+encodeURIComponent('بخصوص صيانة '+b.num)+'">واتساب</a>'):'';return '👤 '+esc(c.name||'رئيس اتحاد')+(c.phone?' · '+esc(c.phone):'')+w;}).join('<br>'):'<span class="muted">مفيش رئيس اتحاد مسجّل</span>';
  var h='<header><div class="t">'+esc(b.num)+'</div><span class="badge" id="closeB" style="cursor:pointer">✕ إغلاق</span></header><div class="pad">';
  h+='<div class="muted">منطقة '+esc(b.zone)+' · القيمة '+money(b.value)+' · المدفوع '+money(b.paid)+' · الغفير '+money(b.guard)+'</div>';
  h+='<div style="margin:9px 0;line-height:2">'+uni+(adm?' <button class="btn sm o" id="edUnion">تعديل</button>':'')+'</div>';
  if(b.driveFolder)h+='<div style="margin:6px 0"><a class="btn sm o" target="_blank" href="'+esc(b.driveFolder)+'">📁 فولدر الصور/الفيديو</a></div>';
  var mths=monthsFor(b,SELYEAR);
  h+='<div class="sec">التحصيل الشهري — سنة '+SELYEAR+(adm?' (دوس الشهر عشان تسجّل)':'')+'</div><div class="months" id="months">';
  for(var m=1;m<=12;m++){var pd=mths[m]!=null;var past=(SELYEAR<CURYEAR)||(SELYEAR===CURYEAR&&m<=CURMONTH);var cls=pd?'pd':(past?'un':'');h+='<div class="mo '+cls+'" data-m="'+m+'">'+MSH[m-1]+'<br>'+(pd?money(mths[m]):'—')+'</div>';}
  h+='</div>';
  if(adm){h+='<div class="actions" id="evBtns"><button class="btn sm" data-t="fault">🔴 عطل</button><button class="btn sm o" data-t="problem">⚠️ مشكلة</button><button class="btn sm o" data-t="measure">📐 مقايسة</button><button class="btn sm o" data-t="part">🔩 قطعة غيار</button><button class="btn sm o" data-t="maintenance">🔧 صيانة</button><button class="btn sm o" data-t="note">📝 مذكرة</button></div>';}
  h+='<div class="sec">السجل (الأحدث أولاً)</div>';
  var evs=(b.events||[]).slice().reverse();
  h+=evs.length?evs.map(function(e){return '<div class="ev '+(e.type==='fault'?'f':'')+'">'+(EVT[e.type]||'•')+' · '+dlabel(e.at)+' — '+esc(e.text)+(e.by?' ('+esc(e.by)+')':'')+'</div>';}).join(''):'<div class="muted">لسه مفيش</div>';
  h+='<div class="sec">صور وفيديوهات</div><div class="thumbs" id="thumbs">';
  (b.photos||[]).forEach(function(p){h+='<img data-src="/maint/api/photo?id='+esc(p.id)+'" src="/maint/api/photo?id='+esc(p.id)+'">';});
  if(adm)h+='<label class="addp">+<input type="file" accept="image/*" id="upPhoto" style="display:none"></label>';
  h+='</div></div>';
  el('sheet').innerHTML=h;el('ov').style.display='flex';
  el('closeB').addEventListener('click',closeB);
  if(adm){
    el('edUnion').addEventListener('click',editUnion);
    el('months').addEventListener('click',function(e){var c=e.target.closest('.mo');if(c)payMonth(Number(c.getAttribute('data-m')));});
    el('evBtns').addEventListener('click',function(e){var btn=e.target.closest('button');if(btn)addEv(btn.getAttribute('data-t'));});
    el('upPhoto').addEventListener('change',function(){upPhoto(this);});
  }
  el('thumbs').addEventListener('click',function(e){var im=e.target.closest('img');if(im)window.open(im.getAttribute('data-src'));});
}
function closeB(){el('ov').style.display='none';CUR=null;paintHome();}

/* ---- كتابة (تشتغل أوفلاين) ---- */
function saveCur(){DET[CUR.id]=CUR;lsSet('maint_det_'+CUR.id,CUR);}
function listItem(id){for(var i=0;i<LIST.length;i++)if(LIST[i].id===id)return LIST[i];return null;}
function payMonth(m){
  var def=(CUR&&CUR.paid)||'';
  var v=prompt('العمارة '+CUR.num+' — دفعت كام عن '+MON[m-1]+' '+SELYEAR+'؟',def);
  if(v==null)return;var amount=Number(String(v).replace(/[^0-9.]/g,''));if(isNaN(amount))return;
  var y=String(SELYEAR);CUR.monthsY=CUR.monthsY||{};if(!CUR.monthsY[y])CUR.monthsY[y]=(CUR.months&&String(CUR.year||CURYEAR)===y)?Object.assign({},CUR.months):{};CUR.monthsY[y][m]=amount;
  if(String(CUR.year)===y){CUR.months=CUR.months||{};CUR.months[m]=amount;}
  (CUR.events=CUR.events||[]).push({type:'payment',text:'اتحصّل '+amount+' ج عن '+MON[m-1]+' '+SELYEAR,amount:amount,month:m,year:SELYEAR,by:ROLE,at:new Date().toISOString()});
  if(m===MONTH&&SUM&&SELYEAR===SUM.year){var li=listItem(CUR.id);if(li)li.paidThisMonth=true;SUM.collected=(SUM.collected||0)+amount;}
  saveCur();enqueue('pay',{id:CUR.id,month:m,year:SELYEAR,amount:amount,at:new Date().toISOString()});renderB(CUR);
}
function addEv(type){
  if(type==='part'||type==='measure'){return addPart(type);}
  var label=EVT[type]||'';
  var text=type==='maintenance'?(prompt('تفاصيل الصيانة (أو سيبها فاضية):','')||''):prompt(label+' — اكتب التفاصيل:','');
  if(text==null&&type!=='maintenance')return;
  (CUR.events=CUR.events||[]).push({type:type,text:text||'اتعملت صيانة',by:ROLE,at:new Date().toISOString()});
  var li=listItem(CUR.id);if(li){if(type==='fault')li.fault=true;if(type==='maintenance')li.fault=false;}
  saveCur();enqueue('event',{id:CUR.id,type:type,text:text,at:new Date().toISOString()});renderB(CUR);
}
function addPart(type){
  var what=type==='measure'?'مقايسة':'قطعة غيار / شغل';
  var name=prompt(what+' — الاسم (لو منتج عندنا هجيب تكلفته):','');if(name==null)return;
  function cont(cost){
    var rev=prompt('اخدنا كام؟ (الإيراد/سعر البيع):','');if(rev==null)return;
    var c=prompt('صرفنا عليها كام؟ (التكلفة — لو منتج عندنا لقيت '+(cost!=null?cost:'0')+'):',cost!=null?String(cost):'');if(c==null)return;
    var revenue=Number(String(rev).replace(/[^0-9.]/g,''))||0, costv=Number(String(c).replace(/[^0-9.]/g,''))||0;
    var ev={type:type,text:name,revenue:revenue,cost:costv,profit:revenue-costv,by:ROLE,at:new Date().toISOString()};
    (CUR.events=CUR.events||[]).push(ev);saveCur();
    enqueue('event',{id:CUR.id,type:type,text:name,revenue:revenue,cost:costv,at:ev.at});renderB(CUR);
  }
  if(navigator.onLine){
    fetch('/maint/api/product-cost?name='+encodeURIComponent(name),{headers:{Authorization:'Bearer '+T}}).then(function(r){return r.json();}).then(function(d){cont(d.match?d.match.cost:null);}).catch(function(){cont(null);});
  }else cont(null);
}
function openPetty(){
  fetch('/maint/api/expenses',{headers:{Authorization:'Bearer '+T}}).then(function(r){return r.json();}).then(function(d){
    var h='<header><div class="t">🧾 نثريات</div><span class="badge" id="closeB" style="cursor:pointer">✕</span></header><div class="pad">';
    h+='<div class="c" style="background:var(--gl);margin-bottom:10px"><div class="l">إجمالي النثريات المعروضة</div><div class="v redc">'+money(d.total)+' ج</div></div>';
    h+='<div class="actions"><button class="btn sm" id="addExp">+ نثرية</button></div>';
    var evs=d.items||[];
    h+=evs.length?evs.map(function(x){return '<div class="ev">💸 '+money(x.amount)+' ج · '+dlabel(x.at)+(x.note?' — '+esc(x.note):'')+'</div>';}).join(''):'<div class="muted">لسه مفيش</div>';
    h+='</div>';el('sheet').innerHTML=h;el('ov').style.display='flex';
    el('closeB').addEventListener('click',closeB);
    el('addExp').addEventListener('click',function(){var a=prompt('قيمة النثرية (جنيه):','');if(a==null)return;var n=prompt('على إيه؟','')||'';fetch('/maint/api/expenses/add',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+T},body:JSON.stringify({amount:Number(a)||0,note:n})}).then(function(r){return r.json();}).then(function(d){if(d.ok)openPetty();});});
  }).catch(function(){alert('النثريات محتاجة نت.');});
}
function openProfit(){
  var d2=new Date(),d1=new Date(Date.now()-14*864e5);
  var def1=d1.toISOString().slice(0,10),def2=d2.toISOString().slice(0,10);
  var h='<header><div class="t">💰 الأرباح</div><span class="badge" id="closeB" style="cursor:pointer">✕</span></header><div class="pad">';
  h+='<div class="sec">الفترة</div><div style="display:flex;gap:8px;margin-bottom:10px"><input id="pf" type="date" value="'+def1+'" style="flex:1;padding:10px;border:1px solid var(--line);border-radius:10px;font-family:inherit"><input id="pt" type="date" value="'+def2+'" style="flex:1;padding:10px;border:1px solid var(--line);border-radius:10px;font-family:inherit"></div>';
  h+='<button class="btn" id="calcP" style="width:100%">احسب</button><div id="pres" style="margin-top:12px"></div></div>';
  el('sheet').innerHTML=h;el('ov').style.display='flex';
  el('closeB').addEventListener('click',closeB);
  el('calcP').addEventListener('click',function(){
    var from=el('pf').value,to=el('pt').value;
    fetch('/maint/api/profit?from='+from+'&to='+to,{headers:{Authorization:'Bearer '+T}}).then(function(r){return r.json();}).then(function(d){
      if(!d.ok){el('pres').innerHTML='<div class="muted">'+(d.error||'مشكلة')+'</div>';return;}
      function row(l,v,cls){return '<div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid var(--line)"><span>'+l+'</span><span class="'+(cls||'')+'" style="font-weight:600">'+money(v)+' ج</span></div>';}
      el('pres').innerHTML=
        row('دخل الصيانة (محصّل)',d.maintCollected,'green')+
        row('إيراد قطع الغيار/المقايسات',d.partsRev)+
        row('تكلفة قطع الغيار',d.partsCost,'redc')+
        row('صافي قطع الغيار',d.partsNet)+
        row('↳ نصيب العمّال (⅓)',d.workersShare,'redc')+
        row('↳ نصيب المحل (⅔)',d.shopPartsShare,'green')+
        row('النثريات',d.petty,'redc')+
        row('مسحوبات الرواتب',d.payouts,'redc')+
        '<div style="display:flex;justify-content:space-between;padding:11px 0;margin-top:4px"><span style="font-weight:700">صافي ربح المحل</span><span class="green" style="font-weight:700;font-size:18px">'+money(d.shopNet)+' ج</span></div>';
    }).catch(function(){el('pres').innerHTML='<div class="muted">محتاج نت.</div>';});
  });
}
function editUnion(){
  var cts=(CUR.contacts&&CUR.contacts.length)?CUR.contacts:[];
  var n1=prompt('اسم رئيس الاتحاد (1):',(cts[0]&&cts[0].name)||'');if(n1==null)return;
  var p1=prompt('تليفونه (1):',(cts[0]&&cts[0].phone)||'');if(p1==null)return;
  var n2=prompt('اسم رئيس اتحاد تاني (2) — سيبها فاضية لو مفيش:',(cts[1]&&cts[1].name)||'');if(n2==null)return;
  var p2=prompt('تليفونه (2):',(cts[1]&&cts[1].phone)||'');if(p2==null)return;
  var arr=[{name:n1,phone:p1}];if(n2||p2)arr.push({name:n2,phone:p2});
  CUR.contacts=arr;saveCur();enqueue('set',{id:CUR.id,field:'contacts',value:arr});renderB(CUR);
}
function upPhoto(inp){
  var f=inp.files[0];if(!f)return;var rd=new FileReader();
  rd.onload=function(){var b64=String(rd.result).split(',')[1];var cap=prompt('تعليق على الصورة (اختياري):','')||'';
    if(!navigator.onLine){alert('الصور محتاجة نت 🙏 (التسجيل والأعطال بيشتغلوا أوفلاين).');return;}
    fetch('/maint/api/photo',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+T},body:JSON.stringify({bid:CUR.id,b64:b64,mime:f.type||'image/jpeg',caption:cap})})
      .then(function(r){return r.json();}).then(function(d){if(d.ok){DET[CUR.id]=d.building;renderB(d.building);}else alert(d.error||'مشكلة');})
      .catch(function(){alert('مفيش نت — الصور محتاجة نت.');});};
  rd.readAsDataURL(f);
}
function addBuilding(){
  var num=prompt('رقم العملية الجديدة (زي 90ج):','');if(!num)return;
  var value=prompt('القيمة الكاملة:','250');if(value==null)return;
  var paid=prompt('المدفوع (الصافي بعد الغفير):','200');if(paid==null)return;
  fetch('/maint/api/add',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+T},body:JSON.stringify({num:num,value:Number(value),paid:Number(paid)})})
    .then(function(r){return r.json();}).then(function(d){if(d.ok)renderHome();else alert(d.error||'مشكلة');})
    .catch(function(){alert('إضافة عملية جديدة محتاجة نت.');});
}
function broadcast(){
  apiGet('broadcast').then(function(d){
    if(!d.count){alert('مفيش تليفونات رؤساء اتحاد مسجّلة لسه.');return;}
    var msg=prompt('اكتب التحذير اللي هيتبعت لكل العماير:','تنبيه: برجاء فصل المصاعد لحين انتهاء الأمطار.');
    if(msg==null)return;
    var nums=d.contacts.map(function(c){return c.phone;}).join(', ');
    var html='<header><div class="t">📢 تحذير جماعي ('+d.count+')</div><span class="badge" id="closeB" style="cursor:pointer">✕</span></header><div class="pad">'+
      '<div class="muted">واتساب مش بيسمح إرسال جماعي ببلاش من البوت. أسهل طريقة مجانية: من تليفونك اعمل "رسالة جماعية" (Broadcast)، ضيف الأرقام دي، والصق الرسالة وابعت مرة واحدة.</div>'+
      '<div class="sec">الرسالة</div><div class="ev">'+esc(msg)+'</div>'+
      '<div class="sec">الأرقام ('+d.count+')</div><textarea id="bcnums" style="width:100%;height:120px;font-family:inherit;border:1px solid var(--line);border-radius:10px;padding:10px">'+esc(nums)+'</textarea>'+
      '<div class="actions"><button class="btn sm" id="copyNums">نسخ الأرقام</button></div></div>';
    el('sheet').innerHTML=html;el('ov').style.display='flex';
    el('closeB').addEventListener('click',closeB);
    el('copyNums').addEventListener('click',function(){var ta=el('bcnums');ta.select();try{document.execCommand('copy');this.textContent='اتنسخ ✓';}catch(e){}});
  }).catch(function(){alert('التحذير الجماعي محتاج نت.');});
}

/* ---- الموظفين والرواتب ---- */
function openStaff(){
  fetch('/maint/api/staff',{headers:{Authorization:'Bearer '+T}}).then(function(r){return r.json();}).then(function(d){
    if(!d.ok)return;
    var h='<header><div class="t">👷 الموظفين</div><span class="badge" id="closeB" style="cursor:pointer">✕</span></header><div class="pad">';
    if(d.isManager)h+='<div class="muted" style="margin-bottom:8px">الراتب والقبض بيبانوا لك إنت بس 🔒</div>';
    if(d.canWrite&&d.isManager)h+='<div class="actions"><button class="btn sm" id="addEmp">+ موظف</button></div>';
    h+='<div id="emps" style="margin-top:8px">';
    if(!d.emps.length)h+='<div class="empty">مفيش موظفين لسه'+(d.isManager?' — دوس "+ موظف"':'')+'</div>';
    d.emps.forEach(function(e){
      var extra=(d.isManager?(' · القبض '+money(e.net)+' ج'):'');
      h+='<div class="row" data-id="'+esc(e.id)+'"><div><div class="n">'+esc(e.name)+'</div><div class="s">سلف: '+money(e.advAmount)+' ج · غياب: '+(e.absDays||0)+' يوم'+extra+'</div></div><div style="color:var(--mut)">›</div></div>';
    });
    h+='</div></div>';
    el('sheet').innerHTML=h;el('ov').style.display='flex';
    el('closeB').addEventListener('click',closeB);
    if(el('addEmp'))el('addEmp').addEventListener('click',addEmp);
    el('emps').addEventListener('click',function(ev){var r=ev.target.closest('.row');if(r)openEmp(r.getAttribute('data-id'));});
  }).catch(function(){alert('الموظفين محتاج نت.');});
}
function addEmp(){
  var name=prompt('اسم الموظف:','');if(!name)return;
  var sal=prompt('راتبه (اللي بيتحسب عليه، هيتقسم على 24 لليوم):','');if(sal==null)return;
  fetch('/maint/api/staff/add',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+T},body:JSON.stringify({name:name,salary:Number(sal)||0})}).then(function(r){return r.json();}).then(function(d){if(d.ok)openStaff();else alert(d.error||'مشكلة');});
}
function openEmp(id){
  fetch('/maint/api/staff/detail?id='+encodeURIComponent(id),{headers:{Authorization:'Bearer '+T}}).then(function(r){return r.json();}).then(function(d){
    if(!d.ok)return;var e=d.emp;
    var h='<header><div class="t">'+esc(e.name)+'</div><span class="badge" id="backStaff" style="cursor:pointer">‹ رجوع</span></header><div class="pad">';
    if(d.isManager){
      h+='<div class="cards"><div class="c"><div class="l">الراتب</div><div class="v">'+money(e.salary)+'</div></div><div class="c"><div class="l">اليومية (÷24)</div><div class="v">'+money(e.dayVal)+'</div></div></div>';
      h+='<div class="cards"><div class="c"><div class="l">أيام الشغل (من البداية، الجمعة إجازة)</div><div class="v">'+(e.workDays||0)+' يوم</div></div><div class="c"><div class="l">إجمالي الفترة</div><div class="v">'+money(e.gross)+'</div></div></div>';
      h+='<div class="muted" style="margin-bottom:8px">بداية الفترة: '+(e.periodStart?dlabel(e.periodStart):'—')+'</div>';
      h+='<div class="c" style="background:var(--gl);margin-bottom:12px"><div class="l">صافي القبض لحد دلوقتي</div><div class="v green">'+money(e.net)+' ج</div></div>';
    }
    h+='<div class="cards"><div class="c"><div class="l">سلف الفترة</div><div class="v redc">'+money(e.advAmount)+'</div></div><div class="c"><div class="l">غياب الفترة</div><div class="v redc">'+(e.absDays||0)+' يوم</div></div>';
    h+='<div class="c"><div class="l">خصومات</div><div class="v redc">'+money(e.dedAmount)+'</div></div><div class="c"><div class="l">إضافي</div><div class="v green">'+money(e.bonAmount)+'</div></div></div>';
    if(d.canWrite)h+='<div class="actions"><button class="btn sm" data-a="adv">+ سلفة</button><button class="btn sm o" data-a="abs">+ غياب</button><button class="btn sm o" data-a="ded">+ خصم</button><button class="btn sm o" data-a="bon">+ إضافي</button>'+(d.isManager?'<button class="btn sm o" data-a="start">🟢 بداية عمل</button><button class="btn sm o" data-a="sal">تعديل الراتب</button><button class="btn sm" data-a="paid" style="background:var(--g)">✅ تم القبض</button><button class="btn sm o" data-a="del">حذف</button>':'')+'</div>';
    h+='<div class="sec">الحركة (الأحدث أولاً)</div>';
    var evs=(e.events||[]).slice().reverse();
    h+=evs.length?evs.map(function(x){var lbl=x.type==="advance"?("💵 سلفة "+money(x.amount)+" ج"):x.type==="absence"?("🚫 غياب "+(x.days||0)+" يوم"):x.type==="deduction"?("➖ خصم "+money(x.amount)+" ج"):x.type==="bonus"?("➕ إضافي "+money(x.amount)+" ج"):x.type==="paid"?("✅ تم القبض"+(d.isManager?(" ("+money(x.amount)+" ج)"):"")):"📝";return '<div class="ev">'+lbl+' · '+dlabel(x.at)+(x.text?' — '+esc(x.text):'')+'</div>';}).join(''):'<div class="muted">لسه مفيش</div>';
    h+='</div>';
    el('sheet').innerHTML=h;
    el('backStaff').addEventListener('click',openStaff);
    var box=el('sheet');
    box.addEventListener('click',function(ev){var btn=ev.target.closest('button[data-a]');if(!btn)return;empAction(btn.getAttribute('data-a'),e);});
  });
}
function empAction(a,e){
  if(a==='adv'){var amt=prompt('قيمة السلفة:','');if(amt==null)return;var n=prompt('ملاحظة (اختياري):','')||'';staffPost('advance',{id:e.id,amount:Number(amt)||0,note:n},e.id);}
  else if(a==='abs'){var d=prompt('غاب كام يوم؟','1');if(d==null)return;var n2=prompt('ملاحظة (اختياري):','')||'';staffPost('absence',{id:e.id,days:Number(d)||0,note:n2},e.id);}
  else if(a==='ded'){var dd=prompt('قيمة الخصم (جنيه):','');if(dd==null)return;var n3=prompt('سبب الخصم (اختياري):','')||'';staffPost('deduction',{id:e.id,amount:Number(dd)||0,note:n3},e.id);}
  else if(a==='bon'){var bb=prompt('قيمة الإضافي (جنيه):','');if(bb==null)return;var n4=prompt('سبب الإضافي (اختياري):','')||'';staffPost('bonus',{id:e.id,amount:Number(bb)||0,note:n4},e.id);}
  else if(a==='sal'){var s=prompt('الراتب الجديد:',e.salary||'');if(s==null)return;staffPost('salary',{id:e.id,salary:Number(s)||0},e.id);}
  else if(a==='start'){var t=new Date(Date.now()+2*3600000).toISOString().slice(0,10);var ds=prompt('بداية العمل (التاريخ) — سيبها زي ما هي للنهارده:',t);if(ds==null)return;staffPost('period',{id:e.id,date:ds},e.id);}
  else if(a==='paid'){if(!confirm('تأكيد: تم قبض '+e.name+'؟ هنبدأ فترة جديدة (السلف والغياب يتصفّروا والعد يبدأ من النهارده).'))return;staffPost('paid',{id:e.id},e.id);}
  else if(a==='del'){if(!confirm('حذف '+e.name+' نهائيًا؟'))return;staffPost('remove',{id:e.id},null);}
}
function staffPost(path,body,reopenId){
  fetch('/maint/api/staff/'+path,{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+T},body:JSON.stringify(body)}).then(function(r){return r.json();}).then(function(d){if(d.ok){if(reopenId)openEmp(reopenId);else openStaff();}else alert(d.error||'مشكلة');}).catch(function(){alert('محتاج نت.');});
}

function roleLbl(r){return r==='manager'?'كامل (مدير)':r==='admin'?'تعديل':'مشاهدة';}
function openSettings(){
  fetch('/maint/api/settings',{headers:{Authorization:'Bearer '+T}}).then(function(r){return r.json();}).then(function(d){
    if(!d.ok){alert(d.error||'للمدير بس');return;}
    var h='<header><div class="t">⚙️ الإعدادات</div><span class="badge" id="closeB" style="cursor:pointer">✕</span></header><div class="pad">';
    var o=location.origin;
    h+='<div class="sec">اللينكات (انسخ وابعت أو حطها على الموبايل)</div>';
    h+='<div class="ev">🔧 لينك برنامج الصيانة <a data-cp="'+o+'/maint" style="cursor:pointer;color:var(--g)">نسخ</a></div>';
    h+='<div class="ev">🏗️ لينك صفحة توب باور (للزباين) <a data-cp="'+o+'/tp" style="cursor:pointer;color:var(--g)">نسخ</a></div>';
    h+='<div class="sec">الأكواد الأساسية</div>';
    h+='<div class="ev">👑 كود المدير (ليك إنت — بيشوف الرواتب والأرباح): <b>'+esc(d.manager)+'</b> <a data-ec="manager" style="cursor:pointer">تغيير</a></div>';
    h+='<div class="ev">✏️ كود التعديل (الإدارة): <b>'+esc(d.admin)+'</b> <a data-ec="admin" style="cursor:pointer">تغيير</a></div>';
    h+='<div class="ev">👁️ كود المشاهدة: <b>'+esc(d.view)+'</b> <a data-ec="view" style="cursor:pointer">تغيير</a></div>';
    h+='<div class="sec">أكواد الموظفين (صلاحية لكل كود)</div><div class="actions"><button class="btn sm" id="addExtra">+ كود موظف</button></div><div id="exList" style="margin-top:6px">';
    (d.extra||[]).forEach(function(x){h+='<div class="ev">'+esc(x.name)+' — كود <b>'+esc(x.code)+'</b> — '+roleLbl(x.role)+' <a data-rm="'+esc(x.code)+'" style="cursor:pointer;color:#A32D2D">حذف</a></div>';});
    if(!(d.extra||[]).length)h+='<div class="muted">مفيش أكواد موظفين إضافية</div>';
    h+='</div></div>';
    el('sheet').innerHTML=h;el('ov').style.display='flex';
    el('closeB').addEventListener('click',closeB);
    el('addExtra').addEventListener('click',function(){
      var name=prompt('اسم الموظف:','');if(!name)return;
      var code=prompt('الكود اللي هيدخل بيه:','');if(!code)return;
      var r=prompt('الصلاحية؟ اكتب: مشاهدة / تعديل / كامل','تعديل');if(r==null)return;
      r=(r.indexOf('كامل')>=0||r.indexOf('مدير')>=0)?'manager':(r.indexOf('مشاهد')>=0?'view':'admin');
      fetch('/maint/api/settings/extra',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+T},body:JSON.stringify({name:name,code:code,role:r})}).then(function(x){return x.json();}).then(function(x){if(x.ok)openSettings();else alert(x.error||'مشكلة');});
    });
    el('sheet').addEventListener('click',function(ev){
      var ec=ev.target.closest('[data-ec]'),rm=ev.target.closest('[data-rm]'),cp=ev.target.closest('[data-cp]');
      if(cp){var L=cp.getAttribute('data-cp');if(navigator.clipboard&&navigator.clipboard.writeText){navigator.clipboard.writeText(L).then(function(){cp.textContent='اتنسخ ✅';},function(){cp.textContent=L;});}else{cp.textContent=L;}}
      else if(ec){var w=ec.getAttribute('data-ec');var v=prompt('الكود الجديد:','');if(!v)return;fetch('/maint/api/settings/code',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+T},body:JSON.stringify({which:w,value:v})}).then(function(x){return x.json();}).then(function(x){if(x.ok)openSettings();else alert(x.error||'مشكلة');});}
      else if(rm){if(!confirm('حذف الكود؟'))return;fetch('/maint/api/settings/extra-remove',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+T},body:JSON.stringify({code:rm.getAttribute('data-rm')})}).then(function(x){return x.json();}).then(function(x){if(x.ok)openSettings();});}
    });
  }).catch(function(){alert('الإعدادات محتاجة نت.');});
}

window.addEventListener('online',function(){OFF=false;flush(function(){if(el('mlabel'))renderHome();});});
window.addEventListener('offline',function(){OFF=true;updateNet();});
if('serviceWorker' in navigator){navigator.serviceWorker.register('/maint/sw.js',{scope:'/maint'}).catch(function(){});}
// قفل بالكود كل مرة تفتح الأيقونة
if(T&&ROLE&&localStorage.getItem('maint_pin'))renderLock();
else if(T&&ROLE)renderHome();
else renderLogin();
</script>
</body>
</html>`;
