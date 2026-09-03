import { spawn, execFile } from 'child_process'
import { existsSync, writeFileSync, readdirSync, createWriteStream, mkdirSync, chmodSync, unlinkSync, statSync, renameSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { app, BrowserWindow, net } from 'electron'

export interface ToolInfo {
  found: boolean
  path?: string
  version?: string
}

export interface EnvState {
  python: ToolInfo
  ffmpeg: ToolInfo
  jsRuntime?: { kind: 'deno' | 'node'; path: string }
  ready: boolean
  bootstrapping: boolean
  updating: boolean
}

const state: EnvState = {
  python: { found: false },
  ffmpeg: { found: false },
  ready: false,
  bootstrapping: false,
  updating: false
}

export function userDataDir(): string {
  return app.getPath('userData')
}

const IS_WIN = process.platform === 'win32'
const EXE = IS_WIN ? '.exe' : ''
const VENV_BIN = IS_WIN ? 'Scripts' : 'bin'

export function venvDir(): string {
  return join(userDataDir(), 'venv')
}

export function venvPython(): string {
  return join(venvDir(), VENV_BIN, 'python' + EXE)
}

export function venvYtDlp(): string {
  return join(venvDir(), VENV_BIN, 'yt-dlp' + EXE)
}

/* standalone python runtime (python-build-standalone), fetched on demand
   so end users never need python installed */
const PBS_TAG = '20241002'
const PBS_VERSION = '3.11.10'

function runtimeDir(): string {
  return join(userDataDir(), 'python-runtime')
}

function runtimePython(): string {
  return IS_WIN
    ? join(runtimeDir(), 'python', 'python.exe')
    : join(runtimeDir(), 'python', 'bin', 'python3')
}

function runtimeArchivePath(): string {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
  const triple = IS_WIN ? `${arch}-pc-windows-msvc-shared` : `${arch}-apple-darwin`
  return join(userDataDir(), `cpython-${PBS_VERSION}-${triple}-install_only.tar.gz`)
}

function runtimeDownloadUrl(): string {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
  const triple = IS_WIN ? `${arch}-pc-windows-msvc-shared` : `${arch}-apple-darwin`
  return (
    `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/` +
    `cpython-${PBS_VERSION}%2B${PBS_TAG}-${triple}-install_only.tar.gz`
  )
}

export function bundledFfmpeg(): string | null {
  const name = 'ffmpeg' + EXE
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'ffmpeg', name)]
    : [join(app.getAppPath(), 'extras', IS_WIN ? 'ffmpeg-win' : 'ffmpeg-mac', name)]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

export function separateScript(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'python', 'separate.py')
  }
  return join(app.getAppPath(), 'python', 'separate.py')
}

export function roformerScript(): string {
  if (app.isPackaged) {
    return join(process.resourcesPath, 'python', 'roformer.py')
  }
  return join(app.getAppPath(), 'python', 'roformer.py')
}

export function modelsDir(): string {
  return join(userDataDir(), 'models')
}

const ENGINE_DEPS = ['beartype', 'rotary_embedding_torch', 'einops']
let engineDepsReady = false

let gpuProbe: Promise<boolean> | null = null

/* the roformer engine runs its STFT on the accelerator, and MPS has no
   aten::_fft_r2c on Intel Macs with AMD graphics — the split dies there after
   a 913MB checkpoint download. So probe the op rather than just the device;
   demucs moves its own STFT to the CPU and is unaffected either way */
const GPU_PROBE = `
import torch
device = None
if torch.cuda.is_available():
    device = 'cuda'
elif torch.backends.mps.is_available():
    device = 'mps'
ok = False
if device is not None:
    try:
        torch.stft(
            torch.zeros(2048, device=device),
            n_fft=512,
            hop_length=128,
            window=torch.hann_window(512, device=device),
            return_complex=True,
        )
        ok = True
    except Exception:
        ok = False
print(1 if ok else 0)
`

