// ── Domain types ──────────────────────────────────────────────────────────

export type Mode = 'auto' | 'manual';
export type Speaker = string;
export type ParticipantRole = 'care_worker' | 'family_member' | 'client' | 'interpreter' | 'other';

export type Gender = 'female' | 'male';

export interface Participant {
  id: string;
  name: string;
  role: ParticipantRole;
  language: Speaker;
  gender: Gender;
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
  speakerIndex?: number | null; // Deepgram diarization speaker index
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

// ── Test script types ─────────────────────────────────────────────────────

export type TestMode = 'audio' | 'text';
export type ActionEffect = 'leave' | 'rejoin' | 'none';

export interface TestScriptParticipant {
  name: string;
  role: ParticipantRole;
  language: string;
  gender?: Gender;    // Defaults to 'female' if omitted
  voiceId?: string;   // ElevenLabs voice override for audio test mode
}

export interface SpeechLine {
  type: 'speech';
  speaker: string;
  language: string;
  text: string;
}

export interface ActionLine {
  type: 'action';
  description: string;
  effect: ActionEffect;
  participant?: string;
}

export interface PauseLine {
  type: 'pause';
  durationMs: number;
}

export type TestScriptLine = SpeechLine | ActionLine | PauseLine;

export interface TestScript {
  title: string;
  description: string;
  participants: TestScriptParticipant[];
  lines: TestScriptLine[];
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
  participants: Array<{ name: string; role: ParticipantRole; language: Speaker; gender?: Gender }>;
}

export interface AddParticipantMessage {
  type: 'add_participant';
  name: string;
  role: ParticipantRole;
  language: Speaker;
  gender?: Gender;
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

export interface StartTestModeMessage {
  type: 'start_test_mode';
  script: TestScript;
  mode: TestMode;
  ttsPlayback: boolean;
}

export interface TestControlMessage {
  type: 'test_control';
  action: 'play' | 'pause' | 'step' | 'reset' | 'speed' | 'tts_toggle';
  speed?: number;
  ttsEnabled?: boolean;
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
  | GenerateReportMessage
  | StartTestModeMessage
  | TestControlMessage;

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
  speakerIndex: number | null; // Deepgram diarization index (Phase 3)
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

export interface TestReadyMessage {
  type: 'test_ready';
  lineCount: number;
  title: string;
}

export interface TestProgressMessage {
  type: 'test_progress';
  lineIndex: number;
  totalLines: number;
  currentLine: TestScriptLine | null;
}

export interface TestAccuracyMessage {
  type: 'test_accuracy';
  lineIndex: number;
  expected: { text: string; language: string; speaker: string };
  actual: { text: string; language: string; speakerIndex: number | null };
  textSimilarity: number;
  languageMatch: boolean;
}

export interface TestCompleteMessage {
  type: 'test_complete';
  summary: {
    totalLines: number;
    avgTextSimilarity: number;
    languageAccuracy: number;
    diarizationConsistency: number;
  };
}

export interface TestNarrationMessage {
  type: 'test_narration';
  description: string;
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
  | SegmentChangeMessage
  | TestReadyMessage
  | TestProgressMessage
  | TestAccuracyMessage
  | TestCompleteMessage
  | TestNarrationMessage;
