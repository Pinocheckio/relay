import OpenAI from 'openai';
import type { Speaker } from './types.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const LANG_NAMES: Record<string, string> = {
  nl: 'Dutch',
  fa: 'Farsi (Persian)',
  en: 'English',
  ar: 'Arabic',
  tr: 'Turkish',
  de: 'German',
  fr: 'French',
};

function langName(code: Speaker): string {
  return LANG_NAMES[code] ?? code.toUpperCase();
}

// Languages that use non-Latin scripts — Scribe sometimes romanizes these
const NON_LATIN = new Set(['fa', 'ar', 'zh', 'ja', 'ko', 'hi', 'he', 'th', 'ru', 'uk', 'bg']);

export function isNonLatin(lang: Speaker): boolean {
  return NON_LATIN.has(lang);
}

// Check if text is entirely in ASCII/Latin (no native script present)
function isLatinOnly(text: string): boolean {
  return /^[\x00-\x7F\u00C0-\u024F\s.,!?'"()\-:;]+$/.test(text);
}

// Convert romanized/transliterated text to the proper native script via GPT.
// Only runs when text is Latin-only but the language uses a non-Latin script.
export async function normalizeScript(text: string, lang: Speaker): Promise<string> {
  if (!isNonLatin(lang) || !isLatinOnly(text)) return text;

  const completion = await openai.chat.completions.create({
    model: 'gpt-5.4-mini',
    messages: [
      {
        role: 'system',
        content: `You are a script converter. The input is spoken ${langName(lang)} that was ` +
          `transcribed in romanized/Latin form. Convert it to the correct native script ` +
          `(${langName(lang)}). Return only the converted text — no explanation, no quotes.`,
      },
      { role: 'user', content: text },
    ],
    temperature: 0,
    max_completion_tokens: 300,
  });

  return completion.choices[0]?.message?.content?.trim() ?? text;
}

// Known language code prefixes → canonical Speaker code
const LANG_PREFIXES: Array<[string, Speaker]> = [
  ['nl', 'nl'],
  ['en', 'en'],
  ['fa', 'fa'],
  ['per', 'fa'], // ISO 639-2
  ['fr', 'fr'],
  ['de', 'de'],
  ['ar', 'ar'],
  ['tr', 'tr'],
  ['es', 'es'],
];

// Map ElevenLabs BCP-47 codes to canonical Speaker codes.
// Returns null for anything unrecognised — caller decides what to do.
export function detectSpeaker(languageCode: string): Speaker | null {
  const code = languageCode.toLowerCase().replace('_', '-');
  for (const [prefix, speaker] of LANG_PREFIXES) {
    if (code === prefix || code.startsWith(prefix + '-')) return speaker;
  }
  return null;
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
