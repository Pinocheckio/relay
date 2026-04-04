import { EventEmitter } from 'events';
import type { TestScript, TestScriptLine, SpeechLine, ActionLine, Session, Speaker } from './types.js';
import type { SttClient } from './stt.js';
import type { synthesize } from './tts.js';
import { removeParticipant, rejoinParticipant } from './participants.js';

// Default voice pools per language for audio test mode.
// English uses 3 distinct voices for diarization testing (Farid/Nadia/Mehdi).
const VOICE_POOL: Record<string, string[]> = {
  nl: ['nPczCjzI2devNBz1zQrb'],                            // Brian (NL)
  en: ['TxGEqnHWrfWFTfGW9XjX', 'EXAVITQu4vr4xnSDxMaL', 'pqHfZKP75CvOlQylNhV4'], // Josh, Bella, Bill
  fa: ['9BWtsMINqrJLrRacOk9x'],                            // Aria (FA)
};

interface AccuracyResult {
  expected: { text: string; language: string; speaker: string };
  actual: { text: string; language: string; speakerIndex: number | null };
  textSimilarity: number;
  languageMatch: boolean;
}

// Callback for text-mode commits: awaited so player waits for the full pipeline
// (translation + TTS synthesis) before advancing to the next line.
export type CommitTextHandler = (text: string, lang: string, participantName: string) => Promise<void>;

export interface TestModePlayerOptions {
  script: TestScript;
  session: Session;
  mode: 'audio' | 'text';
  apiKey: string;         // ElevenLabs API key for audio generation
  stt?: SttClient;        // Required in audio mode only
  synthesizeFn: typeof synthesize;
  sendFn: (msg: object) => void;
  onCommitText?: CommitTextHandler;  // Text mode: awaited pipeline handler
}

export class TestModePlayer extends EventEmitter {
  private script: TestScript;
  private session: Session;
  private mode: 'audio' | 'text';
  private apiKey: string;
  private stt: SttClient | null;
  private synthesizeFn: typeof synthesize;
  private sendFn: (msg: object) => void;
  private onCommitText: CommitTextHandler | null;

  private lineIndex = 0;
  private playing = false;
  private speed = 1;
  private accuracyResults: AccuracyResult[] = [];

  // Voice assignment: participant name -> voiceId
  private voiceAssignments = new Map<string, string>();

  constructor(opts: TestModePlayerOptions) {
    super();
    this.script = opts.script;
    this.session = opts.session;
    this.mode = opts.mode;
    this.apiKey = opts.apiKey;
    this.stt = opts.stt ?? null;
    this.synthesizeFn = opts.synthesizeFn;
    this.sendFn = opts.sendFn;
    this.onCommitText = opts.onCommitText ?? null;
    this.assignVoices();
  }

  private assignVoices(): void {
    const langCounters = new Map<string, number>();
    for (const p of this.script.participants) {
      if (p.voiceId) {
        this.voiceAssignments.set(p.name, p.voiceId);
      } else {
        const pool = VOICE_POOL[p.language] ?? VOICE_POOL['en'] ?? [];
        const idx = langCounters.get(p.language) ?? 0;
        langCounters.set(p.language, idx + 1);
        this.voiceAssignments.set(p.name, pool[idx % pool.length] ?? 'nPczCjzI2devNBz1zQrb');
      }
    }
  }

  async play(): Promise<void> {
    this.playing = true;
    while (this.playing && this.lineIndex < this.script.lines.length) {
      await this.processLine(this.script.lines[this.lineIndex], this.lineIndex);
      this.lineIndex++;
      this.emitProgress();
    }
    if (this.lineIndex >= this.script.lines.length) {
      this.playing = false;
      this.emitComplete();
    }
  }

  pause(): void {
    this.playing = false;
    this.sendFn({ type: 'test_audio_stop' });
  }

  async step(): Promise<void> {
    if (this.lineIndex < this.script.lines.length) {
      await this.processLine(this.script.lines[this.lineIndex], this.lineIndex);
      this.lineIndex++;
      this.emitProgress();
      if (this.lineIndex >= this.script.lines.length) {
        this.emitComplete();
      }
    }
  }

  reset(): void {
    this.playing = false;
    this.lineIndex = 0;
    this.accuracyResults = [];
    this.sendFn({ type: 'test_audio_stop' });
    this.emitProgress();
  }

  setSpeed(speed: number): void {
    this.speed = Math.max(0.25, Math.min(10, speed));
  }

  private async processLine(line: TestScriptLine, index: number): Promise<void> {
    switch (line.type) {
      case 'speech':
        if (this.mode === 'audio') {
          await this.processSpeechAudio(line, index);
        } else {
          await this.processSpeechText(line);
        }
        break;
      case 'action':
        await this.processAction(line);
        break;
      case 'pause':
        await this.sleep(line.durationMs / this.speed);
        break;
    }
  }

