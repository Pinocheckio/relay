/**
 * Relay — client-side audio capture, WebSocket relay, TTS playback, UI logic.
 */

// ── Auth ──────────────────────────────────────────────────────────────────

const authOverlay = document.getElementById('auth-overlay');
const authInput   = document.getElementById('auth-input');
const authBtn     = document.getElementById('auth-btn');
const authError   = document.getElementById('auth-error');

async function checkAuth(code) {
  const res = await fetch('/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code }),
  });
  return res.ok;
}

async function submitAuth() {
  const code = authInput.value.trim();
  if (!code) return;
  authBtn.disabled = true;
  const ok = await checkAuth(code);
  authBtn.disabled = false;
  if (ok) {
    sessionStorage.setItem('relay_auth', '1');
    authOverlay.classList.add('hidden');
  } else {
    authError.textContent = 'Onjuiste code. Probeer opnieuw.';
    authInput.classList.add('shake');
    authInput.value = '';
    authInput.addEventListener('animationend', () => authInput.classList.remove('shake'), { once: true });
  }
}

authBtn.addEventListener('click', submitAuth);
authInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAuth(); });

// Skip overlay if already authed this session or no code is set
if (sessionStorage.getItem('relay_auth') === '1') {
  authOverlay.classList.add('hidden');
} else {
  // Check if server requires auth at all
  checkAuth('').then(ok => {
    if (ok) authOverlay.classList.add('hidden'); // no ACCESS_CODE set = open
  });
}

// ── State ─────────────────────────────────────────────────────────────────

let ws = null;
let audioContext = null;
let workletNode = null;
let mediaStream = null;
let sourceNode = null;
let resampleNode = null;  // OfflineAudioContext for resampling isn't needed; we resample inline.

let currentMode = 'auto';
let currentLang1 = 'nl';
let currentLang2 = 'fa';
let isRecording = false;
let activePttSpeaker = null;

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
const pttABtn = document.getElementById('btn-ptt-a');
const pttBBtn = document.getElementById('btn-ptt-b');
const pttALabel = document.getElementById('ptt-a-label');
const pttBLabel = document.getElementById('ptt-b-label');
const pttControls = document.getElementById('ptt-controls');
const generateReportBtn = document.getElementById('btn-generate-report');
const reportPanel = document.getElementById('report-panel');
const reportContent = document.getElementById('report-content');
const copyReportBtn = document.getElementById('btn-copy-report');
const ttsIndicator = document.getElementById('tts-indicator');
const connectBtn = document.getElementById('btn-connect');
const levelFill = document.getElementById('level-fill');
const levelStatus = document.getElementById('level-status');
const selectLang1 = document.getElementById('select-lang1');
const selectLang2 = document.getElementById('select-lang2');

let lastLevelUpdate = 0;

// ── WebSocket ─────────────────────────────────────────────────────────────

