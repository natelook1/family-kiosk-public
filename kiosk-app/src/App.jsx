import { useState, useEffect, useRef } from 'react'
import DevFrame from './components/DevFrame'
import SetupScreen from './components/SetupScreen'
import WaitingScreen from './components/WaitingScreen'
import KioskScreen from './components/KioskScreen'

const API_BASE = import.meta.env.VITE_API_BASE || '/webhook'
const API_ROOT = API_BASE.replace(/\/webhook\/?$/, '') || ''
const API_KEY  = import.meta.env.VITE_API_KEY  || 'devkey'
const SYNC_INTERVAL = 15_000
const CALL_POLL_MS  = 3_000

export default function App() {
  const [deviceId, setDeviceId]       = useState(() => localStorage.getItem('kiosk_device_id') || '')
  const [patientData, setPatientData] = useState(null)
  const [appState, setAppState]       = useState(() =>
    localStorage.getItem('kiosk_device_id') ? 'waiting' : 'setup'
  )
  const [battery, setBattery]         = useState(null)
  const [incomingCall, setIncomingCall] = useState(null) // { callId, roomName, contactName, profilePhotoUrl }
  const [isOnline, setIsOnline]       = useState(true)
  const syncFailCount                 = useRef(0)
  const syncAbort                     = useRef(null)

  const headers = { 'x-api-key': API_KEY, 'Content-Type': 'application/json' }

  // ── Native call wake-up (screen-off call detection via KioskCallService) ──
  useEffect(() => {
    const handler = (e) => {
      const call = e.detail
      if (call?.callId) setIncomingCall(prev =>
        prev?.callId === call.callId ? prev : call
      )
    }
    window.addEventListener('incomingCallFromNative', handler)
    return () => window.removeEventListener('incomingCallFromNative', handler)
  }, [])

  // Pre-warm mic/camera permission so WebView caches the origin grant before
  // the first call attempt — avoids NotAllowedError on first getUserMedia().
  useEffect(() => {
    async function prewarm() {
      try {
        const stream = await navigator.mediaDevices?.getUserMedia({ audio: true, video: false })
        stream?.getTracks().forEach(t => t.stop())
      } catch {}
    }
    prewarm()
  }, [])

  // ── Wake lock: keep screen on when kiosk is active ───────────
  const wakeLockRef = useRef(null)
  useEffect(() => {
    if (appState !== 'kiosk') return

    async function acquire() {
      try {
        wakeLockRef.current = await navigator.wakeLock?.request('screen')
      } catch {
        // Not supported or page not visible yet — will retry on visibilitychange
      }
    }

    function onVisibility() {
      if (document.visibilityState === 'visible') acquire()
    }

    acquire()
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      wakeLockRef.current?.release()
      wakeLockRef.current = null
    }
  }, [appState])

  // ── Battery status ────────────────────────────────────────────
  useEffect(() => {
    if (!navigator.getBattery) return
    let bat = null

    async function init() {
      try {
        bat = await navigator.getBattery()
        const update = () => setBattery({ level: bat.level, charging: bat.charging })
        update()
        bat.addEventListener('levelchange',   update)
        bat.addEventListener('chargingchange', update)
      } catch {}
    }

    init()
    // Battery object is page-scoped and persists; no meaningful cleanup needed
  }, [])

  // ── API ───────────────────────────────────────────────────────
  async function registerDevice(id) {
    const res = await fetch(`${API_BASE}/tablet/register`, {
      method: 'POST', headers, body: JSON.stringify({ deviceId: id }),
    })
    if (res.ok) {
      localStorage.setItem('kiosk_device_id', id)
      setDeviceId(id)
      setAppState('waiting')
    } else {
      throw new Error('Registration failed')
    }
  }

  async function syncData() {
    if (!deviceId) return
    syncAbort.current?.abort()
    syncAbort.current = new AbortController()
    try {
      const res = await fetch(`${API_BASE}/tablet/${deviceId}/sync?_t=${Date.now()}`, { headers, signal: syncAbort.current.signal })
      if (res.status === 404) { setAppState('waiting'); setPatientData(null); return }
      if (res.ok) {
        syncFailCount.current = 0
        setIsOnline(true)
        const data = await res.json()

        // Dispatch commands — command is either a legacy string or a structured object
        if (data.command) {
          console.log('[KioskSync] Command received:', JSON.stringify(data.command))
          const cmd = typeof data.command === 'string' ? { type: data.command } : data.command
          if (cmd.type === 'reload') { window.location.reload(); return }
          if (cmd.type === 'reset') { localStorage.removeItem('kiosk_device_id'); window.location.reload(); return }
          if (cmd.type === 'wifi-add' && window.Android?.addWifiNetwork) {
            window.Android.addWifiNetwork(cmd.ssid, cmd.password, cmd.security)
          }
          if (['restart', 'set-brightness', 'clear-cache'].includes(cmd.type)) {
            window.Android?.updateConfig?.(JSON.stringify(cmd))
          }
        }

        setPatientData(data)
        setAppState('kiosk')

        // Register patient context with native call service (enables screen-off call detection)
        window.Android?.setDeviceContext?.(deviceId, data.patientId, API_KEY)

        // Push all settings to native layer
        if (window.Android?.updateConfig && data.settings) {
          window.Android.updateConfig(JSON.stringify({
            unlockPin:        data.settings.unlockPin,
            restartHour:      data.settings.restartHour,
            ringVolume:       data.settings.ringVolume,
            screenTimeoutMs:  data.settings.screenTimeoutMs,
            timezone:         data.settings.timezone,
            fontScale:        data.settings.fontScale,
            orientation:      data.settings.orientation,
            btDeviceAddress:  data.settings.btDeviceAddress,
          }))
        }

        // Prefetch all photos (full + thumbnail) and contact avatars to local cache
        if (window.Android?.prefetchPhotos) {
          const urls = [
            ...(data.photos ?? []).flatMap(p =>
              p.thumbnailUrl ? [p.url, p.thumbnailUrl] : [p.url]
            ),
            ...(data.contacts ?? []).map(c => c.profilePhotoUrl).filter(Boolean),
          ]
          if (urls.length) window.Android.prefetchPhotos(JSON.stringify(urls))
        }

        // Report device health metrics to backend
        if (window.Android?.getStorageInfo) {
          try {
            const info = JSON.parse(window.Android.getStorageInfo())
            fetch(`${API_BASE}/tablet/${deviceId}/storage-report`, {
              method: 'POST', headers, body: JSON.stringify(info),
            }).catch(() => {})
          } catch {}
        }
      }
    } catch (e) {
      if (e.name === 'AbortError') return
      // Offline — keep showing whatever we have
      syncFailCount.current += 1
      if (syncFailCount.current >= 2) setIsOnline(false)
    }
  }

  // ── Incoming call poll (family-initiated) ─────────────────────
  useEffect(() => {
    if (appState !== 'kiosk' || !patientData?.patientId) return
    let abortController = null
    const poll = async () => {
      abortController?.abort()
      abortController = new AbortController()
      try {
        const res = await fetch(`${API_ROOT}/kiosk/patient/${patientData.patientId}/incoming-call?deviceId=${encodeURIComponent(deviceId)}&_t=${Date.now()}`, { headers, signal: abortController.signal })
        if (res.ok) {
          const call = await res.json()
          setIncomingCall(prev => {
            if (!call) return null
            if (prev?.callId === call.callId) return prev // same call, no re-render
            return call
          })
        }
      } catch (e) {
        if (e.name !== 'AbortError') console.warn('incoming-call poll error', e)
      }
    }
    poll()
    const t = setInterval(poll, CALL_POLL_MS)
    return () => { clearInterval(t); abortController?.abort() }
  }, [appState, patientData?.patientId, deviceId])

  async function answerIncomingCall() {
    if (!incomingCall) return
    await fetch(`${API_ROOT}/kiosk/incoming-call/${incomingCall.callId}/answer`, { method: 'POST', headers }).catch(() => {})
    setIncomingCall(null)
  }

  async function declineIncomingCall() {
    if (!incomingCall) return
    await fetch(`${API_ROOT}/kiosk/incoming-call/${incomingCall.callId}/decline`, { method: 'POST', headers }).catch(() => {})
    setIncomingCall(null)
  }

  async function dismissCallRequest(requestId) {
    try {
      await fetch(`${API_BASE}/tablet/dismiss-call-request/${requestId}`, { method: 'POST', headers })
      // Optimistically remove from local state so the banner disappears immediately
      setPatientData(d => d ? {
        ...d,
        callRequests: (d.callRequests ?? []).filter(r => r.requestId !== requestId),
      } : d)
    } catch {}
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (appState === 'setup') return
    syncData()
    const interval = setInterval(syncData, SYNC_INTERVAL)
    return () => { clearInterval(interval); syncAbort.current?.abort() }
  }, [deviceId])

  const screen = (
    <>
      {appState === 'setup'   && <SetupScreen onRegister={registerDevice} />}
      {appState === 'waiting' && <WaitingScreen deviceId={deviceId} />}
      {appState === 'kiosk'   && patientData && (
        <KioskScreen
          patient={patientData}
          battery={battery}
          isOnline={isOnline}
          onDismissCallRequest={dismissCallRequest}
          incomingCall={incomingCall}
          onAnswerIncomingCall={answerIncomingCall}
          onDeclineIncomingCall={declineIncomingCall}
        />
      )}
    </>
  )

  if (import.meta.env.PROD) {
    return (
      <div style={{ width: '100vw', height: '100vh', overflow: 'hidden', background: '#000' }}>
        {screen}
      </div>
    )
  }

  return <DevFrame>{screen}</DevFrame>
}
