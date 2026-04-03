/**
 * Relay — client-side audio capture, WebSocket relay, TTS playback, UI logic.
 */

// ── State ─────────────────────────────────────────────────────────────────

let ws = null;
let audioContext = null;
let workletNode = null;
let mediaStream = null;
let sourceNode = null;
let resampleNode = null;  // OfflineAudioContext for resampling isn't needed; we resample inline.

let currentMode = 'auto';
let isRecording = false;
let activePttSpeaker = null;   // 'nl' | 'fa' | null

// TTS playback queue
const ttsChunks = [];
let ttsPlaying = false;
const AUDIO_QUEUE = [];
let audioQueueRunning = false;

// ── DOM refs ──────────────────────────────────────────────────────────────

const transcriptEl = document.getElementById('transcript');
const partialEl = document.getElementById('partial-text');
const statusEl = document.getElementById('status-text');
const langEl = document.getElementById('lang-detected');
const modeAutoBtn = document.getElementById('btn-mode-auto');
const modeManuBtn = document.getElementById('btn-mode-manual');
const pttNlBtn = document.getElementById('btn-ptt-nl');
const pttFaBtn = document.getElementById('btn-ptt-fa');
const pttControls = document.getElementById('ptt-controls');
const generateReportBtn = document.getElementById('btn-generate-report');
const reportPanel = document.getElementById('report-panel');
const reportContent = document.getElementById('report-content');
const copyReportBtn = document.getElementById('btn-copy-report');
const ttsIndicator = document.getElementById('tts-indicator');
const connectBtn = document.getElementById('btn-connect');

// ── WebSocket ─────────────────────────────────────────────────────────────

function connectWs() {
  const url = `ws://${location.host}`;
  ws = new WebSocket(url);

  ws.onopen = () => {
    setStatus('Verbonden');
    connectBtn.textContent = 'Verbreken';
    connectBtn.classList.add('connected');
  };

  ws.onclose = () => {
    setStatus('Verbroken');
    connectBtn.textContent = 'Verbinden';
    connectBtn.classList.remove('connected');
    stopRecording();
    ws = null;
  };

  ws.onerror = () => {
    setStatus('Verbindingsfout');
  };

  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data);
    handleServerMessage(msg);
  };
}

function disconnectWs() {
  if (ws) ws.close();
  stopRecording();
}

function sendWs(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  }
}

// ── Server message handler ────────────────────────────────────────────────

function handleServerMessage(msg) {
  switch (msg.type) {
    case 'status':
      setStatus(msg.text);
      break;

    case 'error':
      setStatus('Fout: ' + msg.text);
      appendError(msg.text);
      break;

    case 'partial_transcript':
      partialEl.textContent = msg.text;
      if (msg.language) setLang(msg.language);
      break;

    case 'committed_transcript':
      partialEl.textContent = '';
      appendTranscript(msg.language, msg.text, msg.translated);
      break;

    case 'tts_audio':
      ttsChunks.push(msg.data);
      break;

    case 'tts_end':
      playTtsChunks();
      break;

    case 'report':
      showReport(msg.content);
      break;
  }
}

// ── Audio capture ─────────────────────────────────────────────────────────

async function startRecording() {
  if (isRecording) return;
  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
  } catch (e) {
    setStatus('Microfoon geweigerd: ' + e.message);
    return;
  }

  audioContext = new AudioContext({ sampleRate: 16000 });

  try {
    await audioContext.audioWorklet.addModule('/pcm-processor.js');
  } catch (e) {
    setStatus('AudioWorklet fout: ' + e.message);
    return;
  }

  sourceNode = audioContext.createMediaStreamSource(mediaStream);
  workletNode = new AudioWorkletNode(audioContext, 'pcm-processor');

  workletNode.port.onmessage = (e) => {
    if (e.data.type !== 'pcm_chunk') return;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    // In manual mode, only send when a PTT button is held
    if (currentMode === 'manual' && !activePttSpeaker) return;

    const float32 = e.data.samples;
    const int16 = float32ToInt16(float32);
    const base64 = arrayBufferToBase64(int16.buffer);

    sendWs({ type: 'audio_chunk', data: base64, mode: currentMode });
  };

  sourceNode.connect(workletNode);
  workletNode.connect(audioContext.destination);

  isRecording = true;
  setStatus(currentMode === 'auto' ? 'Luisteren...' : 'Klaar — houd knop ingedrukt om te spreken.');
}

function stopRecording() {
  if (!isRecording) return;
  if (workletNode) { workletNode.disconnect(); workletNode = null; }
  if (sourceNode) { sourceNode.disconnect(); sourceNode = null; }
  if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
  if (audioContext) { audioContext.close(); audioContext = null; }
  isRecording = false;
}

// ── PCM helpers ───────────────────────────────────────────────────────────

