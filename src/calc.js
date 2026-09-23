/**
 * أمر الموظف: "احسبلي 3 طرمبة IT، 5 قاعدة طرمبة" → فاتورة (الصنف / العدد / القيمة / الإجمالي
 * + إجمالي الفاتورة) على واتساب + ملف Excel، وبتتبعت للموظف اللي طلبها بس.
 * لو الصنف ينطبق على أكتر من منتج بيسأل "تقصد أنهي؟" ويستنى رقم الاختيار.
 * الأسعار من المتجر (بعد أي تعديل سعر يدوي).
 */
import { config } from './config.js';
import { searchProducts, normalizeAr } from './catalog.js';
import { sendText, uploadMedia, sendDocument } from './whatsapp.js';
import { buildInvoiceXlsx } from './invoice.js';

const latin = (s) => s.replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
const round = (n) => Math.round(n * 100) / 100;
const KEY = (agent) => `calc:pending:${agent}`;

/** "3 طرمبة IT" أو "طرمبة IT 3" أو "طرمبة IT × 3" → { qty, query } */
function parseItem(raw) {
  const s = latin(raw).replace(/[×xX*]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  let m = s.match(/^(\d+(?:\.\d+)?)\s+(.+)$/);
  if (m) return { qty: Number(m[1]), query: m[2].trim() };
  m = s.match(/^(.+?)\s+(\d+(?:\.\d+)?)$/);
  if (m) return { qty: Number(m[2]), query: m[1].trim() };
  return { qty: 1, query: s };
}

function splitItems(body) {
  return body
    .split(/[\n،,؛;]+|\s+و\s+|\s+و(?=\d)/)
    .map(parseItem)
    .filter(Boolean);
}

/** لو الأول تطابق تام بالاسم أو نتيجة واحدة → محسوم، وإلا خيارات. */
function decide(query, results) {
  if (results.length === 0) return { none: true };
  const q = normalizeAr(query);
  const exact = results.filter((r) => normalizeAr(r['الاسم']) === q);
  if (exact.length === 1) return { pick: exact[0] };
  if (results.length === 1) return { pick: results[0] };
  return { options: results.slice(0, 6) };
}

function askOptions(item) {
  return (
    `الصنف "${item.query}" (العدد ${item.qty}) ينطبق على أكتر من منتج، تقصد أنهي؟ ابعت رقمه:\n` +
    item.options.map((p, i) => `${i + 1}. ${p['الاسم']} — ${p['السعر']}`).join('\n') +
    '\n\n(أو اكتب: تخطي — أو: الغاء)'
  );
}

async function finish(agent, items, env) {
  const cur = config.store.currency;
  const lines = [];
  const missing = [];
  for (const it of items) {
    if (!it.chosen) {
      missing.push(it.query);
      continue;
    }
    const unit = Number(it.chosen._price);
    if (!Number.isFinite(unit)) {
      missing.push(`${it.chosen['الاسم']} (السعر غير محدد)`);
      continue;
    }
    lines.push({ name: it.chosen['الاسم'], qty: it.qty, unit, total: round(unit * it.qty) });
  }
  if (!lines.length) {
    await sendText(agent, 'مفيش أصناف اتحسبت.' + (missing.length ? `\n⚠️ مش لاقي: ${missing.join('، ')}` : ''));
    return;
  }
  const grand = round(lines.reduce((a, l) => a + l.total, 0));
  const pieces = lines.reduce((a, l) => a + Number(l.qty), 0);
  await sendText(
    agent,
    '🧾 الفاتورة\n\n' +
      lines
        .map((l, i) => `${i + 1}. ${l.name}\n   العدد: ${l.qty} × القيمة: ${l.unit} = ${l.total} ${cur}`)
        .join('\n') +
      `\n\n━━━━━━━━\nعدد الأصناف: ${lines.length} (القطع: ${pieces})\n✅ إجمالي الفاتورة: ${grand} ${cur}` +
      (missing.length ? `\n\n⚠️ مش لاقي: ${missing.join('، ')}` : ''),
  );
  try {
    const xlsx = buildInvoiceXlsx({ lines, grand });
    const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const mediaId = await uploadMedia(xlsx, mime, 'فاتورة.xlsx');
    if (mediaId) await sendDocument(agent, mediaId, `فاتورة ${config.store.name}.xlsx`, `الإجمالي ${grand} ${cur}`);
  } catch (err) {
    console.error('[calc] xlsx خطأ:', err.message);
  }
}

/** بيمشي على الأصناف لحد أول صنف محتاج اختيار، أو بيطلّع الفاتورة. */
async function advance(agent, items, env) {
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (it.chosen || it.skipped) continue;
    if (!it.options) {
      const results = await searchProducts(it.query, 8);
      const d = decide(it.query, results);
      if (d.pick) {
        it.chosen = d.pick;
        continue;
      }
      if (d.none) {
        it.skipped = true;
        continue;
      }
      it.options = d.options;
    }
    await env.MEMORY.put(KEY(agent), JSON.stringify({ items, cur: i }), { expirationTtl: 900 });
    await sendText(agent, askOptions(it));
    return;
  }
  await env.MEMORY.delete(KEY(agent));
  await finish(agent, items, env);
}

