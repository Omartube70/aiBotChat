/**
 * غلاف بنفس واجهة KV (get / put / delete) بس فوق D1 — متسق فورًا.
 * KV بيكاش القراءة لحد 60 ثانية، فلو زبون رد بسرعة ممكن نقرا الحالة القديمة
 * ونعيد نفس السؤال. D1 بيرجّع آخر حاجة اتكتبت على طول.
 *
 * الانتقال: لو المفتاح مش في D1 لسه بنقراه من KV القديم (بيانات قبل النقل زي أرقام الزباين)،
 * والحذف بيحذف من الاتنين عشان القيمة القديمة ما ترجعش.
 */
// الجدول بيتعمل أول مرة لوحده (مرة واحدة لكل isolate)
let ready = null;
function ensureTable(db) {
  ready ||= db
    .prepare('CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER)')
    .run()
    .catch((err) => {
      ready = null;
      throw err;
    });
  return ready;
}

export function d1kv(db, oldKv) {
  const now = () => Math.floor(Date.now() / 1000);
  return {
    async get(key, type) {
      await ensureTable(db);
      const row = await db
        .prepare('SELECT v, exp FROM kv WHERE k = ?1')
        .bind(key)
        .first();
      let raw = null;
      if (row && (!row.exp || row.exp > now())) raw = row.v;
      else if (!row && oldKv) raw = await oldKv.get(key);
      if (raw == null) return null;
      if (type === 'json') {
        try {
          return JSON.parse(raw);
        } catch {
          return null;
        }
      }
      return raw;
    },
    async put(key, value, opts = {}) {
      await ensureTable(db);
      const exp = opts.expirationTtl ? now() + Number(opts.expirationTtl) : null;
      await db
        .prepare('INSERT INTO kv (k, v, exp) VALUES (?1, ?2, ?3) ON CONFLICT(k) DO UPDATE SET v = ?2, exp = ?3')
        .bind(key, String(value), exp)
        .run();
    },
    async delete(key) {
      await ensureTable(db);
      await db.prepare('DELETE FROM kv WHERE k = ?1').bind(key).run();
      if (oldKv) await oldKv.delete(key);
    },
  };
}

/** يرجّع env بس MEMORY فيه بقى D1 (لو الـ binding موجود). */
export function withD1(env) {
  if (!env?.DB || env.__d1) return env;
  return { ...env, MEMORY: d1kv(env.DB, env.MEMORY), __d1: true };
}
