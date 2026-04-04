/**
 * Relay — client-side audio capture, WebSocket relay, TTS playback, UI logic.
 * v2: Participant management, onboarding, context windows, segment-aware report.
 */

// ── Participant color palette (8 care-friendly colors) ────────────────────

const PARTICIPANT_COLORS = [
  { bg: '#dbeafe', border: '#93c5fd', accent: '#2563eb' }, // blue
  { bg: '#fce7f3', border: '#f9a8d4', accent: '#db2777' }, // pink
  { bg: '#d1fae5', border: '#6ee7b7', accent: '#059669' }, // green
  { bg: '#fef3c7', border: '#fcd34d', accent: '#d97706' }, // amber
  { bg: '#ede9fe', border: '#c4b5fd', accent: '#7c3aed' }, // violet
  { bg: '#fee2e2', border: '#fca5a5', accent: '#dc2626' }, // red
  { bg: '#e0f2fe', border: '#7dd3fc', accent: '#0891b2' }, // cyan
  { bg: '#f0fdf4', border: '#86efac', accent: '#65a30d' }, // lime
];

const ROLE_LABELS = {
  care_worker:   'Zorgverlener',
  family_member: 'Familie',
  client:        'Cliënt',
  interpreter:   'Tolk',
  other:         'Anders',
};

const LANG_LABELS = {
  nl: 'NL', 'nl-NL': 'NL', 'nl-BE': 'NL',
  fa: 'FA', 'fa-IR': 'FA',
  en: 'EN', 'en-US': 'EN', 'en-GB': 'EN',
  ar: 'AR', tr: 'TR', de: 'DE', fr: 'FR',
};

function getLangLabel(code) {
  return LANG_LABELS[code] ?? code.slice(0, 2).toUpperCase();
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Auth ──────────────────────────────────────────────────────────────────

const authOverlay  = document.getElementById('auth-overlay');
const authInput    = document.getElementById('auth-input');
const authBtn      = document.getElementById('auth-btn');
const authError    = document.getElementById('auth-error');

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
    onboardingOverlay.classList.remove('hidden');
  } else {
    authError.textContent = 'Onjuiste code. Probeer opnieuw.';
    authInput.classList.add('shake');
    authInput.value = '';
    authInput.addEventListener('animationend', () => authInput.classList.remove('shake'), { once: true });
  }
}

authBtn.addEventListener('click', submitAuth);
authInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submitAuth(); });

if (sessionStorage.getItem('relay_auth') === '1') {
  authOverlay.classList.add('hidden');
  onboardingOverlay.classList.remove('hidden');
} else {
  checkAuth('').then(ok => {
    if (ok) {
      authOverlay.classList.add('hidden');
      onboardingOverlay.classList.remove('hidden');
    }
  });
}

// ── Onboarding ────────────────────────────────────────────────────────────

const onboardingOverlay         = document.getElementById('onboarding-overlay');
const participantForm           = document.getElementById('participant-form');
const pNameInput                = document.getElementById('p-name');
const pRoleSelect               = document.getElementById('p-role');
const pLangSelect               = document.getElementById('p-lang');
const onboardingParticipantList = document.getElementById('onboarding-participant-list');
const onboardingHint            = document.getElementById('onboarding-hint');
const btnStartSession           = document.getElementById('btn-start-session');

let onboardingParticipants = []; // Array of {name, role, language}

function getParticipantColor(index) {
  return PARTICIPANT_COLORS[index % PARTICIPANT_COLORS.length];
}

function renderOnboardingList() {
  onboardingParticipantList.innerHTML = '';
  onboardingParticipants.forEach((p, i) => {
    const color = getParticipantColor(i);
    const row = document.createElement('div');
    row.className = 'onboarding-participant-row';
    row.innerHTML = `
      <span class="onboarding-participant-dot" style="background:${color.accent}"></span>
      <span class="onboarding-participant-name">${escapeHtml(p.name)}</span>
      <span class="onboarding-participant-meta">${escapeHtml(ROLE_LABELS[p.role] ?? p.role)} · ${getLangLabel(p.language)}</span>
      <button class="onboarding-participant-remove" data-index="${i}" title="Verwijderen">×</button>
    `;
    onboardingParticipantList.appendChild(row);
  });

  onboardingParticipantList.querySelectorAll('.onboarding-participant-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      onboardingParticipants.splice(Number(btn.dataset.index), 1);
      renderOnboardingList();
      updateStartButton();
    });
  });
}