function float32ToInt16(float32Array) {
  const int16 = new Int16Array(float32Array.length);
  for (let i = 0; i < float32Array.length; i++) {
    const s = Math.max(-1, Math.min(1, float32Array[i]));
    int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return int16;
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

// ── TTS playback ──────────────────────────────────────────────────────────

function playTtsChunks() {
  if (ttsChunks.length === 0) return;

  // Combine all chunks into a single base64 string, then decode and play
  const combined = ttsChunks.splice(0);
  const binary = combined.map(b64 => atob(b64)).join('');
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const blob = new Blob([bytes], { type: 'audio/mpeg' });
  const url = URL.createObjectURL(blob);

  const audio = new Audio(url);
  ttsIndicator.classList.add('active');

  AUDIO_QUEUE.push({ audio, url });
  if (!audioQueueRunning) drainAudioQueue();
}

function drainAudioQueue() {
  if (AUDIO_QUEUE.length === 0) {
    audioQueueRunning = false;
    ttsIndicator.classList.remove('active');
    return;
  }
  audioQueueRunning = true;
  const { audio, url } = AUDIO_QUEUE.shift();
  audio.play().catch(() => {});
  audio.onended = () => {
    URL.revokeObjectURL(url);
    drainAudioQueue();
  };
}

// ── Mode switching ────────────────────────────────────────────────────────

function setMode(mode) {
  currentMode = mode;
  modeAutoBtn.classList.toggle('active', mode === 'auto');
  modeManuBtn.classList.toggle('active', mode === 'manual');
  pttControls.classList.toggle('hidden', mode === 'auto');
  setStatus(mode === 'auto' ? 'Luisteren...' : 'Klaar — houd knop ingedrukt.');
  sendWs({ type: 'mode_switch', mode });
}

// ── PTT buttons ───────────────────────────────────────────────────────────

function pttStart(speaker) {
  activePttSpeaker = speaker;
  const btn = speaker === 'nl' ? pttNlBtn : pttFaBtn;
  btn.classList.add('recording');
  setStatus(`Opnemen (${speaker.toUpperCase()})...`);
}

function pttEnd(speaker) {
  if (activePttSpeaker !== speaker) return;
  activePttSpeaker = null;
  const btn = speaker === 'nl' ? pttNlBtn : pttFaBtn;
  btn.classList.remove('recording');
  sendWs({ type: 'manual_commit' });
  setStatus('Verwerken...');
}

// ── UI helpers ────────────────────────────────────────────────────────────

function setStatus(text) {
  statusEl.textContent = text;
}

function setLang(code) {
  const map = { nl: 'NL', 'nl-NL': 'NL', 'nl-BE': 'NL', fa: 'FA', 'fa-IR': 'FA' };
  langEl.textContent = map[code] ?? code.toUpperCase();
}

function appendTranscript(language, original, translated) {
  const entry = document.createElement('div');
  entry.className = `transcript-entry speaker-${language}`;

  const originalLine = document.createElement('p');
  originalLine.className = 'original';
  originalLine.dir = language === 'fa' ? 'rtl' : 'ltr';
  originalLine.textContent = `${language.toUpperCase()}: ${original}`;

  const translatedLine = document.createElement('p');
  translatedLine.className = 'translated';
  translatedLine.dir = language === 'nl' ? 'rtl' : 'ltr'; // translated is the other language
  translatedLine.textContent = `→ ${language === 'nl' ? 'FA' : 'NL'}: ${translated}`;

  entry.appendChild(originalLine);
  entry.appendChild(translatedLine);
  transcriptEl.appendChild(entry);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function appendError(text) {
  const el = document.createElement('p');
  el.className = 'error-line';
  el.textContent = text;
  transcriptEl.appendChild(el);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function showReport(markdown) {
  // Simple markdown-to-HTML for the 4 sections
  const html = markdown
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/\n/g, '<br>');
  reportContent.innerHTML = html;
  reportPanel.classList.remove('hidden');
  reportPanel.scrollIntoView({ behavior: 'smooth' });
}

// ── Event listeners ───────────────────────────────────────────────────────

connectBtn.addEventListener('click', () => {
  if (ws) { disconnectWs(); } else { connectWs(); startRecording(); }
});

modeAutoBtn.addEventListener('click', () => setMode('auto'));
modeManuBtn.addEventListener('click', () => setMode('manual'));

// PTT: mouse + touch support
['mousedown', 'touchstart'].forEach(evt => {
  pttNlBtn.addEventListener(evt, (e) => { e.preventDefault(); pttStart('nl'); });
  pttFaBtn.addEventListener(evt, (e) => { e.preventDefault(); pttStart('fa'); });
});
['mouseup', 'mouseleave', 'touchend', 'touchcancel'].forEach(evt => {
  pttNlBtn.addEventListener(evt, () => pttEnd('nl'));
  pttFaBtn.addEventListener(evt, () => pttEnd('fa'));
});

generateReportBtn.addEventListener('click', () => {
  sendWs({ type: 'generate_report' });
});

copyReportBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(reportContent.innerText).then(() => {
    copyReportBtn.textContent = 'Gekopieerd!';
    setTimeout(() => { copyReportBtn.textContent = 'Kopieer'; }, 2000);
  });
});

// ── Init ──────────────────────────────────────────────────────────────────

setMode('auto');
