// Run with: npm run test:count-in (uses real Web Audio and Librosa in the app Python environment).
const { app, BrowserWindow } = require('electron')
const { createServer } = require('node:http')
const { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync } = require('node:fs')
const { join, extname } = require('node:path')
const { tmpdir } = require('node:os')
const { spawn } = require('node:child_process')
const assert = require('node:assert/strict')

const profile = mkdtempSync(join(tmpdir(), 'stemkit-count-in-'))
app.setPath('userData', profile)
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
const root = join(__dirname, '../out/renderer')
  function wav(silent) {
    const rate = 11025, length = rate * 48;
    const bytes = new Uint8Array(44 + length * 2), view = new DataView(bytes.buffer);
    function text(offset, value) { for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i); }
    text(0, 'RIFF'); view.setUint32(4, bytes.length - 8, true); text(8, 'WAVE'); text(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, rate, true); view.setUint32(28, rate * 2, true); view.setUint16(32, 2, true);
    view.setUint16(34, 16, true); text(36, 'data'); view.setUint32(40, length * 2, true);
    if (!silent) for (const [from, until, bpm] of [[0.1, 24, 90], [24.1, 48, 150]]) {
      for (let t = from; t < until; t += 60 / bpm) {
        const first = Math.round(t * rate);
        for (let i = 0; i < 600 && first + i < length; i++) view.setInt16(44 + (first + i) * 2, Math.round(Math.sin(i * 0.7) * Math.exp(-i / 90) * 16000), true);
      }
    }
    return bytes;
  }

const fixture = `
  const settings = { countInBars: 0, shifts: 1, htdemucsFt: false, roformerVocals: false, gpuSplit: false, hideVideo: false, exportFormat: 'wav' };
  const songs = [
    { videoId: 'local-rhythm', title: 'Rhythm fixture', source: 'local', duration: 48, addedAt: 1 },
    { videoId: 'local-silence', title: 'Silence fixture', source: 'local', duration: 48, addedAt: 1 },
    { videoId: 'video-rhythm', title: 'Video fixture', duration: 48, addedAt: 1 }
  ];
  const tempo = {};
  const pans = {};
  window.fixturePans = pans;
  window.fixtureTempo = tempo;
  const subscribers = new Set();
  window.waveformPaints = {};
  const clearRect = CanvasRenderingContext2D.prototype.clearRect;
  CanvasRenderingContext2D.prototype.clearRect = function() {
    const label = this.canvas.getAttribute('aria-label');
    if (label?.endsWith(' waveform')) window.waveformPaints[label] = (window.waveformPaints[label] || 0) + 1;
    return clearRect.apply(this, arguments);
  };
  window.audioStarts = [];
  window.audioSources = [];
  window.videoPlays = 0;
  window.videoPauses = 0;
  window.fixtureSettings = settings;
  window.settingsEchoDelay = 0;
  window.tempoResponseDelay = 0;
  const start = AudioBufferSourceNode.prototype.start;
  const stop = AudioBufferSourceNode.prototype.stop;
  const connect = AudioNode.prototype.connect;
  AudioNode.prototype.connect = function(target) { this.fixtureOutput = target; return connect.apply(this, arguments); };
  AudioBufferSourceNode.prototype.stop = function() { this.fixtureStopped = true; return stop.apply(this, arguments); };
  AudioBufferSourceNode.prototype.start = function(when, offset) {
    window.audioStarts.push({ when, offset: offset || 0, duration: this.buffer.duration });
    this.fixtureWhen = when;
    window.audioSources.push(this);
    return start.apply(this, arguments);
  };
  ${wav.toString()}
  window.stemkit = {
    envStatus: async () => ({ ready: true }), listSongs: async () => songs,
    exportStem: async (...args) => { window.fixtureExport = args; return { saved: false }; },
    exportAllStems: async (...args) => { window.fixtureExportAll = args; return { saved: false }; },
    getSettings: async () => ({ ...settings }), appVersion: async () => 'test',
    getAppVersion: async () => 'test', getThumb: async () => null,
    onSettingsChange: (cb) => { subscribers.add(cb); return () => subscribers.delete(cb); },
    onJobEvent: () => () => {}, onEnvEvent: () => () => {}, onUpdateEvent: () => () => {},
    onShowAbout: () => () => {}, onThumbCached: () => () => {},
    setSettings: async (patch) => {
      Object.assign(settings, patch);
      const saved = { ...settings };
      setTimeout(() => subscribers.forEach(cb => cb(saved)), window.settingsEchoDelay);
      return saved;
    },
    getBuffers: async (id) => ({ drums: wav(id === 'local-silence') }),
    getStemPan: async id => ({ ...pans[id] }), setStemPan: async (id, value) => { pans[id] = { ...value }; },
    getTempoSettings: async (id) => tempo[id] || { mode: 'auto', manualBpm: null, beatsPerBar: 4 },
    setTempoSettings: async (id, value) => { tempo[id] = value; },
    analyzeTempo: async (id, requestId) => {
      window.tempoRequests = (window.tempoRequests || 0) + 1;
      if (window.failTempo) throw new Error('Missing original mix');
      const response = await fetch('/tempo?videoId=' + encodeURIComponent(id) + '&requestId=' + encodeURIComponent(requestId));
      if (!response.ok) throw new Error(await response.text());
      const result = await response.json();
      if (window.tempoResponseDelay) await new Promise(resolve => setTimeout(resolve, window.tempoResponseDelay));
      window.lastAnalysis = result;
      return result;
    },
    cancelTempoAnalysis: async (requestId) => { await fetch('/cancel-tempo?requestId=' + encodeURIComponent(requestId)); }
  };
  window.YT = { Player: class {
    constructor(el, options) { this.position = 0; this.options = options; setTimeout(() => options.events.onReady(), 0); }
    playVideo() { window.videoPlays++; this.options.events.onStateChange({ data: 1 }); }
    pauseVideo() { window.videoPauses++; }
    seekTo(position) { this.position = position; }
    getCurrentTime() { return this.position; }
    getDuration() { return 48; }
    getAvailablePlaybackRates() { return [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2]; }
    setPlaybackRate(rate) { window.videoRate = rate; }
    getPlaybackRate() { return window.videoRate || 1; }
    mute() {} destroy() {}
  }};
`

