import { randomUUID } from 'crypto'
import { writeFile, rm } from 'fs/promises'
import { dirname, join, parse } from 'path'
import { sanitizeName } from './library'

// No Electron here on purpose: the dialogs live in the IPC handlers, so this
// stays testable. The user picks the destination once, then the renderer sends
// each rendered WAV; main never trusts a path coming from the renderer.
type Session = { kind: 'file' | 'folder'; path: string }
const sessions = new Map<string, Session>()

export function openSession(kind: 'file' | 'folder', path: string): string {
  const token = randomUUID()
  sessions.set(token, { kind, path })
  return token
}

export async function writeToSession(
  token: string,
  fileName: string | null,
  wav: Uint8Array,
  format: 'wav' | 'aac',
  transcode: (src: string, dest: string) => Promise<void>
): Promise<string> {
  const session = sessions.get(token)
  if (!session) throw new Error('Unknown export session')
  const ext = format === 'aac' ? 'm4a' : 'wav'
  let dest: string
  if (session.kind === 'file') {
    if (fileName !== null) throw new Error('A single-file export takes no file name')
    const p = parse(session.path)
    dest = join(p.dir, `${p.name}.${ext}`)
  } else {
    if (fileName === null) throw new Error('A folder export needs a file name')
    dest = join(session.path, `${sanitizeName(fileName)}.${ext}`)
  }
  if (format === 'wav') {
    await writeFile(dest, wav)
    return dest
  }
  // next to the destination so the temp file lives on the same volume
  const tmp = join(dirname(dest), `.stemkit-${randomUUID()}.wav`)
  try {
    await writeFile(tmp, wav)
    await transcode(tmp, dest)
  } finally {
    await rm(tmp, { force: true })
  }
  return dest
}

export function closeSession(token: string): void {
  sessions.delete(token)
}
