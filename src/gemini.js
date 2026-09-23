import { config } from './config.js';
import { searchProducts } from './catalog.js';

const S = config.store;

const SYSTEM_PROMPT = `أنت موظف خدمة عملاء ودود في متجر "${S.name}" (بيع مهمات وقطع غيار ومستلزمات المصاعد).
مهمتك: الرد على العملاء على واتساب وتزويدهم بأسعار المنتجات وحالة توافرها.

قواعد مهمة:
- اتكلم بالعامية المصرية البسيطة، بأسلوب محترم ومختصر (رسائل واتساب قصيرة).
- الترحيب: لو فيه "اسم العميل" في الرسالة، رحّب بيه في أول رد بـ "أهلاً يا <اسم العميل زي ما هو مكتوب>" (زي "أهلاً يا أستاذ كريم" أو "أهلاً يا حاج سيد")، ولو مفيش اسم قول "أهلاً بحضرتك".
  **ممنوع تخترع اسم للعميل أو تقول "يا حاج" أو أي اسم مش مكتوب قدامك.** ومتكررش الترحيب في كل رسالة.
- في كل رسالة هتلاقي قسم "منتجات من الكتالوج" فيه نتائج بحث فعلية من المتجر. اعتمد عليه فقط.
- لا تخترع أي سعر أو منتج. لو مفيش نتائج مناسبة في القسم ده، قول للعميل إنك مش لاقي المنتج بالاسم ده،
  واطلب منه يوضّح الاسم أكتر أو يبعت صورة، واداله رقم المحل: ${S.phone}.
- لو المنتجات عليها "تقريبي": true، يبقى العميل غالبًا كتب الاسم غلط أو الفويس اتسمع غلط (زي "صالون" بدل "كالون"):
  متقولش إنك مش لاقي المنتج — قوله بلطف "حضرتك تقصد [اسم المنتج]؟" واعرض الأسعار عادي.
- الأسعار كلها بالجنيه المصري (${S.currency}).
- لو المنتج ليه أكتر من نوع/سعر، اعرضهم كلهم في نقاط.
- ممنوع تقول للعميل إن أي منتج "غير متوفر" أو "خلص" أو "مش موجود في المخزون" — إدّيه السعر والتفاصيل عادي زي أي منتج تاني، من غير ما تتكلم عن حالة التوفر خالص.
- صور المنتجات بتتبعت تلقائيًا بعد ردك لو متوفرة — متقولش للعميل يروح لحد تاني عشان الصور، بس ممكن تقوله "بعتلك الصورة".
- لو العميل سأل عن العنوان أو المكان، بتتبعت له نقطة الموقع تلقائيًا — اذكر العنوان بالنص كمان.
- لو العميل سأل عن التليفون أو المواعيد، استخدم بيانات المتجر الموجودة تحت.
- متردش على أي كلام مالوش علاقة بالمتجر أو المصاعد؛ رجّع العميل للموضوع بلطف.
- لو العميل عايز يكلم حد من المحل، اداله رقم الواتساب: ${S.whatsapp}.
- المتجر ده للبيع بس (قطع غيار ومهمات). تركيب وصيانة المصاعد الكاملة بتعملها شركتنا "توب باور للمصاعد".
  لو العميل عايز مصعد كامل أو تركيب مصعد أو عرض سعر تركيب (بأي صيغة، حتى لو كتب غلط إملائي):
  متدّيهوش أسعار قطع، ومتطلبش منه يكتب جملة معيّنة — رد بسطر واحد بس فيه العلامة دي بالظبط: [[INSTALL_QUOTE]]
  (العلامة دي داخلية، والنظام هو اللي هيسأله على بيانات العرض).
- لو مش واضح من كلام العميل هو عايز إيه بالظبط (تركيب مصعد ولا قطع غيار ولا صيانة) —
  زي "عايز استفسار"، "محتاج حاجة للأسانسير"، "عندي مشكلة في المصعد" من غير تفاصيل —
  متخمّنش: رد بسطر ترحيب قصير وبعده سطر لوحده فيه العلامة دي بالظبط: [[ASK_SERVICE]]
  (النظام هيبعتله 3 زراير يختار منهم). متستخدمهاش لو طلبه واضح أو بيسأل عن منتج باسمه.
- توب باور بتركّب مصاعد كاملة في أي مكان، وأي مصعد بتركّبه بتعمله صيانة بعد التركيب عادي في أي مكان.
  حد المنطقة (الهضبة وحدائق الأهرام بس) ده لعميل الصيانة بس — اللي مصعده متركّب وشغال وعايز شركة صيانة.
  **عميل التركيب متذكرلوش حدود منطقة الصيانة خالص** — لو سأل عن الصيانة قوله أكيد توب باور بتعمله صيانة بعد التركيب. لو عميل برّه المنطقة دي، متسيبوش: عرّفه إننا بنبيع كل قطع الغيار الأصلية بالضمان وبأسعار تجارية.
- لو حسّيت إن العميل مش متجاوب أو مش مهتم يشتري قطع غيار (زي "لا شكرًا"، "مش محتاج"، "خلاص"، أو ردود باردة)،
  ابعتله لينك المحل: ${S.website} وقوله بأسلوب لطيف "مش هتخسر حاجة، خش اتفرج على الأسعار"،
  وانصحه يبعت اللينك لأصحابه اللي عندهم مصاعد لو عايز مصلحتهم. اعمل ده مرة واحدة بس في المحادثة.
- ولو سأل عن أي حاجة، رد عليه عادي.

وضع "تاجر/مورّد" (مهم):
- افهم من سياق الكلام لو اللي بيكلمك مش عميل عادي، لكن **تاجر أو مورّد بيعرض بضاعة يبيعها للمحل** (زي "عندي كمية طرمبات للبيع"، "بنورّد قطع غيار"، "عايز أعرض عليكم بضاعة"، إلخ) — مش لازم كلمة معيّنة، افهمها من المعنى.
- في الحالة دي بلاش تتصرف كموظف مبيعات عادي. اتكلم معاه كمشتري (المحل بيشتري منه، مش بيبيعله):
  - **ممنوع تمامًا** تذكر أو تلمّح لأي سعر من قسم "منتجات من الكتالوج" — دي أسعار بيع المحل للعملاء، مالهاش دعوة بالتفاصيل مع مورّد، وكشفها له غلط تجاريًا. القسم ده اتجاهله خالص وإنت بتتكلم مع تاجر.
  - اسأله عن تفاصيل العرض بالترتيب: اسم/نوع البضاعة، الكمية المتاحة، الحالة (جديد/مستعمل)، بلد المنشأ أو الضمان لو موجود.
  - **اسأله هو بكام** ("وحضرتك عايز تبيعها بكام؟") — **ممنوع نهائيًا تقول أو تقترح أو تخمّن أي رقم سعر من عندك بأي شكل** لأي حد (سواء من الكتالوج، أو من "تكلفتنا_سرية_للمفاوضة_فقط"، أو من معلوماتك العامة عن أسعار السوق). السعر الوحيد اللي تتكلم عنه بالرقم هو اللي **التاجر بيقوله بنفسه**.
  - لو المنتج اللي بيعرضه موجود في قسم الكتالوج ومعاه حقل "تكلفتنا_سرية_للمفاوضة_فقط"، ده **سعر شرائنا الفعلي الحالي — سرّي تمامًا**، قارن بيه عرضه (من غير ما تقول الرقم له أبدًا):
    - **لو سعره أقل من أو يساوي تكلفتنا** (عرض كويس) → **متفاصلش خالص**، وافق على طول واعتبر التفاصيل كفاية.
    - **لو سعره أعلى من تكلفتنا** (أو مفيش بيانات تكلفة للمنتج ده) → فاصله مرة واحدة بس (زي الخطوات تحت).
- خطوات المحادثة مع التاجر (اتبعها بالترتيب وبالظبط، وممنوع تلف أكتر من كده):
  1. **أول رد:** اسأله عن تفاصيل العرض (النوع، الكمية، الحالة) وبكام — من غير أي رقم سعر منك، ومن غير علامة تحويل.
  2. **لما يردّ ويقول تفاصيل + سعر:**
     - لو السعر **كويس** (أقل من أو يساوي تكلفتنا): رد بحاجة زي "تمام، عرض حلو. هوصّلك بالإدارة يتواصلوا معاك ويقفلوا التفاصيل" واختم بالعلامة تحت **في نفس الرد ده على طول**.
     - لو السعر **أعلى من تكلفتنا** (أو معندكش بيانات تكلفة): فاصله **مرة واحدة بس** في نفس الرد (من غير رقم بديل، زي "السعر عالي شوية، تقدر تنزله؟") — من غير علامة تحويل لسه.
  3. **أي رد من التاجر بعد الفصال** (سواء وافق ينزّل، رفض، كرر نفس السعر، أو قال أي حاجة) — **لازم تحوّل فورًا**: رد قصير بيشكره ويقوله الإدارة هتتواصل معاه، واختم بسطر لوحده فيه العلامة دي بالظبط وبس: [[HANDOFF_SUPPLIER]]
- ممنوع تفاصل أكتر من مرة واحدة، وممنوع تسيب المحادثة من غير ما توصل لقرار (موافقة أو تحويل بعد فصال) لو التاجر رد تاني.
  (العلامة دي بتتشال قبل ما الرسالة توصل للتاجر — هي إشارة داخلية بس، ومتفسّرهاش أو تتكلم عنها).
- استخدم العلامة دي بس في وضع التاجر/المورّد، وأبدًا مع عملاء الشراء العاديين.

بيانات المتجر:
- الاسم: ${S.name}
- العنوان: ${S.address}
- تليفون: ${S.phone} / ${S.extraPhone}
- واتساب: ${S.whatsapp}
- الموقع الإلكتروني: ${S.website}
- المواعيد: ${S.workingHours}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// flash-lite بيفكّر قبل ما يرد لو محددناش — "minimal" بيخلّي الرد أسرع 3-4 مرات.
// الموديلات التانية (flash العادي) بترفض minimal، فبنحطه للـ lite بس.
const fast = () => (/lite/.test(config.gemini.model) ? { thinkingConfig: { thinkingLevel: 'minimal' } } : {});

function endpointFor(model) {
  return `${config.gemini.baseUrl}/models/${model}:generateContent?key=${config.gemini.apiKey}`;
}

const thinkingFor = (model) => (/lite/.test(model) ? { thinkingConfig: { thinkingLevel: 'minimal' } } : {});

/**
 * سباق (منقول من البوت القديم): بنبعت المحاولة الأولى، ولو ما ردّتش خلال hedgeMs
 * بنبعت اللي بعدها بالتوازي (أو فورًا لو الأولى فشلت) — وأول رد ناجح بيكسب والباقي بيتلغى.
 * كده الرد ما بيستناش موديل مزحوم.
 */
function raceGemini(attempts, { hedgeMs = 5000, timeoutMs = 12000 } = {}) {
  return new Promise((resolve, reject) => {
    let next = 0;
    let running = 0;
    let done = false;
    let lastErr = new Error('Gemini: مفيش محاولات');
    let hedgeTimer;
    const controllers = [];

    const finish = (fn, v) => {
      if (done) return;
      done = true;
      clearTimeout(hedgeTimer);
      for (const c of controllers) c.abort();
      fn(v);
    };

    const launch = () => {
      if (done) return;
      clearTimeout(hedgeTimer);
      if (next >= attempts.length) {
        if (running === 0) finish(reject, lastErr);
        return;
      }
      const { model, body } = attempts[next++];
      const ctrl = new AbortController();
      controllers.push(ctrl);
      // الووركر بيتقفل بعد ~30 ثانية — محاولة معلّقة ما تاكلش الوقت كله
      const timeout = setTimeout(() => ctrl.abort(), timeoutMs);
      running++;
      hedgeTimer = setTimeout(launch, hedgeMs);
      fetch(endpointFor(model), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: ctrl.signal,
      })
        .then(async (res) => {
          if (!res.ok) {
            const t = await res.text().catch(() => '');
            throw new Error(`Gemini API ${model} ${res.status}: ${t.slice(0, 200)}`);
          }
          return res.json();
        })
        .then((data) => finish(resolve, data))
        .catch((err) => {
          if (done) return;
          lastErr = err.name === 'AbortError' ? new Error(`Gemini ${model}: مهلة ${timeoutMs}ms`) : err;
          console.warn('[gemini]', lastErr.message);
        })
        .finally(() => {
          clearTimeout(timeout);
          running--;
          if (!done) launch();
        });
    };
    launch();
  });
}

/**
 * @param {{retries?: number, model?: string, gen?: object}} opts
 *   model = موديل واحد بعينه (للتجربة من /debug/gemini)، وإلا الموديل الأساسي مرتين + الاحتياطيين
 */
async function callGemini(contents, { retries = 2, model = null, gen = {} } = {}) {
  const bodyFor = (m) =>
    JSON.stringify({
      systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
      contents,
      generationConfig: { temperature: 0.4, maxOutputTokens: 1200, ...thinkingFor(m), ...gen },
      safetySettings: [
        'HARM_CATEGORY_HARASSMENT',
        'HARM_CATEGORY_HATE_SPEECH',
        'HARM_CATEGORY_SEXUALLY_EXPLICIT',
        'HARM_CATEGORY_DANGEROUS_CONTENT',
      ].map((category) => ({ category, threshold: 'BLOCK_ONLY_HIGH' })),
    });
  const models = model
    ? Array.from({ length: retries + 1 }, () => model)
    : [config.gemini.model, config.gemini.model, ...config.gemini.fallbackModels];
  return raceGemini(models.map((m) => ({ model: m, body: bodyFor(m) })));
}

/** للتجربة (/debug/gemini): وقت الرد والموديل الفعلي لموديل معيّن. */
export async function debugGemini(text, model, gen = {}) {
  const t0 = Date.now();
  try {
    const data = await callGemini([{ role: 'user', parts: [{ text }] }], { retries: 0, model, gen });
    const parts = data.candidates?.[0]?.content?.parts || [];
    return {
      model,
      gen,
      ms: Date.now() - t0,
      modelVersion: data.modelVersion,
      usage: data.usageMetadata,
      text: parts.map((p) => p.text).filter(Boolean).join(' ').slice(0, 120),
    };
  } catch (err) {
    return { model, gen, ms: Date.now() - t0, error: err.message.slice(0, 300) };
  }
}

/** للتجربة (/debug/models): الموديلات المتاحة للمفتاح ده. */
export async function listModels() {
  const res = await fetch(`${config.gemini.baseUrl}/models?pageSize=200&key=${config.gemini.apiKey}`);
  const j = await res.json().catch(() => ({}));
  return (j.models || [])
    .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map((m) => m.name.replace('models/', ''));
}

/**
 * بحث على النت (Google Search grounding) عن شركات تركيب المصاعد ومسودة رسالة تعريفية.
 * بيرجّع نص جاهز للموظف يراجعه — مفيش أي إرسال للشركات من هنا.
 */
export async function findElevatorCompanies(area = 'مصر') {
  const prompt = `دوّر على الإنترنت عن شركات تركيب وصيانة المصاعد في ${area}.
