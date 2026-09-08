import { config } from './config.js';

const W = config.whatsapp;

function graphUrl(path) {
  return `https://graph.facebook.com/${W.graphVersion}/${path}`;
}

/** إرسال رسالة نصية للعميل عبر WhatsApp Cloud API. */
export async function sendText(to, body) {
  if (!W.token || !W.phoneNumberId) {
    console.warn('[whatsapp] التوكن أو Phone Number ID ناقص — مش هيتبعت حاجة');
    return;
  }

  const res = await fetch(graphUrl(`${W.phoneNumberId}/messages`), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${W.token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: 'text',
      text: { preview_url: false, body: body.slice(0, 4096) },
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    console.error(`[whatsapp] فشل الإرسال ${res.status}: ${errText.slice(0, 400)}`);
  }
}

/** وضع علامة "تمت القراءة" على رسالة العميل (اختياري، شكل أحسن). */
export async function markRead(messageId) {
  if (!W.token || !W.phoneNumberId || !messageId) return;
  try {
    await fetch(graphUrl(`${W.phoneNumberId}/messages`), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${W.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        status: 'read',
        message_id: messageId,
      }),
    });
  } catch {
    /* مش مشكلة لو فشلت */
  }
}

/**
 * استخراج الرسائل النصية الواردة من جسم الـ webhook.
 * @returns {Array<{from: string, id: string, text: string, name?: string}>}
 */
export function parseIncoming(reqBody) {
  const out = [];
  const entries = reqBody?.entry || [];
  for (const entry of entries) {
    for (const change of entry.changes || []) {
      const value = change.value || {};
      const contacts = value.contacts || [];
      const nameByWaId = {};
      for (const c of contacts) nameByWaId[c.wa_id] = c.profile?.name;

      for (const msg of value.messages || []) {
        let text = '';
        if (msg.type === 'text') text = msg.text?.body || '';
        else if (msg.type === 'interactive') {
          text =
            msg.interactive?.button_reply?.title ||
            msg.interactive?.list_reply?.title ||
            '';
        } else if (msg.type === 'button') {
          text = msg.button?.text || '';
        }

        out.push({
          from: msg.from,
          id: msg.id,
          type: msg.type,
          text: text.trim(),
          name: nameByWaId[msg.from],
        });
      }
    }
  }
  return out;
}
