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
 * محتاج 3 secrets (تتحط بـ: npx wrangler secret put <NAME>):
 *   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN
 * شوف تعليمات الحصول عليهم في رسالة الشات.
 */

const CONTACTS_KEY = 'contacts:map';
const PEOPLE_API = 'https://people.googleapis.com/v1/people/me/connections';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

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
  const { GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REFRESH_TOKEN } = env;
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
        const phone = normalizePhoneEG(p.value);
        if (phone && !map[phone]) map[phone] = { name, photo };
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
  return map[waId] || null;
}
