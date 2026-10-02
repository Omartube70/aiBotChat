/**
 * القدس لمهمات المصاعد — برنامج المحل (كاشير + خزنة + موظفين + تقرير يومي).
 * مستقل: بيع بخصم → خزنة، نثريات، موظفين (اليومية = الراتب ÷ 24)، تقرير يومي (دخل − نثريات − يوميات).
 * المنتجات (بداية) من كتالوج إنياد المحفوظ (catalog:snapshot) بصورها وأسعار بيعها.
 * الدخول بكود: مدير (يشوف الأرباح) / إدارة (بيع وتسجيل) / مشاهدة.
 *
 *   GET /pos                      الصفحة
 *   POST /pos/api/login           { code } → { role, token }
 *   GET  /pos/api/products        المنتجات (اسم، سعر، صورة)
 *   POST /pos/api/sale            { items, discount, customer } [إدارة]  → فاتورة برقم
 *   GET  /pos/api/day?date=       مبيعات اليوم + الإجماليات [إدارة]
 *   POST /pos/api/expense         { amount, note } [إدارة]
 *   GET  /pos/api/staff           الموظفين [إدارة] (الراتب للمدير بس)
 *   POST /pos/api/staff/add       { name, salary } [مدير]
 *   POST /pos/api/staff/absence   { id, days } [إدارة]
 *   GET  /pos/api/report?date=    تقرير اليوم (دخل/نثريات/يوميات/صافي) [مدير]
 */
const SNAP_KEY = 'catalog:snapshot';
const SALES_KEY = 'qods:sales';
const EXP_KEY = 'qods:expenses';
const STAFF_KEY = 'qods:staff';
const CODES_KEY = 'qods:codes';
const te = new TextEncoder();
const TTL = 30 * 24 * 3600;

