/**
 * WhatsApp Flows — فورم بخانات حقيقية بتتملي جوه واتساب:
 *  - QUOTE_FLOW: العميل بيملا بيانات عرض التركيب (6 خانات).
 *  - PRICE_FLOW: الموظف بيكتب السعر في خانة واحدة.
 * بيتعملوا مرة واحدة على حساب واتساب بيزنس بـ setupFlows() (من /admin/setup-flows)،
 * والـ IDs بتتحفظ في KV تحت flows:ids.
 */
import { config } from './config.js';

export const FLOW_IDS_KEY = 'flows:ids';

// ids الماكينة بالإنجليزي (أضمن في الـ Flow JSON) وبنرجّعها عربي
export const MACHINE_TITLES = { italian: 'إيطالي', turkish: 'تركي' };

const QUOTE_FLOW = {
  version: '5.0',
  screens: [
    {
      id: 'QUOTE',
      title: 'عرض سعر تركيب مصعد',
      terminal: true,
      success: true,
      layout: {
        type: 'SingleColumnLayout',
        children: [
          {
            type: 'Form',
            name: 'form',
            children: [
              { type: 'TextInput', name: 'client', label: 'الاسم', 'input-type': 'text', required: true },
              { type: 'TextInput', name: 'address', label: 'العنوان', 'input-type': 'text', required: true },
              { type: 'TextInput', name: 'phone', label: 'رقم التليفون', 'input-type': 'phone', required: true },
              {
                type: 'Dropdown',
                name: 'machine',
                label: 'نوع الماكينة',
                required: true,
                'data-source': Object.entries(MACHINE_TITLES).map(([id, title]) => ({ id, title })),
              },
              { type: 'TextInput', name: 'hp', label: 'قدرة الماكينة (حصان)', 'input-type': 'number', required: true },
              { type: 'TextInput', name: 'floors', label: 'عدد الأدوار', 'input-type': 'number', required: true },
              {
                type: 'Footer',
                label: 'إرسال',
                'on-click-action': {
                  name: 'complete',
                  payload: {
                    client: '${form.client}',
                    address: '${form.address}',
                    phone: '${form.phone}',
                    machine: '${form.machine}',
                    hp: '${form.hp}',
                    floors: '${form.floors}',
                  },
                },
              },
            ],
          },
        ],
      },
    },
  ],
};

const PRICE_FLOW = {
  version: '5.0',
  screens: [
    {
      id: 'PRICE',
      title: 'سعر العرض',
      terminal: true,
      success: true,
      layout: {
        type: 'SingleColumnLayout',
        children: [
          {
            type: 'Form',
            name: 'form',
            children: [
              { type: 'TextInput', name: 'price', label: 'السعر (جنيه)', 'input-type': 'number', required: true },
              {
                type: 'Footer',
                label: 'ابعت العرض للعميل',
                'on-click-action': { name: 'complete', payload: { price: '${form.price}' } },
              },
            ],
          },
        ],
      },
    },
  ],
};

const graph = (path) => `https://graph.facebook.com/${config.whatsapp.graphVersion}/${path}`;

async function gfetch(path, init = {}) {
  const res = await fetch(graph(path), {
    ...init,
    headers: { Authorization: `Bearer ${config.whatsapp.token}`, ...(init.headers || {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${path} ${res.status}: ${JSON.stringify(body.error || body).slice(0, 400)}`);
  return body;
}

/** رقم حساب واتساب بيزنس (WABA) من صلاحيات التوكن نفسه. */
async function findWabaId(env) {
  if (env?.WABA_ID) return env.WABA_ID;
  const t = encodeURIComponent(config.whatsapp.token);
  const d = await gfetch(`debug_token?input_token=${t}&access_token=${t}`);
  const scopes = d?.data?.granular_scopes || [];
  const s =
    scopes.find((x) => x.scope === 'whatsapp_business_management') ||
    scopes.find((x) => x.scope === 'whatsapp_business_messaging');
  let id = s?.target_ids?.[0];
  // توكن System User عنده صلاحية على كل الحسابات من غير target_ids → ندوّر على الحساب
  // اللي فيه رقم الواتساب بتاعنا جوه الـ Business
  if (!id) {
    const bizs = (await gfetch('me/businesses?fields=id,name').catch(() => ({}))).data || [];
    outer: for (const b of bizs) {
      for (const edge of ['owned_whatsapp_business_accounts', 'client_whatsapp_business_accounts']) {
        const wabas = (await gfetch(`${b.id}/${edge}?fields=id,name`).catch(() => ({}))).data || [];
        for (const w of wabas) {
          const phones = (await gfetch(`${w.id}/phone_numbers?fields=id`).catch(() => ({}))).data || [];
          if (phones.some((p) => p.id === config.whatsapp.phoneNumberId)) {
            id = w.id;
            break outer;
          }
        }
      }
    }
  }
  if (!id) {
    const info = { type: d?.data?.type, scopes: d?.data?.scopes, granular: scopes.map((x) => x.scope) };
    throw new Error(`مش لاقي WABA ID في صلاحيات التوكن — حطه في WABA_ID. ${JSON.stringify(info)}`);
  }
  return id;
}

async function createAndPublish(waba, name, category, json) {
  const fd = new FormData();
  fd.append('name', name);
  fd.append('categories', JSON.stringify([category]));
  const { id } = await gfetch(`${waba}/flows`, { method: 'POST', body: fd });

  const up = new FormData();
  up.append('file', new Blob([JSON.stringify(json)], { type: 'application/json' }), 'flow.json');
  up.append('name', 'flow.json');
  up.append('asset_type', 'FLOW_JSON');
  const asset = await gfetch(`${id}/assets`, { method: 'POST', body: up });
  if (asset.validation_errors?.length) {
    throw new Error(`Flow "${name}" فيه أخطاء: ${JSON.stringify(asset.validation_errors).slice(0, 600)}`);
  }
  await gfetch(`${id}/publish`, { method: 'POST' });
  return id;
}

/** يعمل الفورمين وينشرهم ويحفظ الـ IDs. @returns {{waba, quote, price}} */
export async function setupFlows(env) {
  const waba = await findWabaId(env);
  const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const quote = await createAndPublish(waba, `quote_${stamp}`, 'LEAD_GENERATION', QUOTE_FLOW);
  const price = await createAndPublish(waba, `price_${stamp}`, 'OTHER', PRICE_FLOW);
  const ids = { waba, quote, price };
  await env.MEMORY.put(FLOW_IDS_KEY, JSON.stringify(ids));
  return ids;
}

export async function getFlowIds(env) {
  return (env?.MEMORY && (await env.MEMORY.get(FLOW_IDS_KEY, 'json'))) || {};
}
