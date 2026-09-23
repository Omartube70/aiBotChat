/**
 * تعديلات سعر يدوية (بيع/شراء) بيحطها الموظفين عبر واتساب، وبتتفعّل فورًا في
 * ردود البوت للعملاء — من غير ما تلمس بيانات إنياد الأصلية (بتتخزّن في KV
 * وبتتطبّق فوق سعر إنياد وقت البحث، مش بتستبدله).
 *
 * التخزين: بلوك JSON واحد (price:overrides) — اسم المنتج (بعد التوحيد) → { sale?, cost? }.
 */

const KEY = 'price:overrides';

// نفس isolate الطلب الحالي — بيتحدّث أول كل fetch/scheduled زي applyEnv بالظبط.
let envRef = null;
export function setEnvRef(env) {
  if (env) envRef = env;
}

export async function getOverrides() {
  const kv = envRef?.MEMORY;
  if (!kv) return {};
  return (await kv.get(KEY, 'json')) || {};
}

/** يحفظ تعديل سعر لمنتج (بالاسم بعد التوحيد عبر normalizeAr). patch: { sale? } أو { cost? } */
export async function setOverride(normalizedName, patch) {
  const kv = envRef?.MEMORY;
  if (!kv) return;
  const all = (await kv.get(KEY, 'json')) || {};
  all[normalizedName] = { ...(all[normalizedName] || {}), ...patch, updatedAt: Date.now() };
  await kv.put(KEY, JSON.stringify(all));
}

/** يمسح تعديل حقل معيّن ('sale' أو 'cost') لمنتج، ويشيل المنتج كله لو فضي. */
export async function clearOverride(normalizedName, field) {
  const kv = envRef?.MEMORY;
  if (!kv) return;
  const all = (await kv.get(KEY, 'json')) || {};
  if (!all[normalizedName]) return;
  delete all[normalizedName][field];
  if (!('sale' in all[normalizedName]) && !('cost' in all[normalizedName])) {
    delete all[normalizedName];
  }
  await kv.put(KEY, JSON.stringify(all));
}
