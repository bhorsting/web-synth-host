// ============================================================================
// ULTRA-LOW LATENCY PRELOAD: DIRECT NATIVE ASIO 2.0 BRIDGE (ESI U168XT)
// ============================================================================

const { ipcRenderer } = require('electron');

let activeAudioContext = null;
let asioStatus = { ready: false, latencySamples: 64, latencyMs: 1.33, driver: 'ASIO 2.0 - ESI U168 XT' };

// Listen for live ASIO status updates from Electron main process
ipcRenderer.on('asio-status-update', (event, status) => {
  asioStatus = status;
  updateHUD();
});
ipcRenderer.invoke('get-asio-status').then(status => {
  if (status) asioStatus = status;
  updateHUD();
});

// ============================================================================
// SETTINGS PERSISTENCE (SHEET & DRIVE URLS DISK SYNC)
// ============================================================================

// Restore persisted settings from disk before React mounts
try {
  const diskSettings = ipcRenderer.sendSync('get-saved-settings-sync') || {};
  let current = {};
  try {
    current = JSON.parse(localStorage.getItem('synth_performance_settings') || '{}');
  } catch (e) {}
  
  let needsUpdate = false;
  for (const [k, v] of Object.entries(diskSettings)) {
    if (v !== undefined && v !== null && (current[k] === undefined || current[k] === '')) {
      current[k] = v;
      needsUpdate = true;
    }
  }

  // Ensure enableSurround51 is enabled for multi-channel ASIO host (ESI Out 1/2 Synth, Out 5/6 Click)
  const targetSurround = diskSettings.enableSurround51 !== undefined ? diskSettings.enableSurround51 : true;
  if (current.enableSurround51 !== targetSurround) {
    current.enableSurround51 = targetSurround;
    needsUpdate = true;
  }

  if (needsUpdate) {
    localStorage.setItem('synth_performance_settings', JSON.stringify(current));
    console.log('[SynthHost] Restored persisted settings from disk to localStorage:', current);
  }
} catch (e) {
  console.warn('[SynthHost] Could not preload settings from disk:', e);
}

// Intercept localStorage.setItem to mirror all settings changes to disk
try {
  const origSetItem = Storage.prototype.setItem;
  Storage.prototype.setItem = function(key, value) {
    origSetItem.call(this, key, value);
    if (key === 'synth_performance_settings') {
      try {
        const parsed = JSON.parse(value);
        ipcRenderer.send('save-settings', parsed);
      } catch (e) {}
    }
  };
} catch (e) {}

// ============================================================================
// SYSTEM BROWSER GOOGLE OAUTH 2.0 BRIDGE
// ============================================================================

let currentGoogleAuthCallback = null;
let savedGoogleToken = null;

// Retrieve cached token from Electron main process
ipcRenderer.invoke('get-google-token').then(token => {
  if (token) {
    savedGoogleToken = token;
    console.log('[SynthHost] Acquired active Google OAuth token from main process');
    updateHUD();
  }
});

// Listen for token received from Electron main process loopback server (via Chrome)
ipcRenderer.on('google-token-received', (event, token) => {
  console.log('[SynthHost] Google OAuth access token received in renderer via browser flow!');
  savedGoogleToken = token;
  updateHUD();

  if (currentGoogleAuthCallback) {
    const cb = currentGoogleAuthCallback;
    currentGoogleAuthCallback = null;
    cb({
      access_token: token,
      expires_in: 3600,
      token_type: 'Bearer',
      scope: 'https://www.googleapis.com/auth/spreadsheets https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/drive.readonly'
    });
  }
});

// Intercept Google Identity Services initTokenClient to use the system browser
function hookGoogleIdentityServices() {
  const myInitTokenClient = function(config) {
    console.log('[SynthHost] Intercepted google.accounts.oauth2.initTokenClient call from web synth!');

    return {
      requestAccessToken: function(opts) {
        console.log('[SynthHost] requestAccessToken triggered by web synth');

        // If we already have a valid token saved, supply it immediately
        if (savedGoogleToken) {
          console.log('[SynthHost] Supplying active Google token directly to synth callback!');
          if (config && typeof config.callback === 'function') {
            setTimeout(() => {
              config.callback({
                access_token: savedGoogleToken,
                expires_in: 3600,
                token_type: 'Bearer',
                scope: config.scope || 'https://www.googleapis.com/auth/spreadsheets'
              });
            }, 20);
            return;
          }
        }

        // Otherwise, open system browser for 1-click Google sign-in!
        console.log('[SynthHost] Requesting OAuth authorization via system browser...');
        currentGoogleAuthCallback = config ? config.callback : null;
        ipcRenderer.invoke('open-browser-auth');
      }
    };
  };

  function enforceHook() {
    try {
      if (!window.google) window.google = {};
      if (!window.google.accounts) window.google.accounts = {};
      if (!window.google.accounts.oauth2) window.google.accounts.oauth2 = {};

      if (window.google.accounts.oauth2.initTokenClient !== myInitTokenClient) {
        window.google.accounts.oauth2.initTokenClient = myInitTokenClient;
        console.log('[SynthHost] Enforced initTokenClient hook on window.google.accounts.oauth2');
      }
    } catch (e) {
      console.warn('[SynthHost] Hook error:', e);
    }
  }

  // Continuously enforce so external scripts (e.g. gsi/client) can never clobber it
  setInterval(enforceHook, 50);
  enforceHook();
}

