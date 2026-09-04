const { app, BrowserWindow } = require('electron');

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  await win.loadURL('https://jupiter-8-web-synth-693154064316.us-west1.run.app/');

  const info = await win.webContents.executeJavaScript(`
    (async () => {
      let audioOutputs = [];
      try {
        if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
          const devices = await navigator.mediaDevices.enumerateDevices();
          audioOutputs = devices.filter(d => d.kind === 'audiooutput').map(d => ({ label: d.label, id: d.deviceId }));
        }
      } catch (e) {
        audioOutputs = [{ error: e.message }];
      }

      const ctxInteractive = new AudioContext({ latencyHint: 'interactive' });
      const ctxZero = new AudioContext({ latencyHint: 0 });
      const ctxBalanced = new AudioContext({ latencyHint: 'balanced' });
      const ctxPlayback = new AudioContext({ latencyHint: 'playback' });

      return {
        audioOutputs,
        ctxInteractive: {
          sampleRate: ctxInteractive.sampleRate,
          baseLatency: ctxInteractive.baseLatency,
          outputLatency: ctxInteractive.outputLatency
        },
        ctxZero: {
          sampleRate: ctxZero.sampleRate,
          baseLatency: ctxZero.baseLatency,
          outputLatency: ctxZero.outputLatency
        },
        ctxBalanced: {
          sampleRate: ctxBalanced.sampleRate,
          baseLatency: ctxBalanced.baseLatency,
          outputLatency: ctxBalanced.outputLatency
        },
        ctxPlayback: {
          sampleRate: ctxPlayback.sampleRate,
          baseLatency: ctxPlayback.baseLatency,
          outputLatency: ctxPlayback.outputLatency
        }
      };
    })()
  `);

  console.log('=== AUDIO DIAGNOSTICS ===');
  console.log(JSON.stringify(info, null, 2));
  app.quit();
});