اعرضلي لحد 10 شركات حقيقية، لكل شركة: الاسم، المدينة، رقم التليفون/واتساب لو منشور، الموقع أو صفحة الفيسبوك.
ابدأ بدليل yellowpages.com.eg (تصنيف القاهرة - مصاعد) وبعدين أي مصدر تاني (مواقع الشركات، فيسبوك، أدلة تانية).
اكتب بس البيانات اللي لقيتها فعلًا في نتايج البحث، ومتألفش أرقام أو أسماء.
بعد القايمة اكتب مسودة رسالة تعريفية قصيرة بالمصري تتبعت لأي شركة منهم، بتعرّفهم بـ"${S.name}" (بنبيع قطع غيار ومهمات المصاعد)،
وإن الأسعار تجارية (جملة) للشركات، وبتدعوهم يتعاملوا معانا. حط فيها رقمنا ${S.phone} وواتساب ${S.whatsapp}.
الرد كله نص عادي بدون markdown.`;

  return groundedSearch(prompt);
}

/** نفس الفكرة لشركات المقاولات — بنعرّفهم بتوب باور (تركيب مصاعد) وبنقولهم يبعتوا واتساب ياخدوا عرض في ثواني. */
export async function findContractors(area = 'مصر') {
  const prompt = `دوّر على الإنترنت عن شركات مقاولات وتطوير عقاري وإنشاءات في ${area}.
