import 'dotenv/config';

function required(name) {
  const v = process.env[name];
  if (!v || !v.trim()) {
    console.warn(`[config] تحذير: المتغير ${name} فارغ — راجع ملف .env`);
  }
  return (v || '').trim();
}

export const config = {
  port: Number(process.env.PORT || 3000),

  gemini: {
    apiKey: required('GEMINI_API_KEY'),
    model: (process.env.GEMINI_MODEL || 'gemini-flash-lite-latest').trim(),
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
  },

  whatsapp: {
    phoneNumberId: required('WHATSAPP_PHONE_NUMBER_ID'),
    token: required('WHATSAPP_TOKEN'),
    verifyToken: (process.env.WHATSAPP_VERIFY_TOKEN || 'quds-bot-verify-123').trim(),
    graphVersion: (process.env.WHATSAPP_GRAPH_VERSION || 'v21.0').trim(),
  },

  store: {
    slug: (process.env.STORE_SLUG || 'httpsgcokgspyk1uqu').trim(),
    apiBase: (process.env.INYAD_API_BASE || 'https://api.inyad.com/storefront').trim(),
    apiKey: (process.env.INYAD_API_KEY || 'yhLyRgMw!5je4pN*jrx6').trim(),
    // بيانات المتجر الثابتة (تقدر تعدّلها هنا)
    name: 'القدس لمهمات المصاعد',
    phone: '01050699418',
    whatsapp: '+201050699418',
    extraPhone: '01003044660',
    address: '3 شارع الدكتور علي صبري، من الليبيني، الهرم — بجوار فندق سياج، الجيزة',
    city: 'الجيزة',
    currency: 'ج.م',
    website: 'https://httpsgcokgspyk1uqu.mahaal.online/products',
    workingHours: 'يومياً تقريباً على مدار اليوم',
  },

  catalogTtlMs: Number(process.env.CATALOG_TTL_SECONDS || 300) * 1000,
};