/* true when the venv's torch can run the roformer engine on a GPU
   (MPS on Apple Silicon, CUDA on NVIDIA). CPU-only machines stay on
   the demucs engine, which is much faster without GPU acceleration */
export function hasGpuAcceleration(): Promise<boolean> {
  // test hook: simulates a CPU-only machine (the Windows path)
  if (process.env.STEMKIT_FORCE_CPU === '1') return Promise.resolve(false)
  if (!gpuProbe) {
    gpuProbe = runCapture(venvPython(), ['-c', GPU_PROBE], 30000)
      .then((out) => out.trim().endsWith('1'))
      .catch(() => false)
  }
  return gpuProbe
}

/* venvs created before the roformer engine lack a few small packages;
   verify and install them once per session */
export async function ensureEngineDeps(): Promise<boolean> {
  if (engineDepsReady) return true
  try {
    await runCapture(
      venvPython(),
      ['-c', `import ${ENGINE_DEPS.join(', ')}`],
      20000
    )
    engineDepsReady = true
    return true
  } catch {}
  sendEnvEvent('Preparing engine components…')
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        venvPython(),
        ['-m', 'pip', 'install', '-q', 'beartype', 'rotary-embedding-torch', 'einops'],
        { env: { ...process.env } }
      )
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`pip install failed (${code})`))
      )
      child.on('error', reject)
    })
    engineDepsReady = true
    sendEnvEvent('Engine components ready', 'success')
    return true
  } catch (err) {
    sendEnvEvent(
      `Engine components failed: ${err instanceof Error ? err.message : String(err)}`,
      'error'
    )
    return false
  }
}

function cleanVersion(version: string): string {
  return String(version).replace(/^v/, '')
}

async function detectJsRuntime(): Promise<void> {
  const denoPaths = IS_WIN
    ? [
        join(homedir(), '.deno', 'bin', 'deno.exe'),
        join(process.env.LOCALAPPDATA ?? '', 'Programs', 'deno', 'deno.exe')
      ]
    : ['/opt/homebrew/bin/deno', '/usr/local/bin/deno', join(homedir(), '.deno/bin/deno')]
  for (const p of denoPaths.filter((p): p is string => !!p && p.length > 0)) {
    if (existsSync(p)) {
      state.jsRuntime = { kind: 'deno', path: p }
      return
    }
  }

  const nodeCandidates: string[] = []
  if (IS_WIN) {
    nodeCandidates.push(
      join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'nodejs', 'node.exe'),
      join(process.env['LOCALAPPDATA'] ?? '', 'Programs', 'nodejs', 'node.exe')
    )
    const nvmHome =
      process.env.NVM_HOME ??
      join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'nvm')
    try {
      for (const ver of readdirSync(nvmHome)) {
        const major = parseInt(cleanVersion(ver).split('.')[0], 10)
        if (!Number.isNaN(major) && major >= 18) {
          nodeCandidates.push(join(nvmHome, ver, 'node.exe'))
        }
      }
    } catch {}
  } else {
    nodeCandidates.push('/opt/homebrew/bin/node', '/usr/local/bin/node')
    const nvmRoot = join(homedir(), '.nvm/versions/node')
    try {
      for (const ver of readdirSync(nvmRoot)) {
        const major = parseInt(cleanVersion(ver).split('.')[0], 10)
        if (!Number.isNaN(major) && major >= 18) {
          nodeCandidates.push(join(nvmRoot, ver, 'bin', 'node'))
        }
      }
    } catch {}
  }

  let best: { path: string; version: string } | null = null
  for (const p of nodeCandidates) {
    try {
      const out = await runCapture(p, ['-v'], 5000)
      const version = cleanVersion(out.trim())
      const major = parseInt(version.split('.')[0], 10)
      if (Number.isNaN(major) || major < 18) continue
      if (!best || cmpVersions(version, best.version) > 0) best = { path: p, version }
    } catch {
      continue
    }
  }
  if (best) state.jsRuntime = { kind: 'node', path: best.path }
}

function cmpVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0)
  }
  return 0
}

export function ytDlpRuntimeArgs(): string[] {
  if (!state.jsRuntime) return []
  return ['--js-runtimes', `${state.jsRuntime.kind}:${state.jsRuntime.path}`]
}

function pyCandidates(): string[] {
  if (IS_WIN) {
    const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
    const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files'
    return [
      process.env.STEMKIT_PYTHON,
      join(localAppData, 'Programs', 'Python', 'Python312', 'python.exe'),
      join(localAppData, 'Programs', 'Python', 'Python311', 'python.exe'),
      join(localAppData, 'Programs', 'Python', 'Python310', 'python.exe'),
      join(localAppData, 'Programs', 'Python', 'Python39', 'python.exe'),
      join(programFiles, 'Python312', 'python.exe'),
      join(programFiles, 'Python311', 'python.exe'),
      join(programFiles, 'Python310', 'python.exe'),
      join(programFiles, 'Python39', 'python.exe'),
      join(localAppData, 'Microsoft', 'WindowsApps', 'python3.exe'),
      join(localAppData, 'Microsoft', 'WindowsApps', 'python.exe')
    ].filter((p): p is string => !!p)
  }
  const home = homedir()
  return [
    process.env.STEMKIT_PYTHON,
    '/opt/homebrew/bin/python3',
    '/usr/local/bin/python3',
    '/usr/bin/python3',
    join(home, 'opt/anaconda3/bin/python3'),
    join(home, 'anaconda3/bin/python3'),
    join(home, 'miniconda3/bin/python3'),
    '/opt/homebrew/bin/python3.12',
    '/opt/homebrew/bin/python3.11',
    '/opt/homebrew/bin/python3.10'
  ].filter((p): p is string => !!p)
}

function ffCandidates(): string[] {
  if (IS_WIN) {
    const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
    return [
      process.env.STEMKIT_FFMPEG,
      join(localAppData, 'Microsoft', 'WinGet', 'Links', 'ffmpeg.exe'),
      'C:\\ffmpeg\\bin\\ffmpeg.exe',
      join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'ffmpeg', 'bin', 'ffmpeg.exe')
    ].filter((p): p is string => !!p)
  }
  const home = homedir()
  return [
    process.env.STEMKIT_FFMPEG,
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    join(home, 'opt/anaconda3/bin/ffmpeg'),
    join(home, 'anaconda3/bin/ffmpeg'),
    '/usr/bin/ffmpeg'
  ].filter((p): p is string => !!p)
}

function runCapture(cmd: string, args: string[], timeout = 10000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}

interface PyProbe {
  path: string
  version: string
  machine: string
}

export async function detectTools(): Promise<void> {
  const probes: PyProbe[] = []
  const candidates: string[] = []
  if (existsSync(runtimePython())) candidates.push(runtimePython())
  // STEMKIT_FORCE_RUNTIME=1 ignores system python so the private-runtime
  // download path can be exercised on machines that have python installed
  if (process.env.STEMKIT_FORCE_RUNTIME !== '1') candidates.push(...pyCandidates())
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue
    try {
      const out = await runCapture(candidate, [
        '-c',
        'import sys,platform;print("%d.%d %s"%(*sys.version_info[:2],platform.machine()))'
      ])
      const [version, machine] = out.trim().split(/\s+/)
      const minor = parseInt(version.split('.')[1], 10)
      const major = parseInt(version.split('.')[0], 10)
      if (major > 3 || (major === 3 && minor >= 10 && minor <= 12)) {
        probes.push({ path: candidate, version, machine: machine ?? 'unknown' })
      }
    } catch {
      continue
    }
  }
  probes.sort((a, b) => {
    const aArm = a.machine === 'arm64' ? 0 : 1
    const bArm = b.machine === 'arm64' ? 0 : 1
    if (aArm !== bArm) return aArm - bArm
    return parseInt(b.version.split('.')[1], 10) - parseInt(a.version.split('.')[1], 10)
  })
  const best = probes[0]
  if (best) {
    state.python = { found: true, path: best.path, version: best.version }
  }

  const bundled = bundledFfmpeg()
  if (bundled) {
    state.ffmpeg = { found: true, path: bundled }
  } else {
    for (const candidate of ffCandidates()) {
      if (!existsSync(candidate)) continue
      try {
        await runCapture(candidate, ['-version'])
        state.ffmpeg = { found: true, path: candidate }
        break
      } catch {
        continue
      }
    }
  }

  await detectJsRuntime()
}