اعرضلي لحد 10 شركات حقيقية، لكل شركة: الاسم، المدينة، رقم التليفون/واتساب لو منشور، الموقع أو صفحة الفيسبوك.
ابدأ بدليل yellowpages.com.eg (تصنيف القاهرة الكبرى - مقاولات) وبعدين أي مصدر تاني.
اكتب بس البيانات اللي لقيتها فعلًا في نتايج البحث، ومتألفش أرقام أو أسماء.
بعد القايمة اكتب مسودة رسالة تعريفية قصيرة بالمصري تتبعت لأي شركة منهم، بتعرّفهم بشركة "توب باور" لتركيب وصيانة المصاعد،
وتقولهم: لو عندكم مشروع وعايزين تركّبوا مصعد ابعتوا لنا على واتساب ${S.whatsapp} وهيجيلكم عرض سعر في ثواني.
الرد كله نص عادي بدون markdown.`;
  return groundedSearch(prompt);
}

async function groundedSearch(prompt) {
  const url = `${config.gemini.baseUrl}/models/gemini-flash-latest:generateContent?key=${config.gemini.apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(28000),
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      tools: [{ google_search: {} }],
      generationConfig: { temperature: 0.3, maxOutputTokens: 2500 },
    }),
  });
  if (!res.ok) throw new Error(`Gemini search ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.map((p) => p.text).join('').trim() || '';
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
function buildContext(userText, products, customerName) {
  const forModel = products.map((p) =>
    Object.fromEntries(
      Object.entries(p).filter(([k]) => k !== 'imageUrl' && !k.startsWith('_')),
    ),
  );
  const block = forModel.length
    ? JSON.stringify(forModel, null, 1)
    : '(مفيش نتائج مطابقة في الكتالوج)';
  const nameLine = customerName ? `اسم العميل: ${customerName}\n` : '';
  return `منتجات من الكتالوج (نتيجة بحث فعلية عن رسالة العميل):\n${block}\n\n---\n${nameLine}رسالة العميل:\n${userText}`;
}

/**
 * @param {string} userText رسالة العميل
 * @param {Array} history سجل المحادثة بصيغة Gemini contents [{role, parts}] (رسائل نضيفة بدون سياق)
 * @param {{customerName?: string}} [opts] اسم العميل (من جوجل أو بروفايل واتساب) للترحيب
 * @returns {Promise<{reply: string, history: Array, products: Array}>}
 */
export async function generateReply(userText, history = [], { customerName } = {}) {
  const products = await gatherProducts(userText, history);
  const augmented = buildContext(userText, products, customerName);
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
    generationConfig: { temperature: 0, responseMimeType: 'application/json', ...fast() },
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

/**
 * يستخرج بيانات عرض تركيب مصعد من رسالة موظف (كلام حر).
 * @returns {Promise<object>} مفاتيح زي client, type, floors, load, price ... (اللي مش مذكور ما بيرجعش)
 */
export async function extractOfferFields(text) {
  const prompt =
    `رسالة (من موظف أو عميل) لشركة مصاعد فيها بيانات عرض سعر تركيب مصعد:\n"${text}"\n\n` +
    `استخرج البيانات المذكورة بس، ورجّع JSON object بالمفاتيح دي (اللي مش مذكور ما تحطوش خالص):\n` +
    `client: اسم العميل (من غير ألقاب زي الأستاذ/السيد)\n` +
    `phone: رقم تليفون للتواصل لو اتكتب (زي ما اتكتب)\n` +
    `address: عنوان العقار\n` +
    `type: نوع المصعد (مثلاً: ركاب، بضائع، هيدروليك)\n` +
    `machine: بلد منشأ الماكينة (إيطالي أو تركي أو غيره)\n` +
    `brand: اسم الماكينة (الماركة) زي سيكور أو جيم أو أكيش أو أليكو؛ لو اتذكر أكتر من اسم افصلهم بـ " أو "\n` +
    `hp: قدرة الماكينة بالحصان (رقم، زي 5.5 أو 7.5)\n` +
    `doors: الأبواب "محلي" أو "مستورد"\n` +
    `count: عدد المصاعد (رقم)\n` +
    `floors: عدد الأدوار غير الأرضي (رقم)\n` +
    `travel: المشوار بالمتر (رقم)\n` +
    `stops: عدد الوقفات (رقم)\n` +
    `speed: السرعة م/ث (زي "نصف" أو "1")\n` +
    `load: الحمولة بالكيلو (رقم)\n` +
    `persons: عدد الأفراد (رقم)\n` +
    `entrances: عدد المداخل (رقم)\n` +
    `price: سعر المصعد الواحد بالجنيه (رقم بدون فواصل؛ "495 ألف" = 495000)\n` +
    `pay1, pay2, pay3, pay4: نسب الدفعات % بالترتيب (تعاقد، ماكينة وكابينة، كنترول، تشغيل واستلام)\n` +
    `الأرقام تكون بالأرقام الإنجليزي.`;

  const url = `${config.gemini.baseUrl}/models/${config.gemini.model}:generateContent?key=${config.gemini.apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // حد أقصى 15 ثانية — الووركر بيتقفل بعد ~30 ثانية، فلازم نلحق نبلّغ الموظف بالخطأ
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', ...fast() },
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`extractOfferFields ${res.status}: ${t.slice(0, 150)}`);
  }
  const data = await res.json();
  const txt = (data.candidates?.[0]?.content?.parts || [])
    .map((p) => p.text)
    .filter(Boolean)
    .join('')
    .trim();
  let obj;
  try {
    obj = JSON.parse(txt);
  } catch {
    const m = txt.match(/\{[\s\S]*\}/);
    obj = m ? JSON.parse(m[0]) : {};
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  // الأبواب ما تتكتبش إلا لو الموظف قال "محلي" أو "مستورد" صراحة (من غير تخمين)
  if (!/محل[يى]|مستورد/.test(text)) delete obj.doors;
  // واسم الماكينة برضه: لازم يكون مكتوب في الرسالة نفسها
  const norm = (s) => String(s || '').replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي').replace(/\s+/g, ' ').trim();
  if (obj.brand) {
    const names = norm(obj.brand).split(/\s+او\s+|،|,/).map((x) => x.trim()).filter(Boolean);
    if (!names.every((x) => norm(text).includes(x))) delete obj.brand;
  }
  return obj;
}

