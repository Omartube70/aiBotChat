/**
 * صيانة العمارات (توب باور) — دفتر تحصيل شهري + ملف كامل لكل عملية.
 *
 * كل "عملية" = عمارة ليها رقم زي "30ج" (الحرف جنب الرقم = المنطقة).
 * بيانات مالية: القيمة، المدفوع (الصافي بعد الغفير)، والغفير = القيمة − المدفوع.
 * تحصيل شهري: شهر 1..12 (المبلغ المتحصّل فعلاً كل شهر، فاضي = ما دفعش).
 * وكمان ملف لكل عمارة: مشاكل، مقايسات، صيانة اتعملت، مذكرات، صور، رئيس اتحاد + تليفونه، المحصّل.
 * كل حاجة بتتسجّل بتاريخ اليوم تلقائي (ميلادي، توقيت القاهرة).
 *
 * التخزين: KV/D1 (env.MEMORY) تحت المفتاح "maint:data" (مستند واحد)،
 * والصور منفصلة "maint:photo:<id>" عشان المستند الأساسي يفضل خفيف.
 */
import { config } from './config.js';
import { sendText, sendDocument, uploadMedia, fetchMedia, sendImageId } from './whatsapp.js';
import { buildTableXlsx } from './invoice.js';
import { readSheet } from './shopdata.js';

const DATA_KEY = 'maint:data';
const ADD_KEY = (a) => `maint:add:${a}`;
const PHOTO_PENDING_KEY = (a) => `maint:photopending:${a}`;
const PHOTO_KEY = (id) => `maint:photo:${id}`;

export const MONTHS_AR = [
  'يناير', 'فبراير', 'مارس', 'ابريل', 'مايو', 'يونيو',
  'يوليو', 'اغسطس', 'سبتمبر', 'اكتوبر', 'نوفمبر', 'ديسمبر',
];
const MONTH_SHORT = ['ينا', 'فبر', 'مار', 'ابر', 'ماي', 'يون', 'يول', 'اغس', 'سبت', 'اكت', 'نوف', 'ديس'];
const HOUR = 3600 * 1000;

/* ---------- base64 (Cloudflare: من غير Buffer) ---------- */
function base64FromArrayBuffer(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}
function bytesFromBase64(b64) {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

/* ---------- أدوات نصية ---------- */
function toLatin(s) {
  return String(s == null ? '' : s)
    .replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
    .replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d));
}
function arNorm(s) {
  return toLatin(s)
    .toLowerCase()
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/[ىي]/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim();
}
/** مفتاح مطابقة لرقم العملية: من غير مسافات ولا تشكيل. */
function opKey(s) {
  return arNorm(s).replace(/\s+/g, '');
}
function numOnly(s) {
  const m = toLatin(s).match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
}
function fmtMoney(n) {
  return Math.round(Number(n) || 0).toLocaleString('en-US');
}
/** المنطقة (الحرف العربي جنب الرقم) + الرقم. "102 ج" → {number:102, zone:'ج'} */
function parseZone(raw) {
  const s = arNorm(raw);
  const m = s.match(/(\d+)\s*([ابتثجحخدذرزسشصضطظعغفقكلمنهوي])/);
  const zoneRaw = m ? m[2] : (s.match(/([ابتثجحخدذرزسشصضطظعغفقكلمنهوي])\s*$/) || [])[1] || '';
  const number = m ? Number(m[1]) : numOnly(s);
  // عرض ألطف: ا → أ
  const zone = zoneRaw === 'ا' ? 'أ' : zoneRaw;
  return { number, zone };
}

