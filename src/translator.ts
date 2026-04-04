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

// ── Text-based language detection ─────────────────────────────────────────
// ElevenLabs audio-based detection confuses similar-sounding languages (NL/EN).
// These word lists let us verify the detected language from the actual text.
// Words are chosen to be strong indicators for one language, not shared.

const TEXT_LANG_MARKERS: Record<string, Set<string>> = {
  nl: new Set([
    'de', 'het', 'een', 'ik', 'niet', 'voor', 'maar', 'ook', 'te', 'aan',
    'nog', 'dit', 'wel', 'naar', 'dan', 'zou', 'bij', 'heeft', 'uit', 'zo',
    'werd', 'deze', 'meer', 'geen', 'moet', 'veel', 'onze', 'omdat', 'altijd',
    'nooit', 'graag', 'goed', 'alles', 'niets', 'alleen', 'vaak', 'soms',
    'mijn', 'jouw', 'wij', 'zij', 'dat', 'wie', 'dus', 'toch', 'ja', 'nee',
    'misschien', 'eigenlijk', 'gewoon', 'jullie', 'hier', 'daar', 'hoe',
    'waar', 'waarom', 'wanneer', 'welke', 'kunnen', 'willen', 'moeten',
  ]),
  en: new Set([
    'the', 'you', 'he', 'she', 'they', 'it', 'not', 'have', 'are', 'with',
    'from', 'can', 'will', 'would', 'could', 'should', 'my', 'your', 'our',
    'their', 'what', 'which', 'who', 'how', 'why', 'when', 'where', 'being',
    'about', 'after', 'before', 'between', 'through', 'just', 'also', 'very',
    'only', 'really', 'every', 'some', 'many', 'much', 'because', 'although',
    'while', 'yes', 'maybe', 'actually', 'already', 'enough', 'still', 'again',
    'never', 'always', 'sometimes', 'often', 'there', 'here', 'think', 'know',
  ]),
  de: new Set([
    'ich', 'nicht', 'das', 'ist', 'und', 'aber', 'auch', 'noch', 'schon',
    'immer', 'jetzt', 'hier', 'dort', 'warum', 'weil', 'wenn', 'dass',
    'kann', 'muss', 'soll', 'wird', 'haben', 'sein', 'werden', 'kein',
    'sehr', 'viel', 'mehr', 'andere',
  ]),
  fr: new Set([
    'le', 'la', 'les', 'une', 'des', 'je', 'tu', 'nous', 'vous',
    'ils', 'elles', 'est', 'sont', 'pas', 'mais', 'aussi', 'avec', 'pour',
    'dans', 'sur', 'que', 'qui', 'quoi', 'comment', 'pourquoi', 'quand',
    'jamais', 'toujours', 'peut', 'doit', 'fait', 'bien', 'beaucoup',
  ]),
};

/**
 * Detect the language of transcribed text by counting marker-word hits.
 * Returns the best-matching candidate, or null if inconclusive.
 * Only competes among the provided candidate languages.
 */
export function detectTextLanguage(text: string, candidates: Speaker[]): Speaker | null {
  const words = text.toLowerCase().replace(/[^\p{L}\s]/gu, '').split(/\s+/).filter(Boolean);
  if (words.length === 0) return null;

  // For non-Latin text, skip word analysis (script detection handles those)
  if (!isLatinOnly(text)) return null;

  const scores: Record<string, number> = {};
  for (const lang of candidates) {
    const markers = TEXT_LANG_MARKERS[lang];
    if (!markers || markers.size === 0) continue;
    scores[lang] = words.filter(w => markers.has(w)).length;
  }

  let best: Speaker | null = null;
  let bestScore = 0;
  for (const [lang, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      best = lang as Speaker;
    }
  }

  if (bestScore === 0) return null;

  // Must strictly beat runner-up to be confident
  const sortedScores = Object.values(scores).sort((a, b) => b - a);
  const runnerUp = sortedScores[1] ?? 0;
  if (bestScore <= runnerUp) return null;

  return best;
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

// Convert text into the target language — used when Scribe mis-transcribed in the wrong language.
// If the text is already in targetLang, GPT returns it unchanged.
export async function convertToLanguage(text: string, targetLang: Speaker): Promise<string> {
  const target = langName(targetLang);
  const completion = await openai.chat.completions.create({
    model: 'gpt-5.4-mini',
    messages: [
      {
        role: 'system',
        content: `Rewrite the following text in ${target}. If it is already in ${target}, return it unchanged. Return only the rewritten text — no explanation.`,
      },
      { role: 'user', content: text },
    ],
    temperature: 0.1,
    max_completion_tokens: 500,
  });
  return completion.choices[0]?.message?.content?.trim() ?? text;
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