function connectWs() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${location.host}`;
  ws = new WebSocket(url);

  ws.onopen = () => {
    setStatus('Verbonden');
    connectBtn.textContent = 'Verbreken';
    connectBtn.classList.add('connected');
    // Sync current language selection to server
    ws.send(JSON.stringify({ type: 'set_languages', lang1: currentLang1, lang2: currentLang2 }));
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
      setLang(msg.language);
      appendTranscript(msg.language, msg.targetLanguage, msg.text, msg.translated);
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
    if (e.data.type === 'level') {
      updateLevel(e.data.rms);
      return;
    }
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
  if (vadSilenceTimer) { clearTimeout(vadSilenceTimer); vadSilenceTimer = null; }
  vadSpeaking = false;
  if (workletNode) { workletNode.disconnect(); workletNode = null; }
  if (sourceNode) { sourceNode.disconnect(); sourceNode = null; }
  if (mediaStream) { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
  if (audioContext) { audioContext.close(); audioContext = null; }
  isRecording = false;
}

// ── Audio level meter + client-side VAD ──────────────────────────────────

const SPEECH_THRESHOLD = 0.01;   // noise floor ~0.00014, speech ~0.02+
const SILENCE_MS = 900;          // ms of silence after speech before committing
const MIN_SPEECH_MS = 250;       // ignore bursts shorter than this (avoid false triggers)

let vadSpeaking = false;
let vadSpeechStart = 0;
let vadSilenceTimer = null;

function updateLevel(rms) {
  // Throttle DOM updates to 20fps to stop the bar from glitching
  const now = Date.now();
  if (now - lastLevelUpdate < 50) return;
  lastLevelUpdate = now;

  const pct = Math.min(100, rms * 2000);
  levelFill.style.width = pct + '%';
  levelFill.classList.toggle('loud', pct > 60);
  levelFill.classList.toggle('clipping', pct > 90);
  levelStatus.textContent = vadSpeaking ? '● spreekt' : '';

  // Only run VAD in auto mode when connected
  if (currentMode !== 'auto' || !ws || ws.readyState !== WebSocket.OPEN) return;

  if (rms > SPEECH_THRESHOLD) {
    // Speech detected
    if (!vadSpeaking) {
      vadSpeaking = true;
      vadSpeechStart = Date.now();
    }
    // Cancel any pending silence commit
    if (vadSilenceTimer) {
      clearTimeout(vadSilenceTimer);
      vadSilenceTimer = null;
    }
  } else {
    // Silence
    if (vadSpeaking && !vadSilenceTimer) {
      vadSilenceTimer = setTimeout(() => {
        vadSilenceTimer = null;
        if (vadSpeaking) {
          const speechDuration = Date.now() - vadSpeechStart;
          vadSpeaking = false;
          if (speechDuration >= MIN_SPEECH_MS) {
            // Enough speech captured — commit
            sendWs({ type: 'manual_commit' });
          }
        }
      }, SILENCE_MS);
    }
  }
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

const LANG_LABELS = { nl: 'NL', 'nl-NL': 'NL', 'nl-BE': 'NL', fa: 'FA', 'fa-IR': 'FA', en: 'EN', 'en-US': 'EN', 'en-GB': 'EN' };
function setLang(code) {
  if (code) langEl.textContent = LANG_LABELS[code] ?? code.slice(0,2).toUpperCase();
}

function appendTranscript(sourceLang, targetLang, original, translated) {
  const entry = document.createElement('div');
  entry.className = `transcript-entry speaker-${sourceLang}`;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  const label = document.createElement('span');
  label.className = 'bubble-label';
  label.textContent = LANG_LABELS[sourceLang] ?? sourceLang.toUpperCase();

  const originalLine = document.createElement('p');
  originalLine.className = 'bubble-text';
  originalLine.dir = sourceLang === 'fa' ? 'rtl' : 'ltr';
  originalLine.textContent = original;

  bubble.appendChild(label);
  bubble.appendChild(originalLine);
  entry.appendChild(bubble);

  // Only show translation line if there is one
  if (targetLang && translated) {
    const translatedLine = document.createElement('p');
    translatedLine.className = 'translation';
    translatedLine.dir = targetLang === 'fa' ? 'rtl' : 'ltr';
    translatedLine.textContent = `${LANG_LABELS[targetLang] ?? targetLang.toUpperCase()}: ${translated}`;
    entry.appendChild(translatedLine);
  }

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
  if (ws) {
    disconnectWs();
    levelFill.style.width = '0%';
    levelStatus.textContent = '';
  } else {
    connectWs();
    startRecording();
  }
});

modeAutoBtn.addEventListener('click', () => setMode('auto'));
modeManuBtn.addEventListener('click', () => setMode('manual'));

function updatePttLabels() {
  pttALabel.textContent = currentLang1.toUpperCase();
  pttBLabel.textContent = currentLang2.toUpperCase();
  pttABtn.className = `btn-ptt btn-ptt-${currentLang1}`;
  pttBBtn.className = `btn-ptt btn-ptt-${currentLang2}`;
}

function sendLanguages() {
  sendWs({ type: 'set_languages', lang1: currentLang1, lang2: currentLang2 });
  updatePttLabels();
}

selectLang1.addEventListener('change', () => {
  currentLang1 = selectLang1.value;
  sendLanguages();
});

selectLang2.addEventListener('change', () => {
  currentLang2 = selectLang2.value;
  sendLanguages();
});

['mousedown', 'touchstart'].forEach(evt => {
  pttABtn.addEventListener(evt, (e) => { e.preventDefault(); pttStart(currentLang1); });
  pttBBtn.addEventListener(evt, (e) => { e.preventDefault(); pttStart(currentLang2); });
});
['mouseup', 'mouseleave', 'touchend', 'touchcancel'].forEach(evt => {
  pttABtn.addEventListener(evt, () => pttEnd(currentLang1));
  pttBBtn.addEventListener(evt, () => pttEnd(currentLang2));
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
updatePttLabels();
