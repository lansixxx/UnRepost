// UnRepost Dashboard Frontend Controller
let ws = null;
let appState = null;
let audioCtx = null;

// Sound Synthesizer for CAPTCHA alerts (No external MP3 required)
function playAlertTone(type = 'beep') {
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }

    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);

    if (type === 'captcha') {
      // 3 urgent warning pulses
      const now = audioCtx.currentTime;
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(659.25, now); // E5
      osc.frequency.setValueAtTime(880, now + 0.15); // A5
      osc.frequency.setValueAtTime(659.25, now + 0.3);

      gain.gain.setValueAtTime(0.15, now);
      gain.gain.exponentialRampToValueAtTime(0.01, now + 0.45);

      osc.start(now);
      osc.stop(now + 0.45);
    } else {
      // Gentle chime
      const now = audioCtx.currentTime;
      osc.type = 'sine';
      osc.frequency.setValueAtTime(587.33, now); // D5
      osc.frequency.exponentialRampToValueAtTime(880, now + 0.2); // A5

      gain.gain.setValueAtTime(0.1, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);

      osc.start(now);
      osc.stop(now + 0.3);
    }
  } catch (e) {
    console.warn('Audio synthesis error:', e);
  }
}

// WebSocket Connection Setup
function connectWebSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${protocol}//${window.location.host}`;
  const pill = document.getElementById('connection-pill');
  const connText = document.getElementById('connection-text');

  connText.textContent = 'Connecting...';
  pill.classList.remove('connected');

  ws = new WebSocket(url);

  ws.onopen = () => {
    connText.textContent = 'Connected to Engine';
    pill.classList.add('connected');
  };

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'STATE_UPDATE') {
        renderState(data.state);
      }
    } catch (e) {
      console.error('Failed to parse WebSocket message:', e);
    }
  };

  ws.onclose = () => {
    connText.textContent = 'Engine Offline (Reconnecting...)';
    pill.classList.remove('connected');
    setTimeout(connectWebSocket, 2000);
  };

  ws.onerror = () => {
    ws.close();
  };
}

// Send Action Command to Backend Engine
function sendAction(action) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(action));
  } else {
    // Fallback to REST API
    fetch('/api/action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(action)
    });
  }
}

