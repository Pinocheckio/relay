import OpenAI from 'openai';
import type { Speaker } from './types.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ElevenLabs Scribe returns BCP-47 codes; map to our Speaker type
export function detectSpeaker(languageCode: string): Speaker {
  // Common codes: 'nl', 'nl-NL', 'nl-BE', 'fa', 'fa-IR'
  if (languageCode.startsWith('nl')) return 'nl';
  if (languageCode.startsWith('fa') || languageCode.startsWith('per')) return 'fa';
  // Fallback: treat unknown as Dutch (social worker is more likely to be Dutch-speaking)
  return 'nl';
}

function buildSystemPrompt(from: Speaker, to: Speaker): string {
  const fromLang = from === 'nl' ? 'Dutch' : 'Farsi (Persian)';
  const toLang = to === 'nl' ? 'Dutch' : 'Farsi (Persian)';
  return (
    `You are a professional interpreter in a social care conversation between a Dutch-speaking ` +
    `social worker and a Farsi-speaking client. ` +
    `Translate faithfully from ${fromLang} to ${toLang}, preserving the speaker's tone, ` +
    `register, and intent. Do not add, omit, or interpret. Keep it natural and conversational. ` +
    `Return only the translation — no explanations, no quotes, no annotations.`
  );
}

export async function translate(text: string, speaker: Speaker): Promise<string> {
  const target: Speaker = speaker === 'nl' ? 'fa' : 'nl';
  const systemPrompt = buildSystemPrompt(speaker, target);

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