function updateStartButton() {
  const ready = onboardingParticipants.length >= 2;
  btnStartSession.disabled = !ready;
  onboardingHint.textContent = ready
    ? `${onboardingParticipants.length} deelnemers. Klaar om te starten.`
    : 'Voeg minimaal 2 deelnemers toe.';
}

participantForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = pNameInput.value.trim();
  if (!name) { pNameInput.focus(); return; }
  onboardingParticipants.push({
    name,
    role: pRoleSelect.value,
    language: pLangSelect.value,
  });
  pNameInput.value = '';
  pNameInput.focus();
  renderOnboardingList();
  updateStartButton();
});

btnStartSession.addEventListener('click', () => {
  if (onboardingParticipants.length < 2) return;
  onboardingOverlay.classList.add('hidden');
  startConversation();
});

// ── State ─────────────────────────────────────────────────────────────────

let ws            = null;
let audioContext  = null;
let workletNode   = null;
let mediaStream   = null;
let sourceNode    = null;
let currentMode   = 'auto';
let isRecording   = false;
let activePttSpeaker = null;

// Server-synced participant state
let participants = []; // full Participant[] from server

// TTS playback queue
const ttsChunks = [];
const AUDIO_QUEUE = [];
let audioQueueRunning = false;

// Map of entryId → DOM element for in-place updates
const entryElements = new Map();

// ── DOM refs ──────────────────────────────────────────────────────────────

const transcriptEl      = document.getElementById('transcript');
const partialEl         = document.getElementById('partial-text');
const statusEl          = document.getElementById('status-text');
const langEl            = document.getElementById('lang-detected');
const modeAutoBtn       = document.getElementById('btn-mode-auto');
const modeManuBtn       = document.getElementById('btn-mode-manual');
const pttABtn           = document.getElementById('btn-ptt-a');
const pttBBtn           = document.getElementById('btn-ptt-b');
const pttALabel         = document.getElementById('ptt-a-label');
const pttBLabel         = document.getElementById('ptt-b-label');
const pttControls       = document.getElementById('ptt-controls');
const generateReportBtn = document.getElementById('btn-generate-report');
const correctionPopover = document.getElementById('correction-popover');
const correctionParticipantBtns = document.getElementById('correction-participant-btns');
const correctionLangBtns = document.getElementById('correction-lang-btns');
const reportPanel       = document.getElementById('report-panel');
const reportContent     = document.getElementById('report-content');
const copyReportBtn     = document.getElementById('btn-copy-report');
const ttsIndicator      = document.getElementById('tts-indicator');
const disconnectBtn     = document.getElementById('btn-disconnect');
const participantPanel  = document.getElementById('participant-panel');
const participantChipsEl= document.getElementById('participant-chips');
const btnAddMid         = document.getElementById('btn-add-mid');
const midSessionForm    = document.getElementById('mid-session-form');
const midParticipantForm= document.getElementById('mid-participant-form');
const midPNameInput     = document.getElementById('mid-p-name');
const midPRoleSelect    = document.getElementById('mid-p-role');
const midPLangSelect    = document.getElementById('mid-p-lang');
const btnCancelMid      = document.getElementById('btn-cancel-mid');
const levelFill         = document.getElementById('level-fill');
const levelStatus       = document.getElementById('level-status');

let lastLevelUpdate = 0;

// ── Participant helpers ───────────────────────────────────────────────────

