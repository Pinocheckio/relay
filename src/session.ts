import OpenAI from 'openai';
import type { Session, TranscriptEntry } from './types.js';
import { ROLE_LABELS } from './participants.js';

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

export function createSession(): Session {
  return {
    id: Date.now().toString(),
    startTime: new Date(),
    entries: [],
    participants: [],
    segments: [],
    currentSegmentId: null,
    mode: 'auto',
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

function fmtTime(date: Date): string {
  return date.toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit' });
}

export function getFullTranscript(session: Session): string {
  if (session.entries.length === 0) return '';

  if (session.segments.length === 0) {
    return session.entries.map(e => {
      const ts = fmtTime(e.timestamp);
      const speaker = e.participantName ?? e.speaker.toUpperCase();
      return `[${ts}] ${speaker}: ${e.original}${e.translated ? `\n[${ts}] -> vertaling: ${e.translated}` : ''}`;
    }).join('\n\n');
  }

  const lines: string[] = [];

  for (const seg of session.segments) {
    const presentParticipants = session.participants.filter(p => seg.participantIds.includes(p.id));
    const startStr = fmtTime(seg.startTime);
    const endStr = seg.endTime ? fmtTime(seg.endTime) : 'nu';

    lines.push(`--- ${seg.label ?? 'Gesprekssegment'} (${startStr} - ${endStr}) ---`);
    lines.push(`Aanwezig: ${presentParticipants.map(p => `${p.name} (${ROLE_LABELS[p.role] ?? p.role}, ${p.language.toUpperCase()})`).join(', ')}`);
    lines.push('');

    const segEntries = session.entries.filter(e => e.segmentId === seg.id);
    for (const e of segEntries) {
      const ts = fmtTime(e.timestamp);
      const speakerLabel = e.participantName ?? e.speaker.toUpperCase();
      lines.push(`[${ts}] ${speakerLabel}: ${e.original}`);
      if (e.translated) {
        lines.push(`[${ts}] -> vertaling: ${e.translated}`);
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}

export async function generateReport(session: Session): Promise<string> {
  if (session.entries.length === 0) {
    return '## Geen gesprek opgenomen\n\nEr zijn geen gespreksfragmenten beschikbaar om een verslag te genereren.';
  }

  const transcript = getFullTranscript(session);
  const durationMs = Date.now() - session.startTime.getTime();
  const durationMin = Math.round(durationMs / 60000);

  const participantOverview = session.participants.map(p => {
    const firstJoin = p.presenceLog.find(l => l.action === 'join');
    const lastLeave = [...p.presenceLog].reverse().find(l => l.action === 'leave');
    const timeStr = firstJoin
      ? `${fmtTime(firstJoin.at)} - ${lastLeave ? fmtTime(lastLeave.at) : 'einde gesprek'}`
      : 'aanwezig tijdens gesprek';
    return `- ${p.name} (${ROLE_LABELS[p.role] ?? p.role}, ${p.language.toUpperCase()}) — aanwezig: ${timeStr}`;
  }).join('\n');

  const segmentSections = session.segments.map(seg => {
    const present = session.participants.filter(p => seg.participantIds.includes(p.id));
    const startStr = fmtTime(seg.startTime);
    const endStr = seg.endTime ? fmtTime(seg.endTime) : 'einde gesprek';
    return `## ${seg.label ?? 'Gesprekssegment'} (${startStr} - ${endStr})
Aanwezig: ${present.map(p => p.name).join(', ')}
### Observaties
(Wat werd waargenomen: emotionele toestand, besproken situatie, zorgsignalen)

### Afspraken
(Gemaakte afspraken)

### Actiepunten
(Concrete acties — wie doet wat, wanneer)`;
  }).join('\n\n');

  const systemPrompt = `Je bent een assistent voor gestructureerde verslaglegging in de sociale zorg.
Je genereert professionele, feitelijke verslagen op basis van gesprekken tussen zorgverleners en cliënten/families.
Het gesprek is onderverdeeld in segmenten op basis van wie aanwezig was.
Schrijf altijd in het Nederlands. Wees feitelijk, niet interpretatief.
Voeg niets toe wat niet in het gesprek staat. Als iets niet besproken werd, noteer "Niet besproken".`;

  const userPrompt = `Genereer een gestructureerd zorgverslag op basis van het volgende gesprek (duur: ~${durationMin} minuten).

DEELNEMERS:
${participantOverview}

Gebruik exact de volgende structuur:

## Deelnemers
(Lijst van alle deelnemers met aanwezigheidstijden — kopieer en verfijn uit bovenstaande info)

${segmentSections}

## Overkoepelende actiepunten
(Actiepunten die gelden voor het gehele gesprek of meerdere segmenten)

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
    max_completion_tokens: 2000,
  });

  return completion.choices[0]?.message?.content ?? 'Verslag kon niet worden gegenereerd.';
}
