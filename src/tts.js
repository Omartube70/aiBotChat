import { Mp3Encoder } from '@breezystack/lamejs';
import { config } from './config.js';

/**
 * تحويل نص عربي → كلام لصيغة يقبلها واتساب (MP3).
 * المزوّد يتحدد بـ config.tts.provider: 'gemini' (افتراضي، مجاني بنفس GEMINI_API_KEY)
 * أو 'elevenlabs' أو 'azure' (دول محتاجين TTS_API_KEY).
 * @param {string} text
 * @returns {Promise<{buffer: ArrayBuffer, mimeType: string} | null>} null لو مفيش مفتاح
 * @throws لو النداء رجع خطأ (المتصل بيمسكه ويرجع للنص)
 */
export async function synthesize(text) {
  const { provider, apiKey } = config.tts;
  if (!text || !text.trim()) return null;

  if (provider === 'gemini') return config.gemini.apiKey ? gemini(text) : null;
  if (!apiKey) return null;
  if (provider === 'azure') return azure(text);
  return elevenlabs(text);
}

const GEMINI_TTS_STYLE =
  'اتكلم بالعامية المصرية بشكل طبيعي وودود، زي بياع محترم في محل قطع غيار مصاعد بيكلم زبون.';

/**
 * Gemini TTS (free tier) → WAV/PCM 24kHz → MP3 بـ lamejs جوه الووركر.
 * واتساب مش بيقبل PCM/WAV في رسايل الصوت، فلازم نحوّل لـ MP3.
 */
async function gemini(text) {
  const { geminiModel, geminiVoice } = config.tts;
  const spoken = cleanForSpeech(text).slice(0, 1500);
  if (!spoken) return null;

  const res = await fetch(`${config.gemini.baseUrl}/interactions`, {
    method: 'POST',
    headers: { 'x-goog-api-key': config.gemini.apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: geminiModel,
      input: [
        {
          type: 'user_input',
          content: [
            {
              type: 'text',
              text: spoken,
              annotations: [{ type: 'speech_metadata', style: GEMINI_TTS_STYLE }],
            },
          ],
        },
      ],
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice: geminiVoice }] },
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`TTS gemini ${res.status}: ${t.slice(0, 200)}`);
  }
  const audio = findAudio(await res.json());
  if (!audio) throw new Error('TTS gemini: مفيش صوت في الرد');

  const bytes = Uint8Array.from(atob(audio.data), (c) => c.charCodeAt(0));
  const pcm = decodePcm(bytes, audio.mimeType, audio.sampleRate);
  if (!pcm.samples.length) throw new Error('TTS gemini: الصوت فاضي');
  return { buffer: encodeMp3(pcm.samples, pcm.sampleRate), mimeType: 'audio/mpeg' };
}

/** يدوّر في رد الـ API على أول بلوك صوت (data base64 + mime_type audio/*). */
function findAudio(node) {
  if (!node || typeof node !== 'object') return null;
  const src = node.inlineData || node.inline_data || node;
  const mime = src.mime_type || src.mimeType || '';
  if (typeof src.data === 'string' && (node.type === 'audio' || /^audio\//.test(mime))) {
    return { data: src.data, mimeType: mime, sampleRate: src.sample_rate || src.sampleRate };
  }
  for (const v of Object.values(node)) {
    const found = findAudio(v);
    if (found) return found;
  }
  return null;
}

/** WAV (RIFF) أو L16 خام → عينات 16-bit mono + معدل العينات. */
function decodePcm(bytes, mimeType = '', sampleRate) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o) => String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);

  let rate = Number(sampleRate) || Number(/rate=(\d+)/.exec(mimeType)?.[1]) || 24000;
  let channels = 1;
  let start = 0;
  let end = bytes.length;

  if (bytes.length >= 12 && tag(0) === 'RIFF' && tag(8) === 'WAVE') {
    let o = 12;
    while (o + 8 <= bytes.length) {
      const id = tag(o);
      const size = view.getUint32(o + 4, true);
      if (id === 'fmt ') {
        channels = view.getUint16(o + 10, true) || 1;
        rate = view.getUint32(o + 12, true) || rate;
      } else if (id === 'data') {
        start = o + 8;
        // بعض الـ WAV المتولّدة streaming بيبقى حجم الـ data فيها 0 أو 0xFFFFFFFF
        end = size && start + size <= bytes.length ? start + size : bytes.length;
        break;
      }
      o += 8 + size + (size & 1);
    }
  }

  // لو stereo بناخد القناة الأولى بس
  const frames = Math.floor((end - start) / (2 * channels));
  const samples = new Int16Array(frames);
  for (let i = 0; i < frames; i++) samples[i] = view.getInt16(start + i * 2 * channels, true);
  return { samples, sampleRate: rate };
}

/**
 * 24kHz → 16kHz (كفاية جدًا للكلام) — عينات أقل بالتلت = تحويل MP3 أخف على Cloudflare المجاني.
 * تحويل خطي بسيط (interpolation) من غير مكتبات.
 */
function downsample(samples, from, to) {
  if (from <= to) return { samples, rate: from };
  const ratio = from / to;
  const out = new Int16Array(Math.floor(samples.length / ratio));
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio;
    const j = Math.floor(x);
    const f = x - j;
    const a = samples[j];
    const b = samples[j + 1] ?? a;
    out[i] = a + (b - a) * f;
  }
  return { samples: out, rate: to };
}

function encodeMp3(pcmSamples, pcmRate) {
  const { samples, rate: sampleRate } = downsample(pcmSamples, pcmRate, 16000);
  const enc = new Mp3Encoder(1, sampleRate, 32);
  const chunks = [];
  const BLOCK = 1152;
  for (let i = 0; i < samples.length; i += BLOCK) {
    const out = enc.encodeBuffer(samples.subarray(i, i + BLOCK));
    if (out.length) chunks.push(out);
  }
  const tail = enc.flush();
  if (tail.length) chunks.push(tail);

  const mp3 = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let off = 0;
  for (const c of chunks) {
    mp3.set(c, off);
    off += c.length;
  }
  return mp3.buffer;
}

/** نشيل الإيموجي وعلامات التنسيق والروابط عشان ماتتقريش بصوت عالي. */
function cleanForSpeech(text) {
  return String(text)
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_~`#>|]/g, '')
    .replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

async function elevenlabs(text) {
  const { apiKey, voiceId } = config.tts;
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${voiceId}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: { 'xi-api-key': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: text.slice(0, 1500),
        model_id: 'eleven_multilingual_v2',
      }),
    },
  );
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`TTS elevenlabs ${res.status}: ${t.slice(0, 200)}`);
  }
  return { buffer: await res.arrayBuffer(), mimeType: 'audio/mpeg' };
}

async function azure(text) {
  const { apiKey, voiceId, azureRegion } = config.tts;
  const voice = voiceId || 'ar-EG-SalmaNeural';
  const ssml =
    `<speak version='1.0' xml:lang='ar-EG'>` +
    `<voice xml:lang='ar-EG' name='${voice}'>${escapeXml(text.slice(0, 1500))}</voice>` +
    `</speak>`;

  const res = await fetch(
    `https://${azureRegion}.tts.speech.microsoft.com/cognitiveservices/v1`,
    {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': apiKey,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'audio-24khz-48kbitrate-mono-mp3',
      },
      body: ssml,
    },
  );
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`TTS azure ${res.status}: ${t.slice(0, 200)}`);
  }
  return { buffer: await res.arrayBuffer(), mimeType: 'audio/mpeg' };
}

function escapeXml(s) {
  return s.replace(
    /[<>&'"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c],
  );
}
