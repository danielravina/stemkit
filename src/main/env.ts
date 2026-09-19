import { spawn, execFile } from 'child_process'
import { existsSync, writeFileSync, readdirSync, readFileSync, createWriteStream, mkdirSync, chmodSync, unlinkSync, statSync, renameSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'
import { app, BrowserWindow, net } from 'electron'
import type { EngineStatus, GpuVendor } from '../shared/types'

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

/* CUDA torch (the NVIDIA GPU engine swap) works on windows and linux; ROCm
   torch (AMD) is linux-only. macOS stays on MPS/CPU via the default torch
   build */
const SUPPORTS_GPU = IS_WIN || process.platform === 'linux'

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

function runtimeTriple(): string {
  const arch = process.arch === 'arm64' ? 'aarch64' : 'x86_64'
  if (IS_WIN) return `${arch}-pc-windows-msvc-shared`
  if (process.platform === 'darwin') return `${arch}-apple-darwin`
  return `${arch}-unknown-linux-gnu`
}

function runtimeArchivePath(): string {
  return join(userDataDir(), `cpython-${PBS_VERSION}-${runtimeTriple()}-install_only.tar.gz`)
}

function runtimeDownloadUrl(): string {
  return (
    `https://github.com/astral-sh/python-build-standalone/releases/download/${PBS_TAG}/` +
    `cpython-${PBS_VERSION}%2B${PBS_TAG}-${runtimeTriple()}-install_only.tar.gz`
  )
}

function ffmpegExtraDir(): string {
  if (IS_WIN) return 'ffmpeg-win'
  if (process.platform === 'darwin') return 'ffmpeg-mac'
  return 'ffmpeg-linux'
}

export function bundledFfmpeg(): string | null {
  const name = 'ffmpeg' + EXE
  const candidates = app.isPackaged
    ? [join(process.resourcesPath, 'ffmpeg', name)]
    : [join(app.getAppPath(), 'extras', ffmpegExtraDir(), name)]
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
let gpuInfo: boolean | undefined

/* informational only: whether the venv's torch can use a GPU (MPS on Apple
   Silicon, CUDA on NVIDIA). Engine choice no longer depends on this — it is
   surfaced in Settings as "GPU acceleration available — fast" vs "not
   available — CPU, slower" */
export function hasGpuAcceleration(): Promise<boolean> {
  // test hook: simulates a CPU-only machine (the Windows path)
  if (process.env.STEMKIT_FORCE_CPU === '1') {
    gpuInfo = false
    return Promise.resolve(false)
  }
  if (!gpuProbe) {
    gpuProbe = runCapture(
      venvPython(),
      [
        '-c',
        'import torch;print(1 if (torch.cuda.is_available() or torch.backends.mps.is_available()) else 0)'
      ],
      30000
    )
      .then((out) => out.trim().endsWith('1'))
      .catch(() => false)
      .then((gpu) => {
        gpuInfo = gpu
        return gpu
      })
  }
  return gpuProbe
}

export function gpuAccelerationInfo(): boolean | undefined {
  return gpuInfo
}

let nvidiaProbe: Promise<boolean> | null = null

/* windows + linux: whether an NVIDIA GPU is present (nvidia-smi ships with
   the driver). Part of the vendor detection that gates the GPU-acceleration
   toggle in Settings */
export function detectNvidiaGpu(): Promise<boolean> {
  if (!SUPPORTS_GPU) {
    return Promise.resolve(false)
  }
  if (!nvidiaProbe) {
    nvidiaProbe = runCapture(
      'nvidia-smi',
      ['--query-gpu=name,memory.total', '--format=csv,noheader'],
      10000
    )
      .then((out) => /nvidia/i.test(out))
      .catch(() => false)
  }
  return nvidiaProbe
}

let amdProbe: Promise<boolean> | null = null

/* linux only: whether an AMD GPU is present. sysfs needs no tools and works
   inside the AppImage (unlike lspci/rocminfo); 0x1002 is the AMD/ATI vendor
   id. Not a support statement — the compute preflight in ensureGpuEngine
   decides whether the ROCm torch can actually run on the card */
export function detectAmdGpu(): Promise<boolean> {
  if (process.platform !== 'linux') {
    return Promise.resolve(false)
  }
  if (!amdProbe) {
    amdProbe = (async () => {
      try {
        for (const entry of readdirSync('/sys/class/drm')) {
          if (!/^card\d+$/.test(entry)) continue
          try {
            const vendor = readFileSync(join('/sys/class/drm', entry, 'device', 'vendor'), 'utf8')
            if (vendor.trim() === '0x1002') return true
          } catch {}
        }
      } catch {}
      return false
    })()
  }
  return amdProbe
}

let vendorProbe: Promise<GpuVendor | null> | null = null
let vendorInfo: GpuVendor | null | undefined

/* which vendor GPU acceleration should target; NVIDIA wins when both are
   present (the CUDA path is better supported than ROCm) */
export function detectGpuVendor(): Promise<GpuVendor | null> {
  if (!vendorProbe) {
    vendorProbe = (async () => {
      const vendor = (await detectNvidiaGpu()) ? 'nvidia' : (await detectAmdGpu()) ? 'amd' : null
      vendorInfo = vendor
      return vendor
    })()
  }
  return vendorProbe
}

export function gpuVendorInfo(): GpuVendor | null | undefined {
  return vendorInfo
}

let nvidiaCapProbe: Promise<string | null> | null = null

/* NVIDIA compute capability, e.g. "12.0" for an RTX 5090 (sm_120). Exposed by
   nvidia-smi on driver 450+; null when absent or unreadable */
export function detectNvidiaComputeCap(): Promise<string | null> {
  if (!SUPPORTS_GPU) return Promise.resolve(null)
  if (!nvidiaCapProbe) {
    nvidiaCapProbe = runCapture(
      'nvidia-smi',
      ['--query-gpu=compute_cap', '--format=csv,noheader'],
      10000
    )
      .then((out) => {
        const m = out.match(/(\d+)\.(\d+)/)
        return m ? `${m[1]}.${m[2]}` : null
      })
      .catch(() => null)
  }
  return nvidiaCapProbe
}

/* the torch build's CUDA runtime version, e.g. "12.1"; empty when unset or
   the venv has no torch */
async function torchCudaVersion(): Promise<string> {
  return (
    await runCapture(
      venvPython(),
      ['-c', 'import torch;print(torch.version.cuda or "")'],
      30000
    ).catch(() => '')
  ).trim()
}

function cudaVersionAtLeast(v: string, maj: number, min: number): boolean {
  const m = v.match(/(\d+)\.(\d+)/)
  if (!m) return false
  return parseInt(m[1], 10) * 100 + parseInt(m[2], 10) >= maj * 100 + min
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
    : ['/opt/homebrew/bin/deno', '/usr/local/bin/deno', '/usr/bin/deno', join(homedir(), '.deno/bin/deno')]
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
    nodeCandidates.push('/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node')
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
    '/usr/bin/python3.12',
    '/usr/bin/python3.11',
    '/usr/bin/python3.10',
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

/* system pythons on Debian/Ubuntu often lack the venv module
   (python3-venv not installed), which only surfaces later as a cryptic
   "ensurepip is not available" failure. Filter them out up front so the
   private runtime is picked instead */
async function canCreateVenv(candidate: string): Promise<boolean> {
  if (candidate === runtimePython()) return true
  try {
    await runCapture(candidate, ['-m', 'venv', '--help'], 10000)
    return true
  } catch {
    return false
  }
}

export async function detectTools(): Promise<void> {
  const probes: PyProbe[] = []
  const candidates: string[] = []
  if (existsSync(runtimePython())) candidates.push(runtimePython())
  // STEMKIT_FORCE_RUNTIME=1 ignores system python so the private-runtime
  // download path can be exercised on machines that have python installed.
  // On Linux the private runtime is preferred anyway: system pythons are
  // commonly missing python3-venv and are PEP 668 externally-managed.
  const preferRuntime = process.platform === 'linux' || process.env.STEMKIT_FORCE_RUNTIME === '1'
  if (!preferRuntime) candidates.push(...pyCandidates())
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
        if (await canCreateVenv(candidate)) {
          probes.push({ path: candidate, version, machine: machine ?? 'unknown' })
        }
      }
    } catch {
      continue
    }
  }
  // Linux fallback: no usable python yet (no runtime, system lacks venv
  // module) — still probe system pythons so the error path can name one.
  // bootstrap() below will prefer downloading the private runtime.
  if (probes.length === 0 && preferRuntime) {
    for (const candidate of pyCandidates()) {
      if (!existsSync(candidate) || candidates.includes(candidate)) continue
      try {
        const out = await runCapture(candidate, [
          '-c',
          'import sys,platform;print("%d.%d %s"%(*sys.version_info[:2],platform.machine()))'
        ])
        const [version] = out.trim().split(/\s+/)
        const minor = parseInt(version.split('.')[1], 10)
        const major = parseInt(version.split('.')[0], 10)
        if (major > 3 || (major === 3 && minor >= 10 && minor <= 12)) {
          probes.push({ path: candidate, version, machine: 'no-venv-module' })
        }
      } catch {
        continue
      }
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
      // downloads surfaced in the UI (with an onProgress observer) report
      // finer-grained progress than the plain setup-log ones
      const step = onProgress ? 2 : 10
      res.on('data', (chunk: Buffer) => {
        done += chunk.length
        out.write(chunk)
        if (total > 0) {
          const pct = Math.floor(((start + done) / total) * 100)
          if (pct >= lastPct + step) {
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

/* Mel-band roformer vocals checkpoint. Fetched once per machine when the
   "studio-quality vocals" setting is enabled (explicitly, non-default), and
   awaited by the pipeline so a split never races the download. Non-fatal —
   the lazy download inside roformer.py stays as the fallback. Runs on CPU
   too: the toggle deliberately decouples quality from hardware */
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

/* htdemucs_ft checkpoint (~320MB, fine-tuned demucs). Fetched through the
   venv's torch-hub (get_model) so the cache location and file naming match
   exactly what separate.py expects at separation time. Progress is parsed
   from the downloader's output and reported via env events */
let ftWeightsPromise: Promise<boolean> | null = null
const ftProgressListeners = new Set<(pct: number) => void>()
let ftVerified = false

// htdemucs_ft is a bag of 4 checkpoints (demucs/remote/htdemucs_ft.yaml);
// torch-hub downloads them one after another, each with its own bar
const FT_BAG_COUNT = 4

function torchHubFetch(model: string, onProgress?: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      venvPython(),
      ['-c', `from demucs.pretrained import get_model; get_model(${JSON.stringify(model)})`],
      { env: { ...process.env } }
    )
    let lastPct = 0
    let filesDone = 0
    let stderrTail = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-1000)
      for (const piece of chunk.toString().split(/[\r\n]/)) {
        const m = piece.match(/(\d{1,3})%/)
        if (!m) continue
        const pct = Math.min(100, parseInt(m[1], 10))
        if (pct < lastPct) {
          // the next checkpoint's bar wrapped — count the previous as done
          filesDone = Math.min(filesDone + 1, FT_BAG_COUNT - 1)
        }
        lastPct = pct
        const overall = Math.min(
          99,
          Math.round(((filesDone + pct / 100) / FT_BAG_COUNT) * 100)
        )
        sendEnvEvent(`fine-tuned engine: ${overall}%`)
        onProgress?.(overall)
      }
    })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        onProgress?.(100)
        resolve()
      } else {
        reject(
          new Error(
            stderrTail.split('\n').filter(Boolean).slice(-1).join('') ||
              `fine-tuned engine download exited ${code}`
          )
        )
      }
    })
  })
}

