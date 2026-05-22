import { useEffect, useRef, useState } from 'react'
import { ACCENT_CLASSES } from './Settings'
import { joinCall } from '../api'

const RING_TIMEOUT = 45 // seconds — auto-decline after this

function dismissCallNotification() {
  if (!('serviceWorker' in navigator)) return
  navigator.serviceWorker.ready
    .then(reg => reg.getNotifications({ tag: 'incoming-call' }))
    .then(notifs => notifs.forEach(n => n.close()))
    .catch(() => {})
}

function haptic(pattern) { try { navigator.vibrate?.(pattern) } catch {} }

// SVG arc helpers
function describeArc(cx, cy, r, startDeg, endDeg) {
  const toRad = d => (d - 90) * Math.PI / 180
  const x1 = cx + r * Math.cos(toRad(startDeg))
  const y1 = cy + r * Math.sin(toRad(startDeg))
  const x2 = cx + r * Math.cos(toRad(endDeg))
  const y2 = cy + r * Math.sin(toRad(endDeg))
  const large = endDeg - startDeg > 180 ? 1 : 0
  return `M ${x1} ${y1} A ${r} ${r} 0 ${large} 1 ${x2} ${y2}`
}

export default function IncomingCall({
  patientName, roomName, deviceId, deviceToken, displayName,
  settings, onAnswer, onDecline,
}) {
  const ringRef       = useRef(null)
  const wakeLockRef   = useRef(null)
  const preConnectRef = useRef(null)
  const accent        = ACCENT_CLASSES[settings?.accentColor] || ACCENT_CLASSES.green

  const [countdown, setCountdown] = useState(RING_TIMEOUT)

  // Wake lock
  useEffect(() => {
    if ('wakeLock' in navigator) {
      navigator.wakeLock.request('screen').then(l => { wakeLockRef.current = l }).catch(() => {})
    }
    return () => wakeLockRef.current?.release().catch(() => {})
  }, [])

  // Pre-fetch LiveKit token
  useEffect(() => {
    if (!roomName) return
    const devId    = deviceId    || localStorage.getItem('family_device_id')    || ''
    const devToken = deviceToken || localStorage.getItem('family_device_token') || ''
    joinCall(roomName, devId, devToken, displayName || 'Family')
      .then(data => { preConnectRef.current = data })
      .catch(() => {})
  }, []) // eslint-disable-line

  // Countdown timer → auto-decline at 0
  useEffect(() => {
    const id = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) { clearInterval(id); decline(); return 0 }
        return c - 1
      })
    }, 1000)
    return () => clearInterval(id)
  }, []) // eslint-disable-line

  // Ring tone: dual-tone 440+480 Hz, 2s on / 4s off + haptic
  useEffect(() => {
    let stopped = false
    try {
      const ctx = new AudioContext()
      async function beep(dur) {
        const o1 = ctx.createOscillator(), o2 = ctx.createOscillator(), g = ctx.createGain()
        o1.connect(g); o2.connect(g); g.connect(ctx.destination)
        o1.frequency.value = 440; o2.frequency.value = 480
        o1.type = 'sine'; o2.type = 'sine'
        g.gain.setValueAtTime(0, ctx.currentTime)
        g.gain.linearRampToValueAtTime(0.35, ctx.currentTime + 0.04)
        g.gain.setValueAtTime(0.35, ctx.currentTime + dur - 0.04)
        g.gain.linearRampToValueAtTime(0, ctx.currentTime + dur)
        o1.start(ctx.currentTime); o2.start(ctx.currentTime)
        o1.stop(ctx.currentTime + dur); o2.stop(ctx.currentTime + dur)
        await new Promise(r => setTimeout(r, dur * 1000 + 50))
      }
      async function ring() {
        while (!stopped) { haptic([500, 200, 500]); await beep(2.0); await new Promise(r => setTimeout(r, 4000)) }
      }
      ring()
      ringRef.current = () => { if (!stopped) { stopped = true; ctx.close().catch(() => {}) } }
    } catch {}
    return () => ringRef.current?.()
  }, [])

  function answer() {
    haptic([80])
    ringRef.current?.()
    dismissCallNotification()
    onAnswer(preConnectRef.current)
  }

  function decline() {
    haptic([80])
    ringRef.current?.()
    dismissCallNotification()
    onDecline()
  }

  const photoUrl = localStorage.getItem('family_patient_photo')
  const initial  = patientName?.[0]?.toUpperCase()

  // Countdown arc: 56px radius circle, sweeps 360° over RING_TIMEOUT seconds
  const arcProgress = countdown / RING_TIMEOUT         // 1 → 0
  const arcDeg      = (1 - arcProgress) * 360          // 0 → 360 as it expires
  const arcPath     = arcDeg < 359.9 ? describeArc(60, 60, 54, 0, arcDeg) : ''
  const urgentColor = countdown <= 10 ? 'stroke-red-400' : 'stroke-white/25'

  return (
    <div className="flex flex-col items-center justify-between h-full bg-gradient-to-b from-[#0f0f1a] to-black px-8 pt-safe-or-12 pb-safe-or-16 select-none">

      {/* Caller info */}
      <div className="flex flex-col items-center gap-5 flex-1 justify-center">
        <div className="relative flex items-center justify-center">
          {/* Pulsing glow rings */}
          <div className={`absolute w-52 h-52 rounded-full ${accent.bg} opacity-[0.08] animate-ping`} style={{ animationDuration: '1.5s' }} />
          <div className={`absolute w-40 h-40 rounded-full ${accent.bg} opacity-[0.12] animate-pulse`} />

          {/* Avatar */}
          {photoUrl ? (
            <img src={photoUrl} alt={patientName}
              className="w-32 h-32 rounded-full object-cover shadow-2xl ring-4 ring-white/20 relative z-10"
              onError={e => { e.currentTarget.style.display = 'none' }}
            />
          ) : (
            <div className={`w-32 h-32 rounded-full bg-gradient-to-br from-blue-500 to-indigo-700 flex items-center justify-center text-5xl font-bold text-white shadow-2xl ring-4 ring-white/10 relative z-10`}>
              {initial}
            </div>
          )}
        </div>

        <div className="text-center mt-2">
          <p className="text-white/50 text-sm tracking-wide uppercase">Incoming video call</p>
          <p className="text-white text-4xl font-semibold mt-2">{patientName}</p>
        </div>
      </div>

      {/* Action buttons with countdown arc around decline */}
      <div className="flex items-end justify-center gap-24 w-full pb-4">

        {/* Decline — with countdown arc */}
        <div className="flex flex-col items-center gap-3">
          <div className="relative w-20 h-20">
            {/* Countdown arc SVG */}
            <svg className="absolute inset-0 w-full h-full -rotate-90" viewBox="0 0 120 120">
              <circle cx="60" cy="60" r="54" fill="none" strokeWidth="4" className="stroke-white/8" />
              {arcPath && (
                <path d={describeArc(60, 60, 54, 0, arcDeg)} fill="none" strokeWidth="4"
                  strokeLinecap="round" className={`transition-colors duration-300 ${urgentColor}`}
                />
              )}
            </svg>
            <button onClick={decline}
              className="absolute inset-1 rounded-full bg-red-500 active:bg-red-600 flex items-center justify-center shadow-2xl active:scale-90 transition-transform touch-manipulation">
              <EndCallIcon />
            </button>
          </div>
          <span className="text-white/40 text-sm">
            Decline{countdown <= 15 ? ` (${countdown}s)` : ''}
          </span>
        </div>

        {/* Answer */}
        <div className="flex flex-col items-center gap-3">
          <button onClick={answer}
            className={`w-20 h-20 rounded-full ${accent.bg} ${accent.activeBg} flex items-center justify-center shadow-2xl active:scale-90 transition-transform touch-manipulation`}>
            <PhoneIcon />
          </button>
          <span className="text-white/40 text-sm">Answer</span>
        </div>
      </div>
    </div>
  )
}

function PhoneIcon() {
  return <svg className="w-9 h-9 text-white" viewBox="0 0 24 24" fill="currentColor"><path d="M20.01 15.38c-1.23 0-2.42-.2-3.53-.56-.35-.12-.74-.03-1.01.24l-1.57 1.97c-2.83-1.35-5.48-3.9-6.89-6.83l1.95-1.66c.27-.28.35-.67.24-1.02-.37-1.11-.56-2.3-.56-3.53 0-.54-.45-.99-.99-.99H4.19C3.65 3 3 3.24 3 3.99 3 13.28 10.73 21 20.01 21c.71 0 .99-.63.99-1.18v-3.45c0-.54-.45-.99-.99-.99z"/></svg>
}

function EndCallIcon() {
  return <svg className="w-9 h-9 text-white" viewBox="0 0 24 24" fill="currentColor"><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.27-.27.68-.35 1.02-.18 1.12.45 2.35.68 3.58.68.55 0 1 .45 1 1V20c0 .55-.45 1-1 1C9.61 21 3 14.39 3 6c0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.12.32.03.7-.17.97L6.6 10.8z" transform="rotate(135 12 12)"/></svg>
}
