import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { build } from 'esbuild'
import vm from 'node:vm'
import { createRequire } from 'node:module'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { renderMetronomeWav } from '../src/main/metronome-wav.ts'

const root = mkdtempSync(join(tmpdir(), 'stemkit-export-test-'))
after(() => rmSync(root, { recursive: true, force: true }))
const source = renderMetronomeWav([0.125], 2.125)
const songs = ['test-song', 'collision'].map(videoId => ({ videoId, title: videoId === 'collision' ? 'Metronome' : 'Test song', stems: ['drums'], duration: 2, addedAt: 1 }))
writeFileSync(join(root, 'library.json'), JSON.stringify({ songs }))
for (const song of songs) {
  const directory = join(root, 'songs', song.videoId)
  mkdirSync(join(directory, 'stems'), { recursive: true })
  writeFileSync(join(directory, 'mix.wav'), source)
  writeFileSync(join(directory, 'stems', 'drums.wav'), source)
}
const compiled = await build({
  entryPoints: ['src/main/index.ts'], bundle: true, write: false, format: 'cjs', platform: 'node', packages: 'external',
  plugins: [{ name: 'isolated-export-dependencies', setup(builder) {
    builder.onResolve({ filter: /^\.\/env$/ }, () => ({ path: 'fixture-env', external: true }))
    builder.onResolve({ filter: /^\.\/tempo$/ }, () => ({ path: 'fixture-tempo', external: true }))
  } }]
})
const handlers = new Map()
const manual = { mode: 'manual', manualBpm: 120, beatsPerBar: 4 }
let startup, saveResult, openResult, analysisCalls = 0, reliable = true
const ffmpeg = resolve('extras', process.platform === 'win32' ? 'ffmpeg-win' : process.platform === 'darwin' ? 'ffmpeg-mac' : 'ffmpeg-linux', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
const done = new Error('Handlers registered')
const electron = {
  app: { isPackaged: false, name: 'StemKit', whenReady: () => ({ then: callback => { startup = callback } }), on() {}, getPath: () => root },
  Menu: { buildFromTemplate() {}, setApplicationMenu() {} }, BrowserWindow: { getAllWindows: () => [] },
  ipcMain: { handle(name, callback) { handlers.set(name, callback); if (name === 'open-external') throw done } },
  dialog: { showSaveDialog: async () => saveResult, showOpenDialog: async () => openResult }
}
const require = createRequire(import.meta.url)
const context = vm.createContext({
  require(name) {
    if (name === 'electron') return electron
    if (name === 'electron-updater') return { autoUpdater: {} }
    if (name === 'fixture-env') return { userDataDir: () => root, refreshReady: async () => false, getStatus: () => ({ ffmpeg: { path: ffmpeg } }) }
    if (name === 'fixture-tempo') return { analyzeSongTempo: async () => { analysisCalls++; return { points: reliable ? [{ start: 0, bpm: 120 }] : [], beats: reliable ? [0.125, 0.625, 1.125, 1.625] : [] } } }
    return require(name)
  }, module: { exports: {} }, exports: {}, process, Buffer, console, setTimeout, clearTimeout, __dirname: resolve('out/main')
})
vm.runInContext(compiled.outputFiles[0].text, context)
await assert.rejects(startup(), error => error === done)
const event = { sender: { id: 17 } }
function format(value) { writeFileSync(join(root, 'settings.json'), JSON.stringify({ exportFormat: value })) }
const exportStem = (tempo = manual) => handlers.get('stem:export')(event, 'test-song', 'metronome', tempo)
const exportAll = (id = 'test-song', tempo = manual) => handlers.get('stems:export-all')(event, id, tempo)

test('individual metronome download writes an aligned WAV even when click playback is muted', async () => {
  format('wav')
  saveResult = { canceled: false, filePath: join(root, 'click.wav') }
  assert.equal((await exportStem()).saved, true)
  const bytes = readFileSync(saveResult.filePath)
  assert.equal(bytes.length, source.length)
  assert.ok(bytes.readInt16LE(46) !== 0)
  assert.equal(analysisCalls, 0)
  saveResult = { canceled: false, filePath: join(root, 'auto.wav') }
  await exportStem({ mode: 'auto', manualBpm: null, beatsPerBar: 4 })
  assert.equal(analysisCalls, 1)
  assert.ok(readFileSync(saveResult.filePath).subarray(44, 44 + Math.round(0.125 * 44100) * 2).every(byte => byte === 0))
  saveResult = { canceled: true }
  assert.equal((await exportStem()).saved, false)
})

test('bulk export includes the metronome, preserves other files, and avoids a mix filename collision', async () => {
  format('wav')
  openResult = { canceled: false, filePaths: [join(root, 'bulk')] }
  const result = await exportAll()
  assert.equal(result.count, 3)
  assert.ok(existsSync(join(result.path, 'metronome.wav')))
  assert.deepEqual(readFileSync(join(result.path, 'drums.wav')), source)
  assert.deepEqual(readFileSync(join(result.path, 'Test song.wav')), source)
  const collision = await exportAll('collision')
  assert.equal(collision.count, 3)
  assert.deepEqual(readFileSync(join(collision.path, 'Metronome - full track.wav')), source)
  assert.ok(existsSync(join(collision.path, 'metronome.wav')))
})

test('missing beats report a direct error and a bulk warning while preserving stem exports', async () => {
  reliable = false
  saveResult = { canceled: false, filePath: join(root, 'missing.wav') }
  const auto = { mode: 'auto', manualBpm: null, beatsPerBar: 4 }
  await assert.rejects(() => exportStem(auto), /No reliable metronome beats/)
  assert.ok(!existsSync(saveResult.filePath))
  openResult = { canceled: false, filePaths: [join(root, 'no-beats')] }
  const result = await exportAll('test-song', auto)
  assert.equal(result.count, 2)
  assert.match(result.warning, /metronome was skipped/)
  assert.ok(existsSync(join(result.path, 'drums.wav')))
  assert.ok(!existsSync(join(result.path, 'metronome.wav')))
  reliable = true
  await assert.rejects(() => exportStem({ ...manual, manualBpm: null }), /Invalid tempo settings/)
})

test('AAC export transcodes the click track and cleans temporary WAV files', { skip: !existsSync(ffmpeg) }, async () => {
  format('aac')
  const before = readdirSync(tmpdir()).filter(name => name.startsWith('stemkit-metronome-'))
  saveResult = { canceled: false, filePath: join(root, 'click.m4a') }
  assert.equal((await exportStem()).saved, true)
  assert.equal(readFileSync(saveResult.filePath).toString('ascii', 4, 8), 'ftyp')
  openResult = { canceled: false, filePaths: [join(root, 'aac-bulk')] }
  const result = await exportAll()
  assert.equal(result.count, 3)
  assert.equal(readFileSync(join(result.path, 'metronome.m4a')).toString('ascii', 4, 8), 'ftyp')
  assert.deepEqual(readdirSync(tmpdir()).filter(name => name.startsWith('stemkit-metronome-')), before)
})
