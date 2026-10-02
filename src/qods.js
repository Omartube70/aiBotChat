/**
 * القدس لمهمات المصاعد — كتالوج المنتجات (مرحلة 1).
 * صفحة عامة (من غير دخول) بكل المنتجات بصورها وأسعار بيعها + بحث — لينك تتبعت لأي حد.
 * المنتجات من كتالوج إنياد المحفوظ (KV catalog:snapshot) اللي البوت بيحدّثه كل 30 دقيقة.
 *
 *   GET /qods                 صفحة الكتالوج العامة
 *   GET /qods/api/products    قائمة المنتجات (اسم، سعر البيع، صورة، فئة) — من غير تكلفة
 */
const SNAP_KEY = 'catalog:snapshot';

async function allProducts(env) {
  const snap = await env.MEMORY.get(SNAP_KEY, 'json');
  return (snap && Array.isArray(snap.products)) ? snap.products : [];
}

export async function handleQodsWeb(request, url, env) {
  const { pathname } = url;
  if (pathname === '/qods' || pathname === '/qods/') {
    return new Response(CATALOG_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }
  if (pathname === '/qods/api/products' && request.method === 'GET') {
    const prods = await allProducts(env);
    const q = (url.searchParams.get('q') || '').trim();
    const list = prods
      .filter((p) => p && p.name && p.price != null)
      .map((p) => ({
        id: p.id,
        name: p.name,
        cat: p.category || '',
        price: p.price,
        priceMax: p.priceMax && p.priceMax !== p.price ? p.priceMax : null,
        img: p.imageUrl || null,
        inStock: p.inStock !== false,
      }));
    return new Response(JSON.stringify({ ok: true, count: list.length, products: list }), {
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=300' },
    });
  }
  return null;
}

const CATALOG_HTML = `<!doctype html>
<html lang="ar" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#0F6E56">
<title>القدس لمهمات المصاعد — المنتجات</title>
<style>
  :root{--g:#0F6E56;--gd:#085041;--gl:#E1F5EE;--bg:#f4f5f3;--card:#fff;--line:#e5e5e0;--mut:#6b6b66;--txt:#1c1c1a}
  *{box-sizing:border-box}
  body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",Tahoma,Arial,sans-serif;background:var(--bg);color:var(--txt)}
  header{position:sticky;top:0;z-index:5;background:var(--g);color:var(--gl);padding:12px 16px}
  header .t{font-size:17px;font-weight:600;display:flex;align-items:center;gap:8px}
  .wrap{max-width:900px;margin:0 auto;padding:12px 14px}
  .search{display:flex;align-items:center;gap:8px;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:0 12px;margin-bottom:12px}
  .search input{border:0;outline:0;padding:12px 0;font-size:16px;width:100%;background:transparent;font-family:inherit}
  .count{font-size:13px;color:var(--mut);margin-bottom:10px}
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:12px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden;display:flex;flex-direction:column}
  .imgbox{width:100%;aspect-ratio:1/1;background:#eee;display:flex;align-items:center;justify-content:center;overflow:hidden}
  .imgbox img{width:100%;height:100%;object-fit:cover}
  .imgbox .ph{color:#bbb;font-size:30px}
  .info{padding:9px 10px}
  .nm{font-size:13px;font-weight:600;line-height:1.4;min-height:36px}
  .pr{margin-top:6px;color:var(--g);font-weight:700;font-size:15px}
  .cat{font-size:11px;color:var(--mut);margin-top:2px}
  .out{font-size:11px;color:#A32D2D;margin-top:3px}
  .empty{text-align:center;color:var(--mut);padding:40px 0}
</style>
</head>
<body>
<header><div class="t">🛗 القدس لمهمات المصاعد</div></header>
<div class="wrap">
  <div class="search">🔎<input id="q" placeholder="دوّر على منتج بالاسم..." autocomplete="off"></div>
  <div class="count" id="count">بيحمّل المنتجات...</div>
  <div class="grid" id="grid"></div>
</div>
<script>
var ALL=[],CUR=[];
function money(n){return (Math.round(Number(n)||0)).toLocaleString('en-US');}
function esc(s){return String(s==null?'':s).replace(/[<>&"]/g,function(c){return {'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'}[c];});}
function norm(s){return String(s||'').toLowerCase().replace(/[أإآ]/g,'ا').replace(/ة/g,'ه').replace(/[ىي]/g,'ي').replace(/\s+/g,' ').trim();}
function priceTxt(p){return p.priceMax?(money(p.price)+' - '+money(p.priceMax)):money(p.price);}
function card(p){
  var img=p.img?('<img loading="lazy" src="'+esc(p.img)+'" onerror="this.parentNode.innerHTML=&quot;<span class=ph>🛗</span>&quot;">'):'<span class="ph">🛗</span>';
  return '<div class="card"><div class="imgbox">'+img+'</div><div class="info"><div class="nm">'+esc(p.name)+'</div>'+(p.cat?'<div class="cat">'+esc(p.cat)+'</div>':'')+'<div class="pr">'+priceTxt(p)+' ج.م</div>'+(p.inStock?'':'<div class="out">غير متوفر حاليًا</div>')+'</div></div>';
}
function render(){
  var g=document.getElementById('grid');
  if(!CUR.length){g.innerHTML='<div class="empty">مفيش منتجات بالاسم ده</div>';document.getElementById('count').textContent='';return;}
  document.getElementById('count').textContent=CUR.length+' منتج';
  g.innerHTML=CUR.map(card).join('');
}
function search(q){
  q=norm(q);
  CUR=q?ALL.filter(function(p){return norm(p.name+' '+p.cat).indexOf(q)>=0;}):ALL;
  render();
}
fetch('/qods/api/products').then(function(r){return r.json();}).then(function(d){
  ALL=d.products||[];CUR=ALL;
  if(!ALL.length){document.getElementById('count').textContent='';document.getElementById('grid').innerHTML='<div class="empty">الكتالوج بيتحدّث دلوقتي، جرّب بعد شوية 🙏</div>';return;}
  render();
  var qi=document.getElementById('q'),t;qi.addEventListener('input',function(){clearTimeout(t);t=setTimeout(function(){search(qi.value);},180);});
}).catch(function(){document.getElementById('count').textContent='';document.getElementById('grid').innerHTML='<div class="empty">حصلت مشكلة في التحميل، جرّب تاني 🙏</div>';});
</script>
</body>
</html>`;
