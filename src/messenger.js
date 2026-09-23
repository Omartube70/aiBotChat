/**
 * تكامل Facebook Messenger (لصفحة "توب باور للمصاعد").
 * نفس فكرة واتساب: نستقبل webhook من Meta، ونرد بنفس محرك الردود (Gemini + بحث المنتجات).
 * العملاء بيتسجّلوا في النظام بمعرّف بصيغة `fb:<PSID>` عشان يفرق عن أرقام واتساب
 * في كل حاجة عامة (الذاكرة، وضع التحويل البشري، ربط الرد بالـ quote... إلخ).
 */
import { config } from './config.js';

const GRAPH = 'https://graph.facebook.com/v21.0';

/** إرسال رسالة نصية لعميل ماسنجر عن طريق صفحة الفيسبوك. */
export async function sendMessengerText(psid, body) {
  const token = config.facebook.pageAccessToken;
  if (!token || !psid) return null;
  const res = await fetch(`${GRAPH}/me/messages?access_token=${encodeURIComponent(token)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      recipient: { id: psid },
      message: { text: String(body).slice(0, 2000) },
      messaging_type: 'RESPONSE',
    }),
  });
  if (!res.ok) {
    console.error(`[messenger] فشل الإرسال ${res.status}: ${(await res.text()).slice(0, 300)}`);
    return null;
  }
  const data = await res.json().catch(() => null);
  return data?.message_id || null;
}

/**
 * استخراج الرسائل الواردة من جسم webhook الماسنجر.
 * @returns {Array<{psid: string, id: string, text: string}>}
 */
export function parseMessengerIncoming(reqBody) {
  const out = [];
  if (reqBody?.object !== 'page') return out;
  for (const entry of reqBody.entry || []) {
    for (const event of entry.messaging || []) {
      const psid = event.sender?.id;
      const text = event.message?.text;
      if (!psid || !text || event.message?.is_echo) continue; // نتجاهل صدى رسائلنا احنا
      out.push({ psid, id: event.message?.mid || `${psid}:${event.timestamp}`, text: text.trim() });
    }
  }
  return out;
}
