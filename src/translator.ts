import OpenAI from 'openai';
import type { Speaker } from './types.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const LANG_NAMES: Record<string, string> = {
  nl: 'Dutch',
  fa: 'Farsi (Persian)',
  en: 'English',
};

function langName(code: Speaker): string {
  return LANG_NAMES[code] ?? code.toUpperCase();
}

// Map ElevenLabs BCP-47 codes to our Speaker codes
export function detectSpeaker(languageCode: string): Speaker | null {
  const code = languageCode.toLowerCase();
  if (code.startsWith('nl')) return 'nl';
  if (code.startsWith('fa') || code.startsWith('per')) return 'fa';
  if (code.startsWith('en')) return 'en';
  // Return the raw 2-letter code for other languages
  const base = code.slice(0, 2);
  return base || null;
}

export async function translate(text: string, from: Speaker, to: Speaker): Promise<string> {
  const systemPrompt =
    `You are a professional interpreter in a social care conversation. ` +
    `Translate faithfully from ${langName(from)} to ${langName(to)}, ` +
    `preserving the speaker's tone, register, and intent. ` +
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
