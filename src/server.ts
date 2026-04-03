import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

import { SttClient } from './stt.js';
import { translate, detectSpeaker, isNonLatin, normalizeScript } from './translator.js';
import { synthesize } from './tts.js';
import { createSession, addEntry, generateReport } from './session.js';
import type { ClientMessage, Session, Speaker } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY ?? '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';
const VOICE_NL = process.env.ELEVENLABS_VOICE_NL ?? 'nPczCjzI2devNBz1zQrb';
const VOICE_FA = process.env.ELEVENLABS_VOICE_FA ?? '9BWtsMINqrJLrRacOk9x';
const VOICE_EN = process.env.ELEVENLABS_VOICE_EN ?? 'nPczCjzI2devNBz1zQrb';
const VOICES: Record<string, string> = { nl: VOICE_NL, fa: VOICE_FA, en: VOICE_EN };
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

app.post('/api/auth', (req, res) => {
  const accessCode = process.env.ACCESS_CODE;
  if (!accessCode) { res.json({ ok: true }); return; }
  const { code } = req.body as { code?: string };
  res.status(code === accessCode ? 200 : 401).json({ ok: code === accessCode });
});

// ── HTTP server + WebSocket server ────────────────────────────────────────

const server = createServer(app);
const wss = new WebSocketServer({ server });

wss.on('connection', (clientWs: WebSocket) => {
  console.log('[relay] Client connected');

  const session: Session = createSession('nl', 'fa');
  const stt = new SttClient(ELEVENLABS_API_KEY);
  let ttsPlaying = false;

  function send(msg: object): void {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.send(JSON.stringify(msg));
  }

  // ── STT event handlers ──────────────────────────────────────────────────

  stt.on('connected', () => send({ type: 'status', text: 'Verbonden — klaar om te luisteren.' }));
  stt.on('disconnected', () => send({ type: 'status', text: 'Verbinding verbroken. Opnieuw verbinden...' }));
  stt.on('error', (err: Error) => {
    console.error('[stt] error', err.message);
    send({ type: 'error', text: `STT fout: ${err.message}` });
  });
  stt.on('partial', (text: string, language: string) => {
    send({ type: 'partial_transcript', text, language });
  });

  stt.on('committed', async (text: string, languageCode: string) => {
    const detected = detectSpeaker(languageCode);
    console.log(`[stt] committed lang=${languageCode} → ${detected ?? 'unknown'}: ${text}`);

    // Only process languages that are part of the selected pair
    const sameLanguage = session.lang1 === session.lang2;
    let detectedSpeaker: Speaker;
    let targetSpeaker: Speaker | null = null;

    if (sameLanguage) {
      detectedSpeaker = session.lang1;
    } else if (detected === session.lang1) {
      detectedSpeaker = session.lang1;
      targetSpeaker = session.lang2;
    } else if (detected === session.lang2) {
      detectedSpeaker = session.lang2;
      targetSpeaker = session.lang1;
    } else {
      // Scribe misidentified the language.
      // If one side of the pair is non-Latin (FA, AR, etc.) and the other side is Latin,
      // Latin languages are reliably detected — so if it's not the Latin side, it's the non-Latin side.
      const lang1NonLatin = isNonLatin(session.lang1);
      const lang2NonLatin = isNonLatin(session.lang2);
      if (lang2NonLatin && !lang1NonLatin) {
        console.log(`[stt] lang "${languageCode}" → assuming ${session.lang2} (non-Latin fallback)`);
        detectedSpeaker = session.lang2;
        targetSpeaker = session.lang1;
      } else if (lang1NonLatin && !lang2NonLatin) {
        console.log(`[stt] lang "${languageCode}" → assuming ${session.lang1} (non-Latin fallback)`);
        detectedSpeaker = session.lang1;
        targetSpeaker = session.lang2;
      } else {
        console.log(`[stt] lang "${languageCode}" not in pair ${session.lang1}-${session.lang2}, skipping`);
        return;
      }
    }

    try {
      // If the speaker uses a non-Latin script but Scribe returned romanized text, convert first
      const nativeText = await normalizeScript(text, detectedSpeaker);
      if (nativeText !== text) console.log(`[script] normalized "${text}" → "${nativeText}"`);

      const translated = targetSpeaker ? await translate(nativeText, detectedSpeaker, targetSpeaker) : '';
      if (targetSpeaker) console.log(`[translate] [${detectedSpeaker}->${targetSpeaker}]: ${translated}`);

      send({
        type: 'committed_transcript',
        text: nativeText,
        language: detectedSpeaker,
        targetLanguage: targetSpeaker,
        translated,
        timestamp: new Date().toISOString(),
      });

      addEntry(session, { speaker: detectedSpeaker, original: nativeText, translated, timestamp: new Date() });

      if (targetSpeaker && translated) {
        const voiceId = VOICES[targetSpeaker] ?? VOICE_NL;
        console.log(`[tts] synthesizing to ${targetSpeaker} using voice ${voiceId}`);
        ttsPlaying = true;
        let chunkCount = 0;
        await synthesize(translated, targetSpeaker, ELEVENLABS_API_KEY, voiceId, (chunk) => {
          chunkCount++;
          send({ type: 'tts_audio', data: chunk });
        });
        ttsPlaying = false;
        console.log(`[tts] done — ${chunkCount} chunks sent`);
        send({ type: 'tts_end' });
      }
    } catch (err) {
      ttsPlaying = false;
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error('[pipeline] error', errMsg);
      send({ type: 'error', text: `Pipeline fout: ${errMsg}` });
    }
  });

  // ── Start STT ──────────────────────────────────────────────────────────

  stt.connect(session.mode);
  send({ type: 'status', text: 'Verbinden met spraakherkenning...' });

  // ── Client message handler ──────────────────────────────────────────────

  clientWs.on('message', async (raw: WebSocket.RawData) => {
    let msg: ClientMessage;
    try { msg = JSON.parse(raw.toString()) as ClientMessage; } catch { return; }

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

      case 'set_languages':
        session.lang1 = msg.lang1;
        session.lang2 = msg.lang2;
        if (msg.lang1 === msg.lang2) {
          send({ type: 'status', text: `Alleen opname — geen vertaling (${msg.lang1.toUpperCase()})` });
        } else {
          send({ type: 'status', text: `Taalkeuze: ${msg.lang1.toUpperCase()} ↔ ${msg.lang2.toUpperCase()}` });
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

  clientWs.on('close', () => { console.log('[relay] Client disconnected'); stt.disconnect(); });
  clientWs.on('error', (err: Error) => { console.error('[ws] client error', err.message); stt.disconnect(); });
});

server.listen(PORT, () => console.log(`[relay] Running on http://localhost:${PORT}`));
