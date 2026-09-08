# بوت واتساب — القدس لمهمات المصاعد 🛗

بوت يرد على العملاء على **واتساب**، يبحث في كتالوج المتجر الفعلي، ويجاوب بأسعار
المنتجات وحالة توافرها. الردود بتتولّد بـ **Google Gemini** (الطبقة المجانية).

- القناة: **WhatsApp Cloud API** (الرسمي من Meta)
- الذكاء: **Gemini** (`gemini-flash-lite-latest`) — بحث في المنتجات ثم صياغة الرد (نداء واحد لكل رسالة)
- مصدر المنتجات: API متجر Inyad/Mahaal —
  `https://api.inyad.com/storefront/items/filter`
- الاستضافة: مجانية على **Render** (أو Koyeb) — شغّال 24/7

---

## 1) إزاي البوت بيشتغل

```
عميل يبعت رسالة واتساب
        │
        ▼
Webhook ──► server.js ──► catalog.js يبحث في Inyad API عن المنتجات المتعلقة برسالة العميل
        │                          │
        │                          ▼
        │            Gemini يستقبل: (رسالة العميل + نتائج البحث + بيانات المحل)
        │                          │
        ◄──────── رد نصّي واحد ────┘
        ▼
البوت يبعت الرد للعميل على واتساب
```

- **نداء واحد لـ Gemini لكل رسالة** — البحث بيتعمل محلياً الأول، وبعدين النتائج بتتحقن
  في السياق (retrieval-augmented) بدل ما الموديل ينده أدوات. أوفر في الحصة المجانية وأسرع.
- كل عميل ليه ذاكرة محادثة قصيرة في الرام (آخر ~12 رسالة، بتُنسى بعد 30 دقيقة).
- كاش كامل للمنتجات بيتحدّث كل 5 دقايق (`CATALOG_TTL_SECONDS`) كخطة بديلة لو بحث الـ API فشل.
- البحث بيروح للـ API بكلمات العميل + بيعالج أخطاء الإملاء العربية (أ/ا، ة/ه، ى/ي، وتطابق تقريبي).
  لو مفيش نتيجة حقيقية بيرجّع فاضي والبوت بيقول "مش لاقي المنتج" بدل ما يخترع.

---

## 2) المتطلبات

| الحاجة | من فين |
|---|---|
| Node.js 18.17+ | https://nodejs.org (أو `winget install OpenJS.NodeJS.LTS`) |
| مفتاح Gemini | https://aistudio.google.com/apikey (مجاني) |
| WhatsApp Cloud API | https://developers.facebook.com — أنشئ App نوع *Business* وضيف منتج *WhatsApp* |

---

## 3) الإعداد المحلي (للتجربة)

```bash
npm install
copy .env.example .env      # على ويندوز
# عدّل .env وحط المفاتيح
```

### تجربة من غير واتساب

```bash
# لازم تكون حاطط GEMINI_API_KEY في .env
npm run chat
```

هيفتحلك محادثة في الترمينال — اسأل "سعر باب فورجيه" وشوف الرد.

### تنزيل كل المنتجات في ملف للمراجعة

```bash
npm run sync        # بيطلّع catalog-dump.json فيه كل المنتجات وأسعارها
```

### تشغيل السيرفر محلياً

```bash
npm start           # بيسمع على http://localhost:3000
```

---

## 4) رفع البوت على استضافة مجانية (Render)

الترتيب الصحيح: **ارفع البوت الأول** وخُد لينك الـ HTTPS، **وبعدين** اربط واتساب (قسم 5)،
لأن ربط الـ Webhook محتاج السيرفر يكون شغّال ومعاه دومين.

### 4-أ) ارفع الكود على GitHub

من مجلد المشروع:

```bash
git init
git add .
git commit -m "بوت واتساب - القدس لمهمات المصاعد"
```

بعدين اعمل ريبو جديد **Private** على https://github.com/new (سمّيه مثلاً `quds-bot`)
واتّبع سطرين الـ push اللي GitHub بيعرضهم:

