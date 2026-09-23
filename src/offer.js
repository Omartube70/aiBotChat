import { unzipSync, zipSync, strToU8, strFromU8 } from 'fflate';

/**
 * عرض تركيب مصعد (توب باور) — بيملا قالب Word (src/templates/offer-template.docx)
 * اللي فيه خانات {{...}} بالبيانات اللي الموظف بعتها على واتساب.
 */

/** الخانات اللي لازم تكون موجودة قبل ما نطلّع العرض. */
export const OFFER_REQUIRED = {
  client: 'اسم العميل',
  type: 'نوع المصعد',
  floors: 'عدد الأدوار',
  load: 'الحمولة (كجم)',
  price: 'السعر',
};

export const OFFER_LABELS = {
  ...OFFER_REQUIRED,
  address: 'عنوان العقار',
  phone: 'رقم التليفون',
  machine: 'الماكينة',
  brand: 'اسم الماكينة',
  hp: 'قدرة الماكينة (حصان)',
  doors: 'الأبواب',
  count: 'عدد المصاعد',
  travel: 'المشوار (متر)',
  stops: 'عدد الوقفات',
  speed: 'السرعة (م/ث)',
  persons: 'عدد الأفراد',
  entrances: 'عدد المداخل',
  pay1: 'دفعة التعاقد %',
  pay2: 'دفعة الماكينة والكابينة %',
  pay3: 'دفعة الكنترول %',
  pay4: 'دفعة التشغيل والاستلام %',
};

function num(v) {
  const n = Number(String(v ?? '').replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d)).replace(/[,،\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** يدمج بيانات جديدة على المسودة (القيم الفاضية ما بتمسحش القديمة). */
export function mergeOffer(draft, fields) {
  const out = { ...(draft || {}) };
  for (const k of Object.keys(OFFER_LABELS)) {
    const v = fields?.[k];
    if (v != null && String(v).trim() !== '') out[k] = String(v).trim();
  }
  return out;
}

export function missingOfferFields(d) {
  const missing = Object.keys(OFFER_REQUIRED).filter((k) => !d[k]);
  // الحمولة ممكن تتحسب من عدد الأفراد
  if (missing.includes('load') && num(d.persons)) missing.splice(missing.indexOf('load'), 1);
  return missing;
}

/** يكمّل القيم اللي ممكن تتحسب أو ليها افتراضي معروف. */
export function completeOffer(d) {
  const o = { ...d };
  // العميل ممكن يكتب "6 حصان" أو "8 أدوار" — ناخد الرقم بس عشان العرض ما يتكررش فيه الكلام
  for (const k of ['hp', 'floors', 'stops', 'load', 'persons']) {
    const m = String(o[k] ?? '').replace(/[٠-٩]/g, (c) => '٠١٢٣٤٥٦٧٨٩'.indexOf(c)).match(/\d+(?:\.\d+)?/);
    if (m) o[k] = m[0];
  }
  const floors = num(o.floors);
  if (!o.load && num(o.persons)) o.load = String(num(o.persons) * 75);
  if (!o.persons && num(o.load)) o.persons = String(Math.floor(num(o.load) / 75));
  if (!o.stops && floors) o.stops = String(floors + 1); // الأدوار + الأرضي
  if (!o.count) o.count = '1';
  if (!o.speed) o.speed = 'نصف';
  if (!o.entrances) o.entrances = '1';
  // عنوان الماكينة: "إيطالي سيكور أو جيم — قدرة 7.5 حصان"
  o.machineLine = [[o.machine, o.brand].filter(Boolean).join(' '), o.hp ? `قدرة ${o.hp} حصان` : '']
    .filter(Boolean)
    .join(' — ');
  if (num(o.price)) o.price = num(o.price).toLocaleString('en-US');
  return o;
}

function esc(s) {
  return String(s).replace(
    /[<>&'"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c],
  );
}

const BLUE = '<w:color w:val="0070C0"/>';

/** نفس تنسيق الـ run بس باللون الأزرق (w:color لازم يتحط في مكانه حسب ترتيب الـ schema). */
function blueRPr(rPr) {
  if (!rPr) return `<w:rPr>${BLUE}</w:rPr>`;
  if (/<w:color\b[^>]*\/>/.test(rPr)) return rPr.replace(/<w:color\b[^>]*\/>/, BLUE);
  const after = rPr.match(
    /<w:(?:spacing|w|kern|position|sz|szCs|highlight|u|effect|bdr|shd|fitText|vertAlign|rtl|cs|em|lang|eastAsianLayout)\b/,
  );
  return after
    ? rPr.slice(0, after.index) + BLUE + rPr.slice(after.index)
    : rPr.replace('</w:rPr>', `${BLUE}</w:rPr>`);
}

export function cairoDate() {
  const p = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Cairo', day: '2-digit', month: '2-digit', year: 'numeric',
  }).format(new Date());
  return p; // dd/mm/yyyy
}

/**
 * @param {ArrayBuffer|Uint8Array} template ملف القالب
 * @param {object} data البيانات بعد completeOffer
 * @returns {Uint8Array} ملف docx
 */
export function buildOfferDocx(template, data) {
  const files = unzipSync(template instanceof Uint8Array ? template : new Uint8Array(template));
  const values = {
    date: cairoDate(),
    currency: 'جنيه',
    ...data,
  };
  const blank = '      ';
  const val = (k) => (values[k] != null && values[k] !== '' ? esc(values[k]) : blank);
  // كل run فيه خانة بيتقسم: النص الثابت بتنسيقه الأصلي، والقيمة نفسها بالأزرق
  const xml = strFromU8(files['word/document.xml'])
    .replace(
      /<w:r(?: [^>]*)?>(<w:rPr>(?:(?!<\/w:rPr>)[\s\S])*<\/w:rPr>)?<w:t[^>]*>([^<]*\{\{\w+\}\}[^<]*)<\/w:t><\/w:r>/g,
      (_, rPr = '', text) =>
        text
          .split(/(\{\{\w+\}\})/)
          .filter(Boolean)
          .map((seg) => {
            const tag = seg.match(/^\{\{(\w+)\}\}$/);
            const props = tag ? blueRPr(rPr) : rPr;
            return `<w:r>${props}<w:t xml:space="preserve">${tag ? val(tag[1]) : seg}</w:t></w:r>`;
          })
          .join(''),
    )
    .replace(/\{\{(\w+)\}\}/g, (_, k) => val(k));
  files['word/document.xml'] = strToU8(xml);
  return zipSync(files, { level: 6 });
}

/** ملخّص نصّي للعرض يتبعت مع الملف. */
export function offerSummary(d) {
  return Object.entries(OFFER_LABELS)
    .filter(([k]) => d[k])
    .map(([k, label]) => `• ${label}: ${d[k]}`)
    .join('\n');
}
