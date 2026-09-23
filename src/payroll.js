/**
 * رواتب الموظفين الأسبوعية من واتساب (من رقم AGENT_PAYROLL بس) — نفس منطق شيت رواتب.xlsx:
 *   قيمة اليوم = قيمة القبض ÷ 12
 *   الراتب النهائي = قيمة اليوم × الحضور − السلف
 * البيانات بتتخزّن في KV (payroll:data) ومش بتتربط بأي حاجة تانية.
 *
 * الأوامر:
 *   هند بتاخد 6000      → قيمة القبض
 *   هند سلف 500         → يزوّد على السلف
 *   هند حضور 10         → عدد أيام الحضور
 *   راتب هند            → حضور + سلف + قيمة القبض + الراتب النهائي
 *   الرواتب             → كل الموظفين
 *   تصفير هند / تصفير الرواتب → يبدأ فترة جديدة (بيصفّر الحضور والسلف بس)
 */
import { config } from './config.js';
import { sendText, uploadMedia, sendDocument } from './whatsapp.js';
import { buildTableXlsx } from './invoice.js';

const DEFAULT_EMPLOYEES = ['هند', 'ابو زياد', 'علاء', 'ابو فارس', 'اشرف', 'محمود جمال', 'رمضان', 'محمود منيا'];
const KEY = 'payroll:data';
const EMPS_KEY = 'payroll:emps';
let EMPLOYEES = [...DEFAULT_EMPLOYEES];
const DAYS = 12;

const norm = (s) =>
  String(s)
    .toLowerCase()
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .replace(/[^\p{L}\p{N}\s.]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const latin = (s) => s.replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));

function findEmployee(s) {
  const padded = ` ${s} `;
  // الأطول أولًا عشان "محمود جمال" يتقدّم على أي اسم أقصر
  return [...EMPLOYEES]
    .sort((a, b) => b.length - a.length)
    .find((e) => padded.includes(` ${norm(e)} `));
}

const fmt = (n) => (Math.round(n * 100) / 100).toString();

function report(name, r = {}) {
  const base = r.base || 0;
  const att = r.att || 0;
  const adv = r.adv || 0;
  const day = base / DAYS;
  const net = day * att - adv;
  return (
    `👤 ${name}\n` +
    `• حضور: ${att}\n` +
    `• سلف: ${adv}\n` +
    `• قيمة القبض: ${base}\n` +
    `• قيمة اليوم: ${fmt(day)}\n` +
    `💰 الراتب النهائي: ${fmt(net)} ${config.store.currency}`
  );
}


const BULK_TRIGGERS = ['رواتب الموظفين', 'حساب الرواتب', 'حساب رواتب الموظفين', 'رواتب الكل', 'رواتب كلهم'];
const isNum = (x) => /^\d+(?:\.\d+)?$/.test(x);
const ALL_FULL_RE = /^(?:كلهم|الكل) (?:كامل|تمام)$/;

