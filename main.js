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

let mainWindow = null;
let powerSaveId = null;
let asioProcess = null;
let asioStatus = { ready: false, latencySamples: 64, latencyMs: 1.33, driver: 'ASIO 2.0 - ESI U168 XT' };

function startAsioSink() {
  const asioExe = path.join(__dirname, 'asio-bridge', 'AsioSink.exe');
  console.log('[SynthHost] Starting Native ASIO Bridge:', asioExe);

  try {
    asioProcess = spawn(asioExe, [], {
      stdio: ['pipe', 'pipe', 'inherit'],
      windowsHide: true
    });

    asioProcess.stdout.on('data', (chunk) => {
      const msg = chunk.toString();
      console.log('[ASIO Bridge]', msg.trim());

      if (msg.includes('ASIO_READY')) {
        const matchLat = msg.match(/latency=(\d+)/);
        const lat = matchLat ? parseInt(matchLat[1]) : 64;
        asioStatus = {
          ready: true,
          latencySamples: lat,
          latencyMs: parseFloat((lat / 48000 * 1000).toFixed(2)),
          driver: 'ASIO 2.0 - ESI U168 XT'
        };

        if (mainWindow && mainWindow.webContents) {
          mainWindow.webContents.send('asio-status-update', asioStatus);
        }
      }
    });

    asioProcess.on('exit', (code) => {
      console.log('[ASIO Bridge] Process exited with code:', code);
      asioStatus.ready = false;
      asioProcess = null;
    });
  } catch (err) {
    console.error('[ASIO Bridge] Failed to launch:', err);
  }
}

// Receive Float32 PCM audio frames from AudioWorklet in renderer
ipcMain.on('stream-audio-frame', (event, buffer) => {
  if (asioProcess && asioProcess.stdin && asioProcess.stdin.writable) {
    asioProcess.stdin.write(buffer);
  }
});

ipcMain.handle('get-asio-status', () => asioStatus);

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
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  });

  // Auto-grant all MIDI and media permissions
  session.defaultSession.setPermissionCheckHandler(() => true);
  session.defaultSession.setPermissionRequestHandler((wc, p, cb) => cb(true));

  powerSaveId = powerSaveBlocker.start('prevent-app-suspension');

  console.log('[SynthHost] Loading Synth URL...');
  mainWindow.loadURL('https://jupiter-8-web-synth-693154064316.us-west1.run.app/');

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[SynthHost] Synth page loaded successfully!');
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

app.whenReady().then(() => {
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
