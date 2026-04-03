import OpenAI from 'openai';
import type { Speaker, LanguagePair } from './types.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const LANG_NAMES: Record<Speaker, string> = {
  nl: 'Dutch',
  fa: 'Farsi (Persian)',
  en: 'English',
};

// Map ElevenLabs BCP-47 language codes to our Speaker type
export function detectSpeaker(languageCode: string): Speaker | null {
  const code = languageCode.toLowerCase();
  if (code.startsWith('nl')) return 'nl';
  if (code.startsWith('fa') || code.startsWith('per')) return 'fa';
  if (code.startsWith('en')) return 'en';
  return null; // unknown language
}

// Given a detected speaker and an active pair, return the target language to translate to.
// Returns null if the detected language is not part of the pair (ignore the utterance).
export function getTargetLanguage(speaker: Speaker, pair: LanguagePair): Speaker | null {
  const [a, b] = pair.split('-') as [Speaker, Speaker];
  if (speaker === a) return b;
  if (speaker === b) return a;
  return null;
}

export async function translate(text: string, from: Speaker, to: Speaker): Promise<string> {
  const systemPrompt =
    `You are a professional interpreter in a social care conversation. ` +
    `Translate faithfully from ${LANG_NAMES[from]} to ${LANG_NAMES[to]}, ` +
    `preserving the speaker's tone, register, and intent. ` +
    `Do not add, omit, or interpret. Keep it natural and conversational. ` +
    `Return only the translation — no explanations, no quotes, no annotations.`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-5.4-mini',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: text },
    ],
    temperature: 0.1,
    max_completion_tokens: 500,
  });

  return completion.choices[0]?.message?.content?.trim() ?? '';
}