export function ensureFtWeights(onProgress?: (pct: number) => void): Promise<boolean> {
  if (onProgress) ftProgressListeners.add(onProgress)
  const detach = (): boolean => {
    if (onProgress) ftProgressListeners.delete(onProgress)
    return true
  }
  if (!ftWeightsPromise) {
    ftWeightsPromise = (async () => {
      sendEnvEvent('Downloading the fine-tuned engine (~320MB, one time)')
      await torchHubFetch('htdemucs_ft', (pct) => {
        for (const listener of ftProgressListeners) listener(pct)
      })
      sendEnvEvent('Fine-tuned engine ready', 'success')
      ftVerified = true
      return true
    })()
      .catch((err) => {
        sendEnvEvent(
          `Fine-tuned engine download failed: ${err instanceof Error ? err.message : String(err)} — it will download before the next split`,
          'error'
        )
        return false
      })
      .finally(() => {
        ftWeightsPromise = null
      })
  }
  return ftWeightsPromise.then(detach)
}

/* GPU builds of torch. The default bootstrap installs the CPU wheel (on
   linux pinned to the cpu index, since the default linux wheel would
   otherwise pull CUDA deps for everyone); these swap in on demand when the
   GPU-acceleration toggle is enabled — cu121 for NVIDIA (~2.5GB download),
   rocm6.2 for AMD on linux. They stay installed when the toggle goes back
   off — GPU torch handles cpu devices fine */