// Main State Render Loop
let lastCaptchaAlertTime = 0;
function renderState(state) {
  appState = state;

  // 1. Account Info
  const user = state.user || {};
  const authBadge = document.getElementById('auth-badge');
  const userNick = document.getElementById('user-nickname');
  const userHandle = document.getElementById('user-handle');
  const userSecUid = document.getElementById('user-secuid');
  const userAvatar = document.getElementById('user-avatar');

  if (user.isLoggedIn) {
    authBadge.textContent = 'Signed In';
    authBadge.classList.add('signed-in');
    userNick.textContent = user.nickname || user.uniqueId;
    userHandle.textContent = `@${user.uniqueId}`;
    userSecUid.textContent = `SecUid: ${user.secUid.slice(0, 16)}...`;
    if (user.avatar) userAvatar.src = user.avatar;
    const btnLogout = document.getElementById('btn-logout');
    const btnScan = document.getElementById('btn-scan');
    if (btnLogout) btnLogout.style.display = 'inline-block';
    if (btnScan) btnScan.style.display = 'inline-block';
  } else {
    authBadge.textContent = 'Not Signed In';
    authBadge.classList.remove('signed-in');
    userNick.textContent = 'Not signed in';
    userHandle.textContent = 'Waiting for browser login';
    userSecUid.textContent = 'Please log into TikTok in the Chrome window';
    const btnLogout = document.getElementById('btn-logout');
    const btnScan = document.getElementById('btn-scan');
    if (btnLogout) btnLogout.style.display = 'none';
    if (btnScan) btnScan.style.display = 'none';
  }

  // 2. Status Notice Box & Controls
  const statusTag = document.getElementById('task-status-tag');
  const noticeBox = document.getElementById('notice-box');
  const noticeIcon = document.getElementById('notice-icon');
  const noticeTitle = document.getElementById('notice-title');
  const noticeDesc = document.getElementById('notice-desc');
  const confirmSection = document.getElementById('confirmation-section');
  const runningControls = document.getElementById('running-controls');
  const btnStart = document.getElementById('btn-start');
  const btnPause = document.getElementById('btn-pause');
  const btnPauseText = document.getElementById('btn-pause-text');
  const confirmCheck = document.getElementById('confirm-check');
  const cooldownWrapper = document.getElementById('cooldown-wrapper');
  const cooldownFill = document.getElementById('cooldown-fill');
  const cooldownLabel = document.getElementById('cooldown-label');

  statusTag.textContent = state.status;
  noticeDesc.textContent = state.statusMessage || '';

  // Clear previous notice classes
  noticeBox.className = 'notice-box';

  switch (state.status) {
    case 'WAITING_FOR_LOGIN':
      noticeBox.classList.add('status-waiting');
      noticeIcon.textContent = '🔐';
      noticeTitle.textContent = 'TikTok Sign-in Required';
      btnStart.disabled = true;
      confirmSection.style.display = 'block';
      runningControls.style.display = 'none';
      break;

    case 'READY_TO_START':
      noticeBox.classList.add('status-ready');
      noticeIcon.textContent = '✅';
      noticeTitle.textContent = 'Ready to Clean Reposts';
      btnStart.disabled = !confirmCheck.checked;
      confirmSection.style.display = 'block';
      runningControls.style.display = 'none';
      break;

    case 'RUNNING':
      noticeBox.classList.add('status-running');
      noticeIcon.textContent = '⚡';
      noticeTitle.textContent = 'Removing Reposts in Progress...';
      confirmSection.style.display = 'none';
      runningControls.style.display = 'grid';
      btnPauseText.textContent = 'Pause';
      break;

    case 'PAUSED':
      noticeBox.classList.add('status-waiting');
      noticeIcon.textContent = '⏸️';
      noticeTitle.textContent = 'Removal Paused';
      confirmSection.style.display = 'none';
      runningControls.style.display = 'grid';
      btnPauseText.textContent = 'Resume';
      break;

    case 'CAPTCHA_REQUIRED':
      noticeBox.classList.add('status-captcha');
      noticeIcon.textContent = '🚨';
      noticeTitle.textContent = 'CAPTCHA Challenge Detected!';
      noticeDesc.textContent = 'Please switch to the TikTok browser window and solve the verification slider or puzzle.';
      confirmSection.style.display = 'none';
      runningControls.style.display = 'grid';

      // Play sound alert once every 20 seconds
      if (Date.now() - lastCaptchaAlertTime > 20000) {
        lastCaptchaAlertTime = Date.now();
        playAlertTone('captcha');
      }
      break;

    case 'RATE_LIMITED':
      noticeBox.classList.add('status-ratelimit');
      noticeIcon.textContent = '⏳';
      noticeTitle.textContent = 'Rate Limit Cooldown';
      confirmSection.style.display = 'none';
      runningControls.style.display = 'grid';
      break;

    case 'VERIFYING':
      noticeBox.classList.add('status-ready');
      noticeIcon.textContent = '🔍';
      noticeTitle.textContent = 'Verifying with TikTok Servers...';
      confirmSection.style.display = 'none';
      runningControls.style.display = 'grid';
      break;

    case 'FINISHED':
      noticeBox.classList.add('status-finished');
      noticeIcon.textContent = '🎉';
      noticeTitle.textContent = 'Removal Complete & Verified!';
      confirmSection.style.display = 'block';
      runningControls.style.display = 'none';
      btnStart.disabled = false;
      playAlertTone('beep');
      break;

    default:
      noticeIcon.textContent = 'ℹ️';
      noticeTitle.textContent = state.status;
      break;
  }

  // Cooldown bar
  if (state.cooldownSeconds && state.cooldownSeconds > 0) {
    cooldownWrapper.style.display = 'block';
    cooldownLabel.textContent = `Rate limit cooldown: ${state.cooldownSeconds}s remaining`;
    cooldownFill.style.width = `${Math.min(100, (state.cooldownSeconds / 60) * 100)}%`;
  } else {
    cooldownWrapper.style.display = 'none';
  }

  // 3. Metrics
  const stats = state.stats || {};
  document.getElementById('metric-removed').textContent = stats.confirmedRemoved || 0;
  document.getElementById('metric-batch').textContent = stats.currentBatch || 0;
  document.getElementById('metric-skipped').textContent = stats.failedOrSkipped || 0;
  const elUnconfirmed = document.getElementById('metric-unconfirmed');
  if (elUnconfirmed) {
    elUnconfirmed.textContent = stats.unconfirmedOrRetrying || 0;
  }

  // Pre-scan summary banner
  const scanSummary = document.getElementById('scan-summary');
  if (scanSummary) {
    if (stats.totalDetected && stats.totalDetected > 0) {
      scanSummary.style.display = 'block';
      const elAcc = document.getElementById('confirm-account-name');
      const elCnt = document.getElementById('confirm-count');
      if (elAcc) elAcc.textContent = `@${user.uniqueId || 'you'}`;
      if (elCnt) elCnt.textContent = stats.totalDetected;
    } else {
      scanSummary.style.display = 'none';
    }
  }

  // 4. Current Item Processing View
  const itemEmpty = document.getElementById('item-empty');
  const itemActive = document.getElementById('item-active');
  const itemAuthor = document.getElementById('item-author');
  const itemDesc = document.getElementById('item-desc');
  const itemUrl = document.getElementById('item-url');

  if (state.currentItem) {
    itemEmpty.style.display = 'none';
    itemActive.style.display = 'flex';
    itemAuthor.textContent = state.currentItem.authorName || 'TikTok User';
    itemDesc.textContent = `"${state.currentItem.desc || '(no caption)'}"`;
    itemUrl.href = state.currentItem.url || '#';
  } else {
    itemEmpty.style.display = 'block';
    itemActive.style.display = 'none';
  }

  // 5. Settings update
  if (state.config) {
    const dryRunToggle = document.getElementById('dry-run-toggle');
    if (dryRunToggle.checked !== !!state.config.dryRun) {
      dryRunToggle.checked = !!state.config.dryRun;
    }
    const minSec = ((state.config.minDelayMs || 3000) / 1000).toFixed(1);
    const maxSec = ((state.config.maxDelayMs || 5500) / 1000).toFixed(1);
    document.getElementById('delay-label').textContent = `${minSec}s — ${maxSec}s`;
  }

  // 6. Logs Stream
  renderLogs(state.logs || []);
}

