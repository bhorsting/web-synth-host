const { app, BrowserWindow, powerSaveBlocker, session, ipcMain } = require('electron');
const path = require('path');
const { spawn } = require('child_process');

// ============================================================================
// HARDWARE LOW-LATENCY CHROMIUM SWITCHES
// ============================================================================

app.commandLine.appendSwitch('high-priority-internal-threads');
app.commandLine.appendSwitch('disable-audio-output-resampler');
app.commandLine.appendSwitch('enable-web-midi');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Standard Chrome User-Agent to allow Google Identity Services / OAuth without disallowed_useragent block
const CHROME_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';
app.userAgentFallback = CHROME_USER_AGENT;

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

  mainWindow.webContents.setUserAgent(CHROME_USER_AGENT);

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
  contents.setUserAgent(CHROME_USER_AGENT);
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
  session.defaultSession.setUserAgent(CHROME_USER_AGENT);
  session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
    details.requestHeaders['User-Agent'] = CHROME_USER_AGENT;
    callback({ cancel: false, requestHeaders: details.requestHeaders });
  });

  startAsioSink();
  createWindow();
});

app.on('window-all-closed', () => {
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
