import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'stemkit-settings-'))
after(() => rmSync(root, { recursive: true, force: true }))
const settingsUrl = new URL('../src/main/settings.ts', import.meta.url).href
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL === settingsUrl) {
    if (specifier === './env') return { shortCircuit: true, url: `data:text/javascript,${encodeURIComponent(`export const userDataDir = () => ${JSON.stringify(root)}`)}` }
    if (specifier === 'electron') return { shortCircuit: true, url: 'data:text/javascript,export const BrowserWindow = { getAllWindows: () => [] }' }
    if (specifier === '../shared/types') return { shortCircuit: true, url: new URL('../src/shared/types.ts', import.meta.url).href }
  }
  return next(specifier, context)
} })
const { loadSettings, saveSettings } = await import(settingsUrl)
hooks.deregister()

test('old and invalid count-in preferences default to Off; valid preferences survive other saves', () => {
  assert.equal(loadSettings().countInBars, 0)
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ shifts: 2 }))
  assert.equal(loadSettings().countInBars, 0)
  for (const countInBars of [1, 2, 3, 4, 0]) {
    saveSettings({ countInBars })
    saveSettings({ hideVideo: true })
    assert.equal(loadSettings().countInBars, countInBars)
  }
  for (const countInBars of [-1, 5, 1.5, '2', null]) {
    writeFileSync(join(root, 'settings.json'), JSON.stringify({ countInBars }))
    assert.equal(loadSettings().countInBars, 0)
    assert.equal(saveSettings({ countInBars }).countInBars, 0)
  }
})

test('metronome and click volume persist, default safely, and normalize invalid values', () => {
  writeFileSync(join(root, 'settings.json'), '{}')
  assert.equal(loadSettings().metronomeEnabled, false)
  assert.equal(loadSettings().clickVolume, 0.5)
  saveSettings({ metronomeEnabled: true, clickVolume: 0.25 })
  saveSettings({ hideVideo: true })
  assert.equal(loadSettings().metronomeEnabled, true)
  assert.equal(loadSettings().clickVolume, 0.25)
  for (const [value, expected] of [[0, 0], [1, 1], [-2, 0], [2, 1], [null, 0.5], ['loud', 0.5], [NaN, 0.5]]) {
    assert.equal(saveSettings({ clickVolume: value }).clickVolume, expected)
  }
  writeFileSync(join(root, 'settings.json'), JSON.stringify({ metronomeEnabled: 'yes', clickVolume: 'loud' }))
  assert.equal(loadSettings().metronomeEnabled, false)
  assert.equal(loadSettings().clickVolume, 0.5)
})
