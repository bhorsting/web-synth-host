const { app, BrowserWindow, powerSaveBlocker, session, ipcMain, shell } = require('electron');
const path = require('path');
const http = require('http');
const fs = require('fs');
const { spawn } = require('child_process');

// ============================================================================
// HARDWARE LOW-LATENCY CHROMIUM SWITCHES
// ============================================================================

app.commandLine.appendSwitch('high-priority-internal-threads');
app.commandLine.appendSwitch('disable-audio-output-resampler');
app.commandLine.appendSwitch('enable-web-midi');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Standard Firefox User-Agent prevents Google OAuth from checking Chromium-specific Client Hints (sec-ch-ua)
// and bypasses the embedded webview 'This browser or app may not be secure' block
const AUTH_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:135.0) Gecko/20100101 Firefox/135.0';
app.userAgentFallback = AUTH_USER_AGENT;

let mainWindow = null;
let powerSaveId = null;
let asioProcess = null;
let asioStatus = { ready: false, latencySamples: 64, latencyMs: 1.33, driver: 'ASIO 2.0 - ESI U168 XT' };

function startAsioSink() {
  const asioExe = path.join(__dirname, 'asio-bridge', 'AsioSink.exe');
  console.log('[SynthHost] Starting Native ASIO Bridge:', asioExe);

  try {
    asioProcess = spawn(asioExe, [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });

    asioProcess.stdout.on('data', (chunk) => {
      const msg = chunk.toString();
      console.log('[ASIO Bridge]', msg.trim());

      if (msg.includes('ASIO_READY')) {
        const matchLat = msg.match(/latency=(\d+)/);
        const matchBuf = msg.match(/buffer=(\d+)/);
        const lat = matchLat ? parseInt(matchLat[1]) : 64;
        const buf = matchBuf ? parseInt(matchBuf[1]) : lat;
        asioStatus = {
          ready: true,
          latencySamples: lat,
          bufferSamples: buf,
          latencyMs: parseFloat((lat / 48000 * 1000).toFixed(2)),
          driver: 'ASIO 2.0 - ESI U168 XT'
        };

        if (mainWindow && mainWindow.webContents) {
          mainWindow.webContents.send('asio-status-update', asioStatus);
        }
      }
    });

    asioProcess.stderr.on('data', (chunk) => {
      const errStr = chunk.toString().trim();
      console.error('[ASIO Bridge Error]', errStr);
      asioStatus.error = errStr;
      asioStatus.ready = false;
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('asio-status-update', asioStatus);
      }
    });

    asioProcess.on('exit', (code) => {
      console.log('[ASIO Bridge] Process exited with code:', code);
      asioStatus.ready = false;
      asioProcess = null;
      if (mainWindow && mainWindow.webContents) {
        mainWindow.webContents.send('asio-status-update', asioStatus);
      }
    });
  } catch (err) {
    console.error('[ASIO Bridge] Failed to launch:', err);
    asioStatus.error = err.message;
    asioStatus.ready = false;
  }
}

// Receive Float32 PCM audio frames from AudioWorklet in renderer
ipcMain.on('stream-audio-frame', (event, buffer) => {
  if (asioProcess && asioProcess.stdin && asioProcess.stdin.writable) {
    asioProcess.stdin.write(buffer);
  }
});

ipcMain.handle('get-asio-status', () => asioStatus);
ipcMain.handle('restart-asio', () => {
  if (asioProcess) {
    try {
      asioProcess.kill();
    } catch {}
    asioProcess = null;
  }
  startAsioSink();
  return asioStatus;
});

// ============================================================================
// SYSTEM BROWSER GOOGLE OAUTH 2.0 BRIDGE (LOOPBACK RECEIVER)
// ============================================================================

let localAuthServer = null;
let cachedGoogleToken = null;
let cachedGoogleTokenTime = 0;
const OAUTH_PORT = 48480;
const OAUTH_CLIENT_ID = '693154064316-8dhof576j828lunjt0o3nbed263tecad.apps.googleusercontent.com';

