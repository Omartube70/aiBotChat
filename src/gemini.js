import { config } from './config.js';
import { searchProducts, suggestProduct } from './catalog.js';
import { noteError } from './diag.js';

const S = config.store;

const SYSTEM_PROMPT = `أنت بيّاع شاطر وابن بلد في متجر "${S.name}" (بيع مهمات وقطع غيار ومستلزمات المصاعد)، بتكلم الزباين على واتساب.
مهمتك: تساعد الزبون يلاقي اللي محتاجه بأسعاره، وتكلمه زي ما بيّاع محترم وودود بيكلم زبون قدامه في المحل.

أسلوب الكلام (مهم جدًا):
- اتكلم بالعامية المصرية الطبيعية، بدفء واحترام — مش كلام رسمي ولا ردود آلية محفوظة.
- اندمج مع الزبون: رد على كلامه هو بالظبط، ولو قال حاجة عن شغله أو المصعد أو مشكلته علّق عليها بجملة قصيرة قبل الأسعار
  (زي "ربنا يسهّل، الكالون ده بيتغيّر كتير فعلاً" أو "تمام، يبقى حضرتك محتاج الإيطالي عشان أقوى").
- افتكر اللي اتقال قبل كده في المحادثة وكمّل عليه — متسألوش حاجة قالها، ولو رجع يسأل عن حاجة اتكلمنا فيها اربطها بالكلام اللي فات.
- ساعده يختار: لو فيه أكتر من نوع، قوله الفرق باختصار لو واضح من الاسم أو الوصف (إيطالي/تركي/صيني، الحجم، القدرة)،
  واسأله سؤال واحد بسيط يوصّلك للأنسب (زي "المصعد عندك ركاب ولا بضاعة؟" أو "محتاج كام واحدة؟").
  **الاختيارات والمقارنة تكون بين المنتجات الموجودة في قسم الكتالوج بس** — متعرضش ولا توافق على نوع/بلد مش موجود فيه
  (لو الزبون طلب "إيطالي" ومفيش كالون إيطالي في القسم، قوله بلطف إن المتاح كذا وكذا واقترح الأقرب).
- اختم بجملة تفتح الكلام معاه (سؤال أو عرض مساعدة)، بس متكررش نفس الجملة في كل رد.
- **نوّع أسلوبك** زي البيّاع الشاطر: مرة راقي ("تحت أمر حضرتك يا فندم")، ومرة ابن بلد وشعبي ("تحت أمرك يا برنس"،
  "عيوني يا حبيبنا"، "من عينيا يا باشمهندس"، "تمام يا هندسة"، "يا معلم")، ومرة هزار خفيف يفرّح الزبون —
  على حسب أسلوب الزبون نفسه (لو بيهزر هزّر معاه، ولو رسمي خليك محترم). **متكررش نفس النداء أو نفس الجملة ورا بعض.**
- لو حسّيت إن الزبون بيكتب بصعوبة (كلام متلخبط، أخطاء كتير) أو قال "مش بعرف أكتب/أقرا": قوله بلطف
  "عينيا الاتنين 🙏 لو الكتابة تاعباك ابعتلي فويس وأنا أرد عليك فويس على طول".
- لو فيه منتج عليه "اقتراح_للزبون": true، ده منتج حلو تقترحه عليه **في آخر الرد بجملة خفيفة بسعره**
  (زي "وعلى فكرة يا برنس، إيه رأيك في [اسم المنتج]؟ حلوة جدًا وسعرها [السعر] بس 😉") — من غير إلحاح، وبس لو الكلام ماشي كويس.
- عبارات زي "تحت أمرك"، "من عينيا"، "ولا يهمك"، "نورتنا" حلوة بس بشكل طبيعي ومش في كل رسالة.
- خليك مختصر: رسايل واتساب قصيرة وسهلة القراءة، والأسعار في نقاط. إيموجي واحد أو اتنين بالكتير.
- لما تعرض أسعار، فكّر الزبون إن **كل حاجة عندنا أصلية وبالضمان** — مرة في أول المحادثة، ولو الكلام طوّل قوي فكّره تاني (جملة قصيرة في الآخر، مش في كل رد).
- لو مقدرتش تساعده بالكامل (منتج مش لاقيه، طلب معقّد، أو حسّيت إنه مش مبسوط)، اختم بلطف بحاجة زي:
  "ولو أنا مقدرتش أوفّيك حقك في حاجة، سامحني 🙏 تقدر تكلّمنا مباشرة على ${S.phone} وإحنا تحت أمرك."

قواعد مهمة:
- الرسايل تكون قصيرة ومحترمة (زي ما واتساب محتاج).
- الترحيب: لو فيه "اسم العميل" في الرسالة، رحّب بيه في أول رد بـ "أهلاً يا <اسم العميل زي ما هو مكتوب>" (زي "أهلاً يا أستاذ كريم" أو "أهلاً يا حاج سيد")، ولو مفيش اسم قول "أهلاً بحضرتك".
  **ممنوع تخترع اسم للعميل أو تقول "يا حاج" أو أي اسم مش مكتوب قدامك.** ومتكررش الترحيب في كل رسالة.
- في كل رسالة هتلاقي قسم "منتجات من الكتالوج" فيه نتائج بحث فعلية من المتجر. اعتمد عليه فقط.
- لا تخترع أي سعر أو منتج. لو مفيش نتائج مناسبة في القسم ده، قول للعميل إنك مش لاقي المنتج بالاسم ده،
  واطلب منه يوضّح الاسم أكتر أو يبعت صورة، واداله رقم المحل: ${S.phone}.
- لو المنتجات عليها "تقريبي": true، يبقى العميل غالبًا كتب الاسم غلط أو الفويس اتسمع غلط (زي "صالون" بدل "كالون"):
  متقولش إنك مش لاقي المنتج — قوله بلطف "حضرتك تقصد [اسم المنتج]؟" واعرض الأسعار عادي.
- الأسعار كلها بالجنيه المصري (${S.currency}).
- لو المنتج ليه أكتر من نوع/سعر، اعرضهم كلهم في نقاط.
- اعرض بس المنتجات اللي الزبون بيسأل عنها فعلاً (نفس نوع القطعة) — قسم الكتالوج ممكن يكون فيه حاجات تانية
  طلعت في البحث بالصدفة (زي ماكينات لما الزبون قال "إيطالي" وهو بيتكلم عن كالون)، دي تجاهلها.
  (المنتج اللي عليه "اقتراح_للزبون" استثناء — ده مقصود تقترحه في الآخر.)
- ممنوع تقول للعميل إن أي منتج "غير متوفر" أو "خلص" أو "مش موجود في المخزون" — إدّيه السعر والتفاصيل عادي زي أي منتج تاني، من غير ما تتكلم عن حالة التوفر خالص.
- صور المنتجات بتتبعت تلقائيًا بعد ردك لو متوفرة — متقولش للعميل يروح لحد تاني عشان الصور، بس ممكن تقوله "بعتلك الصورة".
- لو العميل سأل عن العنوان أو المكان، بتتبعت له نقطة الموقع تلقائيًا — اذكر العنوان بالنص كمان.
- لو العميل طلب "فويس" أو "رسالة صوتية" أو قال إنه مش شايف/مش بيعرف يقرا: النظام بيبعت ردك ده نفسه فويس لوحده.
  **متقولش "هبعتلك فويس" ولا "مش بقدر أبعت صوت"** — جاوب على سؤاله على طول بجمل بسيطة تتسمع كويس.
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
      generationConfig: { temperature: 0.7, maxOutputTokens: 1200, ...thinkingFor(m), ...gen },
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
  const prev = lastUserText(history);
  if (!prev || prev === userText) return searchProducts(userText, 10);

  // رسالة متابعة ("والفرق ايه بين التركي والايطالي؟") مالهاش معنى من غير اللي قبلها —
  // فبندوّر بالرسالتين مع بعض كمان، ونتايجهم الأول عشان البوت يفضل في نفس الموضوع (الكالون).
  const [current, together] = await Promise.all([
    searchProducts(userText, 10),
    searchProducts(`${prev} ${userText}`, 10),
  ]);
  const seen = new Set();
  const products = [];
  for (const p of [...together, ...current]) {
    if (seen.has(p.الاسم) || products.length >= 14) continue;
    seen.add(p.الاسم);
    products.push(p);
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
  // من وقت للتاني (مش كل رسالة) نحط منتج حلو يقترحه على الزبون — بسعره الحقيقي وصورته
  if (products.length && history.length >= 2 && Math.random() < 0.3) {
    const extra = await suggestProduct(products.map((p) => p['الاسم'])).catch(() => null);
    if (extra) products.push(extra);
  }
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

  // قفل ضد الأسعار المتألفة: أي سعر في الرد لازم يكون من الكتالوج (أو رقم قاله الزبون نفسه).
  // لو لأ → نطلب منه يكتب تاني مرة، ولو برضو غلط → رد مبني من بيانات الكتالوج مباشرة.
  const userNums = [userText, ...history.filter((m) => m.role === 'user').map((m) => m.parts?.[0]?.text || '')];
  if (reply && !pricesGrounded(reply, products, userNums)) {
    console.warn('[gemini] رد فيه أسعار مش من الكتالوج:', reply.replace(/\n/g, ' ').slice(0, 200));
    noteError(`[أسعار متألفة] اتمنعت: ${reply.replace(/\n/g, ' ').slice(0, 160)}`);
    try {
      const data = await callGemini([
        ...contents,
        { role: 'model', parts: [{ text: reply }] },
        {
          role: 'user',
          parts: [
            {
              text:
                'تنبيه من النظام (مش من الزبون): ردك اللي فات فيه منتجات أو أسعار مش موجودة في قسم "منتجات من الكتالوج". ' +
                'اكتب الرد تاني بنفس الأسلوب، بالمنتجات والأسعار اللي في القسم بس بالحرف. ولو مفيش منتج مناسب قول إنك مش لاقيه.',
            },
          ],
        },
      ]);
      const parts = data.candidates?.[0]?.content?.parts || [];
      reply = parts.map((p) => p.text).filter(Boolean).join('\n').trim();
    } catch {
      reply = '';
    }
    if (!reply || !pricesGrounded(reply, products, userNums)) reply = catalogReply(products);
  }

  // "أصلية وبالضمان" مرة في أول المحادثة، وتاني بس لو الكلام طوّل (آخر 4 ردود مافيهاش ضمان)
  if (reply && history.slice(-8).some((m) => m.role === 'model' && /ضمان/.test(m.parts?.[0]?.text || ''))) {
    reply = dropWarrantySentences(reply);
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

// رقم جنبه عملة: "800 ج.م" / "1,400 جنيه" / "150ج"
const PRICE_RE = /(\d[\d,٬.]*)\s*(?:ج\s*\.?\s*م|جنيه|جنية|ج(?![\p{L}])|LE\b|EGP\b)/gu;
const toNum = (s) => Number(String(s).replace(/[,٬]/g, ''));

/**
 * كل سعر في الرد موجود في الكتالوج؟ مسموح كمان: مضاعفات سعر (كمية × سعر)، مجموع سعرين،
 * وأي رقم كتبه الزبون بنفسه (زي تاجر بيقول سعره).
 */
function pricesGrounded(reply, products, userTexts = []) {
  const toLatin = (s) => String(s).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
  const allowed = new Set();
  const add = (n) => Number.isFinite(n) && n > 0 && allowed.add(Math.round(n * 100) / 100);
  for (const p of products) {
    add(p._price);
    add(p._priceMax);
    const txt = toLatin(`${p['السعر'] || ''} ${(p['الأنواع'] || []).join(' ')}`);
    for (const m of txt.matchAll(/\d[\d,٬.]*/g)) add(toNum(m[0]));
  }
  for (const t of userTexts) for (const m of toLatin(t).matchAll(/\d[\d,٬.]*/g)) add(toNum(m[0]));
  const list = [...allowed];
  for (const m of toLatin(reply).matchAll(PRICE_RE)) {
    const n = Math.round(toNum(m[1]) * 100) / 100;
    if (!Number.isFinite(n) || allowed.has(n)) continue;
    const multiple = list.some((p) => p >= 1 && n % p === 0 && n / p <= 500);
    const pairSum = list.some((a) => list.some((b) => Math.abs(a + b - n) < 0.01));
    if (!multiple && !pairSum) return false;
  }
  return true;
}

/**
 * يشيل الجمل اللي فيها "ضمان" من الرد (لما تكون اتقالت قبل كده في المحادثة).
 * بيقسم بالسطور وبعدين بالجمل (. ! ؟ ،) عشان مايشيلش سطر كامل فيه سؤال مهم.
 */
function dropWarrantySentences(reply) {
  const lines = reply.split('\n').map((line) => {
    if (!/ضمان/.test(line)) return line;
    // بنقسم عند نهاية الجملة أو الفاصلة — عشان "الكالون بـ 800، وكل حاجتنا بالضمان" يفضل فيها السعر
    const parts = line.split(/(?<=[.!؟?،,])\s+/);
    return parts
      .map((p) => {
        if (!/ضمان/.test(p)) return p;
        // جزء فيه رقم (سعر) عمره ما يتشال — بنقص منه كلام الضمان بس ("بـ 375 وكلها بالضمان" → "بـ 375")
        if (/[\d٠-٩]/.test(p)) return p.replace(/\s*و?\s*(?:طبعا|طبعاً)?\s*(?:كل|كلها|كله)[^،,.!؟\d]*ضمان[^،,.!؟\d]*/, '');
        return '';
      })
      .filter(Boolean)
      .join(' ')
      .replace(/[،,]\s*$/, '');
  });
  const out = lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return out || reply;
}

/** رد احتياطي مبني من بيانات الكتالوج مباشرة (لما Gemini يكرر يألّف أسعار). */
function catalogReply(products) {
  if (!products.length) {
    return (
      'معلش، مش لاقي المنتج ده بالاسم ده عندنا 🙏\n' +
      `ممكن توضّحلي الاسم أكتر أو تبعتلي صورته؟ أو كلّمنا على ${S.phone}`
    );
  }
  const lines = products.slice(0, 10).map((p) => `• ${p['الاسم']}: ${p['السعر']}`);
  return `دي الأسعار المتاحة عندنا:\n${lines.join('\n')}\n\nتحب أساعدك تختار الأنسب؟`;
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

/**
 * أمر موظف بالكلام العادي من تليفونه — يفهم هو عايز إيه ولمين:
 *   "قول لعمر اللي كان بيسأل على الكالون إن السعر 700" / "اللي آخره 3518 قوله كذا"
 *   "حط سعر عرض الأستاذ محمد علي 450 ألف" / "العرض بتاع فيصل 5 أدوار سعره 600000"
 * @param {Array<{i:number,id:string,name:?string,text:string,ago:string}>} customers آخر الزباين
 * @param {Array<{n:number,client:string,phone:string,address:string,machine:string,floors:string}>} quotes عروض مستنية سعر
 * @returns {Promise<{action:'message'|'reengage'|'quote_price'|'none', customer?:string, target?:string, message?:string, quote?:number, price?:number}>}
 */
export async function interpretStaffCommand(text, customers, quotes) {
  const custLines = customers
    .map((c) => `${c.i}) رقم ${c.id} (آخره ${c.id.slice(-4)}) | الاسم: ${c.name || '—'} | آخر رسالة (${c.ago}): ${c.text}`)
    .join('\n');
  const quoteLines = quotes
    .map((q) => `عرض رقم ${q.n} | ${q.client || '—'} | ${q.phone || ''} | ${q.address || ''} | ${q.machine || ''} | ${q.floors || ''} أدوار`)
    .join('\n');
  const prompt =
    `إنت مساعد صاحب محل "${S.name}" (قطع غيار مصاعد) وشركة توب باور (تركيب مصاعد). صاحب المحل أو موظف كتبلك من تليفونه:\n"${text}"\n\n` +
    `آخر الزباين اللي كلّموا البوت:\n${custLines || '(مفيش)'}\n\n` +
    `عروض تركيب مستنية سعر:\n${quoteLines || '(مفيش)'}\n\n` +
    `حدد هو عايز إيه ورجّع JSON object بس:\n` +
    `- لو عايز تبعت كلام معيّن لزبون (زي "قوله"، "رد عليه"، "ابعتله"، "بلّغه"): {"action":"message","customer":"<الرقم الكامل من القايمة>","target":"<الاسم أو الأرقام زي ما هو قالها>","message":"<الرسالة للزبون>"}\n` +
    `  لو قال اسم الزبون ("ده اسمه عبد الرحمن"، "ده الحاج سيد") زوّد "customer_name":"<الاسم>" — وفي الحالة دي استخدم الاسم ده في الرسالة.\n` +
    `  اسم زي "toppower4444" أو فيه أرقام أو إنجليزي غريب ده مش اسم حقيقي — متستخدموش، قول "حضرتك".\n` +
    `- لو **بس** بيعرّفك اسم زبون ومفيش أي كلام يتقال للزبون ("اللي آخره 18 اسمه عبد الرحمن" وخلاص): {"action":"set_name","customer":"<الرقم من القايمة>","target":"<الأرقام/الوصف>","customer_name":"<الاسم>"}\n` +
    `  لو قال الاسم **وكمان** كلام يتقال للزبون ("ده اسمه عبد الرحمن قوله كذا") → ده action "message" مع customer_name.\n` +
    `  لو الزبون في القايمة فوق حط رقمه في customer، ولو مش فيها سيب customer فاضي وحط الاسم/الأرقام اللي قالها في target.\n` +
    `- لو عايز يبعت لزبون رسالة حلوة يشجعه يشتري تاني (زي "بقاله كتير ما جاش"، "ابعتله رسالة حلوة"، "فكّره بينا"، "كلمه يرجع"): ` +
    `{"action":"reengage","customer":"<الرقم من القايمة لو موجود>","target":"<الاسم أو الأرقام زي ما هو قالها>"}\n` +
    `  حدد الزبون من الاسم أو آخر أرقام التليفون أو الحاجة اللي كان بيسأل عليها. الرسالة تتكتب للزبون بالعامية المصرية بأسلوب محترم وودود ` +
    `بلسان المحل، وفيها كل المعلومات اللي صاحب المحل قالها بالظبط (الأسعار والأرقام زي ما هي) من غير أي معلومة من عندك. ` +
    `نادي الزبون "أستاذ <اسمه>" لو اسمه عربي ومعروف، وإلا "حضرتك" — من غير ألقاب تانية (مهندس/دكتور...).\n` +
    `- لو عايز يحط سعر لعرض تركيب: {"action":"quote_price","quote":<رقم العرض من القايمة>,"price":<السعر رقم كامل، "450 ألف" = 450000>}\n` +
    `  حدد العرض من اسم العميل أو العنوان أو التليفون أو أي بيانات قالها.\n` +
    `- لو عايز يعرف سعر منتج (بيع/شراء/تكلفة/"شوفلي سعر"/"بنبيعه بكام"/"جاي علينا بكام"): {"action":"product_price","product":"<اسم المنتج بس>"}\n` +
    `- لو عايز فاتورة أو يحسب كذا صنف بكميات: {"action":"invoice","items":"<كل صنف في سطر: العدد وبعده اسم المنتج>"}\n` +
    `- لو عايز يعمل عرض سعر تركيب مصعد جديد: {"action":"install_offer"}\n` +
    `- لو الكلام عن الرواتب أو الموظفين: {"action":"payroll","command":"<أمر واحد بالظبط من دول: مساعده رواتب | راتب <اسم الموظف> | رواتب الموظفين | الموظفين | موظف جديد | حذف موظف | تعديل رواتب | <اسم الموظف> سلف <المبلغ> | <اسم الموظف> حضور <عدد الأيام> | <اسم الموظف> بياخد <المبلغ>>"}\n` +
    `  أمثلة: "هنعمل شغل في الرواتب" / "افتحلي الرواتب" → مساعده رواتب | "احسب رواتب الكل" → رواتب الموظفين | ` +
    `"دخّل/ضيف/زوّد موظف" → موظف جديد | "هنخرج/نشيل/نمشّي/امسح موظف" → حذف موظف | "راتب هند كام" → راتب هند | ` +
    `"هند مرتبها بقى 7000" / "خلي قبض هند 7000" → هند بياخد 7000 | "سعيد أخد سلفة 500" → سعيد سلف 500 | "علاء حضر 10 أيام" → علاء حضور 10\n` +
    `- لو بيسأل على حساب/فلوس/مديونية عميل أو مورّد ("محمد عليه كام"، "لينا عند سعيد كام"، "حساب المورد فلان"): {"action":"balance","who":"<الاسم>","kind":"customer أو supplier"}\n` +
    `- أي كلام تاني (سلام، سؤال عام، دردشة): {"action":"chat"}\n` +
    `- لو أمر لزبون أو عرض بس مش متأكد مين: {"action":"none"}`;
  const res = await fetch(endpointFor(config.gemini.model), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: { temperature: 0, responseMimeType: 'application/json', ...fast() },
    }),
  });
  if (!res.ok) throw new Error(`interpretStaffCommand ${res.status}`);
  const data = await res.json();
  const txt = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text).filter(Boolean).join('');
  try {
    const o = JSON.parse(txt);
    return o && typeof o === 'object' && !Array.isArray(o) ? o : { action: 'none' };
  } catch {
    return { action: 'none' };
  }
}

const STAFF_PROMPT = `إنت مساعد شاطر وموظف أمين عند صاحب محل "${S.name}" (قطع غيار مصاعد) وشركة "توب باور" (تركيب وصيانة مصاعد).
اللي بيكلمك دلوقتي صاحب المحل أو واحد من موظفينه — مش زبون.
- **ممنوع تعامله كزبون**: متسألوش "محتاج قطع غيار إيه" ولا تعرض عليه بضاعة ولا تقوله "أهلاً بيك في المحل".
- رد زي موظف بيكلم مديره: قصير، عملي، بالعامية المصرية، ومحترم ("تحت أمرك"، "حاضر"، "تمام يا فندم").
- لو بيسلّم أو بيدردش: رد بلطف واسأله "تحب أعملك إيه؟".
- قوله إنك تقدر: تجيب سعر البيع والشراء لأي منتج، تعمل فاتورة، تعمل عرض سعر تركيب، تحسب الرواتب، تبعت رسالة لزبون، تحط سعر لعرض عميل — لو سأل تقدر تعمل إيه.
- ممنوع تخترع أرقام أو أسعار أو بيانات.`;

/** رد "موظف" لصاحب المحل (مش رد بيّاع لزبون). */
export async function staffChat(text, history = []) {
  const res = await fetch(endpointFor(config.gemini.model), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(15000),
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: STAFF_PROMPT }] },
      contents: [...history, { role: 'user', parts: [{ text }] }],
      generationConfig: { temperature: 0.5, maxOutputTokens: 600, ...fast() },
    }),
  });
  if (!res.ok) throw new Error(`staffChat ${res.status}`);
  const data = await res.json();
  const reply = (data.candidates?.[0]?.content?.parts || []).map((p) => p.text).filter(Boolean).join('\n').trim();
  return {
    reply,
    history: [...history, { role: 'user', parts: [{ text }] }, { role: 'model', parts: [{ text: reply }] }].slice(-12),
  };
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
