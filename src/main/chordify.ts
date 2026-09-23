import { BrowserWindow, session, dialog } from 'electron'
import { existsSync, readFileSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { songDir } from './library'
import type { ChordsDoc, ChordSegment } from '../shared/types'

const NOTES = ['C','C#','D','D#','E','F','F#','G','G#','A','A#','B'] as const
const FLAT_TO_SHARP: Record<string,string> = { Db:'C#', Eb:'D#', Gb:'F#', Ab:'G#', Bb:'A#' }

// ── path helpers ──────────────────────────────────────────────────────────

export function chordifyJsonPath(videoId: string): string {
  return join(songDir(videoId), 'chords_chordify.json')
}
export function localChordsJsonPath(videoId: string): string {
  return join(songDir(videoId), 'chords.json')
}
export function hasChordifyChords(videoId: string): boolean {
  return existsSync(chordifyJsonPath(videoId))
}
export function readChordifyDoc(videoId: string): ChordsDoc | null {
  try {
    const p = chordifyJsonPath(videoId)
    if (!existsSync(p)) return null
    const raw = readFileSync(p, 'utf8')
    const doc = JSON.parse(raw) as ChordsDoc
    if (!doc || (doc as any).version !== 1 || !Array.isArray(doc.chords)) return null
    return doc
  } catch { return null }
}
export function readLocalDoc(videoId: string): ChordsDoc | null {
  try {
    const p = localChordsJsonPath(videoId)
    if (!existsSync(p)) return null
    const raw = readFileSync(p, 'utf8')
    const doc = JSON.parse(raw) as ChordsDoc
    // old docs had no source field — treat as local
    if (!doc || (doc as any).version !== 1 || !Array.isArray(doc.chords)) return null
    return doc
  } catch { return null }
}
export function readActiveDoc(videoId: string): ChordsDoc | null {
  // Chordify is premium and more accurate — prefer it when present
  return readChordifyDoc(videoId) ?? readLocalDoc(videoId)
}
export function deleteChordifyDoc(videoId: string): void {
  rmSync(chordifyJsonPath(videoId), { force: true })
}

// ── status ────────────────────────────────────────────────────────────────
// Chordify login lives in the "persist:default" partition (where the login
// BrowserWindow stores its cookies — Partitions/default/Network/Cookies),
// NOT in session.defaultSession (Network/Cookies). The old code checked the
// wrong store, so a successful login always read as 0 cookies → "Not
// connected". We now check the correct partition and merge the top store for
// backwards compatibility. We also probe the homepage for a logged-in marker
// ("Log out"/avatar) when cookies alone are ambiguous — anonymous visits
// already create a `session_token` cookie, so name alone cannot prove auth.

export async function getChordifyStatus(): Promise<{ connected: boolean; cookieCount: number; username?: string; names?: string[] }> {
  try {
    const part = session.fromPartition('persist:default')
    // Electron's domain filter is picky about leading dots — pull all and filter manually
    const allPart = await part.cookies.get({})
    const allTop = await session.defaultSession.cookies.get({})
    const chordCookies = [...allPart, ...allTop].filter(c => (c.domain ?? '').includes('chordify.net'))
    const names = chordCookies.map(c => c.name)
    // dedupe names
    const uniqNames = Array.from(new Set(names))
    const hasSessionToken = chordCookies.some(c => c.name === 'session_token' && (c.value?.length ?? 0) > 10)
    // anonymous visits also get session_token, so we try a lightweight
    // logged-in probe: fetch chordify.net in the same partition and look for
    // an authenticated marker. If the probe fails we fall back to cookie heuristic.
    let probedLoggedIn: boolean | null = null
    if (hasSessionToken) {
      try {
        const probeWin = new BrowserWindow({
          show: false,
          webPreferences: { partition: 'persist:default', offscreen: true }
        })
        await probeWin.loadURL('https://chordify.net/')
        // give Cloudflare + hydration a moment
        await new Promise(r => setTimeout(r, 900))
        const probe: string = await probeWin.webContents.executeJavaScript(
          `(() => { try {
            const html = document.documentElement.innerHTML.slice(0, 80000);
            const text = document.body?.innerText?.slice(0, 4000) ?? '';
            // also check localStorage for an auth token / user object chordify keeps there
            let ls = '';
            try { for (let i=0;i<localStorage.length;i++){ const k=localStorage.key(i); if(k && /chordify|auth|user|token/i.test(k)) ls += k + ':' + (localStorage.getItem(k)||'').slice(0,300) + '\\n'; } } catch(e){}
            return JSON.stringify({ htmlLen: html.length, textHead: text.slice(0,1500), ls: ls.slice(0,3000), url: location.href, title: document.title });
          } catch(e){ return JSON.stringify({error:e.message}) } })()`
        )
        let info: any = {}
        try { info = JSON.parse(probe) } catch {}
        const txt: string = (info.textHead ?? '') as string
        // Heuristics: logged-in pages show "Log out", "My songs", "Premium" badge, or avatar menu, and do NOT show "Sign up | Log in" hero
        const hasLogout = /log\s*out/i.test(txt)
        const hasMySongs = /my\s+songs/i.test(txt)
        const hasSignInHero = /sign\s*in\s*-\s*chordify/i.test(info.title ?? '') && /welcome back/i.test(txt)
        if (hasLogout || hasMySongs) probedLoggedIn = true
        else if (hasSignInHero) probedLoggedIn = false
        // also if localStorage contains a user id / token, treat as logged in
        if (info.ls && /chordify|auth/i.test(info.ls) && info.ls.length > 20) probedLoggedIn = true
        try { probeWin.close() } catch {}
      } catch {
        probedLoggedIn = null
      }
    }
    const hasAnyChord = chordCookies.length > 0
    // Final decision: if probe gave a clear answer use it, otherwise fall back
    // to cookie presence (session_token). The probe is the only thing that can
    // distinguish anonymous session_token from an authenticated one.
    const connected = probedLoggedIn !== null ? probedLoggedIn : hasSessionToken || hasAnyChord
    return { connected, cookieCount: chordCookies.length, names: uniqNames }
  } catch {
    return { connected: false, cookieCount: 0, names: [] }
  }
}

// ── login window ──────────────────────────────────────────────────────────

let loginWin: BrowserWindow | null = null

export async function openChordifyLogin(): Promise<{ success: boolean; error?: string }> {
  if (loginWin && !loginWin.isDestroyed()) {
    loginWin.focus()
    return { success: true }
  }
  return new Promise((resolve) => {
    loginWin = new BrowserWindow({
      width: 1100,
      height: 800,
      title: 'Chordify — Log in',
      backgroundColor: '#0b0b10',
      show: true,
      autoHideMenuBar: true,
      webPreferences: {
        partition: 'persist:default',
        nodeIntegration: false,
        contextIsolation: true
      }
    })
    loginWin.setMenuBarVisibility(false)

    // Chordify moved login: /users/sign_in (old, now 404 frog) → /user/signin (current).
    // Handle both plus Cloudflare: on HTTP 404 (frog "Ribbit! Nothing here") auto-retry fallback,
    // then fall back to homepage where the Log in button is always reachable.
    const LOGIN_PRIMARY = 'https://chordify.net/user/signin'
    const LOGIN_FALLBACK = 'https://chordify.net/users/sign_in'
    const LOGIN_HOME = 'https://chordify.net/'
    let triedFallback = false
    let triedHome = false

    const loadLogin = (url: string): void => {
      loginWin!.loadURL(url).catch((e) => console.warn('[chordify] loadURL failed', url, e))
    }
    loadLogin(LOGIN_PRIMARY)

    // HTTP 404s still fire did-finish-load (with the frog page), not did-fail-load,
    // so detect the frog by title/body and auto-retry.
    loginWin.webContents.on('did-finish-load', async () => {
      try {
        const curUrl = loginWin?.webContents.getURL() ?? ''
        const probe: string = await loginWin!.webContents.executeJavaScript(
          `(() => { try { return (document.title + '\\n' + (document.body?.innerText ?? '')).slice(0, 3000) } catch(e){ return '' } })()`
        )
        const is404 = /404|Ribbit! Nothing here but me/i.test(probe)
        if (!is404) return
        console.warn('[chordify] login 404 detected at', curUrl)
        if (!triedFallback) {
          triedFallback = true
          loadLogin(LOGIN_FALLBACK)
          return
        }
        if (!triedHome) {
          triedHome = true
          loadLogin(LOGIN_HOME)
          return
        }
      } catch {}
    })

    const onClosed = (): void => {
      loginWin = null
      resolve({ success: true })
    }
    loginWin.on('closed', onClosed)
    loginWin.webContents.on('did-fail-load', (_e, code, desc, url) => {
      if (code === -3) return // aborted (navigation replaced)
      console.warn('[chordify] login load failed', code, desc, url)
      // ERR_NAME_NOT_RESOLVED / blocked etc — try next fallback
      if (!triedFallback && url.includes('chordify.net')) {
        triedFallback = true
        loadLogin(LOGIN_FALLBACK)
      } else if (!triedHome) {
        triedHome = true
        loadLogin(LOGIN_HOME)
      }
    })
  })
}

export async function logoutChordify(): Promise<void> {
  try {
    const cookies = await session.defaultSession.cookies.get({ domain: 'chordify.net' })
    for (const c of cookies) {
      const url = `https://${c.domain?.startsWith('.') ? c.domain.slice(1) : c.domain}${c.path}`
      try { await session.defaultSession.cookies.remove(url, c.name) } catch {}
    }
    // also clear storage for chordify.net
    try { await session.defaultSession.clearStorageData({ origin: 'https://chordify.net', storages: ['cookies','localstorage'] }) } catch {}
  } catch {}
}

export async function openChordifySongPage(videoId: string): Promise<void> {
  const url = `https://chordify.net/chords/youtube/${videoId}`
  const win = new BrowserWindow({
    width: 1120,
    height: 820,
    title: `Chordify \u2014 ${videoId}`,
    backgroundColor: '#0b0b10',
    show: true,
    autoHideMenuBar: true,
    webPreferences: { partition: 'persist:default', nodeIntegration: false, contextIsolation: true }
  })
  win.setMenuBarVisibility(false)
  await win.loadURL(url)
}

// ── Harte → our label helpers ─────────────────────────────────────────────

function parseHarte(harte: string): { chord: string; root: number; quality: string } | null {
  const raw = harte.trim()
  if (!raw || raw === 'N' || raw === 'X' || raw.toLowerCase() === 'n.c.') {
    return { chord: 'N', root: -1, quality: 'N' }
  }
  // Strip inversion: "C:maj/3" or "C:maj/E" -> keep before /
  const base = raw.split('/')[0]
  // Split at ':'  — root is before ':', quality after
  let rootName = ''
  let qualPart = ''
  if (base.includes(':')) {
    const [r, q] = base.split(':', 2)
    rootName = r.trim()
    qualPart = (q || '').trim()
  } else {
    // fallback: root is leading letter + optional #/b, rest is quality
    const m = base.match(/^([A-G][#b]?)(.*)$/)
    if (!m) return null
    rootName = m[1]
    qualPart = m[2]
  }
  // Normalize root: handle flats
  if (FLAT_TO_SHARP[rootName]) rootName = FLAT_TO_SHARP[rootName]
  // Some chordify roots are like "A#" already sharp — keep
  let root = NOTES.indexOf(rootName as any)
  if (root < 0) {
    // Try enharmonic flat form
    const sharp = FLAT_TO_SHARP[rootName]
    if (sharp) root = NOTES.indexOf(sharp as any)
  }
  if (root < 0) return null
  // Strip parentheses and extras: "maj(7)", "min7(b5)" etc.
  qualPart = qualPart.replace(/\(.*\)/g, '').replace(/\*/g, '').trim()
  // Take first token before comma / space
  qualPart = qualPart.split(/[,\s]/)[0] ?? ''
  qualPart = qualPart.toLowerCase()

  // Map Harte qualities to our 8 qualities
  // Chordify vocab 'extended_inversions' returns: maj, min, 7, min7, maj7, dim, dim7, hdim7, sus2, sus4, maj6, min6, 9, min9, 11, etc.
  let quality = ''
  if (qualPart === '' || qualPart === 'maj' || qualPart === 'major' || qualPart === 'maj6' || qualPart === '6') quality = ''
  else if (qualPart === 'min' || qualPart === 'm' || qualPart === 'minor' || qualPart === 'min6' || qualPart === 'm6') quality = 'm'
  else if (qualPart === '7' || qualPart === '9' || qualPart === '11' || qualPart === '13' || qualPart === 'dom7') quality = '7'
  else if (qualPart === 'min7' || qualPart === 'm7' || qualPart === 'min9' || qualPart === 'm9') quality = 'm7'
  else if (qualPart === 'maj7' || qualPart === 'maj9' || qualPart === 'maj11') quality = 'maj7'
  else if (qualPart.startsWith('dim') || qualPart === 'dim7' || qualPart === 'hdim7') quality = 'dim'
  else if (qualPart === 'sus4' || qualPart === 'sus') quality = 'sus4'
  else if (qualPart === 'sus2') quality = 'sus2'
  else if (qualPart === 'aug') quality = '' // map aug to major for guitar
  else {
    // unknown — try to detect minor flag
    if (qualPart.includes('min') || qualPart === 'm') quality = 'm'
    else if (qualPart.includes('dim')) quality = 'dim'
    else quality = ''
  }
  const suffixMap: Record<string,string> = { '':'' , 'm':'m', '7':'7', 'm7':'m7', 'maj7':'maj7', 'dim':'dim', 'sus4':'sus4', 'sus2':'sus2' }
  const suffix = suffixMap[quality] ?? ''
  const chord = NOTES[root] + suffix
  return { chord, root, quality }
}

// ── Chordify payload → ChordsDoc parser ───────────────────────────────────

interface ChordifyRaw {
  chords?: string | any[]
  barLength?: number
  bar_length?: number
  bpm?: number
  tempo?: number
  key?: string
  [k: string]: any
}

function expandBeats(entries: string[][], barLength: number): string[] {
  // entries: each entry is split ';' fields, first field is beat pos 1..barLength
  // Reconstruct absolute beats array like gist does, with '_' expansion.
  const beats: string[] = []
  let i = 0
  // Guard against malformed where entries have <4 fields — skip
  const filtered = entries.filter(e => e.length >= 2)
  if (filtered.length === 0) return beats
  // Outer loop over bars until we consume all entries
  let safety = 0
  while (i < filtered.length && safety < 10000) {
    safety++
    for (let j = 0; j < barLength; j++) {
      if (i >= filtered.length) {
        beats.push('_')
        continue
      }
      const cur = filtered[i]
      // cur[0] is beat position 1-indexed within bar, cur[1] is chord
      const pos = parseInt(cur[0], 10)
      if (isNaN(pos)) {
        // malformed — treat as chord at this beat
        beats.push(cur[1] ?? 'N')
        i++
      } else if (pos === j + 1) {
        beats.push(cur[1] ?? 'N')
        i++
      } else {
        // no chord at this beat — continuation
        // gist prints '_' but we want previous chord repeated for segment compression
        // So we push '_' marker and later expand.
        beats.push('_')
      }
      // Handle malformed len !=4 case from gist: break outer bar on bad entry
      if (cur.length !== 4 && cur.length !== 2 && cur.length !== 3) {
        // In gist, len !=4 breaks inner loop after i++
        // We already advanced, break to next bar after finishing remaining beats as '_'
        // Fill rest of bar with '_'
        for (let k = j + 1; k < barLength; k++) beats.push('_')
        break
      }
    }
  }
  // Expand '_' to previous chord
  let last = 'N'
  for (let idx = 0; idx < beats.length; idx++) {
    if (beats[idx] === '_' || beats[idx] === '') {
      beats[idx] = last
    } else {
      last = beats[idx]
    }
  }
  return beats
}

export function parseChordifyPayload(raw: ChordifyRaw, songDuration: number, videoId: string): ChordsDoc {
  // Try multiple shapes
  let chordsRaw = raw.chords ?? raw.data ?? raw.result ?? raw
  let barLength = Number(raw.barLength ?? raw.bar_length ?? raw.bars ?? 4)
  if (!barLength || isNaN(barLength) || barLength < 2 || barLength > 8) barLength = 4
  let bpm = Number(raw.bpm ?? raw.tempo ?? raw.bpmDetected ?? raw.estimated_bpm ?? 0)
  // Some payloads embed beats/chords differently

  let beats: string[] = []
  let segments: ChordSegment[] = []

  if (typeof chordsRaw === 'string') {
    // String case: newline separated "pos;chord;..." lines
    const lines = (chordsRaw as string).split('\n').map(s => s.trim()).filter(Boolean)
    const entries = lines.map(l => l.split(';').map(s => s.trim()))
    beats = expandBeats(entries, barLength)
    // If beats empty but lines had chords without pos, fallback: each line is a chord per beat
    if (beats.length === 0 && entries.length > 0) {
      beats = entries.map(e => e[1] ?? e[0] ?? 'N')
    }
    if (bpm <= 0) {
      // Estimate bpm from duration: totalBeats = beats.length, bpm = beats*60/duration
      if (songDuration > 0 && beats.length > 0) bpm = (beats.length * 60) / songDuration
      else bpm = 120
    }
    const beatDur = 60 / bpm
    // Compress beats into segments
    let idx = 0
    while (idx < beats.length) {
      const harte = beats[idx]
      let j = idx + 1
      while (j < beats.length && beats[j] === harte) j++
      const count = j - idx
      const time = idx * beatDur
      const duration = count * beatDur
      const parsed = parseHarte(harte)
      if (!parsed) { idx = j; continue }
      // Skip very short N at start? keep for now
      segments.push({
        time: Math.round(time * 1000) / 1000,
        duration: Math.round(duration * 1000) / 1000,
        chord: parsed.chord,
        root: parsed.root,
        quality: parsed.quality,
        score: 0.95 // chordify is high confidence
      })
      idx = j
    }
  } else if (Array.isArray(chordsRaw)) {
    // Array case: could be array of strings, or array of objects {chord,time,beat}
    // Try to handle object array
    if (chordsRaw.length > 0 && typeof chordsRaw[0] === 'object' && !Array.isArray(chordsRaw[0])) {
      // Object array: each has chord, time, duration, etc.
      for (const obj of chordsRaw as any[]) {
        const harte = String(obj.chord ?? obj.label ?? obj.name ?? obj.value ?? 'N')
        const t = Number(obj.time ?? obj.start ?? obj.beat ?? 0)
        const dur = Number(obj.duration ?? obj.length ?? obj.beats ?? 2)
        // If time is in beats, convert via bpm
        let timeSec = t
        let durSec = dur
        if (bpm > 0 && t < 1000 && t < songDuration) {
          // Heuristic: if t looks like beat index, convert
          // But if object has bpm, assume t is beats
          // We'll treat t as beats if t < beats.length and bpm known
          // Simpler: if t < 500 and bpm known and songDuration>0 and t < songDuration/2, keep as sec
          // We'll assume caller gives seconds; if beats, they'll be small.
        }
        const parsed = parseHarte(harte)
        if (!parsed) continue
        segments.push({
          time: Math.round(timeSec * 1000) / 1000,
          duration: Math.round(durSec * 1000) / 1000,
          chord: parsed.chord,
          root: parsed.root,
          quality: parsed.quality,
          score: 0.92
        })
      }
    } else {
      // Array of strings/arrays like "1;C:maj;..." split already
      const entries = (chordsRaw as any[]).map((e: any) => {
        if (Array.isArray(e)) return e.map(String)
        return String(e).split(';')
      })
      beats = expandBeats(entries, barLength)
      if (bpm <= 0 && songDuration > 0 && beats.length > 0) bpm = (beats.length * 60) / songDuration
      if (bpm <= 0) bpm = 120
      const beatDur = 60 / bpm
      let idx = 0
      while (idx < beats.length) {
        const harte = beats[idx]
        let j = idx + 1
        while (j < beats.length && beats[j] === harte) j++
        const count = j - idx
        const parsed = parseHarte(harte)
        if (!parsed) { idx = j; continue }
        segments.push({
          time: Math.round(idx * beatDur * 1000) / 1000,
          duration: Math.round(count * beatDur * 1000) / 1000,
          chord: parsed.chord,
          root: parsed.root,
          quality: parsed.quality,
          score: 0.95
        })
        idx = j
      }
    }
  } else if (raw && typeof raw === 'object') {
    // Raw is itself the chords string? Try to find any string field that looks like chords
    // fallback: no chords field but raw has keys that are chords?
    throw new Error('Chordify response has no recognizable chords field — raw: ' + JSON.stringify(raw).slice(0, 800))
  }

  if (segments.length === 0) {
    throw new Error('Chordify payload produced no segments — raw preview: ' + JSON.stringify(raw).slice(0, 600))
  }

  // Post-process: ensure last segment fills to songDuration if close
  if (songDuration > 0 && segments.length > 0) {
    const last = segments[segments.length - 1]
    const end = last.time + last.duration
    const gap = songDuration - end
    if (gap > 0.3 && gap < 8) {
      last.duration = Math.round((last.duration + gap) * 1000) / 1000
    }
  }

  // Merge N handling: drop leading/trailing short N like local does
  if (segments.length > 1 && segments[0].chord === 'N' && segments[0].duration < 0.8) segments.shift()
  if (segments.length > 0 && segments[segments.length - 1].chord === 'N' && segments[segments.length - 1].duration < 0.8) segments.pop()

  const doc: ChordsDoc = {
    version: 1,
    duration: Math.round(songDuration * 1000) / 1000 || Math.round((segments[segments.length-1]?.time + segments[segments.length-1]?.duration || 0)*1000)/1000,
    hop: 0.5,
    win: 1.0,
    generatedAt: Date.now(),
    chords: segments,
    source: 'chordify',
    chordifyMeta: { bpm: Math.round(bpm), barLength }
  } as any
  return doc
}

// ── fetch via hidden window ───────────────────────────────────────────────

async function fetchViaHiddenWindow(videoId: string): Promise<any> {
  // We use a hidden BrowserWindow that shares defaultSession, so Cloudflare + auth cookies apply.
  // We navigate to chordify.net first to ensure correct origin, then fetch API via executeJavaScript.
  const endpoints = [
    `https://chordify.net/api/v2/songs/youtube:${videoId}/chords?vocabulary=extended_inversions`,
    `https://chordify.net/api/v2/songs/youtube:${videoId}`,
    `https://chordify.net/api/songs/youtube:${videoId}`
  ]
  const win = new BrowserWindow({
    show: false,
    webPreferences: {
      partition: 'persist:default',
      offscreen: false
    }
  })
  try {
    await win.loadURL('https://chordify.net/')
    // Wait a bit for Cloudflare to settle
    await new Promise(r => setTimeout(r, 800))

    for (const url of endpoints) {
      const script = `
        (async () => {
          try {
            const r = await fetch(${JSON.stringify(url)}, {
              credentials: 'include',
              headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
              redirect: 'follow'
            });
            const text = await r.text();
            return JSON.stringify({ ok: r.ok, status: r.status, url: ${JSON.stringify(url)}, body: text.slice(0, 50000), headers: Object.fromEntries(r.headers.entries()) });
          } catch (e) {
            return JSON.stringify({ error: e.message, url: ${JSON.stringify(url)} });
          }
        })()
      `
      const rawStr = await win.webContents.executeJavaScript(script) as string
      let parsed: any
      try { parsed = JSON.parse(rawStr) } catch { continue }
      if (parsed.error) continue
      if (!parsed.ok) {
        // 404 means song not yet analyzed — chordify may need to trigger analysis
        // 403 may be Cloudflare/WAF — still try next endpoint
        // Keep last error for reporting
        if (parsed.status === 404) {
          // Try to trigger analysis by visiting the chordify page
          // The page at /chords/{id} triggers analysis on first view
          continue
        }
        continue
      }
      // Try to parse body as JSON
      try {
        const body = JSON.parse(parsed.body)
        // Some endpoints return { chords: "...", ... } directly, others wrap
        win.close()
        return body
      } catch {
        // Body is not JSON — maybe HTML? try next
        continue
      }
    }
    // Fallback: try to scrape the song page's Next data
    // Load the youtube chord page
    const pageUrl = `https://chordify.net/chords/youtube/${videoId}`
    await win.loadURL(pageUrl)
    await new Promise(r => setTimeout(r, 1200))
    const scraped = await win.webContents.executeJavaScript(`
      (() => {
        try {
          const html = document.documentElement.outerHTML;
          // Try to find __NEXT_DATA__ or window.__INITIAL__ or embedded JSON
          const nextData = document.getElementById('__NEXT_DATA__')?.textContent?.slice(0, 80000) ?? '';
          const scripts = Array.from(document.querySelectorAll('script')).map(s=>s.textContent?.slice(0,4000) ?? '').join('\\n---\\n').slice(0,8000);
          // Look for chordify API data in page
          return JSON.stringify({ htmlLen: html.length, nextDataLen: nextData.length, nextData: nextData.slice(0,5000), scriptsPreview: scripts.slice(0,3000), title: document.title });
        } catch(e) { return JSON.stringify({error:e.message}) }
      })()
    `) as string
    let info: any = {}
    try { info = JSON.parse(scraped) } catch {}
    // Try to extract chords from nextData if present
    if (info.nextData) {
      try {
        const nd = JSON.parse(info.nextData)
        // Search recursively for chords string
        const findChords = (obj:any, depth=0): any => {
          if (!obj || depth>6) return null
          if (typeof obj === 'string' && obj.includes(';') && obj.includes(':maj')) return obj
          if (typeof obj === 'object') {
            for (const k of Object.keys(obj)) {
              if (k.toLowerCase().includes('chord')) {
                const v = obj[k]
                if (typeof v === 'string' && v.length>10) return v
                if (typeof v === 'object') { const r=findChords(v,depth+1); if(r) return r; }
              }
              if (typeof obj[k]==='object') { const r=findChords(obj[k],depth+1); if(r) return r; }
            }
          }
          return null
        }
        const found = findChords(nd)
        if (found) {
          win.close()
          // Wrap as raw
          return { chords: found, barLength: 4 }
        }
      } catch {}
    }
    // Auto-trigger: leave the chordify page open so their backend starts analysing this YouTube id.
    // We already loaded /chords/youtube/{id} above — keep that win open briefly for the trigger, then close.
    // Give chordify 2s to queue the job before we throw a friendly retry message.
    await new Promise(r => setTimeout(r, 1800))
    win.close()
    throw new Error('Chordify has not analysed this video yet (' + videoId + '). I opened https://chordify.net/chords/youtube/' + videoId + ' to start it — wait ~30-60s on chordify.net (Premium) then hit Fetch again. Your offline chords stay active in the meantime. If it still fails, use Import Chordify JSON.')
  } catch (e) {
    try { win.close() } catch {}
    throw e
  }
}

export async function fetchChordifyForSong(videoId: string, songDuration: number): Promise<ChordsDoc> {
  const status = await getChordifyStatus()
  if (!status.connected) {
    throw new Error('Not connected to Chordify — open the login window first (Settings → Chordify → Log in)')
  }
  const raw = await fetchViaHiddenWindow(videoId)
  const doc = parseChordifyPayload(raw, songDuration, videoId)
  // Write to chordify path
  const dest = chordifyJsonPath(videoId)
  writeFileSync(dest, JSON.stringify(doc, null, 2), 'utf8')
  return doc
}

// ── import from file (user exports JSON from chordify) ────────────────────

export async function importChordifyFile(videoId: string, songDuration: number): Promise<ChordsDoc> {
  const result = await dialog.showOpenDialog({
    title: 'Import Chordify export (JSON)',
    properties: ['openFile'],
    filters: [
      { name: 'Chordify JSON', extensions: ['json'] },
      { name: 'All files', extensions: ['*'] }
    ]
  })
  if (result.canceled || !result.filePaths[0]) throw new Error('Import cancelled')
  const file = result.filePaths[0]
  const text = readFileSync(file, 'utf8')
  let raw: any
  try { raw = JSON.parse(text) } catch { throw new Error('File is not valid JSON') }
  const doc = parseChordifyPayload(raw, songDuration, videoId)
  writeFileSync(chordifyJsonPath(videoId), JSON.stringify(doc, null, 2), 'utf8')
  return doc
}
