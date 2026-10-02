/**
 * سيستم الصيانة (ويب) — نفس داتا البوت (maint:data في KV/D1).
 * صفحة واحدة + API تحت /maint. دخول بكود: كود إدارة (كتابة) وكود مشاهدة (قراءة بس).
 *
 * المسارات:
 *   GET  /maint                     صفحة السيستم
 *   POST /maint/api/login           { code } → { role, token }
 *   GET  /maint/api/summary         إجماليات الشهر الحالي + المناطق
 *   GET  /maint/api/buildings       ?zone=&q=  قائمة مختصرة
 *   GET  /maint/api/building        ?id=       ملف كامل
 *   POST /maint/api/pay             { id, month, amount }           [إدارة]
 *   POST /maint/api/event           { id, type, text }             [إدارة]
 *   POST /maint/api/set             { id, field, value }           [إدارة]
 *   POST /maint/api/add             { num, value, paid, ... }      [إدارة]
 *   GET  /maint/api/photo           ?id=   بايتات الصورة
 *   POST /maint/api/photo           { bid, b64, mime, caption }    [إدارة]
 */
import { loadMaint, saveMaint, cairoNow, MONTHS_AR } from './maintenance.js';

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
  if (!['admin', 'view'].includes(role)) return null;
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
function monthStatus(b, m) {
  return b.months && b.months[m] != null;
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
  if (!pathname.startsWith('/maint/api/')) return null;

  // تسجيل الدخول
  if (pathname === '/maint/api/login' && method === 'POST') {
    const body = await request.json().catch(() => ({}));
    const code = String(body.code || '').trim();
    let role = null;
    if (code && code === adminCode(env)) role = 'admin';
    else if (code && code === viewCode(env)) role = 'view';
    if (!role) return json({ ok: false, error: 'الكود غلط' }, 401);
    return json({ ok: true, role, token: await makeToken(role, env) });
  }

  // كل الباقي محتاج توكن صالح
  const role = await verifyToken(bearer(request), env);
  if (!role) return json({ ok: false, error: 'محتاج تسجيل دخول' }, 401);
  const canWrite = role === 'admin';
  const needWrite = () => json({ ok: false, error: 'صلاحيتك مشاهدة بس' }, 403);

  const data = await loadMaint(env);
  const now = cairoNow();

  if (pathname === '/maint/api/summary' && method === 'GET') {
    const active = data.buildings.filter((b) => b.active !== false);
    const m = Number(url.searchParams.get('month')) || now.m;
    const expected = active.reduce((s, b) => s + (b.paid || 0), 0);
    const collected = active.reduce((s, b) => s + ((b.months && b.months[m]) || 0), 0);
    const unpaid = active.filter((b) => !monthStatus(b, m));
    const zones = {};
    for (const b of active) zones[b.zone || '—'] = (zones[b.zone || '—'] || 0) + 1;
    return json({
      ok: true, role, month: m, monthName: MONTHS_AR[m - 1],
      total: active.length, expected, collected, due: expected - collected, unpaidCount: unpaid.length,
      faults: active.filter(hasOpenFault).length,
      zones: Object.keys(zones).sort().map((z) => ({ zone: z, count: zones[z] })),
    });
  }

  if (pathname === '/maint/api/buildings' && method === 'GET') {
    const m = Number(url.searchParams.get('month')) || now.m;
    const zone = url.searchParams.get('zone') || '';
    const q = (url.searchParams.get('q') || '').trim().toLowerCase();
    let list = data.buildings.filter((b) => b.active !== false);
    if (zone) list = list.filter((b) => b.zone === zone);
    if (q) list = list.filter((b) => (b.num + ' ' + (b.name || '')).toLowerCase().includes(q));
    list = list.sort((a, b) => String(a.zone).localeCompare(String(b.zone), 'ar') || (a.number || 0) - (b.number || 0));
    return json({
      ok: true,
      buildings: list.slice(0, 500).map((b) => ({
        id: b.id, num: b.num, zone: b.zone, name: b.name || '', value: b.value, paid: b.paid,
        paidThisMonth: monthStatus(b, m), fault: hasOpenFault(b),
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
    const amount = Number(body.amount);
    if (!Number.isFinite(amount)) return json({ ok: false, error: 'مبلغ غلط' }, 400);
    b.months = b.months || {};
    b.months[m] = amount;
    b.events = b.events || [];
    b.events.push({ type: 'payment', text: `اتحصّل ${amount} ج عن ${MONTHS_AR[m - 1]}`, amount, month: m, by: role, at: now.iso });
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
    b.events.push({ type, text: text || 'اتعملت صيانة', by: role, at: now.iso });
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
      unionHead: body.unionHead || '', unionPhone: String(body.unionPhone || '').replace(/[^\d+]/g, ''),
      driveFolder: body.driveFolder || '', active: true, year: now.y, months: {}, events: [], photos: [],
      createdAt: now.iso, updatedAt: now.iso,
    };
    data.buildings.push(b);
    await saveMaint(env, data);
    return json({ ok: true, building: b });
  }

  if (pathname === '/maint/api/broadcast' && method === 'GET') {
    const phones = [];
    const contactsOf = (b) => (Array.isArray(b.contacts) && b.contacts.length ? b.contacts : (b.unionHead || b.unionPhone ? [{ name: b.unionHead, phone: b.unionPhone }] : []));
    for (const b of data.buildings) {
      if (b.active === false) continue;
      for (const c of contactsOf(b)) if (c.phone) phones.push({ num: b.num, name: c.name || '', phone: String(c.phone).replace(/[^\d]/g, '').replace(/^0/, '20') });
    }
    const seen = new Set();
    const uniq = phones.filter((p) => (seen.has(p.phone) ? false : (seen.add(p.phone), true)));
    return json({ ok: true, count: uniq.length, contacts: uniq });
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
    b.photos.push({ id: pid, mime: body.mime || 'image/jpeg', caption: String(body.caption || ''), at: now.iso, by: role });
    while (b.photos.length > 20) { const old = b.photos.shift(); await env.MEMORY.delete(PHOTO_KEY(old.id)).catch(() => {}); }
    b.events = b.events || [];
    b.events.push({ type: 'photo', text: 'صورة' + (body.caption ? ' — ' + body.caption : ''), by: role, at: now.iso });
    b.updatedAt = now.iso;
    await saveMaint(env, data);
    return json({ ok: true, building: b });
  }

  return json({ ok: false, error: 'مسار غير معروف' }, 404);
}

/* ================= واجهة السيستم (صفحة واحدة) ================= */
const APP_HTML = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1">
<title>صيانة توب باور</title>
<style>
  :root{--g:#0F6E56;--gd:#085041;--gl:#E1F5EE;--red:#A32D2D;--redl:#FCEBEB;--bg:#f4f5f3;--card:#fff;--line:#e5e5e0;--mut:#6b6b66;--txt:#1c1c1a}
  *{box-sizing:border-box;-webkit-tap-highlight-color:transparent}
  body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Tahoma,Arial,sans-serif;background:var(--bg);color:var(--txt);font-size:16px}
  .wrap{max-width:560px;margin:0 auto;min-height:100vh;background:var(--bg)}
  header{position:sticky;top:0;z-index:10;background:var(--g);color:var(--gl);padding:12px 16px;display:flex;align-items:center;justify-content:space-between}
  header .t{font-size:17px;font-weight:600}
  .badge{font-size:12px;background:var(--gd);padding:4px 10px;border-radius:20px}
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
var T=localStorage.getItem('maint_token')||'', ROLE=localStorage.getItem('maint_role')||'', MONTH=0, ZONE='', Q='', FAULTSONLY=false, CUR=null;
var MON=['يناير','فبراير','مارس','ابريل','مايو','يونيو','يوليو','اغسطس','سبتمبر','اكتوبر','نوفمبر','ديسمبر'];
var MSH=['ينا','فبر','مار','ابر','ماي','يون','يول','اغس','سبت','اكت','نوف','ديس'];
var EVT={fault:'🔴 عطل',problem:'⚠️ مشكلة',measure:'📐 مقايسة',part:'🔩 قطعة غيار',maintenance:'🔧 صيانة اتعملت',pending:'📌 مطلوب',note:'📝 مذكرة',photo:'📷 صورة',payment:'💵 دفع'};
function esc(s){return String(s==null?'':s).replace(/[<>&"]/g,function(c){return {'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c];});}
function money(n){return (Math.round(Number(n)||0)).toLocaleString('en-US');}
function el(id){return document.getElementById(id);}
function api(path,opts){opts=opts||{};opts.headers=opts.headers||{};if(T)opts.headers.Authorization='Bearer '+T;if(opts.body){opts.headers['Content-Type']='application/json';opts.body=JSON.stringify(opts.body);}return fetch('/maint/api/'+path,opts).then(function(r){if(r.status===401){logout();throw new Error('login');}return r.json();});}
function logout(){localStorage.removeItem('maint_token');localStorage.removeItem('maint_role');T='';ROLE='';renderLogin();}
function dlabel(iso){try{var d=new Date(iso);return d.getUTCDate()+'/'+(d.getUTCMonth()+1);}catch(e){return '';}}

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
    T=d.token;ROLE=d.role;localStorage.setItem('maint_token',T);localStorage.setItem('maint_role',ROLE);renderHome();
  }).catch(function(){el('lerr').textContent='حصلت مشكلة، جرّب تاني';});
}

function renderHome(){
  FAULTSONLY=false;
  el('app').innerHTML='<header><div class="t">🏢 صيانة توب باور</div><span class="badge" id="mlabel">...</span></header><div class="pad" id="body"><div class="empty">بحمّل...</div></div>';
  api('summary').then(function(s){
    MONTH=s.month;el('mlabel').textContent=s.monthName;
    var h='<div class="cards">'+card('المطلوب',money(s.expected),'')+card('المتحصّل',money(s.collected),'green')+card('المتبقّي',money(s.due),'redc')+card('ما دفعوش',s.unpaidCount,'redc')+'</div>';
    h+='<div class="actions"><button class="btn sm" id="faultsBtn">🔴 أعطال ('+s.faults+')</button>'+(ROLE==='admin'?'<button class="btn sm o" id="bcBtn">📢 تحذير جماعي</button><button class="btn sm o" id="addBtn">+ عملية</button>':'')+'<button class="btn sm o" id="logoutBtn">خروج</button></div>';
    h+='<div class="search">🔎<input id="q" placeholder="دوّر على عمارة (زي 90ج)"></div>';
    h+='<div class="chips" id="chips"></div><div id="list"><div class="empty">بحمّل...</div></div>';
    el('body').innerHTML=h;
    el('q').value=Q;
    el('logoutBtn').addEventListener('click',logout);
    el('faultsBtn').addEventListener('click',function(){FAULTSONLY=!FAULTSONLY;loadList();});
    if(ROLE==='admin'){el('addBtn').addEventListener('click',addBuilding);el('bcBtn').addEventListener('click',broadcast);}
    var chips='<span class="chip '+(ZONE===''?'on':'')+'" data-z="">الكل</span>';
    s.zones.forEach(function(z){chips+='<span class="chip '+(ZONE===z.zone?'on':'')+'" data-z="'+esc(z.zone)+'">'+esc(z.zone)+' ('+z.count+')</span>';});
    el('chips').innerHTML=chips;
    el('chips').addEventListener('click',function(e){var c=e.target.closest('.chip');if(!c)return;ZONE=c.getAttribute('data-z');renderHome();});
    var qi=el('q'),t;qi.addEventListener('input',function(){clearTimeout(t);Q=qi.value;t=setTimeout(loadList,250);});
    var listEl=el('list');listEl.addEventListener('click',function(e){var r=e.target.closest('.row');if(r)openB(r.getAttribute('data-id'));});
    loadList();
  }).catch(function(){});
}
function card(l,v,cls){return '<div class="c"><div class="l">'+l+'</div><div class="v '+cls+'">'+v+'</div></div>';}

function loadList(){
  api('buildings?month='+MONTH+'&zone='+encodeURIComponent(ZONE)+'&q='+encodeURIComponent(Q)).then(function(d){
    var list=d.buildings||[];if(FAULTSONLY)list=list.filter(function(b){return b.fault;});
    var elx=el('list');if(!elx)return;
    if(!list.length){elx.innerHTML='<div class="empty">مفيش عمليات</div>';return;}
    elx.innerHTML=list.map(function(b){
      var tags=(b.fault?'<span class="tag tr">🔴 عطل</span>':'')+(b.paidThisMonth?'<span class="tag tg">✓ دفع</span>':'<span class="tag tr">ما دفعش</span>');
      return '<div class="row" data-id="'+esc(b.id)+'"><div><div class="n">'+esc(b.num)+'</div><div class="s">منطقة '+esc(b.zone)+' · '+money(b.paid)+' ج'+(b.name?' · '+esc(b.name):'')+'</div></div><div style="display:flex;align-items:center">'+tags+'</div></div>';
    }).join('');
  });
}

function openB(id){
  api('building?id='+encodeURIComponent(id)).then(function(d){
    if(!d.ok)return;var b=d.building;CUR=b;var adm=ROLE==='admin';
    var cts=(b.contacts&&b.contacts.length)?b.contacts:((b.unionHead||b.unionPhone)?[{name:b.unionHead||'',phone:b.unionPhone||''}]:[]);
    var uni=cts.length?cts.map(function(c){var w=c.phone?(' <a class="btn sm" target="_blank" href="https://wa.me/'+String(c.phone).replace(/[^0-9]/g,'').replace(/^0/,'20')+'?text='+encodeURIComponent('بخصوص صيانة '+b.num)+'">واتساب</a>'):'';return '👤 '+esc(c.name||'رئيس اتحاد')+(c.phone?' · '+esc(c.phone):'')+w;}).join('<br>'):'<span class="muted">مفيش رئيس اتحاد مسجّل</span>';
    var h='<header><div class="t">'+esc(b.num)+'</div><span class="badge" id="closeB" style="cursor:pointer">✕ إغلاق</span></header><div class="pad">';
    h+='<div class="muted">منطقة '+esc(b.zone)+' · القيمة '+money(b.value)+' · المدفوع '+money(b.paid)+' · الغفير '+money(b.guard)+'</div>';
    h+='<div style="margin:9px 0;line-height:2">'+uni+(adm?' <button class="btn sm o" id="edUnion">تعديل</button>':'')+'</div>';
    if(b.driveFolder)h+='<div style="margin:6px 0"><a class="btn sm o" target="_blank" href="'+esc(b.driveFolder)+'">📁 فولدر الصور/الفيديو</a></div>';
    h+='<div class="sec">التحصيل الشهري'+(adm?' — دوس الشهر عشان تسجّل':'')+'</div><div class="months" id="months">';
    for(var m=1;m<=12;m++){var pd=b.months&&b.months[m]!=null;var cls=pd?'pd':(m<=MONTH?'un':'');h+='<div class="mo '+cls+'" data-m="'+m+'">'+MSH[m-1]+'<br>'+(pd?money(b.months[m]):'—')+'</div>';}
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
  });
}
function closeB(){el('ov').style.display='none';CUR=null;}

function payMonth(m){
  var def=(CUR&&CUR.paid)||'';
  var v=prompt('العمارة '+CUR.num+' — دفعت كام عن '+MON[m-1]+'؟',def);
  if(v==null)return;var amount=Number(String(v).replace(/[^0-9.]/g,''));if(isNaN(amount))return;
  api('pay',{method:'POST',body:{id:CUR.id,month:m,amount:amount}}).then(function(d){if(d.ok)openB(CUR.id);else alert(d.error||'مشكلة');});
}
function addEv(type){
  var label=EVT[type]||'';
  var text=type==='maintenance'?(prompt('تفاصيل الصيانة (أو سيبها فاضية):','')||''):prompt(label+' — اكتب التفاصيل:','');
  if(text==null&&type!=='maintenance')return;
  api('event',{method:'POST',body:{id:CUR.id,type:type,text:text}}).then(function(d){if(d.ok)openB(CUR.id);else alert(d.error||'مشكلة');});
}
function editUnion(){
  var cts=(CUR.contacts&&CUR.contacts.length)?CUR.contacts:((CUR.unionHead||CUR.unionPhone)?[{name:CUR.unionHead||'',phone:CUR.unionPhone||''}]:[]);
  var n1=prompt('اسم رئيس الاتحاد (1):',(cts[0]&&cts[0].name)||'');if(n1==null)return;
  var p1=prompt('تليفونه (1):',(cts[0]&&cts[0].phone)||'');if(p1==null)return;
  var n2=prompt('اسم رئيس اتحاد تاني (2) — سيبها فاضية لو مفيش:',(cts[1]&&cts[1].name)||'');if(n2==null)return;
  var p2=prompt('تليفونه (2):',(cts[1]&&cts[1].phone)||'');if(p2==null)return;
  var arr=[{name:n1,phone:p1}];if(n2||p2)arr.push({name:n2,phone:p2});
  var id=CUR.id;
  api('set',{method:'POST',body:{id:id,field:'contacts',value:arr}}).then(function(d){if(d.ok)openB(id);else alert(d.error||'مشكلة');});
}
function upPhoto(inp){
  var f=inp.files[0];if(!f)return;var id=CUR.id;var rd=new FileReader();
  rd.onload=function(){var b64=String(rd.result).split(',')[1];var cap=prompt('تعليق على الصورة (اختياري):','')||'';
    api('photo',{method:'POST',body:{bid:id,b64:b64,mime:f.type||'image/jpeg',caption:cap}}).then(function(d){if(d.ok)openB(id);else alert(d.error||'مشكلة');});};
  rd.readAsDataURL(f);
}
function addBuilding(){
  var num=prompt('رقم العملية الجديدة (زي 90ج):','');if(!num)return;
  var value=prompt('القيمة الكاملة:','250');if(value==null)return;
  var paid=prompt('المدفوع (الصافي بعد الغفير):','200');if(paid==null)return;
  api('add',{method:'POST',body:{num:num,value:Number(value),paid:Number(paid)}}).then(function(d){if(d.ok)renderHome();else alert(d.error||'مشكلة');});
}

function broadcast(){
  api('broadcast').then(function(d){
    if(!d.count){alert('مفيش تليفونات رؤساء اتحاد مسجّلة لسه. سجّلهم الأول.');return;}
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
  });
}

if(T&&ROLE)renderHome();else renderLogin();
</script>
</body>
</html>`;
