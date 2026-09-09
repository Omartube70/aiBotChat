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
    // موديل تفريغ الصوت — flash العادي أضمن للصوت من flash-lite
    audioModel: 'gemini-flash-latest',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
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
    provider: 'elevenlabs', // TTS_PROVIDER: elevenlabs | azure
    apiKey: '', // TTS_API_KEY (لو فاضي، الرد بيفضل نص)
    voiceId: '21m00Tcm4TlvDq8ikWAM', // TTS_VOICE_ID — صوت ElevenLabs، أو اسم صوت Azure
    azureRegion: 'eastus', // TTS_AZURE_REGION (لو provider=azure)
    maxChars: 700, // ردود أطول من كده بتتبعت نص
  },

  sendImages: true, // إرسال صور المنتجات مع الرد

  // التحويل لموظف بشري + متابعة الإدارة
  agent: {
    manager: '201000363323', // AGENT_MANAGER — تحويل "عايز أكلم حد"
    accounts: '201050699420', // AGENT_ACCOUNTS — حسابات / فواتير / دفع
    ccNumbers: ['201000363323', '201003044660'], // CC_NUMBERS — بتوصلهم نسخة من كل رسالة عميل
    handoffTtl: 7200, // ثواني — بعدها البوت يرجع تلقائيًا لو الموظف نسي يقفل
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
  config.tts.azureRegion = g('TTS_AZURE_REGION', config.tts.azureRegion);
  const tmax = Number(g('TTS_MAX_CHARS', String(config.tts.maxChars)));
  config.tts.maxChars = Number.isFinite(tmax) && tmax > 0 ? tmax : 700;

  config.sendImages = g('SEND_IMAGES', '1') !== '0';
  config.agent.manager = g('AGENT_MANAGER', config.agent.manager).replace(/\D/g, '');
  config.agent.accounts = g('AGENT_ACCOUNTS', config.agent.accounts).replace(/\D/g, '');
  config.agent.ccNumbers = [
    ...new Set(
      g('CC_NUMBERS', config.agent.ccNumbers.join(','))
        .split(',')
        .map((s) => s.replace(/\D/g, ''))
        .filter(Boolean),
    ),
  ];
  const httl = Number(g('HANDOFF_TTL_SECONDS', String(config.agent.handoffTtl)));
  config.agent.handoffTtl = Number.isFinite(httl) && httl > 0 ? httl : 7200;

  const ttl = Number(g('CATALOG_TTL_SECONDS', '300'));
  config.catalogTtlMs = (Number.isFinite(ttl) && ttl > 0 ? ttl : 300) * 1000;

  config.port = Number(g('PORT', '3000')) || 3000;

  return config;
}
