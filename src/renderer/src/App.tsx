import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppSettings, EnvStatus, JobProgress, JobStage, Song, UpdateEvent } from '../../shared/types'
import { DEFAULT_STEMS, MODEL_DEFAULT } from '../../shared/types'
import { parseVideoId } from '../../shared/url'
import { isAudioPath, isLocalId, localSongId } from '../../shared/local'
import { Sidebar } from './components/Sidebar'
import { Home } from './components/Home'
import { Processing } from './components/Processing'
import { Player, releaseBufferCache } from './components/Player'
import { Setup } from './components/Setup'
import { Settings } from './components/Settings'
import { LogoMark } from './components/Icons'

interface EnvLog {
  message: string
  level: string
}

// what the retry button re-runs: the original url or the picked local file
type LastStart =
  | { kind: 'url'; url: string; model: string }
  | { kind: 'local'; filePath: string; model: string }

function stageLabel(stage: JobStage, pct: number): string {
  switch (stage) {
    case 'metadata':
      return 'reading info…'
    case 'download':
      return `downloading ${Math.round(pct)}%`
    case 'convert':
      return 'converting…'
    case 'separate':
      return `separating ${Math.round(pct)}%`
    case 'finalize':
      return 'finishing…'
  }
}

function withoutKey<T>(map: Record<string, T>, key: string): Record<string, T> {
  const { [key]: _drop, ...rest } = map
  return rest
}

