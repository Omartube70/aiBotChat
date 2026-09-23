import { zipSync, strToU8 } from 'fflate';
import { config } from './config.js';

const S = config.store;

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[ً-ْـ]/g, '')
    .replace(/[أإآ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/[ىي]/g, 'ي')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * يطابق الأصناف المستخرجة (name, qty) بمنتجات البحث ويحسب الإجماليات.
 * @returns {{lines: Array<{name,qty,unit,total}>, missing: string[], grand: number}}
 */
export function computeInvoice(order, products) {
  const exact = new Map(products.map((p) => [norm(p['الاسم']), p]));
  const lines = [];
  const missing = [];

  for (const item of order) {
    const key = norm(item.name);
    let p = exact.get(key);
    if (!p) {
      p = products.find(
        (x) => norm(x['الاسم']).includes(key) || key.includes(norm(x['الاسم'])),
      );
    }
    const unit = p ? Number(p._price) : NaN;
    if (!p || !Number.isFinite(unit)) {
      missing.push(item.name);
      continue;
    }
    const qty = Math.max(1, Math.round(Number(item.qty) || 1));
    lines.push({ name: p['الاسم'], qty, unit, total: Math.round(unit * qty * 100) / 100 });
  }

  const grand = Math.round(lines.reduce((s, l) => s + l.total, 0) * 100) / 100;
  return { lines, missing, grand };
}

function esc(s) {
  return String(s).replace(
    /[<>&'"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c],
  );
}

function colRef(i) {
  let s = '';
  i++;
  while (i > 0) {
    const m = (i - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    i = Math.floor((i - 1) / 26);
  }
  return s;
}

/**
 * يبني ملف xlsx بسيط للفاتورة (باسم المحل).
 * @returns {Uint8Array}
 */
export function buildInvoiceXlsx({ lines, grand }) {
  const date = new Date().toISOString().slice(0, 10);

  const rows = [
    [S.name],
    [S.address],
    [`ت: ${S.phone} / ${S.extraPhone}`],
    [`فاتورة مبدئية — ${date}`],
    [],
    ['الصنف', 'الكمية', `سعر الوحدة (${S.currency})`, `الإجمالي (${S.currency})`],
    ...lines.map((l) => [l.name, l.qty, l.unit, l.total]),
    [],
    ['', '', 'الإجمالي الكلي', grand],
    [],
    [`الأسعار قابلة للتغيير — للتأكيد كلمنا واتساب ${S.whatsapp}`],
  ];

  return buildTableXlsx(rows, 'فاتورة');
}

/** يبني xlsx بسيط من مصفوفة صفوف (RTL) — يستخدمه الفاتورة وشيت الرواتب. */
export function buildTableXlsx(rows, sheetName = 'شيت') {
  const sheetData = rows
    .map((cells, r) => {
      const c = cells
        .map((val, i) => {
          const ref = colRef(i) + (r + 1);
          if (typeof val === 'number' && Number.isFinite(val)) {
            return `<c r="${ref}"><v>${val}</v></c>`;
          }
          const text = val == null ? '' : String(val);
          return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(text)}</t></is></c>`;
        })
        .join('');
      return `<row r="${r + 1}">${c}</row>`;
    })
    .join('');

  const sheetXml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<sheetViews><sheetView rightToLeft="1" workbookViewId="0"/></sheetViews>` +
    `<cols><col min="1" max="1" width="34" customWidth="1"/><col min="2" max="4" width="16" customWidth="1"/></cols>` +
    `<sheetData>${sheetData}</sheetData></worksheet>`;

  const files = {
    '[Content_Types].xml':
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
      `<Default Extension="xml" ContentType="application/xml"/>` +
      `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
      `<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>` +
      `</Types>`,
    '_rels/.rels':
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
      `</Relationships>`,
    'xl/workbook.xml':
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
      `<sheets><sheet name="${esc(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    'xl/_rels/workbook.xml.rels':
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
      `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
      `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>` +
      `</Relationships>`,
    'xl/worksheets/sheet1.xml': sheetXml,
  };

  const zipInput = {};
  for (const [k, v] of Object.entries(files)) zipInput[k] = strToU8(v);
  return zipSync(zipInput, { level: 6 });
}
