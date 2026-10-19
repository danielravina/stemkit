import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { localSongId } from '../src/shared/local.ts'

const root = mkdtempSync(join(tmpdir(), 'stemkit-import-tempo-'))
after(() => rmSync(root, { recursive: true, force: true }))
const trace = join(root, 'trace.jsonl')
const config = join(root, 'config.json')
const tool = join(root, 'tool.cjs')
writeFileSync(config, '{}')
writeFileSync(tool, `
const fs = require('node:fs'), path = require('node:path');
const [cmd, ...args] = process.argv.slice(2);
const root = ${JSON.stringify(root)};
const options = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
const record = value => fs.appendFileSync(path.join(root, 'trace.jsonl'), JSON.stringify(value) + '\\n');
if (cmd === 'ytdlp') {
  if (args.includes('-J')) console.log(JSON.stringify({ title: 'YouTube fixture', duration: 1 }));
  else fs.writeFileSync(args[args.indexOf('-o') + 1].replace('%(ext)s', 'wav'), 'download');
} else if (cmd === 'ffmpeg') {
  fs.writeFileSync(args.at(-1), Buffer.alloc(88244));
} else if (args[0] === 'separate') {
  const out = args[args.indexOf('--out') + 1];
  fs.mkdirSync(out, { recursive: true }); fs.writeFileSync(path.join(out, 'drums.wav'), 'stem');
  console.log(JSON.stringify({ type: 'done', stems: ['drums'] }));
} else if (args[0] === 'tempo') {
  const source = args[args.indexOf('--input') + 1];
  record({ stage: 'analyze', source });
  if (options.fail) { console.error('test detector failure'); process.exit(1); }
  setTimeout(() => console.log(JSON.stringify({ points: [{ start: 0, bpm: 126 }], beats: [0.1, 0.576] })), options.delay || 0);
} else process.exit(2);
`)
const urls = Object.fromEntries(['pipeline', 'library', 'tempo'].map(name => [name, new URL(`../src/main/${name}.ts`, import.meta.url).href]))
const sharedUrl = new URL('../src/shared/types.ts', import.meta.url).href
const jsModule = source => `data:text/javascript,${encodeURIComponent(source)}`
const env = jsModule(`
export const userDataDir = () => ${JSON.stringify(root)};
export const venvPython = () => 'python'; export const venvYtDlp = () => 'ytdlp';
export const separateScript = () => 'separate'; export const roformerScript = () => 'roformer'; export const tempoScript = () => 'tempo';
export const modelsDir = () => ${JSON.stringify(join(root, 'models'))};
export const ensureEngineDeps = async () => true; export const ensureTempoDeps = async () => {};
export const ensureVocalsEngine = async () => {}; export const ensureFtWeights = async () => {};
export const ensureGpuEngine = async () => true; export const detectGpuVendor = async () => undefined;
export const getStatus = () => ({ ffmpeg: { path: 'ffmpeg' } }); export const ytDlpRuntimeArgs = () => [];
`)
globalThis.importEvents = []
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (Object.values(urls).includes(context.parentURL)) {
    if (specifier === './env') return { shortCircuit: true, url: env }
    if (specifier === './settings') return { shortCircuit: true, url: jsModule(`import { DEFAULT_SETTINGS } from ${JSON.stringify(sharedUrl)}; export const loadSettings = () => ({...DEFAULT_SETTINGS})`) }
    if (specifier === './thumbs') return { shortCircuit: true, url: jsModule('export const cacheThumbnail = async () => {}') }
    if (specifier === 'electron') return { shortCircuit: true, url: jsModule(`export const BrowserWindow = { getAllWindows: () => [{ webContents: { send: (_, event) => globalThis.importEvents.push(event) } }] }`) }
    if (specifier === 'child_process') return { shortCircuit: true, url: jsModule(`import { spawn as realSpawn } from 'node:child_process'; export const spawn = (cmd, args, options) => realSpawn(process.execPath, [${JSON.stringify(tool)}, cmd, ...args], options)`) }
    if (specifier === '../shared/types') return { shortCircuit: true, url: sharedUrl }
    if (specifier === '../shared/local') return { shortCircuit: true, url: new URL('../src/shared/local.ts', import.meta.url).href }
    if (specifier === '../shared/url') return { shortCircuit: true, url: new URL('../src/shared/url.ts', import.meta.url).href }
    if (specifier === './library') return { shortCircuit: true, url: urls.library }
    if (specifier === './tempo') return { shortCircuit: true, url: urls.tempo }
  }
  return next(specifier, context)
} })
const { startJob, startLocalJob, cancelJob } = await import(urls.pipeline)
const { loadSongs } = await import(urls.library)
hooks.deregister()
const local = join(root, 'local.wav')
writeFileSync(local, 'local input')
const records = () => existsSync(trace) ? readFileSync(trace, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []

for (const source of ['local', 'youtube']) {
  test(`${source} import analyzes tempo before done and persists analysis for playback`, async () => {
    importEvents.length = 0
    const id = source === 'local' ? localSongId(local) : 'abcdefghijk'
    if (source === 'local') await startLocalJob(local, 'htdemucs_6s', ['drums'])
    else await startJob('https://youtu.be/abcdefghijk', 'htdemucs_6s', ['drums'])
    const analysis = importEvents.findIndex(event => event.kind === 'progress' && event.data.stage === 'analyze')
    const done = importEvents.findIndex(event => event.kind === 'done')
    assert.ok(analysis >= 0, 'Import did not run tempo detection')
    assert.ok(done > analysis, 'Import completed before detection')
    const saved = JSON.parse(readFileSync(join(root, 'songs', id, 'tempo-analysis.json'), 'utf8'))
    assert.deepEqual(saved.points, [{ start: 0, bpm: 126 }])
    assert.ok(loadSongs().some(song => song.videoId === id))
    assert.ok(records().some(record => record.source === join(root, 'songs', id, 'mix.wav')))
  })
}

test('re-importing a cached split fills missing tempo analysis without splitting again', async () => {
  const id = localSongId(local)
  rmSync(join(root, 'songs', id, 'tempo-analysis.json'), { force: true })
  importEvents.length = 0
  await startLocalJob(local, 'htdemucs_6s', ['drums'])
  assert.ok(importEvents.some(event => event.kind === 'progress' && event.data.stage === 'analyze'))
  assert.ok(!importEvents.some(event => event.kind === 'progress' && event.data.stage === 'separate'))
  assert.ok(existsSync(join(root, 'songs', id, 'tempo-analysis.json')))
})

test('tempo detection failure does not discard a successful audio import', async () => {
  const file = join(root, 'failure.wav')
  writeFileSync(file, 'input')
  writeFileSync(config, JSON.stringify({ fail: true }))
  importEvents.length = 0
  await startLocalJob(file, 'htdemucs_6s', ['drums'])
  assert.ok(importEvents.some(event => event.kind === 'done'))
  assert.ok(!importEvents.some(event => event.kind === 'failed'))
  assert.ok(loadSongs().some(song => song.videoId === localSongId(file)))
})

test('cancelling during import analysis stops detection and does not add the song', async () => {
  const file = join(root, 'cancel.wav')
  writeFileSync(file, 'input')
  writeFileSync(config, JSON.stringify({ delay: 2000 }))
  const id = localSongId(file)
  importEvents.length = 0
  const pending = startLocalJob(file, 'htdemucs_6s', ['drums'])
  const until = Date.now() + 5000
  while (!records().some(record => record.source === join(root, 'songs', id, 'mix.wav'))) {
    if (Date.now() > until) throw new Error('Import never reached tempo analysis')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  cancelJob(id)
  await pending
  assert.equal(existsSync(join(root, 'songs', id)), false)
  assert.ok(!loadSongs().some(song => song.videoId === id))
  assert.equal(importEvents.filter(event => event.kind === 'failed').length, 1)
  assert.equal(importEvents.find(event => event.kind === 'failed').data.message, 'Cancelled')
  assert.ok(!importEvents.some(event => event.kind === 'done'))
})

test('cancelling tempo analysis on a cached re-import preserves the existing song and stems', async () => {
  const id = localSongId(local)
  rmSync(join(root, 'songs', id, 'tempo-analysis.json'), { force: true })
  writeFileSync(config, JSON.stringify({ delay: 2000 }))
  const count = records().length
  const pending = startLocalJob(local, 'htdemucs_6s', ['drums'])
  const until = Date.now() + 5000
  while (records().length === count) {
    if (Date.now() > until) throw new Error('Cached import never reached tempo analysis')
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  cancelJob(id)
  await pending
  assert.ok(existsSync(join(root, 'songs', id, 'stems', 'drums.wav')))
  assert.ok(loadSongs().some(song => song.videoId === id))
})