/** يقسّم الرسالة لأجزاء لكل موظف اتذكر بالاسم (مطابقة أطول اسم الأول). */
function parseBulk(text) {
  const firsts = new Set(EMPLOYEES.map((e) => norm(e).split(' ')[0]));
  const tokens = norm(latin(text))
    .split(' ')
    .filter(Boolean)
    // "وعلاء" (واو العطف ملزوقة بالاسم) → "علاء"
    .map((x) => (x.startsWith('و') && !firsts.has(x) && firsts.has(x.slice(1)) ? x.slice(1) : x));
  const names = [...EMPLOYEES].sort((a, b) => b.length - a.length).map((e) => ({ e, w: norm(e).split(' ') }));
  const hits = [];
  const used = new Set();
  for (let i = 0; i < tokens.length; i++) {
    for (const { e, w } of names) {
      if (w.every((x, k) => tokens[i + k] === x) && !w.some((_, k) => used.has(i + k))) {
        hits.push({ e, start: i, end: i + w.length });
        w.forEach((_, k) => used.add(i + k));
        break;
      }
    }
  }
  const result = {};
  hits.forEach((h, idx) => {
    const seg = tokens
      .slice(h.end, idx + 1 < hits.length ? hits[idx + 1].start : tokens.length)
      .map((x) => x.replace(/^و(?=\d|سلف|غياب|غايب)/, ''))
      .filter((x) => x !== 'و');
    let adv = 0;
    let absent = 0;
    const rest = [];
    for (let i = 0; i < seg.length; i++) {
      const x = seg[i];
      const kind = x.startsWith('سلف') ? 'adv' : x.startsWith('غياب') || x.startsWith('غايب') ? 'abs' : null;
      if (!kind) {
        rest.push(x);
        continue;
      }
      const inline = x.match(/(\d+(?:\.\d+)?)/);
      let v = inline ? Number(inline[1]) : null;
      if (v == null && rest.length && isNum(rest[rest.length - 1])) v = Number(rest.pop());
      else if (v == null && isNum(seg[i + 1] || '')) v = Number(seg[++i]);
      if (kind === 'adv') adv += v || 0;
      else absent += v || 0;
    }
    const firstNum = rest.find(isNum);
    result[h.e] = { att: firstNum != null ? Number(firstNum) : DAYS - absent, adv };
  });
  // اسم أول مشترك (زي "محمود") اتكتب لوحده من غير الاسم الكامل
  const firstWords = EMPLOYEES.map((e) => norm(e).split(' ')).filter((w) => w.length > 1).map((w) => w[0]);
  const ambiguous = [...new Set(tokens.filter((x, i) => !used.has(i) && firstWords.includes(x)))];
  return { result, ambiguous };
}

/** يحسب رواتب كل الموظفين مرة واحدة (اللي متذكرش = 12 يوم من غير سلف) ويبعت رسالة + Excel. */
async function runBulk(agent, text, kv, all) {
  const { result, ambiguous } = all ? { result: {}, ambiguous: [] } : parseBulk(text);
  if (ambiguous.length) {
    await sendText(
      agent,
      `فيه أكتر من موظف باسم "${ambiguous.join('، ')}" — اكتب الاسم كامل (مثلاً محمود جمال أو محمود منيا) وابعت الرسالة تاني.`,
    );
    return false;
  }
  if (!all && !Object.keys(result).length) {
    await sendText(agent, 'مفهمتش أي اسم موظف. مثال: اشرف 11 و500 سلف، علاء 9 ايام وسلفه 700 (أو اكتب: كلهم كامل).');
    return false;
  }
  const cur = config.store.currency;
  const data = (await kv.get(KEY, 'json')) || {};
  const rows = [['الموظف', 'قيمة القبض', 'قيمة اليوم', 'الحضور', 'السلف', `الراتب النهائي (${cur})`]];
  const lines = [];
  const noBase = [];
  let total = 0;
  EMPLOYEES.forEach((e, i) => {
    const r = result[e] || { att: DAYS, adv: 0 };
    const base = data[e]?.base || 0;
    if (!base) noBase.push(e);
    const day = base / DAYS;
    const net = Math.round((day * r.att - r.adv) * 100) / 100;
    total += net;
    data[e] = { base, att: r.att, adv: r.adv };
    rows.push([e, base, Math.round(day * 100) / 100, r.att, r.adv, net]);
    lines.push(`${i + 1}. ${e}: قبض ${base} | حضور ${r.att} | سلف ${r.adv} ← ${fmt(net)}`);
  });
  total = Math.round(total * 100) / 100;
  rows.push([]);
  rows.push(['الإجمالي', '', '', '', '', total]);
  await kv.put(KEY, JSON.stringify(data));

  let msg = `💰 رواتب الموظفين (الفترة ${DAYS} يوم)\n\n${lines.join('\n')}\n\n━━━━━━━━\n✅ إجمالي الرواتب: ${fmt(total)} ${cur}`;
  if (noBase.length) msg += `\n\n⚠️ قيمة القبض مش متسجّلة لـ: ${noBase.join('، ')} (اكتب: تعديل رواتب)`;
  await sendText(agent, msg);
  try {
    const mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    const mediaId = await uploadMedia(buildTableXlsx(rows, 'الرواتب'), mime, 'رواتب.xlsx');
    if (mediaId) await sendDocument(agent, mediaId, 'رواتب الموظفين.xlsx', `إجمالي الرواتب ${fmt(total)}`);
  } catch (err) {
    console.error('[payroll] xlsx خطأ:', err.message);
  }
  return true;
}