function sendEnvEvent(message: string, level: 'info' | 'error' | 'success' = 'info'): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('env:event', { message, level })
  }
}

export async function refreshReady(): Promise<boolean> {
  const marker = join(venvDir(), '.ready')
  state.ready =
    existsSync(marker) && existsSync(venvPython()) && existsSync(venvYtDlp())
  return state.ready
}

function downloadTo(
  url: string,
  dest: string,
  label: string,
  onProgress?: (pct: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    // download into <dest>.part so an interrupted fetch can resume and a
    // partial file is never mistaken for the real one; rename on success
    const part = dest + '.part'
    const base = existsSync(part) ? statSync(part).size : 0
    let lastPct = -1
    let lastFine = -1
    const req = net.request({
      url,
      redirect: 'follow',
      ...(base > 0 ? { headers: { Range: `bytes=${base}-` } } : {})
    })
    req.on('response', (res) => {
      if (res.statusCode === 416 && base > 0) {
        // the .part already holds the whole file (killed right before the rename)
        renameSync(part, dest)
        onProgress?.(100)
        resolve()
        return
      }
      if (res.statusCode !== 200 && res.statusCode !== 206) {
        reject(new Error(`${label} download failed (HTTP ${res.statusCode})`))
        return
      }
      const resumed = res.statusCode === 206 && base > 0
      const start = resumed ? base : 0
      const total = start + Number(res.headers['content-length'] ?? 0)
      const out = createWriteStream(part, { flags: resumed ? 'append' : 'w' })
      let done = 0
      res.on('data', (chunk: Buffer) => {
        done += chunk.length
        out.write(chunk)
        if (total > 0) {
          const pct = Math.floor(((start + done) / total) * 100)
          if (pct >= lastPct + 10) {
            lastPct = pct
            sendEnvEvent(`${label}: ${pct}%`)
          }
          if (onProgress && pct > lastFine) {
            lastFine = pct
            onProgress(pct)
          }
        }
      })
      res.on('end', () =>
        out.end(() => {
          try {
            renameSync(part, dest)
            onProgress?.(100)
            resolve()
          } catch (e) {
            reject(e instanceof Error ? e : new Error(String(e)))
          }
        })
      )
      res.on('error', (e) => {
        out.close()
        reject(e instanceof Error ? e : new Error(String(e)))
      })
    })
    req.on('error', (e) => reject(e instanceof Error ? e : new Error(String(e))))
    req.end()
  })
}

/* Mel-band roformer vocals checkpoint. Fetched once per machine: during
   setup for new installs, in the background for existing ones, and awaited
   by the pipeline so a split never races the download. Non-fatal — the lazy
   download inside roformer.py stays as the fallback */
const CKPT_NAME = 'MelBandRoformer.ckpt'
const CKPT_URL =
  'https://huggingface.co/KimberleyJSN/melbandroformer/resolve/main/MelBandRoformer.ckpt'

export function vocalsEnginePath(): string {
  return join(modelsDir(), CKPT_NAME)
}

let vocalsEnginePromise: Promise<boolean> | null = null
const vocalsProgressListeners = new Set<(pct: number) => void>()