hookGoogleIdentityServices();

const workletCode = `
class AsioTapProcessor extends AudioWorkletProcessor {
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const len = 128;
    const interleaved = new Float32Array(len * 8);

    if (input && input.length > 0 && input[0] && input[0].length > 0) {
      const ch0 = input[0];
      const ch1 = input.length > 1 ? input[1] : input[0];
      const ch2 = input.length > 2 ? input[2] : null;
      const ch3 = input.length > 3 ? input[3] : null;
      const ch4 = input.length > 4 ? input[4] : null;
      const ch5 = input.length > 5 ? input[5] : null;
      const ch6 = input.length > 6 ? input[6] : null;
      const ch7 = input.length > 7 ? input[7] : null;

      for (let i = 0; i < len; i++) {
        interleaved[i * 8 + 0] = ch0 ? ch0[i] : 0;
        interleaved[i * 8 + 1] = ch1 ? ch1[i] : 0;
        interleaved[i * 8 + 2] = ch2 ? ch2[i] : 0;
        interleaved[i * 8 + 3] = ch3 ? ch3[i] : 0;
        interleaved[i * 8 + 4] = ch4 ? ch4[i] : 0;
        interleaved[i * 8 + 5] = ch5 ? ch5[i] : 0;
        interleaved[i * 8 + 6] = ch6 ? ch6[i] : 0;
        interleaved[i * 8 + 7] = ch7 ? ch7[i] : 0;
      }
    }

    this.port.postMessage(interleaved.buffer, [interleaved.buffer]);
    return true;
  }
}
registerProcessor('asio-tap-processor', AsioTapProcessor);
`;

