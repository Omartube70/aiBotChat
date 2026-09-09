/**
 * نقطة تشغيل Cloudflare Workers.
 *  - بيرد على تحقّق الـ webhook فوراً.
 *  - رسائل واتساب: بيرجّع 200 على طول، والمعالجة (بحث + Gemini + رد)
 *    بتكمّل في ctx.waitUntil() عشان Meta ما تعيدش إرسال نفس الرسالة.
 *
 * محلياً استخدم src/server.js (Express). الملف ده للـ Workers بس.
 */
import { config, applyEnv } from './config.js';
import { generateReply, transcribeAudio, extractOrder } from './gemini.js';
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
} from './whatsapp.js';
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
} from './memory.js';
import { catalogStats, searchProducts } from './catalog.js';
import { synthesize } from './tts.js';
import { computeInvoice, buildInvoiceXlsx } from './invoice.js';

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
    applyEnv(env); // رخيص و idempotent — بنعمله كل request
    const url = new URL(request.url);
    const { pathname } = url;
    const { method } = request;

    /* ---------- فحص صحة الخدمة ---------- */
    if (method === 'GET' && pathname === '/') {
      return new Response('QUDS WhatsApp bot ✅');
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

    if (pathname === '/debug/search' && env.ENABLE_DEBUG_CHAT === '1') {
      const q = url.searchParams.get('q') || '';
      try {
        return Response.json({ q, results: await searchProducts(q, 8) });
      } catch (err) {
        return Response.json({ error: err.message }, { status: 500 });
      }
    }

    /* ---------- استقبال الرسائل ---------- */
    if (method === 'POST' && pathname === '/webhook') {
      let body = {};
      try {
        body = await request.json();
      } catch {
        /* جسم فاضي أو مش JSON — نتجاهله */
      }

      const messages = parseIncoming(body);
      ctx.waitUntil(
        (async () => {
          for (const msg of messages) {
            if (alreadyHandled(msg.id)) continue;
            try {
              await handleMessage(msg, env);
            } catch (err) {
              console.error('[handleMessage] خطأ:', err);
            }
          }
        })(),
      );

      return new Response('OK', { status: 200 });
    }

    return new Response('Not found', { status: 404 });
  },
};

const MAX_AUDIO_BYTES = 3 * 1024 * 1024; // فوق كده تفريغ الـ base64 ممكن يعدّي حد الـ CPU

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

  // رسالة من موظف (مدير/حسابات) → توجيه ردّه للعميل
  if (agentNumbers().includes(from)) {
    await handleAgentMessage(from, text, env);
    return;
  }

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
      await sendText(
        from,
        'حصلت مشكلة في تحويل الصوت لنص. اكتبلي اسم المنتج من فضلك 🙏',
      );
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

  const who = `${msg.name ? msg.name + ' ' : ''}${from}`;

  // نسخة من كل رسالة عميل تتبعت لأرقام المتابعة (fire-and-forget)
  for (const n of config.agent.ccNumbers) {
    if (n !== from) sendText(n, `👤 ${who}\n${text}`).catch(() => {});
  }

  // العميل متحوّل لموظف → ننقل رسالته له والبوت ساكت
  const mode = await getMode(from, env);
  if (mode && mode !== 'bot') {
    await setMode(from, env, mode, config.agent.handoffTtl); // تجديد المهلة
    await setLastHandoff(mode, from, env, config.agent.handoffTtl);
    await sendText(mode, `💬 ${who}:\n${text}`);
    console.log(`[human:${mode}] ${from}: ${text}`);
    return;
  }

  // فاتورة / بيان أسعار → نعملها Excel أوتوماتيك
  if (wantsInvoice(text)) {
    await handleInvoice(from, text, env);
    return;
  }

  // تحويل لقسم الحسابات
  if (wantsAccounts(text) && config.agent.accounts) {
    await handoff(from, who, text, config.agent.accounts, 'الحسابات', env);
    return;
  }
  // تحويل للمدير
  if (wantsHuman(text) && config.agent.manager) {
    await handoff(from, who, text, config.agent.manager, 'المدير', env);
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
    const out = await generateReply(text, history);
    reply = out.reply;
    products = out.products || [];
    await saveHistory(from, out.history, env);
  } catch (err) {
    console.error('[gemini] خطأ:', err.message);
    reply = `معلش حصل خطأ مؤقت. جرّب تاني بعد شوية أو كلمنا على واتساب: ${config.store.whatsapp}`;
  }

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
  if (!deliveredAsVoice) await sendText(from, reply);

  const pics = await sendProductImages(from, reply, products, wantsImage(text));

  if (wantsLocation(text)) {
    await sendLocation(from, {
      lat: config.store.lat,
      lng: config.store.lng,
      name: config.store.name,
      address: config.store.address,
    });
  }

  console.log(
    `[reply${deliveredAsVoice ? ':voice' : ''}${pics ? `:${pics}img` : ''}] ${from}: ${reply.replace(/\n/g, ' ')}`,
  );
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
      [config.agent.manager, config.agent.accounts, ...config.agent.ccNumbers].filter(Boolean),
    ),
  ];
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