export default function App(): React.ReactElement {
  const [status, setStatus] = useState<EnvStatus | null>(null)
  const [songs, setSongs] = useState<Song[]>([])
  const [activeId, setActiveId] = useState<string | null>(null)
  const [jobs, setJobs] = useState<Record<string, JobProgress>>({})
  const [errors, setErrors] = useState<Record<string, string>>({})
  const [lastStart, setLastStart] = useState<LastStart | null>(null)
  const [envLogs, setEnvLogs] = useState<EnvLog[]>([])
  const [update, setUpdate] = useState<UpdateEvent | null>(null)
  const [appVersion, setAppVersion] = useState<string | undefined>(undefined)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [dropping, setDropping] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  // what a dropped file should be split with: Home pushes its current engine
  // and instrument selection down, so a drop honours the same toggles the
  // buttons use without owning that state here
  const startOpts = useRef<{ model: string; stems: string[] }>({
    model: MODEL_DEFAULT,
    stems: [...DEFAULT_STEMS]
  })

  useEffect(() => {
    void window.stemkit.envStatus().then(setStatus)
    void window.stemkit.listSongs().then(setSongs)
    void window.stemkit.getSettings().then(setSettings)
    const offSettings = window.stemkit.onSettingsChange(setSettings)
    const offJob = window.stemkit.onJobEvent((ev) => {
      if (ev.kind === 'progress') {
        setJobs((prev) => ({ ...prev, [ev.data.videoId]: ev.data }))
        setErrors((prev) => (prev[ev.data.videoId] ? withoutKey(prev, ev.data.videoId) : prev))
      } else if (ev.kind === 'done') {
        setJobs((prev) => withoutKey(prev, ev.data.videoId))
        setErrors((prev) => withoutKey(prev, ev.data.videoId))
        void window.stemkit.listSongs().then(setSongs)
      } else if (ev.data.message === 'Cancelled') {
        setJobs((prev) => withoutKey(prev, ev.data.videoId))
      } else if (!ev.data.videoId) {
        // rejections that have no song to attach to (unplayable drop, missing
        // file): a toast, since an empty id would key a blank library row
        setNotice(ev.data.message)
      } else {
        setJobs((prev) => withoutKey(prev, ev.data.videoId))
        setErrors((prev) => ({ ...prev, [ev.data.videoId]: ev.data.message }))
      }
    })
    const offEnv = window.stemkit.onEnvEvent((e) =>
      setEnvLogs((l) => [...l.slice(-300), { message: e.message, level: e.level }])
    )
    const offUpdate = window.stemkit.onUpdateEvent((e) => setUpdate(e))
    void window.stemkit.getAppVersion().then(setAppVersion)
    return () => {
      offJob()
      offEnv()
      offUpdate()
      offSettings()
    }
  }, [])

  useEffect(() => {
    if (status?.ready && envLogs.length > 0) {
      void window.stemkit.envStatus().then(setStatus)
    }
  }, [status?.ready])

  const startUrl = useCallback(
    async (url: string, model: string = MODEL_DEFAULT, stems?: string[]): Promise<void> => {
      const vid = parseVideoId(url)
      if (!vid) return
      releaseBufferCache()
      setActiveId(vid)
      setLastStart({ kind: 'url', url, model })
      setErrors((prev) => withoutKey(prev, vid))
      setJobs((prev) =>
        prev[vid]
          ? prev
          : { ...prev, [vid]: { videoId: vid, stage: 'metadata', pct: 0, message: 'Starting…', model } }
      )
      await window.stemkit.startJob(url, model, stems)
    },
    []
  )

  const startLocal = useCallback(
    async (
      filePath: string,
      model: string = MODEL_DEFAULT,
      stems?: string[],
      // a multi-file drop queues every file but only the first takes the view
      focus = true
    ): Promise<void> => {
      const id = localSongId(filePath)
      releaseBufferCache()
      if (focus) setActiveId(id)
      setLastStart({ kind: 'local', filePath, model })
      setErrors((prev) => withoutKey(prev, id))
      setJobs((prev) =>
        prev[id]
          ? prev
          : { ...prev, [id]: { videoId: id, stage: 'convert', pct: 0, message: 'Starting…', model } }
      )
      await window.stemkit.startLocalJob(filePath, model, stems)
    },
    []
  )

  const setStartOptions = useCallback((model: string, stems: string[]): void => {
    startOpts.current = { model, stems }
  }, [])

  const ready = !!status?.ready

  useEffect(() => {
    if (!notice) return
    const timer = setTimeout(() => setNotice(null), 6000)
    return () => clearTimeout(timer)
  }, [notice])

  useEffect(() => {
    let depth = 0
    // Files = something off disk, text/uri-list = a dragged link. A plain
    // text/plain drag is a selection inside the app, which stays untouched
    const droppable = (e: DragEvent): boolean => {
      const types = e.dataTransfer ? Array.from(e.dataTransfer.types) : []
      return types.includes('Files') || types.includes('text/uri-list')
    }

    /* dropping without preventDefault navigates the window to file:///… and
       takes the whole app down with it, so every handler here claims the
       event first and only then decides what to do with it */
    const onDragEnter = (e: DragEvent): void => {
      if (!droppable(e)) return
      e.preventDefault()
      depth += 1
      setDropping(true)
    }
    const onDragOver = (e: DragEvent): void => {
      if (!droppable(e)) return
      e.preventDefault()
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'
    }
    const onDragLeave = (): void => {
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDropping(false)
    }
    const onDrop = (e: DragEvent): void => {
      e.preventDefault()
      depth = 0
      setDropping(false)
      const dt = e.dataTransfer
      if (!dt) return
      // dropping into the search field is an edit, not a request to split
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (!ready) {
        setNotice('StemKit is still getting ready — try again once setup finishes')
        return
      }
      const { model, stems } = startOpts.current
      const files = Array.from(dt.files)
      if (files.length === 0) {
        const link = (dt.getData('text/uri-list') || '').split(/[\r\n]/)[0]
        if (link && parseVideoId(link)) void startUrl(link, model, stems)
        else setNotice('Drop audio files or a YouTube link')
        return
      }
      const paths: string[] = []
      const skipped: string[] = []
      for (const file of files) {
        let path = ''
        try {
          path = window.stemkit.getPathForFile(file)
        } catch {
          path = ''
        }
        if (path && isAudioPath(path)) paths.push(path)
        else skipped.push(file.name || 'that file')
      }
      if (paths.length === 0) {
        setNotice(
          skipped.length
            ? `Can’t split ${skipped.join(', ')} — use mp3, wav, flac, m4a, ogg or opus`
            : 'Drop audio files (mp3, wav, flac, m4a…)'
        )
        return
      }
      if (stems.length === 0) {
        setNotice('Pick at least one instrument first')
        return
      }
      if (skipped.length > 0) setNotice(`Skipped ${skipped.join(', ')} — not audio`)
      paths.forEach((path, i) => {
        void startLocal(path, model, stems, i === 0)
      })
    }

    window.addEventListener('dragenter', onDragEnter)
    window.addEventListener('dragover', onDragOver)
    window.addEventListener('dragleave', onDragLeave)
    window.addEventListener('drop', onDrop)
    return () => {
      window.removeEventListener('dragenter', onDragEnter)
      window.removeEventListener('dragover', onDragOver)
      window.removeEventListener('dragleave', onDragLeave)
      window.removeEventListener('drop', onDrop)
    }
  }, [ready, startLocal, startUrl])

  const cancelSelectedJob = useCallback(
    (videoId: string): void => {
      void window.stemkit.cancelJob(videoId)
      setJobs((prev) => withoutKey(prev, videoId))
    },
    []
  )

  const retryJob = useCallback((): void => {
    if (!lastStart) return
    if (lastStart.kind === 'url') void startUrl(lastStart.url, lastStart.model)
    else void startLocal(lastStart.filePath, lastStart.model)
  }, [lastStart, startUrl, startLocal])

  const updateYtDlp = useCallback(async (): Promise<void> => {
    await window.stemkit.envUpdateYtDlp()
    if (lastStart?.kind === 'url') void startUrl(lastStart.url, lastStart.model)
  }, [lastStart, startUrl])

  const deleteSong = useCallback(
    async (videoId: string): Promise<void> => {
      if (jobs[videoId]) return
      setErrors((prev) => withoutKey(prev, videoId))
      await window.stemkit.deleteSong(videoId)
      setSongs(await window.stemkit.listSongs())
      setActiveId((cur) => (cur === videoId ? null : cur))
    },
    [jobs]
  )

  const clearAll = useCallback(async (): Promise<void> => {
    if (!songs.length) return
    // main cancels anything mid-split before wiping the folders
    if (!window.confirm(`Remove all ${songs.length} songs and delete their stems from this computer?`))
      return
    releaseBufferCache()
    setJobs({})
    setErrors({})
    setActiveId(null)
    await window.stemkit.clearLibrary()
    setSongs(await window.stemkit.listSongs())
  }, [songs.length])

  const activeSong = useMemo(
    () => songs.find((s) => s.videoId === activeId) ?? null,
    [songs, activeId]
  )

  const selectedJob = useMemo(
    () => (activeId ? jobs[activeId] ?? null : null),
    [jobs, activeId]
  )
  const selectedError = useMemo(
    () => (activeId ? errors[activeId] ?? null : null),
    [errors, activeId]
  )

  const pendingMap = useMemo(() => {
    const map: Record<string, { label: string; error?: boolean }> = {}
    for (const j of Object.values(jobs)) {
      map[j.videoId] = { label: stageLabel(j.stage, j.pct) }
    }
    for (const [id, message] of Object.entries(errors)) {
      if (!map[id]) {
        map[id] = { label: /already being processed/.test(message) ? 'queued' : 'failed', error: true }
      }
    }
    return map
  }, [jobs, errors])

  const displaySongs = useMemo(() => {
    const known = new Set(songs.map((s) => s.videoId))
    const top: Song[] = []
    for (const j of Object.values(jobs)) {
      if (!known.has(j.videoId)) {
        top.push({
          videoId: j.videoId,
          title: j.title ?? '',
          duration: 0,
          addedAt: 0,
          model: j.model
        })
        known.add(j.videoId)
      }
    }
    for (const id of Object.keys(errors)) {
      if (!known.has(id)) {
        top.push({ videoId: id, title: '', duration: 0, addedAt: 0 })
        known.add(id)
      }
    }
    return [...top, ...songs]
  }, [songs, jobs, errors])

  if (!status) {
    return (
      <div className="h-full flex items-center justify-center">
        <LogoMark className="w-12 h-12 animate-pulse" />
      </div>
    )
  }

  if (!status.ready) {
    return (
      <Setup
        status={status}
        logs={envLogs}
        onInstall={() => {
          void window.stemkit.envBootstrap().then(() => window.stemkit.envStatus().then(setStatus))
        }}
      />
    )
  }

  const selectedIsBusy = !!(selectedJob || selectedError)

  let main: React.ReactElement
  if (selectedIsBusy) {
    main = (
      <Processing
        job={selectedJob}
        error={selectedError}
        isLocal={activeId ? isLocalId(activeId) : false}
        botSuspected={
          !!selectedError && /sign in|bot|confirm|unavailable|private/i.test(selectedError)
        }
        onCancel={() => activeId && cancelSelectedJob(activeId)}
        onRetry={retryJob}
        onUpdateYtDlp={() => void updateYtDlp()}
      />
    )
  } else if (activeSong) {
    main = <Player key={activeSong.videoId} song={activeSong} settings={settings ?? undefined} />
  } else {
    main = (
      <Home
        hasSongs={displaySongs.length > 0}
        songs={displaySongs}
        pending={pendingMap}
        settings={settings ?? undefined}
        onStart={(u, m, s) => void startUrl(u, m, s)}
        onStartLocal={(path, m, s) => void startLocal(path, m, s)}
        onOptions={setStartOptions}
        onSelect={(id) => setActiveId(id)}
        onOpenSettings={() => {
          void window.stemkit.envStatus().then(setStatus)
          setSettingsOpen(true)
        }}
      />
    )
  }

  return (
    <div className="h-full flex">
      <Sidebar
        songs={displaySongs}
        activeId={activeId}
        pending={pendingMap}
        update={update ?? undefined}
        appVersion={appVersion}
        onSelect={(id) => setActiveId(id)}
        onDelete={(id) => void deleteSong(id)}
        onClearAll={() => void clearAll()}
        onAdd={() => setActiveId(null)}
        onInstallUpdate={() => window.stemkit.installUpdate()}
        onOpenSettings={() => {
          void window.stemkit.envStatus().then(setStatus)
          setSettingsOpen(true)
        }}
      />
      <main className="flex-1 min-w-0">{main}</main>
      {settings && settingsOpen && (
        <Settings
          settings={settings}
          gpu={status.gpu}
          gpuVendor={status.gpuVendor}
          onChange={(patch) => void window.stemkit.setSettings(patch)}
          onClose={() => setSettingsOpen(false)}
        />
      )}
      {/* pointer-events-none: the drop has to land on the window listeners,
          not on the hint itself, or enter/leave would flicker over it */}
      {dropping && (
        <div className="fixed inset-0 z-50 p-6 pointer-events-none">
          <div className="h-full w-full rounded-3xl border-2 border-dashed border-violet-300/70 bg-violet-500/[0.12] flex flex-col items-center justify-center gap-2">
            <p className="text-lg font-semibold text-violet-100">Drop to split</p>
            <p className="text-[13px] text-white/60">
              audio files (mp3, wav, flac, m4a…) or a YouTube link
            </p>
          </div>
        </div>
      )}
      {notice && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 max-w-[720px] rise-in">
          <div className="rounded-xl border border-rose-400/25 bg-rose-500/10 px-4 py-2.5 text-[13px] text-rose-200 break-words">
            {notice}
          </div>
        </div>
      )}
    </div>
  )
}
