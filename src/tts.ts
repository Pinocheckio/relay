import type { Speaker } from './types.js';

const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1';

// eleven_flash_v2_5 doesn't support Farsi — use multilingual_v2 for FA
const MODEL_BY_LANG: Record<string, string> = {
  nl: 'eleven_flash_v2_5',
  en: 'eleven_flash_v2_5',
  fa: 'eleven_multilingual_v2',
};

// Map Speaker to BCP-47 for ElevenLabs
const LANGUAGE_CODES: Record<Speaker, string> = {
  nl: 'nl',
  fa: 'fa',
  en: 'en',
};

export async function synthesize(
  text: string,
  targetSpeaker: Speaker,
  apiKey: string,
  voiceId: string,
  onChunk: (base64Chunk: string) => void,
): Promise<void> {
  const url = `${ELEVENLABS_BASE}/text-to-speech/${voiceId}/stream`;

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      text,
      model_id: MODEL_BY_LANG[targetSpeaker] ?? 'eleven_multilingual_v2',
      language_code: LANGUAGE_CODES[targetSpeaker],
      output_format: 'mp3_44100_128',
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