let window, server
const analysisJobs = new Map()
const analysisCache = new Map()
const evaluate = (fn, ...args) => window.webContents.executeJavaScript(`(${fn.toString()})(...${JSON.stringify(args)})`, true)
async function waitFor(fn, message, timeout = 60000) {
  const until = Date.now() + timeout
  while (Date.now() < until) {
    if (await evaluate(fn)) return
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error(message)
}
const clickText = (text) => evaluate((text) => {
  const button = [...document.querySelectorAll('button')].find(el => el.textContent.trim() === text)
  if (!button) throw new Error('Button missing: ' + text)
  button.focus(); button.click()
}, text)
const play = () => evaluate(() => document.querySelector('button[aria-label="Play"]').click())
const pause = () => evaluate(() => document.querySelector('button[aria-label="Pause or cancel count-in"]').click())
const select = (label, value) => evaluate((label, value) => {
  const control = document.querySelector('select[aria-label="' + label + '"]')
  control.value = value; control.dispatchEvent(new Event('change', { bubbles: true }))
}, label, value)
const key = (code, value) => evaluate((code, value) => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { code, key: value, bubbles: true, cancelable: true })), code, value)
async function enterBpm(value) {
  window.show()
  window.focus()
  await evaluate(() => {
    const input = document.querySelector('input[aria-label="Tempo BPM"]')
    input.focus(); input.select()
  })
  await window.webContents.insertText(value)
  await evaluate(() => document.querySelector('input[aria-label="Tempo BPM"]').blur())
}
async function chooseSong(title) {
  await evaluate((title) => {
    const label = [...document.querySelectorAll('aside button span')].find(el => el.textContent.trim() === title)
    if (!label) throw new Error('Song missing: ' + title)
    label.closest('button').click()
  }, title)
  await waitFor(() => !!document.querySelector('button[aria-label="Play"]:not(:disabled)') && !!document.querySelector('select[aria-label="Count-in"]:not(:disabled)'), 'Song did not finish loading')
}