const GPU_TORCH_VERSION = '2.5.1'
const GPU_TORCH_INDEX: Record<GpuVendor, string> = {
  nvidia: 'https://download.pytorch.org/whl/cu121',
  amd: 'https://download.pytorch.org/whl/rocm6.2'
}

/* official rocm wheels ship kernel images for gfx90x/942, gfx1030 and
   gfx1100 only; consumer RDNA parts (RX 6600 = gfx1032, 7600 = gfx1102,
   680M iGPU = gfx1035, …) need HSA_OVERRIDE_GFX_VERSION to run the nearest
   code object. The compute preflight below validates the result — if the
   override does not save the card, the CPU path stays in charge */
function gfxOverride(gfx: string): string | null {
  const id = parseInt((gfx.match(/gfx(\d+)/) ?? [])[1] ?? '', 10)
  if (Number.isNaN(id)) return null
  if (id >= 1010 && id <= 1039) return '10.3.0'
  if (id >= 1101 && id <= 1103) return '11.0.0'
  return null
}

/* RTX 50-series and newer (compute capability 12.0/10.0) have no kernels in
   cu121 torch — first launch dies with "no kernel image is available". The
   cu128 build of torch 2.7.0 ships sm_100/120 kernels; every older NVIDIA
   card stays on the long-tested 2.5.1 cu121 engine. torch 2.7 needs the
   torch.load shim in separate.py (demucs ships pre-2.6 checkpoints) */
