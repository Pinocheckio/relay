import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import path from 'path';
import { fileURLToPath } from 'url';

import { SttClient } from './stt.js';
import { TestModePlayer } from './test-mode.js';
import { translate, detectSpeaker, detectTextLanguage, isNonLatin, normalizeScript, convertToLanguage } from './translator.js';
import { synthesize } from './tts.js';
import { getVoice } from './voices.js';
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
import type { ClientMessage, Speaker, Participant, Gender } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEEPGRAM_API_KEY  = process.env.DEEPGRAM_API_KEY ?? '';
const ELEVENLABS_API_KEY = process.env.ELEVENLABS_API_KEY ?? '';
const OPENAI_API_KEY    = process.env.OPENAI_API_KEY ?? '';
const PORT = Number(process.env.PORT ?? 3000);

if (!DEEPGRAM_API_KEY)   throw new Error('DEEPGRAM_API_KEY is not set');
if (!ELEVENLABS_API_KEY) throw new Error('ELEVENLABS_API_KEY is not set');
if (!OPENAI_API_KEY)     throw new Error('OPENAI_API_KEY is not set');

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

  // STT is created lazily on start_session or start_test_mode (audio)
  let stt: SttClient | null = null;
  let testPlayer: TestModePlayer | null = null;
  let isTestMode = false;
  let testTtsEnabled = true;

  // Phase 3: diarization speaker index -> participant id mapping
  const speakerMap = new Map<number, string>();

  function send(msg: object): void {
    if (clientWs.readyState === WebSocket.OPEN) clientWs.send(JSON.stringify(msg));
  }

  // ── STT event wiring ───────────────────────────────────────────────────

  function wireUpSttEvents(sttClient: SttClient): void {
    sttClient.on('connected', () => send({ type: 'status', text: 'Verbonden — klaar om te luisteren.' }));
    sttClient.on('disconnected', () => send({ type: 'status', text: 'Verbinding verbroken. Opnieuw verbinden...' }));
    sttClient.on('error', (err: Error) => {
      console.error('[stt] error', err.message);
      send({ type: 'error', text: `STT fout: ${err.message}` });
    });

    sttClient.on('partial', (text: string, language: string) => {
      let partialDetected = detectSpeaker(language);

      const activeLangs = getActiveLangs(session);
      if (activeLangs.length > 1 && text.split(/\s+/).length >= 3) {
        const textLang = detectTextLanguage(text, activeLangs);
        if (textLang && textLang !== partialDetected) {
          partialDetected = textLang;
        }
      }

      // Suppress partials for languages not in the active participant set
      if (activeLangs.length > 0 && partialDetected && !activeLangs.includes(partialDetected)) {
        const nonLatinFallback = activeLangs.some(l => isNonLatin(l)) && activeLangs.some(l => !isNonLatin(l));
        if (!nonLatinFallback) {
          send({ type: 'partial_transcript', text: '', language });
          return;
        }
      }

      send({ type: 'partial_transcript', text, language: partialDetected ?? language });
    });

    sttClient.on('committed', async (text: string, languageCode: string, speakerIndex: number | null) => {
      await handleCommitted(text, languageCode, speakerIndex);
    });
  }

  // ── Core pipeline: STT committed -> translate -> TTS -> send ──────────

  async function handleCommitted(
    committedText: string,
    languageCode: string,
    speakerIndex: number | null,
    knownParticipantName?: string,
  ): Promise<void> {
    const text = committedText;
    if (!text.trim()) return;

    const activeLangs = getActiveLangs(session);
    if (activeLangs.length === 0) {
      console.log('[stt] No active participants, skipping committed utterance');
      return;
    }

    // Text-based language override: Deepgram language detection can confuse NL/EN
    let detected = detectSpeaker(languageCode);
    if (activeLangs.length > 1) {
      const textLang = detectTextLanguage(text, activeLangs);
      if (textLang && textLang !== detected) {
        console.log(`[stt] Text override: Deepgram="${detected}" -> text="${textLang}" for "${text.slice(0, 50)}"`);
        detected = textLang;
      }
    }

    // Speaker resolution: diarization first (Phase 3), then language-based fallback
    let detectedSpeaker: Speaker = activeLangs[0]; // safe default, will be overwritten
    let targetSpeaker: Speaker | null = null;
    let participant: Participant | null = null;
    let confident = false;
    let resolvedByDiarize = false;

    // Test mode text: participant is known from the script
    if (knownParticipantName) {
      const knownP = session.participants.find(
        p => p.name === knownParticipantName && p.isPresent,
      );
      if (knownP) {
        detectedSpeaker = knownP.language as Speaker;
        participant = knownP;
        confident = true;
        const others = activeLangs.filter(l => l !== detectedSpeaker);
        targetSpeaker = others[0] ?? null;
        resolvedByDiarize = true;
        console.log(`[test] known speaker: ${knownP.name} (${detectedSpeaker})`);
      }
    }

    if (!resolvedByDiarize && speakerIndex !== null && speakerMap.has(speakerIndex)) {
      const mappedId = speakerMap.get(speakerIndex)!;
      const mappedP = session.participants.find(p => p.id === mappedId && p.isPresent);
      if (mappedP) {
        detectedSpeaker = mappedP.language as Speaker;
        participant = mappedP;
        confident = true;
        const others = activeLangs.filter(l => l !== detectedSpeaker);
        targetSpeaker = others[0] ?? null;
        resolvedByDiarize = true;
        console.log(`[stt] diarize: speaker ${speakerIndex} -> ${mappedP.name} (${detectedSpeaker})`);
      }
    }

    if (!resolvedByDiarize) {
      if (activeLangs.length === 1) {
        detectedSpeaker = activeLangs[0];
      } else if (detected && activeLangs.includes(detected)) {
        detectedSpeaker = detected;
        const others = activeLangs.filter(l => l !== detected);
        targetSpeaker = others[0] ?? null;
      } else {
        const nonLatin = activeLangs.filter(l => isNonLatin(l));
        const latin = activeLangs.filter(l => !isNonLatin(l));
        if (nonLatin.length > 0 && latin.length > 0) {
          console.log(`[stt] lang "${languageCode}" -> non-Latin fallback (${nonLatin[0]})`);
          detectedSpeaker = nonLatin[0];
          targetSpeaker = latin[0];
        } else {
          console.log(`[stt] lang "${languageCode}" unmatched, skipping`);
          return;
        }
      }
      const res = resolveParticipant(session, detectedSpeaker);
      participant = res.participant;
      confident = res.confident;

      // Learn: confident language match + new speaker index -> save mapping
      if (confident && speakerIndex !== null && !speakerMap.has(speakerIndex) && participant) {
        speakerMap.set(speakerIndex, participant.id);
        console.log(`[diarize] Learned: speaker ${speakerIndex} = ${participant.name}`);
      }
    }

    const currentSegmentId = session.currentSegmentId ?? 'unknown';

    try {
      const nativeText = await normalizeScript(text, detectedSpeaker);
      if (nativeText !== text) console.log(`[script] normalized "${text}" -> "${nativeText}"`);

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
        speakerIndex,
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
        speakerIndex,
      });

      const shouldTts = !isTestMode || testTtsEnabled;
      if (targetSpeaker && translated && shouldTts) {
        // Pick voice matching the target language + listener's gender
        const targetParticipant = session.participants.find(
          p => p.language === targetSpeaker && p.isPresent,
        );
        const voiceGender: Gender = targetParticipant?.gender ?? 'female';
        const voiceId = getVoice(targetSpeaker, voiceGender);
        console.log(`[tts] synthesizing to ${targetSpeaker} (${voiceGender}) using voice ${voiceId}`);
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
  }

  // ── Client message handler ─────────────────────────────────────────────

  clientWs.on('message', async (raw: WebSocket.RawData) => {
    let msg: ClientMessage;
    try { msg = JSON.parse(raw.toString()) as ClientMessage; } catch { return; }

    switch (msg.type) {

      case 'start_session': {
        for (const p of msg.participants) {
          session.participants.push(createParticipant(p.name, p.role, p.language, p.gender ?? 'female'));
        }
        const firstSeg = startNewSegment(session);
        send({
          type: 'participants_update',
          participants: session.participants,
          segments: session.segments,
          currentSegmentId: session.currentSegmentId,
        });
        console.log(`[session] started with ${session.participants.length} participants, segment: "${firstSeg.label}"`);
        // Connect Deepgram STT now that we have participants
        stt = new SttClient(DEEPGRAM_API_KEY);
        wireUpSttEvents(stt);
        stt.connect(session.mode);
        send({ type: 'status', text: 'Verbinden met spraakherkenning...' });
        break;
      }

      case 'start_test_mode': {
        isTestMode = true;
        testTtsEnabled = msg.ttsPlayback;

        // Set up session participants from script definition
        for (const p of msg.script.participants) {
          session.participants.push(createParticipant(p.name, p.role as import('./types.js').ParticipantRole, p.language, p.gender ?? 'female'));
        }
        startNewSegment(session);

        // In audio mode, connect Deepgram to receive generated PCM audio
        if (msg.mode === 'audio') {
          stt = new SttClient(DEEPGRAM_API_KEY);
          wireUpSttEvents(stt);
          stt.connect(session.mode);
        }

        testPlayer = new TestModePlayer({
          script: msg.script,
          session,
          mode: msg.mode,
          apiKey: ELEVENLABS_API_KEY,
          stt: msg.mode === 'audio' ? (stt ?? undefined) : undefined,
          synthesizeFn: synthesize,
          sendFn: send,
          // Text mode: awaited callback passes participant name and waits for
          // full pipeline (translate + TTS synthesis) before advancing.
          onCommitText: msg.mode === 'text'
            ? async (text, lang, participantName) => {
                await handleCommitted(text, lang, null, participantName);
              }
            : undefined,
        });

        send({
          type: 'participants_update',
          participants: session.participants,
          segments: session.segments,
          currentSegmentId: session.currentSegmentId,
        });
        send({ type: 'test_ready', lineCount: msg.script.lines.length, title: msg.script.title });
        break;
      }

      case 'test_control': {
        if (!testPlayer) break;
        switch (msg.action) {
          case 'play':  testPlayer.play(); break;
          case 'pause': testPlayer.pause(); break;
          case 'step':  testPlayer.step(); break;
          case 'reset': testPlayer.reset(); break;
          case 'speed':
            if (msg.speed !== undefined) testPlayer.setSpeed(msg.speed);
            break;
          case 'tts_toggle':
            testTtsEnabled = msg.ttsEnabled ?? true;
            break;
        }
        break;
      }

      case 'audio_chunk':
        // In test mode, audio is generated by the player — ignore mic chunks
        if (!isTestMode && stt) stt.sendChunk(Buffer.from(msg.data, 'base64'));
        break;

      case 'manual_commit':
        if (stt) stt.commitManual();
        break;

      case 'mode_switch':
        if (msg.mode !== session.mode) {
          session.mode = msg.mode;
          if (stt) stt.switchMode(msg.mode);
          send({ type: 'status', text: msg.mode === 'auto' ? 'Auto-modus actief.' : 'Handmatige modus actief.' });
        }
        break;

      case 'add_participant': {
        const newParticipant = createParticipant(msg.name, msg.role, msg.language, msg.gender ?? 'female');
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

          // Phase 3: update diarization map so future utterances auto-correct
          if (entry.speakerIndex !== undefined && entry.speakerIndex !== null) {
            speakerMap.set(entry.speakerIndex, msg.participantId);
            console.log(`[diarize] Corrected: speaker ${entry.speakerIndex} = ${assignedParticipant.name}`);
          }

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
          console.log(`[redo] converted "${text.slice(0, 30)}" -> "${sourceText.slice(0, 30)}" (${sourceLang})`);
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
            const redoTarget = session.participants.find(
              p => p.language === targetLang && p.isPresent,
            );
            const voiceId = getVoice(targetLang, redoTarget?.gender ?? 'female');
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

  clientWs.on('close', () => {
    console.log('[relay] Client disconnected');
    testPlayer?.pause();
    stt?.disconnect();
  });

  clientWs.on('error', (err: Error) => {
    console.error('[ws] client error', err.message);
    testPlayer?.pause();
    stt?.disconnect();
  });
});

server.listen(PORT, () => console.log(`[relay] Running on http://localhost:${PORT}`));