export function ensureVocalsEngine(onProgress?: (pct: number) => void): Promise<boolean> {
  if (onProgress) vocalsProgressListeners.add(onProgress)
  const detach = (): boolean => {
    if (onProgress) vocalsProgressListeners.delete(onProgress)
    return true
  }
  if (existsSync(vocalsEnginePath())) {
    detach()
    return Promise.resolve(true)
  }
  if (!vocalsEnginePromise) {
    vocalsEnginePromise = (async () => {
      if (!(await hasGpuAcceleration())) {
        sendEnvEvent('No GPU acceleration — skipping the vocals engine download')
        return false
      }
      mkdirSync(modelsDir(), { recursive: true })
      sendEnvEvent('Downloading the vocals engine (~913MB, one time)')
      await downloadTo(CKPT_URL, vocalsEnginePath(), 'vocals engine', (pct) => {
        for (const listener of vocalsProgressListeners) listener(pct)
      })
      sendEnvEvent('Vocals engine ready', 'success')
      return true
    })()
      .catch((err) => {
        sendEnvEvent(
          `Vocals engine download failed: ${err instanceof Error ? err.message : String(err)} — it will download before the first split`,
          'error'
        )
        return false
      })
      .finally(() => {
        vocalsEnginePromise = null
      })
  }
  return vocalsEnginePromise.then(detach)
}

function extractArchive(archive: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    mkdirSync(dest, { recursive: true })
    // GNU tar (e.g. Git for Windows) treats "C:\..." as a remote host and dies
    // with "Cannot connect to C: resolve failed". Prefer Windows built-in bsdtar.
    const sys32Tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    const tarBin = IS_WIN && existsSync(sys32Tar) ? sys32Tar : 'tar'
    const child = spawn(tarBin, ['-xzf', archive, '-C', dest], { stdio: 'ignore' })
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`extract failed (${code})`))
    )
    child.on('error', reject)
  })
}

export async function ensureRuntimePython(): Promise<boolean> {
  if (existsSync(runtimePython())) return true
  try {
    const archive = runtimeArchivePath()
    sendEnvEvent('Downloading components (~35MB)')
    await downloadTo(runtimeDownloadUrl(), archive, 'components')
    sendEnvEvent('Unpacking components')
    await extractArchive(archive, runtimeDir())
    unlinkSync(archive)
    if (!existsSync(runtimePython())) throw new Error('runtime python missing after extract')
    chmodSync(runtimePython(), 0o755)

    const out = await runCapture(runtimePython(), ['-V'], 15000).catch(() => '')
    if (!/Python 3\./.test(out)) throw new Error(`runtime python not runnable (${out.trim()})`)
    return true
  } catch (err) {
    sendEnvEvent(
      `Setup failed: ${err instanceof Error ? err.message : String(err)}`,
      'error'
    )
    try {
      unlinkSync(runtimeArchivePath())
    } catch {}
    return false
  }
}

/* PyTorch shipped its last macOS x86_64 wheels in 2.2.2, so the 2.5.1 pin
   cannot resolve on Intel Macs and the whole install aborts. Those machines
   have no GPU acceleration anyway, so they run the demucs engine, which
   2.2.2 supports. Probe the interpreter rather than process.arch — a system
   python can be a different architecture to Electron. */
async function torchPins(python: string): Promise<string[]> {
  let machine = process.arch === 'arm64' ? 'arm64' : 'x86_64'
  try {
    machine = (
      await runCapture(python, ['-c', 'import platform;print(platform.machine())'], 15000)
    ).trim()
  } catch {}
  const version = process.platform === 'darwin' && machine !== 'arm64' ? '2.2.2' : '2.5.1'
  return [`torch==${version}`, `torchaudio==${version}`]
}

