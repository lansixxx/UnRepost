const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { chromium } = require('playwright-core');

// Constants & Networking
const PORT = parseInt(process.env.PORT, 10) || 3210;
const HOST = '127.0.0.1';

// Resolve Data & Session Storage Locations
function resolveAppPaths() {
  // 1. Explicit override via environment variable
  const envDir = process.env.UNREPOST_DATA_DIR || process.env.CLEARTOK_DATA_DIR;
  if (envDir) {
    const customDir = path.resolve(envDir);
    try { fs.mkdirSync(customDir, { recursive: true, mode: 0o700 }); } catch (e) {}
    return {
      dataDir: customDir,
      userDataDir: path.join(customDir, 'tiktok_session_data'),
      stateFile: path.join(customDir, 'unrepost_state.json')
    };
  }

  // 2. Portable mode or existing local workspace session
  const localSessionDir = path.join(__dirname, 'tiktok_session_data');
  const localStateFile = path.join(__dirname, 'unrepost_state.json');
  const legacyLocalState = path.join(__dirname, 'cleartok_state.json');
  if (process.env.UNREPOST_PORTABLE === 'true' || process.env.CLEARTOK_PORTABLE === 'true' || fs.existsSync(localSessionDir)) {
    return {
      dataDir: __dirname,
      userDataDir: localSessionDir,
      stateFile: fs.existsSync(localStateFile) ? localStateFile : (fs.existsSync(legacyLocalState) ? legacyLocalState : localStateFile)
    };
  }

  // 3. Standard OS User Application Support Directory
  const home = os.homedir();
  let baseDir;
  if (process.platform === 'darwin') {
    baseDir = path.join(home, 'Library', 'Application Support', 'UnRepost');
  } else if (process.platform === 'win32') {
    baseDir = path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'UnRepost');
  } else {
    baseDir = path.join(home, '.config', 'unrepost');
  }

  try { fs.mkdirSync(baseDir, { recursive: true, mode: 0o700 }); } catch (e) {}

  let statePath = path.join(baseDir, 'unrepost_state.json');
  if (!fs.existsSync(statePath) && fs.existsSync(path.join(baseDir, 'cleartok_state.json'))) {
    statePath = path.join(baseDir, 'cleartok_state.json');
  }

  return {
    dataDir: baseDir,
    userDataDir: path.join(baseDir, 'tiktok_session_data'),
    stateFile: statePath
  };
}

const { dataDir: APP_DATA_DIR, userDataDir: USER_DATA_DIR, stateFile: STATE_FILE } = resolveAppPaths();

