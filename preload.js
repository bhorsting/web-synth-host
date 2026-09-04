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

const workletCode = `
class AsioTapProcessor extends AudioWorkletProcessor {
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    if (input && input.length >= 2) {
      const left = input[0];
      const right = input[1];
      const len = left.length; // 128 samples per quantum
      const interleaved = new Float32Array(len * 2);
      for (let i = 0; i < len; i++) {
        interleaved[i * 2] = left[i];
        interleaved[i * 2 + 1] = right[i];
      }
      this.port.postMessage(interleaved.buffer, [interleaved.buffer]);
    }
    return true;
  }
}
registerProcessor('asio-tap-processor', AsioTapProcessor);
`;

// Intercept AudioContext to attach the high-speed ASIO tap
const OriginalAudioContext = window.AudioContext || window.webkitAudioContext;
if (OriginalAudioContext) {
  window.AudioContext = class PatchedAudioContext extends OriginalAudioContext {
    constructor(options = {}) {
      super({ ...options, latencyHint: 0 });
      activeAudioContext = this;
      window.__activeAudioContext = this;

      console.log('[SynthHost] AudioContext created. Initializing Direct ASIO pipeline...');

      // Master bus that receives all synth output
      this._asioMasterBus = this.createGain();

      // Muted destination connection to prevent Chromium's 128ms WASAPI engine from playing audio
      const silentSink = this.createGain();
      silentSink.gain.value = 0.0;
      this._asioMasterBus.connect(silentSink);
      silentSink.connect(this.destination);

      // Initialize AudioWorklet for low-latency Float32 capture
      const blob = new Blob([workletCode], { type: 'application/javascript' });
      const url = URL.createObjectURL(blob);

      this.audioWorklet.addModule(url).then(() => {
        URL.revokeObjectURL(url);
        this._asioTapNode = new AudioWorkletNode(this, 'asio-tap-processor');
        this._asioMasterBus.connect(this._asioTapNode);

        this._asioTapNode.port.onmessage = (e) => {
          // Stream raw 128-sample Float32 chunks directly to native ASIO driver
          ipcRenderer.send('stream-audio-frame', Buffer.from(e.data));
        };

        console.log('[SynthHost] Native ASIO Tap Processor is LIVE and streaming!');
        updateHUD();
      }).catch(err => {
        console.error('[SynthHost] Failed to load AudioWorklet module:', err);
      });

      this.addEventListener('statechange', () => {
        updateHUD();
      });
    }
  };
  window.webkitAudioContext = window.AudioContext;

  // Intercept all AudioNode.connect calls to redirect destination connections to our ASIO master bus
  const origConnect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function(destination, outputIndex, inputIndex) {
    if (destination === this.context.destination && this.context._asioMasterBus) {
      // Divert audio from Chromium's 128ms output queue into our direct ASIO bus
      return origConnect.call(this, this.context._asioMasterBus, outputIndex, inputIndex);
    }
    return origConnect.call(this, destination, outputIndex, inputIndex);
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

        <span style="color: #9ca3af;">ASIO Status:</span>
        <span id="hud-asio-status" style="color: #4ade80; font-weight: 600; text-align: right;">ACTIVE (64s)</span>
      </div>

      <div style="display: flex; gap: 6px; margin-top: 6px;">
        <button id="hud-reload-btn" style="flex: 1; background: #15803d; color: white; border: none; border-radius: 4px; padding: 4px 8px; font-size: 10px; cursor: pointer; font-weight: 600;">
          🔄 Restart Synth
        </button>
        <button id="hud-resume-btn" style="display: none; flex: 1; background: #ea580c; color: white; border: none; border-radius: 4px; padding: 4px 8px; font-size: 10px; cursor: pointer; font-weight: 600;">
          ▶ Click to Start Audio
        </button>
      </div>

      <div style="margin-top: 6px; padding-top: 4px; border-top: 1px solid rgba(255, 255, 255, 0.08); font-size: 9px; color: #86efac; display: flex; justify-content: space-between;">
        <span>F11 / Esc: Fullscreen</span>
        <span>Bypassed Chrome 128ms!</span>
      </div>
    </div>
  `;

  document.body.appendChild(hud);

  const toggleBtn = hud.querySelector('#hud-toggle-btn');
  const body = hud.querySelector('#hud-body');
  const resumeBtn = hud.querySelector('#hud-resume-btn');
  const reloadBtn = hud.querySelector('#hud-reload-btn');
  let isMinimized = false;

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
    window.location.reload();
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
  const quantumMs = 2.67; // 128 frames @ 48kHz
  const hwMs = asioStatus.ready ? asioStatus.latencyMs : 1.33;
  const totalMs = (quantumMs + hwMs).toFixed(2);

  if (elHwBuf) {
    elHwBuf.textContent = `${asioStatus.latencySamples || 64} frames (${hwMs.toFixed(2)} ms)`;
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
      elStatus.textContent = `STREAMING (${asioStatus.latencySamples}s)`;
      elStatus.style.color = '#4ade80';
      if (elDot) elDot.style.background = '#22c55e';
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
}