const BLACKWELL_TORCH_VERSION = '2.7.0'
const BLACKWELL_TORCH_INDEX = 'https://download.pytorch.org/whl/cu128'

/* the HSA override computed by the AMD preflight must survive restarts: the
   informational gpu probe (torch.cuda.is_available) passes without it, so a
   fresh session would otherwise skip the preflight and ship an override-less
   env to the separation runs */
function gpuOverrideFile(): string {
  return join(userDataDir(), '.gpu-override')
}

export function applyGpuOverride(): void {
  try {
    const saved = readFileSync(gpuOverrideFile(), 'utf8').trim()
    if (/^\d+\.\d+\.\d+$/.test(saved)) process.env.HSA_OVERRIDE_GFX_VERSION = saved
  } catch {}
}

let gpuEnginePromise: Promise<boolean> | null = null
const gpuProgressListeners = new Set<(pct: number) => void>()

/* requireVendor (with force off): only proceed when that vendor is the one
   detected on this machine. force (smoke test): install the named wheels
   regardless of detection */
export function ensureGpuEngine(
  onProgress?: (pct: number) => void,
  requireVendor?: GpuVendor | null,
  force = false
): Promise<boolean> {
  if (onProgress) gpuProgressListeners.add(onProgress)
  const detach = (): boolean => {
    if (onProgress) gpuProgressListeners.delete(onProgress)
    return true
  }
  if (!SUPPORTS_GPU) {
    detach()
    return Promise.resolve(false)
  }
  if (!gpuEnginePromise) {
    gpuEnginePromise = (async () => {
      // the Settings toggle is only rendered when a GPU was detected, but a
      // stale setting or a failed probe could still land here — don't pull
      // ~2.5GB of GPU torch on a machine that can't use it
      const detected = await detectGpuVendor()
      if (!force) {
        if (!detected) return false
        if (requireVendor && detected !== requireVendor) return false
      }
      const vendor: GpuVendor = force
        ? (requireVendor ?? detected ?? 'nvidia')
        : (detected ?? 'nvidia')
      // no ROCm wheels for windows: an AMD card there stays on CPU
      if (vendor === 'amd' && IS_WIN) return false
      const label = vendor === 'amd' ? 'AMD' : 'NVIDIA'
      // wheel selection: Blackwell-class NVIDIA cards (compute cap 10+)
      // need the cu128 build; anything already installed from cu121 must be
      // upgraded to it. Without this, the early-return below would leave the
      // older engine in place and separation would die mid-split
      let torchVersion = GPU_TORCH_VERSION
      let torchIndex = GPU_TORCH_INDEX[vendor]
      let sizeLabel = '~2.5GB'
      let needUpgrade = false
      if (vendor === 'nvidia') {
        const capMajor = parseInt(((await detectNvidiaComputeCap()) ?? '').split('.')[0], 10)
        if (!Number.isNaN(capMajor) && capMajor >= 10) {
          torchVersion = BLACKWELL_TORCH_VERSION
          torchIndex = BLACKWELL_TORCH_INDEX
          sizeLabel = '~3GB'
          needUpgrade = !(await cudaVersionAtLeast(await torchCudaVersion(), 12, 8))
        }
      }
      // already swapped in: the venv's torch speaks to a GPU, nothing to install
      if (!needUpgrade && (await hasGpuAcceleration())) return true
      sendEnvEvent(`Downloading the ${label} GPU engine (${sizeLabel}, one time)`)
      await new Promise<void>((resolve, reject) => {
        const child = spawn(
          venvPython(),
          [
            '-m',
            'pip',
            'install',
            // required: the CPU torch from bootstrap already satisfies the
            // version spec, so without -U pip would no-op and never swap in
            // the gpu build
            '-U',
            '--no-cache-dir',
            `torch==${torchVersion}`,
            `torchaudio==${torchVersion}`,
            '--index-url',
            torchIndex
          ],
          { env: { ...process.env } }
        )
        let lastPct = 0
        let stderrTail = ''
        child.stdout?.on('data', (chunk: Buffer) => {
          const t = chunk.toString().trim()
          if (/^(Collecting|Downloading|Installing)/i.test(t)) sendEnvEvent(t.slice(0, 200))
        })
        child.stderr?.on('data', (chunk: Buffer) => {
          stderrTail = (stderrTail + chunk.toString()).slice(-1000)
          for (const piece of chunk.toString().split(/[\r\n]/)) {
            const pct = pipProgressPct(piece)
            if (pct === null || pct <= lastPct) continue
            lastPct = Math.min(99, pct)
            sendEnvEvent(`GPU engine: ${lastPct}%`)
            for (const listener of gpuProgressListeners) listener(lastPct)
          }
        })
        child.on('error', reject)
        child.on('close', (code) => {
          if (code === 0) {
            resolve()
            return
          }
          reject(
            new Error(
              stderrTail.split('\n').filter(Boolean).slice(-1).join('') ||
                `GPU engine install exited ${code}`
            )
          )
        })
      })
      // verify the swap actually took effect: torch must report the expected
      // build (torch.version.cuda for cu121, torch.version.hip for rocm —
      // set by the wheel itself, independent of whether a working
      // driver/GPU is present on this machine)
      const swapped = await runCapture(
        venvPython(),
        [
          '-c',
          vendor === 'amd'
            ? 'import torch;print(1 if torch.version.hip else 0)'
            : 'import torch;print(1 if torch.version.cuda else 0)'
        ],
        30000
      ).catch(() => '0')
      if (!swapped.trim().startsWith('1')) {
        throw new Error(
          vendor === 'amd'
            ? 'rocm torch is not active after install (torch.version.hip unset)'
            : 'cuda torch is not active after install (torch.version.cuda unset)'
        )
      }
      if (vendor === 'amd') {
        // consumer RDNA cards are not official wheel targets; probe the gfx
        // target, apply the HSA override when needed, then prove the GPU
        // with a real compute op before declaring the engine ready — a
        // missing kernel image would otherwise surface mid-separation as a
        // cryptic HIP error
        const gfxOut = await runCapture(
          venvPython(),
          [
            '-c',
            'import torch;p=torch.cuda.get_device_properties(0);print(getattr(p,"gcnArchName","") or "gfx%d%02d" % (p.major, p.minor))'
          ],
          30000
        ).catch(() => '')
        const override = gfxOverride(gfxOut)
        if (override) {
          // every python spawn inherits process.env, so one assignment
          // covers the separation runs too; persist it for future launches
          process.env.HSA_OVERRIDE_GFX_VERSION = override
          try {
            writeFileSync(gpuOverrideFile(), override)
          } catch {}
        } else {
          // stale override from an earlier card/engine would shadow the
          // officially supported target
          try {
            unlinkSync(gpuOverrideFile())
          } catch {}
        }
        try {
          const ok = await runCapture(
            venvPython(),
            ['-c', 'import torch;torch.randn(256,256,device="cuda").sum().item();print("ok")'],
            60000
          )
          if (!ok.trim().includes('ok')) throw new Error('compute probe returned no result')
        } catch (err) {
          throw new Error(
            `AMD GPU probe failed${override ? ` (using ${override})` : ''}: ${
              err instanceof Error ? err.message : String(err)
            }. Check the amdgpu driver and that your user can access /dev/kfd and /dev/dri`
          )
        }
      }
      // refresh the cached gpu probe so Settings' status lines update
      gpuProbe = null
      gpuInfo = undefined
      void hasGpuAcceleration()
      sendEnvEvent(`${label} GPU engine ready`, 'success')
      return true
    })()
      .catch((err) => {
        sendEnvEvent(
          `GPU engine install failed: ${err instanceof Error ? err.message : String(err)}`,
          'error'
        )
        return false
      })
      .finally(() => {
        gpuEnginePromise = null
      })
  }
  return gpuEnginePromise.then(detach)
}

