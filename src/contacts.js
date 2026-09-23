/**
 * مزامنة "الأسماء" من جوجل (Google Contacts / People API) لحساب توب باور
 * (toppower4444@gmail.com) — عشان لما عميل يبعت واتساب، البوت يعرف اسمه
 * المسجّل عند صاحب المحل من غير ما يتاخد من اسم بروفايل واتساب.
 *
 * التخزين: بلوك JSON واحد في KV (contacts:map) — رقم مطبّع → اسم.
 * ده أسرع وأرخص من مفتاح KV منفصل لكل جهة اتصال، وكافي لحجم جهات الاتصال دي.
 *
 * المزامنة بتحصل:
 *  - تلقائيًا كل شوية عبر Cron Trigger (شوف wrangler.toml + scheduled() في worker.js)
 *  - يدويًا لما موظف يكتب على واتساب: "حدث الاسماء"
 *
 * محتاج GOOGLE_CLIENT_ID و GOOGLE_CLIENT_SECRET (secrets)، والـ refresh token يا إما:
 *   - secret اسمه GOOGLE_REFRESH_TOKEN، أو
 *   - صاحب المحل يفتح <الووركر>/google/connect ويوافق بحساب المحل (منقول من البوت القديم)
 *     والتوكن بيتحفظ في KV (google:refresh).
 */
import { config } from './config.js';

const CONTACTS_KEY = 'contacts:map';
const PEOPLE_API = 'https://people.googleapis.com/v1/people/me/connections';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const REFRESH_KEY = 'google:refresh';
const stateKey = (s) => `google:state:${s}`;
const SCOPES = 'https://www.googleapis.com/auth/contacts.readonly openid email';

/** يطبّع رقم مصري لنفس الصيغة اللي واتساب بيبعتها (20XXXXXXXXXX من غير +). */
export function normalizePhoneEG(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/[^\d]/g, '');
  if (!d) return null;
  if (d.startsWith('0020')) d = d.slice(2);
  if (d.startsWith('020') && d.length === 13) d = d.slice(1); // 020XXXXXXXXXX غلط شائع
  if (d.startsWith('0') && !d.startsWith('020')) d = '2' + d; // 01XXXXXXXXX → 201XXXXXXXXX
  if (d.startsWith('1') && d.length === 10) d = '20' + d; // 1XXXXXXXXX → 201XXXXXXXXX
  if (!d.startsWith('20')) return null;
  if (d.length !== 12) return null;
  return d;
}