function startLocalOAuthServer() {
  if (localAuthServer) return;

  localAuthServer = http.createServer((req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url, `http://localhost:${OAUTH_PORT}`);

    if (parsedUrl.pathname === '/callback') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!DOCTYPE html>
<html>
<head>
  <title>Jupiter-8 Synth Host - Authorization</title>
  <style>
    body {
      background: #0a0a0f;
      color: #f3f4f6;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100vh;
      margin: 0;
      text-align: center;
    }
    .card {
      background: #111827;
      border: 1px solid #374151;
      border-radius: 12px;
      padding: 32px 40px;
      box-shadow: 0 10px 25px rgba(0,0,0,0.5);
      max-width: 440px;
    }
    h2 { margin: 0 0 12px 0; font-size: 20px; color: #4ade80; }
    p { margin: 0; font-size: 14px; color: #9ca3af; line-height: 1.6; }
    .spinner {
      width: 28px;
      height: 28px;
      border: 3px solid rgba(255,255,255,0.1);
      border-top-color: #4ade80;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      margin: 16px auto 0 auto;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="card" id="content">
    <h2>Authorizing Synth Host...</h2>
    <p>Connecting your Google Account to the Jupiter-8 Synth...</p>
    <div class="spinner" id="spinner"></div>
  </div>
  <script>
    const hash = window.location.hash.substring(1);
    const params = new URLSearchParams(hash);
    const token = params.get('access_token');
    const error = params.get('error');

    if (token) {
      fetch('/token?token=' + encodeURIComponent(token))
        .then(r => r.json())
        .then(() => {
          document.getElementById('content').innerHTML =
            '<h2 style="color: #4ade80;">Authorization Successful!</h2>' +
            '<p>Your Google Sheets library is now connected.<br>You can close this browser tab and return to the synth.</p>';
          setTimeout(() => { try { window.close(); } catch(e){} }, 2000);
        })
        .catch(err => {
          document.getElementById('content').innerHTML =
            '<h2 style="color: #ef4444;">Error Sending Token</h2>' +
            '<p>' + err.message + '</p>';
        });
    } else if (error) {
      document.getElementById('content').innerHTML =
        '<h2 style="color: #ef4444;">Authorization Cancelled</h2>' +
        '<p>' + (params.get('error_description') || error) + '</p>';
    } else {
      document.getElementById('content').innerHTML =
        '<h2 style="color: #facc15;">No Token Received</h2>' +
        '<p>Please try clicking Authorize again in the synth host.</p>';
    }
  </script>
</body>
</html>`);
      return;
    }

    if (parsedUrl.pathname === '/token') {
      const token = parsedUrl.searchParams.get('token');
      if (token) {
        saveGoogleToken(token);
        if (mainWindow && mainWindow.webContents) {
          console.log('[SynthHost] Google OAuth access token successfully received from browser!');
          mainWindow.webContents.send('google-token-received', token);
          try {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.show();
            mainWindow.focus();
          } catch (e) {}
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true }));
      return;
    }

    if (parsedUrl.pathname === '/eval') {
      const code = parsedUrl.searchParams.get('code');
      if (mainWindow && mainWindow.webContents && code) {
        mainWindow.webContents.executeJavaScript(code)
          .then(result => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ result }));
          })
          .catch(err => {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          });
        return;
      }
    }

    res.writeHead(404);
    res.end();
  });

  localAuthServer.listen(OAUTH_PORT, () => {
    console.log(`[SynthHost] Local OAuth loopback receiver listening on http://localhost:${OAUTH_PORT}`);
  });

  localAuthServer.on('error', (err) => {
    console.warn('[SynthHost] Local OAuth server notice:', err.message);
  });
}

function getTokenFilePath() {
  return path.join(app.getPath('userData'), 'google-oauth-token.json');
}

function loadStoredGoogleToken() {
  try {
    const p = getTokenFilePath();
    if (fs.existsSync(p)) {
      const data = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (data.token && data.time && (Date.now() - data.time < 55 * 60 * 1000)) {
        cachedGoogleToken = data.token;
        cachedGoogleTokenTime = data.time;
        console.log('[SynthHost] Loaded valid cached Google OAuth token from disk');
      } else {
        console.log('[SynthHost] Saved Google OAuth token on disk is expired');
        try { fs.unlinkSync(p); } catch {}
      }
    }
  } catch (e) {
    console.warn('[SynthHost] Error loading cached token:', e.message);
  }
}

function saveGoogleToken(token) {
  cachedGoogleToken = token;
  cachedGoogleTokenTime = Date.now();
  try {
    fs.writeFileSync(getTokenFilePath(), JSON.stringify({ token, time: cachedGoogleTokenTime }), 'utf8');
    console.log('[SynthHost] Cached Google OAuth token saved to disk');
  } catch (e) {
    console.warn('[SynthHost] Error saving cached token:', e.message);
  }
}

function clearGoogleToken() {
  cachedGoogleToken = null;
  cachedGoogleTokenTime = 0;
  try {
    const p = getTokenFilePath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
    console.log('[SynthHost] Google OAuth token cleared from disk');
  } catch (e) {}
}

ipcMain.handle('get-google-token', () => {
  if (cachedGoogleToken && (Date.now() - cachedGoogleTokenTime < 55 * 60 * 1000)) {
    return cachedGoogleToken;
  }
  return null;
});

ipcMain.handle('clear-google-token', () => {
  clearGoogleToken();
  return true;
});

function getSettingsFilePath() {
  return path.join(app.getPath('userData'), 'synth-settings.json');
}

function loadSavedSettings() {
  try {
    const p = getSettingsFilePath();
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  } catch (e) {
    console.warn('[SynthHost] Error loading settings from disk:', e.message);
  }
  return {};
}

function saveSettings(settings) {
  try {
    const p = getSettingsFilePath();
    let current = {};
    if (fs.existsSync(p)) {
      try { current = JSON.parse(fs.readFileSync(p, 'utf8')); } catch {}
    }
    const merged = { ...current, ...settings };
    fs.writeFileSync(p, JSON.stringify(merged, null, 2), 'utf8');
    console.log('[SynthHost] Synth settings persisted to disk');
  } catch (e) {
    console.warn('[SynthHost] Error saving settings to disk:', e.message);
  }
}

ipcMain.on('get-saved-settings-sync', (event) => {
  event.returnValue = loadSavedSettings();
});

ipcMain.handle('get-saved-settings', () => loadSavedSettings());

ipcMain.on('save-settings', (event, settings) => {
  saveSettings(settings);
});

ipcMain.handle('open-browser-auth', () => {
  const redirectUri = `http://localhost:${OAUTH_PORT}/callback`;
  const scopes = [
    'https://www.googleapis.com/auth/spreadsheets',
    'https://www.googleapis.com/auth/drive.file',
    'https://www.googleapis.com/auth/drive.readonly'
  ].join(' ');

  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?` +
    `client_id=${encodeURIComponent(OAUTH_CLIENT_ID)}&` +
    `redirect_uri=${encodeURIComponent(redirectUri)}&` +
    `response_type=token&` +
    `scope=${encodeURIComponent(scopes)}&` +
    `prompt=select_account`;

  console.log('[SynthHost] Launching system browser for Google OAuth flow...');
  shell.openExternal(authUrl);
  return { started: true };
});

function createWindow() {
  console.log('[SynthHost] Creating BrowserWindow in Fullscreen...');

  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1024,
    minHeight: 600,
    fullscreen: true,
    title: 'Roland Jupiter-8 Synth (Native ASIO - ESI U168XT)',
    backgroundColor: '#0a0a0f',
    show: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  });

  mainWindow.webContents.setUserAgent(AUTH_USER_AGENT);

  // Auto-grant all MIDI and media permissions
  session.defaultSession.setPermissionCheckHandler(() => true);
  session.defaultSession.setPermissionRequestHandler((wc, p, cb) => cb(true));

  // Handle popup windows (e.g. Google OAuth Sign-In for Google Sheets sync)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    console.log('[SynthHost] Opening authentication popup:', url);
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 540,
        height: 680,
        autoHideMenuBar: true,
        alwaysOnTop: true, // Floats cleanly over the fullscreen synth
        center: true,
        modal: false,
        title: 'Google Sign-In',
        webPreferences: {
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true
        }
      }
    };
  });

  powerSaveId = powerSaveBlocker.start('prevent-app-suspension');

  console.log('[SynthHost] Loading Synth URL...');
  mainWindow.loadURL('https://jupiter-8-web-synth-693154064316.us-west1.run.app/');

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[SynthHost] Synth page loaded successfully!');
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('asio-status-update', asioStatus);
    }
  });

  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    const levelStr = level === 3 ? 'ERROR' : level === 2 ? 'WARN' : 'LOG';
    if (message.includes('[SynthHost]') || message.includes('Google') || message.includes('OAuth') || level >= 2) {
      console.log(`[Renderer ${levelStr}]`, message);
    }
  });

  // Keyboard shortcuts: F11 or Escape to toggle Fullscreen, F12 for DevTools
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if ((input.key === 'F11' || input.key === 'Escape') && input.type === 'keyDown') {
      mainWindow.setFullScreen(!mainWindow.isFullScreen());
      event.preventDefault();
    } else if (input.key === 'F12' && input.type === 'keyDown') {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.on('web-contents-created', (event, contents) => {
  contents.setUserAgent(AUTH_USER_AGENT);
  if (contents.getType() === 'window') {
    contents.on('did-finish-load', () => {
      console.log('[SynthHost] Popup window loaded:', contents.getURL());
    });
    contents.on('console-message', (e, level, msg) => {
      console.log('[Popup Console]', msg);
    });
  }
});

app.whenReady().then(() => {
  session.defaultSession.setUserAgent(AUTH_USER_AGENT);
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    details.requestHeaders['User-Agent'] = AUTH_USER_AGENT;
    delete details.requestHeaders['sec-ch-ua'];
    delete details.requestHeaders['sec-ch-ua-mobile'];
    delete details.requestHeaders['sec-ch-ua-platform'];
    callback({ cancel: false, requestHeaders: details.requestHeaders });
  });

  startLocalOAuthServer();
  loadStoredGoogleToken();
  startAsioSink();
  createWindow();
});

app.on('window-all-closed', () => {
  if (localAuthServer) {
    try {
      localAuthServer.close();
    } catch {}
    localAuthServer = null;
  }
  if (asioProcess) {
    try {
      asioProcess.stdin.end();
      asioProcess.kill();
    } catch {}
    asioProcess = null;
  }
  if (powerSaveId !== null && powerSaveBlocker.isStarted(powerSaveId)) {
    powerSaveBlocker.stop(powerSaveId);
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
