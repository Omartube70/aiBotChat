/**
 * الإعدادات.
 * - بيانات المتجر الثابتة موجودة هنا كقيَم افتراضية.
 * - المفاتيح السرّية بتتحقن وقت التشغيل عبر applyEnv(env):
 *     على Workers  → من الـ bindings (env)
 *     محلياً       → من process.env (شوف src/load-env.js)
 */

export const config = {
  port: 3000, // مستخدم محلياً فقط، Workers بيتجاهله

  gemini: {
    apiKey: '',
    model: 'gemini-flash-lite-latest',
    audioModel: 'gemini-flash-lite-latest', // أسرع ومش بيزدحم زي flash؛ flash العادي احتياطي لو فشل
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    // GEMINI_FALLBACK_MODELS — بيدخلوا السباق لو الأساسي اتأخر أو فشل (من البوت القديم)
    fallbackModels: ['gemini-3.5-flash-lite', 'gemini-3-flash-preview'],
  },

  whatsapp: {
    phoneNumberId: '',
    token: '',
    verifyToken: 'quds-bot-verify-123',
    graphVersion: 'v21.0',
  },

  store: {
    slug: 'httpsgcokgspyk1uqu',
    apiBase: 'https://api.inyad.com/storefront',
    apiKey: 'yhLyRgMw!5je4pN*jrx6', // مفتاح الـ storefront العام
    imageBase: 'https://s3.eu-west-3.amazonaws.com/images.api.invyad.com',
    // بيانات المتجر الثابتة (عدّلها هنا مباشرة)
    name: 'القدس لمهمات المصاعد',
    phone: '01050699418',
    whatsapp: '+201050699418',
    extraPhone: '01003044660',
    address: '3 شارع الدكتور علي صبري، من الليبيني، الهرم — بجوار فندق سياج، الجيزة',
    city: 'الجيزة',
    lat: 29.98513454,
    lng: 31.15106881,
    mapUrl: 'https://maps.google.com/?q=29.98513454,31.15106881',
    currency: 'ج.م',
    website: 'https://httpsgcokgspyk1uqu.mahaal.online/products',
    workingHours: 'يومياً تقريباً على مدار اليوم',
  },

  // تحويل نص → كلام للرد الصوتي
  tts: {
    provider: 'gemini', // TTS_PROVIDER: gemini (مجاني بـ GEMINI_API_KEY) | elevenlabs | azure
    apiKey: '', // TTS_API_KEY لـ elevenlabs/azure (لو فاضي، الرد بيفضل نص)
    geminiModel: 'gemini-3.8-flash-tts', // TTS_GEMINI_MODEL — موديل الـ TTS المتاح في الـ free tier
    geminiVoice: 'Charon', // TTS_GEMINI_VOICE — من أصوات Gemini الجاهزة
    voiceId: '21m00Tcm4TlvDq8ikWAM', // TTS_VOICE_ID — صوت ElevenLabs، أو اسم صوت Azure
    azureRegion: 'eastus', // TTS_AZURE_REGION (لو provider=azure)
    maxChars: 700, // ردود أطول من كده بتتبعت نص
    enabled: false, // VOICE_REPLIES=1 يشغّل الرد بالصوت (محتاج Workers Paid — المجاني بيوقف الرسالة)
  },

  sendImages: true, // إرسال صور المنتجات مع الرد
  botEnabled: true, // BOT_ENABLED=0 يوقف الردود كلها مؤقتًا من غير ما يلغي أي إعداد

  // تكامل Facebook Messenger (صفحة توب باور للمصاعد)
  facebook: {
    pageAccessToken: '', // FB_PAGE_ACCESS_TOKEN
    verifyToken: '', // FB_VERIFY_TOKEN (لو فاضي بيستخدم WHATSAPP_VERIFY_TOKEN)
  },

  // التحويل لموظف بشري + متابعة الإدارة
  agent: {
    manager: '201000363323', // AGENT_MANAGER — تحويل "عايز أكلم حد"
    accounts: '201050699420', // AGENT_ACCOUNTS — حسابات / فواتير / دفع
    management: ['201000363323', '201003044660'], // AGENT_MANAGEMENT — "عايز حد من الإدارة" (بيوصل الاتنين)
    ccNumbers: ['201000363323', '201003044660', '201050699420'], // CC_NUMBERS — بتوصلهم نسخة من كل رسالة عميل
    handoffTtl: 7200, // ثواني — بعدها البوت يرجع تلقائيًا لو الموظف نسي يقفل
    admins: ['201000363323', '201003044660', '201050699420'], // AGENT_ADMINS — أسعار البيع والشراء والمخزون (أرقام الموظفين التلاتة)
    payroll: ['201000363323'], // AGENT_PAYROLL — الرواتب من الرقم ده بس
  },

  // ربط جهات اتصال جوجل من المتصفح (/google/connect) — الحساب الوحيد المسموح بربطه
  google: {
    accountEmail: 'toppower4444@gmail.com', // GOOGLE_ACCOUNT_EMAIL
  },

  catalogTtlMs: 300 * 1000,
};

