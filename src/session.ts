import OpenAI from 'openai';
import type { Session, TranscriptEntry, Speaker } from './types.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export function createSession(lang1: Speaker = 'nl', lang2: Speaker = 'fa'): Session {
  return {
    id: Date.now().toString(),
    startTime: new Date(),
    entries: [],
    mode: 'auto',
    lang1,
    lang2,
  };
}

let entryCounter = 0;

export function makeEntryId(): string {
  return `e${Date.now()}-${++entryCounter}`;
}

export function addEntry(session: Session, entry: TranscriptEntry): void {
  session.entries.push(entry);
}

export function updateEntry(session: Session, id: string, patch: Partial<TranscriptEntry>): void {
  const entry = session.entries.find(e => e.id === id);
  if (entry) Object.assign(entry, patch);
}

export function getFullTranscript(session: Session): string {
  return session.entries
    .map((e) => {
      const ts = e.timestamp.toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      const langLabel = e.speaker === 'nl' ? 'NL' : 'FA';
      return `[${ts}] ${langLabel}: ${e.original}\n[${ts}] -> ${e.speaker === 'nl' ? 'FA' : 'NL'}: ${e.translated}`;
    })
    .join('\n\n');
}

export async function generateReport(session: Session): Promise<string> {
  if (session.entries.length === 0) {
    return '## Geen gesprek opgenomen\n\nEr zijn geen gespreksfragmenten beschikbaar om een verslag te genereren.';
  }

  const transcript = getFullTranscript(session);
  const durationMs = Date.now() - session.startTime.getTime();
  const durationMin = Math.round(durationMs / 60000);

  const systemPrompt = `Je bent een assistent voor gestructureerde verslaglegging in de sociale zorg.
Je genereert professionele, feitelijke verslagen op basis van gesprekken tussen een Nederlandstalige
zorgverlener en een Farsi-sprekende cliënt. Schrijf altijd in het Nederlands.`;

  const userPrompt = `Genereer een gestructureerd zorgverslag op basis van het volgende gesprek
(duur: ~${durationMin} minuten). Gebruik exact deze secties:

## Observaties
(Wat werd waargenomen: emotionele toestand cliënt, vermelde leefsituatie, lichaamshouding/stemming indien opgemerkt)

## Afspraken
(Gemaakte afspraken tussen zorgverlener en cliënt)

## Actiepunten
(Concrete acties — wie doet wat, tegen wanneer)

## Zorgsignalen
(Zorgen of risicosignalen uit het gesprek)

Wees feitelijk, niet interpretatief. Voeg niets toe wat niet in het gesprek staat.
Als iets niet besproken werd, noteer dan "Niet besproken" voor die sectie.

--- GESPREKSTRANSCRIPT ---
${transcript}
--- EINDE TRANSCRIPT ---`;

  const completion = await openai.chat.completions.create({
    model: 'gpt-5.4',
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.3,
    max_completion_tokens: 1500,
  });

  return completion.choices[0]?.message?.content ?? 'Verslag kon niet worden gegenereerd.';
}
