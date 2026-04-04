import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

import { SttClient } from './stt.js';
import { translate, detectSpeaker, isNonLatin, normalizeScript, convertToLanguage } from './translator.js';
import { synthesize } from './tts.js';
import { createSession, addEntry, updateEntry, makeEntryId, generateReport } from './session.js';
import {
  createParticipant,
  addParticipant,
  removeParticipant,
  rejoinParticipant,
  startNewSegment,
  getActiveLangs,
  resolveParticipant,
} from './participants.js';
import type { ClientMessage, Speaker } from './types.js';

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

  const session = createSession();
  const stt = new SttClient(ELEVENLABS_API_KEY);

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

  let lastPartialLang: Speaker | null = null;
  let lastPartialText = '';

  stt.on('partial', (text: string, language: string) => {
    const partialDetected = detectSpeaker(language);
    if (partialDetected) lastPartialLang = partialDetected;
    if (text) lastPartialText = text;
    send({ type: 'partial_transcript', text, language });
  });

  stt.on('committed', async (committedText: string, languageCode: string) => {
    let detected = detectSpeaker(languageCode);
    let text = committedText;

    console.log(`[stt] committed lang=${languageCode}(${detected}) text="${text.slice(0, 40)}" | partial lang=${lastPartialLang} text="${lastPartialText.slice(0, 40)}"`);

    // Partial-vs-committed correction: Scribe sometimes re-transcribes differently on commit
    const activeLangs = getActiveLangs(session);
    if (lastPartialLang && lastPartialLang !== detected && lastPartialText) {
      const partialInPair = activeLangs.includes(lastPartialLang);
      if (partialInPair) {
        console.log(`[stt] Scribe re-transcribed on commit: reverting to partial text+lang`);
        detected = lastPartialLang;
        text = lastPartialText;
      }
    }

    lastPartialLang = null;
    lastPartialText = '';

    if (activeLangs.length === 0) {
      console.log('[stt] No active participants, skipping committed utterance');
      return;
    }

    let detectedSpeaker: Speaker;
    let targetSpeaker: Speaker | null = null;

    if (activeLangs.length === 1) {
      detectedSpeaker = activeLangs[0];
    } else if (detected && activeLangs.includes(detected)) {
      detectedSpeaker = detected;
      const otherLangs = activeLangs.filter(l => l !== detected);
      targetSpeaker = otherLangs[0] ?? null;
    } else {
      // Non-Latin fallback
      const nonLatinLangs = activeLangs.filter(l => isNonLatin(l));
      const latinLangs = activeLangs.filter(l => !isNonLatin(l));
      if (nonLatinLangs.length > 0 && latinLangs.length > 0) {
        console.log(`[stt] lang "${languageCode}" → assuming non-Latin fallback (${nonLatinLangs[0]})`);
        detectedSpeaker = nonLatinLangs[0];
        targetSpeaker = latinLangs[0];
      } else {
        console.log(`[stt] lang "${languageCode}" not matched to any active participant, skipping`);
        return;
      }
    }

    const { participant, confident } = resolveParticipant(session, detectedSpeaker);
    const currentSegmentId = session.currentSegmentId ?? 'unknown';

    try {
      const nativeText = await normalizeScript(text, detectedSpeaker);
      if (nativeText !== text) console.log(`[script] normalized "${text}" → "${nativeText}"`);

      const translated = targetSpeaker ? await translate(nativeText, detectedSpeaker, targetSpeaker) : '';
      if (targetSpeaker) console.log(`[translate] [${detectedSpeaker}->${targetSpeaker}]: ${translated}`);

      const entryId = makeEntryId();
      send({
        type: 'committed_transcript',
        entryId,
        text: nativeText,
        language: detectedSpeaker,
        participantId: participant?.id ?? null,
        participantName: participant?.name ?? null,
        confident,
        targetLanguage: targetSpeaker,
        translated,
        timestamp: new Date().toISOString(),
        segmentId: currentSegmentId,
      });

      addEntry(session, {
        id: entryId,
        speaker: detectedSpeaker,
        participantId: participant?.id ?? null,
        participantName: participant?.name ?? null,
        original: nativeText,
        translated,
        timestamp: new Date(),
        segmentId: currentSegmentId,
      });

      if (targetSpeaker && translated) {
        const voiceId = VOICES[targetSpeaker] ?? VOICE_NL;
        console.log(`[tts] synthesizing to ${targetSpeaker} using voice ${voiceId}`);
        let chunkCount = 0;
        await synthesize(translated, targetSpeaker, ELEVENLABS_API_KEY, voiceId, (chunk) => {
          chunkCount++;
          send({ type: 'tts_audio', data: chunk });
        });
        console.log(`[tts] done — ${chunkCount} chunks sent`);
        send({ type: 'tts_end' });
      }
    } catch (err) {
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

      case 'start_session': {
        for (const p of msg.participants) {
          const participant = createParticipant(p.name, p.role, p.language);
          session.participants.push(participant);
        }
        const firstSeg = startNewSegment(session);
        send({
          type: 'participants_update',
          participants: session.participants,
          segments: session.segments,
          currentSegmentId: session.currentSegmentId,
        });
        console.log(`[session] started with ${session.participants.length} participants, segment: "${firstSeg.label}"`);
        break;
      }

      case 'add_participant': {
        const newParticipant = createParticipant(msg.name, msg.role, msg.language);
        const addSeg = addParticipant(session, newParticipant);
        send({
          type: 'participants_update',
          participants: session.participants,
          segments: session.segments,
          currentSegmentId: session.currentSegmentId,
        });
        send({ type: 'segment_change', segment: addSeg, label: `${newParticipant.name} is bij het gesprek gekomen` });
        break;
      }

      case 'remove_participant': {
        const leaving = session.participants.find(p => p.id === msg.participantId);
        const leaveName = leaving?.name ?? 'Deelnemer';
        const removeSeg = removeParticipant(session, msg.participantId);
        send({
          type: 'participants_update',
          participants: session.participants,
          segments: session.segments,
          currentSegmentId: session.currentSegmentId,
        });
        send({ type: 'segment_change', segment: removeSeg, label: `${leaveName} heeft het gesprek verlaten` });
        break;
      }

      case 'rejoin_participant': {
        const rejoining = session.participants.find(p => p.id === msg.participantId);
        const rejoinName = rejoining?.name ?? 'Deelnemer';
        const rejoinSeg = rejoinParticipant(session, msg.participantId);
        send({
          type: 'participants_update',
          participants: session.participants,
          segments: session.segments,
          currentSegmentId: session.currentSegmentId,
        });
        send({ type: 'segment_change', segment: rejoinSeg, label: `${rejoinName} is teruggekomen` });
        break;
      }

      case 'assign_speaker': {
        const entry = session.entries.find(e => e.id === msg.entryId);
        const assignedParticipant = session.participants.find(p => p.id === msg.participantId);
        if (entry && assignedParticipant) {
          entry.participantId = assignedParticipant.id;
          entry.participantName = assignedParticipant.name;
          send({
            type: 'corrected_transcript',
            entryId: msg.entryId,
            text: entry.original,
            language: entry.speaker,
            participantId: assignedParticipant.id,
            participantName: assignedParticipant.name,
            targetLanguage: null,
            translated: entry.translated,
          });
        }
        break;
      }

      case 'redo_entry': {
        const { entryId, text, sourceLang, targetLang } = msg;
        try {
          const sourceText = await convertToLanguage(text, sourceLang);
          console.log(`[redo] converted "${text.slice(0, 30)}" → "${sourceText.slice(0, 30)}" (${sourceLang})`);
          const nativeText = await normalizeScript(sourceText, sourceLang);
          const translated = targetLang ? await translate(nativeText, sourceLang, targetLang) : '';
          const redoEntry = session.entries.find(e => e.id === entryId);
          send({
            type: 'corrected_transcript',
            entryId,
            text: nativeText,
            language: sourceLang,
            participantId: redoEntry?.participantId ?? null,
            participantName: redoEntry?.participantName ?? null,
            targetLanguage: targetLang,
            translated,
          });
          updateEntry(session, entryId, { speaker: sourceLang, original: nativeText, translated });
          if (targetLang && translated) {
            const voiceId = VOICES[targetLang] ?? VOICE_NL;
            await synthesize(translated, targetLang, ELEVENLABS_API_KEY, voiceId, (chunk) => {
              send({ type: 'tts_audio', data: chunk });
            });
            send({ type: 'tts_end' });
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          send({ type: 'error', text: `Redo fout: ${errMsg}` });
        }
        break;
      }

      case 'delete_entry':
        session.entries = session.entries.filter(e => e.id !== msg.entryId);
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
