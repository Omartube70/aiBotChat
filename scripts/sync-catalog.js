/**
 * تنزيل كل منتجات المتجر في ملف catalog-dump.json للمراجعة.
 * التشغيل:  npm run sync
 */
import '../src/load-env.js';
import { writeFile } from 'node:fs/promises';
import { fetchAllProducts } from '../src/catalog.js';

const products = await fetchAllProducts();
const outOfStock = products.filter((p) => !p.inStock).length;

await writeFile(
  'catalog-dump.json',
  JSON.stringify({ count: products.length, outOfStock, products }, null, 2),
  'utf8',
);

console.log(`✅ ${products.length} منتج (${outOfStock} غير متوفر) — اتحفظوا في catalog-dump.json`);
