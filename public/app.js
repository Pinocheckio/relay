/**
 * Relay — client-side audio capture, WebSocket relay, TTS playback, UI logic.
 * v3: Deepgram STT migration + test mode (audio + text tiers).
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
const normalSetup               = document.getElementById('normal-setup');
const testSetup                 = document.getElementById('test-setup');
const btnTestToggle             = document.getElementById('btn-test-toggle');

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

// ── Test mode onboarding ──────────────────────────────────────────────────

let isTestMode = false;
let testScript = null;
let testModeType = 'text'; // 'audio' | 'text'
let testTtsPlayback = true;

const testParticipantList  = document.getElementById('test-participant-list');
const testScriptTitle      = document.getElementById('test-script-title');
const btnStartTest         = document.getElementById('btn-start-test');
const btnLoadExample       = document.getElementById('btn-load-example');
const testDropZone         = document.getElementById('test-drop-zone');
const testFileInput        = document.getElementById('test-file-input');
const btnTestModeText      = document.getElementById('btn-test-mode-text');
const btnTestModeAudio     = document.getElementById('btn-test-mode-audio');
const btnTestTts           = document.getElementById('btn-test-tts');

btnTestToggle.addEventListener('click', () => {
  isTestMode = !isTestMode;
  btnTestToggle.classList.toggle('active', isTestMode);
  normalSetup.classList.toggle('hidden', isTestMode);
  testSetup.classList.toggle('hidden', !isTestMode);
});

[btnTestModeText, btnTestModeAudio].forEach(btn => {
  btn.addEventListener('click', () => {
    testModeType = btn.dataset.mode;
    btnTestModeText.classList.toggle('active', testModeType === 'text');
    btnTestModeAudio.classList.toggle('active', testModeType === 'audio');
  });
});

btnTestTts.addEventListener('click', () => {
  testTtsPlayback = !testTtsPlayback;
  btnTestTts.textContent = testTtsPlayback ? 'aan' : 'uit';
  btnTestTts.classList.toggle('active', testTtsPlayback);
});

function loadTestScript(data) {
  try {
    testScript = typeof data === 'string' ? JSON.parse(data) : data;
  } catch {
    alert('Ongeldig JSON bestand.');
    return;
  }
  testScriptTitle.textContent = `"${testScript.title}" — ${testScript.lines.length} regels`;
  renderTestParticipantList(testScript.participants);
  btnStartTest.disabled = false;
}

function renderTestParticipantList(participants) {
  testParticipantList.innerHTML = '';
  participants.forEach((p, i) => {
    const color = getParticipantColor(i);
    const row = document.createElement('div');
    row.className = 'onboarding-participant-row';
    row.innerHTML = `
      <span class="onboarding-participant-dot" style="background:${color.accent}"></span>
      <span class="onboarding-participant-name">${escapeHtml(p.name)}</span>
      <span class="onboarding-participant-meta">${escapeHtml(ROLE_LABELS[p.role] ?? p.role)} · ${getLangLabel(p.language)}</span>
    `;
    testParticipantList.appendChild(row);
  });
}

btnLoadExample.addEventListener('click', () => {
  fetch('/test-scripts/intake-benhaddou.json')
    .then(r => r.json())
    .then(data => loadTestScript(data))
    .catch(() => alert('Voorbeeld kon niet worden geladen.'));
});

testDropZone.addEventListener('click', () => testFileInput.click());
testDropZone.addEventListener('dragover', (e) => { e.preventDefault(); testDropZone.classList.add('dragover'); });
testDropZone.addEventListener('dragleave', () => testDropZone.classList.remove('dragover'));
testDropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  testDropZone.classList.remove('dragover');
  const file = e.dataTransfer?.files[0];
  if (file) readTestFile(file);
});
testFileInput.addEventListener('change', () => {
  if (testFileInput.files[0]) readTestFile(testFileInput.files[0]);
});

function readTestFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => loadTestScript(e.target.result);
  reader.readAsText(file);
}

btnStartTest.addEventListener('click', () => {
  if (!testScript) return;
  onboardingOverlay.classList.add('hidden');
  startTestSession();
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
let isActiveTestMode = false; // true during a live test session

// Server-synced participant state
let participants = []; // full Participant[] from server

// TTS playback queue
const ttsChunks = [];
const AUDIO_QUEUE = [];
let audioQueueRunning = false;

// Map of entryId -> DOM element for in-place updates
const entryElements = new Map();

// ── DOM refs ──────────────────────────────────────────────────────────────

const transcriptEl          = document.getElementById('transcript');
const partialEl             = document.getElementById('partial-text');
const statusEl              = document.getElementById('status-text');
const langEl                = document.getElementById('lang-detected');
const modeAutoBtn           = document.getElementById('btn-mode-auto');
const modeManuBtn           = document.getElementById('btn-mode-manual');
const pttABtn               = document.getElementById('btn-ptt-a');
const pttBBtn               = document.getElementById('btn-ptt-b');
const pttALabel             = document.getElementById('ptt-a-label');
const pttBLabel             = document.getElementById('ptt-b-label');
const pttControls           = document.getElementById('ptt-controls');
const generateReportBtn     = document.getElementById('btn-generate-report');
const correctionPopover     = document.getElementById('correction-popover');
const correctionParticipantBtns = document.getElementById('correction-participant-btns');
const correctionLangBtns    = document.getElementById('correction-lang-btns');
const reportPanel           = document.getElementById('report-panel');
const reportContent         = document.getElementById('report-content');
const copyReportBtn         = document.getElementById('btn-copy-report');
const ttsIndicator          = document.getElementById('tts-indicator');
const disconnectBtn         = document.getElementById('btn-disconnect');
const newConversationBtn    = document.getElementById('btn-new-conversation');
const participantPanel      = document.getElementById('participant-panel');
const participantChipsEl    = document.getElementById('participant-chips');
const btnAddMid             = document.getElementById('btn-add-mid');
const midSessionForm        = document.getElementById('mid-session-form');
const midParticipantForm    = document.getElementById('mid-participant-form');
const midPNameInput         = document.getElementById('mid-p-name');
const midPRoleSelect        = document.getElementById('mid-p-role');
const midPLangSelect        = document.getElementById('mid-p-lang');
const btnCancelMid          = document.getElementById('btn-cancel-mid');
const levelFill             = document.getElementById('level-fill');
const levelStatus           = document.getElementById('level-status');
const testControlBar        = document.getElementById('test-control-bar');
const btnTestReset          = document.getElementById('btn-test-reset');
const btnTestPlay           = document.getElementById('btn-test-play');
const btnTestStep           = document.getElementById('btn-test-step');
const testProgressText      = document.getElementById('test-progress-text');
const testProgressFill      = document.getElementById('test-progress-fill');
const testCurrentLine       = document.getElementById('test-current-line');
const btnTestTtsLive        = document.getElementById('btn-test-tts-live');
const testAccuracyPanel     = document.getElementById('test-accuracy-panel');
const testAccuracyContent   = document.getElementById('test-accuracy-content');

let lastLevelUpdate = 0;
let isTestPlaying = false;

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

// ── Conversation start (normal mode) ──────────────────────────────────────

function startConversation() {
  isActiveTestMode = false;
  participantPanel.classList.remove('hidden');
  newConversationBtn.classList.remove('hidden');
  disconnectBtn.classList.remove('hidden');
  transcriptEl.innerHTML = '';
  reportPanel.classList.add('hidden');
  reportContent.innerHTML = '';
  testControlBar.classList.add('hidden');
  testAccuracyPanel.classList.add('hidden');

  connectWs(() => {
    sendWs({ type: 'start_session', participants: onboardingParticipants });
    startRecording();
  });
}

// ── Test session start ────────────────────────────────────────────────────

function startTestSession() {
  isActiveTestMode = true;
  isTestPlaying = false;
  participantPanel.classList.remove('hidden');
  newConversationBtn.classList.remove('hidden');
  disconnectBtn.classList.remove('hidden');
  transcriptEl.innerHTML = '';
  reportPanel.classList.add('hidden');
  testAccuracyPanel.classList.add('hidden');
  testControlBar.classList.remove('hidden');

  updateTestControls(false);

  connectWs(() => {
    sendWs({
      type: 'start_test_mode',
      script: testScript,
      mode: testModeType,
      ttsPlayback: testTtsPlayback,
    });
    // No mic recording in test mode — audio comes from the server's TTS generation
  });
}

function resetConversation() {
  disconnectWs();
  levelFill.style.width = '0%';
  levelStatus.textContent = '';

  // Reset state
  participants = [];
  onboardingParticipants = [];
  entryElements.clear();
  isActiveTestMode = false;
  isTestPlaying = false;
  testScript = null;

  // Reset UI
  transcriptEl.innerHTML = '<p class="transcript-placeholder">Klik op <strong>Verbinden</strong> om het gesprek te starten.</p>';
  partialEl.textContent = '';
  participantChipsEl.innerHTML = '';
  participantPanel.classList.add('hidden');
  midSessionForm.classList.add('hidden');
  reportPanel.classList.add('hidden');
  reportContent.innerHTML = '';
  testControlBar.classList.add('hidden');
  testAccuracyPanel.classList.add('hidden');
  newConversationBtn.classList.add('hidden');
  disconnectBtn.classList.add('hidden');
  setStatus('Niet verbonden');
  langEl.textContent = '—';

  // Reset onboarding
  pNameInput.value = '';
  testScript = null;
  testScriptTitle.textContent = '';
  testParticipantList.innerHTML = '';
  btnStartTest.disabled = true;
  renderOnboardingList();
  updateStartButton();
  isTestMode = false;
  btnTestToggle.classList.remove('active');
  normalSetup.classList.remove('hidden');
  testSetup.classList.add('hidden');

  onboardingOverlay.classList.remove('hidden');
}

disconnectBtn.addEventListener('click', () => {
  disconnectWs();
  levelFill.style.width = '0%';
  levelStatus.textContent = '';
});

newConversationBtn.addEventListener('click', resetConversation);

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

    // ── Test mode messages ──────────────────────────────────────────────

    case 'test_ready':
      setStatus(`Testscript geladen: "${msg.title}" — ${msg.lineCount} regels. Klik ▶ om te starten.`);
      updateTestProgress(0, msg.lineCount, null);
      break;

    case 'test_progress':
      updateTestProgress(msg.lineIndex, msg.totalLines, msg.currentLine);
      break;

    case 'test_accuracy':
      appendTestAccuracy(msg);
      break;

    case 'test_complete':
      showTestSummary(msg.summary);
      updateTestControls(false);
      isTestPlaying = false;
      btnTestPlay.textContent = '▶';
      break;

    case 'test_narration':
      appendTestNarration(msg.description);
      break;

    case 'test_audio_stop':
      stopAllAudio();
      break;
  }
}

// ── Test mode UI helpers ──────────────────────────────────────────────────

function updateTestProgress(lineIndex, totalLines, currentLine) {
  testProgressText.textContent = `Regel ${lineIndex}/${totalLines}`;
  const pct = totalLines > 0 ? (lineIndex / totalLines) * 100 : 0;
  testProgressFill.style.width = `${pct}%`;

  if (currentLine && currentLine.type === 'speech') {
    const preview = currentLine.text.length > 50 ? currentLine.text.slice(0, 50) + '…' : currentLine.text;
    testCurrentLine.textContent = `${currentLine.speaker} (${getLangLabel(currentLine.language)}): "${preview}"`;
  } else if (currentLine && currentLine.type === 'action') {
    testCurrentLine.textContent = `[actie] ${currentLine.description}`;
  } else if (currentLine && currentLine.type === 'pause') {
    testCurrentLine.textContent = `[pauze ${currentLine.durationMs}ms]`;
  } else {
    testCurrentLine.textContent = '';
  }
}

function updateTestControls(playing) {
  btnTestPlay.textContent = playing ? '⏸' : '▶';
}

function appendTestNarration(description) {
  const el = document.createElement('div');
  el.className = 'test-narration';
  el.textContent = description;
  transcriptEl.appendChild(el);
  transcriptEl.scrollTop = transcriptEl.scrollHeight;
}

function appendTestAccuracy(result) {
  testAccuracyPanel.classList.remove('hidden');
  const pct = Math.round(result.textSimilarity * 100);
  const langOk = result.languageMatch ? '✓' : '✗';
  const row = document.createElement('div');
  row.className = `test-accuracy-row ${pct >= 70 ? 'ok' : 'warn'}`;
  row.innerHTML = `
    <span class="acc-speaker">${escapeHtml(result.expected.speaker)}</span>
    <span class="acc-pct">${pct}%</span>
    <span class="acc-lang">${langOk} ${escapeHtml(result.expected.language)}</span>
    <span class="acc-text" title="${escapeHtml(result.actual.text)}">${escapeHtml(result.actual.text.slice(0, 40))}${result.actual.text.length > 40 ? '…' : ''}</span>
  `;
  testAccuracyContent.appendChild(row);
}

function showTestSummary(summary) {
  testAccuracyPanel.classList.remove('hidden');
  const avgPct = Math.round(summary.avgTextSimilarity * 100);
  const langPct = Math.round(summary.languageAccuracy * 100);
  const div = document.createElement('div');
  div.className = 'test-accuracy-summary';
  div.innerHTML = `
    <strong>Samenvatting:</strong>
    Tekst nauwkeurigheid: ${avgPct}% |
    Taalherkenning: ${langPct}% |
    ${summary.totalLines} regels verwerkt
  `;
  testAccuracyContent.appendChild(div);
  testAccuracyPanel.scrollIntoView({ behavior: 'smooth' });
}

// ── Test control bar event listeners ─────────────────────────────────────

btnTestPlay.addEventListener('click', () => {
  if (!ws) return;
  isTestPlaying = !isTestPlaying;
  updateTestControls(isTestPlaying);
  sendWs({ type: 'test_control', action: isTestPlaying ? 'play' : 'pause' });
});

btnTestStep.addEventListener('click', () => {
  if (!ws) return;
  isTestPlaying = false;
  updateTestControls(false);
  sendWs({ type: 'test_control', action: 'step' });
});

btnTestReset.addEventListener('click', () => {
  if (!ws) return;
  isTestPlaying = false;
  updateTestControls(false);
  stopAllAudio();
  transcriptEl.innerHTML = '';
  entryElements.clear();
  testAccuracyContent.innerHTML = '';
  testAccuracyPanel.classList.add('hidden');
  sendWs({ type: 'test_control', action: 'reset' });
});

document.querySelectorAll('.btn-speed').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.btn-speed').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    sendWs({ type: 'test_control', action: 'speed', speed: Number(btn.dataset.speed) });
  });
});

btnTestTtsLive.addEventListener('click', () => {
  const enabled = btnTestTtsLive.textContent !== 'TTS: aan';
  btnTestTtsLive.textContent = enabled ? 'TTS: aan' : 'TTS: uit';
  btnTestTtsLive.classList.toggle('active', enabled);
  sendWs({ type: 'test_control', action: 'tts_toggle', ttsEnabled: enabled });
});

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

  correctionLangBtns.innerHTML = '';
  const activeLangs = [...new Set(participants.map(p => p.language))];
  activeLangs.forEach(code => {
    const btn = document.createElement('button');
    btn.className = 'correction-lang-btn' + (code === currentLang ? ' current' : '');
    btn.textContent = getLangLabel(code);
    btn.addEventListener('click', (e) => { e.stopPropagation(); applyLangCorrection(entryEl, code); });
    correctionLangBtns.appendChild(btn);
  });

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
// With Deepgram server-side VAD (endpointing:300), the manual_commit is gone.
// Client-side VAD only manages UI feedback and bandwidth pre-filtering.

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
        // Deepgram handles endpointing server-side; no manual_commit needed
        if (vadSpeaking) vadSpeaking = false;
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
  currentAudio = audio;
  audio.play().catch(() => {});
  audio.onended = () => {
    currentAudio = null;
    URL.revokeObjectURL(url);
    drainAudioQueue();
  };
}

let currentAudio = null;

function stopAllAudio() {
  if (currentAudio) {
    currentAudio.pause();
    currentAudio.onended = null;
    currentAudio = null;
  }
  for (const { audio, url } of AUDIO_QUEUE.splice(0)) {
    URL.revokeObjectURL(url);
  }
  ttsChunks.length = 0;
  audioQueueRunning = false;
  ttsIndicator.classList.remove('active');
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
  // No manual_commit: Deepgram endpoints via silence detection
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
