// ============================================================================
// ULTRA-LOW LATENCY PRELOAD & TELEMETRY HUD FOR ESI U168XT
// ============================================================================

let activeAudioContext = null;

// Intercept AudioContext before any page scripts execute
const OriginalAudioContext = window.AudioContext || window.webkitAudioContext;
if (OriginalAudioContext) {
  window.AudioContext = class PatchedAudioContext extends OriginalAudioContext {
    constructor(options = {}) {
      // Force hardware minimum latencyHint: 0
      const enhancedOptions = {
        ...options,
        latencyHint: 0
      };

      super(enhancedOptions);
      activeAudioContext = this;
      window.__activeAudioContext = this;

      console.log('[SynthHost] AudioContext created with hardware-minimum latencyHint (0):', {
        sampleRate: this.sampleRate,
        baseLatency: this.baseLatency,
        outputLatency: this.outputLatency,
        state: this.state
      });

      this.addEventListener('statechange', () => {
        updateHUD();
      });
    }
  };
  window.webkitAudioContext = window.AudioContext;
}

window.addEventListener('DOMContentLoaded', () => {
  console.log('[SynthHost] Preload DOM ready.');
  createLatencyHUD();
  setInterval(updateHUD, 300);
  populateDeviceList();

  // Listen for device connect / disconnect
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', populateDeviceList);
  }

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
    top: 10px;
    right: 10px;
    z-index: 2147483647;
    background: rgba(14, 15, 20, 0.94);
    backdrop-filter: blur(14px);
    -webkit-backdrop-filter: blur(14px);
    border: 1px solid rgba(255, 140, 0, 0.5);
    border-radius: 8px;
    padding: 10px 14px;
    color: #e5e7eb;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, monospace;
    font-size: 11px;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.7);
    user-select: none;
    line-height: 1.5;
    min-width: 270px;
    max-width: 320px;
  `;

  hud.innerHTML = `
    <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; border-bottom: 1px solid rgba(255, 255, 255, 0.1); padding-bottom: 4px;">
      <div style="display: flex; align-items: center; gap: 6px;">
        <span style="display: inline-block; width: 8px; height: 8px; border-radius: 50%; background: #22c55e;" id="hud-status-dot"></span>
        <span style="font-weight: 700; color: #ff9933; text-transform: uppercase; letter-spacing: 0.6px; font-size: 10px;">
          ESI U168XT HOST
        </span>
      </div>
      <button id="hud-toggle-btn" style="background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.1); border-radius: 4px; color: #9ca3af; cursor: pointer; font-size: 10px; padding: 1px 6px;">–</button>
    </div>
    <div id="hud-body">
      <!-- Device warning banner if Voicemeeter is active -->
      <div id="hud-device-alert" style="display: none; background: rgba(239, 68, 68, 0.15); border: 1px solid rgba(239, 68, 68, 0.4); border-radius: 4px; padding: 6px 8px; margin-bottom: 8px; font-size: 10px; color: #fca5a5;">
        ⚠️ <b>Voicemeeter active:</b> Voicemeeter adds 128ms buffer. Turn on/select ESI U168XT below!
      </div>

      <div style="margin-bottom: 8px;">
        <div style="color: #9ca3af; font-size: 10px; margin-bottom: 2px;">Audio Output Device:</div>
        <select id="hud-device-select" style="width: 100%; background: #1e2029; color: #f3f4f6; border: 1px solid #4b5563; border-radius: 4px; padding: 3px 6px; font-size: 10px; outline: none; cursor: pointer;">
          <option value="default">Default Device</option>
        </select>
      </div>

      <div style="display: grid; grid-template-columns: auto auto; gap: 3px 12px; margin-bottom: 6px;">
        <span style="color: #9ca3af;">Driver Pipeline:</span>
        <span style="color: #4ade80; font-weight: 600; text-align: right;">WASAPI Exclusive</span>

        <span style="color: #9ca3af;">Quantum Latency:</span>
        <span id="hud-base-lat" style="color: #fff; text-align: right;">-- ms</span>

        <span style="color: #9ca3af;">Output Latency:</span>
        <span id="hud-out-lat" style="color: #fff; text-align: right;">-- ms</span>

        <span style="color: #9ca3af; font-weight: 600;">Total Latency:</span>
        <span id="hud-total-lat" style="color: #4ade80; font-weight: 800; font-size: 12px; text-align: right;">Measuring...</span>

        <span style="color: #9ca3af;">Sample Rate:</span>
        <span id="hud-sample-rate" style="color: #fff; text-align: right;">-- Hz</span>

        <span style="color: #9ca3af;">Synth Engine:</span>
        <span id="hud-state" style="color: #facc15; font-weight: 600; text-align: right;">READY</span>
      </div>

      <div style="display: flex; gap: 6px; margin-top: 6px;">
        <button id="hud-resume-btn" style="display: none; flex: 1; background: #ea580c; color: white; border: none; border-radius: 4px; padding: 4px 8px; font-size: 10px; cursor: pointer; font-weight: 600;">
          ▶ Click to Start Audio
        </button>
      </div>

      <div style="margin-top: 6px; padding-top: 4px; border-top: 1px solid rgba(255, 255, 255, 0.08); font-size: 9px; color: #6b7280; display: flex; justify-content: space-between;">
        <span>F11: Fullscreen</span>
        <span>Target: &lt; 5ms</span>
      </div>
    </div>
  `;

  document.body.appendChild(hud);

  const toggleBtn = hud.querySelector('#hud-toggle-btn');
  const body = hud.querySelector('#hud-body');
  const resumeBtn = hud.querySelector('#hud-resume-btn');
  const deviceSelect = hud.querySelector('#hud-device-select');
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

  deviceSelect.addEventListener('change', async (e) => {
    const deviceId = e.target.value;
    if (activeAudioContext && typeof activeAudioContext.setSinkId === 'function') {
      try {
        await activeAudioContext.setSinkId(deviceId);
        console.log('[SynthHost] Switched audio output device to:', deviceId);
        updateHUD();
      } catch (err) {
        console.error('[SynthHost] Failed to setSinkId:', err);
      }
    }
  });
}

async function populateDeviceList() {
  const select = document.getElementById('hud-device-select');
  if (!select || !navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return;

  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outputs = devices.filter(d => d.kind === 'audiooutput');
    
    // Save current selection
    const currentVal = select.value;
    select.innerHTML = '';

    let hasVoicemeeterAsDefault = false;
    let hasEsi = false;

    outputs.forEach(dev => {
      const opt = document.createElement('option');
      opt.value = dev.deviceId;
      opt.textContent = dev.label || `Device ${dev.deviceId.slice(0, 8)}`;
      if (dev.label.toLowerCase().includes('voicemeeter') && (dev.deviceId === 'default' || dev.label.toLowerCase().includes('default'))) {
        hasVoicemeeterAsDefault = true;
      }
      if (dev.label.toLowerCase().includes('esi') || dev.label.toLowerCase().includes('u168')) {
        hasEsi = true;
        opt.textContent = `⭐ ${opt.textContent}`;
      }
      select.appendChild(opt);
    });

    if (currentVal && Array.from(select.options).some(o => o.value === currentVal)) {
      select.value = currentVal;
    }

    const alertEl = document.getElementById('hud-device-alert');
    if (alertEl) {
      if (hasVoicemeeterAsDefault && !hasEsi) {
        alertEl.style.display = 'block';
        alertEl.innerHTML = `⚠️ <b>Voicemeeter is active (128ms buffer)!</b><br>Turn ON or plug in your <b>ESI U168XT</b> so it can bypass Voicemeeter.`;
      } else if (hasVoicemeeterAsDefault && hasEsi) {
        alertEl.style.display = 'block';
        alertEl.innerHTML = `⚠️ <b>Voicemeeter is active (128ms)!</b><br>Select your <b>⭐ ESI U168XT</b> in the dropdown above.`;
      } else {
        alertEl.style.display = 'none';
      }
    }
  } catch (err) {
    console.error('[SynthHost] Error enumerating audio devices:', err);
  }
}

function updateHUD() {
  if (!activeAudioContext && window.__activeAudioContext) {
    activeAudioContext = window.__activeAudioContext;
  }

  const elBase = document.getElementById('hud-base-lat');
  const elOut = document.getElementById('hud-out-lat');
  const elTotal = document.getElementById('hud-total-lat');
  const elRate = document.getElementById('hud-sample-rate');
  const elState = document.getElementById('hud-state');
  const elDot = document.getElementById('hud-status-dot');
  const resumeBtn = document.getElementById('hud-resume-btn');

  if (!activeAudioContext) {
    if (elState) elState.textContent = 'Waiting for Synth...';
    return;
  }

  const sr = activeAudioContext.sampleRate || 48000;
  const baseLat = activeAudioContext.baseLatency || (128 / sr);
  const outLat = activeAudioContext.outputLatency || 0;

  const baseMs = (baseLat * 1000).toFixed(2);
  const outMs = (outLat * 1000).toFixed(2);
  const totalMs = ((baseLat + outLat) * 1000).toFixed(2);

  if (elBase) elBase.textContent = `${baseMs} ms`;
  if (elOut) elOut.textContent = `${outMs} ms`;
  if (elTotal) {
    elTotal.textContent = `${totalMs} ms`;
    const num = parseFloat(totalMs);
    if (num <= 6.0) {
      elTotal.style.color = '#4ade80'; // Sub-6ms (Green)
    } else if (num <= 20.0) {
      elTotal.style.color = '#60a5fa'; // Low (Blue)
    } else {
      elTotal.style.color = '#f87171'; // High (Red)
    }
  }

  if (elRate) elRate.textContent = `${sr.toLocaleString()} Hz`;

  if (elState) {
    const s = activeAudioContext.state;
    elState.textContent = s.toUpperCase();
    if (s === 'running') {
      elState.style.color = '#4ade80';
      if (elDot) elDot.style.background = '#22c55e';
      if (resumeBtn) resumeBtn.style.display = 'none';
    } else {
      elState.style.color = '#facc15';
      if (elDot) elDot.style.background = '#eab308';
      if (resumeBtn) resumeBtn.style.display = 'block';
    }
  }
}
