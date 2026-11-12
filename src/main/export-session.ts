import { randomUUID } from 'crypto'
import { writeFile, rm } from 'fs/promises'
import { dirname, join } from 'path'
import { sanitizeName } from './library'

// No Electron here on purpose: the dialogs live in the IPC handlers, so this
// stays testable. The user picks the destination once, then the renderer sends
// each rendered WAV; main never trusts a path coming from the renderer.
// the format is pinned at begin: the dialog already showed that extension to the user
type Session = { kind: 'file' | 'folder'; path: string; format: 'wav' | 'aac'; expiresAt: number }
const sessions = new Map<string, Session>()
// a renderer that crashes mid-export never sends export:end, so an idle
// session expires; every write pushes the deadline back
export const SESSION_TTL_MS = 10 * 60_000

function liveSession(token: string): Session | undefined {
  const session = sessions.get(token)
  if (session && session.expiresAt <= Date.now()) {
    sessions.delete(token)
    return undefined
  }
  return session
}

// for tests: how many sessions main still holds
export function openSessionCount(): number {
  return sessions.size
}
// "Show in folder" takes a path from the renderer, so main only reveals what an
// export actually wrote this run (the file, or the folder of a separate export)
const revealable = new Set<string>()

export function canReveal(path: unknown): path is string {
  return typeof path === 'string' && revealable.has(path)
}

export function openSession(kind: 'file' | 'folder', path: string, format: 'wav' | 'aac'): string {
  const now = Date.now()
  for (const [t, s] of sessions) if (s.expiresAt <= now) sessions.delete(t)
  const token = randomUUID()
  sessions.set(token, { kind, path, format, expiresAt: now + SESSION_TTL_MS })
  return token
}

export async function writeToSession(
  token: string,
  fileName: string | null,
  wav: Uint8Array,
  transcode: (src: string, dest: string) => Promise<void>
): Promise<string> {
  const session = liveSession(token)
  if (!session) throw new Error('Unknown export session')
  session.expiresAt = Date.now() + SESSION_TTL_MS
  const format = session.format
  const ext = format === 'aac' ? 'm4a' : 'wav'
  let dest: string
  if (session.kind === 'file') {
    if (fileName !== null) throw new Error('A single-file export takes no file name')
    // only a real audio extension is swapped: a title like "Mr. Brightside"
    // has a dot that path.parse would take for one and cut the name there
    dest = /\.(wav|m4a)$/i.test(session.path)
      ? session.path.replace(/\.(wav|m4a)$/i, `.${ext}`)
      : `${session.path}.${ext}`
  } else {
    if (fileName === null) throw new Error('A folder export needs a file name')
    dest = join(session.path, `${sanitizeName(fileName)}.${ext}`)
  }
  if (format === 'wav') {
    await writeFile(dest, wav)
  } else {
    await transcodeVia(dest, wav, transcode)
  }
  revealable.add(dest)
  if (session.kind === 'folder') revealable.add(session.path)
  return dest
}

async function transcodeVia(
  dest: string,
  wav: Uint8Array,
  transcode: (src: string, dest: string) => Promise<void>
): Promise<void> {
  // next to the destination so the temp file lives on the same volume
  const tmp = join(dirname(dest), `.stemkit-${randomUUID()}.wav`)
  try {
    await writeFile(tmp, wav)
    await transcode(tmp, dest)
  } catch (err) {
    // a transcoder that dies mid-write leaves a truncated file the user would take for the export
    await rm(dest, { force: true })
    throw err
  } finally {
    await rm(tmp, { force: true })
  }
}

export function closeSession(token: string): void {
  sessions.delete(token)
}