// Render Recent Activity Logs
function renderLogs(logs) {
  const container = document.getElementById('log-container');
  if (!logs || logs.length === 0) {
    container.innerHTML = '<div class="log-empty">Waiting for actions to record...</div>';
    return;
  }

  container.innerHTML = logs.map(log => {
    const time = new Date(log.timestamp).toLocaleTimeString();
    return `
      <div class="log-entry type-${escapeHtml(log.type)}">
        <span class="log-time">${time}</span>
        <span class="log-badge">${escapeHtml(log.type)}</span>
        <span class="log-msg">${escapeHtml(log.message)}</span>
      </div>
    `;
  }).join('');
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// UI Event Handlers
document.addEventListener('DOMContentLoaded', () => {
  connectWebSocket();

  const confirmCheck = document.getElementById('confirm-check');
  const btnStart = document.getElementById('btn-start');
  const btnPause = document.getElementById('btn-pause');
  const btnStop = document.getElementById('btn-stop');
  const btnScan = document.getElementById('btn-scan');
  const btnLogout = document.getElementById('btn-logout');
  const dryRunToggle = document.getElementById('dry-run-toggle');
  const btnResetHistory = document.getElementById('btn-reset-history');
  const btnTestSound = document.getElementById('btn-test-sound');
  const btnClearLog = document.getElementById('btn-clear-log');
  const btnExportCsv = document.getElementById('btn-export-csv');
  const btnExportJson = document.getElementById('btn-export-json');

  if (btnScan) {
    btnScan.addEventListener('click', () => {
      sendAction({ type: 'SCAN_ONLY' });
    });
  }

  if (btnLogout) {
    btnLogout.addEventListener('click', () => {
      if (confirm('Are you sure you want to sign out and clear your saved session cookies from this computer?')) {
        sendAction({ type: 'LOGOUT', clearFiles: true });
      }
    });
  }

  confirmCheck.addEventListener('change', () => {
    if (appState && appState.user && appState.user.isLoggedIn) {
      btnStart.disabled = !confirmCheck.checked;
    }
  });

  btnStart.addEventListener('click', () => {
    if (!confirmCheck.checked) {
      alert('Please check the confirmation box first.');
      return;
    }
    sendAction({ type: 'CONFIRM_START' });
  });

  btnPause.addEventListener('click', () => {
    if (appState && appState.status === 'PAUSED') {
      sendAction({ type: 'RESUME' });
    } else {
      sendAction({ type: 'PAUSE' });
    }
  });

  btnStop.addEventListener('click', () => {
    if (confirm('Are you sure you want to stop the tool? Your progress has been saved.')) {
      sendAction({ type: 'STOP' });
    }
  });

  dryRunToggle.addEventListener('change', () => {
    sendAction({
      type: 'UPDATE_CONFIG',
      config: { dryRun: dryRunToggle.checked }
    });
  });

  btnResetHistory.addEventListener('click', () => {
    if (confirm('Reset tracked removed IDs? This allows re-checking previously removed reposts.')) {
      sendAction({ type: 'CLEAR_HISTORY' });
    }
  });

  btnTestSound.addEventListener('click', () => {
    playAlertTone('captcha');
  });

  btnClearLog.addEventListener('click', () => {
    document.getElementById('log-container').innerHTML = '<div class="log-empty">Log view cleared.</div>';
  });

  btnExportCsv.addEventListener('click', () => {
    if (confirm('Privacy Notice: This export contains the list of removed video IDs and audit logs stored during this session.\n\nEnsure you do not share this file publicly if you want to keep your account activity private.\n\nDownload CSV file?')) {
      window.location.href = '/api/export?format=csv';
    }
  });

  btnExportJson.addEventListener('click', () => {
    if (confirm('Privacy Notice: This export contains the list of removed video IDs and audit logs stored during this session.\n\nEnsure you do not share this file publicly if you want to keep your account activity private.\n\nDownload JSON file?')) {
      window.location.href = '/api/export?format=json';
    }
  });
});