// Intercept AudioContext to attach the high-speed ASIO tap
const OriginalAudioContext = window.AudioContext || window.webkitAudioContext;
if (OriginalAudioContext) {
  const origConnect = AudioNode.prototype.connect;

  function setupAsioPipeline(ctx) {
    if (ctx._asioInitialized) return;
    ctx._asioInitialized = true;

    console.log('[SynthHost] Primary Playback AudioContext identified! Attaching 8-Channel Native ASIO Tap...');
    activeAudioContext = ctx;
    window.__activeAudioContext = ctx;

    // Master bus configured for 8 discrete channels (Ch 0/1: Synth, Ch 4/5: Click, Ch 2/3/6/7: Aux/Surround)
    ctx._asioMasterBus = ctx.createGain();
    ctx._asioMasterBus._isAsioInternal = true;
    ctx._asioMasterBus.channelCount = 8;
    ctx._asioMasterBus.channelCountMode = 'explicit';
    ctx._asioMasterBus.channelInterpretation = 'discrete';

    // Muted destination connection to pull the audio graph through Chromium's hardware clock
    const silentSink = ctx.createGain();
    silentSink._isAsioInternal = true;
    silentSink.channelCount = 8;
    silentSink.channelCountMode = 'explicit';
    silentSink.channelInterpretation = 'discrete';
    silentSink.gain.value = 0.0;
    origConnect.call(ctx._asioMasterBus, silentSink);
    origConnect.call(silentSink, ctx.destination);

    // Initialize AudioWorklet for low-latency 8-channel Float32 capture
    const blob = new Blob([workletCode], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);

    ctx.audioWorklet.addModule(url).then(() => {
      URL.revokeObjectURL(url);
      ctx._asioTapNode = new AudioWorkletNode(ctx, 'asio-tap-processor', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [8],
        channelCount: 8,
        channelCountMode: 'explicit',
        channelInterpretation: 'discrete'
      });
      ctx._asioTapNode._isAsioInternal = true;
      origConnect.call(ctx._asioMasterBus, ctx._asioTapNode);
      origConnect.call(ctx._asioTapNode, silentSink); // Ensures Blink pulls this node every quantum

      ctx._asioTapNode.port.onmessage = (e) => {
        // Stream raw 128-sample 8-channel Float32 chunks directly to native ASIO driver
        ipcRenderer.send('stream-audio-frame', Buffer.from(e.data));
      };

      console.log('[SynthHost] Native 8-Channel ASIO Tap Processor is LIVE and streaming cleanly!');
      updateHUD();
    }).catch(err => {
      console.error('[SynthHost] Failed to load AudioWorklet module:', err);
    });

    try {
      Object.defineProperty(ctx.destination, 'maxChannelCount', {
        get: () => 8,
        configurable: true
      });
      Object.defineProperty(ctx.destination, 'channelCount', {
        get: () => 8,
        set: () => {},
        configurable: true
      });
      Object.defineProperty(ctx, 'baseLatency', {
        get: () => 128 / (ctx.sampleRate || 48000),
        configurable: true
      });
      Object.defineProperty(ctx, 'outputLatency', {
        get: () => (asioStatus.ready ? asioStatus.latencySamples : 64) / (ctx.sampleRate || 48000),
        configurable: true
      });
    } catch (e) {}

    ctx.addEventListener('statechange', () => {
      updateHUD();
    });
  }

  window.AudioContext = class PatchedAudioContext extends OriginalAudioContext {
    constructor(options = {}) {
      super({ ...options, latencyHint: 0 });
      console.log('[SynthHost] AudioContext instance created (sampleRate: ' + this.sampleRate + ')');
    }
  };
  window.webkitAudioContext = window.AudioContext;

  // Intercept all AudioNode.connect calls to redirect destination connections to our ASIO master bus
  AudioNode.prototype.connect = function(destination) {
    if (this._isAsioInternal) {
      return origConnect.apply(this, arguments);
    }
    if (destination === this.context.destination) {
      setupAsioPipeline(this.context);
      if (this.context._asioMasterBus) {
        const args = Array.from(arguments);
        args[0] = this.context._asioMasterBus;
        return origConnect.apply(this, args);
      }
    }
    return origConnect.apply(this, arguments);
  };

  const origDisconnect = AudioNode.prototype.disconnect;
  AudioNode.prototype.disconnect = function(destination) {
    if (this._isAsioInternal) {
      return origDisconnect.apply(this, arguments);
    }
    if (destination === this.context.destination && this.context._asioMasterBus) {
      const args = Array.from(arguments);
      args[0] = this.context._asioMasterBus;
      return origDisconnect.apply(this, args);
    }
    return origDisconnect.apply(this, arguments);
  };
}

window.addEventListener('DOMContentLoaded', () => {
  createLatencyHUD();
  setInterval(updateHUD, 400);

  // Auto-unlock audio on user gesture
  const unlockAudio = () => {
    if (activeAudioContext && activeAudioContext.state === 'suspended') {
      activeAudioContext.resume().then(updateHUD);
    }
  };
  window.addEventListener('click', unlockAudio);
  window.addEventListener('keydown', unlockAudio);
});

