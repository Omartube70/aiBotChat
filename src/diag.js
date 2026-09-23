/**
 * سجل تشخيص بسيط (منقول من البوت القديم): آخر 30 حدث في KV (diag:log)
 * — رسايل وصلت 📩 ومشاكل إرسال ❌ — بيتعرض على /debug/log عشان صاحب المحل
 * يعرف من الموبايل لو واتساب مش بيوصّل رسايل ومن غير ما يفتح Cloudflare.
 */

const KEY = 'diag:log';
const MAX = 30;
let pending = [];
let lastInWrite = 0;

// أكواد أخطاء واتساب الشائعة → شرح بالعربي
const HINTS = {
  131030: 'الرقم ده مش متضاف في قائمة الأرقام المسموح بيها (رقم التجربة بيرد على أرقام محددة بس).',
  131047: 'فات أكتر من 24 ساعة من آخر رسالة من العميل.',
  131026: 'الرقم مش عليه واتساب أو مش قادر يستقبل.',
  190: 'مفتاح واتساب (التوكن) انتهى أو اتغيّر.',
  10: 'مفتاح واتساب مالوش صلاحية على الرقم ده.',
  131056: 'رسايل كتير لنفس الرقم في وقت قصير.',
  368: 'الحساب متوقف مؤقتاً من ميتا.',
};

export function maskPhone(p) {
  const s = String(p || '');
  return s.length > 8 ? `${s.slice(0, 4)}****${s.slice(-4)}` : s;
}

export function noteError(msg) {
  const s = String(msg);
  const code = s.match(/"code"\s*:\s*(\d+)/)?.[1] || s.match(/\bcode (\d+)/)?.[1];
  const hint = code && HINTS[code] ? ` ⇐ ${HINTS[code]}` : '';
  pending.push(`${new Date().toISOString()} ❌ ${s.slice(0, 400)}${hint}`);
  if (pending.length > MAX) pending.shift();
}

/** console.error + يتسجّل في سجل التشخيص. */
export function logErr(msg) {
  console.error(msg);
  noteError(msg);
}

/** رسايل واتساب معرفش يوصّلها (statuses: failed) بتيجي في نفس الـ webhook. */
export function noteFailedStatuses(body) {
  for (const entry of body?.entry || []) {
    for (const change of entry.changes || []) {
      for (const st of change.value?.statuses || []) {
        if (st.status !== 'failed') continue;
        for (const e of st.errors || [{}]) {
          noteError(
            `واتساب موصّلش رسالة لـ ${maskPhone(st.recipient_id)}: code ${e.code} ${e.title || ''} ${e.error_data?.details || ''}`,
          );
        }
      }
    }
  }
}

/** بيكتب المتجمّع في KV (رسالة واردة بتتسجل مرة كل دقيقة بالكتير عشان ما نكترش كتابة). */
export async function flushDiag(env, incoming = '') {
  const kv = env?.MEMORY;
  if (!kv) return;
  const lines = pending;
  pending = [];
  const now = Date.now();
  if (incoming && (lines.length || now - lastInWrite > 60000)) {
    lines.unshift(`${new Date().toISOString()} 📩 ${incoming}`);
    lastInWrite = now;
  }
  if (!lines.length) return;
  try {
    const old = (await kv.get(KEY, 'json')) || [];
    await kv.put(KEY, JSON.stringify([...lines.reverse(), ...old].slice(0, MAX)));
  } catch (err) {
    console.error('[diag] خطأ:', err.message);
  }
}

export async function diagPage(env) {
  const log = (await env.MEMORY.get(KEY, 'json').catch(() => null)) || [];
  const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  const items = log.length
    ? log.map((l) => `<li>${esc(l)}</li>`).join('')
    : '<li>لسه مفيش حاجة متسجلة — ابعت رسالة للبوت وافتح الصفحة تاني.</li>';
  return new Response(
    `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body dir="rtl" style="font-family:sans-serif;padding:16px;font-size:16px;line-height:1.7"><h2>سجل البوت (الأحدث فوق)</h2><p>📩 = رسالة وصلت للبوت، ❌ = مشكلة في الإرسال</p><ul>${items}</ul></body>`,
    { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } },
  );
}
