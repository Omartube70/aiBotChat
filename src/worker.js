/**
 * نقطة تشغيل Cloudflare Workers.
 *  - بيرد على تحقّق الـ webhook فوراً.
 *  - رسائل واتساب: بيرجّع 200 على طول، والمعالجة (بحث + Gemini + رد)
 *    بتكمّل في ctx.waitUntil() عشان Meta ما تعيدش إرسال نفس الرسالة.
 *
 * محلياً استخدم src/server.js (Express). الملف ده للـ Workers بس.
 */
import { config, applyEnv } from './config.js';
import {
  generateReply,
  transcribeAudio,
  identifyImage,
  extractOrder,
  extractOfferFields,
  extractDiscount,
  findElevatorCompanies,
  findContractors,
  debugGemini,
  listModels,
} from './gemini.js';
import {
  sendText,
  markRead,
  parseIncoming,
  fetchMedia,
  uploadMedia,
  sendAudio,
  sendImage,
  sendLocation,
  sendDocument,
  sendContact,
  sendFlow,
  sendButtons,
} from './whatsapp.js';
import { setupFlows, getFlowIds, MACHINE_TITLES } from './flows.js';
import { withD1 } from './d1kv.js';
import { parseInventoryXlsx, saveInventory, getInventory, findQty, inventoryTotals } from './inventory.js';
import {
  getHistory,
  saveHistory,
  resetHistory,
  getPref,
  setPref,
  getMode,
  setMode,
  setLastHandoff,
  getLastHandoff,
  isBotEnabled,
  setBotEnabled,
  setReplyTarget,
  getReplyTarget,
  recordCustomer,
  recordSupplier,
  getCustomerList,
  getSupplierList,
} from './memory.js';
import { catalogStats, searchProducts, stockSummary } from './catalog.js';
import { synthesize } from './tts.js';
import { computeInvoice, buildInvoiceXlsx } from './invoice.js';
import { syncGoogleContacts, getContactInfo, startConnect, finishConnect } from './contacts.js';
import { noteError, noteFailedStatuses, flushDiag, diagPage, maskPhone } from './diag.js';
import { sendMessengerText, parseMessengerIncoming } from './messenger.js';
import { setEnvRef as setPriceEnvRef, setOverride, clearOverride } from './priceOverrides.js';
import { normalizeAr } from './catalog.js';
import { handlePayroll } from './payroll.js';
import { handleStaffCalc } from './calc.js';
import {
  OFFER_LABELS,
  mergeOffer,
  missingOfferFields,
  completeOffer,
  buildOfferDocx,
  offerSummary,
  cairoDate,
} from './offer.js';
// قالب عرض تركيب المصعد (Word) — بيتحمّل كـ ArrayBuffer عن طريق [[rules]] في wrangler.toml
import offerTemplate from './templates/offer-template.docx';

/** يبعت رد للعميل أيًا كانت منصّته — واتساب برقمه العادي، أو ماسنجر بـ fb:<psid>. */
function sendToUser(target, body, env) {
  if (typeof target === 'string' && target.startsWith('fb:')) {
    return sendMessengerText(target.slice(3), body);
  }
  return sendText(target, body);
}

// منع معالجة نفس الرسالة مرتين داخل نفس الـ isolate (Meta بتعيد الإرسال أحياناً).
// ملاحظة: الحماية دي per-isolate مش عامة — لو محتاج ضمان أقوى استخدم KV.
const seen = new Set();
function alreadyHandled(id) {
  if (!id) return false;
  if (seen.has(id)) return true;
  seen.add(id);
  if (seen.size > 2000) seen.clear();
  return false;
}