function createLatencyHUD() {
  if (document.getElementById('synth-host-latency-hud')) return;

  const hud = document.createElement('div');
  hud.id = 'synth-host-latency-hud';
  hud.style.cssText = `
    position: fixed;
    top: 12px;
    right: 12px;
    z-index: 2147483647;
    background: rgba(10, 12, 18, 0.94);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    border: 1px solid rgba(34, 197, 94, 0.5);
    border-radius: 8px;
    padding: 10px 14px;
    color: #e5e7eb;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
    font-size: 11px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.7);
    user-select: none;
    line-height: 1.5;
    min-width: 280px;
    max-width: 340px;
  `;

  hud.innerHTML = `
    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; border-bottom: 1px solid rgba(255, 255, 255, 0.1); padding-bottom: 4px;">
      <div style="display: flex; align-items: center; gap: 6px;">
        <span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #22c55e;" id="hud-status-dot"></span>
        <span style="font-weight: 700; color: #4ade80; text-transform: uppercase; letter-spacing: 0.6px; font-size: 10px;">
          ⚡ TRUE ASIO 2.0 HOST
        </span>
      </div>
      <button id="hud-toggle-btn" style="background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); border-radius: 4px; color: #9ca3af; cursor: pointer; font-size: 10px; padding: 1px 6px;">–</button>
    </div>
    <div id="hud-body">
      <div style="display: grid; grid-template-columns: auto auto; gap: 3px 12px; margin-bottom: 6px;">
        <span style="color: #9ca3af;">Driver Pipeline:</span>
        <span style="color: #4ade80; font-weight: 700; text-align: right;">ESI U168XT ASIO</span>

        <span style="color: #9ca3af;">Hardware Buffer:</span>
        <span id="hud-hw-buf" style="color: #60a5fa; font-weight: 600; text-align: right;">64 frames (1.33 ms)</span>

        <span style="color: #9ca3af;">Render Quantum:</span>
        <span style="color: #fff; text-align: right;">128 frames (2.67 ms)</span>

        <span style="color: #9ca3af; font-weight: 600;">Total Latency:</span>
        <span id="hud-total-lat" style="color: #4ade80; font-weight: 800; font-size: 13px; text-align: right;">4.00 ms</span>

        <span style="color: #9ca3af;">Sample Rate:</span>
        <span id="hud-sample-rate" style="color: #fff; text-align: right;">48,000 Hz</span>

        <span style="color: #9ca3af;">Channels:</span>
        <span id="hud-channels" style="color: #a78bfa; font-weight: 600; text-align: right;">8 Ch (1/2 Synth, 5/6 Click)</span>

        <span style="color: #9ca3af;">ASIO Status:</span>
        <span id="hud-asio-status" style="color: #4ade80; font-weight: 600; text-align: right;">ACTIVE (64s)</span>

        <span style="color: #9ca3af;">Google Sheets:</span>
        <span id="hud-google-status" style="color: #facc15; font-weight: 600; text-align: right;">NOT CONNECTED</span>
      </div>

      <div style="display: flex; gap: 6px; margin-top: 6px;">
        <button id="hud-reload-btn" style="flex: 1; background: #15803d; color: white; border: none; border-radius: 4px; padding: 4px 6px; font-size: 10px; cursor: pointer; font-weight: 600;">
          🔄 Restart
        </button>
        <button id="hud-test-btn" style="flex: 1; background: #2563eb; color: white; border: none; border-radius: 4px; padding: 4px 6px; font-size: 10px; cursor: pointer; font-weight: 600;">
          🔊 Test Audio
        </button>
        <button id="hud-auth-btn" style="flex: 1.2; background: #7c3aed; color: white; border: none; border-radius: 4px; padding: 4px 6px; font-size: 10px; cursor: pointer; font-weight: 600;">
          🌐 Google Auth
        </button>
        <button id="hud-resume-btn" style="display: none; flex: 1; background: #ea580c; color: white; border: none; border-radius: 4px; padding: 4px 6px; font-size: 10px; cursor: pointer; font-weight: 600;">
          ▶ Start
        </button>
      </div>

      <div style="margin-top: 6px; padding-top: 4px; border-top: 1px solid rgba(255, 255, 255, 0.08); font-size: 9px; color: #86efac; display: flex; justify-content: space-between;">
        <span>F11 / Esc: Fullscreen</span>
        <span>Out 1/2: Synth | Out 5/6: Click</span>
      </div>
    </div>
  `;

  document.body.appendChild(hud);

  const toggleBtn = hud.querySelector('#hud-toggle-btn');
  const body = hud.querySelector('#hud-body');
  const resumeBtn = hud.querySelector('#hud-resume-btn');
  const reloadBtn = hud.querySelector('#hud-reload-btn');
  const testBtn = hud.querySelector('#hud-test-btn');
  const authBtn = hud.querySelector('#hud-auth-btn');
  let isMinimized = false;

  authBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    savedGoogleToken = null;
    updateHUD();
    ipcRenderer.invoke('clear-google-token');
    console.log('[SynthHost] Initiating manual Google OAuth login in Chrome...');
    ipcRenderer.invoke('open-browser-auth');
  });

  window.__playTestTone = () => {
    if (!activeAudioContext) {
      console.warn('[SynthHost] Cannot test audio: activeAudioContext not ready yet');
      return false;
    }
    if (activeAudioContext.state === 'suspended') {
      activeAudioContext.resume();
    }
    try {
      const merger = activeAudioContext.createChannelMerger(8);
      merger._isAsioInternal = true;
      merger.channelCountMode = 'explicit';
      merger.channelInterpretation = 'discrete';
      origConnect.call(merger, activeAudioContext._asioMasterBus);

      // Tone 1: Synth audio (440 Hz) on Channels 0 & 1 (ESI Out 1 & 2)
      const oscSynth = activeAudioContext.createOscillator();
      const gainSynth = activeAudioContext.createGain();
      gainSynth._isAsioInternal = true;
      gainSynth.gain.value = 0.2;
      oscSynth.frequency.value = 440;
      origConnect.call(oscSynth, gainSynth);
      origConnect.call(gainSynth, merger, 0, 0); // Out 1 (L)
      origConnect.call(gainSynth, merger, 0, 1); // Out 2 (R)

      // Tone 2: Click track (880 Hz beep) on Channels 4 & 5 (ESI Out 5 & 6)
      const oscClick = activeAudioContext.createOscillator();
      const gainClick = activeAudioContext.createGain();
      gainClick._isAsioInternal = true;
      gainClick.gain.value = 0.25;
      oscClick.frequency.value = 880;
      origConnect.call(oscClick, gainClick);
      origConnect.call(gainClick, merger, 0, 4); // Out 5 (Click L)
      origConnect.call(gainClick, merger, 0, 5); // Out 6 (Click R)

      const now = activeAudioContext.currentTime;
      oscSynth.start(now);
      oscSynth.stop(now + 1.2);
      oscClick.start(now);
      oscClick.stop(now + 1.2);

      setTimeout(() => {
        try { merger.disconnect(); } catch {}
      }, 1500);

      console.log('[SynthHost] 🔊 Multi-channel test tone: Ch 1/2 (Out 1/2) 440Hz, Ch 5/6 (Out 5/6 Click) 880Hz');
      return true;
    } catch (err) {
      console.error('[SynthHost] Test tone error:', err);
      return false;
    }
  };

  testBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    window.__playTestTone();
  });

  toggleBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    isMinimized = !isMinimized;
    body.style.display = isMinimized ? 'none' : 'block';
    toggleBtn.textContent = isMinimized ? '+' : '–';
  });

  resumeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (activeAudioContext) {
      activeAudioContext.resume().then(updateHUD);
    }
  });

  reloadBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    ipcRenderer.invoke('restart-asio').then(() => {
      window.location.reload();
    });
  });
}

