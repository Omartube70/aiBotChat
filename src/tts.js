import { config } from './config.js';

/**
 * تحويل نص عربي → كلام لصيغة يقبلها واتساب (MP3).
 * المزوّد يتحدد بـ config.tts.provider: 'elevenlabs' (افتراضي) أو 'azure'.
 * @param {string} text
 * @returns {Promise<{buffer: ArrayBuffer, mimeType: string} | null>} null لو مفيش مفتاح
 * @throws لو النداء رجع خطأ (المتصل بيمسكه ويرجع للنص)
 */
export async function synthesize(text) {
  const { provider, apiKey } = config.tts;
  if (!apiKey || !text || !text.trim()) return null;

  if (provider === 'azure') return azure(text);
  return elevenlabs(text); // الافتراضي
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
