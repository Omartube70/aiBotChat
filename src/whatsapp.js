import { config } from './config.js';

const W = config.whatsapp;

function graphUrl(path) {
  return `https://graph.facebook.com/${W.graphVersion}/${path}`;
}

/**
 * إرسال رسالة نصية للعميل عبر WhatsApp Cloud API.
 * @returns {Promise<string|null>} معرّف الرسالة المُرسلة (wamid) — مفيد عشان لو حد
 *   عمل "رد" (quote) على الرسالة دي نقدر نربطها برقم العميل الأصلي.
 */
export async function sendText(to, body) {
  if (!W.token || !W.phoneNumberId) {
    console.warn('[whatsapp] التوكن أو Phone Number ID ناقص — مش هيتبعت حاجة');
    return null;
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
    return null;
  }
  try {
    const data = await res.json();
    return data?.messages?.[0]?.id || null;
  } catch {
    return null;
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

/**
 * يبعت "جهة اتصال" (كارت) — الموظف يقدر يحفظها على موبايله بضغطة.
 * @param {{name: string, phone: string, address?: string, note?: string}} c phone بصيغة دولية (2010...)
 */
export async function sendContact(to, { name, phone, address, note }) {
  if (!W.token || !W.phoneNumberId || !phone) return false;
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
      type: 'contacts',
      contacts: [
        {
          name: { formatted_name: name || phone, first_name: name || phone },
          phones: [{ phone: `+${phone}`, type: 'CELL', wa_id: phone }],
          addresses: address ? [{ street: address, type: 'HOME' }] : undefined,
          org: note ? { company: note } : undefined,
        },
      ],
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    console.error(`[whatsapp] فشل إرسال جهة الاتصال ${res.status}: ${t.slice(0, 300)}`);
    return false;
  }
  return true;
}

/**
 * رسالة فيها لحد 3 زراير تحت بعض (العميل بيدوس بدل ما يكتب).
 * @param {Array<{id: string, title: string}>} buttons العنوان لحد 20 حرف
 */
export async function sendButtons(to, body, buttons) {
  if (!W.token || !W.phoneNumberId) return false;
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
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text: body },
        action: {
          buttons: buttons.slice(0, 3).map((b) => ({
            type: 'reply',
            reply: { id: b.id, title: b.title.slice(0, 20) },
          })),
        },
      },
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    console.error(`[whatsapp] فشل إرسال الزراير ${res.status}: ${t.slice(0, 300)}`);
    return false;
  }
  return true;
}

/**
 * يبعت فورم WhatsApp Flow (زرار بيفتح خانات تتملي).
 * @param {{flowId: string, flowToken: string, screen: string, body: string, cta: string, header?: string}} f
 */
export async function sendFlow(to, { flowId, flowToken, screen, body, cta, header }) {
  if (!W.token || !W.phoneNumberId || !flowId) return false;
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
      type: 'interactive',
      interactive: {
        type: 'flow',
        header: header ? { type: 'text', text: header } : undefined,
        body: { text: body },
        action: {
          name: 'flow',
          parameters: {
            flow_message_version: '3',
            flow_token: flowToken,
            flow_id: flowId,
            flow_cta: cta,
            flow_action: 'navigate',
            flow_action_payload: { screen },
          },
        },
      },
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    console.error(`[whatsapp] فشل إرسال الفورم ${res.status}: ${t.slice(0, 300)}`);
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
        let image = null;
        let flow = null;
        let document = null;
        if (msg.type === 'text') text = msg.text?.body || '';
        else if (msg.type === 'document' && msg.document?.id) {
          // ملف (زي جرد إنياد Excel اللي المدير بيبعته)
          document = {
            id: msg.document.id,
            filename: msg.document.filename || '',
            mimeType: (msg.document.mime_type || '').split(';')[0].trim(),
          };
          text = (msg.document.caption || '').trim();
        }
        else if (msg.type === 'interactive' && msg.interactive?.type === 'nfm_reply') {
          // رد فورم WhatsApp Flow (العميل/الموظف ملا الخانات وداس إرسال)
          try {
            flow = JSON.parse(msg.interactive.nfm_reply?.response_json || '{}');
          } catch {
            flow = {};
          }
        } else if (msg.type === 'interactive') {
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
        } else if (msg.type === 'image' && msg.image?.id) {
          image = {
            id: msg.image.id,
            mimeType: (msg.image.mime_type || 'image/jpeg').split(';')[0].trim(),
          };
          text = (msg.image.caption || '').trim(); // لو العميل كتب كلام مع الصورة
        }

        out.push({
          from: msg.from,
          id: msg.id,
          type: msg.type,
          text: text.trim(),
          audio,
          image,
          flow,
          document,
          name: nameByWaId[msg.from],
          // لو الموظف عمل "رد" (quote) على رسالة قديمة، ده الـ wamid بتاعها
          contextId: msg.context?.id || null,
        });
      }
    }
  }
  return out;
}
