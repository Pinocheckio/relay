import type { Speaker } from './types.js';

export type Gender = 'female' | 'male';

// ── Voice Registry ───────────────────────────────────────────────────────
// Voice IDs are public ElevenLabs library IDs, not secrets.
// Update these directly in code when swapping voices.

interface VoicePair {
  female: string;
  male: string;
}

const VOICE_REGISTRY: Record<string, VoicePair> = {
  nl: {
    female: 'TODO_NL_FEMALE',               // TODO: pick from ElevenLabs (e.g. Ruth)
    male:   'nPczCjzI2devNBz1zQrb',         // Brian
  },
  en: {
    female: 'EXAVITQu4vr4xnSDxMaL',         // Bella
    male:   'TxGEqnHWrfWFTfGW9XjX',         // Josh
  },
  fa: {
    female: 'TODO_FA_FEMALE',               // TODO: pick Farsi-native female voice
    male:   'TODO_FA_MALE',                 // TODO: pick Farsi-native male voice
  },
};

// Fallback voice when language/gender combo is missing
const FALLBACK_VOICE = 'nPczCjzI2devNBz1zQrb'; // Brian

/**
 * Get the appropriate voice ID for a language + gender combination.
 */
export function getVoice(language: Speaker, gender: Gender): string {
  const pair = VOICE_REGISTRY[language];
  if (!pair) return FALLBACK_VOICE;
  return pair[gender] || pair.female || pair.male || FALLBACK_VOICE;
}

/**
 * Get all voice IDs for a language (used by test mode audio for diarization).
 */
export function getVoicePool(language: string): string[] {
  const pair = VOICE_REGISTRY[language];
  if (!pair) return [FALLBACK_VOICE];
  return [pair.female, pair.male].filter(Boolean);
}
