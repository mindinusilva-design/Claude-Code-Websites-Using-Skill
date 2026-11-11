import { fetchWithTimeout } from '../core/http.js';

const API = 'https://api.elevenlabs.io';
export const DEFAULT_VOICE_ID = 'JBFqnCBsd6RMkjVDRZzb'; // "George": warm, British, fits JARVIS
export const DEFAULT_TTS_MODEL = 'eleven_flash_v2_5'; // low latency, good for conversation
export const DEFAULT_STT_MODEL = 'scribe_v2';
export const MAX_SPEECH_CHARS = 2500;
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024;
export const AUDIO_TYPES = new Set(['audio/webm', 'audio/ogg', 'audio/mp4', 'audio/mpeg', 'audio/wav', 'audio/x-wav', 'audio/wave', 'audio/aac', 'audio/flac']);
const VOICE_ID = /^[A-Za-z0-9]{10,40}$/;

export class VoiceError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

/** Keep speech short enough to be pleasant and bounded in cost: cut at a sentence end. */
export function clipForSpeech(text, max = MAX_SPEECH_CHARS) {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const slice = clean.slice(0, max);
  const end = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('! '), slice.lastIndexOf('? '));
  return end > max * 0.5 ? slice.slice(0, end + 1) : `${slice.replace(/\s+\S*$/, '')}…`;
}

async function failure(response, what) {
  let detail = '';
  try {
    const body = await response.json();
    detail = body?.detail?.message ?? body?.detail?.status ?? (typeof body?.detail === 'string' ? body.detail : '');
  } catch { /* body was not JSON */ }
  if (response.status === 401) return new VoiceError('The ElevenLabs API key was rejected.', 502);
  if (response.status === 429) return new VoiceError('ElevenLabs is rate limiting requests or the quota is used up.', 503);
  return new VoiceError(`ElevenLabs ${what} failed (${response.status}${detail ? `: ${detail}` : ''}).`, 502);
}

/**
 * Cloud voice for JARVIS: ElevenLabs text-to-speech and speech-to-text, called
 * from the server so the API key never reaches the browser. When ElevenLabs is
 * not configured, the dashboard falls back to the browser's built-in speech.
 */
export function createVoiceService({ integrations, logger = console }) {
  const cache = new Map(); // `${voice}|${model}|${text}` -> Buffer
  let voiceList = null;

  const config = () => integrations.config('elevenlabs');
  const configured = () => integrations.isConfigured('elevenlabs');
  const headers = () => ({ 'xi-api-key': config().apiKey });

  return {
    status() {
      const c = config();
      const on = configured();
      return {
        tts: on ? { provider: 'elevenlabs', voiceId: c.voiceId ?? DEFAULT_VOICE_ID, model: c.model ?? DEFAULT_TTS_MODEL } : null,
        stt: on ? { provider: 'elevenlabs', model: c.sttModel ?? DEFAULT_STT_MODEL } : null,
      };
    },

    /** @returns {Promise<{audio: Buffer, contentType: string, cached: boolean}>} */
    async speak(text, { voiceId = null } = {}) {
      if (!configured()) throw new VoiceError('Cloud voice is not configured.', 409);
      const c = config();
      const voice = voiceId && VOICE_ID.test(voiceId) ? voiceId : c.voiceId ?? DEFAULT_VOICE_ID;
      const model = c.model ?? DEFAULT_TTS_MODEL;
      const clipped = clipForSpeech(text);
      if (!clipped) throw new VoiceError('Nothing to say.', 400);
      const key = `${voice}|${model}|${clipped}`;
      if (cache.has(key)) {
        const audio = cache.get(key);
        cache.delete(key);
        cache.set(key, audio); // keep recently used phrases warm
        return { audio, contentType: 'audio/mpeg', cached: true };
      }
      const response = await fetchWithTimeout(`${API}/v1/text-to-speech/${encodeURIComponent(voice)}?output_format=mp3_44100_128`, {
        method: 'POST',
        timeoutMs: 20_000,
        headers: { ...headers(), 'content-type': 'application/json', accept: 'audio/mpeg' },
        body: JSON.stringify({
          text: clipped,
          model_id: model,
          voice_settings: { stability: 0.5, similarity_boost: 0.75, use_speaker_boost: true },
        }),
      });
      if (!response.ok) throw await failure(response, 'speech');
      const bytes = await response.arrayBuffer();
      const audio = typeof Buffer !== 'undefined' ? Buffer.from(bytes) : new Blob([bytes], { type: 'audio/mpeg' });
      if (clipped.length <= 300) { // short, frequently repeated phrases
        cache.set(key, audio);
        if (cache.size > 40) cache.delete(cache.keys().next().value);
      }
      return { audio, contentType: 'audio/mpeg', cached: false };
    },

    /** @returns {Promise<{text: string, language: string|null}>} */
    async transcribe(audio, contentType = 'audio/webm') {
      if (!configured()) throw new VoiceError('Cloud speech recognition is not configured.', 409);
      if (!audio?.length) throw new VoiceError('No audio received.', 400);
      const form = new FormData();
      form.append('model_id', config().sttModel ?? DEFAULT_STT_MODEL);
      form.append('tag_audio_events', 'false');
      const extension = contentType.split('/')[1]?.replace('x-', '').replace('mpeg', 'mp3') ?? 'webm';
      form.append('file', new Blob([audio], { type: contentType }), `speech.${extension}`);
      const response = await fetchWithTimeout(`${API}/v1/speech-to-text`, { method: 'POST', timeoutMs: 30_000, headers: headers(), body: form });
      if (!response.ok) throw await failure(response, 'transcription');
      const data = await response.json();
      return { text: String(data?.text ?? '').trim(), language: data?.language_code ?? null };
    },

    /** Voices on the account, cached for ten minutes. */
    async voices() {
      if (!configured()) return [];
      if (voiceList && Date.now() - voiceList.at < 10 * 60_000) return voiceList.items;
      const response = await fetchWithTimeout(`${API}/v1/voices`, { headers: headers() });
      if (!response.ok) throw await failure(response, 'voice list');
      const data = await response.json();
      const items = (data?.voices ?? []).map((v) => ({
        id: v.voice_id,
        name: v.name ?? v.voice_id,
        category: v.category ?? null,
        description: [v.labels?.accent, v.labels?.gender, v.labels?.age, v.labels?.description ?? v.labels?.descriptive].filter(Boolean).join(', '),
      })).filter((v) => VOICE_ID.test(v.id));
      voiceList = { at: Date.now(), items };
      return items;
    },

    reset() {
      cache.clear();
      voiceList = null;
    },
  };
}

export async function testElevenLabs(config) {
  const response = await fetchWithTimeout(`${API}/v1/voices`, { headers: { 'xi-api-key': config.apiKey } });
  if (!response.ok) throw await failure(response, 'connection test');
  const data = await response.json();
  return `Connected. ${(data?.voices ?? []).length} voices available`;
}
