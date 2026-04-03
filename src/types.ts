// ── Messages: Browser → Server ────────────────────────────────────────────

export type Mode = 'auto' | 'manual';
export type Speaker = 'nl' | 'fa' | 'en';
export type LanguagePair = 'nl-fa' | 'nl-en' | 'fa-en';

export interface AudioChunkMessage {
  type: 'audio_chunk';
  data: string;   // base64-encoded Int16 PCM at 16kHz
  mode: Mode;
}

export interface ManualCommitMessage {
  type: 'manual_commit';
}

export interface ModeSwitchMessage {
  type: 'mode_switch';
  mode: Mode;
}

export interface SetPairMessage {
  type: 'set_pair';
  pair: LanguagePair;
}

export interface GenerateReportMessage {
  type: 'generate_report';
}

export type ClientMessage =
  | AudioChunkMessage
  | ManualCommitMessage
  | ModeSwitchMessage
  | SetPairMessage
  | GenerateReportMessage;

// ── Messages: Server → Browser ────────────────────────────────────────────

export interface PartialTranscriptMessage {
  type: 'partial_transcript';
  text: string;
  language: string;
}

export interface CommittedTranscriptMessage {
  type: 'committed_transcript';
  text: string;
  language: Speaker;
  targetLanguage: Speaker;
  translated: string;
  timestamp: string;
}

export interface TtsAudioMessage {
  type: 'tts_audio';
  data: string;   // base64-encoded MP3 chunk
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
  | TtsAudioMessage
  | TtsEndMessage
  | ReportMessage
  | StatusMessage
  | ErrorMessage;

// ── Domain types ──────────────────────────────────────────────────────────

export interface TranscriptEntry {
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
  pair: LanguagePair;
}