```bash
git remote add origin https://github.com/<حسابك>/quds-bot.git
git branch -M main
git push -u origin main
```

> ملف `.env` مش هيترفع (متحطوط في `.gitignore`) — ده مقصود، المفاتيح بتتحط في Render مباشرة.

### 4-ب) اعمل Web Service على Render

1. ادخل https://render.com ← **Sign up** بحساب GitHub.
2. **New +** ← **Web Service** ← **Build and deploy from a Git repository** ← اختار ريبو `quds-bot`.
3. الإعدادات:
   | الحقل | القيمة |
   |---|---|
   | Name | `quds-bot` (هيبقى جزء من اللينك) |
   | Region | `Frankfurt` (الأقرب لمصر) |
   | Branch | `main` |
   | Runtime | `Node` |
   | Build Command | `npm install` |
   | Start Command | `node src/server.js` |
   | Instance Type | **Free** |
4. افتح **Advanced** ← **Add Environment Variable** وضيف دول واحد واحد:
   | Key | Value |
   |---|---|
   | `GEMINI_API_KEY` | مفتاح Gemini بتاعك |
   | `GEMINI_MODEL` | `gemini-flash-lite-latest` |
   | `WHATSAPP_PHONE_NUMBER_ID` | (هتجيبه من قسم 5) — سيبه فاضي دلوقتي أو حط `x` مؤقتاً |
   | `WHATSAPP_TOKEN` | (من قسم 5) |
   | `WHATSAPP_VERIFY_TOKEN` | اختار نص سرّي من عندك، مثلاً `quds-verify-9f3k2` — **احفظه** |
   | `STORE_SLUG` | `httpsgcokgspyk1uqu` |
   | `INYAD_API_KEY` | `yhLyRgMw!5je4pN*jrx6` |
5. **Create Web Service**. استنى 2-3 دقايق لحد ما الحالة تبقى **Live**.
6. فوق هتلاقي اللينك: `https://quds-bot.onrender.com` (اسمك ممكن يختلف).
7. **اختبر:** افتح `https://quds-bot.onrender.com/health` في المتصفح —
   المفروض يرجّع `{"ok":true,"catalog":{"count":451,...}}`.

### 4-ج) امنع البوت من "النوم" (مهم في الخطة المجانية)

خطة Render المجانية **بتوقف السيرفر بعد 15 دقيقة بدون طلبات**، وأول رسالة بعدها
بتتأخر ~50 ثانية (ممكن واتساب يعتبرها فشلت). الحل: خلّي حاجة تفتح `/health` كل 10 دقايق.

1. ادخل https://cron-job.org ← اعمل حساب مجاني.
2. **Create cronjob**:
   - Title: `keep quds-bot awake`
   - URL: `https://quds-bot.onrender.com/health`
   - Schedule: **Every 10 minutes**
3. Save. كده البوت هيفضل صاحي طول الوقت.

### بديل بدون "نوم": Koyeb

لو مش عايز حكاية الـ pinger: https://koyeb.com فيه خطة **Free** (خدمة واحدة، بتفضل شغّالة
من غير توقف). نفس الخطوات: **Create Service → GitHub → اختر الريبو → Instance: Free →
Build: `npm install` → Run: `node src/server.js` → ضيف نفس الـ Environment Variables →
Port: `3000`**. اللينك بيبقى `https://<اسم-الخدمة>-<حسابك>.koyeb.app`.

### بديل: Docker على VPS

```bash
docker build -t quds-bot .
docker run -d --env-file .env -p 3000:3000 --restart unless-stopped quds-bot
```
لازم Nginx + شهادة SSL قدامه لأن Webhook واتساب بيتطلب HTTPS.

---

## 5) ربط WhatsApp Cloud API (خطوة بخطوة)

### 5-أ) اعمل تطبيق Meta