function updateHUD() {
  const elHwBuf = document.getElementById('hud-hw-buf');
  const elTotal = document.getElementById('hud-total-lat');
  const elRate = document.getElementById('hud-sample-rate');
  const elStatus = document.getElementById('hud-asio-status');
  const elDot = document.getElementById('hud-status-dot');
  const resumeBtn = document.getElementById('hud-resume-btn');

  const sr = (activeAudioContext && activeAudioContext.sampleRate) ? activeAudioContext.sampleRate : 48000;
  const quantumMs = (128 / sr * 1000); // 2.67ms @ 48kHz
  const hwFrames = asioStatus.ready ? (asioStatus.latencySamples || 64) : 64;
  const hwMs = (hwFrames / sr * 1000);
  const totalMs = (quantumMs + hwMs).toFixed(2);

  if (elHwBuf) {
    elHwBuf.textContent = `${hwFrames} frames (${hwMs.toFixed(2)} ms)`;
  }
  if (elTotal) {
    elTotal.textContent = `${totalMs} ms`;
    elTotal.style.color = '#4ade80';
  }
  if (elRate) {
    elRate.textContent = `${sr.toLocaleString()} Hz`;
  }
  if (elStatus) {
    if (asioStatus.ready) {
      elStatus.textContent = `STREAMING (${hwFrames}s)`;
      elStatus.style.color = '#4ade80';
      if (elDot) elDot.style.background = '#22c55e';
    } else if (asioStatus.error) {
      elStatus.textContent = `ERR: ${asioStatus.error.substring(0, 18)}`;
      elStatus.title = asioStatus.error;
      elStatus.style.color = '#ef4444';
      if (elDot) elDot.style.background = '#ef4444';
    } else {
      elStatus.textContent = 'CONNECTING...';
      elStatus.style.color = '#facc15';
      if (elDot) elDot.style.background = '#eab308';
    }
  }

  if (activeAudioContext && activeAudioContext.state !== 'running') {
    if (resumeBtn) resumeBtn.style.display = 'block';
  } else {
    if (resumeBtn) resumeBtn.style.display = 'none';
  }

  const elGoogle = document.getElementById('hud-google-status');
  const authBtn = document.getElementById('hud-auth-btn');
  if (elGoogle) {
    if (savedGoogleToken) {
      elGoogle.textContent = 'CONNECTED';
      elGoogle.style.color = '#4ade80';
      if (authBtn) authBtn.textContent = '🔄 Re-auth Google';
    } else {
      elGoogle.textContent = 'NOT CONNECTED';
      elGoogle.style.color = '#facc15';
      if (authBtn) authBtn.textContent = '🌐 Google Auth';
    }
  }
}