// Helper to find Chrome / Chromium executable cross-platform
function findChromeExecutable() {
  const home = os.homedir();
  const candidates = [];

  if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      path.join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      path.join(home, 'Applications/Brave Browser.app/Contents/MacOS/Brave Browser')
    );
  } else if (process.platform === 'win32') {
    const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    candidates.push(
      path.join(programFiles, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(programFilesX86, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(localAppData, 'Google\\Chrome\\Application\\chrome.exe'),
      path.join(programFiles, 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'),
      path.join(programFilesX86, 'Microsoft\\Edge\\Application\\msedge.exe')
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/usr/bin/brave-browser'
    );
  }

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return c;
    }
  }

  // Check Playwright default cache dynamically
  const cacheBase = process.platform === 'darwin'
    ? path.join(home, 'Library/Caches/ms-playwright')
    : path.join(home, '.cache/ms-playwright');

  if (fs.existsSync(cacheBase)) {
    try {
      const dirs = fs.readdirSync(cacheBase);
      for (const d of dirs) {
        if (d.startsWith('chromium-')) {
          const appPathArm = path.join(cacheBase, d, 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing');
          if (fs.existsSync(appPathArm)) return appPathArm;
          const appPathX64 = path.join(cacheBase, d, 'chrome-mac/Chromium.app/Contents/MacOS/Chromium');
          if (fs.existsSync(appPathX64)) return appPathX64;
          const linuxPath = path.join(cacheBase, d, 'chrome-linux/chrome');
          if (fs.existsSync(linuxPath)) return linuxPath;
        }
      }
    } catch (e) {}
  }

  return null;
}

// Initial State Manager
class StateManager {
  constructor() {
    this.data = {
      status: 'STARTING', // STARTING, WAITING_FOR_LOGIN, READY_TO_START, RUNNING, PAUSED, CAPTCHA_REQUIRED, RATE_LIMITED, VERIFYING, FINISHED, STOPPED
      statusMessage: 'Initializing browser engine...',
      user: {
        isLoggedIn: false,
        uniqueId: '',
        nickname: '',
        secUid: '',
        avatar: '',
        csrfToken: ''
      },
      stats: {
        confirmedRemoved: 0,
        failedOrSkipped: 0,
        unconfirmedOrRetrying: 0,
        totalDetected: 0,
        queuedRemaining: 0,
        currentBatch: 0,
        startedAt: null,
        elapsedSeconds: 0
      },
      currentItem: null,
      cooldownSeconds: 0,
      config: {
        minDelayMs: 3500,
        maxDelayMs: 6000,
        dryRun: false,
        batchSize: 30
      },
      removedIds: [],
      failedIds: [],
      logs: []
    };
  }

  load() {
    try {
      if (fs.existsSync(STATE_FILE)) {
        const raw = fs.readFileSync(STATE_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        if (parsed.removedIds) this.data.removedIds = parsed.removedIds;
        if (parsed.failedIds) this.data.failedIds = parsed.failedIds;
        if (parsed.stats) {
          if (parsed.stats.confirmedRemoved) this.data.stats.confirmedRemoved = parsed.removedIds.length;
          if (parsed.stats.failedOrSkipped) this.data.stats.failedOrSkipped = parsed.stats.failedOrSkipped;
          if (parsed.stats.unconfirmedOrRetrying) this.data.stats.unconfirmedOrRetrying = parsed.stats.unconfirmedOrRetrying;
          if (parsed.stats.totalDetected) this.data.stats.totalDetected = parsed.stats.totalDetected;
        }
        if (parsed.config) this.data.config = { ...this.data.config, ...parsed.config };
        this.log('system', `Loaded saved state: ${this.data.removedIds.length} previously removed reposts tracked.`);
      }
    } catch (err) {
      console.error('Failed to load state file:', err.message);
    }
  }

  save() {
    try {
      const toSave = {
        savedAt: new Date().toISOString(),
        removedIds: this.data.removedIds,
        failedIds: this.data.failedIds,
        stats: {
          confirmedRemoved: this.data.stats.confirmedRemoved,
          failedOrSkipped: this.data.stats.failedOrSkipped,
          unconfirmedOrRetrying: this.data.stats.unconfirmedOrRetrying || 0,
          totalDetected: this.data.stats.totalDetected || 0
        },
        config: this.data.config
      };
      fs.writeFileSync(STATE_FILE, JSON.stringify(toSave, null, 2), 'utf8');
    } catch (err) {
      console.error('Failed to write state file:', err.message);
    }
  }

  log(type, message, details = null) {
    const entry = {
      id: Date.now().toString(36) + Math.random().toString(36).substr(2, 5),
      timestamp: new Date().toISOString(),
      type, // 'info', 'success', 'warning', 'error', 'system'
      message,
      details
    };
    this.data.logs.unshift(entry);
    if (this.data.logs.length > 200) this.data.logs.pop();
    if (typeof broadcastState === 'function') {
      broadcastState();
    }
    return entry;
  }

  recordRemoval(id, author, desc) {
    if (!this.data.removedIds.includes(id)) {
      this.data.removedIds.push(id);
      this.data.stats.confirmedRemoved = this.data.removedIds.length;
    }
    this.log('success', `Removed repost from ${author}: "${(desc || '').slice(0, 45)}..."`, { id, author });
    this.save();
  }

  recordFailure(id, author, reason) {
    if (!this.data.failedIds.includes(id)) {
      this.data.failedIds.push(id);
      this.data.stats.failedOrSkipped = this.data.failedIds.length;
    }
    this.log('warning', `Skipped/Failed repost ${id} (${author}): ${reason}`, { id, author, reason });
    this.save();
  }

  recordUnconfirmed(id, author, reason) {
    this.data.stats.unconfirmedOrRetrying = (this.data.stats.unconfirmedOrRetrying || 0) + 1;
    this.log('warning', `Unconfirmed removal on repost ${id} (${author}): ${reason}. Cooldown initiated.`);
    broadcastState();
  }
}

// Security: Enforce Loopback Only and Protect Against Cross-Origin Attacks
function validateLoopbackRequest(req, res, next) {
  const host = req.headers['host'] || '';
  const origin = req.headers['origin'];
  const referer = req.headers['referer'];

  const isValidHost = host.startsWith('127.0.0.1') || host.startsWith('localhost');
  if (!isValidHost) {
    return res.status(403).json({ error: 'Access denied: Loopback only (127.0.0.1)' });
  }

  if (origin) {
    try {
      const u = new URL(origin);
      if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
        return res.status(403).json({ error: 'CSRF protection: Invalid request origin' });
      }
    } catch (e) {
      return res.status(403).json({ error: 'CSRF protection: Malformed origin' });
    }
  }

  if (referer) {
    try {
      const u = new URL(referer);
      if (u.hostname !== 'localhost' && u.hostname !== '127.0.0.1') {
        return res.status(403).json({ error: 'CSRF protection: Invalid referer' });
      }
    } catch (e) {
      return res.status(403).json({ error: 'CSRF protection: Malformed referer' });
    }
  }

  next();
}

// Express & WebSocket Server setup
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.json());
app.use('/api', validateLoopbackRequest);
app.use(express.static(path.join(__dirname, 'public')));

function broadcastState() {
  if (typeof state === 'undefined' || !state || !state.data) return;
  if (typeof wss === 'undefined' || !wss || !wss.clients) return;
  const payload = JSON.stringify({ type: 'STATE_UPDATE', state: state.data });
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(payload);
  });
}

const state = new StateManager();
state.load();

wss.on('connection', (ws) => {
  ws.send(JSON.stringify({ type: 'STATE_UPDATE', state: state.data }));
  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      handleClientAction(data);
    } catch (e) {}
  });
});

// Playwright Controller & Worker
let browserContext = null;
let tiktokPage = null;
let isWorkerRunning = false;
let shouldPause = false;
let shouldStop = false;

async function initBrowser() {
  const chromePath = findChromeExecutable();
  state.log('system', chromePath ? `Using browser: ${chromePath}` : 'Using bundled Chromium launcher...');

  try {
    const launchOptions = {
      headless: false,
      viewport: { width: 1280, height: 860 },
      args: [
        '--disable-blink-features=AutomationControlled',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-features=IsolateOrigins,site-per-process'
      ]
    };
    if (chromePath) {
      launchOptions.executablePath = chromePath;
    }

    browserContext = await chromium.launchPersistentContext(USER_DATA_DIR, launchOptions);

    const pages = browserContext.pages();
    tiktokPage = pages.length > 0 ? pages[0] : await browserContext.newPage();

    // Stealth: hide navigator.webdriver
    await tiktokPage.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });

    state.log('system', 'Opening TikTok in browser window...');
    try {
      await tiktokPage.goto('https://www.tiktok.com/profile', { waitUntil: 'domcontentloaded', timeout: 60000 });
    } catch (navErr) {
      state.log('warning', `Initial navigation slow, retrying with tiktok.com... (${navErr.message})`);
      try {
        await tiktokPage.goto('https://www.tiktok.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
      } catch (navErr2) {
        state.log('warning', `Navigation to tiktok.com also slow: ${navErr2.message}. The browser is open — you can navigate manually.`);
      }
    }

    state.data.status = 'WAITING_FOR_LOGIN';
    state.data.statusMessage = 'Please log into your TikTok account in the opened browser window.';
    state.log('info', 'Waiting for user login on TikTok...');
    broadcastState();

    startAuthMonitor();
  } catch (err) {
    state.data.status = 'ERROR';
    state.data.statusMessage = `Failed to launch browser: ${err.message}`;
    state.log('error', `Browser launch error: ${err.message}`);
    broadcastState();
  }
}

