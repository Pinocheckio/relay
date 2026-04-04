import type { Speaker } from './types.js';

const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';

// eleven_flash_v2_5 for NL/EN (fast, good quality)
// eleven_v3 for FA (best multilingual quality, higher latency)
const MODEL_BY_LANG: Record<string, string> = {
  nl: 'eleven_flash_v2_5',
  en: 'eleven_flash_v2_5',
  fa: 'eleven_v3',
};

// Map Speaker to BCP-47 for ElevenLabs
const LANGUAGE_CODES: Record<Speaker, string> = {
  nl: 'nl',
  fa: 'fa',
  en: 'en',
};

export interface SynthesizeOptions {
  // Output format string: 'mp3_44100_128' (default) or 'pcm_16000' for test mode audio
  outputFormat?: string;
}

export async function synthesize(
  text: string,
  targetSpeaker: Speaker,
  apiKey: string,
  voiceId: string,
  onChunk: (base64Chunk: string) => void,
  options?: SynthesizeOptions,
): Promise<void> {
  const url = `${ELEVENLABS_BASE}/text-to-speech/${voiceId}/stream`;

  const modelId = MODEL_BY_LANG[targetSpeaker] ?? 'eleven_multilingual_v2';
  const outputFormat = options?.outputFormat ?? 'mp3_44100_128';

  // flash_v2_5 needs explicit language_code; v3 and multilingual_v2 auto-detect
  const needsLangCode = modelId === 'eleven_flash_v2_5';
  const langCodeField = needsLangCode
    ? { language_code: LANGUAGE_CODES[targetSpeaker] }
    : {};

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text,
      model_id: modelId,
      ...langCodeField,
      output_format: outputFormat,
      voice_settings: {
        stability: 0.5,
        similarity_boost: 0.75,
        style: 0.0,
        use_speaker_boost: true,
      },
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`ElevenLabs TTS error ${response.status}: ${body}`);
  }

  if (!response.body) {
    throw new Error('ElevenLabs TTS returned empty body');
  }

  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value && value.length > 0) {
      onChunk(Buffer.from(value).toString('base64'));
    }
  }
}
