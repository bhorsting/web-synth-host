# Jupiter-8 Web Synth - Ultra-Low Latency Host

Dedicated Electron host for `https://jupiter-8-web-synth-693154064316.us-west1.run.app/` engineered for sub-5ms audio latency with the **ESI U168XT** audio interface on Windows.

## Why This App Exists
Standard Chrome on Windows runs in **WASAPI Shared Mode** through the Windows Audio Engine mixer (`audiodg.exe`). This adds ~58ms of total round-trip buffering latency.

This host bypasses the Windows mixer entirely by forcing **WASAPI Exclusive Mode** directly to the ESI U168XT hardware endpoint with a hardware buffer size of **128 samples** (2.67ms @ 48kHz) and in-process audio rendering.

## Hardware Tuning (ESI U168XT)
1. **Windows Sound Settings**:
   - Right click Speaker icon -> **Sound Settings** -> **More sound settings**.
   - Select **ESI U168XT** -> **Properties** -> **Advanced**.
   - Ensure both checkboxes are enabled:
     - [x] *Allow applications to take exclusive control of this device*
     - [x] *Give exclusive mode applications priority*
   - Set Default Format to **24-bit, 48000 Hz** (or 44100 Hz).
2. **ESI U168XT Control Panel**:
   - Set ASIO / Driver buffer size to **64 samples** or **128 samples**.

## Running the App
Double-click `run.bat` or run:
```powershell
npm start
```

## Hotkeys
- **F11**: Fullscreen toggle (optimized for touchscreens)
- **F12**: Toggle Developer Tools
- **– / +**: Minimize or expand the real-time Latency Telemetry HUD
