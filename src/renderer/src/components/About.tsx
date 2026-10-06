import { useEffect, useState } from 'react'
import { LogoMark, XIcon } from './Icons'

interface Props {
  version?: string
  onClose: () => void
}

export function About({ version, onClose }: Props): React.ReactElement {
  const [checkingUpdates, setCheckingUpdates] = useState(false)
  const [updateMessage, setUpdateMessage] = useState('')

  useEffect(() => {
    const off = window.stemkit.onUpdateEvent((event) => {
      switch (event.status) {
        case 'checking':
          setCheckingUpdates(true)
          setUpdateMessage('Checking for updates…')
          break
        case 'available':
          setCheckingUpdates(false)
          setUpdateMessage(`Version ${event.version} is available and downloading.`)
          break
        case 'none':
          setCheckingUpdates(false)
          setUpdateMessage('StemKit is up to date.')
          break
        case 'progress':
          setCheckingUpdates(false)
          setUpdateMessage(`Downloading update… ${event.pct ?? 0}%`)
          break
        case 'downloaded':
          setCheckingUpdates(false)
          setUpdateMessage(`Version ${event.version} is ready. Restart StemKit to install it.`)
          break
        case 'error':
          setCheckingUpdates(false)
          setUpdateMessage('Could not check for updates. Try again later.')
          break
      }
    })
    return off
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const checkForUpdates = async (): Promise<void> => {
    setCheckingUpdates(true)
    setUpdateMessage('Checking for updates…')
    try {
      const result = await window.stemkit.checkForUpdates()
      if (result.ok) return
    } catch {
      // Show the same message if the updater IPC call itself fails.
    }
    setCheckingUpdates(false)
    setUpdateMessage('Could not check for updates. Try again later.')
  }

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-title"
        className="relative w-full max-w-sm mx-4 rounded-2xl border border-white/[0.08] bg-[#16151d] p-6 text-center shadow-2xl rise-in"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          onClick={onClose}
          title="Close"
          className="no-drag absolute right-3 top-3 w-7 h-7 rounded-lg hover:bg-white/10 text-white/50 hover:text-white flex items-center justify-center transition-colors"
        >
          <XIcon className="w-3.5 h-3.5" />
        </button>
        <LogoMark className="mx-auto h-11 w-11" />
        <h2 id="about-title" className="mt-3 text-lg font-semibold tracking-tight">
          About StemKit
        </h2>
        {version && <p className="mt-1 text-xs text-white/40">Version {version}</p>}
        <p className="mt-4 text-[12px] leading-relaxed text-white/50">
          Split songs into stems and play them locally.
        </p>

        <div className="mt-5 flex justify-center gap-2">
          <button
            onClick={() => void window.stemkit.openExternal('https://stemkit.pages.dev')}
            className="no-drag px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/10 text-white/70 hover:text-white text-[12px] transition-colors"
          >
            StemKit website ↗
          </button>
          <button
            onClick={() => void window.stemkit.openExternal('https://github.com/danvelope/stemkit/issues')}
            className="no-drag px-3 py-1.5 rounded-lg bg-white/[0.06] hover:bg-white/10 text-white/70 hover:text-white text-[12px] transition-colors"
          >
            Get help ↗
          </button>
        </div>

        <div className="mt-5 border-t border-white/[0.07] pt-4">
          <p role="status" className="min-h-4 text-[11px] text-white/40">
            {updateMessage || 'Check whether a newer version is available.'}
          </p>
          <button
            onClick={() => void checkForUpdates()}
            disabled={checkingUpdates}
            className="no-drag mt-3 px-3 py-1.5 rounded-lg bg-violet-500/90 hover:bg-violet-500 disabled:opacity-50 disabled:cursor-wait text-white text-[12px] font-semibold transition-colors"
          >
            {checkingUpdates ? 'Checking…' : 'Check for updates'}
          </button>
        </div>
      </div>
    </div>
  )
}