/** @returns {Promise<boolean>} true لو الرسالة كانت أمر حساب أو رد على سؤال اختيار */
export async function handleStaffCalc(agent, text, env) {
  if (!env?.MEMORY) return false;
  const t = latin(text).trim();

  // "احسبلي فاتورة" لوحدها → يسأل عن الأصناف، والرسالة الجاية هي الأصناف
  const askKey = `calc:ask:${agent}`;
  if (/^(?:احسب|اعمل)(?:\s*لي|لى|ي)?(?:\s+فاتور[هة])?[\s:،-]*$/.test(t)) {
    await env.MEMORY.put(askKey, '1', { expirationTtl: 600 });
    await sendText(agent, 'تمام 🧾 ابعتلي المنتجات والأعداد، مثال:\n3 طرمبة IT تركي\n2 قاعدة طرمبة\n(أو اكتب: الغاء)');
    return true;
  }
  if (await env.MEMORY.get(askKey)) {
    await env.MEMORY.delete(askKey);
    if (/^(?:الغاء|إلغاء)$/.test(t)) {
      await sendText(agent, 'تمام، لغيت الفاتورة.');
      return true;
    }
    const items = splitItems(t);
    if (items.length) {
      await advance(agent, items, env);
      return true;
    }
  }

  const pending = await env.MEMORY.get(KEY(agent), 'json');
  if (pending) {
    if (/^(?:الغاء|إلغاء)$/.test(t)) {
      await env.MEMORY.delete(KEY(agent));
      await sendText(agent, 'تمام، لغيت الفاتورة.');
      return true;
    }
    const items = pending.items;
    const it = items[pending.cur];
    if (/^تخطي$/.test(t)) {
      it.skipped = true;
      await advance(agent, items, env);
      return true;
    }
    const n = t.match(/^(\d{1,2})$/);
    if (n && it.options[Number(n[1]) - 1]) {
      it.chosen = it.options[Number(n[1]) - 1];
      await advance(agent, items, env);
      return true;
    }
  }

  const m = t.match(/^(?:احسب|اعمل)(?:\s*لي|لى|ي)?(?:\s+فاتور[هة])?[\s:،-]+([\s\S]+)$/);
  if (!m) return false;
  const items = splitItems(m[1]);
  if (!items.length) {
    await sendText(agent, 'ابعت الأصناف والكميات بعد الكلمة، مثال:\nاحسبلي 3 طرمبة IT تركي، 5 قاعدة طرمبة');
    return true;
  }
  await advance(agent, items, env);
  return true;
}
