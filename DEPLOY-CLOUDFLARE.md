# رفع البوت على Cloudflare Workers

الكود اتحوّل من Express لـ Worker. نقطة التشغيل الجديدة: `src/worker.js`.
`src/server.js` لسه شغّال زي ما هو للتجربة المحلية (`npm run dev`).

## اللي اتغيّر

| ملف | التغيير |
|-----|---------|
| `src/worker.js` | **جديد** — `export default { fetch }`، بيرجّع 200 فوراً والمعالجة في `ctx.waitUntil()` |
| `src/config.js` | شال `dotenv`. القيَم بتتحقن بـ `applyEnv(env)` — من bindings على Workers، ومن `.env` محلياً |
| `src/memory.js` | ذاكرة المحادثة بقت في **KV** (binding اسمه `MEMORY`, TTL 30 دقيقة). محلياً بترجع للرام تلقائياً. الدوال بقت `async` |
| `src/load-env.js` | **جديد** — بيحمّل `.env` لنقاط التشغيل المحلية بس |
| `wrangler.toml` | **جديد** |
| `catalog.js` / `gemini.js` / `whatsapp.js` | من غير تغيير (شغّالين على Workers زي ما هم) |

الكاش بتاع الكتالوج لسه في ذاكرة الـ isolate (مش KV) — كفاية لأول نسخة.

---

## الخطوات

كل الأوامر من داخل مجلد المشروع. الحزم متثبّتة خلاص (`npm install` اتعمل).

### 1) تسجيل الدخول

```bash
npx wrangler login
```

لو المتصفح فشل أو ظهر `Authentication failed` — استخدم API Token:

1. افتح https://dash.cloudflare.com/profile/api-tokens
2. **Create Token** ← قالب **Edit Cloudflare Workers** ← Continue ← Create Token ← انسخه
3. في نفس النافذة:

```bash
setx CLOUDFLARE_API_TOKEN "التوكن_هنا"
```

اقفل النافذة وافتح واحدة جديدة، وتأكد:

```bash
npx wrangler whoami
```

### 2) إنشاء مخزن الذاكرة (KV)

```bash
npx wrangler kv namespace create MEMORY
```

هيطبعلك سطر فيه `id = "..."`. افتح `wrangler.toml` وحُط الـ id ده مكان `REPLACE_WITH_KV_ID`.

### 3) المفاتيح السرّية

```bash
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put WHATSAPP_PHONE_NUMBER_ID
npx wrangler secret put WHATSAPP_TOKEN
```

- `GEMINI_API_KEY` — نفس المفتاح اللي في `.env`
- `WHATSAPP_PHONE_NUMBER_ID` و `WHATSAPP_TOKEN` — من Meta (لسه فاضيين في `.env` عندك)
- `INYAD_API_KEY` مش لازم — القيمة الافتراضية في الكود شغّالة. لو اتغيّرت: `npx wrangler secret put INYAD_API_KEY`

### 4) الرفع

```bash
npx wrangler deploy
```

هيطلعلك رابط زي:

```
https://quds-bot.<اسم-حسابك>.workers.dev
```

اختبار سريع:

```bash
curl https://quds-bot.<اسم-حسابك>.workers.dev/health
```

### 5) ربط webhook واتساب في Meta

في **Meta ← WhatsApp ← Configuration ← Webhook**:

- **Callback URL:** `https://quds-bot.<اسم-حسابك>.workers.dev/webhook`
- **Verify token:** `quds-bot-verify-123` (نفس اللي في `wrangler.toml` → `WHATSAPP_VERIFY_TOKEN`)
- بعد التحقق: فعّل الاشتراك في حقل **messages**

### 6) متابعة اللوجات

```bash
npx wrangler tail
```

---

## تجربة محلية للـ Worker (اختياري)

```bash
cp .dev.vars.example .dev.vars   # املأ المفاتيح جواه
npm run cf:dev
```

---

## نقاط انتبه لها

- **KV في الخطة المجانية:** 1000 كتابة / 100 ألف قراءة يومياً. كل رسالة عميل = كتابة واحدة. لو العدد كبر أو لاحظت البوت بيرد بسياق قديم أحياناً → انقل الذاكرة لـ D1.
- **10ms CPU لكل request (مجاني):** انتظار Gemini و Inyad مش بيتحسب. لو ظهرت أخطاء `Exceeded CPU` في `wrangler tail`، السبب غالباً تطبيع أسماء الـ 451 منتج وقت البحث المحلي — الحل وقتها تخزين نسخة (اسم + سعر، متطبّعة) في KV.
- **إعادة محاولات Gemini:** `src/gemini.js` ممكن يستنى لحد ~دقيقتين لو 429 اتكرر. شغّال جوه `waitUntil` فمش هيأثر على رد الـ webhook، بس لو ضايقك قلّل `retries` لـ 2.
- **Wrangler v3** هو المثبّت. فيه v4 لو حبيت تحدّث لاحقاً: `npm i -D wrangler@4`.
