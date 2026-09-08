/**
 * ذاكرة محادثة بسيطة في الرام (تتصفّر لو السيرفر اتقفل).
 * لو احتجت ذاكرة دائمة استبدلها بـ Redis أو قاعدة بيانات.
 */

const MAX_TURNS = 12; // عدد الرسائل المحفوظة لكل عميل (user + model)
const TTL_MS = 30 * 60 * 1000; // ننسى المحادثة بعد 30 دقيقة سكوت

const store = new Map(); // waId -> { history: [], updatedAt: number }

export function getHistory(waId) {
  const entry = store.get(waId);
  if (!entry) return [];
  if (Date.now() - entry.updatedAt > TTL_MS) {
    store.delete(waId);
    return [];
  }
  return entry.history;
}

export function saveHistory(waId, history) {
  // نحتفظ بآخر MAX_TURNS عنصر فقط، مع الحفاظ على تسلسل الأدوار
  const trimmed = history.slice(-MAX_TURNS);
  store.set(waId, { history: trimmed, updatedAt: Date.now() });
}

export function resetHistory(waId) {
  store.delete(waId);
}

// تنظيف دوري
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of store) {
    if (now - v.updatedAt > TTL_MS) store.delete(k);
  }
}, 10 * 60 * 1000).unref?.();
