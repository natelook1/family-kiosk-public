import { useState, useEffect, useCallback, useRef } from 'react'
import IncomingCall from './components/IncomingCall'
import CallScreen   from './components/CallScreen'
import Settings, { ACCENT_CLASSES } from './components/Settings'
import ToastContainer from './components/Toast'
import { pairDevice, subscribeToPush, requestCallback, cancelCallback, getPatientStatus, getCallHistory } from './api'
import { useDevice } from './hooks/useDevice'
import { useSettings } from './hooks/useSettings'
import { useToast } from './hooks/useToast'
import './index.css'

if ('serviceWorker' in navigator && !window.FamilyBridge) {
  navigator.serviceWorker.register('/sw.js').catch(console.error)
}

function parseUrlParams(search) {
  const p = new URLSearchParams(search)
  return {
    room:        p.get('room')        || '',
    patient:     p.get('patient')     || 'Someone',
    contact:     p.get('contact')     || '',
    pair:        p.get('pair')        || '',
    caller:      p.get('caller')      || '',
    deviceId:    p.get('deviceId')    || '',
    deviceToken: p.get('deviceToken') || '',
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isIos() { return /iphone|ipad|ipod/i.test(navigator.userAgent) }
function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true
}

function formatLastSeen(ts) {
  if (!ts) return null
  const diff = Date.now() - ts
  if (diff < 60_000)            return 'Active now'
  if (diff < 3_600_000)         return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000)        return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

function formatCallTime(ts) {
  const d = new Date(ts)
  const now = new Date()
  const isToday = d.toDateString() === now.toDateString()
  const isYesterday = d.toDateString() === new Date(now - 86_400_000).toDateString()
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  if (isToday)     return `Today ${time}`
  if (isYesterday) return `Yesterday ${time}`
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time
}

// ─── Pairing ─────────────────────────────────────────────────────────────────

function PairingScreen({ token }) {
  const [status, setStatus] = useState('pairing')

  useEffect(() => {
    const deviceId = localStorage.getItem('family_device_id') || crypto.randomUUID()
    pairDevice(token, deviceId)
      .then(data => {
        localStorage.setItem('family_device_id', deviceId)
        if (data.deviceToken) localStorage.setItem('family_device_token', data.deviceToken)
        setStatus('done')
      })
      .catch(() => setStatus('error'))
  }, [token])

  return (
    <div className="flex flex-col items-center justify-center h-full gap-6 text-center px-8">
      {status === 'pairing' && (
        <>
          <div className="w-12 h-12 rounded-full border-2 border-white/20 border-t-white animate-spin" />
          <p className="text-white/60 text-base">Pairing device…</p>
        </>
      )}
      {status === 'done' && (
        <>
          <div className="w-16 h-16 rounded-full bg-green-500/20 flex items-center justify-center">
            <svg className="w-8 h-8 text-green-400" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>
          </div>
          <div>
            <p className="text-white text-lg font-semibold">Device paired!</p>
            <p className="text-white/40 text-sm mt-1">You can close this tab.</p>
          </div>
        </>
      )}
      {status === 'error' && (
        <>
          <div className="w-16 h-16 rounded-full bg-red-500/20 flex items-center justify-center">
            <svg className="w-8 h-8 text-red-400" viewBox="0 0 24 24" fill="currentColor"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12 19 6.41z"/></svg>
          </div>
          <div>
            <p className="text-white text-lg font-semibold">Pairing failed</p>
            <p className="text-white/40 text-sm mt-1">The code may have expired.</p>
          </div>
        </>
      )}
    </div>
  )
}

// ─── Idle ─────────────────────────────────────────────────────────────────────

function IdleScreen({ settings, onOpenSettings, toast }) {
  const { deviceId, deviceToken } = useDevice()
  const accent = ACCENT_CLASSES[settings.accentColor] || ACCENT_CLASSES.green
  const isPaired = !!(deviceId && deviceToken)

  const [notifState, setNotifState]              = useState(() => Notification.permission)
  const [patientPhoto, setPatientPhoto]          = useState(() => localStorage.getItem('family_patient_photo') || null)
  const [patientName, setPatientName]            = useState(() => localStorage.getItem('family_patient_name') || '')
  const [lastSeenAt, setLastSeenAt]              = useState(null)
  const [inCall, setInCall]                      = useState(false)
  const [callbackState, setCallbackState]        = useState('idle')
  const [callbackRequestId, setCallbackRequestId] = useState(null)
  const [callHistory, setCallHistory]            = useState([])
  const [isRefreshing, setIsRefreshing]          = useState(false)

  // Pull-to-refresh state
  const touchStartY = useRef(0)
  const pullDelta   = useRef(0)
  const [pullProgress, setPullProgress] = useState(0) // 0–1

  const PULL_THRESHOLD = 72

  const fetchAll = useCallback(async () => {
    if (!deviceId || !deviceToken) return
    const [statusData, historyData] = await Promise.allSettled([
      getPatientStatus(deviceId, deviceToken),
      getCallHistory(deviceId, deviceToken),
    ])
    if (statusData.status === 'fulfilled') {
      const d = statusData.value
      if (d.patientPhotoUrl) { setPatientPhoto(d.patientPhotoUrl); localStorage.setItem('family_patient_photo', d.patientPhotoUrl) }
      if (d.patientName)     { setPatientName(d.patientName);      localStorage.setItem('family_patient_name', d.patientName) }
      if (d.lastSeenAt)      setLastSeenAt(d.lastSeenAt)
      setInCall(!!d.inCall)
    }
    if (historyData.status === 'fulfilled') {
      setCallHistory(historyData.value.calls || [])
    }
  }, [deviceId, deviceToken])

  // Initial load + 30s poll
  useEffect(() => {
    if (navigator.storage?.persist) navigator.storage.persist()
    if (Notification.permission === 'granted' && deviceId) {
      subscribeToPush(deviceId, deviceToken).catch(console.error)
    }
    fetchAll()
    const id = setInterval(fetchAll, 30_000)
    return () => clearInterval(id)
  }, [fetchAll]) // eslint-disable-line

  async function handleRefresh() {
    setIsRefreshing(true)
    await fetchAll()
    setIsRefreshing(false)
    toast.show('Updated', { type: 'info', duration: 1500 })
  }

  // Touch-based pull-to-refresh
  function onTouchStart(e) { touchStartY.current = e.touches[0].clientY }
  function onTouchMove(e) {
    const delta = e.touches[0].clientY - touchStartY.current
    if (delta < 0) { pullDelta.current = 0; setPullProgress(0); return }
    pullDelta.current = delta
    setPullProgress(Math.min(delta / PULL_THRESHOLD, 1))
  }
  function onTouchEnd() {
    if (pullDelta.current >= PULL_THRESHOLD) handleRefresh()
    pullDelta.current = 0
    setPullProgress(0)
  }

  async function enableNotifications() {
    if (!deviceId) return
    await subscribeToPush(deviceId, deviceToken)
    const perm = Notification.permission
    setNotifState(perm)
    if (perm === 'granted') toast.show('Notifications enabled', { type: 'success' })
    else if (perm === 'denied') toast.show('Notifications blocked — enable in your phone\'s Settings', { type: 'error', duration: 5000 })
  }

  async function handleCallbackRequest() {
    if (callbackState === 'pending') {
      try {
        await cancelCallback(deviceId, deviceToken, callbackRequestId)
        setCallbackState('idle')
        setCallbackRequestId(null)
        toast.show('Callback cancelled', { type: 'info' })
      } catch {
        setCallbackState('idle')
      }
      return
    }
    setCallbackState('pending')
    try {
      const data = await requestCallback(deviceId, deviceToken)
      setCallbackRequestId(data?.requestId || null)
      toast.show('Callback requested', { type: 'success' })
    } catch {
      setCallbackState('error')
      toast.show('Request failed — try again', { type: 'error' })
      setTimeout(() => setCallbackState('idle'), 3000)
    }
  }

  const showIosInstall = isIos() && !isStandalone()
  const lastSeenLabel  = formatLastSeen(lastSeenAt)
  const isOnline       = lastSeenAt && (Date.now() - lastSeenAt) < 5 * 60_000
  const recentCalls    = callHistory.slice(0, 3)

  // Unpaired state
  if (!isPaired) {
    return (
      <div className="flex flex-col h-full bg-black select-none">
        <div className="flex items-center justify-between px-5 pt-safe-or-4 pb-2">
          <p className="text-white/30 text-xs tracking-widest uppercase">Family Kiosk</p>
          <button onClick={onOpenSettings} className="w-9 h-9 rounded-full bg-white/8 flex items-center justify-center active:bg-white/15 touch-manipulation" aria-label="Settings">
            <GearIcon />
          </button>
        </div>
        <div className="flex-1 flex flex-col items-center justify-center gap-6 px-8 text-center">
          <div className="w-24 h-24 rounded-full bg-white/5 border border-white/10 flex items-center justify-center">
            <svg className="w-12 h-12 text-white/20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z"/>
            </svg>
          </div>
          <div>
            <p className="text-white text-xl font-semibold">Not connected</p>
            <p className="text-white/40 text-sm mt-2 leading-relaxed max-w-xs">
              Ask your family for a pairing link, or open the link they sent you to connect this device.
            </p>
          </div>
        </div>
        <div className="pb-safe-or-6" />
      </div>
    )
  }

  return (
    <div
      className="flex flex-col h-full bg-black select-none overflow-hidden"
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      {/* Pull-to-refresh indicator */}
      {pullProgress > 0 && (
        <div className="absolute top-0 inset-x-0 flex justify-center z-10 pt-2" style={{ opacity: pullProgress }}>
          <div className="w-7 h-7 rounded-full border-2 border-white/30 border-t-white/80 animate-spin" />
        </div>
      )}
      {isRefreshing && (
        <div className="absolute top-safe-or-4 inset-x-0 flex justify-center z-10">
          <div className="w-5 h-5 rounded-full border-2 border-white/30 border-t-white/60 animate-spin" />
        </div>
      )}

      {/* Header */}
      <div className="flex items-center justify-between px-5 pt-safe-or-4 pb-2 shrink-0">
        <p className="text-white/30 text-xs tracking-widest uppercase">Family Kiosk</p>
        <button onClick={onOpenSettings} className="w-9 h-9 rounded-full bg-white/8 flex items-center justify-center active:bg-white/15 touch-manipulation" aria-label="Settings">
          <GearIcon />
        </button>
      </div>

      {/* Scrollable main content */}
      <div className="flex-1 overflow-y-auto">
        <div className="flex flex-col items-center px-6 pt-6 pb-8 gap-6">

          {/* ── Avatar with ambient rings ── */}
          <div className="relative flex items-center justify-center mt-2">
            {/* Ambient breathing rings */}
            <div className={`absolute w-52 h-52 rounded-full ${inCall ? accent.bg : 'bg-white'} opacity-[0.04] animate-pulse`} style={{ animationDuration: '3s' }} />
            <div className={`absolute w-44 h-44 rounded-full ${inCall ? accent.bg : 'bg-white'} opacity-[0.06] animate-pulse`} style={{ animationDuration: '3s', animationDelay: '0.5s' }} />

            {/* Status ring — color encodes online/in-call/offline */}
            <div className={`absolute w-36 h-36 rounded-full ${
              inCall   ? `ring-4 ${accent.ring} ring-opacity-80 animate-pulse` :
              isOnline ? 'ring-4 ring-green-500 ring-opacity-70' :
                         'ring-4 ring-white/10'
            }`} />

            {patientPhoto ? (
              <img
                src={patientPhoto}
                alt={patientName}
                className="w-32 h-32 rounded-full object-cover shadow-2xl relative z-10"
                onError={() => setPatientPhoto(null)}
              />
            ) : (
              <div className="w-32 h-32 rounded-full bg-white/10 flex items-center justify-center shadow-2xl relative z-10">
                {patientName
                  ? <span className="text-white text-5xl font-semibold">{patientName[0].toUpperCase()}</span>
                  : <PersonIcon />
                }
              </div>
            )}

            {/* Online dot */}
            {(isOnline || inCall) && (
              <div className={`absolute bottom-1 right-1 z-20 w-4 h-4 rounded-full border-2 border-black ${inCall ? accent.bg : 'bg-green-400'}`} />
            )}
          </div>

          {/* Name + status */}
          <div className="text-center">
            <p className="text-white text-2xl font-semibold">{patientName || 'Your person'}</p>
            <p className={`text-sm mt-1 ${
              inCall   ? accent.text :
              isOnline ? 'text-green-400' :
                         'text-white/40'
            }`}>
              {inCall ? 'In a call' : lastSeenLabel || 'Waiting for a call'}
            </p>
          </div>

          {/* iOS install prompt */}
          {showIosInstall && (
            <div className="w-full px-5 py-4 rounded-2xl bg-white/8 border border-white/10 text-left">
              <p className="text-white font-semibold text-sm mb-1">Install for call alerts</p>
              <p className="text-white/50 text-xs leading-relaxed">
                Tap <strong className="text-white/70">Share</strong> in Safari, then{' '}
                <strong className="text-white/70">Add to Home Screen</strong>. Notifications only work from the installed app.
              </p>
            </div>
          )}

          {/* Notification permission */}
          {notifState === 'denied' && !showIosInstall && (
            <div className="w-full px-5 py-4 rounded-2xl bg-orange-500/10 border border-orange-500/20 text-left">
              <p className="text-orange-300 font-semibold text-sm mb-1">Notifications blocked</p>
              <p className="text-white/50 text-xs leading-relaxed">
                Enable notifications for this app in your phone's <strong className="text-white/70">Settings → Notifications</strong> to receive call alerts.
              </p>
            </div>
          )}
          {notifState === 'default' && !showIosInstall && (
            <button
              onClick={enableNotifications}
              className={`w-full py-3.5 rounded-2xl ${accent.bg} ${accent.activeBg} text-white font-semibold text-base touch-manipulation transition-colors shadow-lg`}
            >
              Enable call notifications
            </button>
          )}
          {notifState === 'granted' && (
            <p className={`${accent.text} text-sm`}>Notifications enabled</p>
          )}

          {/* Callback request */}
          <button
            onClick={handleCallbackRequest}
            disabled={callbackState === 'error'}
            className={`w-full py-3.5 rounded-2xl border font-semibold text-base touch-manipulation transition-all ${
              callbackState === 'pending'
                ? 'border-white/30 bg-white/10 text-white/70'
                : callbackState === 'error'
                  ? 'border-red-500/40 text-red-400/70'
                  : 'border-white/15 text-white/50 active:bg-white/8'
            }`}
          >
            {callbackState === 'pending' ? 'Callback requested — tap to cancel'
              : callbackState === 'error' ? 'Request failed'
              : 'Request a callback'}
          </button>

          {/* Recent calls */}
          {recentCalls.length > 0 && (
            <div className="w-full">
              <p className="text-white/30 text-xs tracking-widest uppercase mb-3">Recent calls</p>
              <div className="rounded-2xl bg-white/5 border border-white/8 overflow-hidden divide-y divide-white/8">
                {recentCalls.map(call => (
                  <div key={call.callId} className="flex items-center px-4 py-3 gap-3">
                    <div className={`w-8 h-8 rounded-full flex items-center justify-center shrink-0 ${
                      call.answered ? 'bg-green-500/15' : 'bg-red-500/15'
                    }`}>
                      <svg className={`w-4 h-4 ${call.answered ? 'text-green-400' : 'text-red-400'}`} viewBox="0 0 24 24" fill="currentColor">
                        {call.answered
                          ? <path d="M20.01 15.38c-1.23 0-2.42-.2-3.53-.56-.35-.12-.74-.03-1.01.24l-1.57 1.97c-2.83-1.35-5.48-3.9-6.89-6.83l1.95-1.66c.27-.28.35-.67.24-1.02-.37-1.11-.56-2.3-.56-3.53 0-.54-.45-.99-.99-.99H4.19C3.65 3 3 3.24 3 3.99 3 13.28 10.73 21 20.01 21c.71 0 .99-.63.99-1.18v-3.45c0-.54-.45-.99-.99-.99z"/>
                          : <path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.27-.27.68-.35 1.02-.18 1.12.45 2.35.68 3.58.68.55 0 1 .45 1 1V20c0 .55-.45 1-1 1C9.61 21 3 14.39 3 6c0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.12.32.03.7-.17.97L6.6 10.8z" transform="rotate(135 12 12)"/>
                        }
                      </svg>
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-white/80 text-sm font-medium truncate">{call.contactName}</p>
                      <p className="text-white/30 text-xs">{formatCallTime(call.startedAt)}</p>
                    </div>
                    <p className={`text-xs shrink-0 ${call.answered ? 'text-green-400/60' : 'text-red-400/60'}`}>
                      {call.answered ? 'Answered' : call.declined ? 'Declined' : 'Missed'}
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

        </div>
      </div>

      <div className="pb-safe-or-6 shrink-0" />
    </div>
  )
}

// ─── Root ─────────────────────────────────────────────────────────────────────

export default function App() {
  const [urlParams]   = useState(() => parseUrlParams(window.location.search))
  const [phase, setPhase] = useState(() => {
    const p = parseUrlParams(window.location.search)
    return p.room ? (p.caller === '1' ? 'call' : 'incoming') : 'idle'
  })
  const [callParams, setCallParams] = useState(urlParams)
  const [preConnectData, setPreConnectData] = useState(null)
  const [showSettings, setShowSettings] = useState(false)
  const [settings, updateSettings] = useSettings()
  const toast = useToast()

  useEffect(() => {
    if (urlParams.deviceId)    localStorage.setItem('family_device_id',    urlParams.deviceId)
    if (urlParams.deviceToken) localStorage.setItem('family_device_token', urlParams.deviceToken)
  }, [urlParams.deviceId, urlParams.deviceToken]) // eslint-disable-line

  useEffect(() => {
    if (!('serviceWorker' in navigator)) return
    const handler = (event) => {
      if (event.data?.type !== 'incoming-call') return
      const sp = new URL(event.data.url).searchParams
      setCallParams({
        room:        sp.get('room')        || '',
        patient:     sp.get('patient')     || 'Someone',
        contact:     sp.get('contact')     || '',
        pair:        sp.get('pair')        || '',
        caller:      sp.get('caller')      || '',
        deviceId:    sp.get('deviceId')    || '',
        deviceToken: sp.get('deviceToken') || '',
      })
      setPreConnectData(null)
      setPhase('incoming')
    }
    navigator.serviceWorker.addEventListener('message', handler)
    return () => navigator.serviceWorker.removeEventListener('message', handler)
  }, [])

  const { deviceId, deviceToken } = useDevice(callParams.deviceId, callParams.deviceToken)

  const handleEnd = useCallback(() => {
    if (window.FamilyBridge?.closeCall) window.FamilyBridge.closeCall()
    else setPhase('idle')
  }, [])

  if (callParams.pair) return <PairingScreen token={callParams.pair} />

  return (
    <>
      <div className={`absolute inset-0 transition-opacity duration-300 ${phase === 'idle' ? 'opacity-100 pointer-events-auto z-10' : 'opacity-0 pointer-events-none z-0'}`}>
        <IdleScreen settings={settings} onOpenSettings={() => setShowSettings(true)} toast={toast} />
      </div>

      <div className={`absolute inset-0 transition-all duration-300 ${phase === 'incoming' ? 'opacity-100 pointer-events-auto z-20 translate-y-0' : 'opacity-0 pointer-events-none z-0 translate-y-4'}`}>
        {phase === 'incoming' && (
          <IncomingCall
            patientName={callParams.patient}
            roomName={callParams.room}
            deviceId={deviceId}
            deviceToken={deviceToken}
            displayName={callParams.contact || 'Family'}
            settings={settings}
            onAnswer={(data) => { if (data) setPreConnectData(data); setPhase('call') }}
            onDecline={() => setPhase('idle')}
          />
        )}
      </div>

      <div className={`absolute inset-0 transition-all duration-300 ${phase === 'call' ? 'opacity-100 pointer-events-auto z-20 scale-100' : 'opacity-0 pointer-events-none z-0 scale-95'}`}>
        {phase === 'call' && (
          <CallScreen
            roomName={callParams.room}
            deviceId={deviceId}
            deviceToken={deviceToken}
            displayName={callParams.contact || 'Family'}
            patientName={callParams.patient}
            preConnectData={preConnectData}
            settings={settings}
            onEnd={handleEnd}
          />
        )}
      </div>

      {showSettings && (
        <Settings
          settings={settings}
          onUpdate={updateSettings}
          onClose={() => setShowSettings(false)}
        />
      )}

      <ToastContainer toasts={toast.toasts} onDismiss={toast.dismiss} />
    </>
  )
}

// ─── Icons ───────────────────────────────────────────────────────────────────

function GearIcon() {
  return (
    <svg className="w-5 h-5 text-white/50" viewBox="0 0 24 24" fill="currentColor">
      <path d="M19.14 12.94c.04-.3.06-.61.06-.94s-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96a7.1 7.1 0 0 0-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.47.47 0 0 0-.59.22L2.74 8.87a.47.47 0 0 0 .12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.37 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.57 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32a.47.47 0 0 0-.12-.61l-2.01-1.58zM12 15.6a3.6 3.6 0 1 1 0-7.2 3.6 3.6 0 0 1 0 7.2z"/>
    </svg>
  )
}

function PersonIcon() {
  return (
    <svg className="w-16 h-16 text-white/20" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
    </svg>
  )
}
