import { config } from './config.js';

/**
 * الزبون بعت لوكيشن → المسافة لحد المحل + الوقت بالعربية + الطرق الأساسية + لينك اتجاهات جوجل.
 * الطريق من OSRM (مجاني ومن غير مفتاح)، والكلام بيتصاغ بالمصري بـ Gemini، ولو أي حاجة فشلت بنرد برسالة جاهزة.
 */

const S = config.store;

/** المسافة في خط مستقيم (كم). */
function airKm(a, b) {
  const R = 6371;
  const rad = (x) => (x * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function osrmRoute(from) {
  const url =
    `https://router.project-osrm.org/route/v1/driving/${from.lng},${from.lat};${S.lng},${S.lat}` +
    '?overview=false&steps=true';
  const res = await fetch(url, { signal: AbortSignal.timeout(6000), headers: { 'User-Agent': 'quds-bot' } });
  if (!res.ok) throw new Error(`OSRM ${res.status}`);
  const j = await res.json();
  const r = j.routes?.[0];
  if (!r) throw new Error('OSRM: مفيش طريق');
  // الطرق الأساسية بالترتيب (اللي الزبون بيمشي فيها مسافة معقولة)، من غير تكرار
  const roads = [];
  for (const s of r.legs?.[0]?.steps || []) {
    const name = (s.name || s.ref || '').trim();
    if (name && s.distance >= 300 && roads[roads.length - 1] !== name) roads.push(name);
  }
  return { km: r.distance / 1000, min: r.duration / 60, roads: roads.slice(0, 8) };
}

const fmtKm = (km) => (km < 1 ? `${Math.round(km * 1000)} متر` : `${Math.round(km * 10) / 10} كم`);
const fmtMin = (m) => (m < 60 ? `${Math.max(1, Math.round(m))} دقيقة` : `${Math.floor(m / 60)} ساعة و${Math.round(m % 60)} دقيقة`);

async function phrase(info) {
  const prompt =
    `زبون بعت اللوكيشن بتاعه لمحل "${S.name}" (قطع غيار مصاعد). اكتبله رد قصير بالعامية المصرية (4-6 سطور) بيقوله:\n` +
    `- المسافة بينه وبين المحل ${fmtKm(info.km)} تقريبًا، ومشوار حوالي ${fmtMin(info.min)} بالعربية (من غير زحمة).\n` +
    (info.roads.length ? `- الطريق بيعدّي على: ${info.roads.join(' ← ')} (اذكر أهم 2-4 منهم بأسماء مفهومة).\n` : '') +
    `- عنوان المحل (انسخه بالحرف من غير أي تغيير): ${S.address}\n` +
    `- لو المسافة قريبة (أقل من 4 كم) قوله إننا قريبين منه. وفي الآخر قوله يبعت اسم القطعة اللي محتاجها عشان نجهزهاله قبل ما يوصل.\n` +
    `- ماتوعدش بتوصيل أو شحن أو مواعيد.\n` +
    `ماتخترعش طرق أو علامات مش مكتوبة هنا. من غير markdown، ونجمة واحدة *كده* للتقيل بس. ماتكتبش لينكات (هتتحط لوحدها).`;
  const res = await fetch(`${config.gemini.baseUrl}/models/${config.gemini.model}:generateContent?key=${config.gemini.apiKey}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(9000),
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.5,
        maxOutputTokens: 500,
        ...(/lite/.test(config.gemini.model) ? { thinkingConfig: { thinkingLevel: 'minimal' } } : {}),
      },
    }),
  });
  if (!res.ok) throw new Error(`Gemini ${res.status}`);
  const j = await res.json();
  return (j.candidates?.[0]?.content?.parts || []).map((p) => p.text).filter(Boolean).join('').trim();
}

/**
 * @param {{lat:number,lng:number}} from لوكيشن الزبون
 * @returns {Promise<{text:string, summary:string}>} text = الرد للزبون، summary = سطر للموظفين/الذاكرة
 */
export async function directionsReply(from) {
  const link =
    `https://www.google.com/maps/dir/?api=1&origin=${from.lat},${from.lng}` +
    `&destination=${S.lat},${S.lng}&travelmode=driving`;
  let info;
  try {
    info = await osrmRoute(from);
  } catch (err) {
    console.warn('[directions]', err.message);
    // من غير طريق: المسافة في خط مستقيم × 1.3 تقريب للطريق الفعلي
    const km = airKm(from, S) * 1.3;
    info = { km, min: (km / 30) * 60, roads: [], approx: true };
  }
  let body = '';
  try {
    body = await phrase(info);
  } catch (err) {
    console.warn('[directions] صياغة:', err.message);
  }
  if (!body) {
    body =
      `📍 وصلني اللوكيشن بتاعك 👍\n` +
      `المسافة بينك وبين المحل حوالي *${fmtKm(info.km)}* — يعني مشوار ${fmtMin(info.min)} تقريبًا بالعربية.\n` +
      (info.roads.length ? `الطريق: ${info.roads.slice(0, 4).join(' ← ')}\n` : '') +
      `العنوان: ${S.address}`;
  }
  const text = `${body}\n\n🧭 دوس هنا والخريطة توصّلك لحد باب المحل:\n${link}`;
  const summary =
    `📍 بعت لوكيشن — بيبعد ${fmtKm(info.km)} (${fmtMin(info.min)} بالعربية)` +
    (info.roads.length ? ` عن طريق ${info.roads.slice(0, 3).join(' ← ')}` : '') +
    `\nلوكيشنه: https://maps.google.com/?q=${from.lat},${from.lng}`;
  return { text, summary };
}
