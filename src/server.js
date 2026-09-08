import express from 'express';
import { config } from './config.js';
import { generateReply } from './gemini.js';
import { sendText, markRead, parseIncoming } from './whatsapp.js';
import { getHistory, saveHistory, resetHistory } from './memory.js';
import { catalogStats } from './catalog.js';

const app = express();
app.use(express.json({ limit: '1mb' }));

// منع معالجة نفس الرسالة مرتين (Meta بتعيد الإرسال أحياناً)
const seen = new Set();
function alreadyHandled(id) {
  if (!id) return false;
  if (seen.has(id)) return true;
  seen.add(id);
  if (seen.size > 2000) seen.clear();
  return false;
}

/* ---------- فحص صحة الخدمة ---------- */
app.get('/', (_req, res) => res.send('QUDS WhatsApp bot ✅'));
app.get('/health', async (_req, res) => {
  try {
    const stats = await catalogStats();
    res.json({ ok: true, catalog: stats });
  } catch (err) {
    res.status(200).json({ ok: true, catalog: 'غير محمّل بعد', error: err.message });
  }
});

/* ---------- تحقق الـ Webhook (Meta) ---------- */
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === config.whatsapp.verifyToken) {
    console.log('[webhook] تم التحقق ✅');
    return res.status(200).send(challenge);
  }
  return res.sendStatus(403);
});

/* ---------- استقبال الرسائل ---------- */
app.post('/webhook', (req, res) => {
  res.sendStatus(200); // نرد بسرعة، والمعالجة بتكمّل ورا

  const messages = parseIncoming(req.body);
  for (const msg of messages) {
    if (alreadyHandled(msg.id)) continue;
    handleMessage(msg).catch((err) =>
      console.error('[handleMessage] خطأ:', err),
    );
  }
});

async function handleMessage(msg) {
  const { from, text, id, type } = msg;
  if (!from) return;

  markRead(id);

  if (type !== 'text' && !text) {
    await sendText(
      from,
      'أهلاً بيك 👋 ابعتلنا اسم المنتج اللي محتاج تعرف سعره، وهنرد عليك على طول.',
    );
    return;
  }

  const lower = text.toLowerCase();
  if (['/reset', 'ابدأ من جديد', 'restart'].includes(lower)) {
    resetHistory(from);
    await sendText(from, 'اتمسحت المحادثة. اسأل عن أي منتج 👍');
    return;
  }

  console.log(`[msg] ${from}: ${text}`);

  const history = getHistory(from);
  let reply;
  try {
    const out = await generateReply(text, history);
    reply = out.reply;
    saveHistory(from, out.history);
  } catch (err) {
    console.error('[gemini] خطأ:', err.message);
    reply = `معلش حصل خطأ مؤقت. جرّب تاني بعد شوية أو كلمنا على واتساب: ${config.store.whatsapp}`;
  }

  await sendText(from, reply);
  console.log(`[reply] ${from}: ${reply.replace(/\n/g, ' ')}`);
}

/* ---------- اختبار سريع بدون واتساب (اختياري) ---------- */
// POST /debug/chat { "text": "سعر باب فورجيه", "user": "test1" }
if (process.env.ENABLE_DEBUG_CHAT === '1') {
  app.post('/debug/chat', async (req, res) => {
    const text = req.body?.text || '';
    const user = req.body?.user || 'debug';
    try {
      const out = await generateReply(text, getHistory(user));
      saveHistory(user, out.history);
      res.json({ reply: out.reply });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
  console.log('[debug] /debug/chat مفعّل');
}

app.listen(config.port, () => {
  console.log(`🚀 البوت شغّال على البورت ${config.port}`);
  console.log(`   Webhook verify token: ${config.whatsapp.verifyToken}`);
});
