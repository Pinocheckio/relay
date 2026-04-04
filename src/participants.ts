import type { Session, Participant, Segment, Speaker, ParticipantRole } from './types.js';

let participantCounter = 0;
let segmentCounter = 0;

export const ROLE_LABELS: Record<string, string> = {
  care_worker: 'Zorgverlener',
  family_member: 'Familie',
  client: 'Cliënt',
  interpreter: 'Tolk',
  other: 'Anders',
};

export function createParticipant(name: string, role: ParticipantRole, language: Speaker): Participant {
  const now = new Date();
  return {
    id: `p-${Date.now()}-${++participantCounter}`,
    name,
    role,
    language,
    isPresent: true,
    joinedAt: now,
    presenceLog: [{ action: 'join', at: now }],
  };
}

function generateSegmentLabel(session: Session): string {
  const present = session.participants.filter(p => p.isPresent);
  if (present.length === 0) return 'Leeg gesprek';

  const careWorkers = present.filter(p => p.role === 'care_worker');
  const others = present.filter(p => p.role !== 'care_worker');

  if (present.length === 1) return `Gesprek met ${present[0].name}`;

  if (careWorkers.length > 0 && others.length >= 2) {
    const familyOnly = others.filter(p => p.role === 'family_member');
    if (familyOnly.length === others.length) return 'Familiegesprek';
    return `Groepsgesprek (${present.map(p => p.name).join(', ')})`;
  }

  if (careWorkers.length > 0 && others.length === 1) {
    return `Gesprek met ${others[0].name}`;
  }

  return `Gesprek (${present.map(p => p.name).join(', ')})`;
}

export function startNewSegment(session: Session): Segment {
  if (session.currentSegmentId) {
    const current = session.segments.find(s => s.id === session.currentSegmentId);
    if (current) current.endTime = new Date();
  }

  const presentIds = session.participants.filter(p => p.isPresent).map(p => p.id);
  const label = generateSegmentLabel(session);
  const seg: Segment = {
    id: `seg-${Date.now()}-${++segmentCounter}`,
    startTime: new Date(),
    endTime: null,
    participantIds: presentIds,
    label,
  };
  session.segments.push(seg);
  session.currentSegmentId = seg.id;
  return seg;
}

export function addParticipant(session: Session, participant: Participant): Segment {
  session.participants.push(participant);
  return startNewSegment(session);
}

export function removeParticipant(session: Session, participantId: string): Segment {
  const p = session.participants.find(p => p.id === participantId);
  if (p) {
    p.isPresent = false;
    p.presenceLog.push({ action: 'leave', at: new Date() });
  }
  return startNewSegment(session);
}

export function rejoinParticipant(session: Session, participantId: string): Segment {
  const p = session.participants.find(p => p.id === participantId);
  if (p) {
    p.isPresent = true;
    p.presenceLog.push({ action: 'join', at: new Date() });
  }
  return startNewSegment(session);
}

export function getActiveParticipants(session: Session): Participant[] {
  return session.participants.filter(p => p.isPresent);
}

export function getActiveLangs(session: Session): Speaker[] {
  const active = getActiveParticipants(session);
  const seen = new Set<string>();
  const langs: Speaker[] = [];
  for (const p of active) {
    if (!seen.has(p.language)) {
      seen.add(p.language);
      langs.push(p.language);
    }
  }
  return langs;
}

export function resolveParticipant(
  session: Session,
  langCode: Speaker,
): { participant: Participant | null; confident: boolean } {
  const active = getActiveParticipants(session);
  const speakersOfLang = active.filter(p => p.language === langCode);

  if (speakersOfLang.length === 1) {
    return { participant: speakersOfLang[0], confident: true };
  }
  if (speakersOfLang.length > 1) {
    return { participant: speakersOfLang[0], confident: false };
  }
  return { participant: null, confident: false };
}