export default {
  async fetch(request, env, ctx) {
    env = withD1(env); // الحالة في D1 (متسقة فورًا) بدل KV
    applyEnv(env); // رخيص و idempotent — بنعمله كل request
    setPriceEnvRef(env);
    const url = new URL(request.url);
    const { pathname } = url;
    const { method } = request;

    /* ---------- فحص صحة الخدمة ---------- */
    if (method === 'GET' && pathname === '/') {
      return new Response('QUDS WhatsApp bot ✅');
    }

    // سياسة الخصوصية (ميتا بتطلب رابط ليها في إعدادات التطبيق)
    if (method === 'GET' && pathname === '/privacy') {
      return new Response(PRIVACY_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
    }

    // ربط جهات اتصال جوجل من المتصفح: افتح /google/connect ووافق بحساب المحل
    if (method === 'GET' && (pathname === '/oauth/start' || pathname === '/google/connect')) {
      return startConnect(url, env);
    }
    if (method === 'GET' && (pathname === '/oauth/callback' || pathname === '/google/callback')) {
      return finishConnect(url, env);
    }

    if (method === 'GET' && pathname === '/health') {
      try {
        const stats = await catalogStats();
        return Response.json({ ok: true, catalog: stats });
      } catch (err) {
        return Response.json({ ok: true, catalog: 'غير محمّل بعد', error: err.message });
      }
    }

    /* ---------- تحقّق الـ Webhook (Meta) ---------- */
    if (method === 'GET' && pathname === '/webhook') {
      const mode = url.searchParams.get('hub.mode');
      const token = url.searchParams.get('hub.verify_token');
      const challenge = url.searchParams.get('hub.challenge');
      if (mode === 'subscribe' && token === config.whatsapp.verifyToken) {
        console.log('[webhook] تم التحقق ✅');
        return new Response(challenge ?? '', { status: 200 });
      }
      return new Response('Forbidden', { status: 403 });
    }

    /* ---------- تجربة بدون واتساب ---------- */
    // مفعّل فقط لما env.ENABLE_DEBUG_CHAT === '1'
    //   GET  /debug/chat?text=سعر باب فورجيه
    //   POST /debug/chat   { "text": "...", "user": "test1" }
    if (pathname === '/debug/chat' && env.ENABLE_DEBUG_CHAT === '1') {
      let text = url.searchParams.get('text') || '';
      let user = url.searchParams.get('user') || 'debug';
      if (method === 'POST') {
        try {
          const b = await request.json();
          text = b?.text || text;
          user = b?.user || user;
        } catch {
          /* نكمّل بالـ query params */
        }
      }
      if (!text) {
        return Response.json({ error: 'ابعت ?text=رسالتك' }, { status: 400 });
      }
      try {
        const history = await getHistory(user, env);
        const out = await generateReply(text, history);
        await saveHistory(user, out.history, env);
        return Response.json({ reply: out.reply });
      } catch (err) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // اختبار إن الحالة بتتقري فورًا بعد الكتابة (D1) + إن بيانات KV القديمة لسه بتتقري
    if (pathname === '/debug/state-test' && env.ENABLE_DEBUG_CHAT === '1') {
      try {
        const out = [];
        for (let i = 1; i <= 5; i++) {
          await env.MEMORY.put('debug:rw', String(i), { expirationTtl: 60 });
          out.push((await env.MEMORY.get('debug:rw')) === String(i));
        }
        await env.MEMORY.delete('debug:rw');
        return Response.json({
          d1: !!env.__d1,
          readAfterWrite: out,
          afterDelete: await env.MEMORY.get('debug:rw'),
          legacyCustNum: await env.MEMORY.get('custnum:201000278824'),
        });
      } catch (err) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    // سجل التشخيص: رسايل وصلت + مشاكل إرسال واتساب (من الموبايل)
    if (method === 'GET' && pathname === '/debug/log' && env.ENABLE_DEBUG_CHAT === '1') {
      return diagPage(env);
    }

    //   GET /debug/gemini?model=...&text=...&gen={...}  → وقت الرد لموديل معيّن
    if (pathname === '/debug/gemini' && env.ENABLE_DEBUG_CHAT === '1') {
      let gen = {};
      try {
        gen = JSON.parse(url.searchParams.get('gen') || '{}');
      } catch {
        /* gen غلط — نكمّل من غيره */
      }
      const model = url.searchParams.get('model') || config.gemini.model;
      const text = url.searchParams.get('text') || 'بكام الباب الفورجيه؟ رد في سطر واحد.';
      return Response.json(await debugGemini(text, model, gen));
    }
    if (pathname === '/debug/models' && env.ENABLE_DEBUG_CHAT === '1') {
      return Response.json(await listModels());
    }
    //   POST /debug/voice (جسم الطلب = ملف صوت) → النص المفرّغ
    if (method === 'POST' && pathname === '/debug/voice' && env.ENABLE_DEBUG_CHAT === '1') {
      const t0 = Date.now();
      try {
        const buf = await request.arrayBuffer();
        const mime = request.headers.get('content-type') || 'audio/ogg';
        const text = await transcribeAudio(buf, mime);
        return Response.json({ text, bytes: buf.byteLength, ms: Date.now() - t0 });
      } catch (err) {
        return Response.json({ error: err.message, ms: Date.now() - t0 }, { status: 500 });
      }
    }

    if (pathname === '/debug/search' && env.ENABLE_DEBUG_CHAT === '1') {
      const q = url.searchParams.get('q') || '';
      try {
        return Response.json({ q, results: await searchProducts(q, 8) });
      } catch (err) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    /* ---------- تجهيز فورمات WhatsApp Flows (مرة واحدة) — محمي بمفتاح SETUP_KEY ---------- */
    if (method === 'POST' && pathname === '/admin/setup-flows') {
      if (!env.SETUP_KEY || request.headers.get('x-setup-key') !== env.SETUP_KEY) {
        return new Response('Forbidden', { status: 403 });
      }
      try {
        return Response.json({ ok: true, ...(await setupFlows(env)) });
      } catch (err) {
        return Response.json({ ok: false, error: err.message }, { status: 500 });
      }
    }

    /* ---------- رفع ملف جرد إنياد (Excel) — محمي بمفتاح SETUP_KEY ---------- */
    if (method === 'POST' && pathname === '/admin/inventory') {
      if (!env.SETUP_KEY || request.headers.get('x-setup-key') !== env.SETUP_KEY) {
        return new Response('Forbidden', { status: 403 });
      }
      try {
        const t0 = Date.now();
        const inv = parseInventoryXlsx(new Uint8Array(await request.arrayBuffer()));
        await saveInventory(env, inv);
        return Response.json({ ok: true, ms: Date.now() - t0, date: inv.date, ...inventoryTotals(inv) });
      } catch (err) {
        return Response.json({ ok: false, error: err.message }, { status: 500 });
      }
    }

    /* ---------- استقبال الرسائل ---------- */
    if (method === 'POST' && pathname === '/webhook') {
      // زرار إيقاف مؤقت: BOT_ENABLED=0 في wrangler.toml (أو secret) يوقف الردود تمامًا
      // من غير ما يلغي التحقق ولا الاشتراك — رجّعها 1 أو شيلها وانشر تاني عشان يرجع يشتغل.
      if (config.botEnabled === false) {
        return new Response('OK (bot disabled)', { status: 200 });
      }

      let body = {};
      try {
        body = await request.json();
      } catch {
        /* جسم فاضي أو مش JSON — نتجاهله */
      }

      const messages = parseIncoming(body);
      noteFailedStatuses(body);
      ctx.waitUntil(
        (async () => {
          for (const msg of messages) {
            if (alreadyHandled(msg.id)) continue;
            try {
              await handleMessage(msg, env);
            } catch (err) {
              console.error('[handleMessage] خطأ:', err);
              noteError(`[handleMessage] ${err.message}`);
            }
          }
          const incoming = messages.map((m) => `${maskPhone(m.from)} (${m.type})`).join('، ');
          await flushDiag(env, incoming);
        })(),
      );

      return new Response('OK', { status: 200 });
    }

    /* ---------- تحقّق webhook الماسنجر (Meta) ---------- */
    if (method === 'GET' && pathname === '/webhook/messenger') {
      const mode = url.searchParams.get('hub.mode');
      const token = url.searchParams.get('hub.verify_token');
      const challenge = url.searchParams.get('hub.challenge');
      if (mode === 'subscribe' && token === config.facebook.verifyToken) {
        console.log('[messenger] تم التحقق ✅');
        return new Response(challenge ?? '', { status: 200 });
      }
      return new Response('Forbidden', { status: 403 });
    }

    /* ---------- استقبال رسائل الماسنجر ---------- */
    if (method === 'POST' && pathname === '/webhook/messenger') {
      if (config.botEnabled === false) return new Response('OK (bot disabled)', { status: 200 });
      let body = {};
      try {
        body = await request.json();
      } catch {
        /* تجاهل */
      }
      const messages = parseMessengerIncoming(body);
      ctx.waitUntil(
        (async () => {
          for (const m of messages) {
            if (alreadyHandled(`fb:${m.id}`)) continue;
            try {
              await handleMessengerMessage(m.psid, m.text, env);
            } catch (err) {
              console.error('[handleMessengerMessage] خطأ:', err);
            }
          }
        })(),
      );
      return new Response('EVENT_RECEIVED', { status: 200 });
    }

    /* ---------- مزامنة يدوية لأسماء جوجل (لو محتاج تشغّلها بإيدك) ---------- */
    if (pathname === '/debug/sync-contacts' && env.ENABLE_DEBUG_CHAT === '1') {
      try {
        const count = await syncGoogleContacts(env);
        return Response.json({ ok: true, contacts: count });
      } catch (err) {
        return Response.json({ ok: false, error: err.message }, { status: 500 });
      }
    }

    return new Response('Not found', { status: 404 });
  },

  /** مزامنة تلقائية لأسماء جوجل — شوف [triggers] crons في wrangler.toml. */
  async scheduled(event, env, ctx) {
    env = withD1(env);
    applyEnv(env);
    setPriceEnvRef(env);
    ctx.waitUntil(
      syncGoogleContacts(env)
        .then((count) => console.log(`[contacts-sync] تمت المزامنة: ${count} اسم`))
        .catch((err) => console.error('[contacts-sync] خطأ:', err.message)),
    );
    ctx.waitUntil(remindStaffWindow(env).catch((err) => console.error('[remind] خطأ:', err.message)));
  },
};

/* ---------- تذكير أرقام الموظفين قبل ما نافذة الـ 24 ساعة تقفل ---------- */
// واتساب مش بيسمح للبوت يبعت لرقم ماكلّمهوش آخر 24 ساعة (code 131047) — فنسخ رسايل
// الزباين بتقف. قبل ما المدة تخلص بساعتين بنفكّر الموظف يرد بأي كلمة عشان تتجدد.
const lastInKey = (n) => `staff:lastin:${n}`;
const remindKey = (n) => `staff:reminded:${n}`;
const HOUR = 3600 * 1000;
const REMIND_TEXT =
  '⏰ رد بأي كلمة (زي: تمام) عشان نسخ رسايل الزباين تفضل توصلك 24 ساعة كمان.\n' +
  'لو مارديتش، واتساب هيوقف النسخ لحد ما تبعت أي رسالة.';

/** بيتنده من الـ cron كل نص ساعة. */
async function remindStaffWindow(env) {
  const kv = env?.MEMORY;
  if (!kv) return;
  for (const n of config.agent.ccNumbers) {
    const last = Number(await kv.get(lastInKey(n)));
    if (!last) continue;
    const age = Date.now() - last;
    // بين 21.5 و 23.5 ساعة — الـ cron كل 30 دقيقة فبيقع مرة جوه الفترة دي
    if (age < 21.5 * HOUR || age > 23.5 * HOUR) continue;
    if ((await kv.get(remindKey(n))) === String(last)) continue; // اتفكّر خلاص للمدة دي
    if (await sendText(n, REMIND_TEXT)) {
      await kv.put(remindKey(n), String(last), { expirationTtl: 2 * 24 * 3600 });
      console.log(`[remind] ${n}`);
    }
  }
}

const MAX_AUDIO_BYTES = 3 * 1024 * 1024; // فوق كده تفريغ الـ base64 ممكن يعدّي حد الـ CPU
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

const PRIVACY_HTML = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Privacy Policy - Quds Bot</title>
<body style="font-family:sans-serif;max-width:720px;margin:auto;padding:24px;line-height:1.7">
<h2 dir="rtl">سياسة الخصوصية - بوت القدس لمهمات المصاعد</h2>
<p dir="rtl">البوت ده بيرد على عملاء محل القدس لمهمات المصاعد (الجيزة) على واتساب بالأسعار والمنتجات.
البوت بيقرا أسماء وأرقام جهات الاتصال من حساب جوجل الخاص بالمحل بس، عشان ينادي العميل باسمه.
البيانات دي بتتحفظ عند المحل ومبتتشاركش ولا بتتباع لأي حد.</p>
<h2>Privacy Policy - Quds Elevator Supplies Bot</h2>
<p>This WhatsApp bot answers customers of Quds Elevator Supplies (Giza, Egypt) with product prices.
It reads contact names and phone numbers (read-only) from the shop's own Google account only, to greet
customers by name. This data is stored privately by the shop and is never shared or sold.
Contact: toppowerelevators4@gmail.com</p>
</body>`;

// ألقاب محفوظة في جهات الاتصال ("حاج سيد"، "م/ علي") — بنسيبها زي ما هي (من البوت القديم)
const TITLE_RE = /^(أستاذ|استاذ|أستاذة|استاذة|أ\/|ا\/|حاج|الحاج|حجة|الحاجة|مهندس|م\/|م\.|دكتور|د\/|د\.|شيخ|الشيخ|مدام|أ\.)/;

/**
 * اسم الترحيب من اسم جوجل/واتساب: "حاج سيد محمود" → "حاج سيد"، "محمد علي" → "أستاذ محمد"،
 * أو null لو مش اسم (إيموجي/أرقام).
 */
function politeName(name) {
  const words = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  if (TITLE_RE.test(words[0])) {
    const titled = words.slice(0, 2).join(' ');
    return /\p{L}{2,}/u.test(titled) ? titled : null;
  }
  return /^\p{L}{2,}$/u.test(words[0]) ? `أستاذ ${words[0]}` : null;
}

/**
 * يضمن إن أول رد فيه "أهلاً يا <الاسم> 👋" (أو "أهلاً بحضرتك 👋" لو مفيش اسم).
 * لو Gemini كتب ترحيب عام من غير الاسم، بنشيله ونحط ترحيب بالاسم مكانه.
 */
function withGreeting(reply, name) {
  const greet = name ? `أهلاً يا ${name} 👋` : 'أهلاً بحضرتك 👋';
  const head = reply.slice(0, 100);
  // الترحيب لازم يبقى بالظبط "أهلاً يا <اللقب + الاسم>" — مش كفاية الاسم لوحده ("يا محمد")
  if (name ? /أهلا|اهلا/.test(head) && head.includes(`يا ${name}`) : /أهلا|اهلا|مرحب/.test(head)) return reply;
  // بنشيل جملة الترحيب اللي Gemini كتبها (لحد أول فاصلة/سطر) ونحط الترحيب الصح مكانها
  const salam = /^\s*(?:و\s*)?عليكم السلام/.test(reply);
  const rest = reply
    .replace(/^\s*(?:(?:و\s*)?عليكم السلام|أهلاً|أهلا|اهلا|اهلاً|مرحبا|مرحباً|يا هلا)[^\n،,.!؟]*[،,.!؟]?\s*/, '')
    .trim();
  return `${salam ? 'وعليكم السلام، ' : ''}${greet}\n${rest}`;
}

/** الرد فيه أرقام (أسعار/أكواد منتجات) تستاهل تتبعت مكتوبة بعد الصوت؟ */
function hasPricesOrCodes(text) {
  return /[0-9٠-٩]{2,}|ج\.?\s?م|جنيه|[A-Za-z]+[-_]?[0-9]+/.test(String(text));
}

/**
 * هل العميل طلب يغيّر نوع الرد؟
 * @returns {'voice'|'text'|'auto'|null}
 */
function detectReplyModeChange(text) {
  const s =
    ' ' +
    String(text)
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .toLowerCase() +
    ' ';
  const has = (...w) => w.some((x) => s.includes(x));

  if (has('رد عادي', 'زي ما تحب', 'الغاء الصوت', 'رجعنا عادي')) return 'auto';
  if (has('بلاش صوت', 'مش عايز صوت', 'من غير صوت', 'بطل صوت', 'مفيش صوت')) return 'text';

  const askReply = has(
    'رد', 'ردود', 'ردي', 'جاوب', 'كلمني', 'ابعت', 'ابعتلي',
    'عايز', 'عاوز', 'محتاج', 'ممكن', 'please', 'reply',
  );
  const voiceWord = has('صوت', 'فويس', 'voice', 'audio');
  const textWord = has(
    'نص', 'كتابه', 'كتابة', 'مكتوب', 'اكتبلي', 'اكتب', 'رسايل', 'text', 'message',
  );
  if (askReply && voiceWord && !textWord) return 'voice';
  if (askReply && textWord && !voiceWord) return 'text';
  return null;
}

async function handleMessage(msg, env) {
  const { from, id, type } = msg;
  let text = msg.text;
  if (!from) return;

  // أي رسالة من رقم متابعة بتجدد نافذة الـ 24 ساعة → نسجّل وقتها للتذكير
  if (config.agent.ccNumbers.includes(from)) {
    await env.MEMORY?.put(lastInKey(from), String(Date.now()), { expirationTtl: 3 * 24 * 3600 });
  }

  // رد فورم (WhatsApp Flow): عميل ملا بيانات عرض التركيب، أو موظف كتب السعر
  if (msg.flow) {
    await handleFlowReply(msg, env);
    return;
  }

  // رسالة من موظف (مدير/حسابات) → توجيه ردّه للعميل (أو أمر تشغيل/إيقاف البوت)
  if (agentNumbers().includes(from)) {
    // ملف جرد Excel من المدير → نحدّث الكميات
    if (msg.document && config.agent.admins.includes(from)) {
      await handleInventoryUpload(from, msg.document, env);
      return;
    }
    await handleAgentMessage(from, text, env, msg.contextId);
    return;
  }

  // البوت متوقف مؤقتًا بأمر من الإدارة عبر واتساب — يسكت تمامًا مع العملاء
  if (!(await isBotEnabled(env))) return;

  await markRead(id);

  // رسالة صوتية → ننزّلها ونفرّغها لنص، وبعدها تكمّل عادي
  if (type === 'audio' && msg.audio?.id) {
    try {
      const media = await fetchMedia(msg.audio.id);
      if (!media) throw new Error('تعذّر تنزيل الملف الصوتي');
      if (media.size > MAX_AUDIO_BYTES) {
        await sendText(
          from,
          'الرسالة الصوتية طويلة شوية 🙏 ابعتها أقصر، أو اكتبلي اسم المنتج.',
        );
        return;
      }
      text = await transcribeAudio(media.buffer, media.mimeType || msg.audio.mimeType);
      console.log(`[voice] ${from}: ${text}`);
      if (!text) {
        await sendText(
          from,
          'معلش مش قادر أفهم الرسالة الصوتية 🙏 جرّب تبعتها تاني أو اكتبلي اسم المنتج.',
        );
        return;
      }
    } catch (err) {
      console.error('[voice] خطأ:', err.message);
      noteError(`[voice] ${err.message}`);
      await sendText(
        from,
        'حصلت مشكلة في تحويل الصوت لنص. اكتبلي اسم المنتج من فضلك 🙏',
      );
      return;
    }
  }

  // صورة منتج → نتعرّف عليها ونحوّلها لجملة بحث، وبعدها تكمّل عادي
  if (type === 'image' && msg.image?.id) {
    try {
      const media = await fetchMedia(msg.image.id);
      if (!media) throw new Error('تعذّر تنزيل الصورة');
      if (media.size > MAX_IMAGE_BYTES) {
        await sendText(from, 'الصورة كبيرة شوية 🙏 ابعت صورة أصغر، أو اكتبلي اسم المنتج.');
        return;
      }
      const desc = await identifyImage(media.buffer, media.mimeType || msg.image.mimeType);
      console.log(`[image] ${from}: ${desc}`);
      if (!desc) {
        await sendText(
          from,
          'معلش مش قادر أتعرّف على المنتج من الصورة 🙏 اكتبلي اسمه أو ابعت صورة أوضح.',
        );
        return;
      }
      // لو العميل كتب كابشن مع الصورة، نضمّه لجملة البحث
      text = text ? `${desc} — ${text}` : desc;
    } catch (err) {
      console.error('[image] خطأ:', err.message);
      await sendText(from, 'حصلت مشكلة في تحليل الصورة. اكتبلي اسم المنتج من فضلك 🙏');
      return;
    }
  }

  if (!text) {
    await sendText(
      from,
      'أهلاً بيك 👋 ابعتلنا اسم المنتج اللي محتاج تعرف سعره، وهنرد عليك على طول.',
    );
    return;
  }

  // اسم العميل المسجّل عند صاحب المحل في جوجل (أدق من اسم بروفايل واتساب)
  const contact = await getContactInfo(from, env);
  const displayName = contact?.name || msg.name || null;
  const custNum = await customerNum(from, env);
  const who = `${custNum ? `زبون ${custNum} — ` : ''}${displayName ? displayName + ' ' : ''}${from}`;

  // تسجيله في قائمة "آخر العملاء" (تُستعرض بأمر "العملاء" من واتساب)
  recordCustomer(from, displayName, text, env).catch(() => {});

  // نسخة من رسالة العميل لأرقام المتابعة (fire-and-forget)
  ccStaff(`👤 ${who}\n${text}`, from, env);
  // وصورته لو متسجله في جوجل — عشان الإدارة تتعرف عليه بسرعة
  if (contact?.photo) {
    for (const n of config.agent.ccNumbers) {
      if (n && n !== from) sendImage(n, contact.photo, `صورة ${displayName || from}`).catch(() => {});
    }
  }

  // العميل متحوّل لموظف → ننقل رسالته له والبوت ساكت
  let mode = await getMode(from, env);
  // طلب تركيب أو صيانة → البوت يمسكه على طول (يبعتله البنود) حتى لو كان متحوّل لموظف
  if (mode && mode !== 'bot' && (wantsElevatorQuote(text) || wantsMaintenance(text))) {
    await setMode(from, env, 'bot');
    mode = 'bot';
  }
  if (mode && mode !== 'bot') {
    // العميل نفسه يقدر يرجع للبوت في أي وقت (بدل ما يفضل عالق لو اتحوّل بالغلط)
    if (wantsBackToBot(text)) {
      await setMode(from, env, 'bot');
      await sendToUser(from, 'تمام، رجعنا لخدمة الأسئلة والأسعار 👍 اسأل عن أي منتج.', env);
      console.log(`[human-exit] ${from}`);
      return;
    }
    await setMode(from, env, mode, config.agent.handoffTtl); // تجديد المهلة
    await setLastHandoff(mode, from, env, config.agent.handoffTtl);
    const relayId = await sendText(mode, `💬 ${who}:\n${text}`);
    if (relayId) await setReplyTarget(relayId, from, env, config.agent.handoffTtl);
    console.log(`[human:${mode}] ${from}: ${text}`);
    return;
  }

  // صيانة/شهرية → نسأل عن المنطقة (الصيانة بس في الهضبة وحدائق الأهرام)
  if (await handleMaintenance(from, text, env)) return;

  // رد العميل على سؤال "بضاعة ولا مصعد كامل؟"
  if (await handleQuoteChoice(from, text, displayName, who, env)) return;

  // عميل عايز عرض تركيب مصعد → البوت يجمع البيانات ويبعتها للإدارة تحط السعر
  if (await handleCustomerQuote(from, text, displayName, who, env)) return;

  // فاتورة / بيان أسعار → نعملها Excel أوتوماتيك
  if (wantsInvoice(text)) {
    await handleInvoice(from, text, env);
    return;
  }

  // تحويل لقسم الحسابات
  if (wantsAccounts(text) && config.agent.accounts) {
    await handoff(from, who, text, [config.agent.accounts], 'الحسابات', env);
    return;
  }
  // تحويل للإدارة (بيوصل كل أرقام الإدارة مع بعض)
  if (wantsManagement(text) && config.agent.management.length) {
    await handoff(from, who, text, config.agent.management, 'الإدارة', env);
    return;
  }
  // تحويل للمدير
  if (wantsHuman(text) && config.agent.manager) {
    await handoff(from, who, text, [config.agent.manager], 'المدير', env);
    return;
  }

  const lower = text.toLowerCase();
  if (['/reset', 'ابدأ من جديد', 'restart'].includes(lower)) {
    await resetHistory(from, env);
    await sendText(from, 'اتمسحت المحادثة. اسأل عن أي منتج 👍');
    return;
  }

  // تغيير تفضيل نوع الرد (لو العميل طلب)
  const modeChange = detectReplyModeChange(text);
  if (modeChange) {
    await setPref(from, env, modeChange === 'auto' ? null : modeChange);
    if (modeChange === 'voice') await sendText(from, 'تمام، هرد عليك بالصوت من دلوقتي 🎙️');
    else if (modeChange === 'text') await sendText(from, 'تمام، هرد عليك بالكتابة من دلوقتي ✍️');
    else await sendText(from, 'تمام، هرد بنفس نوع رسالتك 👍');
  }

  console.log(`[msg] ${from}: ${text}`);

  const history = await getHistory(from, env);
  let reply;
  let products = [];
  try {
    const out = await generateReply(text, history, { customerName: politeName(displayName) });
    reply = out.reply;
    products = out.products || [];
    await saveHistory(from, out.history, env);
  } catch (err) {
    console.error('[gemini] خطأ:', err.message);
    noteError(`[gemini] ${err.message}`);
    reply = `معلش حصل خطأ مؤقت. جرّب تاني بعد شوية أو كلمنا على واتساب: ${config.store.whatsapp}`;
  }

  // البوت فهم إن العميل عايز تركيب مصعد (صيغة ما اتلقطتش بالكلمات) → نبدأ أسئلة عرض التركيب
  if (reply.includes('[[INSTALL_QUOTE]]')) {
    await handleCustomerQuote(from, text, displayName, who, env, true);
    return;
  }
  // مش واضح العميل عايز إيه → 3 زراير (عرض تركيب / قطع غيار / صيانة)
  if (reply.includes('[[ASK_SERVICE]]')) {
    const intro = reply.replace('[[ASK_SERVICE]]', '').trim() || 'تحت أمرك 🙏 حضرتك محتاج إيه؟';
    await askService(from, env, intro.slice(0, 900));
    return;
  }

  // البوت حس إنه بيتكلم مع تاجر/مورّد ووصل لنقطة محتاجة قرار بشري
  const isSupplierHandoff = reply.includes('[[HANDOFF_SUPPLIER]]');
  if (isSupplierHandoff) reply = reply.replace('[[HANDOFF_SUPPLIER]]', '').trim();

  // أول رسالة في المحادثة → ترحيب بالاسم مضمون (Gemini ساعات بينساه)
  if (!history.length) reply = withGreeting(reply, politeName(displayName));

  // نحدد نوع الرد: تفضيل محفوظ > (تلقائي) يقلّد رسالة العميل
  let pref;
  if (modeChange === 'auto') pref = null;
  else if (modeChange) pref = modeChange;
  else pref = await getPref(from, env);
  const wantVoice = pref === 'voice' || (!pref && type === 'audio');

  let deliveredAsVoice = false;
  if (wantVoice && reply.length <= config.tts.maxChars) {
    try {
      const audio = await synthesize(reply);
      if (audio) {
        const fname = audio.mimeType === 'audio/ogg' ? 'reply.ogg' : 'reply.mp3';
        const mediaId = await uploadMedia(audio.buffer, audio.mimeType, fname);
        if (mediaId && (await sendAudio(from, mediaId))) deliveredAsVoice = true;
      }
    } catch (err) {
      console.error('[tts] خطأ:', err.message);
    }
  }
  // الصوت وصل بس فيه أسعار/أكواد → نبعت نفس الرد مكتوب كمان عشان العميل يرجعله
  if (!deliveredAsVoice || hasPricesOrCodes(reply)) await sendText(from, reply);

  // نسخة من رد البوت لأرقام المتابعة
  ccStaff(`🤖 رد على ${from}:\n${reply}`, from, env);

  const pics = await sendProductImages(from, reply, products, wantsImage(text));

  if (wantsLocation(text)) {
    await sendLocation(from, {
      lat: config.store.lat,
      lng: config.store.lng,
      name: config.store.name,
      address: config.store.address,
    });
  }

  if (isSupplierHandoff) {
    recordSupplier(from, displayName, text, env).catch(() => {});
    await alertSupplierHandoff(from, who, `${who} (تاجر/مورّد):\n${text}\n\nرد البوت:\n${reply}`, env);
  }

  console.log(
    `[reply${deliveredAsVoice ? ':voice' : ''}${pics ? `:${pics}img` : ''}] ${from}: ${reply.replace(/\n/g, ' ')}`,
  );
}

/**
 * نفس محرك الردود بتاع واتساب لكن لعميل ماسنجر (from بصيغة fb:<PSID>).
 * نسخة أبسط: نص بس (من غير صوت/صورة/فاتورة Excel — دي مرتبطة بـ APIs واتساب).
 */
async function handleMessengerMessage(psid, text, env) {
  const from = `fb:${psid}`;
  if (!text) return;

  const custNum = await customerNum(from, env);
  const who = `${custNum ? `زبون ${custNum} — ` : ''}(ماسنجر) ${from}`;
  recordCustomer(from, null, text, env).catch(() => {});
  ccStaff(`👤 ${who}\n${text}`, from, env);

  const mode = await getMode(from, env);
  if (mode && mode !== 'bot') {
    if (wantsBackToBot(text)) {
      await setMode(from, env, 'bot');
      await sendToUser(from, 'تمام، رجعنا لخدمة الأسئلة والأسعار 👍 اسأل عن أي منتج.', env);
      return;
    }
    await setMode(from, env, mode, config.agent.handoffTtl);
    await setLastHandoff(mode, from, env, config.agent.handoffTtl);
    const relayId = await sendText(mode, `💬 ${who}:\n${text}`);
    if (relayId) await setReplyTarget(relayId, from, env, config.agent.handoffTtl);
    return;
  }

  if (wantsAccounts(text) && config.agent.accounts) {
    await handoff(from, who, text, [config.agent.accounts], 'الحسابات', env);
    return;
  }
  if (wantsManagement(text) && config.agent.management.length) {
    await handoff(from, who, text, config.agent.management, 'الإدارة', env);
    return;
  }
  if (wantsHuman(text) && config.agent.manager) {
    await handoff(from, who, text, [config.agent.manager], 'المدير', env);
    return;
  }

  const lower = text.toLowerCase();
  if (['/reset', 'ابدأ من جديد', 'restart'].includes(lower)) {
    await resetHistory(from, env);
    await sendToUser(from, 'اتمسحت المحادثة. اسأل عن أي منتج 👍', env);
    return;
  }

  const history = await getHistory(from, env);
  let reply;
  try {
    const out = await generateReply(text, history);
    reply = out.reply;
    await saveHistory(from, out.history, env);
  } catch (err) {
    console.error('[gemini] خطأ:', err.message);
    noteError(`[gemini] ${err.message}`);
    reply = `معلش حصل خطأ مؤقت. جرّب تاني بعد شوية أو كلمنا على واتساب: ${config.store.whatsapp}`;
  }

  // عرض التركيب بيتعمل على واتساب بس (الملف بيتبعت هناك)
  if (reply.includes('[[INSTALL_QUOTE]]')) {
    reply = `أكيد 👍 عشان نجهّزلك عرض سعر تركيب المصعد من توب باور، ابعتلنا على واتساب: ${config.store.whatsapp}`;
  }
  if (reply.includes('[[ASK_SERVICE]]')) {
    reply =
      reply.replace('[[ASK_SERVICE]]', '').trim() +
      '\nحضرتك محتاج: عرض تركيب مصعد، ولا قطع غيار، ولا صيانة؟';
  }

  const isSupplierHandoff = reply.includes('[[HANDOFF_SUPPLIER]]');
  if (isSupplierHandoff) reply = reply.replace('[[HANDOFF_SUPPLIER]]', '').trim();

  await sendToUser(from, reply, env);
  ccStaff(`🤖 رد على ${from}:\n${reply}`, from, env);

  if (isSupplierHandoff) {
    recordSupplier(from, null, text, env).catch(() => {});
    await alertSupplierHandoff(from, who, `${who} (تاجر/مورّد):\n${text}\n\nرد البوت:\n${reply}`, env);
  }

  console.log(`[messenger-reply] ${from}: ${reply.replace(/\n/g, ' ')}`);
}

function wantsImage(text) {
  const s = arKey(text);
  return ['صوره', 'صور', 'صورة', 'شكلها', 'شكله', 'شكل المنتج', 'picture', 'photo', 'pics'].some(
    (k) => s.includes(k),
  );
}

function wantsLocation(text) {
  const s = arKey(text);
  return [
    'فين المحل', 'فين المكان', 'فين مكانكم', 'العنوان', 'عنوانكم', 'عنوان المحل',
    'مكانكم', 'مكان المحل', 'لوكيشن', 'الموقع', 'موقعكم', 'خريطه', 'الخريطه',
    'ازاي اجي', 'ازاي اوصل', 'منين اجيلكم', 'وين المحل', 'location', 'maps', 'map',
  ].some((k) => s.includes(k));
}

function agentNumbers() {
  return [
    ...new Set(
      [
        config.agent.manager,
        config.agent.accounts,
        ...config.agent.management,
        ...config.agent.ccNumbers,
      ].filter(Boolean),
    ),
  ];
}

/**
 * يبعت نص لكل أرقام المتابعة (fire-and-forget، من غير ما يوقف المعالجة).
 * وبيربط كل رسالة مبعوتة برقم العميل (exceptFrom) — عشان أي موظف يقدر يرد
 * على العميل ده بعدين بس بعمل "رد" (quote) على الرسالة دي في واتساب.
 */
function ccStaff(body, exceptFrom, env) {
  for (const n of config.agent.ccNumbers) {
    if (n && n !== exceptFrom) {
      sendText(n, body)
        .then((id) => {
          if (id && exceptFrom && env) setReplyTarget(id, exceptFrom, env, config.agent.handoffTtl);
        })
        .catch(() => {});
    }
  }
}

/** يبعت ملف مرفوع (media id) لكل أرقام المتابعة. */
async function ccStaffDoc(mediaId, filename, caption, exceptFrom) {
  for (const n of config.agent.ccNumbers) {
    if (n && n !== exceptFrom) {
      try {
        await sendDocument(n, mediaId, filename, caption);
      } catch {
        /* تجاهل */
      }
    }
  }
}

function wantsBackToBot(text) {
  const s = arKey(text);
  return [
    '/bot', 'رجعني للبوت', 'رجعني بوت', 'رجعني البوت', 'ارجع بوت', 'ارجع للبوت',
    'كمل بوت', 'الغاء التحويل', 'إلغاء التحويل', 'عايز البوت', 'عاوز البوت', 'بوت تاني',
  ].some((k) => s.includes(k));
}

function wantsHuman(text) {
  const s = arKey(text);
  const person = ['موظف', 'حد', 'انسان', 'بني ادم', 'بشر', 'حضرتك', 'ناس', 'مدير', 'agent', 'human', 'representative'];
  const verb = ['اكلم', 'كلم', 'اتكلم', 'كلمني', 'اتصل', 'عايز', 'عاوز', 'محتاج', 'ممكن', 'talk', 'speak'];
  if (s.includes('مش عايز بوت') || s.includes('مش عايز روبوت') || s.includes('بلاش بوت')) return true;
  return person.some((p) => s.includes(p)) && verb.some((v) => s.includes(v));
}

function wantsAccounts(text) {
  const s = arKey(text);
  return ['الحسابات', 'قسم الحسابات', 'المحاسب', 'محاسب', 'مسؤول الحسابات', 'accounting', 'accounts'].some(
    (k) => s.includes(k),
  );
}

function wantsManagement(text) {
  const s = arKey(text);
  return ['الاداره', 'اداره', 'ادارة', 'management'].some((k) => s.includes(k));
}

function wantsInvoice(text) {
  const s = arKey(text);
  return [
    'فاتوره', 'فاتورة', 'بيان اسعار', 'بيان بالاسعار', 'بيان بأسعار', 'بيان سعر',
    'عرض سعر', 'عرض اسعار', 'كشف اسعار', 'قايمه اسعار', 'قائمه اسعار', 'كوتيشن',
    'quotation', 'quote', 'invoice',
  ].some((k) => s.includes(k));
}

/** يحوّل العميل لقسم معيّن — ممكن أكتر من رقم يستلموا التنبيه ويقدروا يردوا. */
async function handoff(from, who, text, agentNums, deptLabel, env) {
  const targets = [...new Set((agentNums || []).filter(Boolean))];
  if (targets.length === 0) return;

  // أول رقم هو "المالك" الافتراضي للمحادثة (بيتفرد ليه رسايل العميل الجاية)
  await setMode(from, env, targets[0], config.agent.handoffTtl);
  for (const t of targets) await setLastHandoff(t, from, env, config.agent.handoffTtl);

  await sendToUser(from, `تمام، هوصّلك بـ${deptLabel} من المحل 🙏 هيكلموك حالًا.`, env);
  const alert =
    `🔔 عميل عايز ${deptLabel}: ${who}\nآخر رسالة: ${text}\n\n` +
    `للرد اعمل "رد" (quote) على الرسالة دي واكتب ردك، أو اكتب رقم العميل في أول رسالتك.\nللإنهاء اكتب: /bot`;
  for (const t of targets) {
    const id = await sendText(t, alert);
    if (id) await setReplyTarget(id, from, env, config.agent.handoffTtl);
  }

  console.log(`[handoff:${deptLabel}] ${from}: ${text} → ${targets.join(',')}`);
}

/**
 * تنبيه الإدارة إن في تاجر/مورّد وصل لنقطة محتاجة قرار بشري.
 * البوت بيكون خلّص كلامه الطبيعي مع التاجر (من غير رسالة تحويل قياسية)،
 * وده بس تنبيه + تفعيل ريلاي الردود لو الإدارة حبّت تكمّل معاه مباشرة.
 */
async function alertSupplierHandoff(from, who, summary, env) {
  const targets = [...new Set(config.agent.management.filter(Boolean))];
  if (targets.length === 0) return;

  await setMode(from, env, targets[0], config.agent.handoffTtl);
  for (const t of targets) await setLastHandoff(t, from, env, config.agent.handoffTtl);

  const alert =
    `🧾 تاجر/مورّد عايز يعرض بضاعة على المحل:\n${summary}\n\n` +
    `للرد اعمل "رد" (quote) على الرسالة دي واكتب ردك، أو اكتب رقم العميل في أول رسالتك.\nللإنهاء اكتب: /bot`;
  for (const t of targets) {
    const id = await sendText(t, alert);
    if (id) await setReplyTarget(id, from, env, config.agent.handoffTtl);
  }

  console.log(`[supplier-handoff] ${from} → ${targets.join(',')}`);
}

/**
 * رسالة من موظف: /bot تنهي التحويل، وأي رسالة تانية تتبعت لآخر عميل تحوّل له —
 * أو لو الموظف عمل "رد" (quote) على رسالة عميل قديمة (contextId)، تتبعت له
 * هو بالذات فورًا من غير ما يكتب رقمه ولا يعتمد على آخر تحويل.
 */
async function handleAgentMessage(agent, text, env, contextId) {
  const t = (text || '').trim();
  if (!t) return;

  // تشغيل/إيقاف البوت فورًا من واتساب — بيتحكم فيه أي رقم موظف
  console.log(`[staff ${agent}] ${t}${contextId ? ' (رد على رسالة)' : ''}`);

  // رد على تذكير الـ 24 ساعة ("تمام"، "ok"...) → تأكيد قصير بدل ما البوت يعتبره سؤال
  if (/^(تمام|تم|ok|okay|اوك|أوك|ماشي|حاضر|👍|✅)$/i.test(t) && (await env.MEMORY?.get(remindKey(agent)))) {
    await env.MEMORY.delete(remindKey(agent));
    await sendText(agent, '✅ تمام، النسخ هتفضل توصلك 24 ساعة كمان.');
    return;
  }

  // "اعمل عرض" → البوت يسأل المدير نفس الأسئلة الست + السعر ويطلّع العرض (أول حاجة،
  // عشان إجابات زي "12" أو "500000" ما تتفهمش أوامر تانية)
  if (await handleGuidedOffer(agent, t, env)) return;

  // سعر لطلب عرض من عميل: "رد" على تنبيه الطلب بالسعر، أو "سعر 555000" لآخر طلب
  if (await handleQuotePrice(agent, t, env, contextId)) return;

  // تغيير سعر (للمدير بس): "تغيير سعر طرمبة" → يختار المنتج → "بيع 400 شراء 300"
  if (await handlePriceChange(agent, t, env)) return;

  // "احسبلي 3 طرمبة IT، 5 قاعدة" → فاتورة (صنف/عدد/سعر/إجمالي + إجمالي الفاتورة) ليك انت بس
  if (await handleStaffCalc(agent, t, env)) return;

  // رواتب الموظفين (للإدارة فقط): "هند سلف 500" / "راتب هند" / "الرواتب"
  if (await handlePayroll(agent, t, env)) return;

  // المخزون (للمدير بس): "المخزون" → ملخص، وبعدها اسم منتج → سعر البيع والشراء والحالة
  if (await handleStockQuery(agent, t, env)) return;

  const s = arKey(t);
  if (['اوقف البوت', 'وقف البوت', 'طفي البوت', 'ايقاف البوت', 'stop bot', 'bot off'].some((k) => s.includes(k))) {
    await setBotEnabled(env, false);
    await sendText(agent, '🔴 البوت اتوقف مؤقتًا. للتشغيل تاني اكتب: شغل البوت');
    return;
  }
  if (['شغل البوت', 'شغّل البوت', 'رجع البوت', 'تشغيل البوت', 'start bot', 'bot on'].some((k) => s.includes(k))) {
    await setBotEnabled(env, true);
    await sendText(agent, '🟢 البوت رجع يشتغل عادي.');
    return;
  }

  // مزامنة يدوية فورية لأسماء جوجل (بجانب المزامنة التلقائية الدورية)
  if (['حدث الاسماء', 'حدّث الاسماء', 'مزامنه الاسماء', 'مزامنة الاسماء', 'sync contacts'].some((k) => s.includes(k))) {
    try {
      const count = await syncGoogleContacts(env);
      await sendText(agent, `✅ اتحدثت الأسماء من جوجل (${count} اسم).`);
    } catch (err) {
      await sendText(agent, `❌ فشلت المزامنة: ${err.message}`);
    }
    return;
  }

  // "شركات مقاولات" → بحث عن شركات مقاولات + مسودة تعريف بتوب باور (للمراجعة، مفيش إرسال تلقائي)
  if (s.includes('شركات مقاولات') || s.includes('شركات المقاولات')) {
    await sendText(agent, '🔎 بدوّر على النت عن شركات المقاولات... هاخد دقيقة.');
    try {
      const area = (t.match(/(?:في|ب)\s*([؀-ۿ ]{3,30})$/) || [])[1]?.trim();
      await sendText(agent, (await findContractors(area || 'مصر')) || 'معرفتش ألاقي نتايج دلوقتي، جرّب تاني.');
    } catch (err) {
      await sendText(agent, `❌ فشل البحث: ${err.message}`);
    }
    return;
  }

  // بحث على النت عن شركات تركيب المصاعد + مسودة رسالة تعريفية بالقدس (للمراجعة، مفيش إرسال تلقائي)
  if (['شركات تركيب', 'شركات المصاعد', 'دور علي شركات', 'دور على شركات', 'ابحث عن شركات'].some((k) => s.includes(arKey(k)))) {
    await sendText(agent, '🔎 بدوّر على النت عن شركات تركيب المصاعد... هاخد دقيقة.');
    try {
      const area = (t.match(/(?:في|ب)\s*([؀-ۿ ]{3,30})$/) || [])[1]?.trim();
      const out = await findElevatorCompanies(area || 'مصر');
      await sendText(agent, out || 'معرفتش ألاقي نتايج دلوقتي، جرّب تاني.');
    } catch (err) {
      await sendText(agent, `❌ فشل البحث: ${err.message}`);
    }
    return;
  }

  // قائمة سريعة بالأرقام: 1 القائمة، 2 العملاء، 3 العروض
  const n = toLatinDigits(t);
  if (['0', '1'].includes(n) || ['قائمه', 'القائمه', 'menu'].includes(s)) {
    await sendText(agent, AGENT_MENU);
    return;
  }
  if (n === '4' || ['الطلبات', 'طلبات'].includes(s)) {
    const pending = (env?.MEMORY && (await env.MEMORY.get(PENDING_QUOTES_KEY, 'json'))) || [];
    await sendText(
      agent,
      pending.length
        ? `🏗️ عروض تركيب مستنية سعر (${pending.length}):\n\n` +
            pending
              .map((q) => `عرض رقم ${q.n ?? '?'}: ${q.data.client || q.who} — ${q.data.floors ? q.data.floors + ' أدوار' : ''}`)
              .join('\n') +
            `\n\nعشان تحط السعر: عرض رقم <رقمه> سعره <السعر>\nمثال: عرض رقم ${pending[0].n ?? 1} سعره 6000`
        : '🏗️ مفيش عروض تركيب مستنية سعر دلوقتي.',
    );
    return;
  }
  if (n === '3' || ['العروض', 'اخر العروض'].includes(s)) {
    await sendText(agent, formatOfferLog(await getOfferLog(env)));
    return;
  }

  // "زبون 3 رسالتك" (أو "ابعت 3 رسالتك") → للزبون رقم 3 (رقمه ثابت ما بيتغيرش)
  const sendM = n.match(/^(?:زبون|ابعت)\s*(?:رقم)?\s*(\d{1,5})\s+([\s\S]+)$/);
  if (sendM) {
    const id = env?.MEMORY && (await env.MEMORY.get(numCustKey(sendM[1])));
    if (!id) {
      await sendText(agent, `مفيش زبون رقم ${sendM[1]}. اكتب 2 عشان تشوف أرقام الزباين.`);
      return;
    }
    // أوامر المدير للبوت مع زبون معيّن (رد عليه / اعمله عرض / نفذ: ... / رجعه للبوت)
    if (await handleManagerCommand(agent, id, sendM[1], sendM[2].trim(), env)) return;

    // "زبون 1 خفض الطرمبة IT لـ 300" → رسالة للزبون بالسعر قبل وبعد الخصم
    if (/خفض|خصم|تخفيض|نزل|نزّل|وطي/.test(sendM[2])) {
      await handleDiscount(agent, id, sendM[1], sendM[2].trim(), env);
      return;
    }
    // "زبون 1 90000" (رقم بس) → غالبًا قصده سعر عرض، مش رسالة — منبعتهاش للزبون
    if (/^[\s\d,.]*(?:الف|ألف)?\s*(?:جنيه)?$/.test(sendM[2].replace(/اديله|اديلو|خليه|سعره|السعر/g, ''))) {
      await sendText(
        agent,
        `مبعتّش حاجة لزبون ${sendM[1]} — الرسالة فيها رقم بس.\n` +
          `• لو عايز تبعتله عرض تركيب بالسعر ده: عرض لزبون ${sendM[1]} السعر ${sendM[2].replace(/[^\d,.]/g, '')}\n` +
          `• لو عايز تبعتله الرسالة زي ما هي، اكتب معاها كلام، مثال: زبون ${sendM[1]} السعر ${sendM[2].replace(/[^\d,.]/g, '')} جنيه`,
      );
      return;
    }
    await relayToCustomer(agent, id, sendM[2].trim(), env, `زبون ${sendM[1]}`, false);
    return;
  }

  // استعراض آخر الزباين أو آخر الموردين اللي كلّموا البوت
  if (n === '2' || ['العملاء', 'قائمة العملاء', 'اخر العملاء', 'آخر العملاء', 'الزباين', 'الزبائن', 'customers'].some((k) => s.includes(k))) {
    const list = await getCustomerList(env, 20);
    const lines = [];
    for (const c of list) {
      const num = await customerNum(c.id, env);
      const when = new Date(c.at).toLocaleString('ar-EG', { timeZone: 'Africa/Cairo' });
      lines.push(`زبون ${num}: ${c.name ? `${c.name} (${c.id})` : c.id}\n   "${c.text}"\n   ${when}`);
    }
    await sendText(
      agent,
      list.length
        ? `👥 آخر الزباين (${list.length}):\n\n${lines.join('\n\n')}\n\n` +
            'عشان تبعت لزبون: زبون <رقمه> <رسالتك>\nمثال: زبون 3 السعر متاح عندنا'
        : '👥 مفيش زباين متسجلين لسه.',
    );
    return;
  }
  if (['الموردين', 'قائمة الموردين', 'اخر الموردين', 'آخر الموردين', 'suppliers'].some((k) => s.includes(k))) {
    await sendText(agent, formatContactLog(await getSupplierList(env, 20), '🧾 آخر الموردين/التجار'));
    return;
  }

  // تعديل سعر بيع/شراء منتج مباشرة من واتساب:
  //   سعر بيع اسم المنتج 1500
  //   سعر شراء اسم المنتج = 900
  //   الغاء سعر بيع اسم المنتج   (يرجّعه لسعر إنياد الأصلي)
  if (await handlePriceCommand(agent, t)) return;

  // عرض تركيب مصعد (Word): "عرض ..." بالبيانات، "عرض جديد ..." يبدأ من الصفر، "الغاء العرض"
  // "عرض لـ 3 ..." / "عرض لزبون 3 ..." → العرض يروح للزبون رقم 3
  const listOffer = toLatinDigits(t).match(/^عرض\s+(?:للعميل|للزبون|لزبون|لـ|ل)\s*(\d{1,5})\s+([\s\S]+)$/);
  if (listOffer) {
    const id = env?.MEMORY && (await env.MEMORY.get(numCustKey(listOffer[1])));
    if (!id) {
      await sendText(agent, `مفيش زبون رقم ${listOffer[1]}. اكتب 2 عشان تشوف أرقام الزباين.`);
      return;
    }
    await handleOfferCommand(agent, `عرض ${listOffer[2]}`, env, id);
    return;
  }

  // "01xxxxxxxxx عرض ..." → يعمل العرض ويبعته للعميل ده كمان
  const phoneOffer = toLatinDigits(t).match(/^\+?(\d{10,15})[\s:،,-]+(عرض[\s\S]*)$/);
  if (phoneOffer) {
    await handleOfferCommand(agent, phoneOffer[2], env, normalizePhone(phoneOffer[1]));
    return;
  }
  if (await handleOfferCommand(agent, t, env)) return;

  if (/^\/bot\b/i.test(t) || ['تم', 'خلاص', 'انهاء', 'اقفل'].includes(t)) {
    const m = t.match(/(\d{9,15})/);
    const target = m ? m[1] : await getLastHandoff(agent, env);
    if (!target) {
      await sendText(agent, 'مفيش محادثة محوّلة حاليًا.');
      return;
    }
    await setMode(target, env, 'bot');
    await sendText(agent, `✅ رجّعت العميل ${target} للبوت.`);
    await sendToUser(target, 'رجعنا لخدمة الأسئلة والأسعار 👍 اسأل عن أي منتج.', env);
    return;
  }

  let target;
  let body = t;

  // أولوية قصوى: لو الموظف عمل "رد" (quote) على رسالة عميل، بنستهدفه هو بالذات
  if (contextId) target = await getReplyTarget(contextId, env);

  if (!target) {
    const m = toLatinDigits(t).match(/^\+?(\d{10,15})[\s:،,-]+([\s\S]+)$/);
    // من غير "رد" على رسالة العميل أو رقمه في أول الرسالة، ما بنبعتش لأي عميل —
    // عشان كلام الموظف مع البوت (أوامر، عروض...) ما يروحش لعميل بالغلط.
    if (m) {
      // رقم مصري محلي (01xxxxxxxxx) → صيغة واتساب الدولية (201xxxxxxxxx)
      target = normalizePhone(m[1]);
      body = m[2].trim();
    }
  }
  if (!target) {
    // سؤال عادي من الموظف (مش موجّه لعميل) → البوت يجاوبه (منقول من البوت القديم)
    await handleAdminQuestion(agent, t, env);
    return;
  }

  await relayToCustomer(agent, target, body, env);
}

// تحية المدير (من البوت القديم) — "حاج محمد" للمدير بس، مش للعملاء ولا باقي الموظفين
const ADMIN_GREETING = 'أهلاً يا حاج محمد 👋';
const STAFF_GREETING = 'أهلاً بحضرتك 👋';

/** سؤال حر من موظف → البوت يرد بنفس محرك الأسعار، مع التحية + تذكير إزاي يبعت لعميل. */
async function handleAdminQuestion(agent, text, env) {
  const greeting = agent === config.agent.manager ? ADMIN_GREETING : STAFF_GREETING;
  if (['/reset', 'ابدأ من جديد', 'ابدا من جديد', 'restart'].includes(text.toLowerCase())) {
    await resetHistory(agent, env);
    await sendText(agent, `${greeting}\nاتمسحت المحادثة. اسأل عن أي منتج 👍`);
    return;
  }
  const history = await getHistory(agent, env);
  let reply;
  let products = [];
  try {
    const out = await generateReply(text, history);
    reply = out.reply;
    products = out.products || [];
    await saveHistory(agent, out.history, env);
  } catch (err) {
    console.error('[gemini] خطأ:', err.message);
    noteError(`[gemini] ${err.message}`);
    reply = 'معلش حصل خطأ مؤقت. جرّب تاني بعد شوية.';
  }
  // العلامات الداخلية (عرض تركيب/زراير/مورّد) مالهاش معنى مع الموظف
  reply = reply.replace(/\[\[[A-Z_]+\]\]/g, '').trim() || 'تحت أمرك 🙏';
  await sendText(
    agent,
    `${greeting}\n${reply}\n\n` +
      '(عشان تبعت لعميل: اكتب رقمه في أول الرسالة، أو اعمل "رد" على رسالته)',
  );
  await sendProductImages(agent, reply, products, wantsImage(text));
  console.log(`[admin ${agent}] ${text} → ${reply.replace(/\n/g, ' ')}`);
}

/** يبعت رسالة الموظف للعميل، ويخلّي ردود العميل الجاية توصل للموظف ده (والبوت يسكت معاه). */
async function relayToCustomer(agent, target, body, env, name, handoff = true) {
  const label = name ? `${name} (${target})` : target;
  // واتساب مش بيسمح نبعت لزبون عدّى 24 ساعة على آخر رسالة منه (الرسالة بتتقبل وبعدين تفشل)
  const last = (await getCustomerList(env, 100)).find((c) => c.id === target);
  if (last && Date.now() - last.at > 24 * 3600 * 1000) {
    await sendText(
      agent,
      `⚠️ مقدرتش أبعت لـ ${label}: عدّى أكتر من 24 ساعة على آخر رسالة منه، وواتساب مش بيسمح للبوت يبعتله.\n` +
        'كلّمه من موبايلك، وأول ما يرد البوت يقدر يبعتله عادي.',
    );
    return;
  }
  const sent = await sendToUser(target, body, env);
  if (!sent) {
    await sendText(agent, `❌ الرسالة ما اتبعتتش لـ ${label}. جرّب تاني أو كلّمه من موبايلك.`);
    return;
  }
  // handoff: البوت يسكت مع الزبون وردوده توصل للموظف. رسايل "زبون N" من غير handoff —
  // البوت يفضل يرد عليه عادي (ورسايله بتوصل الموظفين نسخة زي أي زبون).
  if (handoff) {
    await setMode(target, env, agent, config.agent.handoffTtl);
    await setLastHandoff(agent, target, env, config.agent.handoffTtl);
  }
  await sendText(agent, `➡️ اتبعت لـ ${label}`);
  console.log(`[agent ${agent}→${target}] ${body}`);
}

/**
 * المدير بيأمر البوت يتصرف مع زبون (لو البوت ما اشتغلش معاه صح):
 *   زبون 3 رد عليه            → البوت يرد على آخر رسالة من الزبون
 *   زبون 3 نفذ: ابعتله سعر الطرمبة الإيطالي وصورتها  → البوت ينفّذ ويكتب للزبون
 *   زبون 3 اعمله عرض تركيب    → البوت يبدأ معاه أسئلة عرض التركيب
 *   زبون 3 رجعه للبوت          → البوت يرجع يرد عليه عادي
 * @returns اتعامل مع الأمر ولا لأ (لو لأ، الرسالة بتروح للزبون زي ما هي).
 */
async function handleManagerCommand(agent, customer, num, body, env) {
  const a = arKey(body);
  const label = `زبون ${num}`;

  if (/^(رجع|رجعه|رجعو|خلي|شغل)\s*(ه|و)?\s*(لل|ل)?\s*بوت|البوت يرد عليه|شغل البوت معا/.test(a)) {
    await setMode(customer, env, 'bot');
    await sendText(agent, `✅ ${label} رجع للبوت — هيرد عليه عادي.`);
    return true;
  }

  if (/(اعمل|ابدا|ابتدي|افتح|ابعت)(له|لو|ه)?\s*(معاه\s*)?عرض|اساله (علي|على) (العرض|التركيب)|عرض تركيب/.test(a)) {
    if (!(await within24h(customer, env))) {
      await sendText(agent, `⚠️ عدّى أكتر من 24 ساعة على آخر رسالة من ${label} — واتساب مش بيسمح للبوت يبعتله. كلّمه من موبايلك.`);
      return true;
    }
    await env.MEMORY.delete(cquoteKey(customer));
    await setMode(customer, env, 'bot');
    const c = (await getCustomerList(env, 100)).find((x) => x.id === customer);
    const who = `${label} — ${c?.name ? c.name + ' ' : ''}${customer}`;
    await handleCustomerQuote(customer, '', c?.name, who, env, true);
    await sendText(agent, `✅ بدأت مع ${label} أسئلة عرض التركيب — أول ما يخلّص هيوصلك العرض.`);
    return true;
  }

  const ai = a.match(/^(?:رد عليه|رد عليه يا بوت|جاوبه|جاوب عليه|رد|جاوب)$/) || body.match(/^(?:نفذ|نفّذ|بوت|يا بوت)\s*[:：،,-]?\s*([\s\S]+)$/);
  if (!ai) return false;
  if (!(await within24h(customer, env))) {
    await sendText(agent, `⚠️ عدّى أكتر من 24 ساعة على آخر رسالة من ${label} — واتساب مش بيسمح للبوت يبعتله. كلّمه من موبايلك.`);
    return true;
  }

  const c = (await getCustomerList(env, 100)).find((x) => x.id === customer);
  const lastMsg = c?.text || '';
  const instruction = ai[1] ? ai[1].trim() : '';
  const prompt = instruction
    ? `[تعليمات من مدير المحل — نفّذها واكتب الرد للعميل مباشرة من غير ما تذكر إن في تعليمات: ${instruction}]\n` +
      `آخر رسالة من العميل: ${lastMsg}`
    : lastMsg;
  if (!prompt) {
    await sendText(agent, `مفيش رسالة من ${label} أرد عليها.`);
    return true;
  }

  let out;
  try {
    out = await generateReply(prompt, await getHistory(customer, env));
  } catch (err) {
    await sendText(agent, `❌ البوت ما قدرش يكتب الرد: ${err.message}`);
    return true;
  }
  const reply = out.reply.replace(/\[\[[A-Z_]+\]\]/g, '').trim();
  if (!reply) {
    await sendText(agent, '❌ البوت ما طلّعش رد. اكتب التعليمات بشكل أوضح.');
    return true;
  }
  await saveHistory(customer, out.history, env);
  await setMode(customer, env, 'bot');
  await relayToCustomer(agent, customer, reply, env, label, false);
  await sendProductImages(customer, reply, out.products || []).catch(() => 0);
  await sendText(agent, `🤖 البوت بعت لـ ${label}:\n${reply}`);
  return true;
}

/* ---------- استعلامات المدير (المخزون) ---------- */

const mgrKey = (agent) => `mgrq:${agent}`;

/** لو الرسالة سؤال عن سعر منتج (للمدير) يرجّع اسم المنتج، وإلا null. s = بعد arKey. */
function adminProductQuery(s) {
  if (/^(زبون|عرض|طلب|ابعت|تغيير|تغير|غير|عدل|تعديل|وقف|شغل|\/bot)/.test(s)) return null;
  const hasLetters = (x) => /[a-zء-ي]{2,}/i.test(x || '');
  const clean = (x) => String(x || '').replace(/\b(كام|ايه|اي|يا بوت)\b/g, '').trim();
  let m =
    s.match(/^(?:سعر\s*)?(?:ال)?منتج\s+(.+)$/) || // منتج X / المنتج X / سعر المنتج X
    s.match(/^بكام\s+(.+)$/) || // بكام X
    s.match(/^(.+?)\s+(?:سعره|سعرها|سعرو|بكام)(?:\s+(?:كام|ايه|اي))?\s*$/); // X سعره / X بكام
  if (!m) {
    // سعر X / سعرX (لازقة) — بس مش "سعر بيع/شراء ..." ولا "سعر 5 6000"
    const p = s.match(/^سعر\s*(.+)$/);
    if (p && !/^(ال)?(بيع|شراء)(\s|$)/.test(p[1]) && !/^(ه|ها|و)(\s|$)/.test(p[1])) m = p;
  }
  const name = m && clean(m[1]);
  return hasLetters(name) ? name : null;
}

/* ---------- عرض بالأسئلة للمدير ("اعمل عرض") ---------- */

const guidedKey = (agent) => `guided:${agent}`;
const GUIDED_STEPS = ['client', 'address', 'phone', 'machine', 'hp', 'floors', 'price'];
const GUIDED_Q = {
  client: '1️⃣ اسم العميل؟',
  address: '2️⃣ عنوان العقار؟',
  phone: '3️⃣ رقم تليفون العميل؟',
  machine: '4️⃣ نوع الماكينة؟ (إيطالي ولا تركي)',
  hp: '5️⃣ قدرة الماكينة كام حصان؟',
  floors: '6️⃣ عدد الأدوار؟',
  price: '7️⃣ السعر؟',
};

/**
 * المدير: "اعمل عرض" → البوت يسأله سؤال سؤال (الاسم، العنوان، التليفون، الماكينة، الحصان،
 * الأدوار، السعر) وبعدها يطلّع ملف العرض + كارت العميل. "-" أو "مش عارف" يعدّي السؤال،
 * و"الغاء" يلغي. @returns اتعامل مع الرسالة ولا لأ.
 */
async function handleGuidedOffer(agent, t, env) {
  if (!config.agent.admins.includes(agent)) return false;
  const kv = env.MEMORY;
  const s = arKey(t);
  let st = await kv.get(guidedKey(agent), 'json');

  if (/^(اعمل|اعملي|اعمللي|ابدا|ابتدي|عايز|عاوز)\s*(ال)?عرض(\s*(جديد|تركيب|سعر))?$/.test(s)) {
    st = { step: 0, data: {} };
    await kv.put(guidedKey(agent), JSON.stringify(st), { expirationTtl: 3600 });
    await sendText(agent, '📝 عرض تركيب جديد — جاوب على الأسئلة ("-" تعدّي السؤال، "الغاء" تلغي):');
    await sendText(agent, GUIDED_Q[GUIDED_STEPS[0]]);
    return true;
  }
  if (!st) return false;

  if (['الغاء', 'الغي', 'خلاص', 'خروج'].includes(s)) {
    await kv.delete(guidedKey(agent));
    await sendText(agent, '👍 اتلغى العرض.');
    return true;
  }

  const key = GUIDED_STEPS[st.step];
  const skip = /^(-|\.|مش عارف|معرفش|لا يوجد|مفيش)$/.test(s);
  if (!skip) {
    let val = t.trim();
    if (key === 'price') {
      const p = parsePrice(val);
      if (!p) {
        await sendText(agent, 'اكتب السعر رقم، مثال: 600000 أو 600 ألف');
        return true;
      }
      val = String(p);
    }
    st.data[key] = val;
  }
  st.step++;

  if (st.step < GUIDED_STEPS.length) {
    await kv.put(guidedKey(agent), JSON.stringify(st), { expirationTtl: 3600 });
    await sendText(agent, GUIDED_Q[GUIDED_STEPS[st.step]]);
    return true;
  }

  // الأسئلة خلصت → ملف العرض + كارت العميل
  await kv.delete(guidedKey(agent));
  const data = { ...completeOffer(st.data), date: cairoDate() };
  try {
    await sendOfferFile([agent], data);
    await recordOffer(data, env);
    const phone = data.phone ? normalizePhone(toLatinDigits(data.phone).replace(/\D/g, '')) : null;
    if (phone && /^\d{11,15}$/.test(phone)) await sendCustomerCard(agent, data, phone, 'عرض تركيب');
    await sendText(agent, `✅ العرض جاهز:\n${offerSummary(data)}`);
    console.log(`[guided-offer] ${agent}: ${data.client} — ${data.price}`);
  } catch (err) {
    console.error('[guided-offer] خطأ:', err.message);
    await sendText(agent, `❌ مقدرتش أطلّع العرض: ${err.message}`);
  }
  return true;
}

/** المدير بعت ملف جرد إنياد (Excel) → نقرا الكميات ونحفظها. */
async function handleInventoryUpload(agent, doc, env) {
  const isXlsx = /\.xlsx$/i.test(doc.filename) || /spreadsheetml/.test(doc.mimeType);
  if (!isXlsx) {
    await sendText(agent, 'ابعت ملف الجرد Excel (.xlsx) المتصدّر من إنياد عشان أحدّث الكميات.');
    return;
  }
  try {
    const media = await fetchMedia(doc.id);
    if (!media) throw new Error('مقدرتش أنزّل الملف');
    const inv = parseInventoryXlsx(media.buffer);
    await saveInventory(env, inv);
    const tot = inventoryTotals(inv);
    await sendText(
      agent,
      `✅ اتحدّث المخزون من الملف${inv.date ? ` (جرد ${inv.date})` : ''}:\n` +
        `عدد الأصناف: ${tot.count}\n` +
        `إجمالي القطع: ${tot.qty}\n` +
        `أصناف رصيدها صفر أو أقل: ${tot.zero}\n\n` +
        'دلوقتي لما تسأل عن منتج هيطلعلك العدد الموجود.',
    );
    console.log(`[inventory] ${agent}: ${tot.count} صنف`);
  } catch (err) {
    console.error('[inventory] خطأ:', err.message);
    await sendText(agent, `❌ مقدرتش أقرا ملف الجرد: ${err.message}`);
  }
}

/** صورة المنتج (لو موجودة) وبعدها تفاصيله. */
async function sendDetails(agent, p, text) {
  if (p?.imageUrl) await sendImage(agent, p.imageUrl, p.name).catch(() => false);
  await sendText(agent, text);
}

/** مستوى المخزون بالكلام (إنياد بيدّي المستوى وحد التنبيه، مش الكمية بالعدد). */
function stockLabel(stock, lowAt, inStock) {
  if (stock === 'LOW_STOCK') return `⚠️ قليل${lowAt ? ` (${lowAt} أو أقل)` : ''}`;
  if (stock === 'OUT_OF_STOCK') return '❌ خلصان';
  if (stock === 'IN_STOCK') return `✅ متاح${lowAt ? ` (أكتر من ${lowAt})` : ''}`;
  return inStock === false ? '❌ خلصان' : '✅ متاح';
}

/** تفاصيل منتج للمدير: سعر البيع، سعر الشراء، الربح، وحالة المخزون. */
function stockDetails(p, inv) {
  const cur = config.store.currency;
  const sale = p.override?.sale ?? p.price;
  const cost = p.override?.cost ?? p.ourCost;
  // العدد من آخر ملف جرد اتبعت (إنياد مش بيدّيه في الـ API) — ولو مش موجود نعرض المستوى
  const q = findQty(inv, p.name);
  const lines = [
    `📦 ${p.name}`,
    p.category ? `التصنيف: ${p.category}` : null,
    `سعر البيع: ${sale ?? '—'}${p.priceMax && p.priceMax !== sale && p.override?.sale == null ? ` إلى ${p.priceMax}` : ''} ${cur}`,
    `سعر الشراء: ${cost ?? '—'} ${cur}`,
    sale != null && cost ? `الربح: ${Math.round((sale - cost) * 100) / 100} ${cur} (${Math.round(((sale - cost) / cost) * 100)}%)` : null,
    q
      ? `الكمية الموجودة: ${q.qty}${q.date ? ` (جرد ${q.date})` : ''}`
      : `المخزون: ${stockLabel(p.stock, p.lowAt, p.inStock)}`,
  ];
  if (p.variations?.length) {
    lines.push('', 'الأنواع:');
    for (const v of p.variations) {
      lines.push(
        `• ${v.name}: بيع ${v.price} / شراء ${Number.isFinite(v.cost) && v.cost > 0 ? v.cost : '—'} — ${stockLabel(v.stock, v.lowAt, v.inStock)}`,
      );
    }
  }
  return lines.filter((l) => l != null).join('\n');
}

/**
 * المدير بس: "المخزون" → ملخص + يطلب اسم منتج. الاسم → التفاصيل، ولو في أكتر من منتج
 * شبهه → قايمة بأرقام يختار منها. @returns اتعامل مع الرسالة ولا لأ.
 */
async function handleStockQuery(agent, t, env) {
  if (!config.agent.admins.includes(agent)) return false;
  const kv = env.MEMORY;
  const s = arKey(t);
  const st = await kv.get(mgrKey(agent), 'json');

  // اختصار: سعر البيع والشراء على طول (من غير ما يدخل المخزون) — أي صيغة من دول:
  //   "سعر طرمبة" / "سعرطرمبة" / "منتج طرمبة" / "المنتج طرمبة" / "سعر المنتج طرمبة"
  //   "طرمبة سعره" / "طرمبة سعرها كام" / "طرمبة بكام" / "بكام الطرمبة"
  // ("سعر بيع ... 100" / "سعر شراء ..." تعديل سعر، و"سعر 5 6000" سعر عرض، و"زبون ..." — مش ده)
  const productName = adminProductQuery(s);
  if (productName) return lookupProduct(agent, productName, env, { once: true });

  // "المخزون طرمبة" → يدوّر على طول ويطلّع المتشابه
  const stockQ = s.match(/^(?:ال)?(?:مخزون|جرد)\s+(.+)$/);
  if (stockQ && /[a-zء-ي]/i.test(stockQ[1])) {
    return lookupProduct(agent, t.replace(/^\s*\S+\s+/, ''), env);
  }

  if (['المخزون', 'مخزون', 'الجرد', 'جرد'].includes(s)) {
    const sum = await stockSummary();
    const tot = inventoryTotals(await getInventory(env));
    await kv.put(mgrKey(agent), JSON.stringify({ mode: 'stock' }), { expirationTtl: 1800 });
    await sendText(
      agent,
      `📦 المخزون:\n` +
        `إجمالي المنتجات: ${sum.total}\n` +
        (tot ? `إجمالي القطع: ${tot.qty} (جرد ${tot.date || '—'})\n` : '') +
        `✅ متاح: ${sum.inStock}\n` +
        `⚠️ قليل: ${sum.low}\n` +
        `❌ خلصان: ${sum.outOfStock}\n` +
        (tot ? '' : '\n(عشان يطلعلك العدد بالظبط، ابعتلي ملف الجرد Excel من إنياد)\n') +
        '\n' +
        '👈 اكتب اسم المنتج اللي عايز تعرف تفاصيله\n(أو "القليل" أو "الخلصان" تشوف قايمتهم)',
    );
    return true;
  }
  if (!st) return false;

  // خروج، أو أمر تاني → نسيب وضع المخزون
  if (['خلاص', 'الغاء', 'خروج', 'انهاء'].includes(s) || /^(زبون|عرض|سعر|ابعت|طلب|وقف|شغل|\/bot)/.test(s)) {
    await kv.delete(mgrKey(agent));
    return ['خلاص', 'الغاء', 'خروج', 'انهاء'].includes(s)
      ? (await sendText(agent, '👍 خرجنا من المخزون.'), true)
      : false;
  }

  if (s === 'القليل' || s === 'قليل' || s === 'الناقص') {
    const sum = await stockSummary();
    await sendText(
      agent,
      sum.lowNames.length
        ? `⚠️ منتجات قربت تخلص (${sum.lowNames.length}):\n\n${sum.lowNames.slice(0, 80).map((n, i) => `${i + 1}. ${n}`).join('\n')}`
        : '✅ مفيش منتجات قربت تخلص.',
    );
    return true;
  }
  if (s === 'الخلصان' || s === 'خلصان') {
    const sum = await stockSummary();
    await sendText(
      agent,
      sum.outNames.length
        ? `❌ المنتجات الخلصانة (${sum.outNames.length}):\n\n${sum.outNames.slice(0, 80).map((n, i) => `${i + 1}. ${n}`).join('\n')}`
        : '✅ مفيش منتجات خلصانة.',
    );
    return true;
  }

  // اختيار رقم من قايمة المشتبهات
  const n = toLatinDigits(t).trim();
  if (st.mode === 'pick' && /^\d{1,2}$/.test(n)) {
    const p = st.items[Number(n) - 1];
    if (!p) {
      await sendText(agent, `اختار رقم من 1 لـ ${st.items.length}.`);
      return true;
    }
    if (st.once) {
      await kv.delete(mgrKey(agent));
      await sendDetails(agent, p, stockDetails(p, await getInventory(env)));
    } else {
      await kv.put(mgrKey(agent), JSON.stringify({ mode: 'stock' }), { expirationTtl: 1800 });
      await sendDetails(agent, p, stockDetails(p, await getInventory(env)) + '\n\n👈 اكتب اسم منتج تاني، أو "خلاص"');
    }
    return true;
  }
  if (/^\d{1,4}$/.test(n)) return false; // أرقام القايمة (2، 3، 4) وغيرها — مش اسم منتج
  if (st.mode === 'pick' && st.once) {
    await kv.delete(mgrKey(agent)); // كتب حاجة تانية بدل ما يختار — نسيب القايمة
    return false;
  }

  return lookupProduct(agent, t, env);
}

const pchgKey = (agent) => `pchg:${agent}`;
const slimProduct = (p) => ({
  name: p.name,
  category: p.category,
  price: p.price,
  priceMax: p.priceMax,
  ourCost: p.ourCost,
  inStock: p.inStock,
  stock: p.stock,
  lowAt: p.lowAt,
  imageUrl: p.imageUrl,
  variations: p.variations,
  override: p.override,
});
const PCHG_HELP = '👈 اكتب السعر الجديد كده:\nبيع 400\nأو: شراء 300\nأو الاتنين: بيع 400 شراء 300';

/**
 * المدير بس: تغيير سعر البيع/الشراء بمحادثة — "تغيير سعر" → اسم المنتج (ولو في مشتبهات
 * يختار رقم) → "بيع 400" / "شراء 300". التعديل بيتطبّق على ردود البوت (فوق سعر إنياد).
 * @returns اتعامل مع الرسالة ولا لأ.
 */
async function handlePriceChange(agent, t, env) {
  if (!config.agent.admins.includes(agent)) return false;
  const kv = env.MEMORY;
  const s = arKey(t);
  const lt = toLatinDigits(t).trim();
  let st = await kv.get(pchgKey(agent), 'json');

  const start = s.match(/^(?:تغيير|تغير|غير|عدل|تعديل)\s*(?:ال)?سعر\s*(.*)$/);
  if (start) {
    st = { step: 'name' };
    const name = t.replace(/^\s*\S+\s*\S*سعر\S*\s*/, '').trim();
    if (!name) {
      await kv.put(pchgKey(agent), JSON.stringify(st), { expirationTtl: 1800 });
      await sendText(agent, '✏️ تغيير سعر — اكتب اسم المنتج:');
      return true;
    }
    return pchgFind(agent, name, env);
  }
  if (!st) return false;

  if (['خلاص', 'الغاء', 'خروج', 'انهاء'].includes(s)) {
    await kv.delete(pchgKey(agent));
    await sendText(agent, '👍 اتلغى تغيير السعر.');
    return true;
  }

  if (st.step === 'name') return pchgFind(agent, t, env);

  if (st.step === 'pick') {
    if (!/^\d{1,2}$/.test(lt)) return pchgFind(agent, t, env); // كتب اسم تاني بدل الرقم
    const item = st.items[Number(lt) - 1];
    if (!item) {
      await sendText(agent, `اختار رقم من 1 لـ ${st.items.length}.`);
      return true;
    }
    await kv.put(pchgKey(agent), JSON.stringify({ step: 'set', item }), { expirationTtl: 1800 });
    await sendDetails(agent, item, `${stockDetails(item, await getInventory(env))}\n\n${PCHG_HELP}`);
    return true;
  }

  if (st.step === 'set') {
    const num = (re) => {
      const m = lt.match(re);
      return m ? Number(m[1].replace(/,/g, '')) : null;
    };
    const sale = num(/بيع\s*[:=]?\s*(\d[\d,.]*)/);
    const cost = num(/شراء\s*[:=]?\s*(\d[\d,.]*)/);
    if (!(sale > 0) && !(cost > 0)) {
      await sendText(agent, `مش فاهم. ${PCHG_HELP}\n(أو "الغاء")`);
      return true;
    }
    const patch = {};
    if (sale > 0) patch.sale = sale;
    if (cost > 0) patch.cost = cost;
    await setOverride(normalizeAr(st.item.name), patch);
    await kv.delete(pchgKey(agent));
    const cur = config.store.currency;
    await sendText(
      agent,
      `✅ اتغيّر سعر "${st.item.name}":\n` +
        (patch.sale ? `سعر البيع: ${st.item.override?.sale ?? st.item.price ?? '—'} ← ${patch.sale} ${cur}\n` : '') +
        (patch.cost ? `سعر الشراء: ${st.item.override?.cost ?? st.item.ourCost ?? '—'} ← ${patch.cost} ${cur}\n` : '') +
        '\n(التعديل شغال في ردود البوت على طول — ومش بيغيّر السعر في برنامج إنياد نفسه)',
    );
    console.log(`[price-change] ${agent}: ${st.item.name} ${JSON.stringify(patch)}`);
    return true;
  }
  return false;
}

/** يدوّر على المنتج اللي هيتغيّر سعره: واحد → يطلب السعر، كذا واحد → قايمة يختار منها. */
async function pchgFind(agent, name, env) {
  const kv = env.MEMORY;
  const found = await searchProducts(name, 10, { raw: true });
  if (!found.length) {
    await kv.put(pchgKey(agent), JSON.stringify({ step: 'name' }), { expirationTtl: 1800 });
    await sendText(agent, `مش لاقي منتج اسمه "${name}". اكتب اسم تاني، أو "الغاء".`);
    return true;
  }
  if (found.length === 1) {
    const item = slimProduct(found[0]);
    await kv.put(pchgKey(agent), JSON.stringify({ step: 'set', item }), { expirationTtl: 1800 });
    await sendDetails(agent, item, `${stockDetails(item, await getInventory(env))}\n\n${PCHG_HELP}`);
    return true;
  }
  const items = found.map(slimProduct);
  await kv.put(pchgKey(agent), JSON.stringify({ step: 'pick', items }), { expirationTtl: 1800 });
  await sendText(
    agent,
    `لقيت ${items.length} منتجات شبه "${name}":\n\n` +
      items.map((p, i) => `${i + 1}. ${p.name} — بيع ${p.override?.sale ?? p.price ?? '—'} / شراء ${p.override?.cost ?? p.ourCost ?? '—'}`).join('\n') +
      '\n\n👈 اكتب رقم المنتج اللي عايز تغيّر سعره',
  );
  return true;
}

/**
 * يدوّر على منتج ويبعت تفاصيله (بيع/شراء/مخزون). أكتر من منتج شبه الاسم → قايمة بأرقام.
 * once: من اختصار "سعر ..." — بعد الاختيار ما يفضلش في وضع المخزون.
 */
async function lookupProduct(agent, name, env, { once = false } = {}) {
  const kv = env.MEMORY;
  const t = name.trim();
  const tail = once ? '' : '\n\n👈 اكتب اسم منتج تاني، أو "خلاص"';
  const found = await searchProducts(t, 10, { raw: true });
  if (!found.length) {
    await sendText(agent, `مش لاقي منتج اسمه "${t}". جرّب اسم تاني${once ? '' : '، أو "خلاص" للخروج'}.`);
    return true;
  }
  if (found.length === 1) {
    if (!once) await kv.put(mgrKey(agent), JSON.stringify({ mode: 'stock' }), { expirationTtl: 1800 });
    await sendDetails(agent, found[0], stockDetails(found[0], await getInventory(env)) + tail);
    return true;
  }
  // أكتر من منتج شبه الاسم → قايمة يختار منها
  const items = found.map((p) => ({
    name: p.name,
    category: p.category,
    price: p.price,
    priceMax: p.priceMax,
    ourCost: p.ourCost,
    inStock: p.inStock,
    stock: p.stock,
    lowAt: p.lowAt,
    imageUrl: p.imageUrl,
    variations: p.variations,
    override: p.override,
  }));
  await kv.put(mgrKey(agent), JSON.stringify({ mode: 'pick', items, once }), { expirationTtl: 1800 });
  await sendText(
    agent,
    `لقيت ${items.length} منتجات شبه "${t}":\n\n` +
      items.map((p, i) => `${i + 1}. ${p.name} — ${p.override?.sale ?? p.price ?? '—'} ${config.store.currency}`).join('\n') +
      '\n\n👈 اكتب رقم المنتج اللي تقصده',
  );
  return true;
}

/** آخر رسالة من الزبون في خلال 24 ساعة؟ (غير كده واتساب مش بيسمح للبوت يبعتله) */
async function within24h(customer, env) {
  const last = (await getCustomerList(env, 100)).find((c) => c.id === customer);
  return !last || Date.now() - last.at <= 24 * 3600 * 1000;
}

/** خصم لزبون: نجيب سعر المنتج من المتجر ونبعتله السعر قبل وبعد الخصم. */
async function handleDiscount(agent, customer, num, text, env) {
  let d = {};
  try {
    d = await extractDiscount(text);
  } catch (err) {
    console.error('[discount] extract خطأ:', err.message);
  }
  if (!d.product) {
    await sendText(agent, 'مش فاهم اسم المنتج. اكتب كده مثلاً:\nزبون 1 خفض الطرمبة IT لـ 300');
    return;
  }
  const p = (await searchProducts(d.product, 5))[0];
  const before = p ? Number(p._price) : NaN;
  if (!p || !Number.isFinite(before)) {
    await sendText(agent, `مش لاقي منتج اسمه "${d.product}" في المتجر. اكتب اسمه زي ما هو في المتجر.`);
    return;
  }
  let after = null;
  if (Number(d.newPrice) > 0) after = Number(d.newPrice);
  else if (Number(d.amount) > 0) after = before - Number(d.amount);
  else if (Number(d.percent) > 0) after = before * (1 - Number(d.percent) / 100);
  after = after == null ? null : Math.round(after * 100) / 100;
  if (after == null || after <= 0 || after >= before) {
    await sendText(
      agent,
      `سعر "${p['الاسم']}" دلوقتي ${before} ${config.store.currency}. اكتب السعر الجديد أو قيمة الخصم، مثال:\n` +
        `زبون ${num} خفض ${p['الاسم']} لـ ${Math.round(before * 0.9)}`,
    );
    return;
  }

  const cur = config.store.currency;
  const msg =
    `🎁 عرض خاص ليك من ${config.store.name}:\n\n` +
    `${p['الاسم']}\n` +
    `السعر كان: ${before} ${cur}\n` +
    `بعد الخصم: ${after} ${cur} ✅`;
  await relayToCustomer(agent, customer, msg, env, `زبون ${num}`, false);
  console.log(`[discount] ${agent}→${customer}: ${p['الاسم']} ${before}→${after}`);
}

const AGENT_MENU =
  '📋 القائمة:\n' +
  '2 ← آخر الزباين (كل زبون ليه رقم ثابت)\n' +
  '3 ← آخر العروض\n' +
  '4 ← عروض تركيب من عملاء مستنية سعر\n\n' +
  'عرض رقم <رقمه> سعره <السعر> ← العرض يطلع ويتبعت للعميل (مثال: عرض رقم 5 سعره 6000)\n' +
  'زبون <رقمه> <رسالتك> ← رسالة لزبون (مثال: زبون 3 السعر متاح)\n' +
  'زبون <رقمه> رد عليه ← البوت يرد على آخر رسالة منه\n' +
  'زبون <رقمه> نفذ: ... ← البوت ينفّذ اللي تقوله (مثال: زبون 3 نفذ: ابعتله سعر الطرمبة)\n' +
  'زبون <رقمه> اعمله عرض تركيب ← البوت يبدأ معاه أسئلة العرض\n' +
  'زبون <رقمه> رجعه للبوت ← البوت يرجع يرد عليه عادي\n' +
  'عرض ... ← عرض تركيب جديد (اكتب البيانات براحتك)\n' +
  'عرض لزبون <رقمه> ... ← عرض تركيب يروح للزبون ده كمان\n' +
  'عرض <رقم> ← يبعتلك ملف عرض من قائمة 3 تاني\n' +
  'وقف البوت / شغل البوت';

// كل زبون ليه رقم ثابت (زبون 1، زبون 2...) — بيظهر في كل رسايله اللي بتوصل للموظفين
const custNumKey = (id) => `custnum:${id}`;
const numCustKey = (n) => `numcust:${n}`;

async function customerNum(id, env) {
  const kv = env?.MEMORY;
  if (!kv) return null;
  const existing = await kv.get(custNumKey(id));
  if (existing) return existing;
  const n = String(Number((await kv.get('cust:seq')) || 0) + 1);
  await kv.put('cust:seq', n);
  await kv.put(custNumKey(id), n);
  await kv.put(numCustKey(n), id);
  return n;
}
const OFFER_LOG_KEY = 'log:offers';

function toLatinDigits(s) {
  return String(s).replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
}

async function getOfferLog(env) {
  return (env?.MEMORY && (await env.MEMORY.get(OFFER_LOG_KEY, 'json'))) || [];
}

/** يسجّل العرض في أول القائمة (نفس العميل بيتحدّث بدل ما يتكرر). */
async function recordOffer(data, env) {
  const kv = env?.MEMORY;
  if (!kv) return;
  const list = (await getOfferLog(env)).filter((o) => !data.client || arKey(o.data.client || "") !== arKey(data.client));
  list.unshift({ at: Date.now(), data });
  await kv.put(OFFER_LOG_KEY, JSON.stringify(list.slice(0, 30)));
}

function formatOfferLog(list) {
  if (!list.length) return '📄 مفيش عروض متسجلة لسه.';
  const lines = list.map((o, i) => {
    const when = new Date(o.at).toLocaleDateString('ar-EG', { timeZone: 'Africa/Cairo' });
    return `${i + 1}. ${o.data.client || "(من غير اسم)"} — ${o.data.price || "?"} ${config.store.currency} — ${when}`;
  });
  return `📄 آخر العروض (${list.length}):\n\n${lines.join('\n')}\n\nعشان يوصلك الملف تاني: عرض <رقمه>\nمثال: عرض 1`;
}

/** يطلّع ملف Word للعرض ويبعته للموظف. */
/**
 * يطلّع ملف Word للعرض ويبعته لكل رقم في targets (بيترفع مرة واحدة بس).
 * @returns {Promise<boolean[]>} اتبعت لكل رقم ولا لأ
 */
async function sendOfferFile(targets, data) {
  const docx = buildOfferDocx(offerTemplate, data);
  const mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const mediaId = await uploadMedia(docx, mime, 'offer.docx');
  if (!mediaId) throw new Error('فشل رفع الملف');
  const who = data.client || 'عميل';
  const fname = `عرض تركيب مصعد - ${who}${data.qn ? ` - عرض ${data.qn}` : ''}.docx`;
  // الموظف (أول واحد) بيوصله اسم العميل وبياناته فوق الملف عشان يعرفه؛ العميل بيوصله كابشن عادي
  const staffCap =
    `📄 ${data.qn ? `عرض رقم ${data.qn} — ` : ''}${who}` +
    (data.address ? `\n📍 ${data.address}` : '') +
    (data.phone || data.to || data.qcustomer ? `\n📞 ${data.phone || localPhone(data.to || data.qcustomer)}` : '') +
    (data.price ? `\n💰 ${data.price} ${config.store.currency}` : '');
  const out = [];
  for (let i = 0; i < targets.length; i++) {
    const cap = i === 0 ? staffCap : 'عرض سعر تركيب مصعد — توب باور للمصاعد';
    out.push(await sendDocument(targets[i], mediaId, fname, cap));
  }
  return out;
}

/** رقم مصري محلي (01xxxxxxxxx أو 0020...) → صيغة واتساب الدولية (201xxxxxxxxx). */
function normalizePhone(p) {
  return String(p).replace(/^00/, '').replace(/^0(1\d{9})$/, '20$1');
}

/** يبني رسالة نصية من قائمة عملاء/موردين مسجّلة (شوف getCustomerList/getSupplierList). */
function formatContactLog(list, title) {
  if (!list.length) return `${title}: مفيش حد مسجّل لسه.`;
  const lines = list.map((c, i) => {
    const when = new Date(c.at).toLocaleString('ar-EG', { timeZone: 'Africa/Cairo' });
    const label = c.name ? `${c.name} (${c.id})` : c.id;
    return `${i + 1}. ${label}\n   "${c.text}"\n   ${when}`;
  });
  return `${title} (${list.length}):\n\n${lines.join('\n\n')}`;
}

const PRICE_SET_RE = /^سعر\s*(?:ال)?(بيع|شراء)\s+(.+?)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*$/i;
const PRICE_CLEAR_RE = /^(?:الغاء|إلغاء)\s+سعر\s*(?:ال)?(بيع|شراء)\s+(.+)$/i;

/**
 * أوامر الموظفين لتعديل سعر بيع/شراء منتج فورًا عبر واتساب (بيتفعّل في ردود
 * البوت للعملاء على طول، من غير ما يلمس بيانات إنياد). @returns تعامل الأمر ولا لأ.
 */
async function handlePriceCommand(agent, t) {
  const setMatch = t.match(PRICE_SET_RE);
  const clearMatch = !setMatch && t.match(PRICE_CLEAR_RE);
  if (!setMatch && !clearMatch) return false;

  const kindAr = (setMatch || clearMatch)[1];
  const field = kindAr.includes('بيع') ? 'sale' : 'cost';
  const query = (setMatch || clearMatch)[2].trim();

  const matches = await searchProducts(query, 5);
  if (matches.length === 0) {
    await sendText(agent, `مش لاقي منتج اسمه "${query}". اكتب اسمه زي ما هو في المتجر.`);
    return true;
  }
  const product = matches[0];
  const key = normalizeAr(product.الاسم);
  const fieldLabel = field === 'sale' ? 'البيع' : 'الشراء';

  if (setMatch) {
    const value = Number(setMatch[3]);
    await setOverride(key, { [field]: value });
    await sendText(
      agent,
      `✅ اتظبط سعر ${fieldLabel} لـ "${product.الاسم}" = ${value} ${config.store.currency}.\n(هيفضل زي ما هو لحد ما تغيّره تاني أو تلغيه)`,
    );
  } else {
    await clearOverride(key, field);
    await sendText(agent, `✅ اتلغى تعديل سعر ${fieldLabel} لـ "${product.الاسم}" — رجع لسعر إنياد الأصلي.`);
  }
  return true;
}

const OFFER_TTL = 24 * 3600;
const offerKey = (agent) => `offer:${agent}`;

/**
 * أمر الموظف لعمل عرض تركيب مصعد. بيحفظ البيانات كمسودة (يوم) عشان الموظف
 * يقدر يكمّل الناقص أو يعدّل حاجة ("عرض السعر 500000") ويطلع العرض تاني.
 * @returns تعامل الأمر ولا لأ.
 */
async function handleOfferCommand(agent, t, env, to) {
  const s = arKey(t);
  const kv = env?.MEMORY;
  if (['الغاء العرض', 'الغي العرض', 'امسح العرض'].some((k) => s.startsWith(k))) {
    if (kv) await kv.delete(offerKey(agent));
    await sendText(agent, '🗑️ اتمسحت بيانات العرض.');
    return true;
  }
  if (!/^عرض(\s|$)/.test(s)) return false;

  const fresh = /^عرض\s+جديد/.test(s);
  const body = t.replace(/^\S+(\s+جديد)?/, '').trim();
  if (!body) {
    await sendText(
      agent,
      'ابعت بيانات العرض في رسالة تبدأ بكلمة "عرض"، مثال:\n' +
        'عرض تركيب للأستاذ محمد علي، العقار في فيصل شارع العشرين، مصعد ركاب، ' +
        '6 أدوار، المشوار 20 متر، حمولة 450 كجم، السعر 495000، ' +
        'الدفعات 50 25 20 5\n\n' +
        'عشان تبدأ عرض لعميل تاني: "عرض جديد ..."، وللمسح: "الغاء العرض".',
    );
    return true;
  }

  // "عرض 2" → يبعت ملف العرض رقم 2 من قائمة العروض (أمر 3) تاني
  const idx = toLatinDigits(body).match(/^(\d{1,2})$/);
  if (idx) {
    // "عرض 5" ورقم 5 عرض تركيب مستني سعر → نفكّره بطريقة حط السعر
    const waiting = ((await kv?.get(PENDING_QUOTES_KEY, 'json')) || []).find((q) => q.n === Number(idx[1]));
    if (waiting) {
      await sendText(
        agent,
        `🏗️ عرض رقم ${waiting.n} (${waiting.data.client || waiting.who}) مستني سعر.\n` +
          `اكتب: عرض رقم ${waiting.n} سعره 6000 (حط السعر مكان 6000)`,
      );
      return true;
    }
    const item = (await getOfferLog(env))[Number(idx[1]) - 1];
    if (!item) {
      await sendText(agent, 'الرقم ده مش في قائمة العروض. اكتب 3 عشان تشوفها.');
      return true;
    }
    try {
      await sendOfferFile([agent], item.data);
    } catch (err) {
      console.error('[offer] resend خطأ:', err.message);
      await sendText(agent, `❌ مقدرتش أبعت الملف: ${err.message}`);
    }
    return true;
  }

  const t0 = Date.now();
  const lap = (step) => console.log(`[offer] ${step}: ${Date.now() - t0}ms`);
  await sendText(agent, '⏳ ثواني وبجهّز العرض...');
  lap('ack');

  let fields;
  try {
    fields = await extractOfferFields(body);
    lap('gemini');
  } catch (err) {
    console.error('[offer] extract خطأ:', err.message);
    await sendText(agent, '❌ حصلت مشكلة في قراءة البيانات، ابعتها تاني.');
    return true;
  }

  let draft = fresh || !kv ? {} : (await kv.get(offerKey(agent), 'json')) || {};
  // اسم عميل مختلف عن المسودة القديمة → عرض جديد (عشان بيانات العميل القديم ما تدخلش فيه)
  if (fields.client && draft.client && arKey(fields.client) !== arKey(draft.client)) draft = {};
  draft = mergeOffer(draft, fields);
  if (to) draft.to = to; // رقم العميل اللي هيتبعتله العرض
  if (kv) await kv.put(offerKey(agent), JSON.stringify(draft), { expirationTtl: OFFER_TTL });

  // العرض بيطلع على طول حتى لو في بيانات ناقصة — خاناتها بتفضل فاضية، وبنبلّغ الموظف بيها بس
  const missing = missingOfferFields(draft);

  // التاريخ بيتثبت يوم عمل العرض، عشان لو اتبعت تاني من قائمة العروض يفضل زي ما هو
  const data = { date: cairoDate(), ...completeOffer(draft) };
  try {
    // بيتبعت للعميل بس لو الأمر ده نفسه فيه رقمه ("01... عرض ..." / "عرض لزبون 3 ...") —
    // تعديل عادي زي "عرض السعر 480000" ما يبعتش للعميل تاني من غير ما تقصد
    const sendTo = to || null;
    const [, toCustomer] = await sendOfferFile(sendTo ? [agent, sendTo] : [agent], data);
    lap('file sent');
    await recordOffer(data, env);
    if (sendTo) {
      await kv?.put(installKey(sendTo), '1', { expirationTtl: INSTALL_TTL });
      await sendText(agent, contactHeader(data, sendTo));
      await sendCustomerCard(agent, data, sendTo, 'عرض تركيب');
      if (toCustomer) {
        // البوت بيفضل يرد على العميل عادي، ورسايله بتوصلك نسخة منها
        await sendText(agent, `📤 العرض اتبعت للعميل ${localPhone(sendTo)}`);
      } else {
        await sendText(
          agent,
          `⚠️ العرض ما وصلش للعميل ${sendTo}. واتساب مش بيسمح للبوت يبعت لعميل ما كلّمهوش آخر 24 ساعة، ` +
            'فاعمل Forward للملف ليه من عندك.',
        );
      }
    }
    await sendText(
      agent,
      `✅ العرض جاهز:\n${offerSummary(data)}\n\n` +
        (missing.length ? `(سايب فاضي: ${missing.map((k) => OFFER_LABELS[k]).join('، ')})\n\n` : '') +
        'لو عايز تعدّل حاجة ابعت مثلاً: عرض السعر 480000\nولعميل تاني: عرض جديد ...',
    );
    console.log(`[offer] ${agent}: ${data.client} — ${data.price}`);
  } catch (err) {
    console.error('[offer] docx خطأ:', err.message);
    await sendText(agent, `❌ مقدرتش أطلّع ملف العرض: ${err.message}`);
  }
  return true;
}

/* ---------- عرض تركيب مصعد بطلب من العميل ---------- */

// الخانات الست اللي العميل بيملاها (السعر بتحطه الإدارة) — بالترتيب ده تحت بعض
const CUSTOMER_QUOTE_REQUIRED = ['client', 'address', 'phone', 'machine', 'hp', 'floors'];
const CUSTOMER_QUOTE_ASK = {
  client: 'الاسم',
  address: 'العنوان',
  phone: 'رقم التليفون',
  machine: 'نوع الماكينة',
  hp: 'قدرة الماكينة',
  floors: 'عدد الأدوار',
};

const QUOTE_QUESTIONS = {
  client: '1️⃣ اسم حضرتك؟',
  address: '2️⃣ عنوان العقار؟',
  phone: '3️⃣ رقم تليفون للتواصل؟ (لو نفس الرقم ده اكتب: نفس الرقم)',
  machine: '4️⃣ نوع الماكينة؟ (إيطالي ولا تركي)',
  hp: '5️⃣ قدرة الماكينة كام حصان؟',
  floors: '6️⃣ عدد الأدوار؟',
};

/**
 * الإجابة مش مناسبة للسؤال (زي حروف في خانة رقم): لو باين إنه سؤال تاني (سعر منتج مثلاً)
 * نسيب البوت يرد عليه عادي والأسئلة مستنية، وإلا نعيد السؤال.
 */
async function offTopicOrRepeat(from, st, key, asking, env) {
  st.retries = (st.retries || 0) + 1;
  await env.MEMORY.put(cquoteKey(from), JSON.stringify(st), { expirationTtl: QUOTE_TTL });
  if (st.retries > 2 && !asking) return false; // مش مهتم يكمّل — البوت يرد عليه عادي
  await sendText(from, `معلش، محتاج ${key === 'phone' ? 'رقم التليفون' : 'رقم'} هنا 🙏\n${QUOTE_QUESTIONS[key]}`);
  return true;
}

/** يقرا الفورم سطر سطر ("الاسم: محمد") — من غير ذكاء اصطناعي عشان ميغلطش. */
function parseQuoteForm(text, from) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^\s*([^:：]+?)\s*[:：]\s*(.*)$/);
    if (!m || !m[2].trim()) continue;
    const label = arKey(m[1]);
    const val = m[2].trim();
    let k = null;
    if (/قدر|حصان/.test(label)) k = 'hp';
    else if (/ماكين|مكن/.test(label)) k = 'machine';
    else if (/ادوار|دور/.test(label)) k = 'floors';
    else if (/تليفون|موبايل|تلفون|رقم/.test(label)) k = 'phone';
    else if (/عنوان/.test(label)) k = 'address';
    else if (/اسم/.test(label)) k = 'client';
    if (k) out[k] = val;
  }
  if (out.phone && /نفس|ده|دا|هو/.test(arKey(out.phone)) && !/\d/.test(out.phone)) out.phone = localPhone(from);
  return out;
}
const QUOTE_TTL = 24 * 3600;
const PENDING_QUOTES_KEY = 'quotes:pending';
const cquoteKey = (id) => `cquote:${id}`;

/* ---------- صيانة المصاعد (قسم تالت: الهضبة وحدائق الأهرام بس) ---------- */

const MAINT_PHONE = '01000278824';
const maintKey = (id) => `maint:${id}`;
// علامة إن العميل ده عميل تركيب (بتفضل 6 شهور) — عشان منذكرلوش حدود منطقة الصيانة
const installKey = (id) => `installcust:${id}`;
const INSTALL_TTL = 180 * 24 * 3600;

function wantsMaintenance(text) {
  const s = arKey(text);
  // صيانة / بتصينوا / عطل / عطلان / اشتراك / شهري / عقد صيانة
  if (/صيان|صين|عطل|اشترا?ك|شهري|عقد صيان/.test(s)) return true;
  // "بتعملوا/بتاخدوا ..." مع مصعد أو شهر (من غير اسم قطعة) — "بتاخدوا كام في الشهر"
  const lift = /مصعد|مصاعد|[اأ]?[سص]ا?[نت][سص]ي?ر/.test(s);
  // "المصعد واقف / مش شغال / فيه مشكلة / بيزيق" = عطل → صيانة (مش سؤال عن قطعة)
  const part = /طرمب|كالون|كامه|ماكين|مكنه|كارت|باب|زرار|وقفه/.test(s);
  if (lift && !part && /واقف|وقف|مش شغال|مبيشتغلش|مشكل|بيزيق|بيخبط|بيرجع/.test(s)) return true;
  return /بت?(عمل|[اأ]?خد)/.test(s) && (lift || /شهر/.test(s)) && !/طرمب|كالون|كامه|ماكين/.test(s);
}

function inMaintArea(text) {
  const s = arKey(text);
  return s.includes('هضبه') || /حدا[يئ]ق\s*(ال)?اهرام/.test(s);
}

/**
 * عميل عايز صيانة: نسأله عن مكانه. في المنطقة → رقم الصيانة. برّه المنطقة → نعرض عليه
 * قطع الغيار (والبوت بعدها يكمّل معاه عادي، وعارف السياق من الـ history).
 * @returns اتعامل مع الرسالة ولا لأ.
 */
async function handleMaintenance(from, text, env) {
  const kv = env?.MEMORY;
  if (!kv) return false;

  // عميل تركيب: توب باور بتعمل صيانة لأي مصعد ركّبته في أي مكان — حد المنطقة لعميل الصيانة بس
  // (اللي مصعده متركّب من برّه). البوت يكمّل معاه عادي من غير أسئلة المنطقة.
  if (await kv.get(installKey(from))) return false;

  const waiting = await kv.get(maintKey(from));
  if (!waiting) {
    if (!wantsMaintenance(text)) return false;
    await kv.delete(choiceKey(from)); // لو جه من زرار "صيانة"
    if (!inMaintArea(text)) {
      await kv.put(maintKey(from), '1', { expirationTtl: 3600 });
      await sendToUser(from, 'أكيد تحت أمرك 🙏 حضرتك مكانك فين؟ (اسم المنطقة)', env);
      return true;
    }
  } else {
    await kv.delete(maintKey(from));
  }

  let reply;
  if (inMaintArea(text)) {
    reply = `تمام 👍 منطقتك عندنا فيها صيانة من توب باور للمصاعد.\nكلّم الرقم ده ${MAINT_PHONE} وهيرد على كل تساؤلاتك.`;
  } else {
    reply =
      'للأسف صيانة توب باور للمصاعد في منطقة الهضبة وحدائق الأهرام بس 🙏\n' +
      'بس إحنا في متجر القدس بنبيع كل قطع غيار المصاعد الأصلية بالضمان وبأسعار تجارية — ' +
      'لو محتاج أي قطعة اسألني عنها وأقولك سعرها على طول.\n\n' +
      'ولو محتاج تركيب مصعد جديد، توب باور بتركّب في أي مكان — اكتب "عايز عرض سعر تركيب مصعد".';
  }
  await sendToUser(from, reply, env);
  // نسجّلها في المحادثة عشان البوت يكمّل وهو فاهم السياق (زي لو العميل قال "مش محتاج")
  const history = await getHistory(from, env);
  await saveHistory(
    from,
    [...history, { role: 'user', parts: [{ text }] }, { role: 'model', parts: [{ text: reply }] }],
    env,
  );
  console.log(`[maint] ${from}: ${inMaintArea(text) ? 'في المنطقة' : 'برّه المنطقة'}`);
  return true;
}

const choiceKey = (id) => `qchoice:${id}`;

/**
 * مش واضح العميل عايز إيه → 3 زراير تحت بعض: عرض تركيب / قطع غيار / صيانة
 * (ولو الزراير فشلت، نفس الاختيارات كنص بأرقام).
 */
async function askService(from, env, intro = 'تحت أمرك 🙏 حضرتك محتاج إيه؟') {
  await env?.MEMORY?.put(choiceKey(from), '1', { expirationTtl: 3600 });
  const ok = await sendButtons(from, intro, [
    { id: 'svc_install', title: 'عرض تركيب مصعد' },
    { id: 'svc_parts', title: 'قطع غيار' },
    { id: 'svc_maint', title: 'صيانة' },
  ]);
  if (!ok) {
    await sendText(from, `${intro}\n1️⃣ عرض تركيب مصعد\n2️⃣ قطع غيار\n3️⃣ صيانة\n\nاكتب رقم اختيارك`);
  }
}

/**
 * رد العميل على الاختيارات التلاتة — كل اختيار بيكمّل بنفس السيستم بتاعه.
 * @returns اتعامل مع الرسالة ولا لأ.
 */
async function handleQuoteChoice(from, text, name, who, env) {
  const kv = env?.MEMORY;
  if (!kv || !(await kv.get(choiceKey(from)))) return false;
  const s = arKey(toLatinDigits(text));
  const maint = /^3\b/.test(s) || wantsMaintenance(text);
  const lift = !maint && (/^1\b/.test(s) || ['مصعد', 'اسانسير', 'تركيب', 'كامل', 'توب باور'].some((k) => s.includes(k)));
  const parts = !maint && !lift && (/^2\b/.test(s) || ['قطع', 'غيار', 'بضاعه', 'اصناف', 'مهمات', 'القدس'].some((k) => s.includes(k)));
  if (!maint && !lift && !parts) return false; // كلام تاني — يكمّل عادي
  await kv.delete(choiceKey(from));
  if (maint) return handleMaintenance(from, 'صيانة', env);
  if (lift) return handleCustomerQuote(from, '', name, who, env, true);
  await sendText(
    from,
    'تمام 👍 ابعتلي اسم القطعة اللي محتاجها (أو صورتها) وأنا أقولك سعرها على طول.\n' +
      'ولو أكتر من قطعة اكتبهم بالكميات، مثال: 3 طرمبة IT تركي، 2 كاوتشة طرمبة',
  );
  return true;
}

function wantsElevatorQuote(text) {
  const s = arKey(text);
  if (wantsMaintenance(text)) return false; // صيانة ليها مسار لوحدها
  // "عاوز عرض تركيب" / "عرض سعر تركيب" / "تركيب مصعد" حتى من غير كلمة مصعد
  if (/عرض\s*(?:سعر\s*)?(?:لل?)?تركيب|تركيب\s*(?:مصعد|مصاعد|اسانسير|اسنسير|اصانصير)/.test(s)) return true;
  // "معاينة" لوحدها معناها تركيب (زي "محتاج معاينة تركيب")
  if (s.includes('معاين')) return true;
  // مصعد / مصاعد / أسانسير بكل طرق الكتابة (اسنسير، استسير، اصانصير، سانسير، اسانسور...)
  const lift = /مصعد|مصاعد|مصعب|[اأ]?[سص]ا?[نت][سص]ي?ر|[اأ]?[سص]ا?[نت][سص]ور/.test(s);
  // سؤال عن قطعة غيار للمصعد ("سعر ماكينة مصعد"، "كالون اسانسير") → ده القدس مش تركيب
  const part = /ماكين|مكنه|كالون|طرمب|كامه|حبل|حبال|كارت|كنترول|لوح|زرار|زراير|بطاري|انفرتر|موتور|سلك|كابل|سوست|ريلي|مفتاح|باب|ابواب|كابين|دلائل|سكين|قطع|غيار/.test(s);
  // "عرض سعر" لوحدها (من غير اسم قطعة) → عرض تركيب
  if (/عرض\s*(ال)?سعر/.test(s) && !part) return true;
  // "مصعد كامل" / "اسنسير كامل" → تركيب دايمًا
  if (lift && s.includes('كامل')) return true;
  // "تركيب" أو "أركّب" لوحدها (من غير قطعة غيار) → تركيب
  if (/تركيب|اركب|نركب|يركب|تركب/.test(s) && !part) return true;
  if (!lift) return false;
  // "عرض مصعد" / "سعر اسنسير" / "يعمل كام مصعد" / "مصعد بكام" / "مصعد جديد"
  // "عايز اسانسير" / "محتاج مصعد لعمارة" / "مصعد لبيت 5 دور"
  const quote =
    /عرض|تركيب|تركب|ركب|جديد|سعر|بكام|يعمل كام|بيعمل كام|تكلف|تكلفه|عا[وي][زر]|محتاج|نفسي|ينفع|عماره|بيت|برج|فيلا|مبني|دور|ادوار|طوابق/.test(
      s,
    );
  // "المصعد عطلان / واقف / فيه مشكلة" = صيانة/إصلاح مش تركيب
  if (/عطل|عطلان|واقف|مشكل|بيزيق|بيخبط|مش شغال|وقف/.test(s)) return false;
  return quote && !part;
}

/**
 * العميل عايز عرض تركيب: البوت يسأله على البيانات (ممكن على كذا رسالة)، ولما تكمل —
 * أو بعد سؤالين لو في حاجة مش عارفها — يبعتها للإدارة. @returns اتعامل مع الرسالة ولا لأ.
 */
async function handleCustomerQuote(from, text, name, who, env, force = false) {
  const kv = env?.MEMORY;
  if (!kv || String(from).startsWith('fb:')) return false;

  let st = await kv.get(cquoteKey(from), 'json');
  const asking = force || wantsElevatorQuote(text);
  if (!st) {
    if (!asking) return false;
    st = { data: {}, asks: 0 };
    await kv.put(installKey(from), '1', { expirationTtl: INSTALL_TTL });
  }
  if (st.sent) {
    if (!asking) return false;
    // طلب عرض تاني من نفس العميل (والأول لسه مستني سعر) → طلب جديد بالست بنود من الأول
    st = { data: {} };
  }

  // سؤال سؤال: البوت بيسأل خانة واحدة، والعميل يرد بالإجابة بس
  if (st.step == null) {
    st.step = 0;
    // فورم بخانات حقيقية (WhatsApp Flow) لو متجهّز، وإلا أسئلة سؤال سؤال
    const flows = await getFlowIds(env);
    st.viaFlow =
      !!flows.quote &&
      (await sendFlow(from, {
        flowId: flows.quote,
        flowToken: `quote:${from}`,
        screen: 'QUOTE',
        header: 'توب باور للمصاعد',
        body: 'أهلاً بيك 👋 عشان نجهّزلك عرض سعر تركيب المصعد، دوس على الزرار تحت واملى البيانات 👇',
        cta: 'املى البيانات',
      }));
    await kv.put(cquoteKey(from), JSON.stringify(st), { expirationTtl: QUOTE_TTL });
    if (!st.viaFlow) {
      await sendText(
        from,
        'أهلاً بيك 👋 عشان نجهّزلك عرض سعر تركيب المصعد من توب باور محتاجين البيانات دي:\n\n' +
          CUSTOMER_QUOTE_REQUIRED.map((k, i) => `${i + 1}. ${CUSTOMER_QUOTE_ASK[k]}`).join('\n') +
          '\n\nتقدر تبعتهم كلهم في رسالة واحدة، أو تجاوب سؤال سؤال 👇',
      );
      await sendText(from, QUOTE_QUESTIONS[CUSTOMER_QUOTE_REQUIRED[0]]);
    }
    return true;
  }

  // اتبعتله الفورم بس كتب رسالة بدل ما يملاه → نكمّل بالأسئلة سؤال سؤال
  if (st.viaFlow) {
    st.viaFlow = false;
    await kv.put(cquoteKey(from), JSON.stringify(st), { expirationTtl: QUOTE_TTL });
    await sendText(from, 'تقدر تدوس على زرار "املى البيانات" فوق 👆 أو تجاوب هنا على طول:');
    await sendText(from, QUOTE_QUESTIONS[CUSTOMER_QUOTE_REQUIRED[st.step]]);
    return true;
  }

  const key = CUSTOMER_QUOTE_REQUIRED[st.step];
  const ans = String(text || '').trim();
  const a = arKey(toLatinDigits(ans));
  const skip = /^(مش عارف|معرفش|مش متاكد|لا اعرف|مش فاكر|-|\.)$/.test(a);

  // لو كتب كل البيانات مرة واحدة ("الاسم: ... العنوان: ...") ناخدها كلها
  let form = parseQuoteForm(ans, from);
  // أو كتبهم كلام عادي في رسالة واحدة (كذا سطر أو مفصولين بفواصل) → الذكاء الاصطناعي يوزّعهم
  if (Object.keys(form).length < 2 && (/\n/.test(ans) || ans.split(/[،,]/).length >= 3)) {
    try {
      const ai = await extractOfferFields(ans);
      const picked = {};
      for (const k of CUSTOMER_QUOTE_REQUIRED) if (ai[k]) picked[k] = String(ai[k]);
      if (Object.keys(picked).length >= 2) form = picked;
    } catch (err) {
      console.error('[cquote] extract خطأ:', err.message);
    }
  }
  if (Object.keys(form).length >= 2) {
    st.data = mergeOffer(st.data, form);
  } else if (skip) {
    // يعدّي الخانة دي
  } else {
    let val = ans;
    if (key === 'phone') {
      if (/نفس|ده|دا|هو هو|الرقم ده/.test(a) && !/\d/.test(a)) val = localPhone(from);
      else if (!/\d{7,}/.test(a.replace(/\s/g, ''))) return offTopicOrRepeat(from, st, key, asking, env);
    }
    if ((key === 'hp' || key === 'floors') && !/\d/.test(a)) {
      return offTopicOrRepeat(from, st, key, asking, env);
    }
    if (ans.length > 120) return offTopicOrRepeat(from, st, key, asking, env); // غالبًا سؤال تاني مش إجابة
    st.data = mergeOffer(st.data, { [key]: val });
  }

  // الخانة الجاية اللي لسه فاضية
  let next = st.step + 1;
  while (next < CUSTOMER_QUOTE_REQUIRED.length && st.data[CUSTOMER_QUOTE_REQUIRED[next]]) next++;
  if (next < CUSTOMER_QUOTE_REQUIRED.length) {
    st.step = next;
    await kv.put(cquoteKey(from), JSON.stringify(st), { expirationTtl: QUOTE_TTL });
    await sendText(from, QUOTE_QUESTIONS[CUSTOMER_QUOTE_REQUIRED[next]]);
    return true;
  }

  // الأسئلة خلصت → للإدارة
  return submitCustomerQuote(from, st, name, who, env);
}

/** البيانات كملت (من الأسئلة أو من الفورم) → رقم عرض + تنبيه للإدارة + خانة السعر. */
async function submitCustomerQuote(from, st, name, who, env) {
  const kv = env.MEMORY;
  if (!st.data.client && name) st.data.client = name;
  if (!st.data.phone) st.data.phone = localPhone(from);
  st.sent = true;
  await kv.put(cquoteKey(from), JSON.stringify(st), { expirationTtl: QUOTE_TTL });

  // كل طلب ليه رقم ثابت ("عرض رقم 5") عشان الموظف يحط السعر بيه: عرض رقم 5 سعره 6000
  const n = Number((await kv.get('quotes:seq')) || 0) + 1;
  await kv.put('quotes:seq', String(n));
  const pending = ((await kv.get(PENDING_QUOTES_KEY, 'json')) || []).filter((q) => q.customer !== from);
  pending.unshift({ n, customer: from, who, data: st.data, at: Date.now() });
  await kv.put(PENDING_QUOTES_KEY, JSON.stringify(pending.slice(0, 30)));

  await sendText(
    from,
    'شكرًا 🙏 البيانات وصلت، والإدارة هتراجعها وهيوصلك عرض السعر هنا على واتساب في أقرب وقت.',
  );

  const flows = await getFlowIds(env);
  const still = CUSTOMER_QUOTE_REQUIRED.filter((k) => !st.data[k]);
  const alert =
    `🏗️ عرض رقم ${n} — تركيب مصعد\n\n${contactHeader(st.data, from)}\n\n${offerSummary(st.data)}` +
    (still.length ? `\n\n(مش عارف: ${still.map((k) => CUSTOMER_QUOTE_ASK[k]).join('، ')})` : '');
  for (const t of [...new Set(config.agent.management.filter(Boolean))]) {
    const id = await sendText(t, alert);
    if (id) await setReplyTarget(id, `quote:${from}`, env, QUOTE_TTL);
    await sendCustomerCard(t, st.data, from, `عرض تركيب رقم ${n}`, { vcf: false });
    // "خانة السعر": فورم فيه خانة السعر، ولو الفورم مش متاح الرقم الجاي من الموظف بيتحط سعر
    await kv.put(`quotesel:${t}`, String(n), { expirationTtl: 12 * 3600 });
    const flowSent =
      flows.price &&
      (await sendFlow(t, {
        flowId: flows.price,
        flowToken: `price:${n}`,
        screen: 'PRICE',
        body: `💰 السعر لعرض رقم ${n} (${st.data.client || localPhone(from)})`,
        cta: 'اكتب السعر',
      }));
    if (!flowSent) {
      await sendText(t, `💰 السعر لعرض رقم ${n}:\n(اكتب الرقم بس، مثال: 600000 — والعرض يتبعت للعميل على طول)`);
    }
  }
  console.log(`[cquote] ${from} → الإدارة`);
  return true;
}

/** رد فورم WhatsApp Flow — الـ flow_token بيقول ده فورم إيه. */
async function handleFlowReply(msg, env) {
  const { from, flow } = msg;
  const token = String(flow?.flow_token || '');
  console.log(`[flow] ${from}: ${token} ${JSON.stringify(flow).slice(0, 300)}`);

  // موظف كتب السعر → العرض يطلع ويتبعت للعميل
  if (token.startsWith('price:') && agentNumbers().includes(from)) {
    const n = token.slice(6);
    await handleQuotePrice(from, `عرض رقم ${n} سعره ${flow.price}`, env);
    return;
  }

  // عميل ملا بيانات عرض التركيب
  if (token.startsWith('quote:')) {
    const kv = env.MEMORY;
    let st = (await kv.get(cquoteKey(from), 'json')) || { data: {}, step: 0 };
    if (st.sent) st = { data: {}, step: 0 }; // فورم جديد بعد طلب قديم → طلب جديد
    const fields = {
      client: flow.client,
      address: flow.address,
      phone: flow.phone,
      machine: MACHINE_TITLES[flow.machine] || flow.machine,
      hp: flow.hp,
      floors: flow.floors,
    };
    st.data = mergeOffer(st.data, fields);
    await kv.put(installKey(from), '1', { expirationTtl: INSTALL_TTL });
    const contact = await getContactInfo(from, env);
    const name = contact?.name || msg.name || null;
    const num = await customerNum(from, env);
    const who = `${num ? `زبون ${num} — ` : ''}${name ? name + ' ' : ''}${from}`;
    await submitCustomerQuote(from, st, name, who, env);
  }
}

/** رقم واتساب دولي (2010...) → الشكل المحلي (010...) عشان يتقرا ويتحفظ بسهولة. */
function localPhone(id) {
  return String(id).replace(/^20(1\d{9})$/, '0$1');
}

/** بيانات العميل (اسم/عنوان/تليفون) في أول رسالة العرض — عشان الموظف يحفظها. */
function contactHeader(d, phone) {
  const wa = localPhone(phone);
  const given = d.phone && toLatinDigits(d.phone).replace(/\D/g, '') !== wa ? d.phone : null;
  return (
    '📇 بيانات العميل:\n' +
    `الاسم: ${d.client || '—'}\n` +
    `العنوان: ${d.address || '—'}\n` +
    `التليفون: ${given || wa}` +
    (given ? `\nواتساب اللي بعت منه: ${wa}` : '')
  );
}

/**
 * كارت العميل: كارت جهة اتصال جوه واتساب (يتحفظ على الموبايل بضغطة) +
 * ملف .vcf يتحفظ على الكمبيوتر (تفتحه يتضاف لجهات الاتصال بالاسم والعنوان والتليفون).
 */
async function sendCustomerCard(to, d, phone, note, { wa = true, vcf = true } = {}) {
  if (!phone || String(phone).startsWith('fb:')) return;
  const name = d.client ? `${d.client} (توب باور)` : localPhone(phone);
  if (wa) {
    try {
      await sendContact(to, { name, phone: String(phone), address: d.address, note });
    } catch {
      /* تجاهل — البيانات مكتوبة في الرسالة كمان */
    }
  }
  if (!vcf) return;
  try {
    const vcf = buildVcard(d, phone, note);
    const fname = `${(d.client || localPhone(phone)).replace(/[\\/:*?"<>|]/g, ' ')} - ${note || 'عميل'}.vcf`;
    const id = await uploadMedia(new TextEncoder().encode(vcf), 'text/plain', 'card.vcf');
    if (id) await sendDocument(to, id, fname, `📇 كارت ${d.client || localPhone(phone)} — احفظه على الكمبيوتر`);
  } catch (err) {
    console.error('[vcf] خطأ:', err.message);
  }
}

/** vCard (بيتفتح على الكمبيوتر أو الموبايل ويتضاف لجهات الاتصال). */
function buildVcard(d, phone, note) {
  const esc = (s) => String(s || '').replace(/([,;\\])/g, '\\$1').replace(/\r?\n/g, ' ');
  const wa = `+${String(phone).replace(/\D/g, '')}`;
  const given = d.phone ? toLatinDigits(d.phone).replace(/[^\d+]/g, '') : '';
  const givenIntl = given.replace(/^0(1\d{9})$/, '+20$1');
  const details = [
    note,
    d.machine && `ماكينة ${d.machine}${d.hp ? ` ${d.hp} حصان` : ''}`,
    d.floors && `${d.floors} أدوار`,
    d.price && `السعر ${d.price} جنيه`,
  ]
    .filter(Boolean)
    .join(' - ');
  return [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${esc(d.client ? `${d.client} (توب باور)` : localPhone(phone))}`,
    `N:;${esc(d.client || localPhone(phone))};;;`,
    'ORG:عميل توب باور للمصاعد',
    `TEL;TYPE=CELL:${wa}`,
    givenIntl && givenIntl !== wa ? `TEL;TYPE=WORK:${givenIntl}` : null,
    d.address ? `ADR;TYPE=HOME:;;${esc(d.address)};;;;` : null,
    details ? `NOTE:${esc(details)}` : null,
    'END:VCARD',
  ]
    .filter(Boolean)
    .join('\r\n');
}

function parsePrice(s) {
  const m = toLatinDigits(s).match(/(\d[\d,.]*)\s*(الف|ألف|k)?/i);
  if (!m) return null;
  let n = Number(m[1].replace(/,/g, ''));
  if (!Number.isFinite(n) || n <= 0) return null;
  if (m[2]) n *= 1000;
  return n;
}

/**
 * الموظف بيحط السعر لطلب عرض من عميل → العرض يطلع ويتبعت للعميل وللموظف.
 * @returns اتعامل مع الرسالة ولا لأ.
 */
async function handleQuotePrice(agent, t, env, contextId) {
  const kv = env?.MEMORY;
  if (!kv) return false;

  let customer = null;
  let priceText = null;
  if (contextId) {
    const ref = await getReplyTarget(contextId, env);
    if (ref && ref.startsWith('quote:')) {
      customer = ref.slice(6);
      priceText = t;
    }
  }
  const lt = toLatinDigits(t);
  const selKey = `quotesel:${agent}`;

  // كلام على خطوتين: "عايز رقم 2" / "العرض رقم 2" → وبعدها "600000" لوحدها
  const pick = !customer && lt.match(/^(?:عايز|عاوز|هات|افتح|اختار|شوف)?\s*(?:ال)?(?:عرض|طلب)?\s*رقم\s*(\d{1,4})\s*$/);
  if (pick) {
    const num = Number(pick[1]);
    const q = ((await kv.get(PENDING_QUOTES_KEY, 'json')) || []).find((x) => x.n === num);
    const o = !q && (await getOfferLog(env)).find((x) => x.data.qn === num);
    if (!q && !o) {
      await sendText(agent, `مفيش عرض تركيب رقم ${num}. اكتب 4 عشان تشوف العروض المستنية سعر.`);
      return true;
    }
    await kv.put(selKey, String(num), { expirationTtl: 1800 });
    const d = q ? q.data : o.data;
    await sendText(
      agent,
      `🏗️ عرض رقم ${num} — ${d.client || 'عميل'}\n\n${offerSummary(d)}\n\n👈 ابعت السعر بس (مثال: 600000)`,
    );
    return true;
  }
  const sel = !customer && (await kv.get(selKey));
  // (السعر لازم يكون 1000 أو أكتر — عشان أوامر القائمة زي 2 و3 و4 ما تتحسبش سعر)
  if (
    sel &&
    /^\s*(?:السعر|سعره|اديله)?\s*\d[\d,.]*\s*(?:الف|ألف)?\s*(?:جنيه)?\s*$/.test(lt) &&
    parsePrice(lt) >= 1000
  ) {
    await kv.delete(selKey);
    return handleQuotePrice(agent, `عرض رقم ${sel} سعره ${lt.replace(/السعر|سعره|اديله/g, '').trim()}`, env);
  }

  // رقم العرض والسعر بأي صيغة: "عرض رقم 5 سعره 880000" / "عرض 5 880000" / "سعر 5 6000"
  // (وكلمة "طلب" بدل "عرض" شغالة برضه). "عرض 6 أدوار ... السعر ..." من غير "رقم" = عرض جديد مش ده.
  const P = '(\\d[\\d,.]*\\s*(?:الف|ألف|k)?)';
  let byNum =
    !customer &&
    (lt.match(new RegExp(`^(?:سعر|طلب)\\s+(\\d{1,4})\\s+${P}\\s*(?:جنيه)?$`, 'i')) ||
      lt.match(new RegExp(`^عرض\\s+(\\d{1,4})\\s+(?:سعره|السعر|سعر|هو|خليه|=|:)?\\s*${P}\\s*(?:جنيه)?$`, 'i')));
  if (!customer && !byNum && /عرض|طلب/.test(lt)) {
    // "عرض السعر رقم 7 اديله 160 ألف" / "العرض رقم 7 ..." / "طلب 7 ..." / "العرض 6-400000"
    const numM =
      lt.match(/(?:رقم|نمره|نمرة)\s*(\d{1,4})(?!\d)/) ||
      lt.match(/طلب\s*(\d{1,4})(?!\d)/) ||
      lt.match(/عرض\s*(\d{1,4})\s*[-–—:=]/);
    if (numM) {
      const rest = lt.slice(numM.index + numM[0].length);
      const price = [...rest.matchAll(new RegExp(P, 'gi'))].map((m) => m[1]).find((x) => parsePrice(x) >= 1000);
      if (price) byNum = [null, numM[1], price];
    }
  }
  let reprice = null; // عرض اتسعّر قبل كده وبيتسعّر تاني
  if (byNum) {
    const num = Number(byNum[1]);
    const pending = (await kv.get(PENDING_QUOTES_KEY, 'json')) || [];
    const q = pending.find((x) => x.n === num);
    if (q) {
      customer = q.customer;
    } else {
      const o = (await getOfferLog(env)).find((x) => x.data.qn === num);
      if (!o) {
        await sendText(agent, `مفيش عرض تركيب رقم ${num}. اكتب 4 عشان تشوف العروض المستنية سعر.`);
        return true;
      }
      customer = o.data.qcustomer;
      reprice = { n: num, customer, who: o.data.client || localPhone(customer), data: o.data };
    }
    priceText = byNum[2];
  }
  if (!customer) {
    // "سعر 6000" → آخر طلب وصل
    const m = lt.match(/^سعر\s+(\d[\d,.]*\s*(?:الف|ألف|k)?)\s*(?:جنيه)?$/i);
    if (!m) return false;
    const pending = (await kv.get(PENDING_QUOTES_KEY, 'json')) || [];
    if (!pending.length) return false; // مش طلب عميل — يكمّل لباقي الأوامر
    customer = pending[0].customer;
    priceText = m[1];
  }

  const price = parsePrice(priceText);
  if (!price) {
    await sendText(agent, 'ابعت السعر رقم بس، مثال: 555000 أو 555 ألف');
    return true;
  }

  const pending = (await kv.get(PENDING_QUOTES_KEY, 'json')) || [];
  const q = reprice || pending.find((x) => x.customer === customer);
  if (!q) {
    await sendText(agent, `الطلب ده اتقفل أو العرض اتبعت قبل كده للعميل ${customer}.`);
    return true;
  }

  // qn/qcustomer بيتحفظوا مع العرض عشان "عرض رقم 5 سعره ..." تشتغل تاني بعد ما يتسعّر
  const data = {
    ...completeOffer({ ...q.data, price: String(price) }),
    date: cairoDate(),
    qn: q.n,
    qcustomer: customer,
  };
  try {
    const [, toCustomer] = await sendOfferFile([agent, customer], data);
    await recordOffer(data, env);
    await kv.put(PENDING_QUOTES_KEY, JSON.stringify(pending.filter((x) => x.customer !== customer)));
    await kv.delete(cquoteKey(customer));
    if (toCustomer) {
      await sendText(customer, 'اتفضل عرض سعر تركيب المصعد 👆 لو عندك أي استفسار إحنا تحت أمرك.');
      await sendText(agent, `✅ العرض اتبعت لـ ${q.who} بسعر ${data.price} ${config.store.currency}`);
    } else {
      await sendText(agent, `⚠️ العرض ما وصلش لـ ${q.who} (عدّى 24 ساعة من آخر رسالة منه) — اعمله Forward من عندك.`);
    }
    // كارت العميل كملف .vcf (فيه السعر) — يتحفظ على الكمبيوتر جنب ملف العرض
    await sendCustomerCard(agent, data, customer, `عرض تركيب رقم ${q.n}`, { wa: false });
    console.log(`[cquote] ${agent} سعّر ${customer}: ${data.price}`);
  } catch (err) {
    console.error('[cquote] docx خطأ:', err.message);
    await sendText(agent, `❌ مقدرتش أطلّع ملف العرض: ${err.message}`);
  }
  return true;
}

/** يبني فاتورة Excel من طلب العميل ويبعتها. */
async function handleInvoice(from, text, env) {
  const products = await searchProducts(text, 30);
  let order = [];
  try {
    order = await extractOrder(text, products);
  } catch (err) {
    console.error('[invoice] extract خطأ:', err.message);
  }

  if (order.length === 0) {
    // "عايز عرض سعر" من غير أصناف → مش واضح: بضاعة من القدس ولا مصعد كامل من توب باور؟
    await askService(from, env, 'تحت أمرك 🙏 حضرتك محتاج عرض سعر لإيه؟');
    return;
  }

  const { lines, missing, grand } = computeInvoice(order, products);
  if (lines.length === 0) {
    await sendText(
      from,
      `مش لاقي الأصناف دي بالظبط: ${missing.join('، ')}\nاكتب أسماءها زي ما هي في المتجر من فضلك.`,
    );
    return;
  }

  const cur = config.store.currency;
  const summary =
    lines.map((l) => `• ${l.name} × ${l.qty} = ${l.total} ${cur}`).join('\n') +
    `\n\nالإجمالي: ${grand} ${cur}` +
    (missing.length ? `\n\n(مش لاقي: ${missing.join('، ')})` : '');
  await sendText(from, `فاتورة مبدئية من ${config.store.name}:\n\n${summary}`);
  ccStaff(`👤 ${from} طلب فاتورة:\n${summary}`, from, env);

  try {
    const xlsx = buildInvoiceXlsx({ lines, grand });
    const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const fname = `فاتورة ${config.store.name}.xlsx`;
    const cap = `فاتورة مبدئية — الإجمالي ${grand} ${cur}`;
    const mediaId = await uploadMedia(xlsx, mime, 'فاتورة.xlsx');
    if (mediaId) {
      await sendDocument(from, mediaId, fname, cap);
      await ccStaffDoc(mediaId, fname, `فاتورة ${from} — ${grand} ${cur}`, from);
    }
  } catch (err) {
    console.error('[invoice] xlsx خطأ:', err.message);
  }

  console.log(`[invoice] ${from}: ${lines.length} صنف، إجمالي ${grand}`);
}

/** تطبيع عربي خفيف للمطابقة. */
function arKey(s) {
  return String(s)
    .toLowerCase()
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/[ىي]/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * يبعت صور المنتجات: اللي اتذكرت بالاسم في الرد، وإلا (لو العميل طلب صورة) أعلى نتيجتين.
 * @returns {Promise<number>} عدد الصور المبعوتة
 */
async function sendProductImages(to, reply, products, forceTop = false) {
  if (!config.sendImages || !Array.isArray(products) || products.length === 0) return 0;
  const r = arKey(reply);

  const withImg = products.filter((p) => p['الاسم'] && p.imageUrl);
  // المنتج اتذكر في الرد: بالاسم كامل، أو بكل كلماته تقريبًا (الرد ممكن يكتب "يمين" بدل "يمن")
  const mentioned = (p) => {
    const name = arKey(p['الاسم']);
    if (r.includes(name)) return true;
    const words = name.split(' ').filter((w) => w.length >= 2);
    return words.length >= 2 && words.filter((w) => r.includes(w)).length >= words.length - 1;
  };
  let list = withImg.filter(mentioned);
  if (list.length === 0 && forceTop) list = withImg.slice(0, 2);

  // dedupe بالصورة، وحد أقصى 10 (كل المنتجات اللي اتعرضت في الرد)
  const seen = new Set();
  const picked = [];
  for (const p of list) {
    if (picked.length >= 10 || seen.has(p.imageUrl)) continue;
    seen.add(p.imageUrl);
    picked.push(p);
  }

  // بالتوازي مش تسلسلي — عشان الرد ميتأخرش لحد ما كل صورة تتبعت
  const results = await Promise.all(
    picked.map((p) =>
      sendImage(to, p.imageUrl, p['السعر'] ? `${p['الاسم']} — ${p['السعر']}` : p['الاسم']),
    ),
  );
  return results.filter(Boolean).length;
}