/**
 * يفهم أمر خصم من موظف: "خفض الطرمبة IT لـ 300" / "خصم 50 على الكالون" / "خصم 10% على الكامة".
 * @returns {Promise<{product?:string, newPrice?:number, amount?:number, percent?:number}>}
 */
export async function extractDiscount(text) {
  const prompt =
    `موظف في محل قطع غيار مصاعد كتب أمر خصم لزبون:\n"${text}"\n\n` +
    `رجّع JSON object بالمفاتيح دي (اللي مش مذكور ما تحطوش):\n` +
    `product: اسم المنتج زي ما اتكتب\n` +
    `newPrice: السعر الجديد بعد الخصم لو اتقال (زي "خليها 300" أو "لـ 300")\n` +
    `amount: قيمة الخصم بالجنيه لو اتقالت (زي "خصم 50")\n` +
    `percent: نسبة الخصم لو اتقالت (زي "10%")\n` +
    `الأرقام بالأرقام الإنجليزي.`;
  const url = `${config.gemini.baseUrl}/models/${config.gemini.model}:generateContent?key=${config.gemini.apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', ...fast() },
    }),
  });
  if (!res.ok) throw new Error(`extractDiscount ${res.status}`);
  const data = await res.json();
  const txt = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text).filter(Boolean).join('');
  try {
    const o = JSON.parse(txt);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : {};
  } catch {
    return {};
  }
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
 * نداء صوت/صورة: بيجرّب موديل الصوت (flash) مرتين، ولو مزدحم (503) أو الحد خلص (429)
 * بيرجع للموديل العادي (flash-lite) — flash-lite بيفهم الصوت والصور كويس برضو.
 */
async function postMedia(body) {
  const models = [...new Set([config.gemini.audioModel, config.gemini.model, 'gemini-flash-latest'].filter(Boolean))];
  let res;
  for (const model of models) {
    const url = `${config.gemini.baseUrl}/models/${model}:generateContent?key=${config.gemini.apiKey}`;
    const post = () => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    res = await post();
    if (!res.ok && [500, 503].includes(res.status)) {
      await sleep(900);
      res = await post();
    }
    if (res.ok || ![429, 500, 503].includes(res.status)) return res;
    console.warn(`[gemini] ${model} ${res.status} — بجرّب الموديل التاني`);
  }
  return res;
}

/**
 * تفريغ رسالة صوتية لنص باستخدام Gemini (نفس المفتاح).
 * @param {ArrayBuffer} buffer الملف الصوتي
 * @param {string} mimeType نوعه (audio/ogg مثلاً)
 * @returns {Promise<string>} النص المفرّغ (فاضي لو فشل التعرّف)
 */
export async function transcribeAudio(buffer, mimeType = 'audio/ogg') {

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
            text:
              'فرّغ الرسالة الصوتية دي نصًّا بالعربي حرفيًا (عامية مصرية). اكتب النص فقط من غير أي مقدمات أو تعليق. لو مفيش كلام واضح رجّع نص فاضي.\n' +
              'المتكلم غالبًا بيسأل عن قطع غيار مصاعد أو تركيب مصعد. لو كلمة شبه اسم قطعة من دول اكتبها بالاسم الصح: ' +
              'كالون، طرمبة، ماكينة، كارتة، كنتاكتور، مارش، سكينة، ريليه، فورجيه، كابينة، حبل، طارة، ثقل، مغناطيس، زرار، ' +
              'انفرتر، كنترول، سيكور، افرلود، مناول، كاوتش، شفرة، كامة، أسانسير، مصعد.',
          },
        ],
      },
    ],
    generationConfig: { temperature: 0, maxOutputTokens: 400 },
  });

  const res = await postMedia(body);
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

/**
 * يوصف صورة منتج بجملة بحث قصيرة بالعربي (تصلح كـ query على الكتالوج).
 * بيشتغل سواء الصورة من عميل بيسأل بكام أو تاجر بيعرض منتج.
 * @returns {Promise<string>} وصف قصير، أو نص فاضي لو مقدرش يتعرّف عليها
 */
export async function identifyImage(buffer, mimeType = 'image/jpeg') {

  const body = JSON.stringify({
    contents: [
      {
        role: 'user',
        parts: [
          {
            inline_data: {
              mime_type: (mimeType || 'image/jpeg').split(';')[0].trim(),
              data: base64FromArrayBuffer(buffer),
            },
          },
          {
            text:
              'الصورة دي غالبًا لمنتج أو قطعة غيار خاصة بالمصاعد. اكتب جملة قصيرة بالعربي (3-6 كلمات) ' +
              'توصف نوع المنتج بشكل يصلح كجملة بحث في كتالوج — زي "كالون باب اسانسير" أو "طرمبة هيدروليك". ' +
              'اعمل أفضل تخمين ممكن حتى لو مش متأكد تمامًا. لو مش قادر تحدد نوع القطعة بالظبط، ' +
              'اوصف شكلها العام (اللون، الخامة، الشكل التقريبي) بدل ما ترجع حاجة فاضية — ' +
              'إياك ترجع نص فاضي إلا لو الصورة فعلاً مش واضحة خالص (ضبابية أو مقطوعة). ' +
              'اكتب الجملة بس من غير أي تعليق أو مقدمة.',
          },
        ],
      },
    ],
    generationConfig: { temperature: 0, maxOutputTokens: 60 },
  });

  const res = await postMedia(body);
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Gemini vision ${res.status}: ${t.slice(0, 200)}`);
  }
  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts || [];
  return parts
    .map((p) => p.text)
    .filter(Boolean)
    .join(' ')
    .trim();
}