function wantsInvoice(text) {
  const s = arKey(text);
  return [
    'فاتوره', 'فاتورة', 'بيان اسعار', 'بيان بالاسعار', 'بيان بأسعار', 'بيان سعر',
    'عرض سعر', 'عرض اسعار', 'كشف اسعار', 'قايمه اسعار', 'قائمه اسعار', 'كوتيشن',
    'quotation', 'quote', 'invoice',
  ].some((k) => s.includes(k));
}

/** يحوّل العميل لموظف قسم معيّن. */
async function handoff(from, who, text, agentNum, deptLabel, env) {
  await setMode(from, env, agentNum, config.agent.handoffTtl);
  await setLastHandoff(agentNum, from, env, config.agent.handoffTtl);
  await sendText(from, `تمام، هوصّلك بـ${deptLabel} من المحل 🙏 هيكلمك حالًا.`);
  await sendText(
    agentNum,
    `🔔 عميل عايز ${deptLabel}: ${who}\nآخر رسالة: ${text}\n\n` +
      `للرد اكتب رسالتك عادي (هتروح له).\nللإنهاء اكتب: /bot`,
  );
  console.log(`[handoff:${deptLabel}] ${from}: ${text}`);
}

/** رسالة من موظف: /bot تنهي التحويل، وأي رسالة تانية تتبعت لآخر عميل تحوّل له. */
async function handleAgentMessage(agent, text, env) {
  const t = (text || '').trim();
  if (!t) return;

  if (/^\/bot\b/i.test(t) || ['تم', 'خلاص', 'انهاء', 'اقفل'].includes(t)) {
    const m = t.match(/(\d{9,15})/);
    const target = m ? m[1] : await getLastHandoff(agent, env);
    if (!target) {
      await sendText(agent, 'مفيش محادثة محوّلة حاليًا.');
      return;
    }
    await setMode(target, env, 'bot');
    await sendText(agent, `✅ رجّعت العميل ${target} للبوت.`);
    await sendText(target, 'رجعنا لخدمة الأسئلة والأسعار 👍 اسأل عن أي منتج.');
    return;
  }

  let target;
  let body = t;
  const m = t.match(/^\+?(\d{10,15})[\s:،,-]+([\s\S]+)$/);
  if (m) {
    target = m[1];
    body = m[2].trim();
  } else {
    target = await getLastHandoff(agent, env);
  }
  if (!target) {
    await sendText(agent, 'اكتب رقم العميل في أول الرسالة، مثال:\n201234567890 السعر متاح عندنا');
    return;
  }

  await sendText(target, body);
  await setMode(target, env, agent, config.agent.handoffTtl);
  await setLastHandoff(agent, target, env, config.agent.handoffTtl);
  await sendText(agent, `➡️ اتبعت لـ ${target}`);
  console.log(`[agent ${agent}→${target}] ${body}`);
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
    await sendText(
      from,
      'تمام، ابعتلي الأصناف والكميات كده:\nمثال: 3 طرمبة IT تركي، 5 قاعدة طرمبة، 2 كاوتشة طرمبة',
    );
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

  try {
    const xlsx = buildInvoiceXlsx({ lines, grand });
    const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const mediaId = await uploadMedia(xlsx, mime, 'فاتورة.xlsx');
    if (mediaId) {
      await sendDocument(
        from,
        mediaId,
        `فاتورة ${config.store.name}.xlsx`,
        `فاتورة مبدئية — الإجمالي ${grand} ${cur}`,
      );
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
  let list = withImg.filter((p) => r.includes(arKey(p['الاسم'])));
  if (list.length === 0 && forceTop) list = withImg.slice(0, 2);

  const sentUrls = new Set();
  let sent = 0;
  for (const p of list) {
    if (sent >= 3 || sentUrls.has(p.imageUrl)) continue;
    sentUrls.add(p.imageUrl);
    const caption = p['السعر'] ? `${p['الاسم']} — ${p['السعر']}` : p['الاسم'];
    if (await sendImage(to, p.imageUrl, caption)) sent++;
  }
  return sent;
}