function getParticipantColorById(participantId) {
  const idx = participants.findIndex(p => p.id === participantId);
  return idx >= 0 ? getParticipantColor(idx) : { bg: '#f3f4f6', border: '#d1d5db', accent: '#6b7280' };
}

function getBubbleAlignment(participantId, language) {
  if (participantId) {
    const p = participants.find(p => p.id === participantId);
    if (p) return p.role === 'care_worker' ? 'left' : 'right';
  }
  // Language-based fallback: if any care_worker speaks this language, put left
  const careWorkerLangs = participants.filter(p => p.role === 'care_worker').map(p => p.language);
  return careWorkerLangs.includes(language) ? 'left' : 'right';
}

function renderParticipantChips() {
  participantChipsEl.innerHTML = '';
  participants.forEach((p, i) => {
    const color = getParticipantColor(i);
    const chip = document.createElement('div');
    chip.className = `participant-chip${p.isPresent ? '' : ' absent'}`;
    chip.style.setProperty('--chip-color', color.accent);
    chip.style.setProperty('--chip-bg', color.bg);
    chip.style.setProperty('--chip-border', color.border);
    chip.innerHTML = `
      <span class="chip-dot"></span>
      <span class="chip-name">${escapeHtml(p.name)}</span>
      <span class="chip-lang">${getLangLabel(p.language)}</span>
      ${p.isPresent
        ? `<button class="chip-leave" data-id="${p.id}" title="${escapeHtml(p.name)} verlaat gesprek">×</button>`
        : `<button class="chip-rejoin" data-id="${p.id}" title="${escapeHtml(p.name)} is terug">↩</button>`
      }
    `;
    participantChipsEl.appendChild(chip);
  });

  participantChipsEl.querySelectorAll('.chip-leave').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      sendWs({ type: 'remove_participant', participantId: btn.dataset.id });
    });
  });

  participantChipsEl.querySelectorAll('.chip-rejoin').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      sendWs({ type: 'rejoin_participant', participantId: btn.dataset.id });
    });
  });
}

function updatePttLabels() {
  const langs = [...new Set(participants.filter(p => p.isPresent).map(p => p.language))];
  const lang1 = langs[0] ?? 'nl';
  const lang2 = langs[1] ?? lang1;
  pttALabel.textContent = getLangLabel(lang1);
  pttBLabel.textContent = getLangLabel(lang2);
  pttABtn.className = `btn-ptt btn-ptt-${lang1}`;
  pttBBtn.className = `btn-ptt btn-ptt-${lang2}`;
}

// ── WebSocket ─────────────────────────────────────────────────────────────

