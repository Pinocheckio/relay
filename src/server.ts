import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

import { SttClient } from './stt.js';
import { translate, detectSpeaker } from './translator.js';
import { synthesize } from './tts.js';
import { createSession, addEntry, generateReport } from './session.js';
import type { ClientMessage, Session } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY ?? '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';
// Distinct voices per output language for demo clarity
const VOICE_NL = process.env.ELEVENLABS_VOICE_NL ?? 'nPczCjzI2devNBz1zQrb'; // Brian — Dutch output
const VOICE_FA = process.env.ELEVENLABS_VOICE_FA ?? '9BWtsMINqrJLrRacOk9x'; // Aria — Farsi output
const PORT = Number(process.env.PORT ?? 3000);

if (!ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY is not set');
if (!OPENAI_API_KEY) throw new Error('OPENAI_API_KEY is not set');

// ── Express app ───────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

// ── HTTP server + WebSocket server ────────────────────────────────────────

const server = createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (clientWs: WebSocket) => {
  console.log('[relay] Client connected');

  const session: Session = createSession();
  const stt = new SttClient(ELEVENLABS_API_KEY);
  let ttsPlaying = false;

  function send(msg: object): void {
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify(msg));
    }
  }

  // ── STT event handlers ──────────────────────────────────────────────────

  stt.on('connected', () => {
    send({ type: 'status', text: 'Verbonden — klaar om te luisteren.' });
  });

  stt.on('disconnected', () => {
    send({ type: 'status', text: 'Verbinding verbroken. Opnieuw verbinden...' });
  });

  stt.on('error', (err: Error) => {
    console.error('[stt] error', err.message);
    send({ type: 'error', text: `STT fout: ${err.message}` });
  });

  stt.on('partial', (text: string, language: string) => {
    send({ type: 'partial_transcript', text, language });
  });

  stt.on('committed', async (text: string, languageCode: string) => {
    const speaker = detectSpeaker(languageCode);
    const targetSpeaker = speaker === 'nl' ? 'fa' : 'nl';

    console.log(`[stt] committed [${speaker}]: ${text}`);

    try {
      // Translate
      const translated = await translate(text, speaker);
      console.log(`[translate] [${speaker}->${targetSpeaker}]: ${translated}`);

      // Tell browser the committed transcript + translation
      send({
        type: 'committed_transcript',
        text,
        language: speaker,
        translated,
        timestamp: new Date().toISOString(),
      });

      // Store in session
      addEntry(session, {
        speaker,
        original: text,
        translated,
        timestamp: new Date(),
      });

      // TTS: stream audio back to browser (use voice matching the target language)
      const voiceId = targetSpeaker === 'nl' ? VOICE_NL : VOICE_FA;
      ttsPlaying = true;
      await synthesize(translated, targetSpeaker, ELEVENLABS_API_KEY, voiceId, (chunk) => {
        send({ type: 'tts_audio', data: chunk });
      });
      ttsPlaying = false;
      send({ type: 'tts_end' });
    } catch (err) {
      ttsPlaying = false;
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[pipeline] error', msg);
      send({ type: 'error', text: `Pipeline fout: ${msg}` });
    }
  });

  // ── Start STT connection ────────────────────────────────────────────────

  stt.connect(session.mode);
  send({ type: 'status', text: 'Verbinden met spraakherkenning...' });

  // ── Client message handler ──────────────────────────────────────────────

  clientWs.on('message', async (raw: WebSocket.RawData) => {
    let msg: ClientMessage;
    try {
      msg = JSON.parse(raw.toString()) as ClientMessage;
    } catch {
      return;
    }

    switch (msg.type) {
      case 'audio_chunk':
        stt.sendChunk(msg.data);
        break;

      case 'manual_commit':
        stt.commitManual();
        break;

      case 'mode_switch':
        if (msg.mode !== session.mode) {
          session.mode = msg.mode;
          stt.switchMode(msg.mode);
          send({ type: 'status', text: msg.mode === 'auto' ? 'Auto-modus actief.' : 'Handmatige modus actief.' });
        }
        break;

      case 'generate_report': {
        send({ type: 'status', text: 'Verslag genereren...' });
        try {
          const report = await generateReport(session);
          send({ type: 'report', content: report });
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          send({ type: 'error', text: `Verslag fout: ${errMsg}` });
        }
        break;
      }
    }
  });

  clientWs.on('close', () => {
    console.log('[relay] Client disconnected');
    stt.disconnect();
  });

  clientWs.on('error', (err: Error) => {
    console.error('[ws] client error', err.message);
    stt.disconnect();
  });
});

server.listen(PORT, () => {
  console.log(`[relay] Running on http://localhost:${PORT}`);
});
