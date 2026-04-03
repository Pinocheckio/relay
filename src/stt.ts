import WebSocket from 'ws';
import { EventEmitter } from 'events';
import type { Mode } from './types.js';

const SCRIBE_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime';
const TOKEN_URL = 'https://api.elevenlabs.io/v1/single-use-token/realtime_scribe';
const RECONNECT_DELAY_MS = 2000;
const MAX_RECONNECT_ATTEMPTS = 5;

async function fetchSingleUseToken(apiKey: string): Promise<string> {
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'xi-api-key': apiKey },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to fetch STT token (${res.status}): ${body}`);
  }
  const data = await res.json() as { token?: string };
  if (!data.token) throw new Error('STT token response missing token field');
  return data.token;
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
    this._connectWithToken();
  }

  private async _connectWithToken(): Promise<void> {
    let token: string;
    try {
      token = await fetchSingleUseToken(this.apiKey);
    } catch (err) {
      this.emit('error', err instanceof Error ? err : new Error(String(err)));
      return;
    }
    this._connect(token);
  }

  private _connect(token: string): void {
    const params = new URLSearchParams({
      model_id: 'scribe_v2_realtime',
      token,
      audio_format: 'pcm_16000',
      commit_strategy: this.mode === 'auto' ? 'vad' : 'manual',
      include_timestamps: 'true',
      vad_silence_threshold_secs: '1.5',
    });

    const url = `${SCRIBE_URL}?${params.toString()}`;
    console.log('[stt] connecting to ElevenLabs Scribe...');

    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      console.log('[stt] connected');
      this.reconnectAttempts = 0;
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
      this.emit('disconnected');
      if (this.shouldReconnect && this.reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
        this.reconnectAttempts++;
        const delay = RECONNECT_DELAY_MS * this.reconnectAttempts;
        console.log(`[stt] reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);
        setTimeout(() => this._connectWithToken(), delay);
      }
    });

    this.ws.on('error', (err: Error) => {
      console.error('[stt] ws error:', err.message);
      this.emit('error', err);
    });
  }

  private _handleMessage(msg: Record<string, unknown>): void {
    switch (msg.type) {
      case 'session_started':
        console.log('[stt] session started');
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
    setTimeout(() => this._connectWithToken(), 100);
  }

  disconnect(): void {
    this.shouldReconnect = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}
