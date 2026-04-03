import WebSocket from 'ws';
import { EventEmitter } from 'events';
import type { Mode } from './types.js';

const SCRIBE_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
const RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_ATTEMPTS = 5;

export interface SttEvents {
  partial: (text: string, language: string) => void;
  committed: (text: string, language: string) => void;
  error: (err: Error) => void;
  connected: () => void;
  disconnected: () => void;
}

export class SttClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private mode: Mode = 'auto';
  private reconnectAttempts = 0;
  private shouldReconnect = false;
  private apiKey: string;
  private buffer: Buffer[] = [];

  constructor(apiKey: string) {
    super();
    this.apiKey = apiKey;
  }

  connect(mode: Mode): void {
    this.mode = mode;
    this.shouldReconnect = true;
    this.reconnectAttempts = 0;
    this._connect();
  }

  private _connect(): void {
    const params = new URLSearchParams({
      model_id: 'scribe_v2_realtime',
      audio_format: 'pcm_16000',
      commit_strategy: this.mode === 'auto' ? 'vad' : 'manual',
      include_language_detection: 'true',
      include_timestamps: 'true',
      vad_silence_threshold_secs: '1.5',
    });

    const url = `${SCRIBE_URL}?${params.toString()}`;

    this.ws = new WebSocket(url, {
      headers: { 'xi-api-key': this.apiKey },
    });

    this.ws.on('open', () => {
      this.reconnectAttempts = 0;
      // Drain any buffered audio chunks that arrived before connection
      for (const chunk of this.buffer) {
        this._sendChunkRaw(chunk);
      }
      this.buffer = [];
      this.emit('connected');
    });

    this.ws.on('message', (data: WebSocket.RawData) => {
      try {
        const msg = JSON.parse(data.toString());
        this._handleMessage(msg);
      } catch {
        // ignore non-JSON frames
      }
    });

    this.ws.on('close', () => {
      this.emit('disconnected');
      if (this.shouldReconnect && this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        this.reconnectAttempts++;
        setTimeout(() => this._connect(), RECONNECT_DELAY_MS * this.reconnectAttempts);
      }
    });

    this.ws.on('error', (err: Error) => {
      this.emit('error', err);
    });
  }

  private _handleMessage(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'session_started':
        break;

      case 'partial_transcript': {
        const text = (msg.text as string | undefined) ?? '';
        const lang = (msg.language_code as string | undefined) ?? '';
        if (text) this.emit('partial', text, lang);
        break;
      }

      case 'committed_transcript_with_timestamps': {
        const text = ((msg.transcript as Record<string, unknown>)?.text as string | undefined) ?? '';
        const lang = (msg.language_code as string | undefined) ?? '';
        if (text) this.emit('committed', text, lang);
        break;
      }

      // ElevenLabs also emits 'committed_transcript' (without timestamps) in some versions
      case 'committed_transcript': {
        const text = (msg.text as string | undefined) ?? '';
        const lang = (msg.language_code as string | undefined) ?? '';
        if (text) this.emit('committed', text, lang);
        break;
      }

      default:
        break;
    }
  }

  sendChunk(pcmBase64: string): void {
    const buf = Buffer.from(pcmBase64, 'base64');
    if (this.ws?.readyState === WebSocket.OPEN) {
      this._sendChunkRaw(buf);
    } else {
      // Buffer until connected
      this.buffer.push(buf);
    }
  }

  private _sendChunkRaw(buf: Buffer): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ audio: buf.toString('base64') }));
  }

  commitManual(): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ type: 'commit' }));
  }

  switchMode(mode: Mode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    this.disconnect();
    setTimeout(() => this._connect(), 100);
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