/**
 * يحقن قيم البيئة في كائن config الموجود (mutate in place عشان أي
 * `const S = config.store` اتعمل وقت الاستيراد يفضل صالح).
 * @param {Record<string, string | undefined>} env
 */
export function applyEnv(env = {}) {
  const g = (name, fallback = '') => {
    const v = env[name];
    return v == null || String(v).trim() === '' ? fallback : String(v).trim();
  };

  config.gemini.apiKey = g('GEMINI_API_KEY');
  config.gemini.model = g('GEMINI_MODEL', config.gemini.model);
  config.gemini.audioModel = g('GEMINI_AUDIO_MODEL', config.gemini.audioModel);
  config.gemini.fallbackModels = g('GEMINI_FALLBACK_MODELS', config.gemini.fallbackModels.join(','))
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  config.whatsapp.phoneNumberId = g('WHATSAPP_PHONE_NUMBER_ID');
  config.whatsapp.token = g('WHATSAPP_TOKEN');
  config.whatsapp.verifyToken = g('WHATSAPP_VERIFY_TOKEN', config.whatsapp.verifyToken);
  config.whatsapp.graphVersion = g('WHATSAPP_GRAPH_VERSION', config.whatsapp.graphVersion);

  config.store.slug = g('STORE_SLUG', config.store.slug);
  config.store.apiBase = g('INYAD_API_BASE', config.store.apiBase);
  config.store.apiKey = g('INYAD_API_KEY', config.store.apiKey);

  config.tts.provider = g('TTS_PROVIDER', config.tts.provider);
  config.tts.apiKey = g('TTS_API_KEY');
  config.tts.voiceId = g('TTS_VOICE_ID', config.tts.voiceId);
  config.tts.geminiModel = g('TTS_GEMINI_MODEL', config.tts.geminiModel);
  config.tts.geminiVoice = g('TTS_GEMINI_VOICE', config.tts.geminiVoice);
  config.tts.azureRegion = g('TTS_AZURE_REGION', config.tts.azureRegion);
  const tmax = Number(g('TTS_MAX_CHARS', String(config.tts.maxChars)));
  config.tts.maxChars = Number.isFinite(tmax) && tmax > 0 ? tmax : 700;
  config.tts.enabled = g('VOICE_REPLIES', '0') === '1';

  config.sendImages = g('SEND_IMAGES', '1') !== '0';
  config.botEnabled = g('BOT_ENABLED', '1') !== '0';

  config.facebook.pageAccessToken = g('FB_PAGE_ACCESS_TOKEN');
  config.facebook.verifyToken = g('FB_VERIFY_TOKEN', config.whatsapp.verifyToken);
  config.agent.manager = g('AGENT_MANAGER', config.agent.manager).replace(/\D/g, '');
  config.agent.accounts = g('AGENT_ACCOUNTS', config.agent.accounts).replace(/\D/g, '');
  config.agent.management = [
    ...new Set(
      g('AGENT_MANAGEMENT', config.agent.management.join(','))
        .split(',')
        .map((s) => s.replace(/\D/g, ''))
        .filter(Boolean),
    ),
  ];
  config.agent.ccNumbers = [
    ...new Set(
      g('CC_NUMBERS', config.agent.ccNumbers.join(','))
        .split(',')
        .map((s) => s.replace(/\D/g, ''))
        .filter(Boolean),
    ),
  ];
  config.agent.admins = [
    ...new Set(
      g('AGENT_ADMINS', config.agent.admins.join(','))
        .split(',')
        .map((s) => s.replace(/\D/g, ''))
        .filter(Boolean),
    ),
  ];
  config.agent.payroll = g('AGENT_PAYROLL', config.agent.payroll.join(','))
    .split(',')
    .map((s) => s.replace(/D/g, ''))
    .filter(Boolean);
  const httl = Number(g('HANDOFF_TTL_SECONDS', String(config.agent.handoffTtl)));
  config.agent.handoffTtl = Number.isFinite(httl) && httl > 0 ? httl : 7200;

  const ttl = Number(g('CATALOG_TTL_SECONDS', '300'));
  config.catalogTtlMs = (Number.isFinite(ttl) && ttl > 0 ? ttl : 300) * 1000;

  config.google.accountEmail = g('GOOGLE_ACCOUNT_EMAIL', config.google.accountEmail);

  config.port = Number(g('PORT', '3000')) || 3000;

  return config;
}