/* pip progress bars report absolute sizes ("45.2/2450.0 MB") rather than
   percentages; tqdm-style output reports "%" directly */
function pipProgressPct(line: string): number | null {
  const pct = line.match(/(\d{1,3})%/)
  if (pct) return parseInt(pct[1], 10)
  const sizes = line.match(/([\d.]+)\s*\/\s*([\d.]+)\s*(GB|MB)/i)
  if (sizes) {
    const scale = sizes[3].toUpperCase() === 'GB' ? 1024 : 1
    const done = parseFloat(sizes[1]) * scale
    const total = parseFloat(sizes[2]) * scale
    if (total > 0) return Math.round((done / total) * 100)
  }
  return null
}

export function engineStatus(): EngineStatus {
  return {
    vocalsDownloading: vocalsEnginePromise !== null,
    vocalsReady: existsSync(vocalsEnginePath()),
    ftDownloading: ftWeightsPromise !== null,
    ftVerified,
    gpuDownloading: gpuEnginePromise !== null,
    gpuReady: SUPPORTS_GPU && gpuInfo === true
  }
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
    // On Linux the chosen python may lack the venv module (Debian/Ubuntu
    // split it into the python3-venv apt package) even though the version
    // probe passed. Retry once via the private runtime instead of dying.
    const venvWith = (py: string): Promise<void> =>
      new Promise<void>((resolve, reject) => {
        let stderr = ''
        const child = spawn(py, ['-m', 'venv', '--clear', venv])
        child.stderr?.on('data', (c: Buffer) => {
          stderr += c.toString()
        })
        child.on('close', (code) =>
          code === 0
            ? resolve()
            : reject(
                new Error(
                  `venv creation failed (${code})${stderr ? `: ${stderr.slice(0, 300).trim()}` : ''}`
                )
              )
        )
        child.on('error', reject)
      })
    try {
      await venvWith(state.python.path as string)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (/ensurepip|venv/i.test(msg) && state.python.path !== runtimePython()) {
        sendEnvEvent('System python lacks venv support — downloading private runtime instead')
        state.python = { found: false }
        if (!(await ensureRuntimePython())) return false
        await detectTools()
        if (!state.python.found || !state.python.path) {
          sendEnvEvent('No suitable python3 found on this machine', 'error')
          return false
        }
        try {
          await venvWith(state.python.path as string)
        } catch (err2) {
          sendEnvEvent(err2 instanceof Error ? err2.message : String(err2), 'error')
          return false
        }
      } else {
        if (/ensurepip|venv/i.test(msg) && process.platform === 'linux') {
          sendEnvEvent('venv creation failed: install the venv module (e.g. sudo apt install python3-venv) and retry', 'error')
        } else {
          sendEnvEvent(msg, 'error')
        }
        return false
      }
    }

    await new Promise<void>((resolve, reject) => {
      const child = spawn(pip, ['-m', 'pip', 'install', '-q', '-U', 'pip', 'wheel', 'setuptools'])
      child.on('close', (code) =>
        code === 0 ? resolve() : reject(new Error(`pip upgrade failed (${code})`))
      )
      child.on('error', reject)
    })

    sendEnvEvent('Downloading the separation engine — grab a coffee')
    let lastGeneric = 0
    // on linux the default PyPI torch wheel is CUDA-enabled and would pull
    // ~2GB of nvidia deps for every user, GPU or not — install the cpu build
    // in its own step (windows/mac defaults are already CPU, so only linux
    // needs the override) and let the GPU toggle swap in cu121 on demand.
    // --index-url can't be mixed into the big install below: the cpu index
    // only hosts torch packages, so non-torch deps would fail to resolve.
    if (process.platform === 'linux') {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(pip, [
          '-m',
          'pip',
          'install',
          '--progress-bar',
          'off',
          'torch==2.5.1',
          'torchaudio==2.5.1',
          '--index-url',
          'https://download.pytorch.org/whl/cpu'
        ])
        child.stderr?.on('data', (chunk: Buffer) => {
          const t = chunk.toString().trim()
          if (t.startsWith('ERROR') || t.startsWith('error')) sendEnvEvent(t.slice(0, 200), 'error')
        })
        child.on('close', (code) =>
          code === 0 ? resolve() : reject(new Error(`cpu torch install failed (${code})`))
        )
        child.on('error', reject)
      })
    }
    // (already satisfied on linux by the cpu step above — pip skips it)
    await new Promise<void>((resolve, reject) => {
      const child = spawn(pip, [
        '-m',
        'pip',
        'install',
        '--progress-bar',
        'off',
        'demucs==4.0.1',
         'torch==2.5.1',
        'torchaudio==2.5.1',
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
              sendEnvEvent('Still downloading…')
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
    // no checkpoint prefetch here: the optional engines (~913MB vocals,
    // ~320MB fine-tuned) download only when their settings toggles are on,
    // handled by the app-start prefetch in index.ts
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
