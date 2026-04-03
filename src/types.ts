// ── Messages: Browser → Server ────────────────────────────────────────────

export type Mode = 'auto' | 'manual';
export type Speaker = string;

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

export interface SetLanguagesMessage {
  type: 'set_languages';
  lang1: Speaker;
  lang2: Speaker;
}

export interface RedoEntryMessage {
  type: 'redo_entry';
  entryId: string;
  text: string;
  sourceLang: Speaker;
  targetLang: Speaker | null;
}

export interface GenerateReportMessage {
  type: 'generate_report';
}

export type ClientMessage =
  | AudioChunkMessage
  | ManualCommitMessage
  | ModeSwitchMessage
  | SetLanguagesMessage
  | RedoEntryMessage
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
  targetLanguage: Speaker | null;
  translated: string;
  timestamp: string;
}

export interface CorrectedTranscriptMessage {
  type: 'corrected_transcript';
  entryId: string;
  text: string;
  language: Speaker;
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

export type ServerMessage =
  | PartialTranscriptMessage
  | CommittedTranscriptMessage
  | CorrectedTranscriptMessage
  | TtsAudioMessage
  | TtsEndMessage
  | ReportMessage
  | StatusMessage
  | ErrorMessage;

// ── Domain types ──────────────────────────────────────────────────────────

export interface TranscriptEntry {
  id: string;
  speaker: Speaker;
  original: string;
  translated: string;
  timestamp: Date;
}

export interface Session {
  id: string;
  startTime: Date;
  entries: TranscriptEntry[];
  mode: Mode;
  lang1: Speaker;
  lang2: Speaker;
}
