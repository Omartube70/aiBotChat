/**
 * توب باور للمصاعد — صفحة عامة (تركيب + صيانة) يتبعت لينكها للناس.
 * GET /tp   (و /toppower)
 * ملاحظة: الأسعار/الملاحظات يحطها صاحب المحل بعدين — دلوقتي معلومات + تواصل واتساب.
 */
const WA = '201050699418'; // رقم واتساب المحل

export function handleTopPowerWeb(request, url) {
  const { pathname } = url;
  if (['/tp', '/tp/', '/toppower', '/toppower/'].includes(pathname)) {
    return new Response(PAGE, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  return null;
}

const wa = (msg) => `https://wa.me/${WA}?text=${encodeURIComponent(msg)}`;

const PAGE = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0F6E56">
<title>توب باور للمصاعد — تركيب وصيانة</title>
<style>
  :root{--g:#0F6E56;--gd:#085041;--gl:#E1F5EE;--bg:#f4f5f3;--card:#fff;--line:#e5e5e0;--mut:#6b6b66;--txt:#1c1c1a}
  *{box-sizing:border-box}
  body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Tahoma,Arial,sans-serif;background:var(--bg);color:var(--txt);line-height:1.7}
  .wrap{max-width:560px;margin:0 auto;padding:0 16px 40px}
  .hero{background:var(--g);color:var(--gl);text-align:center;padding:30px 16px 26px;border-radius:0 0 24px 24px}
  .hero .logo{font-size:40px}
  .hero h1{font-size:22px;font-weight:700;margin:8px 0 4px}
  .hero p{font-size:14px;margin:0;color:#bfe6d8}
  .card{background:var(--card);border:1px solid var(--line);border-radius:16px;padding:18px 18px;margin-top:16px}
  .card h2{font-size:18px;margin:0 0 6px;display:flex;align-items:center;gap:8px}
  .card p{font-size:14px;color:var(--mut);margin:0 0 14px}
  .btn{display:flex;align-items:center;justify-content:center;gap:8px;background:var(--g);color:#fff;text-decoration:none;border-radius:12px;padding:13px;font-size:16px;font-weight:600}
  .btn.o{background:transparent;color:var(--g);border:1.5px solid var(--g)}
  .tag{display:inline-block;background:var(--gl);color:var(--gd);font-size:12px;padding:3px 10px;border-radius:20px;margin:2px 2px 0}
  .contact{text-align:center;margin-top:22px;color:var(--mut);font-size:14px}
  .contact a{color:var(--g);font-weight:700;text-decoration:none;font-size:18px}
</style>
</head>
<body>
<div class="hero">
  <div class="logo">🛗</div>
  <h1>توب باور للمصاعد</h1>
  <p>تركيب وصيانة المصاعد — خبرة واحترافية</p>
</div>
<div class="wrap">

  <div class="card">
    <h2>🏗️ تركيب مصاعد</h2>
    <p>توريد وتركيب مصاعد جديدة بالكامل، بأحدث الماكينات وأعلى معايير الأمان. اطلب عرض سعر مجاني.</p>
    <a class="btn" href="${wa('السلام عليكم، عايز أستفسر عن تركيب مصعد جديد وأطلب عرض سعر.')}">اطلب عرض سعر تركيب على واتساب</a>
  </div>

  <div class="card">
    <h2>🔧 صيانة مصاعد</h2>
    <p>عقود صيانة دورية وإصلاح أعطال بسرعة. خدمة الصيانة متاحة في مناطق:</p>
    <div style="margin-bottom:14px"><span class="tag">الهضبة</span><span class="tag">حدائق الأهرام</span></div>
    <a class="btn o" href="${wa('السلام عليكم، عايز أستفسر عن صيانة مصعد / عقد صيانة.')}">اسأل عن الصيانة على واتساب</a>
  </div>

  <div class="contact">
    للتواصل المباشر:<br>
    <a href="tel:+${WA}">+${WA}</a><br>
    <span style="font-size:12px">واتساب ومكالمات</span>
  </div>

</div>
</body>
</html>`;
