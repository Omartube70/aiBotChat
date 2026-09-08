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
- لو العميل سأل عن العنوان أو التليفون أو المواعيد، استخدم بيانات المتجر الموجودة تحت.
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

async function callGemini(contents, { retries = 4 } = {}) {
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
      // 429 غالباً بيحتاج انتظار أطول (حد المعدل بيتصفّر كل دقيقة)
      const base = res.status === 429 ? 4000 : 900;
      await sleep(base * 2 ** attempt);
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

/** يبني قسم المنتجات اللي بيتحقن مع رسالة العميل. */
async function buildContext(userText, history) {
  let products = await searchProducts(userText, 10);

  // لو الرسالة قصيرة (رد متابعة زي "والأزرق؟") نبحث كمان بالرسالة السابقة
  if (products.length === 0 || userText.trim().length < 12) {
    const prev = lastUserText(history);
    if (prev && prev !== userText) {
      const more = await searchProducts(`${prev} ${userText}`, 10);
      const seen = new Set(products.map((p) => p.الاسم));
      for (const m of more) if (!seen.has(m.الاسم)) products.push(m);
    }
  }

  const block = products.length
    ? JSON.stringify(products, null, 1)
    : '(مفيش نتائج مطابقة في الكتالوج)';

  return `منتجات من الكتالوج (نتيجة بحث فعلية عن رسالة العميل):\n${block}\n\n---\nرسالة العميل:\n${userText}`;
}

/**
 * @param {string} userText رسالة العميل
 * @param {Array} history سجل المحادثة بصيغة Gemini contents [{role, parts}] (رسائل نضيفة بدون سياق)
 * @returns {Promise<{reply: string, history: Array}>}
 */
export async function generateReply(userText, history = []) {
  const augmented = await buildContext(userText, history);
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

  return { reply, history: newHistory };
}
