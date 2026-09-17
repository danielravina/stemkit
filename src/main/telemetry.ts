import { randomUUID } from 'crypto'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { app, net } from 'electron'
import { userDataDir } from './env'

/* anonymous install counter: one small POST per install, ever. Payload is a
   random install id plus version/os/arch — nothing that identifies the
   machine or user. The endpoint is a Cloudflare Worker (telemetry-worker/ in
   this repo); STEMKIT_TELEMETRY_URL overrides it for testing. */
const TELEMETRY_URL =
  (process.env.STEMKIT_TELEMETRY_URL || 'https://stemkit-stats.danielravina.workers.dev') + '/ping'

interface TelemetryState {
  installId: string
  done: boolean
}

function stateFile(): string {
  return join(userDataDir(), 'telemetry.json')
}

function loadState(): TelemetryState {
  try {
    const data = JSON.parse(readFileSync(stateFile(), 'utf8'))
    if (typeof data.installId === 'string' && data.installId) {
      // 0.1.21 stored lastPing for its daily pings; a past ping counts as done
      return { installId: data.installId, done: !!(data.done || data.lastPing) }
    }
  } catch {}
  return { installId: randomUUID(), done: false }
}

function saveState(state: TelemetryState): void {
  try {
    mkdirSync(userDataDir(), { recursive: true })
    writeFileSync(stateFile(), JSON.stringify(state, null, 2))
  } catch {}
}

/* fire-and-forget: never let a ping slow startup or log errors */
export function maybePing(): void {
  if (!app.isPackaged) return
  const state = loadState()
  if (state.done) return

  const payload = JSON.stringify({
    id: state.installId,
    version: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    ts: Date.now()
  })

  const req = net.request({
    url: TELEMETRY_URL,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' }
  })
  // mark done only once the server confirmed it, so an offline first launch
  // retries on the next open instead of never being counted
  req.on('response', (res) => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      saveState({ ...state, done: true })
    }
  })
  req.on('error', () => {})
  req.write(payload)
  req.end()
}