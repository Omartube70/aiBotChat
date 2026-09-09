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

/** إرسال ملف (مستند) بـ media id مرفوع. */
export async function sendDocument(to, mediaId, filename, caption) {
  if (!W.token || !W.phoneNumberId || !mediaId) return false;
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
      type: 'document',
      document: {
        id: mediaId,
        filename: filename || 'file',
        caption: caption ? String(caption).slice(0, 1024) : undefined,
      },
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    console.error(`[whatsapp] فشل إرسال الملف ${res.status}: ${t.slice(0, 300)}`);
    return false;
  }
  return true;
}

/** إرسال صورة عبر رابط مباشر (واتساب بيجيبها بنفسه). */
export async function sendImage(to, link, caption) {
  if (!W.token || !W.phoneNumberId || !link) return false;
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
      type: 'image',
      image: { link, caption: caption ? String(caption).slice(0, 1024) : undefined },
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    console.error(`[whatsapp] فشل إرسال الصورة ${res.status}: ${t.slice(0, 300)}`);
    return false;
  }
  return true;
}

/** إرسال نقطة موقع (pin على الخريطة). */
export async function sendLocation(to, { lat, lng, name, address }) {
  if (!W.token || !W.phoneNumberId || lat == null || lng == null) return false;
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
      type: 'location',
      location: {
        latitude: Number(lat),
        longitude: Number(lng),
        name: name || undefined,
        address: address || undefined,
      },
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    console.error(`[whatsapp] فشل إرسال الموقع ${res.status}: ${t.slice(0, 300)}`);
    return false;
  }
  return true;
}

/** رفع ملف صوتي لواتساب والحصول على media id. */
export async function uploadMedia(buffer, mimeType = 'audio/ogg', filename = 'reply.ogg') {
  if (!W.token || !W.phoneNumberId) return null;
  const fd = new FormData();
  fd.append('messaging_product', 'whatsapp');
  fd.append('type', mimeType);
  fd.append('file', new Blob([buffer], { type: mimeType }), filename);

  const res = await fetch(graphUrl(`${W.phoneNumberId}/media`), {
    method: 'POST',
    headers: { Authorization: `Bearer ${W.token}` }, // من غير Content-Type — fetch بيحط الـ boundary
    body: fd,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    console.error(`[whatsapp] فشل رفع الوسائط ${res.status}: ${t.slice(0, 300)}`);
    return null;
  }
  const j = await res.json().catch(() => ({}));
  return j.id || null;
}

/** إرسال رسالة صوتية بـ media id مرفوع. */
export async function sendAudio(to, mediaId) {
  if (!W.token || !W.phoneNumberId || !mediaId) return false;
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
      type: 'audio',
      audio: { id: mediaId },
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    console.error(`[whatsapp] فشل إرسال الصوت ${res.status}: ${t.slice(0, 300)}`);
    return false;
  }
  return true;
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
 * تنزيل ملف وسائط (رسالة صوتية مثلاً) من واتساب.
 * خطوتين: نجيب رابط تنزيل مؤقت، وبعدين ننزّل الملف نفسه بنفس التوكن.
 * @returns {Promise<{buffer: ArrayBuffer, mimeType: string, size: number} | null>}
 */
export async function fetchMedia(mediaId) {
  if (!W.token || !mediaId) return null;

  const metaRes = await fetch(graphUrl(mediaId), {
    headers: { Authorization: `Bearer ${W.token}` },
  });
  if (!metaRes.ok) {
    console.error(`[whatsapp] فشل جلب بيانات الوسائط ${metaRes.status}`);
    return null;
  }
  const meta = await metaRes.json();
  if (!meta.url) return null;

  const fileRes = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${W.token}` },
  });
  if (!fileRes.ok) {
    console.error(`[whatsapp] فشل تنزيل الوسائط ${fileRes.status}`);
    return null;
  }
  const buffer = await fileRes.arrayBuffer();
  const mimeType = String(
    meta.mime_type || fileRes.headers.get('content-type') || 'audio/ogg',
  )
    .split(';')[0]
    .trim();
  return { buffer, mimeType, size: buffer.byteLength };
}

/**
 * استخراج الرسائل الواردة من جسم الـ webhook.
 * @returns {Array<{from: string, id: string, type: string, text: string, audio: ({id: string, mimeType: string}|null), name?: string}>}
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
        let audio = null;
        if (msg.type === 'text') text = msg.text?.body || '';
        else if (msg.type === 'interactive') {
          text =
            msg.interactive?.button_reply?.title ||
            msg.interactive?.list_reply?.title ||
            '';
        } else if (msg.type === 'button') {
          text = msg.button?.text || '';
        } else if (msg.type === 'audio' && msg.audio?.id) {
          audio = {
            id: msg.audio.id,
            mimeType: (msg.audio.mime_type || 'audio/ogg').split(';')[0].trim(),
          };
        }

        out.push({
          from: msg.from,
          id: msg.id,
          type: msg.type,
          text: text.trim(),
          audio,
          name: nameByWaId[msg.from],
        });
      }
    }
  }
  return out;
}
