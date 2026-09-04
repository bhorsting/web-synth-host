const { app, BrowserWindow, powerSaveBlocker, session } = require('electron');
const path = require('path');

// ============================================================================
// HARDWARE LOW-LATENCY CHROMIUM SWITCHES FOR ESI U168XT
// ============================================================================

const bufferArg = process.argv.find(a => a.startsWith('--buffer='));
const bufferSize = bufferArg ? bufferArg.split('=')[1] : '128';

// 1. Force WASAPI Exclusive Mode (bypasses Windows Audio Engine mixer audiodg.exe)
app.commandLine.appendSwitch('enable-exclusive-audio');

// 2. Hardware buffer size (128 frames = 2.67ms @ 48kHz, 64 frames = 1.33ms)
app.commandLine.appendSwitch('audio-buffer-size', bufferSize);

// 3. Boost internal audio rendering thread priority
app.commandLine.appendSwitch('high-priority-internal-threads');

// 4. Bypass unnecessary audio resampling
app.commandLine.appendSwitch('disable-audio-output-resampler');

// 5. Enable WebMIDI for hardware MIDI controllers / keyboards
app.commandLine.appendSwitch('enable-web-midi');

// 6. Prevent audio autoplay blocking
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

console.log(`[SynthHost] Audio flags configured (buffer size: ${bufferSize})`);

let mainWindow = null;
let powerSaveId = null;

function createWindow() {
  console.log('[SynthHost] Creating BrowserWindow...');
  
  mainWindow = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1024,
    minHeight: 600,
    fullscreen: true, // Launch in fullscreen at start
    title: 'Roland Jupiter-8 Synth (ESI U168XT Low-Latency Host)',
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

  // Auto-grant MIDI permissions for hardware keyboards (ESI U168XT MIDI in, USB MIDI, etc.)
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => {
    if (permission === 'midi' || permission === 'midiSysex') return true;
    return false;
  });

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    if (permission === 'midi' || permission === 'midiSysex') return callback(true);
    return callback(false);
  });

  powerSaveId = powerSaveBlocker.start('prevent-app-suspension');

  console.log('[SynthHost] Loading URL...');
  mainWindow.loadURL('https://jupiter-8-web-synth-693154064316.us-west1.run.app/');

  mainWindow.webContents.on('did-finish-load', () => {
    console.log('[SynthHost] Page finished loading successfully!');
  });

  mainWindow.webContents.on('did-fail-load', (event, errorCode, errorDescription) => {
    console.error(`[SynthHost] Page failed to load: ${errorDescription} (${errorCode})`);
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
  console.log('[SynthHost] app.whenReady fired.');
  createWindow();
});

app.on('window-all-closed', () => {
  if (powerSaveId !== null && powerSaveBlocker.isStarted(powerSaveId)) {
    powerSaveBlocker.stop(powerSaveId);
  }
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