export async function bootstrap(): Promise<boolean> {
  if (state.bootstrapping) return false
  if (!state.python.found || !state.python.path) {
    const ok = await ensureRuntimePython()
    if (!ok) {
      sendEnvEvent('No suitable python3 found on this machine', 'error')
      return false
    }
    await detectTools()
    if (!state.python.found || !state.python.path) {
      sendEnvEvent('No suitable python3 found on this machine', 'error')
      return false
    }
  }
  state.bootstrapping = true

  try {
    const venv = venvDir()
    const pip = venvPython()

    sendEnvEvent('Preparing workspace')
    await new Promise<void>((resolve, reject) => {
      const child = spawn(state.python.path as string, ['-m', 'venv', '--clear', venv])
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`venv creation failed (${code})`))
      )
      child.on('error', reject)
    })

    await new Promise<void>((resolve, reject) => {
      const child = spawn(pip, ['-m', 'pip', 'install', '-q', '-U', 'pip', 'wheel', 'setuptools'])
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`pip upgrade failed (${code})`))
      )
      child.on('error', reject)
    })

    const torch = await torchPins(pip)

    sendEnvEvent('Downloading the separation engine (~2GB, one time) — grab a coffee')
    let lastGeneric = 0
    await new Promise<void>((resolve, reject) => {
      const child = spawn(pip, [
        '-m',
        'pip',
        'install',
        '--progress-bar',
        'off',
        'demucs==4.0.1',
        ...torch,
        'numpy<2',
        'beartype',
        'rotary-embedding-torch',
        'einops',
        'yt-dlp'
      ])
      let buffer = ''
      child.stdout?.on('data', (chunk: Buffer) => {
        buffer += chunk.toString()
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const t = line.trim()
          if (!t || /^(Looking in|Using cached)/.test(t)) continue
          if (/^(Collecting|Downloading|Installing collected|Successfully installed)/i.test(t)) {
            const now = Date.now()
            if (now - lastGeneric > 8000) {
              lastGeneric = now
              sendEnvEvent('Still downloading — this happens only once')
            }
            continue
          }
          sendEnvEvent(t.length > 120 ? t.slice(0, 117) + '...' : t)
        }
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        const t = chunk.toString().trim()
        if (t.startsWith('ERROR') || t.startsWith('error')) sendEnvEvent(t.slice(0, 200), 'error')
      })
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`engine install failed (${code})`))
      )
      child.on('error', reject)
    })

    await new Promise<void>((resolve, reject) => {
      const child = spawn(pip, ['-m', 'pip', 'install', 'yt-dlp-ejs'])
      let lastErr = ''
      child.stdout?.on('data', (chunk: Buffer) => {
        for (const line of chunk.toString().split('\n')) {
          const t = line.trim()
          if (/^(Collecting|Downloading|Installing)/i.test(t)) sendEnvEvent(t.slice(0, 200))
        }
      })
      child.stderr?.on('data', (chunk: Buffer) => {
        lastErr = chunk.toString().trim()
        if (lastErr) sendEnvEvent(lastErr.slice(0, 200), 'error')
      })
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`solver install failed (${code})${lastErr ? `: ${lastErr.slice(0, 200)}` : ''}`))
      )
      child.on('error', reject)
    })

    writeFileSync(join(venv, '.ready'), JSON.stringify({ createdAt: Date.now() }))
    await refreshReady()
    sendEnvEvent('Engine ready', 'success')
    // one consolidated wait for new installs: grab the vocals engine now so
    // the first split starts instantly (never blocks setup on failure)
    await ensureVocalsEngine().catch(() => false)
    return true
  } catch (err) {
    sendEnvEvent(err instanceof Error ? err.message : String(err), 'error')
    return false
  } finally {
    state.bootstrapping = false
  }
}

export async function updateYtDlp(): Promise<boolean> {
  if (state.updating) return false
  state.updating = true
  try {
    sendEnvEvent('Updating yt-dlp...')
    await new Promise<void>((resolve, reject) => {
      const child = spawn(venvPython(), [
        '-m',
        'pip',
        'install',
        '-q',
        '-U',
        'yt-dlp',
        'yt-dlp-ejs'
      ])
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`code ${code}`))))
      child.on('error', reject)
    })
    sendEnvEvent('yt-dlp updated', 'success')
    return true
  } catch (err) {
    sendEnvEvent(`yt-dlp update failed: ${String(err)}`, 'error')
    return false
  } finally {
    state.updating = false
  }
}

export function getStatus(): EnvState {
  return { ...state }
}
