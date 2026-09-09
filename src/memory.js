/**
 * ذاكرة محادثة قصيرة المدى.
 *  - على Cloudflare Workers: بتتخزّن في KV (binding اسمه MEMORY) وبتنتهي
 *    تلقائياً بعد TTL_SECONDS. القراءة من KV متسقة داخل نفس الـ colo،
 *    وكفاية لبوت متجر بحجم ده.
 *  - محلياً (من غير KV): بتتخزّن في الرام وتتصفّر لو العملية اتقفلت.
 *
 * كل الدوال async — نقاط التشغيل لازم تعمل await.
 */

const MAX_TURNS = 12; // عدد الرسائل المحفوظة لكل عميل (user + model)
const TTL_SECONDS = 30 * 60; // ننسى المحادثة بعد 30 دقيقة سكوت

const mem = new Map(); // fallback محلي: waId -> { history, updatedAt }
const prefMem = new Map(); // fallback محلي لتفضيل نوع الرد
const modeMem = new Map(); // fallback محلي لوضع المحادثة (bot/human)
const lastHandoffMem = new Map(); // agentId -> آخر عميل

const key = (waId) => `h:${waId}`;
const prefKey = (waId) => `pref:${waId}`;
const modeKey = (waId) => `mode:${waId}`;

export async function getHistory(waId, env) {
  const kv = env?.MEMORY;
  if (kv) {
    const data = await kv.get(key(waId), 'json');
    return Array.isArray(data) ? data : [];
  }
  const entry = mem.get(waId);
  if (!entry) return [];
  if (Date.now() - entry.updatedAt > TTL_SECONDS * 1000) {
    mem.delete(waId);
    return [];
  }
  return entry.history;
}

export async function saveHistory(waId, history, env) {
  const trimmed = history.slice(-MAX_TURNS); // آخر MAX_TURNS عنصر مع الحفاظ على التسلسل
  const kv = env?.MEMORY;
  if (kv) {
    await kv.put(key(waId), JSON.stringify(trimmed), { expirationTtl: TTL_SECONDS });
    return;
  }
  mem.set(waId, { history: trimmed, updatedAt: Date.now() });
}

export async function resetHistory(waId, env) {
  const kv = env?.MEMORY;
  if (kv) {
    await kv.delete(key(waId));
    return;
  }
  mem.delete(waId);
}

/**
 * تفضيل نوع الرد لكل عميل: 'voice' أو 'text' أو null (تلقائي = يقلّد رسالة العميل).
 */
export async function getPref(waId, env) {
  const kv = env?.MEMORY;
  if (kv) return (await kv.get(prefKey(waId))) || null;
  return prefMem.get(waId) || null;
}

export async function setPref(waId, env, mode) {
  const kv = env?.MEMORY;
  if (kv) {
    if (mode) await kv.put(prefKey(waId), mode);
    else await kv.delete(prefKey(waId));
    return;
  }
  if (mode) prefMem.set(waId, mode);
  else prefMem.delete(waId);
}

/**
 * وضع المحادثة: 'bot' (افتراضي) أو رقم واتساب الموظف اللي بيتابع العميل.
 * بينتهي تلقائيًا بعد ttl لو الموظف نسي يقفله.
 */
export async function getMode(waId, env) {
  const kv = env?.MEMORY;
  if (kv) return (await kv.get(modeKey(waId))) || 'bot';
  const e = modeMem.get(waId);
  if (!e || Date.now() > e.exp) {
    modeMem.delete(waId);
    return 'bot';
  }
  return e.mode;
}

export async function setMode(waId, env, mode, ttl = 7200) {
  const kv = env?.MEMORY;
  if (kv) {
    if (!mode || mode === 'bot') await kv.delete(modeKey(waId));
    else await kv.put(modeKey(waId), mode, { expirationTtl: ttl });
    return;
  }
  if (!mode || mode === 'bot') modeMem.delete(waId);
  else modeMem.set(waId, { mode, exp: Date.now() + ttl * 1000 });
}

/** آخر عميل اتحوّل لكل موظف — عشان الموظف يرد من غير ما يكتب الرقم كل مرة. */
export async function setLastHandoff(agentId, waId, env, ttl = 7200) {
  const kv = env?.MEMORY;
  if (kv) await kv.put(`lasthandoff:${agentId}`, waId, { expirationTtl: ttl });
  else lastHandoffMem.set(agentId, waId);
}

export async function getLastHandoff(agentId, env) {
  const kv = env?.MEMORY;
  if (kv) return (await kv.get(`lasthandoff:${agentId}`)) || null;
  return lastHandoffMem.get(agentId) || null;
}