async function getAccessToken(env) {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = env;
  const GOOGLE_REFRESH_TOKEN = env.GOOGLE_REFRESH_TOKEN || (await env?.MEMORY?.get(REFRESH_KEY));
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET || !GOOGLE_REFRESH_TOKEN) {
    throw new Error('إعدادات جوجل ناقصة (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET / GOOGLE_REFRESH_TOKEN)');
  }
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: GOOGLE_REFRESH_TOKEN,
      grant_type: 'refresh_token',
    }),
  });
  if (!res.ok) throw new Error(`تجديد توكن جوجل فشل: ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.access_token;
}

/** يجيب كل جهات الاتصال (بالصفحات) ويبني map: رقم مطبّع → { name, photo }. */
async function fetchAllContacts(accessToken) {
  const map = {};
  let pageToken = '';
  let pages = 0;
  do {
    const url = new URL(PEOPLE_API);
    url.searchParams.set('personFields', 'names,phoneNumbers,photos');
    url.searchParams.set('pageSize', '1000');
    if (pageToken) url.searchParams.set('pageToken', pageToken);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) throw new Error(`People API فشل: ${res.status} ${await res.text()}`);
    const data = await res.json();
    for (const person of data.connections || []) {
      const name = person.names?.[0]?.displayName?.trim();
      if (!name) continue;
      // صورة حقيقية بس (مش الأفتار الافتراضي اللي جوجل بيعمله لأول حرف من الاسم)
      const photoObj = (person.photos || []).find((p) => p.default !== true && p.url);
      const photo = photoObj ? photoObj.url : null;
      for (const p of person.phoneNumbers || []) {
        for (const raw of [p.canonicalForm, p.value]) {
          const phone = normalizePhoneEG(raw);
          if (phone && !map[phone]) map[phone] = { name, photo };
        }
      }
    }
    pageToken = data.nextPageToken || '';
    pages += 1;
  } while (pageToken && pages < 20); // حد أمان — 20 صفحة × 1000 = 20 ألف جهة اتصال
  return map;
}

/** يعمل المزامنة الكاملة ويخزّن النتيجة في KV. بيرجّع عدد الأسماء. */
export async function syncGoogleContacts(env) {
  const accessToken = await getAccessToken(env);
  const map = await fetchAllContacts(accessToken);
  const kv = env?.MEMORY;
  if (kv) await kv.put(CONTACTS_KEY, JSON.stringify(map));
  return Object.keys(map).length;
}

/** بيانات العميل المسجّل عند صاحب المحل (من جوجل): { name, photo } أو null. */
export async function getContactInfo(waId, env) {
  const kv = env?.MEMORY;
  if (!kv) return null;
  const map = await kv.get(CONTACTS_KEY, 'json');
  if (!map) return null;
  const hit = map[waId];
  // البوت القديم كان بيخزّن الاسم كنص بس
  return typeof hit === 'string' ? { name: hit, photo: null } : hit || null;
}

/* ---------- ربط جوجل من المتصفح (منقول من البوت القديم) ---------- */

function page(title, body) {
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body dir="rtl" style="font-family:sans-serif;padding:24px;font-size:18px"><h2>${title}</h2><p>${body}</p></body>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  );
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
}

function decodeJwt(jwt) {
  try {
    const b64 = String(jwt).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return {};
  }
}

function redirectUri(url) {
  const base = url.pathname.startsWith('/oauth/') ? '/oauth' : '/google';
  return `${url.origin}${base}/callback`;
}

/** GET /google/connect → يحوّل لصفحة موافقة جوجل. */
export async function startConnect(url, env) {
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET } = env;
  if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
    return page(
      'لسه مفاتيح جوجل مش متحطوطة في Cloudflare.',
      `رابط الرجوع (Redirect URI) اللي هتحتاجه:<br><code>${redirectUri(url)}</code>`,
    );
  }
  const state = crypto.randomUUID();
  await env.MEMORY.put(stateKey(state), '1', { expirationTtl: 600 });
  const q = new URLSearchParams({
    client_id: GOOGLE_CLIENT_ID,
    redirect_uri: redirectUri(url),
    response_type: 'code',
    scope: SCOPES,
    access_type: 'offline',
    prompt: 'consent',
    login_hint: config.google.accountEmail,
    state,
  });
  return Response.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${q}`, 302);
}

/** GET /google/callback → يحفظ الـ refresh token في KV ويعمل أول مزامنة. */
export async function finishConnect(url, env) {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state') || '';
  if (!code) return page('الإذن اتلغى أو حصلت مشكلة.', 'جرّب تفتح رابط الربط تاني.');
  if (!(await env.MEMORY.get(stateKey(state)))) {
    return page('الرابط ده قديم.', 'افتح رابط الربط من الأول.');
  }
  await env.MEMORY.delete(stateKey(state));
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: env.GOOGLE_CLIENT_ID,
      client_secret: env.GOOGLE_CLIENT_SECRET,
      redirect_uri: redirectUri(url),
      grant_type: 'authorization_code',
    }),
  });
  const tok = await res.json().catch(() => ({}));
  if (!res.ok || !tok.refresh_token) {
    console.error('[google] token خطأ:', res.status, JSON.stringify(tok));
    const why = [res.status, tok.error, tok.error_description].filter(Boolean).join(' — ');
    return page(
      'جوجل مرجّعش الإذن كامل.',
      `افتح رابط الربط تاني ووافق على كل حاجة.<br><small dir="ltr">${escapeHtml(why)}</small>`,
    );
  }
  const claims = decodeJwt(tok.id_token);
  const email = String(claims.email || '').toLowerCase();
  if (!claims.email_verified || email !== config.google.accountEmail.toLowerCase()) {
    return page(
      'الحساب ده مش حساب المحل.',
      `دخلت بـ ${escapeHtml(email || 'حساب غير معروف')}، لازم تدخل بـ ${config.google.accountEmail}.`,
    );
  }
  await env.MEMORY.put(REFRESH_KEY, tok.refresh_token);
  try {
    const n = await syncGoogleContacts(env);
    return page('تم ربط جهات الاتصال ✅', `البوت عرف ${n} رقم، وهيحدّثهم لوحده كل شوية.`);
  } catch (err) {
    console.error('[google] sync خطأ:', err.message);
    return page('الربط تم ✅ بس أول تحديث فشل.', 'هيحاول تاني لوحده بعد شوية.');
  }
}
