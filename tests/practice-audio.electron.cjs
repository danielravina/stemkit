// Render the production engine with real Web Audio and Signalsmith Stretch, without an audio device.
const { app, BrowserWindow } = require('electron')
const { createServer } = require('node:http')
const { mkdtempSync, rmSync, readdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')
const { pathToFileURL } = require('node:url')
const { tmpdir } = require('node:os')
const assert = require('node:assert/strict')
const { build } = require('esbuild')
const profile = mkdtempSync(join(tmpdir(), 'stemkit-practice-audio-'))
app.setPath('userData', profile)
let server, window
async function run() {
  const bundle = await build({
    stdin: { contents: "export { StemEngine } from './src/renderer/src/lib/engine';", resolveDir: join(__dirname, '..') },
    bundle: true, format: 'iife', globalName: 'Practice', write: false,
    plugins: [{ name: 'processor-url', setup(build) {
      build.onResolve({ filter: /[?&]url$/ }, () => ({ path: 'processor-url', namespace: 'url' }))
      build.onLoad({ filter: /.*/, namespace: 'url' }, () => ({ contents: 'export default "/processor.js"' }))
    } }]
  })
  const processor = await build({ entryPoints: [join(__dirname, '../src/renderer/src/lib/signalsmith-processor.ts')], bundle: true, format: 'iife', write: false })
  server = createServer((request, response) => {
    response.setHeader('Content-Type', request.url.endsWith('.js') ? 'application/javascript' : 'text/html')
    response.end(request.url === '/engine.js' ? bundle.outputFiles[0].text
      : request.url === '/processor.js' ? processor.outputFiles[0].text
      : '<script src="/engine.js"></script>')
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  window = new BrowserWindow({ show: false, webPreferences: { sandbox: false } })
  await window.loadURL('http://127.0.0.1:' + server.address().port)
  const results = await window.webContents.executeJavaScript(`(async () => {
    const results = [];
    for (const [rate, sr] of [0.5, 0.75, 0.9, 1, 1.5, 2].flatMap(rate => [44100, 48000].map(sr => [rate, sr]))) {
      const countSeconds = rate === 0.75 ? 60 / (90 * rate) : 0;
      const duration = 4, length = Math.ceil(sr * (duration / rate + countSeconds + 1));
      const context = new OfflineAudioContext(2, length, sr);
      context.resume = async () => {};
      const Original = window.AudioContext;
      window.AudioContext = function() { return context; };
      try {
        const engine = new Practice.StemEngine();
        const tone = context.createBuffer(1, sr * duration, sr);
        const pulse = context.createBuffer(1, sr * duration, sr);
        const beats = [0.5, 1.5, 2.5, 3.5];
        const a = tone.getChannelData(0), b = pulse.getChannelData(0);
        for (let i = 0; i < a.length; i++) a[i] = Math.sin(2 * Math.PI * 440 * i / sr) * 0.05;
        for (const beat of beats) for (let j = 0; j < 1800; j++) b[Math.round(beat * sr) + j] = Math.sin(j * 0.14) * Math.exp(-j / 450) * 0.8;
        engine.setBuffers({ vocals: tone, drums: pulse });
        engine.applyMix({}, new Set(), new Set(), 1, { vocals: -1, drums: -1, metronome: 1 });
        engine.setClickVolume(1);
        engine.setMetronome(beats);
        let deadline;
        try {
          await Promise.race([engine.setRate(rate), new Promise((_, reject) => { deadline=setTimeout(() => reject(new Error('Processor startup timed out at '+rate)), 10000); })]);
        } finally { clearTimeout(deadline); }
        await engine.start(0, countSeconds ? { bars: 1, bpm: 90 * rate, beatsPerBar: 1 } : undefined);
        const renderStarted = performance.now();
        const output = await context.startRendering();
        const renderMs = performance.now() - renderStarted;
        const left = output.getChannelData(0), right = output.getChannelData(1);
        const crossings = [];
        const from = Math.floor(sr * (1 / rate + 0.15 + countSeconds)), until = Math.floor(sr * (1.15 / rate + 0.15 + countSeconds));
        for (let i = from; i < until; i++) if (left[i] <= 0 && left[i + 1] > 0) crossings.push(i - left[i] / (left[i + 1] - left[i]));
        const frequency = (crossings.length - 1) * sr / (crossings.at(-1) - crossings[0]);
        const errors = [];
        for (const beat of beats) {
          const expected = 0.04 + beat / rate + countSeconds;
          let peak = 0, peakAt = 0, click = 0, clickAt = 0;
          for (let i = Math.floor(sr * expected); i < Math.min(length, sr * (expected + 0.4)); i++) {
            if (Math.abs(left[i]) > peak) { peak = Math.abs(left[i]); peakAt = i / sr; }
            if (Math.abs(right[i]) > click) { click = Math.abs(right[i]); clickAt = i / sr; }
          }
          errors.push({ delta: Math.abs(peakAt - clickAt), peak, click });
        }
        let last = 0;
        for (let i = 0; i < left.length; i++) if (Math.abs(left[i]) > 0.01) last = i / sr;
        results.push({ rate, sr, countSeconds, frequency, errors, last, renderMs });
        engine.stopAll();
      } finally { window.AudioContext = Original; }
    }
    return results;
  })()`)
  for (const result of results) {
    console.log(JSON.stringify(result))
    assert.ok(Math.abs(result.frequency - 440) < 8, 'Pitch changed at rate ' + result.rate)
    assert.ok(result.errors.every(error => error.peak > 0.075 && error.click > 0.1), 'Missing beat at rate ' + result.rate)
    assert.ok(result.errors.every(error => error.delta < 0.025), 'Click not aligned with stretched audio at rate ' + result.rate)
    assert.ok(Math.abs(result.last - (4 / result.rate + 0.04 + result.countSeconds)) < 0.3, 'Truncated or incorrectly scaled duration at rate ' + result.rate)
  }
  console.log('PASS: real rendered pitch, speed, beat alignment, panning, and audio tails at 0.5–2×')
  const assets = join(__dirname, '../out/renderer/assets')
  const module = readdirSync(assets).find(name => /^practice-audio-.*\.js$/.test(name))
  assert.ok(module, 'Build the production renderer before running this check')
  const html = join(profile, 'file-protocol.html')
  writeFileSync(html, `<meta http-equiv="Content-Security-Policy" content="default-src 'self'; script-src 'self' 'wasm-unsafe-eval' 'unsafe-inline'; connect-src 'self'">`)
  await window.loadFile(html)
  assert.equal(await window.webContents.executeJavaScript(`(async () => {
    const { preparePitch } = await import(${JSON.stringify(pathToFileURL(join(assets, module)).href)});
    const context = new AudioContext();
    try {
      for (const rate of [0.1, 0.75, 10]) {
        const setup = await preparePitch(context, rate);
        const pitch = await setup.create();
        pitch.node.connect(context.destination);
        pitch.dispose();
        if (setup.latency <= 0 || setup.latency >= 1) return false;
      }
      return true;
    } finally { await context.close(); }
  })()`), true)
  console.log('PASS: production processor loads from file URLs under the app content security policy')
}
app.whenReady().then(run).then(() => finish(0), error => { console.error(error); finish(1) })
function finish(code) { window?.destroy(); server?.close(); rmSync(profile, { recursive: true, force: true }); app.exit(code) }