// Authentication Monitor
let authMonitorInterval = null;
function startAuthMonitor() {
  if (authMonitorInterval) clearInterval(authMonitorInterval);

  authMonitorInterval = setInterval(async () => {
    if (!tiktokPage || tiktokPage.isClosed()) return;

    try {
      const ctx = await extractTikTokContext(tiktokPage);
      if (ctx && ctx.isLoggedIn && ctx.secUid) {
        state.data.user = {
          isLoggedIn: true,
          uniqueId: ctx.uniqueId || 'me',
          nickname: ctx.nickname || ctx.uniqueId || 'TikTok User',
          secUid: ctx.secUid,
          avatar: ctx.avatar || '',
          csrfToken: ctx.csrfToken || ''
        };

        if (state.data.status === 'WAITING_FOR_LOGIN' || state.data.status === 'STARTING') {
          state.data.status = 'READY_TO_START';
          state.data.statusMessage = `Signed in as @${state.data.user.uniqueId}. Awaiting your confirmation to start removing reposts.`;
          state.log('success', `Signed in as @${state.data.user.uniqueId} (${state.data.user.nickname}). Ready to start!`);
          broadcastState();
        }
      } else {
        if (state.data.status !== 'WAITING_FOR_LOGIN' && !isWorkerRunning) {
          state.data.user.isLoggedIn = false;
          state.data.status = 'WAITING_FOR_LOGIN';
          state.data.statusMessage = 'Not logged in. Please sign in to TikTok in the browser window.';
          broadcastState();
        }
      }
    } catch (e) {
      // Ignore evaluation errors while navigating
    }
  }, 2500);
}

// Context extractor inside the TikTok page
async function extractTikTokContext(page) {
  return await page.evaluate(() => {
    let secUid = null;
    let uniqueId = null;
    let nickname = null;
    let avatar = null;
    let csrfToken = null;

    // 1. Try __UNIVERSAL_DATA_FOR_REHYDRATION__ script tag
    try {
      const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
      if (el && el.textContent) {
        const d = JSON.parse(el.textContent);
        const appCtx = d?.__DEFAULT_SCOPE__?.['webapp.app-context'];
        if (appCtx) {
          csrfToken = appCtx.csrfToken || csrfToken;
          if (appCtx.user) {
            secUid = appCtx.user.secUid || secUid;
            uniqueId = appCtx.user.uniqueId || uniqueId;
            nickname = appCtx.user.nickname || nickname;
            avatar = appCtx.user.avatarThumb || appCtx.user.avatarMedium || avatar;
          }
        }
        if (!secUid && d?.__DEFAULT_SCOPE__?.['webapp.user-detail']) {
          const u = d.__DEFAULT_SCOPE__['webapp.user-detail'].userInfo?.user;
          if (u) {
            secUid = u.secUid || secUid;
            uniqueId = u.uniqueId || uniqueId;
            nickname = u.nickname || nickname;
          }
        }
      }
    } catch (e) {}

    // 2. Try window.__$UNIVERSAL_DATA$__
    try {
      if (!secUid && window.__$UNIVERSAL_DATA$__?.__DEFAULT_SCOPE__) {
        const appCtx = window.__$UNIVERSAL_DATA$.__DEFAULT_SCOPE__['webapp.app-context'];
        if (appCtx) {
          csrfToken = appCtx.csrfToken || csrfToken;
          if (appCtx.user) {
            secUid = appCtx.user.secUid || secUid;
            uniqueId = appCtx.user.uniqueId || uniqueId;
            nickname = appCtx.user.nickname || nickname;
            avatar = appCtx.user.avatarThumb || avatar;
          }
        }
      }
    } catch (e) {}

    // 3. Try SIGI_STATE
    try {
      if (!secUid && window.SIGI_STATE) {
        const userModule = window.SIGI_STATE.UserModule;
        if (userModule && userModule.users) {
          const myId = window.SIGI_STATE.AppContext?.appContext?.user?.id;
          const u = myId ? userModule.users[myId] : Object.values(userModule.users)[0];
          if (u) {
            secUid = u.secUid || secUid;
            uniqueId = u.uniqueId || uniqueId;
            nickname = u.nickname || nickname;
          }
        }
      }
    } catch (e) {}

    // 4. Try document cookies for CSRF token
    try {
      if (!csrfToken) {
        const match = document.cookie.match(/(?:^|;\s*)csrf_session_id=([^;]+)/);
        if (match) csrfToken = match[1];
      }
    } catch (e) {}

    return {
      isLoggedIn: !!secUid,
      secUid,
      uniqueId,
      nickname,
      avatar,
      csrfToken
    };
  });
}

// Check for CAPTCHA / Verification challenge in DOM
async function isCaptchaVisible(page) {
  try {
    return await page.evaluate(() => {
      const captchaSelectors = [
        '#captcha-verify-image',
        '.captcha-verify-container',
        '.captcha_verify_container',
        '[data-e2e="captcha-verify-container"]',
        '.secsdk-captcha-drag-icon',
        '#secsdk-captcha-drag-wrapper',
        '.verify-wrap'
      ];
      for (const sel of captchaSelectors) {
        const el = document.querySelector(sel);
        if (el && el.offsetParent !== null) return true;
      }
      return false;
    });
  } catch (e) {
    return false;
  }
}

const MOBILE_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