/* ---------- التاريخ (القاهرة، ميلادي) ---------- */
export function cairoNow() {
  const d = new Date(Date.now() + 2 * HOUR); // القاهرة UTC+2 (تقريبي، كفاية للتاريخ)
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return { y, m, day, iso: d.toISOString(), label: `${day}/${m}/${y}` };
}
function dateLabel(iso) {
  try {
    const d = new Date(iso);
    return `${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
  } catch {
    return '';
  }
}

/* ---------- تحميل/حفظ ---------- */
export async function loadMaint(env) {
  const data = (await env.MEMORY.get(DATA_KEY, 'json')) || { seq: 0, buildings: [] };
  if (!Array.isArray(data.buildings)) data.buildings = [];
  return data;
}
export async function saveMaint(env, data) {
  await env.MEMORY.put(DATA_KEY, JSON.stringify(data));
}

/* ---------- استيراد شيت إنياد/جوجل (تحصيل صيانة) ---------- */
/** أعمدة الشيت: A عدد | B رقم العملية | C القيمة | D المدفوع | E..P شهر 1..12 */
const MONTH_COLS = ['E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P'];

export function isMaintenanceSheet(rows) {
  // بندوّر على صف فيه "رقم العمليه" و"المدفوع"، وكمان عمود "شهر 1"
  const flat = rows.slice(0, 6).map((r) => Object.values(r).map(arNorm).join(' ')).join(' | ');
  return /رقم العمليه/.test(flat) && /المدفوع/.test(flat) && /شهر 1\b/.test(flat);
}

/**
 * يستورد الشيت ويدمجه مع الموجود (بالمطابقة على رقم العملية) — من غير ما يمسح
 * الحقول الجديدة (رئيس الاتحاد، الصور، المشاكل...).
 * @returns {Promise<{count:number, added:number, updated:number}>}
 */
export async function importMaintenanceSheet(env, rows) {
  const data = await loadMaint(env);
  const byKey = new Map(data.buildings.map((b) => [b.key, b]));
  let added = 0, updated = 0, count = 0;
  const now = cairoNow();

  for (const r of rows) {
    const rawNum = (r.B || '').trim();
    const value = numOnly(r.C);
    const paid = numOnly(r.D);
    if (!rawNum || value == null || !/\d/.test(rawNum)) continue;
    if (arNorm(rawNum) === 'رقم العمليه') continue;
    count++;
    const key = opKey(rawNum);
    const { number, zone } = parseZone(rawNum);
    const months = {};
    MONTH_COLS.forEach((c, i) => {
      const v = numOnly(r[c]);
      if (v != null) months[i + 1] = v;
    });

    let b = byKey.get(key);
    if (!b) {
      b = {
        id: `b${++data.seq}`,
        key,
        num: rawNum,
        number,
        zone,
        name: '',
        address: '',
        value,
        paid,
        guard: value != null && paid != null ? value - paid : null,
        collector: '',
        contacts: [], // [{name, phone}] — رئيس الاتحاد وتليفونه (لحد اتنين)
        active: true,
        year: now.y,
        months,
        events: [],
        photos: [],
        createdAt: now.iso,
        updatedAt: now.iso,
      };
      data.buildings.push(b);
      byKey.set(key, b);
      added++;
    } else {
      // تحديث الأرقام المالية والتحصيل، مع الحفاظ على الحقول الجديدة
      b.value = value;
      b.paid = paid;
      b.guard = value != null && paid != null ? value - paid : b.guard;
      b.months = { ...b.months, ...months };
      b.zone = zone || b.zone;
      b.number = number ?? b.number;
      b.updatedAt = now.iso;
      updated++;
    }
  }
  await saveMaint(env, data);
  return { count, added, updated };
}

/* ---------- البحث عن عملية ---------- */
/** يرجّع المطابقات: مطابقة تامة للمفتاح أولاً، وإلا اللي بيبدأ بيه، وإلا اللي بيحتوي. */
function findOps(data, query) {
  const k = opKey(query);
  if (!k) return [];
  const exact = data.buildings.filter((b) => b.key === k);
  if (exact.length) return exact;
  const starts = data.buildings.filter((b) => b.key.startsWith(k));
  if (starts.length) return starts;
  return data.buildings.filter((b) => b.key.includes(k));
}

function opTitle(b) {
  return `${b.num}${b.name ? ` — ${b.name}` : ''}`;
}

/** جهات اتصال رئيس الاتحاد (مع دعم الصيغة القديمة unionHead/unionPhone). */
function getContacts(b) {
  if (Array.isArray(b.contacts) && b.contacts.length) return b.contacts;
  if (b.unionHead || b.unionPhone) return [{ name: b.unionHead || '', phone: b.unionPhone || '' }];
  return [];
}
function setContact(b, idx, patch) {
  if (!Array.isArray(b.contacts)) b.contacts = getContacts(b);
  while (b.contacts.length <= idx) b.contacts.push({ name: '', phone: '' });
  Object.assign(b.contacts[idx], patch);
}

/* ---------- إضافة حدث بتاريخ اليوم ---------- */
function addEvent(b, ev) {
  const now = cairoNow();
  b.events = b.events || [];
  b.events.push({ ...ev, at: now.iso });
  b.updatedAt = now.iso;
  return now;
}

/* ---------- عرض ملف العملية ---------- */
function renderBuilding(b) {
  const lines = [];
  lines.push(`🏢 *${opTitle(b)}*${b.active === false ? ' (خرجت)' : ''}`);
  const meta = [];
  if (b.zone) meta.push(`منطقة ${b.zone}`);
  if (b.address) meta.push(b.address);
  if (meta.length) lines.push(meta.join(' · '));
  lines.push(
    `💰 القيمة ${fmtMoney(b.value)} · المدفوع ${fmtMoney(b.paid)} · الغفير ${b.guard != null ? fmtMoney(b.guard) : '—'}`,
  );
  if (b.collector) lines.push(`🧾 المحصّل: ${b.collector}`);
  for (const c of getContacts(b))
    lines.push(`👤 رئيس الاتحاد: ${c.name || '—'}${c.phone ? ` · ${c.phone}` : ''}`);

  // التحصيل الشهري
  const paidMonths = [];
  const unpaid = [];
  for (let m = 1; m <= 12; m++) {
    if (b.months && b.months[m] != null) paidMonths.push(`${MONTH_SHORT[m - 1]} ${fmtMoney(b.months[m])}`);
    else unpaid.push(MONTH_SHORT[m - 1]);
  }
  lines.push('');
  lines.push(`✅ دَفَع: ${paidMonths.length ? paidMonths.join(' · ') : '—'}`);
  if (unpaid.length) lines.push(`❌ فاضل: ${unpaid.join(' · ')}`);

  // الصور
  if (b.photos && b.photos.length) lines.push(`📷 صور: ${b.photos.length}`);

  // آخر الأحداث (أحدث أولاً)
  const evs = (b.events || []).slice(-15).reverse();
  if (evs.length) {
    lines.push('');
    lines.push('🗒️ آخر الأحداث:');
    for (const e of evs) {
      const icon =
        { payment: '💵', maintenance: '🔧', problem: '⚠️', fault: '🔴', part: '🔩', measure: '📐', pending: '📌', note: '📝', photo: '📷' }[e.type] || '•';
      const d = dateLabel(e.at);
      lines.push(`${icon} ${d}: ${e.text}${e.by ? ` (${e.by})` : ''}`);
    }
  }
  return lines.join('\n');
}

/* ---------- تقرير "مين ما دفعش" ---------- */
function unpaidReport(data, month) {
  const active = data.buildings.filter((b) => b.active !== false);
  const unpaid = active.filter((b) => !(b.months && b.months[month] != null));
  const expected = active.reduce((s, b) => s + (b.paid || 0), 0);
  const collected = active.reduce((s, b) => s + ((b.months && b.months[month]) || 0), 0);
  const due = unpaid.reduce((s, b) => s + (b.paid || 0), 0);

  const byZone = {};
  for (const b of unpaid) (byZone[b.zone || '—'] ||= []).push(b);

  const head =
    `📋 *${MONTHS_AR[month - 1]} (شهر ${month})* — ما دفعوش: ${unpaid.length} من ${active.length}\n` +
    `💰 المطلوب ${fmtMoney(expected)} · المتحصّل ${fmtMoney(collected)} · المتبقّي ${fmtMoney(due)} ج`;

  const zones = Object.keys(byZone).sort();
  const body = zones
    .map((z) => {
      const list = byZone[z]
        .sort((a, b) => (a.number || 0) - (b.number || 0))
        .map((b) => `  • ${b.num}${b.name ? ` (${b.name})` : ''} — ${fmtMoney(b.paid)} ج`)
        .join('\n');
      return `*منطقة ${z}* (${byZone[z].length}):\n${list}`;
    })
    .join('\n\n');

  return `${head}\n\n${body}`;
}

/* ---------- شيت Excel ---------- */
export function buildMaintenanceXlsx(data) {
  const header = [
    'م', 'رقم العملية', 'المنطقة', 'الاسم', 'العنوان',
    'رئيس الاتحاد 1', 'تليفون 1', 'رئيس الاتحاد 2', 'تليفون 2', 'المحصّل',
    'القيمة', 'المدفوع', 'الغفير', ...MONTHS_AR, 'ملاحظات',
  ];
  const buildings = [...data.buildings].sort(
    (a, b) => String(a.zone).localeCompare(String(b.zone), 'ar') || (a.number || 0) - (b.number || 0),
  );
  const rows = [header];
  buildings.forEach((b, i) => {
    const months = [];
    for (let m = 1; m <= 12; m++) months.push(b.months && b.months[m] != null ? b.months[m] : '');
    // آخر مشكلة/ملاحظة للعرض
    const lastNote = (b.events || [])
      .filter((e) => ['problem', 'measure', 'pending', 'note'].includes(e.type))
      .slice(-1)[0];
    const cts = getContacts(b);
    rows.push([
      i + 1, b.num, b.zone || '', b.name || '', b.address || '',
      cts[0]?.name || '', cts[0]?.phone || '', cts[1]?.name || '', cts[1]?.phone || '',
      b.collector || '', b.value ?? '', b.paid ?? '', b.guard ?? '', ...months,
      lastNote ? lastNote.text : (b.active === false ? 'خرجت' : ''),
    ]);
  });
  return buildTableXlsx(rows, 'تحصيل صيانة');
}

async function sendMaintenanceSheet(agent, env) {
  const data = await loadMaint(env);
  if (!data.buildings.length) {
    await sendText(agent, 'مفيش عمليات صيانة متسجلة لسه. ابعتلي شيت التحصيل (Excel) أو اكتب "صيانة جديدة".');
    return;
  }
  const buf = buildMaintenanceXlsx(data);
  const name = `تحصيل-صيانة-${cairoNow().label.replace(/\//g, '-')}.xlsx`;
  const mediaId = await uploadMedia(buf, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', name);
  if (mediaId && (await sendDocument(agent, mediaId, name, `شيت الصيانة (${data.buildings.length} عملية)`))) return;
  await sendText(agent, 'حصلت مشكلة في تجهيز ملف الإكسيل 🙏 جرّب تاني.');
}

/* ---------- الصور ---------- */
export async function handleMaintenancePhoto(agent, image, caption, env) {
  const media = await fetchMedia(image.id);
  if (!media) {
    await sendText(agent, 'تعذّر تنزيل الصورة 🙏 ابعتها تاني.');
    return true;
  }
  if (media.size > 1.5 * 1024 * 1024) {
    await sendText(agent, 'الصورة كبيرة شوية (أكتر من 1.5 ميجا) 🙏 ابعت نسخة أصغر.');
    return true;
  }
  const b64 = base64FromArrayBuffer(media.buffer);
  const mime = media.mimeType || image.mimeType || 'image/jpeg';

  const data = await loadMaint(env);
  // لو الكابشن فيه رقم عملية → نلزق على طول
  const capMatch = caption && findOps(data, caption);
  if (capMatch && capMatch.length === 1) {
    await attachPhoto(env, data, capMatch[0], { b64, mime, caption, by: whoName(agent) });
    await sendText(agent, `📷 اتحفظت الصورة على ${opTitle(capMatch[0])}.`);
    return true;
  }
  if (capMatch && capMatch.length > 1) {
    await sendText(
      agent,
      `الصورة دي لأنهي عملية بالظبط؟ لقيت أكتر من واحدة:\n${capMatch.slice(0, 8).map((b) => `• ${b.num}`).join('\n')}\nاكتب رقمها بالضبط.`,
    );
  } else {
    await sendText(agent, 'الصورة دي لأنهي عملية؟ اكتب رقمها (زي 30ج).');
  }
  // نخزّن الصورة مؤقتًا لحد ما يقول العملية (ربع ساعة)
  await env.MEMORY.put(PHOTO_PENDING_KEY(agent), JSON.stringify({ b64, mime, caption: caption || '' }), {
    expirationTtl: 900,
  });
  return true;
}

async function attachPhoto(env, data, b, { b64, mime, caption, by }) {
  const id = `p${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;
  await env.MEMORY.put(PHOTO_KEY(id), JSON.stringify({ b64, mime }));
  b.photos = b.photos || [];
  b.photos.push({ id, mime, caption: caption || '', at: cairoNow().iso, by });
  while (b.photos.length > 12) {
    const old = b.photos.shift();
    await env.MEMORY.delete(PHOTO_KEY(old.id)).catch(() => {});
  }
  addEvent(b, { type: 'photo', text: `صورة${caption ? ` — ${caption}` : ''}`, by });
  await saveMaint(env, data);
}

async function sendBuildingPhotos(agent, b, env) {
  const photos = (b.photos || []).slice(-6);
  for (const p of photos) {
    try {
      const raw = await env.MEMORY.get(PHOTO_KEY(p.id), 'json');
      if (!raw) continue;
      const buf = bytesFromBase64(raw.b64);
      const mediaId = await uploadMedia(buf, raw.mime || 'image/jpeg', 'photo.jpg');
      if (mediaId) await sendImageId(agent, mediaId, `${b.num}${p.caption ? ` — ${p.caption}` : ''} (${dateLabel(p.at)})`);
    } catch {
      /* نكمّل باقي الصور */
    }
  }
}

/* ---------- مين المحصّل (اسم الموظف من رقمه) ---------- */
function whoName(agent) {
  const names = { '201000363323': 'الحاج محمد', '201003044660': '', '201050699420': '' };
  return names[agent] || '';
}

/* ---------- خطوات "صيانة جديدة" ---------- */
const ADD_STEPS = [
  { k: 'num', q: 'رقم العملية؟ (زي 30ج — الحرف ده المنطقة)' },
  { k: 'value', q: 'القيمة الكاملة؟ (مثلاً 250)' },
  { k: 'paid', q: 'المدفوع (الصافي بعد الغفير)؟ (مثلاً 200 — والفرق يبقى الغفير)' },
  { k: 'collector', q: 'مين المحصّل؟ (أو اكتب "تخطي")' },
  { k: 'unionHead', q: 'اسم رئيس اتحاد الملاك؟ (أو "تخطي")' },
  { k: 'unionPhone', q: 'تليفون رئيس الاتحاد؟ (أو "تخطي")' },
];

export async function maintAddStep(agent, t, env) {
  const pend = await env.MEMORY.get(ADD_KEY(agent), 'json');
  if (!pend) return false;
  const s = arNorm(t);
  if (['الغاء', 'الغاء العمليه', 'إلغاء', 'بطل', 'cancel'].includes(s)) {
    await env.MEMORY.delete(ADD_KEY(agent));
    await sendText(agent, 'تمام، لغيت إضافة العملية.');
    return true;
  }
  const step = ADD_STEPS[pend.i];
  const val = ['تخطي', 'تخطى', 'skip', '-', 'لا'].includes(s) ? '' : t.trim();

  if (step.k === 'value' || step.k === 'paid') {
    const n = numOnly(val);
    if (n == null) {
      await sendText(agent, `محتاج رقم 🙏 ${step.q}`);
      return true;
    }
    pend.data[step.k] = n;
  } else {
    pend.data[step.k] = val;
  }

  pend.i++;
  if (pend.i < ADD_STEPS.length) {
    await env.MEMORY.put(ADD_KEY(agent), JSON.stringify(pend), { expirationTtl: 3600 });
    await sendText(agent, ADD_STEPS[pend.i].q);
    return true;
  }

  // خلصنا — نحفظ
  await env.MEMORY.delete(ADD_KEY(agent));
  const data = await loadMaint(env);
  const d = pend.data;
  const key = opKey(d.num);
  if (data.buildings.some((b) => b.key === key)) {
    await sendText(agent, `العملية ${d.num} موجودة قبل كده. لو عايز تعدّلها اكتب رقمها.`);
    return true;
  }
  const { number, zone } = parseZone(d.num);
  const now = cairoNow();
  const b = {
    id: `b${++data.seq}`,
    key,
    num: d.num.trim(),
    number,
    zone,
    name: '',
    address: '',
    value: d.value,
    paid: d.paid,
    guard: d.value != null && d.paid != null ? d.value - d.paid : null,
    collector: d.collector || '',
    contacts: d.unionHead || d.unionPhone ? [{ name: d.unionHead || '', phone: d.unionPhone ? toLatin(d.unionPhone).replace(/[^\d+]/g, '') : '' }] : [],
    active: true,
    year: now.y,
    months: {},
    events: [],
    photos: [],
    createdAt: now.iso,
    updatedAt: now.iso,
  };
  data.buildings.push(b);
  await saveMaint(env, data);
  await sendText(agent, `✅ اتضافت العملية:\n\n${renderBuilding(b)}`);
  return true;
}

/* ---------- لينك واتساب لرئيس الاتحاد ---------- */
function waLink(phone, text) {
  const p = String(phone || '').replace(/[^\d]/g, '').replace(/^0/, '20');
  return `https://wa.me/${p}?text=${encodeURIComponent(text)}`;
}
function unionMessageText(b, msg) {
  return msg || `السلام عليكم، بخصوص صيانة ${b.name || 'العمارة'} ${b.num}.`;
}

/* ---------- المعالج الرئيسي لأوامر الصيانة ---------- */
export async function handleMaintenanceStaff(agent, t, env, canWrite = true) {
  const s = arNorm(t);
  const data = await loadMaint(env);
  const denyWrite = async () => {
    await sendText(agent, '🔒 صلاحيتك مشاهدة بس. الإضافة والتعديل بيتعملوا من أرقام الإدارة.');
    return true;
  };

  // لو فيه صورة مستنية عملية، وكتب رقم عملية → نلزقها (كتابة)
  const pendingPhoto = canWrite && (await env.MEMORY.get(PHOTO_PENDING_KEY(agent), 'json'));
  if (pendingPhoto) {
    const m = findOps(data, t);
    if (m.length === 1) {
      await env.MEMORY.delete(PHOTO_PENDING_KEY(agent));
      await attachPhoto(env, data, m[0], { ...pendingPhoto, by: whoName(agent) });
      await sendText(agent, `📷 اتحفظت الصورة على ${opTitle(m[0])}.`);
      return true;
    }
  }

  // --- بدء إضافة عملية ---
  if (/(صيانه|عمليه|عماره) جديد/.test(s) || /^(اضف|اضافه|ضيف)\s+(عمليه|عماره|صيانه)/.test(s)) {
    if (!canWrite) return denyWrite();
    await env.MEMORY.put(ADD_KEY(agent), JSON.stringify({ i: 0, data: {} }), { expirationTtl: 3600 });
    await sendText(agent, `🏢 عملية صيانة جديدة.\n${ADD_STEPS[0].q}\n\n(اكتب "الغاء" في أي وقت للخروج)`);
    return true;
  }

  // --- شيت الإكسيل ---
  if (/(شيت|اكسيل|اكسل|ملف|اكسبورت) (الصيانه|التحصيل|العمارات|صيانه|تحصيل)/.test(s) || /^شيت الصيانه$/.test(s) || /^(تحصيل الصيانه|شيت تحصيل)$/.test(s)) {
    await sendMaintenanceSheet(agent, env);
    return true;
  }

  // --- قائمة المناطق / العمليات ---
  if (/^(المناطق|مناطق الصيانه|قائمه المناطق)$/.test(s)) {
    const zones = {};
    for (const b of data.buildings) if (b.active !== false) (zones[b.zone || '—'] ||= 0), (zones[b.zone || '—']++);
    const keys = Object.keys(zones).sort();
    await sendText(
      agent,
      keys.length
        ? `🗺️ المناطق:\n${keys.map((z) => `• منطقة ${z}: ${zones[z]} عملية`).join('\n')}\n\nاكتب "منطقة ج" تشوف عملياتها.`
        : 'مفيش عمليات متسجلة لسه.',
    );
    return true;
  }
  const zoneMatch = s.match(/^منطق[هة]\s*([ابتثجحخدذرزسشصضطظعغفقكلمنهوي]|أ)$/);
  if (zoneMatch) {
    const z = zoneMatch[1] === 'ا' ? 'أ' : zoneMatch[1];
    const list = data.buildings
      .filter((b) => b.active !== false && (b.zone === z || arNorm(b.zone) === arNorm(z)))
      .sort((a, b) => (a.number || 0) - (b.number || 0));
    await sendText(
      agent,
      list.length
        ? `🗺️ *منطقة ${z}* (${list.length}):\n${list.map((b) => `• ${b.num}${b.name ? ` — ${b.name}` : ''} (${fmtMoney(b.paid)} ج)`).join('\n')}`
        : `مفيش عمليات في منطقة ${z}.`,
    );
    return true;
  }
  if (/^(العمليات|قائمه الصيانه|قائمه العمليات|كل العمليات)$/.test(s)) {
    const active = data.buildings.filter((b) => b.active !== false);
    await sendText(
      agent,
      `🏢 عدد العمليات: ${active.length}. اكتب "المناطق" عشان تختار منطقة، أو اكتب رقم عملية (زي 30ج) تشوف ملفها، أو "شيت الصيانة" للملف الكامل.`,
    );
    return true;
  }

  // --- مين ما دفعش [شهر N] ---
  if (/(ما ?دفع|مدفعش|لسه ما ?دفع|متاخر|المتاخر|عليهم فلوس|لسه عليه|فاضل فلوس|مدفعوش|ما دفعوش)/.test(s)) {
    const month = parseMonthFromText(t) || cairoNow().m;
    await sendText(agent, unpaidReport(data, month));
    return true;
  }

  // --- تسجيل تحصيل: "30ج دفع 200 شهر 9" ---
  const payM = toLatin(t).match(
    /^(.+?)\s+(?:دفع(?:ت|وا)?|سدد(?:ت)?|حصّ?لت(?:\s+منها)?|اتحصّ?ل(?:ت)?)\s+(\d+(?:[.,]\d+)?)(?:\s+(?:شهر|لشهر)\s*([^\s]+))?\s*$/,
  );
  if (payM) {
    if (!canWrite) return denyWrite();
    const ops = findOps(data, payM[1]);
    if (ops.length !== 1) { await askWhich(agent, ops, payM[1]); return true; }
    const b = ops[0];
    const amount = Number(String(payM[2]).replace(',', '.'));
    const month = (payM[3] && parseMonthToken(payM[3])) || cairoNow().m;
    b.months = b.months || {};
    b.months[month] = amount;
    addEvent(b, { type: 'payment', text: `اتحصّل ${fmtMoney(amount)} ج عن ${MONTHS_AR[month - 1]}`, amount, month, by: whoName(agent) });
    await saveMaint(env, data);
    await sendText(agent, `💵 سجّلت: ${opTitle(b)} دفع ${fmtMoney(amount)} ج عن ${MONTHS_AR[month - 1]} (شهر ${month}).`);
    return true;
  }

  // --- صيانة اتعملت: "30ج اتعملت صيانة محمد" / "عملنا صيانة في 30ج" ---
  const maintM =
    toLatin(t).match(/^(.+?)\s+(?:اتعملت|عملنا|تمت|خلصت)\s+صيان[هة]\s*(.*)$/) ||
    toLatin(t).match(/^(?:عملنا|اتعملت|تمت)\s+صيان[هة]\s+(?:في|ل|لـ)\s+(.+?)\s*(?:بواسطه|بمعرفه)?\s*(.*)$/);
  if (maintM) {
    if (!canWrite) return denyWrite();
    const ops = findOps(data, maintM[1]);
    if (!ops.length) { await sendText(agent, `مفيش عملية اسمها "${maintM[1].trim()}". اكتب "المناطق" أو جرّب رقم أوضح.`); return true; }
    if (ops.length !== 1) { await askWhich(agent, ops, maintM[1]); return true; }
    const b = ops[0];
    const by = (maintM[2] || '').trim() || whoName(agent);
    const now = addEvent(b, { type: 'maintenance', text: `اتعملت صيانة`, by });
    await saveMaint(env, data);
    await sendText(agent, `🔧 سجّلت: اتعملت صيانة في ${opTitle(b)} يوم ${now.label}${by ? ` (${by})` : ''}.`);
    return true;
  }

  // --- عطل: "عطل 90ج الباب مش بيقفل" أو "90ج عطل ..." → يتسجّل ويوصل للتلاتة ---
  const faultM =
    toLatin(t).match(/^عطل\s+(\S+)\s+([\s\S]+)$/) ||
    toLatin(t).match(/^(.+?)\s+عطل\s+([\s\S]+)$/);
  if (faultM) {
    if (!canWrite) return denyWrite();
    const ops = findOps(data, faultM[1]);
    if (ops.length !== 1) { await askWhich(agent, ops, faultM[1]); return true; }
    const b = ops[0];
    const desc = faultM[2].trim();
    const by = whoName(agent);
    const now = addEvent(b, { type: 'fault', text: desc, by });
    await saveMaint(env, data);
    await sendText(agent, `🔴 اتسجّل عطل في ${opTitle(b)} يوم ${now.label}:\n«${desc}»`);
    // نبلّغ باقي الإدارة (زي الجروب)
    const note = `🔴 *عطل جديد* — ${opTitle(b)}${b.zone ? ` (منطقة ${b.zone})` : ''}\n«${desc}»\nاتبلّغ ${now.label}${by ? ` بواسطة ${by}` : ''}`;
    for (const n of config.agent.admins) if (n && n !== agent) await sendText(n, note).catch(() => {});
    return true;
  }

  // --- قطعة غيار اتغيرت (للضمان): "90ج غيرت كنتاكتور" / "90ج قطعة غيار لوحة" ---
  const partM =
    toLatin(t).match(/^(.+?)\s+(?:غيرت|غيّرت|اتغير|اتغيّر|ركبت|ركّبت)\s+([\s\S]+)$/) ||
    toLatin(t).match(/^(.+?)\s+قطع[هة]?\s+غيار\s+([\s\S]+)$/);
  if (partM) {
    const ops = findOps(data, partM[1]);
    if (ops.length === 1) {
      if (!canWrite) return denyWrite();
      const b = ops[0];
      const desc = partM[2].trim();
      const now = addEvent(b, { type: 'part', text: `اتغيّرت/اتركّبت: ${desc}`, by: whoName(agent) });
      await saveMaint(env, data);
      await sendText(agent, `🔩 اتسجّل على ${opTitle(b)} يوم ${now.label} (للضمان):\n«${desc}»`);
      return true;
    }
  }

  // --- تحذير جماعي لكل العماير (زي المطر) ---
  const bcM = toLatin(t).match(/^(?:تحذير|حذر|ابعت|رساله|نبّه|نبه)\s+(?:ل)?(?:كل|جميع)\s+(?:ال)?(?:عماير|العماير|العمارات|الاتحادات|الملاك)\s*[:：]?\s*([\s\S]*)$/);
  if (bcM) {
    if (!canWrite) return denyWrite();
    const msg = (bcM[1] || '').trim() || 'تنبيه هام: برجاء فصل المصاعد لحين انتهاء الأمطار.';
    const phones = [];
    for (const b of data.buildings) {
      if (b.active === false) continue;
      for (const c of getContacts(b)) if (c.phone) phones.push(String(c.phone).replace(/[^\d]/g, '').replace(/^0/, '20'));
    }
    const uniq = [...new Set(phones)];
    if (!uniq.length) {
      await sendText(agent, 'مفيش تليفونات رؤساء اتحاد مسجّلة لحد دلوقتي. سجّلهم الأول (من السيستم أو "90ج تليفون 01...").');
      return true;
    }
    await sendText(
      agent,
      `📢 *تحذير جماعي* — ${uniq.length} رقم.\n\n` +
        `واتساب مش بيسمح للبوت يبعت جماعي ببلاش. أسهل وأأمن طريقة مجانية:\n` +
        `1) من تليفونك: واتساب ← القايمة ← "رسالة جماعية" (Broadcast).\n` +
        `2) ضيف الأرقام دي، واكتب الرسالة، وابعت مرة واحدة توصل كلهم.\n\n` +
        `✍️ الرسالة:\n«${msg}»\n\n📞 الأرقام (انسخها):\n${uniq.join(', ')}`,
    );
    return true;
  }

  // --- رسالة لرئيس الاتحاد ---
  const unionM = toLatin(t).match(/^(?:ابعت|كلم|راسل|رساله)\s+(?:ل)?رئيس\s+(?:ال)?اتحاد\s+(.+?)\s*$/);
  if (unionM) {
    const ops = findOps(data, unionM[1]);
    if (ops.length !== 1) { await askWhich(agent, ops, unionM[1]); return true; }
    const b = ops[0];
    const cts = getContacts(b).filter((c) => c.phone);
    if (!cts.length) {
      await sendText(agent, `مفيش تليفون مسجّل لرئيس اتحاد ${b.num}. اكتب: ${b.num} تليفون 01xxxxxxxxx`);
      return true;
    }
    const txt = unionMessageText(b);
    await sendText(
      agent,
      `📲 رسالة جاهزة لرئيس اتحاد ${opTitle(b)} — دوس اللينك وابعتها من تليفونك 👇\n\n` +
        cts.map((c) => `${c.name || 'رئيس الاتحاد'}:\n${waLink(c.phone, txt)}`).join('\n\n'),
    );
    return true;
  }

  // --- ضبط حقل: "30ج تليفون 01.." / "30ج تليفون2 01.." / "30ج رئيس الاتحاد كمال" / "30ج المحصل اشرف" / "30ج الاسم/العنوان ..." ---
  const setM = t.match(/^(.+?)\s+(تليفون\s*2|رقم\s*2|رئيس الاتحاد\s*2|رئيس اتحاد\s*2|تليفون|رقم|رئيس الاتحاد|رئيس اتحاد|المحصل|المحصّل|الاسم|اسم|العنوان|عنوان)\s+(.+)$/);
  if (setM) {
    const ops = findOps(data, setM[1]);
    if (ops.length === 1) {
      if (!canWrite) return denyWrite();
      const b = ops[0];
      const field = arNorm(setM[2]);
      const v = setM[3].trim();
      const idx = /2/.test(field) ? 1 : 0;
      if (/تليفون|رقم/.test(field)) setContact(b, idx, { phone: toLatin(v).replace(/[^\d+]/g, '') });
      else if (/رئيس/.test(field)) setContact(b, idx, { name: v });
      else if (/محصل/.test(field)) b.collector = v;
      else if (/اسم/.test(field)) b.name = v;
      else if (/عنوان/.test(field)) b.address = v;
      b.updatedAt = cairoNow().iso;
      await saveMaint(env, data);
      await sendText(agent, `✅ اتسجّل على ${opTitle(b)}.`);
      return true;
    }
  }

  // --- شيل/خرجت ---
  const rmM = toLatin(t).match(/^(?:شيل|احذف|امسح)\s+(?:عمليه|عماره)?\s*(.+?)\s*$/) || toLatin(t).match(/^(.+?)\s+(?:خرجت|اتشالت|اتلغت)\s*$/);
  if (rmM) {
    const ops = findOps(data, rmM[1]);
    if (ops.length === 1) {
      if (!canWrite) return denyWrite();
      ops[0].active = false;
      addEvent(ops[0], { type: 'note', text: 'العملية خرجت من الصيانة', by: whoName(agent) });
      await saveMaint(env, data);
      await sendText(agent, `✅ علّمت ${opTitle(ops[0])} إنها خرجت. (تاريخها محفوظ)`);
      return true;
    }
  }

  // --- مشكلة/مقايسة/مذكرة/مطلوب: "30ج مشكلة كنترول" / "30ج: ..." ---
  const noteM =
    t.match(/^(.+?)\s*[:：]\s*([\s\S]+)$/) ||
    t.match(/^(.+?)\s+(مشكل[هةه]|مقايس[هةه]|مذكر[هةه]|ملاحظ[هةه]|مطلوب|لسه|اتنفذ|اتعمل|محتاج|عطل)(\s[\s\S]*)?$/);
  if (noteM) {
    const ops = findOps(data, noteM[1]);
    if (ops.length === 1) {
      if (!canWrite) return denyWrite();
      const b = ops[0];
      const rest = (noteM[3] != null ? `${noteM[2]}${noteM[3]}` : noteM[2]).trim();
      const kw = arNorm(rest);
      let type = 'note';
      if (/مقايس/.test(kw)) type = 'measure';
      else if (/مشكل/.test(kw)) type = 'problem';
      else if (/مطلوب|لسه|محتاج/.test(kw)) type = 'pending';
      const now = addEvent(b, { type, text: rest, by: whoName(agent) });
      await saveMaint(env, data);
      await sendText(agent, `📝 اتسجّل على ${opTitle(b)} يوم ${now.label}:\n«${rest}»`);
      return true;
    }
    if (ops.length > 1) { await askWhich(agent, ops, noteM[1]); return true; }
  }

  // --- فتح ملف عملية برقمها المجرّد ---
  const ops = findOps(data, t);
  if (ops.length === 1 && opKey(t).length >= 2) {
    await sendText(agent, renderBuilding(ops[0]));
    await sendBuildingPhotos(agent, ops[0], env);
    return true;
  }
  if (ops.length > 1 && opKey(t).length >= 1 && /^\s*\d/.test(toLatin(t))) {
    await askWhich(agent, ops, t);
    return true;
  }

  return false;
}

async function askWhich(agent, ops, q) {
  if (!ops.length) {
    await sendText(agent, `مفيش عملية بالرقم ده "${String(q).trim()}". اكتب "المناطق" أو جرّب رقم أوضح.`);
    return;
  }
  await sendText(
    agent,
    `فيه أكتر من عملية بتطابق "${String(q).trim()}":\n${ops.slice(0, 10).map((b) => `• ${b.num}${b.zone ? ` (منطقة ${b.zone})` : ''}`).join('\n')}\nاكتب الرقم كامل بالمنطقة.`,
  );
}

/* ---------- أدوات الشهور ---------- */
function parseMonthToken(tok) {
  const n = numOnly(tok);
  if (n != null && n >= 1 && n <= 12) return n;
  const k = arNorm(tok);
  const i = MONTHS_AR.findIndex((m) => arNorm(m) === k || k.startsWith(arNorm(m).slice(0, 4)));
  return i >= 0 ? i + 1 : null;
}
function parseMonthFromText(t) {
  const m = toLatin(t).match(/شهر\s*([^\s]+)/);
  if (m) {
    const v = parseMonthToken(m[1]);
    if (v) return v;
  }
  for (let i = 0; i < 12; i++) if (arNorm(t).includes(arNorm(MONTHS_AR[i]))) return i + 1;
  return null;
}

/* ---------- تذكير شهري بالمتأخرين (cron) ---------- */
export async function remindMaintenanceUnpaid(env) {
  const now = cairoNow();
  if (now.day > 5 || now.day < 1) return; // أول 5 أيام في الشهر
  const key = `maint:reminded:${now.y}-${now.m}`;
  if (await env.MEMORY.get(key)) return;
  const data = await loadMaint(env);
  if (!data.buildings.length) return;
  await env.MEMORY.put(key, '1', { expirationTtl: 20 * 24 * 3600 });
  // المتأخرين عن الشهر اللي فات
  const prev = now.m === 1 ? 12 : now.m - 1;
  const rep = unpaidReport(data, prev);
  await sendText(config.agent.manager, `⏰ تذكير صيانة:\n\n${rep}`);
}