async function run() {
  await app.whenReady()
  const python = process.env.STEMKIT_TEST_PYTHON || join(app.getPath('appData'), 'StemKit', 'venv', process.platform === 'win32' ? 'Scripts' : 'bin', process.platform === 'win32' ? 'python.exe' : 'python');
  if (!existsSync(python)) throw new Error('Set STEMKIT_TEST_PYTHON to a Python environment with librosa==0.11.0');
  writeFileSync(join(profile, 'rhythm.wav'), wav(false));
  writeFileSync(join(profile, 'silence.wav'), wav(true));
  server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const requestId = url.searchParams.get('requestId');
    if (url.pathname === '/cancel-tempo') {
      analysisJobs.get(requestId)?.kill(); res.end(); return;
    }
    if (url.pathname === '/tempo') {
      const id = url.searchParams.get('videoId');
      if (analysisCache.has(id)) { res.end(JSON.stringify(analysisCache.get(id))); return; }
      const source = join(profile, id === 'local-silence' ? 'silence.wav' : 'rhythm.wav');
      const child = spawn(python, [join(__dirname, '../python/tempo.py'), '--input', source], {
        env: { ...process.env, NUMBA_CACHE_DIR: process.env.NUMBA_CACHE_DIR || join(profile, 'numba'),
          OPENBLAS_NUM_THREADS: '1', VECLIB_MAXIMUM_THREADS: '1', OMP_NUM_THREADS: '1', MKL_NUM_THREADS: '1' }
      });
      analysisJobs.set(requestId, child);
      let output = '', error = '';
      child.stdout.on('data', chunk => { output += chunk; });
      child.stderr.on('data', chunk => { error += chunk; });
      child.on('error', err => { res.statusCode = 500; res.end(err.message); });
      child.on('close', code => {
        analysisJobs.delete(requestId);
        if (code !== 0) { res.statusCode = 500; res.end(error || 'Analysis cancelled'); return; }
        try { const points = JSON.parse(output); analysisCache.set(id, points); res.end(JSON.stringify(points)); }
        catch { res.statusCode = 500; res.end('Invalid tempo analysis'); }
      });
      return;
    }
    if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(fixture); return }
    const name = req.url === '/' ? 'index.html' : req.url.split('?')[0].slice(1)
    try {
      let data = readFileSync(join(root, name))
      res.setHeader('Content-Type', { '.js': 'text/javascript', '.html': 'text/html', '.css': 'text/css' }[extname(name)] || 'application/octet-stream')
      if (name === 'index.html') data = data.toString().replace('<head>', '<head><script src="/fixture.js"></script>')
      res.end(data)
    } catch { res.statusCode = 404; res.end() }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  window = new BrowserWindow({ show: false, width: 1350, height: 950, webPreferences: { backgroundThrottling: false } })
  window.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) console.error('Renderer:', message)
  })
  await window.loadURL('http://127.0.0.1:' + server.address().port)
  await waitFor(() => document.body.textContent.includes('Rhythm fixture'), 'App did not load')
  await chooseSong('Rhythm fixture')
  assert.deepEqual(await evaluate(() => [...document.querySelector('select[aria-label="Count-in"]').options].map(option => [option.value, option.textContent])), [['0', 'Off'], ['1', '1 bar'], ['2', '2 bars'], ['3', '3 bars'], ['4', '4 bars']])
  assert.ok(await evaluate(() => {
    const count = document.querySelector('[aria-labelledby="count-in-label"]')
    const transport = document.querySelector('button[aria-label="Play"]').closest('.glass')
    return transport.contains(count) && !document.querySelector('[aria-label="Metronome track"]').contains(count)
  }), 'Count-in controls must stay beside playback controls')
  assert.ok(await evaluate(() => !document.querySelector('button[role="switch"][aria-label="Metronome"]')), 'Dedicated metronome toggle must be removed')
  assert.ok(await evaluate(() => !document.querySelector('[aria-label="Metronome track"]').textContent.includes('Click track')), 'Placeholder click-track text remains')
  await evaluate(() => document.querySelector('button[aria-label="Export metronome"]').click())
  await waitFor(() => !!window.fixtureExport, 'Metronome download did not call the export API')
  assert.deepEqual(await evaluate(() => window.fixtureExport), ['local-rhythm', 'metronome', { mode: 'auto', manualBpm: null, beatsPerBar: 4 }])
  await clickText('Export everything')
  assert.deepEqual(await evaluate(() => window.fixtureExportAll), ['local-rhythm', { mode: 'auto', manualBpm: null, beatsPerBar: 4 }])
  await waitFor(() => {
    const canvas = document.querySelector('canvas[aria-label="Metronome waveform"]')
    if (!canvas || !canvas.width || !canvas.height) return false
    return canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data.some((value, index) => index % 4 === 3 && value > 0)
  }, 'Metronome waveform did not render actual beat data')
  await new Promise(resolve => setTimeout(resolve, 250))
  await evaluate(() => { window.waveformPaints = {} })
  app.getAppMetrics()
  await new Promise(resolve => setTimeout(resolve, 1500))
  const pausedCpu = app.getAppMetrics().find(metric => metric.pid === window.webContents.getOSProcessId())?.cpu.percentCPUUsage
  const idlePaints = await evaluate(() => window.waveformPaints)
  console.log('Paused waveform measurements:', JSON.stringify({ paints: idlePaints, rendererCpuPercent: pausedCpu }))
  assert.ok(Object.values(idlePaints).every(paints => paints === 0), 'Paused waveforms keep redrawing')
  const originalBounds = window.getBounds()
  const oldCanvasWidth = await evaluate(() => document.querySelector('canvas[aria-label="Metronome waveform"]').width)
  await evaluate(width => { window.oldCanvasWidth = width }, oldCanvasWidth)
  window.setSize(originalBounds.width - 150, originalBounds.height)
  await waitFor(() => document.querySelector('canvas[aria-label="Metronome waveform"]').width !== window.oldCanvasWidth, 'Paused waveform did not resize')
  assert.notEqual(await evaluate(() => document.querySelector('canvas[aria-label="Metronome waveform"]').width), oldCanvasWidth)
  assert.ok(await evaluate(() => window.waveformPaints['Metronome waveform'] > 0), 'Paused resize did not repaint')
  window.setBounds(originalBounds)
  await waitFor(() => document.querySelector('canvas[aria-label="Metronome waveform"]').width === window.oldCanvasWidth, 'Paused waveform did not repaint at restored size')

  await evaluate(() => {
    const canvas = document.querySelector('canvas[aria-label="Metronome waveform"]')
    const rect = canvas.getBoundingClientRect()
    canvas.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: rect.left + rect.width / 4, clientY: rect.top + rect.height / 2 }))
  })
  await waitFor(() => document.body.textContent.includes('0:12'), 'Clicking metronome waveform did not seek')
  await waitFor(() => {
    const canvas = document.querySelector('canvas[aria-label="Metronome waveform"]')
    const pixels = canvas.getContext('2d').getImageData(Math.round(canvas.width / 4) - 3, 2, 7, 1).data
    return [...pixels].some((value, index) => index % 4 === 0 && value > 200 && pixels[index + 1] > 200 && pixels[index + 2] > 200)
  }, 'Paused seek did not repaint the waveform playhead')

  await evaluate(() => document.querySelector('button[aria-label="Back to start"]').click())
  await evaluate(() => document.querySelector('[aria-label="Metronome pan"]').focus())
  await key('Home', 'Home')
  await waitFor(() => window.fixturePans['local-rhythm']?.metronome === -1, 'Metronome pan was not saved')
  await chooseSong('Silence fixture')
  assert.equal(await evaluate(() => document.querySelector('[aria-label="Metronome pan"]').getAttribute('aria-valuenow')), '0')
  await chooseSong('Rhythm fixture')
  await waitFor(() => document.querySelector('[aria-label="Metronome pan"]').getAttribute('aria-valuenow') === '-1', 'Metronome pan did not restore for the song')
  await evaluate(() => document.querySelector('[aria-label="Metronome pan"]').focus())
  await key('End', 'End')
  await waitFor(() => window.fixturePans['local-rhythm']?.metronome === 1, 'Right pan was not saved')
  await evaluate(() => document.querySelector('button[aria-label="Back to start"]').focus())
  console.log('PASS: metronome waveform rendering, click-to-seek, pan controls, and per-song persistence')
  await key('ArrowRight', 'ArrowRight')
  assert.ok(await evaluate(() => document.body.textContent.includes('0:05')))
  assert.ok(await evaluate(() => !!document.querySelector('button[aria-label="Back to start"]')), 'Back-to-start button is missing')
  await evaluate(() => document.querySelector('button[aria-label="Back to start"]').click())
  assert.ok(await evaluate(() => document.body.textContent.includes('0:00')))
  assert.ok(await evaluate(() => !!document.querySelector('button[aria-label="Play"]')))
  assert.ok(await evaluate(() => !!document.querySelector('button[title="Back 5 seconds (Shift: 15)"]')))
  console.log('PASS: back-to-start seeks to zero while preserving paused state and 5-second skip')
  await evaluate(() => { window.settingsEchoDelay = 250 })
  await select('Count-in', '1')
  await waitFor(() => Math.abs(Number(document.querySelector('input[aria-label="Tempo BPM"]')?.value) - 90) <= 2, 'Tempo control was not initialized from detection before playback')
  assert.ok(await evaluate(() => !document.querySelector('select[aria-label="Tempo mode"]')), 'Auto/Manual selector remains')
  assert.ok(await evaluate(() => document.querySelector('button[aria-label="Reset to detected tempo"]')?.disabled), 'Restore icon should be visible and disabled before adjustment')
  assert.ok(await evaluate(() => !/Detected \d+.*BPM/.test(document.body.textContent)), 'Detected BPM text remains')
  assert.equal(await evaluate(() => document.querySelector('input[aria-label="Tempo adjustment"]').step), '1')
  assert.equal(await evaluate(() => document.querySelector('input[aria-label="Tempo BPM"]').step), '1')
  await evaluate(() => {
    const slider = document.querySelector('input[aria-label="Tempo adjustment"]')
    slider.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(slider, '96')
    slider.dispatchEvent(new Event('input', { bubbles: true }))
  })
  assert.ok(await evaluate(() => window.fixtureTempo['local-rhythm']?.mode !== 'manual'), 'Drag changed timing before release')
  await evaluate(() => document.querySelector('input[aria-label="Tempo adjustment"]').dispatchEvent(new PointerEvent('pointerup', { bubbles: true })))
  await waitFor(() => window.fixtureTempo['local-rhythm']?.manualBpm === 96, 'Tempo drag was not saved on release')
  assert.equal(await evaluate(() => document.querySelector('input[aria-label="Tempo BPM"]').value), '96')
  assert.equal(await evaluate(() => document.querySelector('button[aria-label="Reset to detected tempo"]').textContent.trim()), '↺')
  assert.equal(await evaluate(() => document.querySelector('button[aria-label="Reset to detected tempo"]').title), 'Restore detected tempo')
  assert.equal(await evaluate(() => document.querySelector('button[aria-label="Reset to detected tempo"]').disabled), false)
  await enterBpm('90')
  assert.equal(await evaluate(() => document.querySelector('button[aria-label="Reset to detected tempo"]').disabled), true, 'Original tempo should disable restore')
  await enterBpm('96')
  assert.equal(await evaluate(() => document.querySelector('button[aria-label="Reset to detected tempo"]').disabled), false)

  await evaluate(() => document.querySelector('button[aria-label="Export metronome"]').click())
  assert.equal(await evaluate(() => window.fixtureExport[2].mode), 'auto')
  await evaluate(() => document.querySelector('button[aria-label="Reset to detected tempo"]').click())
  await waitFor(() => window.fixtureTempo['local-rhythm']?.mode === 'auto', 'Reset did not restore detected timing')
  assert.ok(await evaluate(() => document.querySelector('button[aria-label="Reset to detected tempo"]')?.disabled), 'Restore icon should stay visible and disabled after restoring detection')
  await evaluate(() => document.querySelector('select[aria-label="Count-in"]').focus())
  await key('Space', ' ')
  assert.ok(await evaluate(() => !!document.querySelector('button[aria-label="Play"]')), 'Space while editing the dropdown unexpectedly started playback')
  await evaluate(() => document.querySelector('button[aria-label="Play"]').focus())
  await key('Space', ' ')
  await waitFor(() => window.audioSources.some(source => source.buffer.duration > 1 && !source.fixtureStopped && source.fixtureWhen > source.context.currentTime + 0.2), 'Space on focused Play button did not start counting')
  assert.equal(await evaluate(() => window.audioStarts.filter(s => s.duration < 0.1).length), 4)
  assert.ok(await evaluate(() => !/Bar \d+ \/ \d+/.test(document.body.textContent)), 'Count-in progress text remains visible')
  await evaluate(() => { window.waveformPaints = {} })
  await new Promise(resolve => setTimeout(resolve, 120))
  assert.ok(await evaluate(() => window.waveformPaints['Metronome waveform'] > 1), 'Playback waveform animation did not resume')

  await new Promise(resolve => setTimeout(resolve, 300))
  assert.ok(await evaluate(() => !!document.querySelector('button[aria-label="Pause or cancel count-in"]')), 'Settings echo cancelled active count-in')
  await evaluate(() => { window.settingsEchoDelay = 0 })
  await pause()
  await new Promise(resolve => setTimeout(resolve, 150))
  await evaluate(() => { window.waveformPaints = {} })
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.ok(await evaluate(() => Object.values(window.waveformPaints).every(paints => paints === 0)), 'Waveform animation continued after pausing')
  assert.ok(await evaluate(() => !!document.querySelector('button[aria-label="Play"]')))
  await play()
  await waitFor(() => window.audioSources.some(source => source.buffer.duration > 1 && !source.fixtureStopped && source.fixtureWhen > source.context.currentTime + 0.2), 'Count did not restart')
  await key('ArrowRight', 'ArrowRight')
  await waitFor(() => !!document.querySelector('button[aria-label="Play"]'), 'Seeking during count did not pause')
  assert.ok(await evaluate(() => document.body.textContent.includes('0:05')))
  console.log('PASS: keyboard play, cancellation, and seek during count')

  await evaluate(() => { window.audioStarts = [] })
  await play()
  await waitFor(() => Math.abs(Number(document.querySelector('input[aria-label="Tempo BPM"]')?.value) - 90) <= 2, 'Opening tempo was not detected')
  await waitFor(() => window.audioSources.some(source => source.buffer.duration > 1 && !source.fixtureStopped && source.fixtureWhen <= source.context.currentTime), 'Count did not finish')
  const sources = await evaluate(() => window.audioStarts)
  const clicks = sources.filter(s => s.duration < 0.1), stems = sources.filter(s => s.duration > 1)
  assert.equal(clicks.length, 4)
  assert.equal(stems[0].offset, 5)
  assert.ok(Math.abs(stems[0].when - clicks[0].when - 4 * 60 / 90) < 0.05)
  await pause()
  await evaluate(() => document.body.focus())
  for (let i = 0; i < 5; i++) await key('ArrowRight', 'ArrowRight')
  await play()
  await waitFor(() => Math.abs(Number(document.querySelector('input[aria-label="Tempo BPM"]')?.value) - 150) <= 2, 'Later section tempo was not detected')
  await pause()
  console.log('PASS: Librosa detects tempo changes; stems enter at scheduled time and selected offset')

  await chooseSong('Silence fixture')
  assert.equal(await evaluate(() => window.fixtureSettings.countInBars), 1)
  await play()
  await waitFor(() => document.body.textContent.includes('No reliable tempo'), 'Silence did not request manual BPM')
  assert.ok(await evaluate(() => !!document.querySelector('button[aria-label="Play"]')))
  await select('Count-in', '0')
  await evaluate(() => { window.audioStarts = [] })
  await play()
  await waitFor(() => window.audioStarts.some(source => source.duration > 1), 'Off did not bypass tempo analysis')
  assert.equal(await evaluate(() => window.audioStarts.filter(source => source.duration < 0.1).length), 0)
  await pause()
  await select('Count-in', '1')
  assert.equal(await evaluate(() => document.querySelector('input[aria-label="Tempo BPM"]').value), '')
  await evaluate(() => {
    const slider = document.querySelector('input[aria-label="Tempo adjustment"]')
    slider.focus(); slider.blur()
  })
  assert.ok(await evaluate(() => window.fixtureTempo['local-silence']?.mode !== 'manual'), 'Focusing an undetected tempo saved a fallback override')
  await enterBpm('0')
  assert.equal(await evaluate(() => document.querySelector('input[aria-label="Tempo BPM"]').value), '', 'Invalid BPM was not rejected')
  await enterBpm('120')
  await select('Beats per bar', '1')
  assert.equal(await evaluate(() => window.fixtureTempo['local-silence']?.manualBpm), 120, 'Tempo BPM entry was not saved')
  await play()
  await waitFor(() => window.audioSources.some(source => source.buffer.duration > 1 && !source.fixtureStopped && source.fixtureWhen > source.context.currentTime + 0.2), 'Manual count did not start')
  await select('Count-in', '2')
  assert.ok(await evaluate(() => !!document.querySelector('button[aria-label="Play"]')))
  await evaluate(() => { window.audioStarts = [] })
  await play()
  await waitFor(() => window.audioSources.some(source => source.buffer.duration > 1 && !source.fixtureStopped && source.fixtureWhen > source.context.currentTime + 0.2), 'Two-bar count did not start')
  assert.equal(await evaluate(() => window.audioStarts.filter(source => source.duration < 0.1).length), 2)
  await select('Beats per bar', '2')
  assert.ok(await evaluate(() => !!document.querySelector('button[aria-label="Play"]')))
  await select('Beats per bar', '1')
  await play()
  await waitFor(() => window.audioSources.some(source => source.buffer.duration > 1 && !source.fixtureStopped && source.fixtureWhen > source.context.currentTime + 0.2), 'Count did not restart after changing meter')
  await chooseSong('Rhythm fixture')
  await new Promise(resolve => setTimeout(resolve, 650))
  assert.ok(await evaluate(() => !!document.querySelector('button[aria-label="Play"]')))
  await chooseSong('Silence fixture')
  assert.equal(await evaluate(() => document.querySelector('input[aria-label="Tempo BPM"]').value), '120')
  assert.equal(await evaluate(() => document.querySelector('select[aria-label="Beats per bar"]').value), '1')
  for (const bars of [3, 4]) {
    await select('Count-in', String(bars))
    await evaluate(() => { window.audioStarts = [] })
    await play()
    await waitFor(() => window.audioSources.some(source => source.buffer.duration > 1 && !source.fixtureStopped && source.fixtureWhen > source.context.currentTime + 0.2), 'Longer count-in did not start')
    assert.equal(await evaluate(() => window.audioStarts.filter(source => source.duration < 0.1).length), bars)
    assert.equal(await evaluate(() => window.fixtureSettings.countInBars), bars)
    await pause()
  }
  await chooseSong('Rhythm fixture')
  assert.equal(await evaluate(() => document.querySelector('select[aria-label="Count-in"]').value), '4')
  await chooseSong('Silence fixture')
  assert.equal(await evaluate(() => document.querySelector('select[aria-label="Count-in"]').value), '4')
  await select('Count-in', '2')
  console.log('PASS: Off–4 bar dropdown, keyboard editing, scheduling, persistence, and cancellation')

  await chooseSong('Video fixture')
  await enterBpm('120')
  await select('Beats per bar', '1')
  await evaluate(() => { window.videoPlays = 0 })
  await play()
  await waitFor(() => window.audioSources.some(source => source.buffer.duration > 1 && !source.fixtureStopped && source.fixtureWhen > source.context.currentTime + 0.2), 'Video count did not start')
  assert.equal(await evaluate(() => window.videoPlays), 0)
  await waitFor(() => window.videoPlays > 0, 'Video did not start after counting')
  await pause()
  console.log('PASS: video stays paused until count completes')

  await chooseSong('Rhythm fixture')
  await select('Count-in', '0')
  await evaluate(() => { window.audioStarts = []; window.audioSources = [] })
  await play()
  await waitFor(() => window.audioStarts.some(source => source.duration > 1), 'Audio did not start with clicks Off')
  await evaluate(() => document.querySelector('button[aria-label="Mute metronome"]').click())
  await waitFor(() => window.audioStarts.some(source => source.duration < 0.1), 'Live metronome did not start')
  await enterBpm('60')
  await waitFor(() => {
    const clicks = window.audioSources.filter(source => source.buffer.duration < 0.1 && !source.fixtureStopped && source.fixtureWhen > source.context.currentTime + 0.1)
    return clicks.length > 1 && Math.abs(clicks[1].fixtureWhen - clicks[0].fixtureWhen - 60 / 60) < 0.04
  }, 'Live tempo correction did not change metronome spacing')
  await waitFor(() => window.audioSources.filter(source => source.buffer.duration > 1 && !source.fixtureStopped).every(source => Math.abs(source.playbackRate.value - 60 / 90) < 0.02), 'Practice tempo did not slow every stem')
  assert.equal(await evaluate(() => window.audioSources.filter(source => source.buffer.duration > 1 && !source.fixtureStopped).length), 1, 'Practice tempo left overlapping stems')
  await evaluate(() => document.querySelector('button[aria-label="Reset to detected tempo"]').click())
  await waitFor(() => window.fixtureTempo['local-rhythm']?.mode === 'auto', 'Live reset did not restore detected timing')
  await waitFor(() => window.audioSources.filter(source => source.buffer.duration > 1 && !source.fixtureStopped).every(source => source.playbackRate.value === 1), 'Reset did not restore original song speed')
  await waitFor(() => window.audioSources.filter(source => source.buffer.duration < 0.1 && !source.fixtureStopped).every(source => source.fixtureOutput.fixtureOutput.pan.value > 0.995), 'Saved metronome pan did not reach the audio graph')
  await evaluate(() => document.querySelector('[aria-label="Metronome pan"]').focus())
  await key('Home', 'Home')
  await waitFor(() => window.audioSources.filter(source => source.buffer.duration < 0.1 && !source.fixtureStopped).every(source => source.fixtureOutput.fixtureOutput.pan.value < -0.995), 'Metronome pan did not change live')
  assert.equal(await evaluate(() => window.audioStarts.filter(source => source.duration > 1).length), 3)
  await evaluate(() => {
    const slider = document.querySelector('input[aria-label="Click volume"]')
    slider.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(slider, '0.2')
    slider.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await evaluate(() => document.querySelector('input[aria-label="Click volume"]').dispatchEvent(new PointerEvent('pointerup', { bubbles: true })))
  await waitFor(() => window.fixtureSettings.clickVolume === 0.2, 'Click volume was not saved')
  await waitFor(() => Math.abs(window.audioSources.find(source => source.buffer.duration < 0.1).fixtureOutput.gain.value - 0.4) < 0.005, 'Click gain did not change live')
  assert.equal(await evaluate(() => window.audioStarts.filter(source => source.duration > 1).length), 3)
  await evaluate(() => document.querySelector('button[aria-label="Mute metronome"]').focus())
  await key('ArrowRight', 'ArrowRight')
  const alignment = await evaluate(() => {
    const stem = window.audioStarts.filter(source => source.duration > 1).at(-1)
    const clicks = window.audioSources.filter(source => source.buffer.duration < 0.1 && !source.fixtureStopped && source.fixtureWhen >= stem.when)
    const beats = window.lastAnalysis.beats.filter(beat => beat >= stem.offset && beat < 48)
    return { count: clicks.length, expected: beats.length, error: Math.max(...clicks.map((source, index) => Math.abs(source.fixtureWhen - stem.when - (beats[index] - stem.offset)))) }
  })
  assert.ok(alignment.count > 0)
  assert.equal(alignment.count, alignment.expected)
  assert.ok(alignment.error < 0.001)
  await evaluate(() => document.querySelector('button[aria-label="Solo metronome"]').click())
  await waitFor(() => window.audioSources.filter(source => source.buffer.duration > 1 && !source.fixtureStopped).every(source => source.fixtureOutput.gain.value < 0.005), 'Soloing metronome did not silence stems')
  assert.equal(await evaluate(() => document.querySelector('button[aria-label="Solo metronome"]').getAttribute('aria-pressed')), 'true')
  await evaluate(() => document.querySelector('button[aria-label="Solo metronome"]').click())
  await waitFor(() => window.audioSources.filter(source => source.buffer.duration > 1 && !source.fixtureStopped).every(source => source.fixtureOutput.gain.value > 0.995), 'Clearing metronome Solo did not restore stems')
  await evaluate(() => document.querySelector('canvas').parentElement.querySelector('button[title="Solo"]').click())
  await waitFor(() => !window.audioSources.some(source => source.buffer.duration < 0.1 && !source.fixtureStopped && source.fixtureWhen > source.context.currentTime + 0.1), 'Soloing a stem did not silence metronome')
  await evaluate(() => document.querySelector('canvas').parentElement.querySelector('button[title="Solo"]').click())
  await waitFor(() => window.audioSources.some(source => source.buffer.duration < 0.1 && !source.fixtureStopped && source.fixtureWhen > source.context.currentTime + 0.1), 'Clearing stem Solo did not restore metronome')
  await evaluate(() => document.querySelector('button[aria-label="Mute metronome"]').click())
  assert.equal(await evaluate(() => window.audioSources.filter(source => source.buffer.duration < 0.1 && !source.fixtureStopped && source.fixtureWhen > source.context.currentTime + 0.1).length), 0)
  assert.ok(await evaluate(() => !!document.querySelector('button[aria-label="Pause or cancel count-in"]')))
  await pause()
  await chooseSong('Silence fixture')
  assert.equal(await evaluate(() => document.querySelector('input[aria-label="Click volume"]').value), '0.2')
  assert.equal(await evaluate(() => document.querySelector('button[aria-label="Mute metronome"]').getAttribute('aria-pressed')), 'true')
  console.log('PASS: continuous metronome, independent live volume, beat alignment after seek, live toggle, and saved preferences')

  await chooseSong('Rhythm fixture')
  await evaluate(() => { window.tempoResponseDelay = 300; window.audioSources = [] })
  await evaluate(() => document.querySelector('button[aria-label="Mute metronome"]').click())
  await play()
  await evaluate(() => {
    const slider = document.querySelector('input[aria-label="Click volume"]')
    slider.focus()
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(slider, '0.35')
    slider.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await evaluate(() => document.querySelector('input[aria-label="Click volume"]').dispatchEvent(new PointerEvent('pointerup', { bubbles: true })))
  await waitFor(() => window.audioSources.some(source => source.buffer.duration < 0.1), 'Delayed metronome did not start')
  await waitFor(() => Math.abs(window.audioSources.find(source => source.buffer.duration < 0.1).fixtureOutput.gain.value - 0.7) < 0.005, 'Playback reset a volume change made during analysis', 1500)
  await pause()
  console.log('PASS: volume changes during tempo analysis survive playback start')

  await chooseSong('Silence fixture')
  await chooseSong('Rhythm fixture')
  await evaluate(() => document.querySelector('button[aria-label="Mute metronome"]').click())
  await play()
  await waitFor(() => !!document.querySelector('button[aria-label="Pause or cancel count-in"]'), 'Playback did not start')
  await evaluate(() => { window.previousTempoRequests = window.tempoRequests || 0 })
  await evaluate(() => document.querySelector('button[aria-label="Mute metronome"]').click())
  await waitFor(() => window.tempoRequests > window.previousTempoRequests, 'Live metronome analysis did not start')
  await pause()
  await new Promise(resolve => setTimeout(resolve, 60))
  assert.ok(!(await evaluate(() => document.querySelector('[role="alert"]')?.textContent || '')).toLowerCase().includes('cancel'), 'Pausing metronome analysis showed a cancellation error')
  console.log('PASS: pausing pending metronome analysis does not display an error')
  await chooseSong('Rhythm fixture')
  await waitFor(() => Number(document.querySelector('input[aria-label="Tempo BPM"]').value) === 90, 'Original reference tempo did not load')
  await evaluate(() => document.body.focus())
  for (let i = 0; i < 6; i++) await key('ArrowRight', 'ArrowRight')
  await waitFor(() => Number(document.querySelector('input[aria-label="Tempo BPM"]').value) === 150, 'Later section BPM did not display')
  await enterBpm('100')
  assert.equal(await evaluate(() => window.fixtureTempo['local-rhythm'].sourceBpm), 150)
  await play()
  await waitFor(() => window.audioSources.some(source => source.buffer.duration > 1 && !source.fixtureStopped && Math.abs(source.playbackRate.value - 2 / 3) < 0.001), 'Later section did not slow from 150 to 100 BPM')
  await evaluate(() => document.querySelector('button[aria-label="Back to start"]').click())
  await waitFor(() => Number(document.querySelector('input[aria-label="Tempo BPM"]').value) === 60, 'Fixed ratio did not follow the earlier section BPM')
  await pause()
  await chooseSong('Silence fixture')
  await chooseSong('Rhythm fixture')
  await waitFor(() => Number(document.querySelector('input[aria-label="Tempo BPM"]').value) === 60, 'Saved section baseline was not restored')
  await select('Count-in', '1')
  await select('Beats per bar', '1')
  await evaluate(() => { window.audioStarts = [] })
  await play()
  await waitFor(() => window.audioSources.some(source => source.buffer.duration > 1 && !source.fixtureStopped && source.fixtureWhen > source.context.currentTime + 0.2), 'Slowed count-in did not start')
  const slowedStarts = await evaluate(() => window.audioStarts)
  const slowedClick = slowedStarts.find(source => source.duration < 0.1)
  const slowedStem = slowedStarts.find(source => source.duration > 1)
  const stretchLatency = await evaluate(async () => {
    const source = window.audioSources.find(source => source.buffer.duration > 1 && !source.fixtureStopped)
    // Sources start early by the processor latency so their audible onset follows the count-in.
    return source.fixtureOutput.fixtureOutput.fixtureOutput.latency()
  })
  assert.ok(Math.abs(slowedStem.when + stretchLatency - slowedClick.when - 1) < 0.025, 'Slowed count-in did not use the current 60 BPM')
  await pause()
  await evaluate(() => document.querySelector('button[aria-label="Reset to detected tempo"]').click())
  await select('Count-in', '0')
  console.log('PASS: later-section practice tempo, fixed ratio after seek, saved baseline, and slowed count-in')
  await evaluate(() => { window.fixtureTempo['local-rhythm'] = { mode: 'manual', manualBpm: 60, beatsPerBar: 1 } })
  await chooseSong('Silence fixture')
  await chooseSong('Rhythm fixture')
  await waitFor(() => Number(document.querySelector('input[aria-label="Tempo BPM"]').value) === 60, 'Legacy practice tempo did not load')
  await evaluate(() => document.body.focus())
  for (let i = 0; i < 6; i++) await key('ArrowRight', 'ArrowRight')
  await waitFor(() => Number(document.querySelector('input[aria-label="Tempo BPM"]').value) === 100, 'Legacy practice BPM did not follow later section')
  await evaluate(() => document.querySelector('button[aria-label="Reset to detected tempo"]').click())
  console.log('PASS: legacy saved tempo follows the current section at its fixed practice ratio')

  await evaluate(() => { window.tempoResponseDelay = 900; delete window.fixtureTempo['local-silence'] })
  await chooseSong('Silence fixture')
  await enterBpm('156.5')
  await waitFor(() => document.body.textContent.includes('No tempo detected'), 'Delayed detection did not finish')
  assert.equal(await evaluate(() => document.querySelector('input[aria-label="Tempo BPM"]').value), '157', 'Late detection overwrote a BPM correction')
  assert.equal(await evaluate(() => window.fixtureTempo['local-silence'].manualBpm), 157)
  console.log('PASS: late detection preserves the user BPM correction')
  await evaluate(() => { window.failTempo = true; window.tempoResponseDelay = 0 })
  await chooseSong('Rhythm fixture')
  await chooseSong('Silence fixture')
  await waitFor(() => document.body.textContent.includes('No tempo detected'), 'Failed detection did not finish')
  await play()
  await waitFor(() => window.audioSources.some(source => source.buffer.duration > 1 && !source.fixtureStopped && source.playbackRate.value === 1), 'Missing detection blocked manual fallback playback')
  await pause()
  await evaluate(() => document.querySelector('button[aria-label="Export metronome"]').click())
  assert.equal(await evaluate(() => window.fixtureExport[2].mode), 'manual', 'Failed detection blocked manual metronome export')
  assert.equal(await evaluate(() => window.fixtureExport[2].manualBpm), 157)
  console.log('PASS: detection failure preserves manual clicks, export, and original-speed playback')
}

run().then(() => finish(0), error => { console.error(error); finish(1) })
function finish(code) {
  for (const child of analysisJobs.values()) child.kill()
  if (window) window.destroy()
  if (server) server.close()
  rmSync(profile, { recursive: true, force: true })
  app.exit(code)
}