async function getSessionHeaders(context) {
  try {
    const cookies = await context.cookies();
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const csrfToken = (cookies.find(c => c.name === 'tt_csrf_token' || c.name === 'csrf_session_id') || {}).value || '';
    const msToken = (cookies.find(c => c.name === 'msToken') || {}).value || '';
    return { cookieHeader, csrfToken, msToken };
  } catch (e) {
    return { cookieHeader: '', csrfToken: '', msToken: '' };
  }
}

// Fetch a page of reposts using authenticated session cookies with Mobile UA
async function fetchRepostPage(context, secUid, cursor = '0', count = 30) {
  try {
    const { cookieHeader, msToken } = await getSessionHeaders(context);
    const params = new URLSearchParams({
      aid: '1988',
      count: String(count),
      coverFormat: '2',
      cursor: String(cursor),
      needPinnedItemIds: 'true',
      post_item_list_request_type: '0',
      secUid: secUid
    });
    if (msToken) {
      params.append('msToken', msToken);
    }

    const url = `https://www.tiktok.com/api/repost/item_list/?${params.toString()}`;
    const res = await fetch(url, {
      method: 'GET',
      headers: {
        'User-Agent': MOBILE_UA,
        'Cookie': cookieHeader,
        'Accept': 'application/json, text/plain, */*',
        'Referer': 'https://www.tiktok.com/'
      }
    });

    const rawText = await res.text();

    if (!res.ok) {
      return {
        success: false,
        httpStatus: res.status,
        error: `HTTP ${res.status}: ${rawText.substring(0, 200)}`,
        rawPreview: rawText.substring(0, 500)
      };
    }

    if (!rawText || !rawText.trim()) {
      return {
        success: false,
        httpStatus: res.status,
        error: 'Empty response body from TikTok API',
        rawPreview: '(empty)'
      };
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (parseErr) {
      return {
        success: false,
        httpStatus: res.status,
        error: `JSON parse error: ${parseErr.message}`,
        rawPreview: rawText.substring(0, 500)
      };
    }

    if (data.status_code !== undefined && data.status_code !== 0) {
      return {
        success: false,
        httpStatus: res.status,
        statusCode: data.status_code,
        error: data.status_msg || `TikTok status_code ${data.status_code}`,
        rawPreview: rawText.substring(0, 300)
      };
    }

    return {
      success: true,
      httpStatus: res.status,
      statusCode: data.status_code,
      statusMsg: data.status_msg,
      hasMore: !!data.hasMore,
      nextCursor: data.cursor != null ? String(data.cursor) : null,
      items: (data.itemList || []).map(item => ({
        id: item.id,
        authorName: `@${item.author?.uniqueId || 'unknown'}`,
        authorNickname: item.author?.nickname || '',
        desc: item.desc || '(no caption)',
        createTime: item.createTime,
        url: `https://www.tiktok.com/@${item.author?.uniqueId || 'video'}/video/${item.id}`,
        cover: item.video?.cover || item.video?.dynamicCover || ''
      }))
    };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// Pure evaluation function for un-repost HTTP response (unit-testable)
function evaluateDeleteResponse(httpStatus, responseText) {
  if (httpStatus !== 200) {
    const isRateLimit = httpStatus === 429 || httpStatus === 503;
    return {
      success: false,
      rateLimited: isRateLimit,
      isCaptcha: false,
      httpStatus,
      error: `HTTP ${httpStatus}`
    };
  }

  // TikTok sends an empty response when it silently throttles or drops rapid deletion requests.
  // NEVER treat an empty body as a success!
  if (!responseText || !responseText.trim()) {
    return {
      success: false,
      rateLimited: true,
      isCaptcha: false,
      httpStatus: 200,
      error: 'Empty response body from TikTok (silent rate limit or connection dropped)'
    };
  }

  let json;
  try {
    json = JSON.parse(responseText);
  } catch (e) {
    return {
      success: false,
      rateLimited: false,
      isCaptcha: false,
      httpStatus: 200,
      error: `Non-JSON response: ${responseText.substring(0, 100)}`
    };
  }

  // TikTok un-repost strictly returns:
  // status_code: 0
  // delete_result: { delete_video_status: 1, sync_delete_video: true }
  const confirmed = json.status_code === 0 &&
    json.delete_result &&
    (json.delete_result.delete_video_status === 1 || json.delete_result.sync_delete_video === true);

  if (confirmed) {
    return {
      success: true,
      rateLimited: false,
      isCaptcha: false,
      httpStatus: 200,
      statusCode: 0,
      deleteResult: json.delete_result
    };
  }

  // Check if TikTok indicated a rate limit, CAPTCHA, or temporary lock
  const isRateLimit = json.status_code === 10202 ||
    json.status_code === 429 ||
    (json.status_msg && /frequent|limit|too many|cooldown|busy/i.test(json.status_msg)) ||
    (json.delete_result && json.delete_result.delete_video_status === 0);

  const isCaptcha = json.status_code === 10214;

  return {
    success: false,
    rateLimited: isRateLimit,
    isCaptcha,
    httpStatus: 200,
    statusCode: json.status_code,
    statusMsg: json.status_msg || 'TikTok un-repost unconfirmed',
    error: json.status_msg || `Unconfirmed delete_result: ${JSON.stringify(json.delete_result || {})}`
  };
}

// Send un-repost command via TikTok's internal endpoint with strict confirmation
async function removeRepostItem(context, itemId, fallbackCsrfToken) {
  try {
    const { cookieHeader, csrfToken } = await getSessionHeaders(context);
    const token = csrfToken || fallbackCsrfToken || '';

    const params = new URLSearchParams({
      aid: '1988',
      item_id: String(itemId)
    });

    const headers = {
      'User-Agent': MOBILE_UA,
      'Cookie': cookieHeader,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Accept': 'application/json, text/plain, */*'
    };
    if (token) {
      headers['tt-csrf-token'] = token;
    }

    const url = `https://www.tiktok.com/tiktok/v1/upvote/delete?${params.toString()}`;
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body: ''
    });

    const text = await res.text();
    return evaluateDeleteResponse(res.status, text);
  } catch (e) {
    return { success: false, rateLimited: false, isCaptcha: false, error: e.message };
  }
}

// Utility: Sleep with pause/stop check
async function cancellableDelay(ms) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (shouldStop) return false;
    while (shouldPause && !shouldStop) {
      await new Promise(r => setTimeout(r, 200));
    }
    await new Promise(r => setTimeout(r, 100));
  }
  return true;
}

// Scan remaining reposts across pages starting from cursor 0
async function scanRemainingReposts(context, secUid, maxCheckPages = 25) {
  let cur = '0';
  let totalRemaining = 0;
  for (let p = 0; p < maxCheckPages; p++) {
    const res = await fetchRepostPage(context, secUid, cur, 30);
    if (!res.success) break;
    const items = res.items || [];
    totalRemaining += items.length;
    if (totalRemaining > 0) {
      return { remainingCount: totalRemaining, hasMore: res.hasMore, sampleItem: items[0] };
    }
    if (!res.hasMore) break;
    cur = res.nextCursor || '0';
    await new Promise(r => setTimeout(r, 250));
  }
  return { remainingCount: totalRemaining, hasMore: false };
}

// Pre-scan all reposts in read-only mode to estimate total count
async function runPreScan(context, secUid, maxPages = 50) {
  let cur = '0';
  let totalFound = 0;
  const sampleItems = [];

  for (let p = 0; p < maxPages; p++) {
    const res = await fetchRepostPage(context, secUid, cur, 30);
    if (!res.success) break;
    const items = res.items || [];
    totalFound += items.length;
    if (sampleItems.length < 5 && items.length > 0) {
      sampleItems.push(...items.slice(0, 5 - sampleItems.length));
    }
    if (!res.hasMore) break;
    cur = res.nextCursor || '0';
    await new Promise(r => setTimeout(r, 200));
  }

  return { totalFound, sampleItems };
}

// Main Repost Removal Worker Loop
async function runRemovalWorker() {
  if (isWorkerRunning) return;
  isWorkerRunning = true;
  shouldPause = false;
  shouldStop = false;

  state.data.status = 'RUNNING';
  state.data.statusMessage = 'Navigating to your profile page...';
  state.data.stats.startedAt = state.data.stats.startedAt || new Date().toISOString();
  state.log('info', 'Worker started. Navigating to profile page first...');
  broadcastState();

  // Navigate to profile page so API calls are in the right page context
  try {
    const currentUrl = tiktokPage.url();
    if (!currentUrl.includes('/@') && !currentUrl.includes('/profile')) {
      const profileUrl = state.data.user.uniqueId
        ? `https://www.tiktok.com/@${state.data.user.uniqueId}`
        : 'https://www.tiktok.com/profile';
      await tiktokPage.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      state.log('info', `Navigated to ${profileUrl}`);
      await new Promise(r => setTimeout(r, 3000)); // Let page fully load & initialize cookies/CSRF
    }
  } catch (navErr) {
    state.log('warning', `Profile navigation warning: ${navErr.message}. Continuing anyway...`);
  }

  // Re-extract context after navigation (CSRF token may have changed)
  try {
    const freshCtx = await extractTikTokContext(tiktokPage);
    if (freshCtx && freshCtx.secUid) {
      state.data.user.secUid = freshCtx.secUid;
      state.data.user.csrfToken = freshCtx.csrfToken || '';
      state.log('info', `Refreshed session context. CSRF token: ${freshCtx.csrfToken ? 'present' : 'missing'}`);
    }
  } catch (ctxErr) {
    state.log('warning', `Context refresh warning: ${ctxErr.message}`);
  }

  const secUid = state.data.user.secUid;
  const csrfToken = state.data.user.csrfToken;

  state.data.statusMessage = 'Active: Scanning and removing reposts...';
  state.log('info', `Scanning reposts for secUid: ${secUid.substring(0, 20)}...`);
  broadcastState();

  let totalProcessedInRun = 0;
  let burstCount = 0;
  const BURST_LIMIT = 15; // TikTok allows bursts of ~20. Rest every 15 items to stay completely safe!
  const BURST_REST_SECONDS = 45; // 45 seconds pause
  let consecutiveErrors = 0;
  let cursor = '0';
  let hasMore = true;
  let passNumber = 1;

  try {
    while (!shouldStop) {
      // Check pause
      while (shouldPause && !shouldStop) {
        state.data.status = 'PAUSED';
        state.data.statusMessage = 'Process paused by user.';
        broadcastState();
        await new Promise(r => setTimeout(r, 500));
      }
      if (shouldStop) break;

      // Check CAPTCHA
      const captchaActive = await isCaptchaVisible(tiktokPage);
      if (captchaActive) {
        state.data.status = 'CAPTCHA_REQUIRED';
        state.data.statusMessage = 'Verification CAPTCHA detected! Please solve it in the TikTok browser window.';
        state.log('warning', 'CAPTCHA challenge detected! Waiting for you to solve it in the browser...');
        broadcastState();

        while (await isCaptchaVisible(tiktokPage) && !shouldStop) {
          await new Promise(r => setTimeout(r, 1000));
        }

        if (shouldStop) break;
        state.data.status = 'RUNNING';
        state.data.statusMessage = 'CAPTCHA solved! Resuming removal...';
        state.log('info', 'CAPTCHA solved. Resuming removal.');
        broadcastState();
      }

      state.data.status = 'RUNNING';
      state.data.statusMessage = `Pass #${passNumber}: Fetching repost batch (cursor: ${cursor})...`;
      broadcastState();

      // Fetch batch using authenticated session cookies with Mobile UA bypass
      const pageResult = await fetchRepostPage(browserContext, secUid, cursor, state.data.config.batchSize);

      if (!pageResult.success) {
        consecutiveErrors++;
        const rawInfo = pageResult.rawPreview ? ` | Raw: ${pageResult.rawPreview.substring(0, 150)}` : '';
        state.log('error', `Failed to fetch repost list: ${pageResult.error}${rawInfo}`);

        if (pageResult.httpStatus === 429) {
          await handleRateLimit(60, 'Rate limit encountered while fetching repost list.');
          continue;
        }

        // After 2 consecutive errors, try refreshing the page to re-establish session
        if (consecutiveErrors === 2) {
          state.log('info', 'Refreshing page to re-establish session context...');
          try {
            const profileUrl = state.data.user.uniqueId
              ? `https://www.tiktok.com/@${state.data.user.uniqueId}`
              : 'https://www.tiktok.com/profile';
            await tiktokPage.goto(profileUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await new Promise(r => setTimeout(r, 4000));
            // Re-extract context
            const freshCtx = await extractTikTokContext(tiktokPage);
            if (freshCtx && freshCtx.csrfToken) {
              state.data.user.csrfToken = freshCtx.csrfToken;
            }
            state.log('info', 'Page refreshed. Retrying...');
          } catch (refreshErr) {
            state.log('warning', `Page refresh failed: ${refreshErr.message}`);
          }
        }

        if (consecutiveErrors >= 5) {
          state.log('error', 'Too many consecutive network/API errors. Pausing worker for safety.');
          shouldPause = true;
          continue;
        }

        await cancellableDelay(5000);
        continue;
      }

      consecutiveErrors = 0;
      const items = pageResult.items || [];
      hasMore = pageResult.hasMore;
      cursor = pageResult.nextCursor || '0';

      state.data.stats.currentBatch = items.length;

      // Self-healing state reconciliation:
      // If TikTok returned items that our state previously assumed were removed,
      // purge them from removedIds so they get cleanly and genuinely deleted!
      const falseRemovals = items.filter(it => state.data.removedIds.includes(it.id));
      if (falseRemovals.length > 0) {
        state.log('warning', `Detected ${falseRemovals.length} repost(s) that were previously unconfirmed. Re-queuing for removal.`);
        state.data.removedIds = state.data.removedIds.filter(id => !falseRemovals.some(it => it.id === id));
        state.data.stats.confirmedRemoved = state.data.removedIds.length;
        state.save();
        broadcastState();
      }

      // Filter out items already confirmed removed
      const pendingItems = items.filter(it => !state.data.removedIds.includes(it.id));
      state.data.stats.queuedRemaining = pendingItems.length;
      broadcastState();

      // If this page had 0 items but TikTok says hasMore, quietly step to next cursor
      if (items.length === 0 && hasMore) {
        await cancellableDelay(350);
        continue;
      }

      if (items.length > 0) {
        state.log('info', `Fetched ${items.length} items (pending in batch: ${pendingItems.length}, hasMore: ${hasMore}).`);
      }

      // If no items on this page and no more pages left in current pass, run verification
      if (pendingItems.length === 0 && !hasMore) {
        state.data.status = 'VERIFYING';
        state.data.statusMessage = 'Pass finished. Verifying with TikTok servers if any reposts remain...';
        state.log('info', 'Pass finished. Performing full verification across all pages...');
        broadcastState();

        await cancellableDelay(5000); // Allow TikTok backend cache to invalidate

        const verifyCheck = await scanRemainingReposts(browserContext, secUid);

        if (verifyCheck.remainingCount === 0) {
          state.data.status = 'FINISHED';
          state.data.statusMessage = `Completed! Verified that all reposts have been removed. Total removed: ${state.data.stats.confirmedRemoved}.`;
          state.log('success', `🎉 All reposts successfully removed and verified! Total: ${state.data.stats.confirmedRemoved}`);
          state.data.currentItem = null;
          broadcastState();
          break;
        } else {
          passNumber++;
          cursor = '0';
          state.log('info', `Verification detected ${verifyCheck.remainingCount} remaining repost(s). Starting clean-up pass #${passNumber}...`);
          continue;
        }
      }

      // Process pending items sequentially
      for (const item of pendingItems) {
        if (shouldStop) break;
        while (shouldPause && !shouldStop) {
          state.data.status = 'PAUSED';
          state.data.statusMessage = 'Process paused by user.';
          broadcastState();
          await new Promise(r => setTimeout(r, 500));
        }
        if (shouldStop) break;

        state.data.currentItem = item;
        state.data.statusMessage = `Removing repost: ${item.authorName} - "${(item.desc || '').slice(0, 30)}..."`;
        broadcastState();

        if (state.data.config.dryRun) {
          state.log('info', `[DRY RUN] Would remove: ${item.authorName} (${item.id})`);
          await cancellableDelay(1000);
          continue;
        }

        // Execute removal with rate-limit retry protection
        let removeRes = await removeRepostItem(browserContext, item.id, csrfToken);

        // If rate limited, cooldown and retry up to 2 times
        let retryCount = 0;
        while (!removeRes.success && removeRes.rateLimited && retryCount < 2 && !shouldStop) {
          retryCount++;
          state.recordUnconfirmed(item.id, item.authorName, removeRes.error);
          const waitSec = 50 + retryCount * 15;
          state.log('warning', `TikTok rate-limited un-reposting item ${item.id}. Cooling down for ${waitSec}s before retry ${retryCount}/2...`);
          await handleRateLimit(waitSec, `Rate limit on repost ${item.id}`);
          if (shouldStop) break;
          removeRes = await removeRepostItem(browserContext, item.id, csrfToken);
        }

        if (removeRes.success) {
          state.recordRemoval(item.id, item.authorName, item.desc);
          totalProcessedInRun++;
          burstCount++;
          consecutiveErrors = 0;

          // Safe batch rest interval to avoid triggering TikTok burst throttling
          if (burstCount >= BURST_LIMIT) {
            burstCount = 0;
            state.log('info', `Completed batch of ${BURST_LIMIT} reposts. Resting for ${BURST_REST_SECONDS}s to avoid TikTok burst limits...`);
            await handleRateLimit(BURST_REST_SECONDS, `Periodic batch rest (${BURST_LIMIT} items removed)`);
          }
        } else {
          if (removeRes.isCaptcha || removeRes.statusCode === 10214) {
            state.data.status = 'CAPTCHA_REQUIRED';
            state.data.statusMessage = 'TikTok requested verification. Please solve the CAPTCHA in the browser.';
            state.log('warning', 'Verification required by TikTok! Waiting for manual completion in browser...');
            broadcastState();

            while (await isCaptchaVisible(tiktokPage) && !shouldStop) {
              await new Promise(r => setTimeout(r, 1000));
            }
            if (shouldStop) break;
            continue;
          } else {
            state.recordFailure(item.id, item.authorName, removeRes.error || 'Removal unconfirmed by TikTok');
          }
        }

        // Safe randomized delay between individual deletions
        const minD = state.data.config.minDelayMs || 3500;
        const maxD = state.data.config.maxDelayMs || 6000;
        const delay = Math.floor(Math.random() * (maxD - minD + 1)) + minD;
        await cancellableDelay(delay);
      }

      // If finished current page and hasMore is false, reset cursor to 0 for verification
      if (!hasMore) {
        cursor = '0';
      }
    }
  } catch (err) {
    state.data.status = 'ERROR';
    state.data.statusMessage = `Worker stopped due to an error: ${err.message}`;
    state.log('error', `Worker crashed: ${err.message}`);
    broadcastState();
  } finally {
    isWorkerRunning = false;
    state.data.currentItem = null;
    if (state.data.status === 'RUNNING') {
      state.data.status = 'PAUSED';
      state.data.statusMessage = 'Stopped.';
    }
    broadcastState();
  }
}

async function handleRateLimit(seconds, reason) {
  state.data.status = 'RATE_LIMITED';
  state.data.statusMessage = `${reason}. Cooling down for ${seconds}s...`;
  state.log('warning', `${reason}. Cooling down for ${seconds} seconds before resuming.`);
  state.data.cooldownSeconds = seconds;
  broadcastState();

  for (let s = seconds; s > 0; s--) {
    if (shouldStop) break;
    state.data.cooldownSeconds = s;
    broadcastState();
    await new Promise(r => setTimeout(r, 1000));
  }
  state.data.cooldownSeconds = 0;
  state.data.status = 'RUNNING';
  broadcastState();
}

// Handle Client Commands from UI
function handleClientAction(action) {
  switch (action.type) {
    case 'CONFIRM_START':
      if (!state.data.user.isLoggedIn) {
        state.log('warning', 'Cannot start: Not signed in to TikTok.');
        return;
      }
      if (isWorkerRunning) {
        shouldPause = false;
        state.data.status = 'RUNNING';
        broadcastState();
      } else {
        runRemovalWorker();
      }
      break;

    case 'PAUSE':
      shouldPause = true;
      state.data.status = 'PAUSED';
      state.data.statusMessage = 'Paused by user.';
      state.log('info', 'Removal paused by user.');
      broadcastState();
      break;

    case 'RESUME':
      shouldPause = false;
      if (!isWorkerRunning) {
        runRemovalWorker();
      } else {
        state.data.status = 'RUNNING';
        state.data.statusMessage = 'Resumed.';
        state.log('info', 'Removal resumed.');
        broadcastState();
      }
      break;

    case 'STOP':
      shouldStop = true;
      shouldPause = false;
      state.data.status = 'STOPPED';
      state.data.statusMessage = 'Stopped by user. State saved.';
      state.log('info', 'Removal stopped by user.');
      state.save();
      broadcastState();
      break;

    case 'UPDATE_CONFIG':
      if (action.config) {
        state.data.config = { ...state.data.config, ...action.config };
        state.save();
        state.log('system', `Updated settings: Min delay ${state.data.config.minDelayMs}ms, Max delay ${state.data.config.maxDelayMs}ms, Dry run: ${state.data.config.dryRun}`);
        broadcastState();
      }
      break;

    case 'CLEAR_HISTORY':
      state.data.removedIds = [];
      state.data.failedIds = [];
      state.data.stats.confirmedRemoved = 0;
      state.data.stats.failedOrSkipped = 0;
      state.data.stats.unconfirmedOrRetrying = 0;
      state.save();
      state.log('info', 'Reset local tracked IDs history.');
      broadcastState();
      break;

    case 'SCAN_ONLY':
      if (!state.data.user.isLoggedIn) {
        state.log('warning', 'Cannot scan: Not signed in to TikTok.');
        return;
      }
      (async () => {
        state.data.status = 'VERIFYING';
        state.data.statusMessage = 'Scanning your reposts in read-only mode...';
        state.log('info', 'Starting read-only scan to count total reposts...');
        broadcastState();

        try {
          const scan = await runPreScan(browserContext, state.data.user.secUid);
          state.data.stats.totalDetected = scan.totalFound;
          state.data.status = 'READY_TO_START';
          state.data.statusMessage = `Scan complete: Found ${scan.totalFound} active reposts on @${state.data.user.uniqueId}.`;
          state.log('success', `Scan complete: Detected ${scan.totalFound} active reposts on @${state.data.user.uniqueId}.`);
          broadcastState();
        } catch (e) {
          state.data.status = 'READY_TO_START';
          state.data.statusMessage = `Scan error: ${e.message}`;
          state.log('error', `Scan failed: ${e.message}`);
          broadcastState();
        }
      })();
      break;

    case 'LOGOUT':
      (async () => {
        state.log('info', 'Logging out and clearing local browser session...');
        if (isWorkerRunning) {
          shouldStop = true;
          isWorkerRunning = false;
        }
        if (browserContext) {
          try { await browserContext.close(); } catch (e) {}
          browserContext = null;
          tiktokPage = null;
        }
        if (action.clearFiles && fs.existsSync(USER_DATA_DIR)) {
          try {
            fs.rmSync(USER_DATA_DIR, { recursive: true, force: true });
            state.log('info', 'Local session files successfully erased.');
          } catch (e) {
            state.log('warning', `Failed to delete session directory: ${e.message}`);
          }
        }
        state.data.user = {
          isLoggedIn: false,
          uniqueId: '',
          nickname: '',
          secUid: '',
          avatar: '',
          csrfToken: ''
        };
        state.data.status = 'WAITING_FOR_LOGIN';
        state.data.statusMessage = 'Signed out. Please log in to TikTok in the browser window.';
        state.save();
        broadcastState();
        setTimeout(() => initBrowser(), 1500);
      })();
      break;
  }
}

// Diagnostic endpoint to test different TikTok endpoints
app.get('/api/diagnose', async (req, res) => {
  if (!tiktokPage || tiktokPage.isClosed()) {
    return res.json({ error: 'tiktokPage not open' });
  }

  const results = await tiktokPage.evaluate(async (secUid) => {
    const report = {};

    // 1. Test /api/favorite/item_list (to see if item_list APIs work in general)
    try {
      const favUrl = `https://www.tiktok.com/api/favorite/item_list/?aid=1988&count=5&cursor=0&secUid=${secUid}`;
      const rFav = await fetch(favUrl, { credentials: 'include' });
      const tFav = await rFav.text();
      report.favoriteTest = { status: rFav.status, length: tFav.length, preview: tFav.substring(0, 100) };
    } catch (e) {
      report.favoriteTest = { error: e.message };
    }

    // 2. Test /api/repost/item_list with aid=1988
    try {
      const repUrl = `https://www.tiktok.com/api/repost/item_list/?aid=1988&count=30&coverFormat=2&cursor=0&needPinnedItemIds=true&post_item_list_request_type=0&secUid=${secUid}`;
      const rRep = await fetch(repUrl, { credentials: 'include' });
      const tRep = await rRep.text();
      report.repost1988 = { status: rRep.status, length: tRep.length, preview: tRep.substring(0, 100) };
    } catch (e) {
      report.repost1988 = { error: e.message };
    }

    // 3. Test /api/repost/item_list with mobile aid=1233
    try {
      const repUrl1233 = `https://www.tiktok.com/api/repost/item_list/?aid=1233&count=30&cursor=0&secUid=${secUid}`;
      const r1233 = await fetch(repUrl1233, { credentials: 'include' });
      const t1233 = await r1233.text();
      report.repost1233 = { status: r1233.status, length: t1233.length, preview: t1233.substring(0, 100) };
    } catch (e) {
      report.repost1233 = { error: e.message };
    }

    // 4. Inspect Universal Data on page for any repost properties
    try {
      const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
      if (el) {
        const d = JSON.parse(el.textContent);
        const userDetail = d?.__DEFAULT_SCOPE__?.['webapp.user-detail']?.userInfo?.user;
        const stats = d?.__DEFAULT_SCOPE__?.['webapp.user-detail']?.userInfo?.stats;
        report.userStats = stats;
        report.userFlags = {
          secret: userDetail?.secret,
          isSecret: userDetail?.isSecret,
          profileTab: d?.__DEFAULT_SCOPE__?.['webapp.user-detail']?.shareMeta
        };
      }
    } catch (e) {
      report.universalDataError = e.message;
    }

    // 5. Check if any element in DOM mentions repost
    const domReposts = document.querySelectorAll('[data-e2e*="repost"], [role="tab"], [aria-label*="repost" i], [aria-label*="репост" i]');
    report.tabsFound = Array.from(domReposts).map(el => ({
      text: el.textContent.trim(),
      role: el.getAttribute('role'),
      dataE2e: el.getAttribute('data-e2e'),
      ariaSelected: el.getAttribute('aria-selected')
    }));

    return report;
  }, state.data.user.secUid);

  res.json({ user: state.data.user, results });
});

// REST API Endpoints
app.get('/api/state', (req, res) => {
  res.json(state.data);
});

app.post('/api/action', (req, res) => {
  handleClientAction(req.body);
  res.json({ ok: true, state: state.data });
});

app.get('/api/export', (req, res) => {
  const format = req.query.format || 'json';
  if (format === 'csv') {
    let csv = 'Video ID,Status,Timestamp\n';
    for (const id of state.data.removedIds) {
      csv += `${id},REMOVED,\n`;
    }
    for (const id of state.data.failedIds) {
      csv += `${id},FAILED_OR_SKIPPED,\n`;
    }
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="unrepost_audit.csv"');
    res.send(csv);
  } else {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Content-Disposition', 'attachment; filename="unrepost_audit.json"');
    res.json({
      exportedAt: new Date().toISOString(),
      account: state.data.user.uniqueId,
      confirmedRemovedCount: state.data.removedIds.length,
      failedOrSkippedCount: state.data.failedIds.length,
      unconfirmedOrRetryingCount: state.data.stats.unconfirmedOrRetrying || 0,
      removedIds: state.data.removedIds,
      failedIds: state.data.failedIds,
      logs: state.data.logs
    });
  }
});

// Start Server and Browser (Only bind to 127.0.0.1 for local security)
if (require.main === module) {
  server.listen(PORT, HOST, async () => {
    console.log(`\n==================================================`);
    console.log(`  UnRepost Engine running on http://${HOST}:${PORT}`);
    console.log(`  Storage directory: ${APP_DATA_DIR}`);
    console.log(`==================================================\n`);
    state.log('system', `Control Dashboard initialized at http://${HOST}:${PORT}`);
    await initBrowser();
  });

  // Clean shutdown handler
  process.on('SIGINT', async () => {
    console.log('\nShutting down UnRepost...');
    shouldStop = true;
    state.save();
    if (browserContext) {
      try { await browserContext.close(); } catch (e) {}
    }
    process.exit(0);
  });
}

// Module exports for automated testing
module.exports = {
  evaluateDeleteResponse,
  StateManager,
  findChromeExecutable,
  resolveAppPaths,
  validateLoopbackRequest
};

