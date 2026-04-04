import WebSocket from 'ws';
import { EventEmitter } from 'events';
import type { Mode } from './types.js';

const DEEPGRAM_EU_URL = 'wss://api.eu.deepgram.com/v1/listen';
const RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_ATTEMPTS = 5;
const KEEPALIVE_INTERVAL_MS = 8000;

export class SttClient extends EventEmitter {
  private ws: WebSocket | null = null;
  private mode: Mode = 'auto';
  private reconnectAttempts = 0;
  private shouldReconnect = false;
  private apiKey: string;
  private buffer: Buffer[] = [];
  private keepaliveTimer: ReturnType<typeof setInterval> | null = null;

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
      model: 'nova-3',       // Risk: verify EU endpoint supports nova-3 + diarize + multi
      language: 'multi',     // Multi-language auto-detection (NL + FA + EN)
      punctuate: 'true',
      diarize: 'true',
      interim_results: 'true',
      endpointing: '300',    // 300ms silence = utterance boundary (replaces manual commit)
      encoding: 'linear16',
      sample_rate: '16000',
      channels: '1',
      smart_format: 'true',
    });

    const url = `${DEEPGRAM_EU_URL}?${params.toString()}`;
    console.log('[stt] connecting to Deepgram EU...');

    this.ws = new WebSocket(url, {
      headers: { Authorization: `Token ${this.apiKey}` },
    });

    this.ws.on('open', () => {
      console.log('[stt] connected to Deepgram EU');
      this.reconnectAttempts = 0;
      this._startKeepalive();
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

    this.ws.on('close', (code, reason) => {
      console.log(`[stt] disconnected (code=${code} reason=${reason.toString()})`);
      this._stopKeepalive();
      this.emit('disconnected');
      if (this.shouldReconnect && this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        this.reconnectAttempts++;
        const delay = RECONNECT_DELAY_MS * this.reconnectAttempts;
        console.log(`[stt] reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
        setTimeout(() => this._connect(), delay);
      }
    });

    this.ws.on('error', (err: Error) => {
      console.error('[stt] ws error:', err.message);
      this.emit('error', err);
    });
  }

  private _handleMessage(msg: Record<string, unknown>): void {
    const msgType = msg.type as string | undefined;

    switch (msgType) {
      case 'Metadata':
        console.log('[stt] Deepgram session ready');
        break;

      case 'SpeechStarted':
        break;

      case 'Results': {
        const isFinal = msg.is_final as boolean;
        const speechFinal = msg.speech_final as boolean;

        type Word = { word?: string; speaker?: number; start?: number; end?: number };
        type Alternative = { transcript?: string; words?: Word[] };
        type Channel = { alternatives?: Alternative[] };
        type Metadata = { detected_language?: string };

        const channel = msg.channel as Channel | undefined;
        const alt = channel?.alternatives?.[0];
        const text = alt?.transcript ?? '';
        const metadata = msg.metadata as Metadata | undefined;
        const lang = metadata?.detected_language ?? '';

        if (!text) break;

        if (!isFinal) {
          // Interim result: emit as partial for live display
          this.emit('partial', text, lang);
        } else if (speechFinal) {
          // Endpointing fired: full utterance complete, extract diarization
          const words = alt?.words ?? [];
          const speakerCounts = new Map<number, number>();
          for (const w of words) {
            if (w.speaker !== undefined) {
              speakerCounts.set(w.speaker, (speakerCounts.get(w.speaker) ?? 0) + 1);
            }
          }
          let speakerIndex: number | null = null;
          if (speakerCounts.size > 0) {
            // Dominant speaker = most words in this utterance
            speakerIndex = [...speakerCounts.entries()].sort((a, b) => b[1] - a[1])[0][0];
          }
          console.log(`[stt] committed lang=${lang} speaker=${speakerIndex} text="${text.slice(0, 40)}"`);
          this.emit('committed', text, lang, speakerIndex);
        } else {
          // is_final but not speech_final: stable mid-utterance segment, show as partial
          this.emit('partial', text, lang);
        }
        break;
      }

      case 'UtteranceEnd':
        // Deepgram utterance end signal — already handled via speech_final in Results
        break;

      case 'Error': {
        const errMsg = JSON.stringify(msg);
        console.error('[stt] Deepgram error:', errMsg);
        this.emit('error', new Error(`Deepgram error: ${errMsg}`));
        break;
      }

      default:
        console.log('[stt] unhandled message type:', msgType);
        break;
    }
  }

  // Accepts raw PCM Buffer and sends as binary frame to Deepgram
  sendChunk(pcmBuffer: Buffer): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this._sendChunkRaw(pcmBuffer);
    } else {
      this.buffer.push(pcmBuffer);
    }
  }

  private _sendChunkRaw(buf: Buffer): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(buf); // raw binary PCM — no JSON wrapping
  }

  private _startKeepalive(): void {
    this._stopKeepalive();
    this.keepaliveTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'KeepAlive' }));
      }
    }, KEEPALIVE_INTERVAL_MS);
  }

  private _stopKeepalive(): void {
    if (this.keepaliveTimer) {
      clearInterval(this.keepaliveTimer);
      this.keepaliveTimer = null;
    }
  }

  // No-op with Deepgram: server-side endpointing handles utterance boundaries.
  // PTT mode works by stopping audio chunks; Deepgram detects silence after 300ms.
  commitManual(): void {}

  switchMode(mode: Mode): void {
    if (this.mode === mode) return;
    this.mode = mode;
    // With Deepgram server-side VAD, mode changes only affect client-side audio gating.
    // No reconnection needed — the same WebSocket works for both auto and PTT modes.
  }

  disconnect(): void {
    this.shouldReconnect = false;
    this._stopKeepalive();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