const TOPIC_WORDS = ['موظف', 'موظفين', 'الموظفين', 'الموظف', 'راتب', 'رواتب', 'الرواتب', 'مرتب', 'مرتبات', 'المرتبات', 'سلف', 'السلف', 'حضور', 'غياب'];

/** أي رسالة قصيرة من الإدارة فيها كلمة موظف/راتب/سلف... → البوت يفهم إنه موضوع الرواتب ويعرض الأوامر. */
async function payrollTopicMenu(agent, s, kv) {
  const words = s.split(' ');
  if (words.length > 6 || /^(?:زبون|ابعت|عرض|عرض رقم)/.test(s)) return false;
  if (!words.some((w) => TOPIC_WORDS.includes(w))) return false;
  if (!config.agent.payroll.includes(agent)) return false;
  const menu = [
    '💼 موضوع الرواتب — تحب إيه؟',
    '',
    '• رواتب الموظفين → حساب كل الرواتب مرة واحدة + Excel',
    '• راتب <اسم> → راتب موظف واحد (بيسألك السلف والحضور)',
    '• تغيير رواتب → تعديل قيمة القبض لموظف',
    '• اضافة موظف <اسم> <قيمة القبض>',
    '• حذف موظف <اسم>',
    '• الرواتب → عرض آخر حساب',
    '',
    'الموظفين: ' + EMPLOYEES.join('، '),
  ].join('\n');
  await sendText(agent, menu);
  return true;
}