function json(o, s = 200) { return new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json; charset=utf-8' } }); }
function cairoNow() { const d = new Date(Date.now() + 2 * 3600 * 1000); return { iso: d.toISOString(), date: d.toISOString().slice(0, 10), y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, day: d.getUTCDate() }; }
async function codes(env) {
  const c = (await env.MEMORY.get(CODES_KEY, 'json')) || {};
  return {
    manager: c.manager || env.QODS_MANAGER_CODE || '0000',
    admin: c.admin || env.QODS_ADMIN_CODE || '1111',
    view: c.view || env.QODS_VIEW_CODE || '2222',
    extra: Array.isArray(c.extra) ? c.extra : [],
  };
}
function roleForCode(cc, code) {
  if (!code) return null;
  if (code === cc.manager) return 'manager';
  if (code === cc.admin) return 'admin';
  if (code === cc.view) return 'view';
  const e = (cc.extra || []).find((x) => String(x.code) === String(code));
  return e ? (['manager', 'admin', 'view'].includes(e.role) ? e.role : 'view') : null;
}
async function hmac(secret, msg) {
  const k = await crypto.subtle.importKey('raw', te.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const s = await crypto.subtle.sign('HMAC', k, te.encode(msg));
  return [...new Uint8Array(s)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function secretOf(env) { return env.MAINT_SECRET || env.DEBUG_KEY || 'qods-dev-secret'; }
async function mkToken(role, name, env) { const exp = Math.floor(Date.now() / 1000) + TTL; const en = encodeURIComponent(name || ''); const body = `${role}.${en}.${exp}`; return `${body}.${await hmac(secretOf(env), body)}`; }
async function verify(token, env) {
  if (!token) return null; const p = String(token).split('.'); if (p.length !== 4) return null;
  const [role, en, exp, sig] = p; if (!['manager', 'admin', 'view'].includes(role)) return null;
  if (Number(exp) < Math.floor(Date.now() / 1000)) return null;
  if ((await hmac(secretOf(env), `${role}.${en}.${exp}`)) !== sig) return null;
  return { role, name: decodeURIComponent(en) };
}
function sellerName(cc, code, role) {
  const ex = (cc.extra || []).find((e) => String(e.code) === String(code));
  if (ex) return ex.name;
  return role === 'manager' ? 'المدير' : role === 'admin' ? 'الإدارة' : 'مشاهدة';
}
function bearer(req) { const h = req.headers.get('Authorization') || ''; const m = h.match(/^Bearer\s+(.+)$/i); return m ? m[1] : ''; }

async function products(env) {
  const snap = await env.MEMORY.get(SNAP_KEY, 'json');
  return ((snap && snap.products) || []).filter((p) => p && p.name && p.price != null)
    .map((p) => ({ id: p.id, name: p.name, price: p.price, img: p.imageUrl || null, cat: p.category || '' }));
}
async function loadStaff(env) { const d = (await env.MEMORY.get(STAFF_KEY, 'json')) || { seq: 0, emps: [] }; if (!Array.isArray(d.emps)) d.emps = []; return d; }
function invoiceNo(now, n) {
  const L = 'ABCDEFGHJKMNPQRSTUVWXYZ';
  let r = ''; for (let i = 0; i < 2; i++) r += L[Math.floor(Math.random() * L.length)];
  return `${String(now.y).slice(2)}${String(now.m).padStart(2, '0')}${String(now.day).padStart(2, '0')}-${r}${(n % 1000)}`;
}

export async function handleQodsPos(request, url, env) {
  const { pathname } = url; const method = request.method;
  if (pathname === '/pos' || pathname === '/pos/') return new Response(POS_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  if (pathname === '/pos/sw.js') return new Response(SW, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Service-Worker-Allowed': '/pos', 'Cache-Control': 'no-cache' } });
  if (pathname === '/pos/manifest.webmanifest') return new Response(MANIFEST, { headers: { 'Content-Type': 'application/manifest+json; charset=utf-8' } });
  if (!pathname.startsWith('/pos/api/')) return null;

  if (pathname === '/pos/api/login' && method === 'POST') {
    const b = await request.json().catch(() => ({}));
    const code = String(b.code || '').trim();
    const cc = await codes(env);
    const role = roleForCode(cc, code);
    if (!role) return json({ ok: false, error: 'الكود غلط' }, 401);
    const name = sellerName(cc, code, role);
    return json({ ok: true, role, name, token: await mkToken(role, name, env) });
  }
  const auth = await verify(bearer(request), env);
  if (!auth) return json({ ok: false, error: 'محتاج دخول' }, 401);
  const role = auth.role, seller = auth.name;
  const isMgr = role === 'manager';
  const canWrite = role === 'manager' || role === 'admin';
  const now = cairoNow();

  if (pathname === '/pos/api/products' && method === 'GET') return json({ ok: true, products: await products(env) });

  if (pathname === '/pos/api/sale' && method === 'POST') {
    if (!canWrite) return json({ ok: false, error: 'مشاهدة بس' }, 403);
    const b = await request.json().catch(() => ({}));
    const items = Array.isArray(b.items) ? b.items.map((x) => ({ name: String(x.name || ''), price: Number(x.price) || 0, qty: Number(x.qty) || 1 })) : [];
    if (!items.length) return json({ ok: false, error: 'مفيش أصناف' }, 400);
    const subtotal = items.reduce((s, x) => s + x.price * x.qty, 0);
    const discount = Number(b.discount) || 0;
    const total = Math.max(0, subtotal - discount);
    const all = (await env.MEMORY.get(SALES_KEY, 'json')) || [];
    const no = invoiceNo(now, all.length + 1);
    const sale = { no, items, subtotal, discount, total, customer: String(b.customer || ''), seller, by: role, at: now.iso, date: now.date };
    all.push(sale);
    await env.MEMORY.put(SALES_KEY, JSON.stringify(all.slice(-5000)));
    return json({ ok: true, sale });
  }

  if (pathname === '/pos/api/invoice' && method === 'GET') {
    const no = url.searchParams.get('no') || '';
    const all = (await env.MEMORY.get(SALES_KEY, 'json')) || [];
    const s = all.find((x) => String(x.no).toLowerCase() === no.trim().toLowerCase());
    return json({ ok: true, sale: s || null });
  }

  if (pathname === '/pos/api/day' && method === 'GET') {
    const date = url.searchParams.get('date') || now.date;
    const all = (await env.MEMORY.get(SALES_KEY, 'json')) || [];
    const sel = all.filter((s) => s.date === date);
    return json({ ok: true, date, count: sel.length, income: sel.reduce((s, x) => s + (x.total || 0), 0), discount: sel.reduce((s, x) => s + (x.discount || 0), 0), sales: sel.slice(-100).reverse() });
  }

  if (pathname === '/pos/api/expense' && method === 'POST') {
    if (!canWrite) return json({ ok: false, error: 'مشاهدة بس' }, 403);
    const b = await request.json().catch(() => ({}));
    const items = (await env.MEMORY.get(EXP_KEY, 'json')) || [];
    items.push({ amount: Number(b.amount) || 0, note: String(b.note || ''), by: role, at: now.iso, date: now.date });
    await env.MEMORY.put(EXP_KEY, JSON.stringify(items.slice(-5000)));
    return json({ ok: true });
  }

  if (pathname === '/pos/api/staff' && method === 'GET') {
    const sd = await loadStaff(env);
    return json({ ok: true, isManager: isMgr, canWrite, emps: sd.emps.map((e) => { const o = { id: e.id, name: e.name, absDays: Number(e.absDays) || 0 }; if (isMgr) { o.salary = Number(e.salary) || 0; o.dayVal = Math.round((Number(e.salary) || 0) / 24); } return o; }) });
  }
  if (pathname === '/pos/api/staff/add' && method === 'POST') {
    if (!isMgr) return json({ ok: false, error: 'للمدير بس' }, 403);
    const b = await request.json().catch(() => ({})); const name = String(b.name || '').trim();
    if (!name) return json({ ok: false, error: 'اكتب الاسم' }, 400);
    const sd = await loadStaff(env); sd.emps.push({ id: 'e' + (++sd.seq), name, salary: Number(b.salary) || 0, absDays: 0, at: now.iso });
    await env.MEMORY.put(STAFF_KEY, JSON.stringify(sd)); return json({ ok: true });
  }
  if (pathname === '/pos/api/staff/absence' && method === 'POST') {
    if (!canWrite) return json({ ok: false, error: 'مشاهدة بس' }, 403);
    const b = await request.json().catch(() => ({})); const sd = await loadStaff(env);
    const e = sd.emps.find((x) => x.id === b.id); if (!e) return json({ ok: false, error: 'مش موجود' }, 404);
    e.absDays = (Number(e.absDays) || 0) + (Number(b.days) || 0);
    await env.MEMORY.put(STAFF_KEY, JSON.stringify(sd)); return json({ ok: true });
  }

  if (pathname === '/pos/api/settings' && method === 'GET') {
    if (!isMgr) return json({ ok: false, error: 'للمدير بس' }, 403);
    const cc = await codes(env);
    return json({ ok: true, manager: cc.manager, admin: cc.admin, view: cc.view, extra: cc.extra });
  }
  if (pathname === '/pos/api/settings/code' && method === 'POST') {
    if (!isMgr) return json({ ok: false, error: 'للمدير بس' }, 403);
    const b = await request.json().catch(() => ({}));
    if (!['manager', 'admin', 'view'].includes(b.which)) return json({ ok: false, error: 'نوع غلط' }, 400);
    const v = String(b.value || '').replace(/\s/g, ''); if (!v) return json({ ok: false, error: 'اكتب الكود' }, 400);
    const c = (await env.MEMORY.get(CODES_KEY, 'json')) || {}; c[b.which] = v; await env.MEMORY.put(CODES_KEY, JSON.stringify(c));
    return json({ ok: true });
  }
  if (pathname === '/pos/api/settings/extra' && method === 'POST') {
    if (!isMgr) return json({ ok: false, error: 'للمدير بس' }, 403);
    const b = await request.json().catch(() => ({}));
    const code = String(b.code || '').replace(/\s/g, ''), name = String(b.name || '').trim();
    const r = ['manager', 'admin', 'view'].includes(b.role) ? b.role : 'view';
    if (!code || !name) return json({ ok: false, error: 'اكتب الاسم والكود' }, 400);
    const c = (await env.MEMORY.get(CODES_KEY, 'json')) || {};
    c.extra = (Array.isArray(c.extra) ? c.extra : []).filter((e) => String(e.code) !== code);
    c.extra.push({ name, code, role: r }); await env.MEMORY.put(CODES_KEY, JSON.stringify(c));
    return json({ ok: true });
  }
  if (pathname === '/pos/api/settings/extra-remove' && method === 'POST') {
    if (!isMgr) return json({ ok: false, error: 'للمدير بس' }, 403);
    const b = await request.json().catch(() => ({}));
    const c = (await env.MEMORY.get(CODES_KEY, 'json')) || {};
    c.extra = (Array.isArray(c.extra) ? c.extra : []).filter((e) => String(e.code) !== String(b.code));
    await env.MEMORY.put(CODES_KEY, JSON.stringify(c)); return json({ ok: true });
  }

  if (pathname === '/pos/api/report' && method === 'GET') {
    if (!isMgr) return json({ ok: false, error: 'للمدير بس' }, 403);
    const date = url.searchParams.get('date') || now.date;
    const sales = (await env.MEMORY.get(SALES_KEY, 'json')) || [];
    const exps = (await env.MEMORY.get(EXP_KEY, 'json')) || [];
    const sd = await loadStaff(env);
    const income = sales.filter((s) => s.date === date).reduce((s, x) => s + (x.total || 0), 0);
    const petty = exps.filter((x) => x.date === date).reduce((s, x) => s + (Number(x.amount) || 0), 0);
    // يوميات: كل موظف اليومية = راتبه ÷ 24 (الحاضرين — من غير غياب اليوم مش محسوب تفصيلي، v1 = كل النشطين)
    const wages = sd.emps.reduce((s, e) => s + Math.round((Number(e.salary) || 0) / 24), 0);
    const net = income - petty - wages;
    return json({ ok: true, date, income, petty, wages, net });
  }

  return json({ ok: false, error: 'مسار غير معروف' }, 404);
}

const SW = `const C='pos-v1';self.addEventListener('install',function(e){self.skipWaiting();e.waitUntil(caches.open(C).then(function(c){return c.add('/pos');}));});self.addEventListener('activate',function(e){e.waitUntil(self.clients.claim());});self.addEventListener('fetch',function(e){var u=new URL(e.request.url);if(e.request.method!=='GET')return;if(u.pathname==='/pos'||u.pathname==='/pos/'){e.respondWith((async function(){try{var r=await fetch(e.request);var c=await caches.open(C);c.put('/pos',r.clone());return r;}catch(err){return (await caches.match('/pos'))||new Response('offline',{status:503});}})());}});`;
const MANIFEST = JSON.stringify({ name: 'القدس — المحل', short_name: 'القدس محل', start_url: '/pos', scope: '/pos', display: 'standalone', background_color: '#0F6E56', theme_color: '#0F6E56', lang: 'ar', dir: 'rtl', icons: [{ src: '/qods/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }] });

const POS_HTML = `<!doctype html>
<html lang="ar" dir="rtl"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<meta name="theme-color" content="#0F6E56"><link rel="manifest" href="/pos/manifest.webmanifest">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-title" content="القدس محل">
<link rel="icon" href="/qods/icon-512.png"><link rel="apple-touch-icon" href="/qods/icon-512.png"><title>القدس — المحل</title>
<style>
 :root{--g:#0F6E56;--gd:#085041;--gl:#E1F5EE;--red:#A32D2D;--redl:#FCEBEB;--bg:#f4f5f3;--card:#fff;--line:#e5e5e0;--mut:#6b6b66;--txt:#1c1c1a}
 *{box-sizing:border-box}body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Tahoma,Arial,sans-serif;background:var(--bg);color:var(--txt)}
 .wrap{max-width:720px;margin:0 auto;min-height:100vh}
 header{position:sticky;top:0;z-index:10;background:var(--g);color:var(--gl);padding:11px 14px;display:flex;align-items:center;justify-content:space-between}
 header .t{font-size:16px;font-weight:600}
 .tabs{display:flex;background:var(--gd)}
 .tabs button{flex:1;background:transparent;border:0;color:#bfe6d8;padding:11px 4px;font-size:14px;font-family:inherit;cursor:pointer}
 .tabs button.on{color:#fff;border-bottom:3px solid #fff;font-weight:600}
 .pad{padding:12px 14px}
 .search{display:flex;align-items:center;gap:8px;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:0 12px;margin-bottom:10px}
 .search input{border:0;outline:0;padding:11px 0;font-size:15px;width:100%;background:transparent;font-family:inherit}
 .grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
 @media(min-width:560px){.grid{grid-template-columns:repeat(auto-fill,minmax(130px,1fr))}}
 .p{background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden;cursor:pointer;text-align:center}
 .p .ib{width:100%;aspect-ratio:1/1;background:#eee;display:flex;align-items:center;justify-content:center}
 .p .ib img{width:100%;height:100%;object-fit:cover}.p .ib span{color:#bbb;font-size:22px}
 .p .n{font-size:11px;font-weight:600;padding:4px 5px 0;min-height:30px;line-height:1.3}
 .p .pr{font-size:12px;color:var(--g);font-weight:700;padding:0 5px 6px}
 .cartbar{position:sticky;bottom:0;background:var(--card);border-top:1px solid var(--line);padding:10px 14px;display:flex;gap:8px;align-items:center}
 .btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;border:1px solid var(--g);background:var(--g);color:#fff;border-radius:10px;padding:11px 14px;font-size:15px;cursor:pointer;font-family:inherit}
 .btn.o{background:transparent;color:var(--g)}.btn.sm{padding:7px 10px;font-size:13px}
 .cards{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;margin-bottom:12px}
 .c{background:var(--card);border-radius:12px;padding:12px;border:1px solid var(--line)}.c .l{font-size:12px;color:var(--mut)}.c .v{font-size:20px;font-weight:700;margin-top:3px}
 .green{color:var(--g)}.redc{color:var(--red)}
 .row{display:flex;align-items:center;justify-content:space-between;background:var(--card);border:1px solid var(--line);border-radius:10px;padding:9px 11px;margin-bottom:7px;font-size:14px}
 .overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);display:none;z-index:50;align-items:flex-end;justify-content:center}
 .sheet{background:var(--bg);width:100%;max-width:720px;max-height:92vh;overflow-y:auto;border-radius:16px 16px 0 0;padding:14px}
 .li{display:flex;align-items:center;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--line);font-size:14px}
 .qty{display:flex;align-items:center;gap:8px}.qty button{width:30px;height:30px;border-radius:8px;border:1px solid var(--line);background:#fff;font-size:18px;cursor:pointer}
 .center{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:24px}
 .login{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:26px 22px;width:100%;max-width:330px;text-align:center}
 .login input{width:100%;padding:12px;font-size:20px;text-align:center;letter-spacing:4px;border:1px solid var(--line);border-radius:10px;margin:14px 0;font-family:inherit}
 .err{color:var(--red);font-size:13px;min-height:18px}.muted{color:var(--mut);font-size:13px}.empty{text-align:center;color:var(--mut);padding:30px 0}
 input.f{width:100%;padding:10px;border:1px solid var(--line);border-radius:10px;font-family:inherit;font-size:15px}
</style></head>
<body><div class="wrap" id="app"><div class="empty">...</div></div>
<div class="overlay" id="ov"><div class="sheet" id="sheet"></div></div>
<script>
var T=localStorage.getItem('pos_token')||'',ROLE=localStorage.getItem('pos_role')||'',PROD=[],CART=[],TAB='sell';
function el(i){return document.getElementById(i);}
function money(n){return (Math.round(Number(n)||0)).toLocaleString('en-US');}
function esc(s){return String(s==null?'':s).replace(/[<>&"]/g,function(c){return{'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c];});}
function norm(s){return String(s||'').toLowerCase().replace(/[أإآ]/g,'ا').replace(/ة/g,'ه').replace(/[ىي]/g,'ي').replace(/\\s+/g,' ').trim();}
function cw(){return ROLE==='admin'||ROLE==='manager';}
function mgr(){return ROLE==='manager';}
function dlg(title,fields,onok){
  var h='<div style="font-size:16px;font-weight:700;margin-bottom:12px">'+esc(title)+'</div>';
  fields.forEach(function(f){h+='<div style="margin-bottom:11px"><label class="muted" style="display:block;margin-bottom:4px">'+esc(f.label)+'</label>'+(f.type==='select'?('<select class="f" id="dg_'+f.k+'">'+f.opts.map(function(o){return '<option value="'+esc(o.v)+'"'+(o.v===f.value?' selected':'')+'>'+esc(o.t)+'</option>';}).join('')+'</select>'):('<input class="f" id="dg_'+f.k+'" type="'+(f.type||'text')+'" '+(f.type==='number'?'inputmode="decimal"':'')+' value="'+esc(f.value==null?'':f.value)+'" placeholder="'+esc(f.ph||'')+'">'))+'</div>';});
  h+='<button class="btn" style="width:100%;margin-top:4px" id="dg_ok">تمام</button><button class="btn o" style="width:100%;margin-top:8px" id="dg_cx">إلغاء</button>';
  el('sheet').innerHTML=h;el('ov').style.display='flex';
  el('dg_cx').onclick=function(){el('ov').style.display='none';};
  el('dg_ok').onclick=function(){var v={};fields.forEach(function(f){v[f.k]=el('dg_'+f.k).value;});el('ov').style.display='none';onok(v);};
  var f0=fields[0]&&el('dg_'+fields[0].k);if(f0&&f0.focus)try{f0.focus();}catch(e){}
}
function confirmBox(msg,onok){el('sheet').innerHTML='<div style="font-size:15px;margin:6px 0 16px">'+esc(msg)+'</div><button class="btn" style="width:100%" id="cf_ok">تمام</button><button class="btn o" style="width:100%;margin-top:8px" id="cf_cx">إلغاء</button>';el('ov').style.display='flex';el('cf_cx').onclick=function(){el('ov').style.display='none';};el('cf_ok').onclick=function(){el('ov').style.display='none';onok();};}
function toast(m){var t=document.createElement('div');t.textContent=m;t.style.cssText='position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:#2c2c2a;color:#fff;padding:11px 20px;border-radius:22px;z-index:200;font-size:14px;max-width:90%;text-align:center';document.body.appendChild(t);setTimeout(function(){t.remove();},2600);}
function api(p,o){o=o||{};o.headers=o.headers||{};if(T)o.headers.Authorization='Bearer '+T;if(o.body){o.headers['Content-Type']='application/json';o.body=JSON.stringify(o.body);}return fetch('/pos/api/'+p,o).then(function(r){if(r.status===401){logout();throw new Error('x');}return r.json();});}
function logout(){localStorage.removeItem('pos_token');localStorage.removeItem('pos_role');T='';ROLE='';renderLogin();}
function renderLogin(){el('app').innerHTML='<div class="center"><div class="login"><div style="font-size:20px;font-weight:700;color:var(--g)">🛗 القدس — المحل</div><div class="muted" style="margin-top:6px">اكتب كود الدخول</div><input id="code" type="tel" inputmode="numeric" placeholder="كود"><div class="err" id="e"></div><button class="btn" style="width:100%" id="lb">دخول</button></div></div>';el('code').focus();el('lb').onclick=doLogin;el('code').addEventListener('keydown',function(e){if(e.key==='Enter')doLogin();});}
function doLogin(){var code=el('code').value.trim();fetch('/pos/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:code})}).then(function(r){return r.json();}).then(function(d){if(!d.ok){el('e').textContent=d.error||'غلط';return;}T=d.token;ROLE=d.role;localStorage.setItem('pos_token',T);localStorage.setItem('pos_role',ROLE);localStorage.setItem('pos_name',d.name||'');home();}).catch(function(){el('e').textContent='مشكلة';});}
function home(){
  el('app').innerHTML='<header><div class="t">🛗 القدس — المحل</div><button class="btn sm o" style="color:#fff;border-color:#fff" id="out">خروج</button></header><div class="tabs" id="tabs"></div><div id="body" class="pad"><div class="empty">بحمّل...</div></div>';
  el('out').onclick=logout;
  var tabs=[['sell','🛒 بيع'],['drawer','💵 الخزنة'],['staff','👷 موظفين']];if(mgr()){tabs.push(['report','📊 اليومية']);tabs.push(['settings','⚙️ إعدادات']);}
  el('tabs').innerHTML=tabs.map(function(t){return '<button data-t="'+t[0]+'" class="'+(TAB===t[0]?'on':'')+'">'+t[1]+'</button>';}).join('');
  el('tabs').onclick=function(e){var b=e.target.closest('button');if(!b)return;TAB=b.getAttribute('data-t');home();};
  if(TAB==='sell')sell();else if(TAB==='drawer')drawer();else if(TAB==='staff')staff();else if(TAB==='report')report();else settings();
}
/* ---- بيع ---- */
function sell(){
  el('body').innerHTML='<div class="search">🔎<input id="q" placeholder="دوّر على منتج..."></div><div class="grid" id="g"><div class="empty">بحمّل...</div></div>';
  function paint(list){el('g').innerHTML=list.slice(0,300).map(function(p){var img=p.img?'<img loading="lazy" src="'+esc(p.img)+'">':'<span>🛗</span>';return '<div class="p" data-i="'+p._i+'"><div class="ib">'+img+'</div><div class="n">'+esc(p.name)+'</div><div class="pr">'+money(p.price)+' ج</div></div>';}).join('')||'<div class="empty">مفيش</div>';}
  function go(){var P=PROD.map(function(p,i){p._i=i;return p;});paint(P);el('q').addEventListener('input',function(){var q=norm(el('q').value);paint(q?P.filter(function(p){return norm(p.name).indexOf(q)>=0;}):P);});el('g').onclick=function(e){var c=e.target.closest('.p');if(c)addCart(PROD[Number(c.getAttribute('data-i'))]);};renderCartBar();}
  if(PROD.length)go();else api('products').then(function(d){PROD=d.products||[];go();});
}
function addCart(p){var f=CART.find(function(x){return x.name===p.name&&x.price===p.price;});if(f)f.qty++;else CART.push({name:p.name,price:p.price,qty:1});renderCartBar();}
function cartTotal(){return CART.reduce(function(s,x){return s+x.price*x.qty;},0);}
function renderCartBar(){var old=document.getElementById('cb');if(old)old.remove();if(!cw())return;var n=CART.reduce(function(s,x){return s+x.qty;},0);var bar=document.createElement('div');bar.id='cb';bar.className='cartbar';bar.innerHTML='<div style="flex:1"><b>'+n+'</b> صنف · <b>'+money(cartTotal())+'</b> ج</div><button class="btn o sm" id="clr">تفريغ</button><button class="btn" id="chk">الدفع ('+money(cartTotal())+')</button>';el('app').appendChild(bar);el('clr').onclick=function(){CART=[];sell();};el('chk').onclick=checkout;}
function checkout(){
  if(!CART.length){toast('مفيش أصناف');return;}
  var h='<div style="font-size:16px;font-weight:700;margin-bottom:8px">الفاتورة</div>';
  h+=CART.map(function(x,i){return '<div class="li"><span>'+esc(x.name)+'</span><span class="qty"><button data-d="'+i+'">−</button>'+x.qty+'<button data-u="'+i+'">+</button> · '+money(x.price*x.qty)+'</span></div>';}).join('');
  h+='<div class="li"><span>الإجمالي</span><b>'+money(cartTotal())+' ج</b></div>';
  h+='<div style="margin:10px 0"><label class="muted">خصم (جنيه)</label><input class="f" id="disc" type="number" inputmode="numeric" value="0"></div>';
  h+='<div style="margin:10px 0"><label class="muted">اسم العميل (اختياري)</label><input class="f" id="cust" placeholder="عميل نقدي"></div>';
  h+='<div id="net" style="font-size:18px;font-weight:700;text-align:center;margin:8px 0"></div>';
  h+='<button class="btn" style="width:100%" id="done">تم البيع ✅</button><button class="btn o" style="width:100%;margin-top:8px" id="cx">رجوع</button>';
  el('sheet').innerHTML=h;el('ov').style.display='flex';
  function upNet(){var d=Number(el('disc').value)||0;el('net').textContent='المطلوب: '+money(Math.max(0,cartTotal()-d))+' ج';}
  upNet();el('disc').addEventListener('input',upNet);
  el('cx').onclick=function(){el('ov').style.display='none';};
  el('sheet').onclick=function(e){var u=e.target.closest('[data-u]'),dd=e.target.closest('[data-d]');if(u){CART[Number(u.getAttribute('data-u'))].qty++;checkout();}else if(dd){var i=Number(dd.getAttribute('data-d'));CART[i].qty--;if(CART[i].qty<=0)CART.splice(i,1);if(!CART.length){el('ov').style.display='none';sell();}else checkout();}};
  el('done').onclick=function(){var disc=Number(el('disc').value)||0,cust=el('cust').value;api('sale',{method:'POST',body:{items:CART,discount:disc,customer:cust}}).then(function(d){if(d.ok){el('ov').style.display='none';CART=[];showInvoice(d.sale);}else toast(d.error||'مشكلة');});};
}
function showInvoice(s){
  var h='<div style="text-align:center"><div style="font-size:18px;font-weight:700;color:var(--g)">🛗 القدس لمهمات المصاعد</div><div class="muted">فاتورة رقم '+esc(s.no)+'</div></div><hr>';
  h+=s.items.map(function(x){return '<div class="li"><span>'+esc(x.name)+' ×'+x.qty+'</span><span>'+money(x.price*x.qty)+'</span></div>';}).join('');
  h+='<div class="li"><span>الإجمالي</span><span>'+money(s.subtotal)+'</span></div>';
  if(s.discount)h+='<div class="li"><span>خصم</span><span>-'+money(s.discount)+'</span></div>';
  h+='<div class="li"><b>المدفوع</b><b>'+money(s.total)+' ج</b></div>';
  if(s.customer)h+='<div class="muted" style="margin-top:6px">العميل: '+esc(s.customer)+'</div>';
  if(s.seller)h+='<div class="muted">البايع: '+esc(s.seller)+'</div>';
  h+='<div class="muted" style="text-align:center;margin-top:8px">📞 01050699418</div>';
  var pw=(Number(localStorage.getItem('pos_pw'))||576)===384?'58مم':'80مم';
  var cp=Number(localStorage.getItem('pos_copies'))||1;
  h+='<button class="btn" style="width:100%;margin-top:12px" id="pth">🖨️ طباعة ('+cp+' نسخة)</button>';
  h+='<div style="display:flex;gap:8px;margin-top:8px"><button class="btn o sm" id="cpb" style="flex:1">نسخ: '+cp+'</button><button class="btn o sm" id="pwb" style="flex:1">مقاس: '+pw+'</button></div>';
  h+='<div style="display:flex;gap:8px;margin-top:8px"><button class="btn o sm" id="pusb" style="flex:1">USB مباشر</button><button class="btn o sm" id="pnorm" style="flex:1">عادية (كمبيوتر)</button></div>';
  h+='<button class="btn o" style="width:100%;margin-top:8px" id="ok">تمام</button>';
  el('sheet').innerHTML=h;el('ov').style.display='flex';
  el('ok').onclick=function(){el('ov').style.display='none';if(TAB!=='drawer')sell();};
  el('pth').onclick=function(){printThermal(s);};
  el('pusb').onclick=function(){printUSB(s);};
  el('pnorm').onclick=function(){window.print();};
  el('pwb').onclick=function(){var cur=Number(localStorage.getItem('pos_pw'))||576;localStorage.setItem('pos_pw',cur===576?384:576);showInvoice(s);};
  el('cpb').onclick=function(){localStorage.setItem('pos_copies',cp===1?2:1);showInvoice(s);};
}
/* ---- طباعة حرارية USB (أندرويد Chrome) — الفاتورة كصورة عشان العربي يطلع صح ---- */
function fmtDate(iso){try{var d=new Date(iso);function p(n){return (n<10?'0':'')+n;}return p(d.getDate())+'/'+p(d.getMonth()+1)+'/'+d.getFullYear()+' '+p(d.getHours())+':'+p(d.getMinutes());}catch(e){return '';}}
function drawReceipt(s,W){
  var ops=[];
  ops.push({k:'c',t:'القدس لمهمات المصاعد',s:32,b:1});
  ops.push({k:'c',t:'فاتورة رقم: '+s.no,s:22});
  ops.push({k:'c',t:fmtDate(s.at),s:18});
  ops.push({k:'line'});
  s.items.forEach(function(it){ops.push({k:'lr',l:money(it.price*it.qty),r:it.name+' ×'+it.qty,s:22});});
  ops.push({k:'line'});
  ops.push({k:'lr',l:money(s.subtotal),r:'الإجمالي',s:22});
  if(s.discount)ops.push({k:'lr',l:'-'+money(s.discount),r:'خصم',s:22});
  ops.push({k:'lr',l:money(s.total)+' ج',r:'المدفوع',s:28,b:1});
  if(s.customer)ops.push({k:'r',t:'العميل: '+s.customer,s:20});
  ops.push({k:'line'});
  ops.push({k:'c',t:'تليفون: 01050699418',s:20});
  ops.push({k:'c',t:'شكراً لتعاملكم معنا',s:18});
  var pad=14,y=pad;
  ops.forEach(function(o){if(o.k==='line'){o.y=y+6;y+=16;}else{o.s=o.s||20;o.y=y+o.s;y+=o.s+12;}});
  var H=y+pad;
  var c=document.createElement('canvas');c.width=W;c.height=H;
  var x=c.getContext('2d');x.fillStyle='#fff';x.fillRect(0,0,W,H);x.fillStyle='#000';x.direction='rtl';
  var px=14,right=W-px,left=px;
  ops.forEach(function(o){
    if(o.k==='line'){x.fillRect(px,o.y,W-2*px,2);return;}
    x.font=(o.b?'bold ':'')+o.s+'px Tahoma,"Segoe UI",sans-serif';
    if(o.k==='c'){x.textAlign='center';x.fillText(o.t,W/2,o.y);}
    else if(o.k==='r'){x.textAlign='right';x.fillText(o.t,right,o.y);}
    else{x.textAlign='right';x.fillText(o.r,right,o.y);x.textAlign='left';x.fillText(o.l,left,o.y);}
  });
  return c;
}
function canvasToEscpos(canvas){
  var ctx=canvas.getContext('2d'),W=canvas.width,H=canvas.height,img=ctx.getImageData(0,0,W,H).data;
  var wb=Math.ceil(W/8),out=[0x1D,0x76,0x30,0x00,wb&0xff,(wb>>8)&0xff,H&0xff,(H>>8)&0xff];
  for(var yy=0;yy<H;yy++){for(var xb=0;xb<wb;xb++){var b=0;for(var bit=0;bit<8;bit++){var xx=xb*8+bit;if(xx<W){var i=(yy*W+xx)*4;var lum=(img[i]+img[i+1]+img[i+2])/3;if(img[i+3]>128&&lum<140)b|=(0x80>>bit);}}out.push(b);}}
  out.push(0x0A,0x0A,0x0A,0x0A,0x1D,0x56,0x42,0x00);
  return new Uint8Array(out);
}
async function getPrinter(){
  var dev=window._usbdev;
  if(!dev){var ds=await navigator.usb.getDevices();dev=ds&&ds[0];}
  if(!dev){dev=await navigator.usb.requestDevice({filters:[]});}
  if(!dev.opened)await dev.open();
  if(!dev.configuration)await dev.selectConfiguration(1);
  var ifn=null,epn=null;
  dev.configuration.interfaces.forEach(function(i){i.alternates.forEach(function(a){a.endpoints.forEach(function(e){if(e.direction==='out'&&epn===null){ifn=i.interfaceNumber;epn=e.endpointNumber;}});});});
  if(epn===null)throw new Error('مفيش منفذ إخراج في الطابعة');
  try{await dev.claimInterface(ifn);}catch(e){}
  window._usbdev=dev;window._usbep=epn;return dev;
}
function bytesToB64(bytes){var bin='';var CH=0x8000;for(var i=0;i<bytes.length;i+=CH){bin+=String.fromCharCode.apply(null,bytes.subarray(i,i+CH));}return btoa(bin);}
function escposFor(s,copies,W){var one=canvasToEscpos(drawReceipt(s,W));var init=new Uint8Array([0x1B,0x40]);var total=(init.length+one.length)*copies;var out=new Uint8Array(total);var off=0;for(var c=0;c<copies;c++){out.set(init,off);off+=init.length;out.set(one,off);off+=one.length;}return out;}
/* الطباعة عبر RawBT (أندرويد) — بنبعت الفاتورة كـ ESC/POS صورة */
function printThermal(s){
  var W=Number(localStorage.getItem('pos_pw'))||576;
  var copies=Number(localStorage.getItem('pos_copies'))||1;
  try{
    var b64=bytesToB64(escposFor(s,copies,W));
    window.location.href='rawbt:base64,'+b64;
  }catch(e){toast('مشكلة في تجهيز الطباعة: '+(e.message||e));}
}
/* طباعة USB مباشرة (احتياطي) */
async function printUSB(s){
  if(!navigator.usb){toast('لازم Chrome على أندرويد');return;}
  try{
    var W=Number(localStorage.getItem('pos_pw'))||576;
    var copies=Number(localStorage.getItem('pos_copies'))||1;
    var bytes=canvasToEscpos(drawReceipt(s,W));
    var dev=await getPrinter();
    for(var c=0;c<copies;c++){
      await dev.transferOut(window._usbep,new Uint8Array([0x1B,0x40]));
      for(var i=0;i<bytes.length;i+=8192){await dev.transferOut(window._usbep,bytes.slice(i,i+8192));}
    }
    toast('اتطبعت ✅');
  }catch(e){window._usbdev=null;toast('مشكلة USB: '+(e.message||e));}
}
/* ---- الخزنة ---- */
function drawer(){
  api('day').then(function(d){
    window._today=d.sales||[];
    var h='<div class="cards"><div class="c"><div class="l">دخل النهارده</div><div class="v green">'+money(d.income)+'</div></div><div class="c"><div class="l">عدد الفواتير</div><div class="v">'+d.count+'</div></div></div>';
    h+='<div class="actions" style="margin-bottom:10px">'+(cw()?'<button class="btn sm o" id="exp">+ نثرية</button>':'')+'<button class="btn sm o" id="find">🔎 فاتورة برقمها</button></div>';
    h+='<div style="font-size:13px;color:var(--mut);margin-bottom:6px">فواتير النهارده (دوس على أي واحدة تفتحها/تطبعها)</div>';
    h+=(d.sales||[]).map(function(s){return '<div class="row" data-no="'+esc(s.no)+'" style="cursor:pointer"><span>'+esc(s.no)+(s.seller?' · '+esc(s.seller):'')+(s.customer?' · '+esc(s.customer):'')+'</span><b>'+money(s.total)+' ج</b></div>';}).join('')||'<div class="empty">لسه مفيش بيع</div>';
    el('body').innerHTML=h;
    if(el('exp'))el('exp').onclick=function(){dlg('نثرية جديدة',[{k:'amount',label:'قيمة النثرية (جنيه)',type:'number'},{k:'note',label:'على إيه؟'}],function(v){api('expense',{method:'POST',body:{amount:Number(v.amount)||0,note:v.note}}).then(function(){toast('اتسجّلت ✅');drawer();});});};
    el('find').onclick=function(){dlg('بحث عن فاتورة',[{k:'no',label:'رقم الفاتورة (زي 261002-WV1)'}],function(v){if(!v.no){return;}api('invoice?no='+encodeURIComponent(v.no.trim())).then(function(r){if(r.ok&&r.sale)showInvoice(r.sale);else toast('مفيش فاتورة بالرقم ده');});});};
    el('body').onclick=function(e){var r=e.target.closest('[data-no]');if(!r)return;var no=r.getAttribute('data-no');var s=(window._today||[]).find(function(x){return x.no===no;});if(s)showInvoice(s);};
  });
}
/* ---- موظفين ---- */
function staff(){
  api('staff').then(function(d){
    var h='';if(d.isManager)h+='<div class="actions" style="margin-bottom:10px"><button class="btn sm" id="add">+ موظف</button></div>';
    h+=(d.emps||[]).map(function(e){return '<div class="row" data-id="'+e.id+'"><span>'+esc(e.name)+'<div class="muted">غياب: '+(e.absDays||0)+' يوم'+(d.isManager?' · يومية '+money(e.dayVal)+' ج':'')+'</div></span>'+(d.canWrite?'<button class="btn sm o" data-abs="'+e.id+'">+ غياب</button>':'')+'</span></div>';}).join('')||'<div class="empty">مفيش موظفين</div>';
    el('body').innerHTML=h;
    if(el('add'))el('add').onclick=function(){dlg('موظف جديد',[{k:'name',label:'اسم الموظف'},{k:'salary',label:'راتبه (÷24 لليومية)',type:'number'}],function(v){if(!v.name){toast('اكتب الاسم');return;}api('staff/add',{method:'POST',body:{name:v.name,salary:Number(v.salary)||0}}).then(function(){staff();});});};
    el('body').onclick=function(e){var b=e.target.closest('[data-abs]');if(!b)return;var id=b.getAttribute('data-abs');dlg('تسجيل غياب',[{k:'days',label:'غاب كام يوم؟',type:'number',value:'1'}],function(v){api('staff/absence',{method:'POST',body:{id:id,days:Number(v.days)||0}}).then(function(){staff();});});};
  });
}
/* ---- التقرير اليومي (مدير) ---- */
function report(){
  api('report?date=').then(function(d){
    if(!d.ok){el('body').innerHTML='<div class="empty">'+(d.error||'')+'</div>';return;}
    function r(l,v,c){return '<div class="li"><span>'+l+'</span><b class="'+(c||'')+'">'+money(v)+' ج</b></div>';}
    el('body').innerHTML='<div class="muted" style="margin-bottom:8px">تقرير النهارده</div>'+r('دخل المبيعات',d.income,'green')+r('النثريات',d.petty,'redc')+r('يوميات الموظفين',d.wages,'redc')+'<div class="li" style="font-size:18px"><b>الصافي (كسب/خسارة)</b><b class="'+(d.net>=0?'green':'redc')+'">'+money(d.net)+' ج</b></div>';
  });
}
/* ---- الإعدادات (مدير): أكواد + صلاحيات + نسخ اللينكات ---- */
function roleLbl(r){return r==='manager'?'كامل':r==='admin'?'تعديل وبيع':'مشاهدة';}
function settings(){
  api('settings').then(function(d){
    if(!d.ok){el('body').innerHTML='<div class="empty">'+(d.error||'للمدير بس')+'</div>';return;}
    var o=location.origin;
    var h='<div style="font-size:13px;color:var(--mut);font-weight:600;margin-bottom:6px">اللينكات (انسخ وابعت)</div>';
    h+='<div class="row"><span>🛗 لينك المنتجات (للزباين)</span><button class="btn sm" data-cp="'+o+'/qods">نسخ</button></div>';
    h+='<div class="row"><span>🛒 لينك البرنامج (الكاشير)</span><button class="btn sm" data-cp="'+o+'/pos">نسخ</button></div>';
    h+='<div style="font-size:13px;color:var(--mut);font-weight:600;margin:14px 0 6px">الأكواد</div>';
    h+='<div class="row"><span>👑 المدير (يشوف الأرباح): <b>'+esc(d.manager)+'</b></span><button class="btn sm o" data-ec="manager">تغيير</button></div>';
    h+='<div class="row"><span>✏️ الإدارة (بيع): <b>'+esc(d.admin)+'</b></span><button class="btn sm o" data-ec="admin">تغيير</button></div>';
    h+='<div class="row"><span>👁️ مشاهدة: <b>'+esc(d.view)+'</b></span><button class="btn sm o" data-ec="view">تغيير</button></div>';
    h+='<div style="font-size:13px;color:var(--mut);font-weight:600;margin:14px 0 6px">أكواد الموظفين</div><div style="margin-bottom:8px"><button class="btn sm" id="addc">+ كود موظف</button></div>';
    (d.extra||[]).forEach(function(x){h+='<div class="row"><span>'+esc(x.name)+' — <b>'+esc(x.code)+'</b> — '+roleLbl(x.role)+'</span><button class="btn sm o" data-rm="'+esc(x.code)+'" style="color:#A32D2D;border-color:#A32D2D">حذف</button></div>';});
    if(!(d.extra||[]).length)h+='<div class="muted">مفيش أكواد موظفين</div>';
    el('body').innerHTML=h;
    el('addc').onclick=function(){dlg('كود موظف جديد',[{k:'name',label:'اسم الموظف'},{k:'code',label:'الكود'},{k:'role',label:'الصلاحية',type:'select',value:'admin',opts:[{v:'view',t:'مشاهدة'},{v:'admin',t:'تعديل وبيع'},{v:'manager',t:'كامل (يشوف الأرباح)'}]}],function(v){if(!v.name||!v.code){toast('اكتب الاسم والكود');return;}api('settings/extra',{method:'POST',body:{name:v.name,code:v.code,role:v.role}}).then(function(x){if(x.ok)settings();else toast(x.error||'مشكلة');});});};
    el('body').onclick=function(e){
      var cp=e.target.closest('[data-cp]'),ec=e.target.closest('[data-ec]'),rm=e.target.closest('[data-rm]');
      if(cp){var L=cp.getAttribute('data-cp');if(navigator.clipboard&&navigator.clipboard.writeText)navigator.clipboard.writeText(L).then(function(){toast('اتنسخ ✅');},function(){toast(L);});else toast(L);}
      else if(ec){var w=ec.getAttribute('data-ec');dlg('كود جديد',[{k:'v',label:'الكود الجديد'}],function(v){if(!v.v){toast('اكتب الكود');return;}api('settings/code',{method:'POST',body:{which:w,value:v.v}}).then(function(x){if(x.ok)settings();else toast(x.error||'مشكلة');});});}
      else if(rm){var code=rm.getAttribute('data-rm');confirmBox('تحذف الكود؟',function(){api('settings/extra-remove',{method:'POST',body:{code:code}}).then(function(){settings();});});}
    };
  });
}
if(T&&ROLE)home();else renderLogin();
if('serviceWorker' in navigator){navigator.serviceWorker.register('/pos/sw.js',{scope:'/pos'}).catch(function(){});}
</script></body></html>`;
