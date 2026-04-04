// ── Domain types ──────────────────────────────────────────────────────────

export type Mode = 'auto' | 'manual';
export type Speaker = string;
export type ParticipantRole = 'care_worker' | 'family_member' | 'client' | 'interpreter' | 'other';

export interface Participant {
  id: string;
  name: string;
  role: ParticipantRole;
  language: Speaker;
  isPresent: boolean;
  joinedAt: Date;
  presenceLog: Array<{ action: 'join' | 'leave'; at: Date }>;
}

export interface Segment {
  id: string;
  startTime: Date;
  endTime: Date | null;
  participantIds: string[];
  label?: string;
}

export interface TranscriptEntry {
  id: string;
  speaker: Speaker;
  participantId: string | null;
  participantName: string | null;
  original: string;
  translated: string;
  timestamp: Date;
  segmentId: string;
}

export interface Session {
  id: string;
  startTime: Date;
  entries: TranscriptEntry[];
  participants: Participant[];
  segments: Segment[];
  currentSegmentId: string | null;
  mode: Mode;
}

// ── Messages: Browser → Server ────────────────────────────────────────────

export interface AudioChunkMessage {
  type: 'audio_chunk';
  data: string;
  mode: Mode;
}

export interface ManualCommitMessage {
  type: 'manual_commit';
}

export interface ModeSwitchMessage {
  type: 'mode_switch';
  mode: Mode;
}

export interface StartSessionMessage {
  type: 'start_session';
  participants: Array<{ name: string; role: ParticipantRole; language: Speaker }>;
}

export interface AddParticipantMessage {
  type: 'add_participant';
  name: string;
  role: ParticipantRole;
  language: Speaker;
}

export interface RemoveParticipantMessage {
  type: 'remove_participant';
  participantId: string;
}

export interface RejoinParticipantMessage {
  type: 'rejoin_participant';
  participantId: string;
}

export interface AssignSpeakerMessage {
  type: 'assign_speaker';
  entryId: string;
  participantId: string;
}

export interface RedoEntryMessage {
  type: 'redo_entry';
  entryId: string;
  text: string;
  sourceLang: Speaker;
  targetLang: Speaker | null;
}

export interface DeleteEntryMessage {
  type: 'delete_entry';
  entryId: string;
}

export interface GenerateReportMessage {
  type: 'generate_report';
}

export type ClientMessage =
  | AudioChunkMessage
  | ManualCommitMessage
  | ModeSwitchMessage
  | StartSessionMessage
  | AddParticipantMessage
  | RemoveParticipantMessage
  | RejoinParticipantMessage
  | AssignSpeakerMessage
  | RedoEntryMessage
  | DeleteEntryMessage
  | GenerateReportMessage;

// ── Messages: Server → Browser ────────────────────────────────────────────

export interface PartialTranscriptMessage {
  type: 'partial_transcript';
  text: string;
  language: string;
}

export interface CommittedTranscriptMessage {
  type: 'committed_transcript';
  entryId: string;
  text: string;
  language: Speaker;
  participantId: string | null;
  participantName: string | null;
  confident: boolean;
  targetLanguage: Speaker | null;
  translated: string;
  timestamp: string;
  segmentId: string;
}

export interface CorrectedTranscriptMessage {
  type: 'corrected_transcript';
  entryId: string;
  text: string;
  language: Speaker;
  participantId: string | null;
  participantName: string | null;
  targetLanguage: Speaker | null;
  translated: string;
}

export interface TtsAudioMessage {
  type: 'tts_audio';
  data: string;
}

export interface TtsEndMessage {
  type: 'tts_end';
}

export interface ReportMessage {
  type: 'report';
  content: string;
}

export interface StatusMessage {
  type: 'status';
  text: string;
}

export interface ErrorMessage {
  type: 'error';
  text: string;
}

export interface ParticipantsUpdateMessage {
  type: 'participants_update';
  participants: Participant[];
  segments: Segment[];
  currentSegmentId: string | null;
}

export interface SegmentChangeMessage {
  type: 'segment_change';
  segment: Segment;
  label: string;
}

export type ServerMessage =
  | PartialTranscriptMessage
  | CommittedTranscriptMessage
  | CorrectedTranscriptMessage
  | TtsAudioMessage
  | TtsEndMessage
  | ReportMessage
  | StatusMessage
  | ErrorMessage
  | ParticipantsUpdateMessage
  | SegmentChangeMessage;