/** @returns {Promise<boolean>} true لو الرسالة كانت أمر رواتب واتعامل معاها */
export async function handlePayroll(agent, text, env) {
  const s = norm(latin(text));

  // "تعديل رواتب" → يعرض قيمة القبض المحفوظة لكل موظف ويفتح وضع تعديل (10 دقايق):
  // كل سطر "اسم رقم" يغيّر قيمة القبض، و"خلاص" تقفل الوضع.
  const kv0 = env?.MEMORY;
  if (kv0) EMPLOYEES = (await kv0.get(EMPS_KEY, 'json')) || [...DEFAULT_EMPLOYEES];

  // "اضافة موظف سعيد 5000" / "حذف موظف سعيد"
  const addM = s.match(/^(?:اضافه|ضيف|اضف) موظف ([^\d]+?)\s*(\d+(?:\.\d+)?)?$/);
  const delM = s.match(/^(?:حذف|امسح|شيل) موظف (.+)$/);
  if ((addM || delM) && kv0 && config.agent.payroll.includes(agent)) {
    const d = (await kv0.get(KEY, 'json')) || {};
    if (addM) {
      const name = addM[1].trim();
      if (!EMPLOYEES.includes(name)) EMPLOYEES.push(name);
      d[name] = { base: Number(addM[2] || 0), att: 0, adv: 0 };
      await kv0.put(EMPS_KEY, JSON.stringify(EMPLOYEES));
      await kv0.put(KEY, JSON.stringify(d));
      await sendText(
        agent,
        `✅ اتضاف الموظف ${name}` +
          (addM[2] ? ` بقيمة قبض ${addM[2]}` : `\n(لسه من غير قيمة قبض — اكتب: ${name} بياخد <المبلغ>)`),
      );
    } else {
      const e = findEmployee(delM[1].trim());
      if (!e) {
        await sendText(agent, 'مش لاقي موظف بالاسم ده.');
        return true;
      }
      EMPLOYEES = EMPLOYEES.filter((x) => x !== e);
      delete d[e];
      await kv0.put(EMPS_KEY, JSON.stringify(EMPLOYEES));
      await kv0.put(KEY, JSON.stringify(d));
      await sendText(agent, `✅ اتحذف الموظف ${e}.`);
    }
    return true;
  }
  // ---- حوار قبض الراتب: "راتب محمود" → سلف كام؟ → حضور كام؟ → الراتب النهائي ----
  const flowKey = `payroll:flow:${agent}`;
  const bulkKey = `payroll:bulk:${agent}`;
  if (kv0 && config.agent.payroll.includes(agent)) {
    // "رواتب الموظفين" → كل الرواتب مرة واحدة (اللي متذكرش يتحسب 12 يوم من غير سلف)
    const words = s.split(' ');
    const TRIG_WORDS = ['رواتب', 'الرواتب', 'مرتبات', 'المرتبات', 'كل', 'الكل', 'كلهم', 'الموظفين', 'موظفين', 'الجميع', 'حساب', 'احسب', 'احسبلي', 'ال', 'لكل', 'بتاع', 'بتوع'];
    const trig =
      (words.some((w) => ['رواتب', 'الرواتب', 'مرتبات', 'المرتبات'].includes(w)) &&
        words.some((w) => ['كل', 'الكل', 'كلهم', 'الموظفين', 'موظفين', 'الجميع'].includes(w))) ||
      BULK_TRIGGERS.some((k) => s.startsWith(norm(k)));
    if (trig) {
      const rest = words.filter((w) => !TRIG_WORDS.includes(w)).join(' ');
      if (rest) {
        await runBulk(agent, text, kv0, /^(?:كامل|تمام)$/.test(rest));
      } else {
        await kv0.put(bulkKey, '1', { expirationTtl: 600 });
        await sendText(
          agent,
          '💰 رواتب الموظفين\nابعت الحضور والسلف للي اتغيّر بس، والباقي هيتحسب 12 يوم من غير سلف.\n' +
            'مثال:\nاشرف 11 و500 سلف، علاء 9 ايام وسلفه 700\n(أو: هند غياب 2)\nولو الكل كامل اكتب: كلهم كامل',
        );
      }
      return true;
    }
    if (await kv0.get(bulkKey)) {
      if (['الغاء', 'خلاص'].includes(s)) {
        await kv0.delete(bulkKey);
        await sendText(agent, 'تمام، لغيت.');
        return true;
      }
      if (await runBulk(agent, text, kv0, ALL_FULL_RE.test(s))) await kv0.delete(bulkKey);
      return true;
    }
    const flow = await kv0.get(flowKey, 'json');
    const numOnly = s.match(/^(\d+(?:\.\d+)?)$/);
    if (flow) {
      if (['الغاء', 'خلاص'].includes(s)) {
        await kv0.delete(flowKey);
        await sendText(agent, 'تمام، لغيت.');
        return true;
      }
      // تعديل قيمة القبض: اسم الموظف ← القيمة الجديدة
      if (flow.step === 'editname') {
        const tokens = s.split(' ');
        const cands = EMPLOYEES.filter((e) => norm(e).split(' ').some((w) => tokens.includes(w)));
        if (cands.length === 1) {
          const d = (await kv0.get(KEY, 'json')) || {};
          await kv0.put(flowKey, JSON.stringify({ step: 'editval', emp: cands[0] }), { expirationTtl: 600 });
          await sendText(agent, `👤 ${cands[0]} (قيمة القبض الحالية: ${d[cands[0]]?.base || 0})\nقيمة القبض الجديدة كام؟`);
        } else if (cands.length > 1) {
          await kv0.put(flowKey, JSON.stringify({ step: 'pick', kind: 'edit', cands }), { expirationTtl: 600 });
          await sendText(agent, 'تقصد مين؟ ابعت رقمه:\n' + cands.map((c, i) => `${i + 1}. ${c}`).join('\n'));
        } else {
          await sendText(agent, 'مش لاقي موظف بالاسم ده، اكتب الاسم تاني (أو اكتب: الغاء).');
        }
        return true;
      }
      if (flow.step === 'editval' && numOnly) {
        const d = (await kv0.get(KEY, 'json')) || {};
        const old = d[flow.emp]?.base || 0;
        d[flow.emp] = { base: Number(numOnly[1]), att: d[flow.emp]?.att || 0, adv: d[flow.emp]?.adv || 0 };
        await kv0.put(KEY, JSON.stringify(d));
        await kv0.delete(flowKey);
        await sendText(agent, `✅ ${flow.emp}: قيمة القبض اتغيّرت من ${old} إلى ${numOnly[1]} (قيمة اليوم ${fmt(Number(numOnly[1]) / DAYS)}).`);
        return true;
      }
      if (flow.step === 'pick' && numOnly && flow.cands[Number(numOnly[1]) - 1]) {
        const emp = flow.cands[Number(numOnly[1]) - 1];
        if (flow.kind === 'edit') {
          const d = (await kv0.get(KEY, 'json')) || {};
          await kv0.put(flowKey, JSON.stringify({ step: 'editval', emp }), { expirationTtl: 600 });
          await sendText(agent, `👤 ${emp} (قيمة القبض الحالية: ${d[emp]?.base || 0})\nقيمة القبض الجديدة كام؟`);
          return true;
        }
        await kv0.put(flowKey, JSON.stringify({ step: 'adv', emp }), { expirationTtl: 600 });
        await sendText(agent, `👤 ${emp}\nواخد سلف كام؟ (اكتب 0 لو مش واخد)`);
        return true;
      }
      if (flow.step === 'adv' && numOnly) {
        await kv0.put(flowKey, JSON.stringify({ ...flow, step: 'att', adv: Number(numOnly[1]) }), { expirationTtl: 600 });
        await sendText(agent, `حضر كام يوم؟`);
        return true;
      }
      if (flow.step === 'att' && numOnly) {
        const data = (await kv0.get(KEY, 'json')) || {};
        const base = data[flow.emp]?.base || 0;
        const att = Number(numOnly[1]);
        data[flow.emp] = { base, att, adv: flow.adv };
        await kv0.put(KEY, JSON.stringify(data));
        await kv0.delete(flowKey);
        const day = base / DAYS;
        const net = day * att - flow.adv;
        await sendText(
          agent,
          `💰 راتب ${flow.emp}\n` +
            `• قيمة القبض: ${base}${base ? '' : ' ⚠️ مش متسجّلة — اكتب: تعديل رواتب'}\n` +
            `• قيمة اليوم: ${fmt(day)}\n` +
            `• حضور: ${att} يوم ← ${fmt(day * att)}\n` +
            `• سلف: ${flow.adv}\n` +
            `✅ الراتب النهائي: ${fmt(net)} ${config.store.currency}`,
        );
        return true;
      }
    }
    // بداية تعديل قيمة القبض: "تعديل رواتب" / "تغيير رواتب"
    if (['تعديل رواتب', 'تعديل الرواتب', 'تعديل القبض', 'تغيير رواتب', 'تغيير الرواتب', 'تغير رواتب', 'تغير الرواتب'].includes(s)) {
      await kv0.put(flowKey, JSON.stringify({ step: 'editname' }), { expirationTtl: 600 });
      await sendText(agent, '✏️ تعديل قيمة القبض\nاسم الموظف إيه؟');
      return true;
    }
    // بداية الحوار: "راتب محمود" (من غير أرقام)
    const startM = s.match(/^(?:راتب|مرتب|حساب راتب|قبض) (.+)$/);
    if (startM && !/\d/.test(s)) {
      const tokens = startM[1].split(' ');
      const cands = EMPLOYEES.filter((e) => norm(e).split(' ').some((w) => tokens.includes(w)));
      if (cands.length === 1) {
        await kv0.put(flowKey, JSON.stringify({ step: 'adv', emp: cands[0] }), { expirationTtl: 600 });
        await sendText(agent, `👤 ${cands[0]}\nواخد سلف كام؟ (اكتب 0 لو مش واخد)`);
        return true;
      }
      if (cands.length > 1) {
        await kv0.put(flowKey, JSON.stringify({ step: 'pick', cands }), { expirationTtl: 600 });
        await sendText(agent, 'تقصد مين؟ ابعت رقمه:\n' + cands.map((c, i) => `${i + 1}. ${c}`).join('\n'));
        return true;
      }
    }
  }

  const editKey = `payroll:edit:${agent}`;
  if (kv0 && config.agent.payroll.includes(agent)) {
    if (['تعديل رواتب', 'تعديل الرواتب', 'تعديل القبض', 'تغيير رواتب', 'تغيير الرواتب', 'تغير رواتب', 'تغير الرواتب'].includes(s)) {
      const d = (await kv0.get(KEY, 'json')) || {};
      await kv0.put(editKey, '1', { expirationTtl: 600 });
      await sendText(
        agent,
        '✏️ قيم القبض الحالية:\n' +
          EMPLOYEES.map((e) => `• ${e}: ${d[e]?.base || 0}`).join('\n') +
          '\n\nاكتب الاسم والقيمة الجديدة (تقدر تبعت أكتر من واحد، كل واحد في سطر):\nهند 7000\nعلاء 6500\n\nولما تخلص اكتب: خلاص',
      );
      return true;
    }
    if (await kv0.get(editKey)) {
      if (['خلاص', 'تم', 'الغاء'].includes(s)) {
        await kv0.delete(editKey);
        await sendText(agent, '✅ اتقفل وضع تعديل الرواتب.');
        return true;
      }
      const d = (await kv0.get(KEY, 'json')) || {};
      const done = [];
      for (const line of latin(text).split(/\n/)) {
        const ls = norm(line);
        const e = findEmployee(ls);
        const m = ls.match(/(\d+(?:\.\d+)?)/);
        if (e && m) {
          d[e] = { base: Number(m[1]), att: d[e]?.att || 0, adv: d[e]?.adv || 0 };
          done.push(`• ${e}: قيمة القبض = ${m[1]}`);
        }
      }
      if (done.length) {
        await kv0.put(KEY, JSON.stringify(d));
        await sendText(agent, `✅ اتعدّل:\n${done.join('\n')}\n\n(كمّل تعديل أو اكتب: خلاص)`);
        return true;
      }
    }
  }

  const isAll = /^(?:ال)?رواتب$|^مرتبات$|^كشف (?:ال)?رواتب$/.test(s);
  const isReset = s.startsWith('تصفير');
  const has = (...w) => w.some((x) => ` ${s} `.includes(` ${x} `));
  const emp = findEmployee(s);
  if (!isAll && !emp && !isReset) return payrollTopicMenu(agent, s, kv0);

  const num = s.match(/(\d+(?:\.\d+)?)/);
  const wantsShow = has('راتب', 'مرتب', 'قبض', 'كام', 'حساب');
  const isSet = num && has('سلف', 'حضور', 'حضر', 'ياخد', 'بياخد', 'بتاخد', 'ياخذ', 'قبض', 'قبضه', 'قبضها', 'شهريه');
  if (!isAll && !isReset && !isSet && !wantsShow) return payrollTopicMenu(agent, s, kv0);

  if (!config.agent.payroll.includes(agent)) {
    await sendText(agent, 'ده أمر خاص بالإدارة فقط.');
    return true;
  }

  const kv = env?.MEMORY;
  if (!kv) {
    await sendText(agent, 'مفيش تخزين متاح دلوقتي.');
    return true;
  }
  const data = (await kv.get(KEY, 'json')) || {};

  if (isReset) {
    const targets = emp ? [emp] : EMPLOYEES;
    for (const e of targets) if (data[e]) data[e] = { base: data[e].base || 0, att: 0, adv: 0 };
    await kv.put(KEY, JSON.stringify(data));
    await sendText(agent, `✅ اتصفّر الحضور والسلف لـ${emp ? ` ${emp}` : ' كل الموظفين'} (قيمة القبض فضلت زي ما هي).`);
    return true;
  }

  if (isAll) {
    await sendText(agent, EMPLOYEES.map((e) => report(e, data[e])).join('\n\n'));
    return true;
  }

  if (isSet) {
    const v = Number(num[1]);
    const r = data[emp] || { base: 0, att: 0, adv: 0 };
    let what;
    if (has('سلف')) {
      r.adv = (r.adv || 0) + v;
      what = `اتضاف سلف ${v} (إجمالي السلف ${r.adv})`;
    } else if (has('حضور', 'حضر')) {
      r.att = v;
      what = `الحضور = ${v} يوم`;
    } else {
      r.base = v;
      what = `قيمة القبض = ${v}`;
    }
    data[emp] = r;
    await kv.put(KEY, JSON.stringify(data));
    await sendText(agent, `✅ ${emp}: ${what}\n\n${report(emp, r)}`);
    return true;
  }

  // عرض راتب موظف واحد
  await sendText(agent, report(emp, data[emp]));
  return true;
}
