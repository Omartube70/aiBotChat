import { config } from './config.js';
import { searchProducts } from './catalog.js';

const S = config.store;

const SYSTEM_PROMPT = `أنت موظف خدمة عملاء ودود في متجر "${S.name}" (بيع مهمات وقطع غيار ومستلزمات المصاعد).
مهمتك: الرد على العملاء على واتساب وتزويدهم بأسعار المنتجات وحالة توافرها.

قواعد مهمة:
- اتكلم بالعامية المصرية البسيطة، بأسلوب محترم ومختصر (رسائل واتساب قصيرة).
- في كل رسالة هتلاقي قسم "منتجات من الكتالوج" فيه نتائج بحث فعلية من المتجر. اعتمد عليه فقط.
- لا تخترع أي سعر أو منتج. لو مفيش نتائج مناسبة في القسم ده، قول للعميل إنك مش لاقي المنتج بالاسم ده،
  واطلب منه يوضّح الاسم أكتر أو يبعت صورة، واداله رقم المحل: ${S.phone}.
- الأسعار كلها بالجنيه المصري (${S.currency}).
- لو المنتج ليه أكتر من نوع/سعر، اعرضهم كلهم في نقاط.
- لو المنتج "غير متوفر حالياً"، بلّغ العميل بده بلطف، واقترح البدائل المتوفرة لو فيه.
- صور المنتجات بتتبعت تلقائيًا بعد ردك لو متوفرة — متقولش للعميل يروح لحد تاني عشان الصور، بس ممكن تقوله "بعتلك الصورة".
- لو العميل سأل عن العنوان أو المكان، بتتبعت له نقطة الموقع تلقائيًا — اذكر العنوان بالنص كمان.
- لو العميل سأل عن التليفون أو المواعيد، استخدم بيانات المتجر الموجودة تحت.
- متردش على أي كلام مالوش علاقة بالمتجر أو المصاعد؛ رجّع العميل للموضوع بلطف.
- لو العميل عايز يكلم حد من المحل، اداله رقم الواتساب: ${S.whatsapp}.

بيانات المتجر:
- الاسم: ${S.name}
- العنوان: ${S.address}
- تليفون: ${S.phone} / ${S.extraPhone}
- واتساب: ${S.whatsapp}
- الموقع الإلكتروني: ${S.website}
- المواعيد: ${S.workingHours}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function endpoint() {
  return `${config.gemini.baseUrl}/models/${config.gemini.model}:generateContent?key=${config.gemini.apiKey}`;
}

// retries قليلة ومهلة قصيرة — لأن ده بيتنفّذ في ctx.waitUntil() اللي ليه حد وقت
async function callGemini(contents, { retries = 2 } = {}) {
  const payload = JSON.stringify({
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents,
    generationConfig: { temperature: 0.4, maxOutputTokens: 1200 },
    safetySettings: [
      'HARM_CATEGORY_HARASSMENT',
      'HARM_CATEGORY_HATE_SPEECH',
      'HARM_CATEGORY_SEXUALLY_EXPLICIT',
      'HARM_CATEGORY_DANGEROUS_CONTENT',
    ].map((category) => ({ category, threshold: 'BLOCK_ONLY_HIGH' })),
  });

  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    let res;
    try {
      res = await fetch(endpoint(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
      });
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await sleep(700 * 2 ** attempt);
        continue;
      }
      throw err;
    }

    if (res.ok) return res.json();

    const body = await res.text().catch(() => '');
    lastErr = new Error(`Gemini API ${res.status}: ${body.slice(0, 200)}`);

    // 429 = تخطّي الحصة/المعدل، 500/503 = ازدحام مؤقت → نعيد المحاولة
    if ([429, 500, 503].includes(res.status) && attempt < retries) {
      const base = res.status === 429 ? 1500 : 700;
      await sleep(base * 2 ** attempt); // 429: ~1.5s ثم ~3s
      continue;
    }
    throw lastErr;
  }
  throw lastErr;
}

function lastUserText(history) {
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'user') {
      return history[i].parts?.map((p) => p.text).join(' ') || '';
    }
  }
  return '';
}

/** يجمع نتائج البحث (مع بحث احتياطي بالرسالة السابقة لو الرسالة قصيرة). */
async function gatherProducts(userText, history) {
  let products = await searchProducts(userText, 10);

  if (products.length === 0 || userText.trim().length < 12) {
    const prev = lastUserText(history);
    if (prev && prev !== userText) {
      const more = await searchProducts(`${prev} ${userText}`, 10);
      const seen = new Set(products.map((p) => p.الاسم));
      for (const m of more) if (!seen.has(m.الاسم)) products.push(m);
    }
  }
  return products;
}

/** قسم المنتجات اللي بيتحقن مع رسالة العميل (من غير المفاتيح الداخلية). */
function buildContext(userText, products) {
  const forModel = products.map((p) =>
    Object.fromEntries(
      Object.entries(p).filter(([k]) => k !== 'imageUrl' && !k.startsWith('_')),
    ),
  );
  const block = forModel.length
    ? JSON.stringify(forModel, null, 1)
    : '(مفيش نتائج مطابقة في الكتالوج)';
  return `منتجات من الكتالوج (نتيجة بحث فعلية عن رسالة العميل):\n${block}\n\n---\nرسالة العميل:\n${userText}`;
}

/**
 * @param {string} userText رسالة العميل
 * @param {Array} history سجل المحادثة بصيغة Gemini contents [{role, parts}] (رسائل نضيفة بدون سياق)
 * @returns {Promise<{reply: string, history: Array, products: Array}>}
 */
export async function generateReply(userText, history = []) {
  const products = await gatherProducts(userText, history);
  const augmented = buildContext(userText, products);
  const contents = [...history, { role: 'user', parts: [{ text: augmented }] }];

  let reply;
  try {
    const data = await callGemini(contents);
    const parts = data.candidates?.[0]?.content?.parts || [];
    reply = parts.map((p) => p.text).filter(Boolean).join('\n').trim();
  } catch (err) {
    console.error('[gemini] فشل النداء:', err.message);
    reply = '';
  }

  if (!reply) {
    reply = `معلش، النظام مضغوط شوية دلوقتي. جرّب تبعت تاني بعد دقيقة، أو كلّمنا على واتساب: ${S.whatsapp}`;
  }

  // نحفظ في الذاكرة الرسالة النضيفة فقط (من غير قسم المنتجات) عشان الذاكرة ما تكبرش
  const newHistory = [
    ...history,
    { role: 'user', parts: [{ text: userText }] },
    { role: 'model', parts: [{ text: reply }] },
  ];

  return { reply, history: newHistory, products };
}

/**
 * يستخرج الأصناف والكميات من طلب فاتورة، ويطابقها بأسماء المنتجات المتاحة.
 * @returns {Promise<Array<{name: string, qty: number}>>}
 */
export async function extractOrder(userText, products) {
  const names = products.map((p) => p['الاسم']).filter(Boolean);
  if (!names.length) return [];

  const prompt =
    `طلب العميل:\n"${userText}"\n\n` +
    `منتجات المتجر المتاحة:\n${names.map((n, i) => `${i + 1}. ${n}`).join('\n')}\n\n` +
    `استخرج الأصناف والكميات اللي العميل طلبها. لكل صنف اختر أقرب اسم من القائمة فوق بالحرف الواحد. ` +
    `لو الكمية مش مذكورة اعتبرها 1. تجاهل أي صنف مش موجود في القائمة. ` +
    `رجّع JSON array فقط بالشكل ده: [{"name":"الاسم من القائمة","qty":عدد}]`;

  const url = `${config.gemini.baseUrl}/models/${config.gemini.model}:generateContent?key=${config.gemini.apiKey}`;
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0, responseMimeType: 'application/json' },
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`extractOrder ${res.status}: ${t.slice(0, 150)}`);
  }
  const data = await res.json();
  const txt = (data.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text)
    .filter(Boolean)
    .join('')
    .trim();

  let arr;
  try {
    arr = JSON.parse(txt);
  } catch {
    const m = txt.match(/\[[\s\S]*\]/);
    arr = m ? JSON.parse(m[0]) : [];
  }
  if (!Array.isArray(arr)) return [];

  return arr
    .map((x) => ({
      name: String(x?.name || '').trim(),
      qty: Math.max(1, Math.round(Number(x?.qty) || 1)),
    }))
    .filter((x) => x.name);
}

/** يحوّل ArrayBuffer لسلسلة base64 (على دفعات عشان ما نكسّرش الـ stack). */
function base64FromArrayBuffer(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * تفريغ رسالة صوتية لنص باستخدام Gemini (نفس المفتاح).
 * @param {ArrayBuffer} buffer الملف الصوتي
 * @param {string} mimeType نوعه (audio/ogg مثلاً)
 * @returns {Promise<string>} النص المفرّغ (فاضي لو فشل التعرّف)
 */
export async function transcribeAudio(buffer, mimeType = 'audio/ogg') {
  const model = config.gemini.audioModel || config.gemini.model;
  const url = `${config.gemini.baseUrl}/models/${model}:generateContent?key=${config.gemini.apiKey}`;

  const body = JSON.stringify({
    contents: [
      {
        role: 'user',
        parts: [
          {
            inline_data: {
              mime_type: (mimeType || 'audio/ogg').split(';')[0].trim(),
              data: base64FromArrayBuffer(buffer),
            },
          },
          {
            text: 'فرّغ الرسالة الصوتية دي نصًّا بالعربي حرفيًا. اكتب النص فقط من غير أي مقدمات أو تعليق. لو مفيش كلام واضح رجّع نص فاضي.',
          },
        ],
      },
    ],
    generationConfig: { temperature: 0, maxOutputTokens: 400 },
  });

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Gemini STT ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  return parts
    .map((p) => p.text)
    .filter(Boolean)
    .join(' ')
    .trim();
}