1. لازم يكون عندك حساب فيسبوك عادي + حساب **Meta Business**
   (اعمله من https://business.facebook.com لو معندكش).
2. ادخل https://developers.facebook.com ← من فوق **My Apps** ← **Create App**.
3. *"What do you want to do?"* ← اختار **Other** ← **Next**.
4. نوع التطبيق ← **Business** ← **Next**.
5. الاسم: `Quds Bot` ← اختر الـ Business account بتاعك ← **Create app**
   (ممكن يطلب باسورد فيسبوك).

### 5-ب) ضيف منتج WhatsApp

1. جوه لوحة التطبيق ← تحت *"Add products to your app"* ← دوّر على **WhatsApp** ← **Set up**.
2. هيسألك تختار Business account ← اختاره ← **Continue**.
3. دلوقتي Meta بتعملّك تلقائياً: **رقم تجربة** + حساب WhatsApp تجريبي + **توكن مؤقت** (24 ساعة).

### 5-ج) هات بيانات الاختبار

من صفحة **WhatsApp → API Setup**:

- **From** = الرقم التجريبي، وتحته **Phone number ID** — انسخه ← ده `WHATSAPP_PHONE_NUMBER_ID`.
- **Temporary access token** — انسخه ← ده `WHATSAPP_TOKEN` مؤقتاً للتجربة.
- تحت **To** ← **Add recipient** ← حط رقم موبايلك (اللي عليه واتساب) ← هيجيلك كود ← أكّده.
  (الخطة التجريبية بترد على **5 أرقام** بس اللي بتضيفهم هنا).
- اضغط **Send message** وتأكد إن رسالة الـ "hello_world" وصلتك على واتساب.

حدّث القيمتين دول في **Render → Environment** ← احفظ ← البوت هيعيد التشغيل لوحده.

### 5-د) اربط الـ Webhook

1. في لوحة التطبيق ← **WhatsApp → Configuration**.
2. جنب **Webhook** ← **Edit**:
   - **Callback URL**: `https://quds-bot.onrender.com/webhook`
     (لينك Render بتاعك + `/webhook` في الآخر).
   - **Verify token**: نفس اللي حطيته في `WHATSAPP_VERIFY_TOKEN` بالظبط.
3. **Verify and save** — لو ظهر ✅ يبقى تمام (لو فشل: اتأكد إن `/health` شغّال وإن التوكن مطابق).
4. تحت **Webhook fields** ← جنب **messages** ← **Subscribe**.

### 5-هـ) جرّب البوت الحقيقي

ابعت من موبايلك (الرقم اللي ضفته في *To*) رسالة واتساب للرقم التجريبي:
> بكام باب فورجيه تركي؟

المفروض يرد عليك البوت بالأسعار خلال ثواني. تقدر تتابع الـ logs من
**Render → Logs**.

### 5-و) التوكن الدائم (قبل ما تشغّل رسمي)

التوكن المؤقت بيموت بعد 24 ساعة. للتوكن اللي **مايموتش**:

1. https://business.facebook.com ← **Business settings** (الترس).
2. **Users → System users** ← **Add** ← الاسم `bot-system-user`، الدور **Admin** ← **Create**.
3. اختاره ← **Assign assets** ← **Apps** ← علّم على تطبيق `Quds Bot` ← فعّل **Full control** ← **Save**.
4. **Generate new token** ← اختر تطبيق `Quds Bot`:
   - **Token expiration**: **Never**
   - **Permissions**: علّم على `whatsapp_business_messaging` و `whatsapp_business_management`
5. **Generate token** ← انسخه (مش هيتعرض تاني) ← حطّه في **Render → Environment →
   `WHATSAPP_TOKEN`** ← احفظ.

### 5-ز) ربط رقم المحل الحقيقي (لما تكون جاهز)

الرقم التجريبي بيرد على 5 أرقام بس. عشان تفتح للعملاء كلهم:

1. **WhatsApp → API Setup** ← **Add phone number**.
2. اكتب اسم العرض (مثلاً "القدس لمهمات المصاعد") ورقم تليفون **مش مفعّل حالياً على
   تطبيق واتساب أو واتساب بيزنس** (لو مفعّل، لازم تحذفه من التطبيق الأول).
3. أكّد الرقم بكود SMS أو مكالمة.
4. بعد ما يتفعّل: انسخ **Phone number ID** بتاعه وحطه مكان القديم في `WHATSAPP_PHONE_NUMBER_ID`.
5. في الأول بيكون عندك حد **1000 محادثة/24 ساعة**؛ بيزيد تلقائياً مع الاستخدام، أو بعد ما
   تعمل **Business Verification** للـ Business account.

---

## 6) المتغيّرات (.env)

| المتغير | الشرح |
|---|---|
| `GEMINI_API_KEY` | مفتاح Google AI Studio |
| `GEMINI_MODEL` | `gemini-flash-lite-latest` (افتراضي). بديل أجود: `gemini-flash-latest` |
| `WHATSAPP_PHONE_NUMBER_ID` | من صفحة API Setup في Meta |
| `WHATSAPP_TOKEN` | التوكن الدائم (System User) |
| `WHATSAPP_VERIFY_TOKEN` | نص من اختيارك، نفسه في Meta |
| `WHATSAPP_GRAPH_VERSION` | `v21.0` (افتراضي) |
| `STORE_SLUG` | `httpsgcokgspyk1uqu` (الساب-دومين بتاع المتجر) |
| `INYAD_API_BASE` | `https://api.inyad.com/storefront` |
| `INYAD_API_KEY` | مفتاح الـ storefront العام الموجود في كود الموقع |
| `CATALOG_TTL_SECONDS` | مدة كاش المنتجات بالثواني (افتراضي 300) |
| `PORT` | البورت (افتراضي 3000) |
| `ENABLE_DEBUG_CHAT` | `1` عشان يفعّل `POST /debug/chat` للتجربة |

---

## 7) ملفات المشروع

```
src/
  server.js     ← Express + Webhook واتساب + توزيع الرسائل
  gemini.js     ← بناء السياق (منتجات + بيانات المحل) + نداء Gemini + شخصية البوت + retry
  catalog.js    ← جلب/بحث/كاش منتجات Inyad API
  whatsapp.js   ← إرسال رسائل + قراءة جسم الـ Webhook
  memory.js     ← ذاكرة محادثة في الرام لكل عميل
  config.js     ← قراءة .env + بيانات المتجر الثابتة
scripts/
  test-cli.js   ← تجربة في الترمينال (npm run chat)
  sync-catalog.js ← تنزيل كل المنتجات (npm run sync)
```

---

## 8) تخصيص شخصية البوت

عدّل `SYSTEM_PROMPT` في [`src/gemini.js`](src/gemini.js) — فيه الأسلوب،
القواعد، وإزاي يتصرّف لو المنتج مش موجود أو غير متوفر.

بيانات المحل (عنوان/تليفون/مواعيد) في [`src/config.js`](src/config.js) تحت `store`.

---

## 9) ملاحظات وحدود

- **الذاكرة في الرام**: أي إعادة تشغيل بتمسح محادثات العملاء. لو محتاج تثبيت،
  استبدل `memory.js` بـ Redis.
- **مفتاح Inyad**: ده مفتاح عام مدفون في كود موقع المتجر، بيسمح بالقراءة بس.
  لو المتجر غيّره هتحتاج تجيب الجديد من الموقع.
- **حدود Gemini المجانية**: بتختلف حسب الموديل — `gemini-flash-lite-latest` من أوسعها
  (حوالي 15 طلب/دقيقة). التصميم بيستهلك **طلب واحد بس لكل رسالة عميل**، فمتجر صغير/متوسط
  مش هيوصل للحد. لو زاد الضغط: فعّل الفوترة في Google AI Studio أو غيّر الموديل.
- الأكواد بتعمل retry تلقائي (مع backoff) لو رجع خطأ 429/503 مؤقت.
- البوت بيرد على **الرسائل النصية** وأزرار القوائم. الصور/الصوت بيرد عليها برسالة
  إرشادية إنه يبعت اسم المنتج مكتوب.