  private async processSpeechAudio(line: SpeechLine, index: number): Promise<void> {
    const voiceId = this.voiceAssignments.get(line.speaker) ?? 'nPczCjzI2devNBz1zQrb';

    // Generate PCM audio via ElevenLabs TTS at 16kHz (matches Deepgram linear16 input)
    const pcmChunks: Buffer[] = [];
    await this.synthesizeFn(
      line.text,
      line.language as Speaker,
      this.apiKey,
      voiceId,
      (chunk) => { pcmChunks.push(Buffer.from(chunk, 'base64')); },
      { outputFormat: 'pcm_16000' },
    );

    const fullPcm = Buffer.concat(pcmChunks);

    // Register listener BEFORE sending audio so we don't miss a fast response
    const commitPromise = this.waitForNextCommit(8000);

    // Feed PCM to Deepgram — same path as live microphone (server's normal STT handler fires)
    this.stt!.sendChunk(fullPcm);

    const { text: actualText, lang: actualLang, speakerIndex: actualSI } = await commitPromise;

    // Accuracy comparison: expected script vs what Deepgram actually returned
    const similarity = this.wordSimilarity(line.text, actualText);
    const langMatch = !actualLang || actualLang === line.language || actualLang.startsWith(line.language.slice(0, 2));
    const result: AccuracyResult = {
      expected: { text: line.text, language: line.language, speaker: line.speaker },
      actual: { text: actualText, language: actualLang, speakerIndex: actualSI },
      textSimilarity: similarity,
      languageMatch: langMatch,
    };
    this.accuracyResults.push(result);
    this.sendFn({ type: 'test_accuracy', lineIndex: index, ...result });
  }

  private waitForNextCommit(timeoutMs: number): Promise<{ text: string; lang: string; speakerIndex: number | null }> {
    return new Promise((resolve) => {
      const onCommitted = (text: string, lang: string, speakerIndex: number | null) => {
        resolve({ text, lang, speakerIndex });
      };
      this.stt!.once('committed', onCommitted);
      setTimeout(() => {
        this.stt!.off('committed', onCommitted as (...args: unknown[]) => void);
        resolve({ text: '', lang: '', speakerIndex: null });
      }, timeoutMs);
    });
  }

  private async processSpeechText(line: SpeechLine): Promise<void> {
    if (this.onCommitText) {
      // Await the full pipeline (translate + TTS synthesis) so we don't advance
      // to the next line until this one's audio has been sent to the client.
      await this.onCommitText(line.text, line.language, line.speaker);

      // The pipeline completes when TTS chunks are sent, but the client still
      // needs time to play them. Estimate playback duration (~300ms/word at 1x).
      const wordCount = line.text.split(/\s+/).length;
      const playbackMs = (wordCount * 300 + 500) / this.speed;
      await this.sleep(playbackMs);
    } else {
      // Fallback: fire-and-forget with simulated pacing
      this.emit('committed', line.text, line.language, null);
      const wordCount = line.text.split(/\s+/).length;
      const speechDurationMs = (wordCount * 100 + 500) / this.speed;
      await this.sleep(speechDurationMs);
    }
  }

  private async processAction(line: ActionLine): Promise<void> {
    const participantName = (line.participant ?? '').toLowerCase();
    const participant = this.session.participants.find(
      p => p.name.toLowerCase() === participantName,
    );

    if (line.effect === 'leave' && participant) {
      const seg = removeParticipant(this.session, participant.id);
      this.sendFn({
        type: 'participants_update',
        participants: this.session.participants,
        segments: this.session.segments,
        currentSegmentId: this.session.currentSegmentId,
      });
      this.sendFn({ type: 'segment_change', segment: seg, label: `${participant.name} heeft het gesprek verlaten` });
    } else if (line.effect === 'rejoin' && participant) {
      const seg = rejoinParticipant(this.session, participant.id);
      this.sendFn({
        type: 'participants_update',
        participants: this.session.participants,
        segments: this.session.segments,
        currentSegmentId: this.session.currentSegmentId,
      });
      this.sendFn({ type: 'segment_change', segment: seg, label: `${participant.name} is teruggekomen` });
    }

    // Always show the narrative description as a system message in the transcript
    this.sendFn({ type: 'test_narration', description: line.description });
  }

  private emitProgress(): void {
    this.sendFn({
      type: 'test_progress',
      lineIndex: this.lineIndex,
      totalLines: this.script.lines.length,
      currentLine: this.lineIndex < this.script.lines.length ? this.script.lines[this.lineIndex] : null,
    });
  }

  private emitComplete(): void {
    const results = this.accuracyResults;
    const avgSimilarity = results.length > 0
      ? results.reduce((s, r) => s + r.textSimilarity, 0) / results.length
      : 1;
    const langAccuracy = results.length > 0
      ? results.filter(r => r.languageMatch).length / results.length
      : 1;
    this.sendFn({
      type: 'test_complete',
      summary: {
        totalLines: this.script.lines.length,
        avgTextSimilarity: avgSimilarity,
        languageAccuracy: langAccuracy,
        diarizationConsistency: 0, // calculated post-hoc in Phase 3 extension
      },
    });
  }

  private wordSimilarity(expected: string, actual: string): number {
    const normalize = (s: string) =>
      s.toLowerCase().replace(/[^\w\s]/g, '').split(/\s+/).filter(Boolean);
    const expWords = normalize(expected);
    const actWords = normalize(actual);
    if (expWords.length === 0) return actWords.length === 0 ? 1 : 0;
    const matched = actWords.filter(w => expWords.includes(w)).length;
    return matched / Math.max(expWords.length, actWords.length);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
  }
}