function connectWs(onOpenCallback) {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}`);

  ws.onopen = () => {
    setStatus('Verbonden');
    disconnectBtn.classList.remove('hidden');
    if (onOpenCallback) onOpenCallback();
  };

  ws.onclose = () => {
    setStatus('Verbroken');
    disconnectBtn.classList.add('hidden');
    stopRecording();
    ws = null;
  };

  ws.onerror = () => setStatus('Verbindingsfout');

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

// ── Conversation start ────────────────────────────────────────────────────

function startConversation() {
  participantPanel.classList.remove('hidden');
  // Clear placeholder
  transcriptEl.innerHTML = '';

  connectWs(() => {
    // Send all onboarding participants + start session in one message
    sendWs({ type: 'start_session', participants: onboardingParticipants });
    // Start recording
    startRecording();
  });
}

disconnectBtn.addEventListener('click', () => {
  disconnectWs();
  levelFill.style.width = '0%';
  levelStatus.textContent = '';
});

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
      appendTranscript(
        msg.entryId, msg.language,
        msg.participantId, msg.participantName, msg.confident,
        msg.targetLanguage, msg.text, msg.translated,
      );
      break;

    case 'corrected_transcript':
      updateTranscript(
        msg.entryId, msg.language,
        msg.participantId, msg.participantName,
        msg.targetLanguage, msg.text, msg.translated,
      );
      break;

    case 'tts_audio':
      ttsChunks.push(msg.data);
      break;

    case 'tts_end':
      playTtsChunks();
      break;

    case 'report':
      showReport(msg.content);
      generateReportBtn.disabled = false;
      generateReportBtn.textContent = 'Genereer verslag';
      break;

    case 'participants_update':
      participants = msg.participants;
      renderParticipantChips();
      updatePttLabels();
      break;

    case 'segment_change': {
      const time = new Date(msg.segment.startTime).toLocaleTimeString('nl-BE', { hour: '2-digit', minute: '2-digit' });
      appendSegmentDivider(msg.label, time);
      break;
    }
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

// ── Correction popover ────────────────────────────────────────────────────

let activeEntryEl = null;

function showCorrectionPopover(entryEl, anchorEl) {
  activeEntryEl = entryEl;

  const currentLang = entryEl.dataset.sourceLang;
  const currentParticipantId = entryEl.dataset.participantId || null;

  // Participant assignment buttons
  correctionParticipantBtns.innerHTML = '';
  participants.forEach(p => {
    const btn = document.createElement('button');
    btn.className = 'correction-participant-btn' + (p.id === currentParticipantId ? ' current' : '');
    btn.title = p.name;
    btn.textContent = p.name.length > 12 ? p.name.slice(0, 11) + '…' : p.name;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      assignSpeaker(entryEl, p.id);
    });
    correctionParticipantBtns.appendChild(btn);
  });

  // Language correction buttons (unique langs from participants)
  correctionLangBtns.innerHTML = '';
  const activeLangs = [...new Set(participants.map(p => p.language))];
  activeLangs.forEach(code => {
    const btn = document.createElement('button');
    btn.className = 'correction-lang-btn' + (code === currentLang ? ' current' : '');
    btn.textContent = getLangLabel(code);
    btn.addEventListener('click', (e) => { e.stopPropagation(); applyLangCorrection(entryEl, code); });
    correctionLangBtns.appendChild(btn);
  });

  // Delete button
  const delBtn = document.createElement('button');
  delBtn.className = 'correction-lang-btn correction-delete';
  delBtn.textContent = '×';
  delBtn.title = 'Verwijder bericht';
  delBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteEntry(entryEl); });
  correctionLangBtns.appendChild(delBtn);

  const rect = anchorEl.getBoundingClientRect();
  correctionPopover.style.top = (rect.bottom + window.scrollY + 4) + 'px';
  correctionPopover.style.left = rect.left + 'px';
  correctionPopover.classList.remove('hidden');
}

function assignSpeaker(entryEl, participantId) {
  correctionPopover.classList.add('hidden');
  const entryId = entryEl.dataset.entryId;
  const label = entryEl.querySelector('.bubble-label');
  if (label) label.textContent = '⏳';
  sendWs({ type: 'assign_speaker', entryId, participantId });
}

function applyLangCorrection(entryEl, newSourceLang) {
  correctionPopover.classList.add('hidden');
  const entryId = entryEl.dataset.entryId;
  const text = entryEl.dataset.text;

  // Target: first language different from source
  const activeLangs = [...new Set(participants.map(p => p.language))];
  const otherLangs = activeLangs.filter(l => l !== newSourceLang);
  const targetLang = otherLangs[0] ?? null;

  const label = entryEl.querySelector('.bubble-label');
  if (label) label.textContent = '⏳';

  sendWs({ type: 'redo_entry', entryId, text, sourceLang: newSourceLang, targetLang });
}

function deleteEntry(entryEl) {
  correctionPopover.classList.add('hidden');
  const entryId = entryEl.dataset.entryId;
  sendWs({ type: 'delete_entry', entryId });
  entryEl.style.transition = 'opacity 0.2s';
  entryEl.style.opacity = '0';
  setTimeout(() => {
    entryEl.remove();
    entryElements.delete(entryId);
  }, 200);
}

document.addEventListener('click', () => {
  correctionPopover.classList.add('hidden');
  activeEntryEl = null;
});

// ── Audio level meter + client-side VAD ──────────────────────────────────

const SPEECH_THRESHOLD = 0.01;
const SILENCE_MS = 900;
const MIN_SPEECH_MS = 250;

let vadSpeaking = false;
let vadSpeechStart = 0;
let vadSilenceTimer = null;

function updateLevel(rms) {
  const now = Date.now();
  if (now - lastLevelUpdate < 50) return;
  lastLevelUpdate = now;

  const pct = Math.min(100, rms * 2000);
  levelFill.style.width = pct + '%';
  levelFill.classList.toggle('loud', pct > 60);
  levelFill.classList.toggle('clipping', pct > 90);
  levelStatus.textContent = vadSpeaking ? '● spreekt' : '';

  if (currentMode !== 'auto' || !ws || ws.readyState !== WebSocket.OPEN) return;

  if (rms > SPEECH_THRESHOLD) {
    if (!vadSpeaking) {
      vadSpeaking = true;
      vadSpeechStart = Date.now();
    }
    if (vadSilenceTimer) {
      clearTimeout(vadSilenceTimer);
      vadSilenceTimer = null;
    }
  } else {
    if (vadSpeaking && !vadSilenceTimer) {
      vadSilenceTimer = setTimeout(() => {
        vadSilenceTimer = null;
        if (vadSpeaking) {
          const speechDuration = Date.now() - vadSpeechStart;
          vadSpeaking = false;
          if (speechDuration >= MIN_SPEECH_MS) {
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

function pttStart(btnEl) {
  activePttSpeaker = btnEl.id;
  btnEl.classList.add('recording');
  setStatus(`Opnemen...`);
}

function pttEnd(btnEl) {
  if (activePttSpeaker !== btnEl.id) return;
  activePttSpeaker = null;
  btnEl.classList.remove('recording');
  sendWs({ type: 'manual_commit' });
  setStatus('Verwerken...');
}

// ── UI helpers ────────────────────────────────────────────────────────────

function setStatus(text) {
  statusEl.textContent = text;
}

function setLang(code) {
  if (code) langEl.textContent = getLangLabel(code);
}

function buildBubble(entryId, language, participantId, participantName, confident, targetLang, original, translated) {
  const alignment = getBubbleAlignment(participantId, language);
  const color = participantId ? getParticipantColorById(participantId) : { bg: '#f3f4f6', border: '#d1d5db', accent: '#6b7280' };

  const entry = document.createElement('div');
  entry.className = `transcript-entry speaker-${alignment}`;
  entry.dataset.entryId = entryId;
  entry.dataset.text = original;
  entry.dataset.sourceLang = language;
  entry.dataset.participantId = participantId ?? '';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.style.setProperty('--bubble-bg', color.bg);
  bubble.style.setProperty('--bubble-border', color.border);
  bubble.style.setProperty('--bubble-accent', color.accent);

  const label = document.createElement('span');
  label.className = 'bubble-label';
  label.title = 'Klik om te corrigeren';

  if (participantName) {
    label.innerHTML = escapeHtml(participantName) + ' ✎' +
      (confident ? '' : ' <span class="unconfirmed-badge">?</span>');
  } else {
    label.textContent = getLangLabel(language) + ' ✎';
  }
  label.addEventListener('click', (e) => { e.stopPropagation(); showCorrectionPopover(entry, label); });

  const originalLine = document.createElement('p');
  originalLine.className = 'bubble-text';
  originalLine.dir = ['fa', 'ar', 'he'].includes(language) ? 'rtl' : 'ltr';
  originalLine.textContent = original;

  bubble.appendChild(label);
  bubble.appendChild(originalLine);
  entry.appendChild(bubble);

  const translationEl = document.createElement('p');
  translationEl.className = 'translation';
  if (targetLang && translated) {
    translationEl.dir = ['fa', 'ar', 'he'].includes(targetLang) ? 'rtl' : 'ltr';
    translationEl.textContent = `${getLangLabel(targetLang)}: ${translated}`;
  }
  entry.appendChild(translationEl);

  return entry;
}

function appendTranscript(entryId, language, participantId, participantName, confident, targetLang, original, translated) {
  const entry = buildBubble(entryId, language, participantId, participantName, confident, targetLang, original, translated);
  entryElements.set(entryId, entry);
  transcriptEl.appendChild(entry);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function updateTranscript(entryId, language, participantId, participantName, targetLang, original, translated) {
  const existing = entryElements.get(entryId);
  if (!existing) return;

  // Confidence is unknown after correction — treat as confident
  const entry = buildBubble(entryId, language, participantId, participantName, true, targetLang, original, translated);
  existing.replaceWith(entry);
  entryElements.set(entryId, entry);

  entry.classList.add('updated');
  setTimeout(() => entry.classList.remove('updated'), 1000);
}

function appendSegmentDivider(label, time) {
  const divider = document.createElement('div');
  divider.className = 'segment-divider';
  divider.innerHTML = `
    <span class="segment-divider-line"></span>
    <span class="segment-divider-content">
      <span class="segment-divider-time">${escapeHtml(time)}</span>
      <span class="segment-divider-label">${escapeHtml(label)}</span>
    </span>
    <span class="segment-divider-line"></span>
  `;
  transcriptEl.appendChild(divider);
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
  const html = markdown
    .replace(/^## (.+)$/gm, '<h3>$1</h3>')
    .replace(/^### (.+)$/gm, '<h4 style="font-size:0.85rem;font-weight:600;color:#374151;margin:0.75rem 0 0.2rem">$1</h4>')
    .replace(/\n/g, '<br>');
  reportContent.innerHTML = html;
  reportPanel.classList.remove('hidden');
  reportPanel.scrollIntoView({ behavior: 'smooth' });
}

// ── Mid-session participant form ───────────────────────────────────────────

btnAddMid.addEventListener('click', () => {
  midSessionForm.classList.toggle('hidden');
  if (!midSessionForm.classList.contains('hidden')) {
    midPNameInput.focus();
  }
});

btnCancelMid.addEventListener('click', () => {
  midSessionForm.classList.add('hidden');
  midPNameInput.value = '';
});

midParticipantForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const name = midPNameInput.value.trim();
  if (!name) { midPNameInput.focus(); return; }
  sendWs({
    type: 'add_participant',
    name,
    role: midPRoleSelect.value,
    language: midPLangSelect.value,
  });
  midPNameInput.value = '';
  midSessionForm.classList.add('hidden');
});

// ── Mode + report + copy event listeners ─────────────────────────────────

modeAutoBtn.addEventListener('click', () => setMode('auto'));
modeManuBtn.addEventListener('click', () => setMode('manual'));

['mousedown', 'touchstart'].forEach(evt => {
  pttABtn.addEventListener(evt, (e) => { e.preventDefault(); pttStart(pttABtn); });
  pttBBtn.addEventListener(evt, (e) => { e.preventDefault(); pttStart(pttBBtn); });
});
['mouseup', 'mouseleave', 'touchend', 'touchcancel'].forEach(evt => {
  pttABtn.addEventListener(evt, () => pttEnd(pttABtn));
  pttBBtn.addEventListener(evt, () => pttEnd(pttBBtn));
});

generateReportBtn.addEventListener('click', () => {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    setStatus('Niet verbonden — start eerst een gesprek.');
    return;
  }
  sendWs({ type: 'generate_report' });
  generateReportBtn.disabled = true;
  generateReportBtn.textContent = 'Genereren...';
  setTimeout(() => {
    generateReportBtn.disabled = false;
    generateReportBtn.textContent = 'Genereer verslag';
  }, 20000);
});

copyReportBtn.addEventListener('click', () => {
  navigator.clipboard.writeText(reportContent.innerText).then(() => {
    copyReportBtn.textContent = 'Gekopieerd!';
    setTimeout(() => { copyReportBtn.textContent = 'Kopieer'; }, 2000);
  });
});

// ── Init ──────────────────────────────────────────────────────────────────

setMode('auto');
