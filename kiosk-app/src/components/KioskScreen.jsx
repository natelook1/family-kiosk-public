import { useState, useEffect, useRef } from 'react'
import CallScreen from './CallScreen'

const AVATAR_COLORS = [
  'bg-rose-500', 'bg-blue-500', 'bg-emerald-500', 'bg-violet-500',
  'bg-amber-500', 'bg-teal-500', 'bg-pink-500', 'bg-indigo-500',
]

// Returns the contact's explicit color if set, otherwise falls back to rotation
function contactColor(contact, index) {
  return contact.color || AVATAR_COLORS[index % AVATAR_COLORS.length]
}

const DEFAULT_SETTINGS = {
  slideInterval:     8,
  resumeDelay:       3,
  nightStart:        21,
  nightEnd:          7,
  nightBrightness:   25,
  nightEnabled:      true,
  kenBurns:          true,
  ringtone:          'digital',
  accessibilityMode: false,
}

function isNightHour(hour, start, end) {
  // Handles crossing midnight, e.g. start=21 end=7
  return start > end ? (hour >= start || hour < end) : (hour >= start && hour < end)
}

// ── Main screen ───────────────────────────────────────────────
export default function KioskScreen({ patient, battery, isOnline = true, onDismissCallRequest, incomingCall, onAnswerIncomingCall, onDeclineIncomingCall }) {
  const allPhotos   = patient.photos        ?? []
  const contacts    = patient.contacts      ?? []
  const callReqs    = patient.callRequests  ?? []
  const settings    = { ...DEFAULT_SETTINGS, ...patient.settings }

  const [slide, setSlide]             = useState(0)
  const [calling, setCalling]         = useState(null)
  const [resuming, setResuming]       = useState(false)  // post-call debounce
  const [time, setTime]               = useState(new Date())
  const [pickerOpen, setPickerOpen]   = useState(false)
  const resumeTimer                   = useRef(null)
  // Swipe tracking
  const touchStartX               = useRef(null)
  const swipeResetTimer           = useRef(null)
  // Manual-advance flag — resets auto-timer after a swipe
  const [swipedAt, setSwipedAt]   = useState(0)

  // Polling for safely cached photos
  const [cachedSet, setCachedSet] = useState(() => new Set())

  useEffect(() => {
    if (!window.Android || !window.Android.getCachedPhotos) return
    const check = () => {
      try {
        const list = JSON.parse(window.Android.getCachedPhotos())
        setCachedSet(new Set(list))
      } catch(e) {}
    }
    check()
    const t = setInterval(check, 5000)
    return () => clearInterval(t)
  }, [])

  const photos = window.Android?.getCachedPhotos
    ? allPhotos.filter(p => {
        const inCache = (url) => {
          if (!url) return false
          const name = url.split('looknet.ca/')[1]?.split('?')[0]?.replace(/\//g, '_')
          return name ? cachedSet.has(name) : false
        }
        return inCache(p.thumbnailUrl) || inCache(p.url)
      })
    : allPhotos

  const currentSlide = slide >= photos.length ? 0 : slide

  // Store length in a ref so the interval doesn't reset every time a photo downloads!
  const photosLenRef = useRef(photos.length)
  useEffect(() => { photosLenRef.current = photos.length }, [photos.length])

  // Boolean dep so the slideshow starts once enough photos are cached, without
  // resetting the timer every time an individual new photo arrives.
  const hasMultiplePhotos = photos.length >= 2

  // Clock tick
  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 10_000)
    return () => clearInterval(t)
  }, [])

  // Slideshow — pauses during a call, resume debounce, and resets after manual swipe
  useEffect(() => {
    if (calling || resuming || !hasMultiplePhotos) return
    const t = setInterval(
      () => setSlide(s => (s >= photosLenRef.current - 1 ? 0 : s + 1)),
      settings.slideInterval * 1000
    )
    return () => clearInterval(t)
  }, [calling, resuming, settings.slideInterval, swipedAt, hasMultiplePhotos])

  function goToSlide(next) {
    const clamped = (next + photos.length) % photos.length
    setSlide(clamped)
    // Reset the auto-advance timer by bumping swipedAt
    clearTimeout(swipeResetTimer.current)
    swipeResetTimer.current = setTimeout(() => setSwipedAt(Date.now()), 50)
  }

  function handleTouchStart(e) {
    // Ignore touches on the contact buttons / call overlay
    if (calling) return
    touchStartX.current = e.touches[0].clientX
  }

  function handleTouchEnd(e) {
    if (calling || touchStartX.current === null || photos.length < 2) return
    const dx = e.changedTouches[0].clientX - touchStartX.current
    touchStartX.current = null
    if (Math.abs(dx) < 40) return  // too short — not a swipe
    goToSlide(dx < 0 ? currentSlide + 1 : currentSlide - 1)
  }

  function initiateCall(contact) {
    clearTimeout(resumeTimer.current)
    setResuming(false)
    setCalling(contact)
  }

  function endCall() {
    setCalling(null)
    setPickerOpen(false)
    if (settings.resumeDelay > 0) {
      setResuming(true)
      resumeTimer.current = setTimeout(() => setResuming(false), settings.resumeDelay * 1000)
    }
  }

  // Day / night brightness
  const hour       = time.getHours()
  const isNight    = settings.nightEnabled && isNightHour(hour, settings.nightStart, settings.nightEnd)
  const brightness = isNight ? settings.nightBrightness / 100 : 1

  const timeFmt = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  const dateFmt = time.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' })

  // Active call request (show first pending)
  const activeCallReq = callReqs[0] ?? null

  return (
    <div
      className="relative w-full h-full overflow-hidden bg-black select-none"
      style={{ filter: brightness < 1 ? `brightness(${brightness})` : undefined }}
      onTouchStart={handleTouchStart}
      onTouchEnd={handleTouchEnd}
    >
      {/* ── Photos ─────────────────────────────────────────────── */}
      {photos.length > 0 ? (
        photos.map((photo, i) => {
          const isActive  = i === currentSlide
          const isPrev    = i === (currentSlide - 1 + photos.length) % photos.length
          const isNext    = i === (currentSlide + 1) % photos.length

          // GPU Memory Fix: Only keep active, previous, and next slides in the DOM.
          if (!isActive && !isPrev && !isNext) return null

          const animated  = settings.kenBurns && photos.length > 1
          const variant   = `kenburns-${i % 4}`
          return (
            <div
              key={photo.photoId}
              className={`absolute inset-0 overflow-hidden transition-opacity duration-1000 ${isActive ? 'opacity-100' : 'opacity-0'}`}
            >
              {/* Blurred thumbnail fills letterbox bars behind contain-fit main photo */}
              {photo.thumbnailUrl && (
                <img
                  src={photo.thumbnailUrl}
                  alt=""
                  draggable={false}
                  aria-hidden
                  className="absolute inset-0 w-full h-full object-cover scale-110"
                  style={{ filter: 'blur(20px)', animation: 'none' }}
                />
              )}
              {/* Overlays */}
              <div className="absolute inset-0 pointer-events-none">
                <div className="absolute inset-0 bg-black/35" />
                <div className="absolute inset-x-0 top-0 h-44 bg-gradient-to-b from-black/70 to-transparent" />
                <div className="absolute inset-x-0 bottom-0 h-72 bg-gradient-to-t from-black/80 to-transparent" />
              </div>
              {/* Main photo — contain so nothing is cropped */}
              <img
                src={photo.url}
                alt=""
                draggable={false}
                className="absolute inset-0 w-full h-full object-contain"
                style={animated
                  ? {
                      animation: `${variant} ${settings.slideInterval + 2}s ease-in-out infinite alternate`,
                      animationPlayState: isActive ? 'running' : 'paused',
                      willChange: 'transform',
                    }
                  : undefined}
              />
            </div>
          )
        })
      ) : (
        <div className="absolute inset-0 bg-gradient-to-br from-gray-900 to-gray-950" />
      )}

      {/* Gradients */}
      <div className="absolute inset-x-0 top-0 h-44 bg-gradient-to-b from-black/75 to-transparent pointer-events-none" />
      <div className="absolute inset-x-0 bottom-0 h-72 bg-gradient-to-t from-black/85 to-transparent pointer-events-none" />

      {/* ── Clock ──────────────────────────────────────────────── */}
      <div className="absolute top-0 left-0 px-7 pt-6 text-white pointer-events-none" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.7)' }}>
        <div className="text-6xl font-thin tabular-nums tracking-tight leading-none">{timeFmt}</div>
        <div className="text-sm text-white/55 mt-1.5 font-light">{dateFmt}</div>
      </div>

      {/* ── Patient greeting (top-right) ───────────────────────── */}
      <div className="absolute top-0 right-0 px-7 pt-7 text-right pointer-events-none" style={{ textShadow: '0 1px 6px rgba(0,0,0,0.7)' }}>
        <div className="text-white/55 text-sm font-light">Hello,</div>
        <div className="text-white text-2xl font-semibold leading-tight">{patient.name}</div>
      </div>

      {/* ── Battery (below greeting, top-right) ────────────────── */}
      {battery && (
        <div className="absolute top-24 right-7 pointer-events-none" style={{ filter: 'drop-shadow(0 1px 4px rgba(0,0,0,0.7))' }}>
          <BatteryIndicator battery={battery} />
        </div>
      )}

      {/* ── Slide indicators (right edge) ───────────────────────��� */}
      {photos.length > 1 && photos.length <= 20 && (
        <div className="absolute right-3 top-1/2 -translate-y-1/2 flex flex-col gap-2 pointer-events-none">
          {photos.map((_, i) => (
            <div
              key={i}
              className={`rounded-full transition-all duration-500 ${
                i === currentSlide ? 'w-1.5 h-5 bg-white' : 'w-1.5 h-1.5 bg-white/30'
              }`}
            />
          ))}
        </div>
      )}

      {/* ── Contact buttons ────────────────────────────────────── */}
      {contacts.length > 0 && !settings.accessibilityMode && (
        <div className={`absolute bottom-0 inset-x-0 px-5 pb-4 transition-opacity duration-1000 ${!isOnline ? 'opacity-40' : ''}`}>
          <div className="flex items-center justify-center gap-2 mb-4">
            {!isOnline && (
              <svg className="w-3.5 h-3.5 text-white/60" viewBox="0 0 24 24" fill="currentColor">
                <path d="M1 1l22 22M16.72 11.06A10.94 10.94 0 0 1 19 12.55M5 12.55a10.94 10.94 0 0 1 5.17-2.39M10.71 5.05A16 16 0 0 1 22.56 9M1.42 9a15.91 15.91 0 0 1 4.7-2.88M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none"/>
              </svg>
            )}
            <p className="text-white/40 text-xs text-center uppercase tracking-widest font-medium">
              {isOnline ? 'Video Call' : 'No connection'}
            </p>
          </div>
          {contacts.length > 5 ? (
            <div className="grid grid-cols-5 gap-3 w-full">
              {contacts.map((contact, i) => (
                <ContactButton
                  key={contact.contactId}
                  contact={contact}
                  color={contactColor(contact, i)}
                  delay={i * 80}
                  onCall={initiateCall}
                  compact
                />
              ))}
            </div>
          ) : (
            <div className="flex gap-4 justify-center">
              {contacts.map((contact, i) => (
                <ContactButton
                  key={contact.contactId}
                  contact={contact}
                  color={contactColor(contact, i)}
                  delay={i * 80}
                  onCall={initiateCall}
                />
              ))}
            </div>
          )}
          {photos[currentSlide]?.caption && !calling && (
            <div className="flex justify-center mt-3 pointer-events-none">
              <div className="bg-black/60 rounded-full px-5 py-2">
                <p className="text-white text-sm font-light text-center">{photos[currentSlide].caption}</p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ── Accessibility mode — big CTA button ────────────────── */}
      {contacts.length > 0 && settings.accessibilityMode && !pickerOpen && (
        <div className="absolute bottom-0 inset-x-0 flex flex-col items-center gap-3 pb-6">
          <button
            onClick={() => setPickerOpen(true)}
            className={`flex items-center gap-4 text-white font-bold text-2xl px-12 py-6 rounded-3xl shadow-lg active:scale-95 transition-all touch-manipulation ${
              isOnline ? 'bg-green-500 active:bg-green-600' : 'bg-gray-600 opacity-50'
            }`}
          >
            {isOnline ? (
              <svg className="w-9 h-9" viewBox="0 0 24 24" fill="currentColor">
                <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/>
              </svg>
            ) : (
              <svg className="w-9 h-9" viewBox="0 0 24 24" fill="currentColor">
                <path d="M1 1l22 22M16.72 11.06A10.94 10.94 0 0 1 19 12.55M5 12.55a10.94 10.94 0 0 1 5.17-2.39M10.71 5.05A16 16 0 0 1 22.56 9M1.42 9a15.91 15.91 0 0 1 4.7-2.88M8.53 16.11a6 6 0 0 1 6.95 0M12 20h.01" stroke="currentColor" strokeWidth="2" strokeLinecap="round" fill="none"/>
              </svg>
            )}
            {isOnline ? 'Video Call' : 'No connection'}
          </button>
          {photos[currentSlide]?.caption && !calling && (
            <div className="bg-black/60 rounded-full px-5 py-2 pointer-events-none">
              <p className="text-white text-sm font-light text-center">{photos[currentSlide].caption}</p>
            </div>
          )}
        </div>
      )}

      {/* ── Accessibility contact picker overlay ────────────────── */}
      {settings.accessibilityMode && pickerOpen && !calling && (
        <AccessibilityPicker
          contacts={contacts}
          onCall={(contact) => { setPickerOpen(false); initiateCall(contact) }}
          onClose={() => setPickerOpen(false)}
        />
      )}

      {/* ── Empty state ─────────────────────────────────────────── */}
      {photos.length === 0 && contacts.length === 0 && (
        <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
          <p className="text-white/25 text-xl font-light">
            {allPhotos.length > 0 ? `Downloading ${allPhotos.length} photos...` : 'Waiting for content…'}
          </p>
        </div>
      )}

      {/* ── Call-back request banner ────────────────────────────── */}
      {activeCallReq && !calling && (
        <CallRequestBanner
          request={activeCallReq}
          contacts={contacts}
          onCall={(contact) => {
            onDismissCallRequest(activeCallReq.requestId)
            // If family initiated, pass roomName so CallScreen joins existing room
            initiateCall(activeCallReq.roomName ? { ...contact, roomName: activeCallReq.roomName } : contact)
          }}
          onDismiss={() => onDismissCallRequest(activeCallReq.requestId)}
        />
      )}

      {/* ── Incoming call from family ───────────────────────────── */}
      {incomingCall && !calling && (
        <IncomingCallOverlay
          call={incomingCall}
          ringtone={settings.ringtone}
          onAnswer={() => {
            onAnswerIncomingCall()
            initiateCall({ contactId: incomingCall.contactId, name: incomingCall.contactName, roomName: incomingCall.roomName })
          }}
          onDecline={onDeclineIncomingCall}
        />
      )}

      {/* ── Call screen (Livekit) ───────────────────────────────── */}
      {calling && (
        <CallScreen
          patient={patient}
          contact={calling}
          onEnd={endCall}
        />
      )}
    </div>
  )
}

// ── Call-back request banner ──────────────────────────────────
function CallRequestBanner({ request, contacts, onCall, onDismiss }) {
  const contact = contacts.find(c => c.contactId === request.contactId)
  const color   = contact
    ? contactColor(contact, contacts.indexOf(contact))
    : 'bg-rose-500'

  return (
    <div className="absolute inset-x-0 bottom-0 pb-48 flex justify-center items-end pointer-events-none">
      <div className="pointer-events-auto mx-5 mb-2 animate-slide-up">
        <div className="bg-black/40 border border-white/20 rounded-3xl px-6 py-5 flex items-center gap-5 shadow-md max-w-sm w-full">
          {/* Avatar with warm glow */}
          <div className="relative flex-shrink-0">
            <div className={`absolute inset-0 rounded-full ${color} opacity-40 animate-ping scale-125`} />
            <Avatar
              name={request.name}
              photoUrl={request.profilePhotoUrl}
              color={color}
              size="w-14 h-14"
              textSize="text-xl"
              ring
            />
          </div>

          <div className="flex-1 min-w-0">
            <p className="text-white/60 text-xs font-medium mb-0.5">
              {request.roomName ? '📞 Incoming video call' : 'Thinking of you 💕'}
            </p>
            <p className="text-white font-bold text-lg leading-tight truncate">{request.name}</p>
            <p className="text-white/50 text-xs">
              {request.roomName ? 'is calling you' : 'wants to hear your voice'}
            </p>
          </div>

          <div className="flex flex-col gap-2 flex-shrink-0">
            {contact && (
              <button
                onClick={() => onCall(contact)}
                className="bg-green-500 active:bg-green-600 text-white text-xs font-semibold px-4 py-2 rounded-xl transition-colors touch-manipulation"
              >
                Call
              </button>
            )}
            <button
              onClick={onDismiss}
              className="text-white/40 active:text-white/70 text-xs px-4 py-2 rounded-xl transition-colors touch-manipulation"
            >
              Later
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Incoming call overlay (family-initiated) ──────────────────
function IncomingCallOverlay({ call, onAnswer, onDecline, ringtone = 'digital' }) {
  const ringRef = useRef(null)

  useEffect(() => {
    // If ringtone is a native URI (content:// or file://) delegate to the Android bridge
    if (ringtone.includes('://') && window.Android?.playRingtone) {
      try { window.Android.playRingtone(ringtone) } catch (_) {}
      ringRef.current = () => { try { window.Android?.stopRingtone() } catch (_) {} }
      return () => ringRef.current?.()
    }

    try {
      const ctx = new AudioContext()
      let stopped = false

      async function pause(ms) { await new Promise(r => setTimeout(r, ms)) }

      // Two short beeps — current default
      async function ringDigital() {
        async function beep(freq, dur) {
          if (ctx.state === 'suspended') await ctx.resume()
          const osc = ctx.createOscillator()
          const gain = ctx.createGain()
          osc.connect(gain); gain.connect(ctx.destination)
          osc.frequency.value = freq; osc.type = 'sine'
          gain.gain.setValueAtTime(0, ctx.currentTime)
          gain.gain.linearRampToValueAtTime(0.7, ctx.currentTime + 0.04)
          gain.gain.setValueAtTime(0.7, ctx.currentTime + dur - 0.04)
          gain.gain.linearRampToValueAtTime(0, ctx.currentTime + dur)
          osc.start(ctx.currentTime); osc.stop(ctx.currentTime + dur)
          await pause(dur * 1000 + 50)
        }
        while (!stopped) {
          await beep(880, 0.35)
          await pause(150)
          await beep(880, 0.35)
          await pause(2200)
        }
      }

      // Classic POTS telephone: 440+480 Hz dual tone, 2 s on / 4 s off
      async function ringClassic() {
        while (!stopped) {
          if (ctx.state === 'suspended') await ctx.resume()
          const t = ctx.currentTime
          for (const freq of [440, 480]) {
            const osc = ctx.createOscillator()
            const gain = ctx.createGain()
            osc.type = 'triangle'; osc.frequency.value = freq
            osc.connect(gain); gain.connect(ctx.destination)
            gain.gain.setValueAtTime(0, t)
            gain.gain.linearRampToValueAtTime(0.35, t + 0.02)
            gain.gain.setValueAtTime(0.35, t + 1.98)
            gain.gain.linearRampToValueAtTime(0, t + 2.0)
            osc.start(t); osc.stop(t + 2.0)
          }
          await pause(2050)
          if (stopped) break
          await pause(4000)
        }
      }

      // Soft chime: single mellow tone, 1 s on / 3 s off
      async function ringGentle() {
        async function chime() {
          if (ctx.state === 'suspended') await ctx.resume()
          const t = ctx.currentTime
          const osc = ctx.createOscillator()
          const gain = ctx.createGain()
          osc.type = 'sine'; osc.frequency.value = 523
          osc.connect(gain); gain.connect(ctx.destination)
          gain.gain.setValueAtTime(0, t)
          gain.gain.linearRampToValueAtTime(0.5, t + 0.08)
          gain.gain.exponentialRampToValueAtTime(0.01, t + 1.2)
          osc.start(t); osc.stop(t + 1.2)
          await pause(1250)
        }
        while (!stopped) {
          await chime()
          await pause(3000)
        }
      }

      const ringFn = ringtone === 'classic' ? ringClassic
                   : ringtone === 'gentle'  ? ringGentle
                   : ringDigital
      ringFn().catch(e => console.error('ring loop error', e))

      ringRef.current = () => {
        stopped = true
        if (ctx.state !== 'closed') ctx.suspend().catch(() => {})
      }
    } catch (e) {
      console.error("AudioContext init error", e)
    }
    return () => ringRef.current?.()
  }, [ringtone])

  function answer() { ringRef.current?.(); onAnswer() }
  function decline() { ringRef.current?.(); onDecline() }

  return (
    <div className="absolute inset-0 z-50 bg-gradient-to-b from-gray-900 to-black flex flex-col items-center justify-between px-8 py-16 select-none">
      <div className="flex flex-col items-center gap-4 mt-8">
        <div className="relative">
          <div className="absolute inset-0 rounded-full bg-green-500/20 animate-ping scale-150" />
          <div className="w-32 h-32 rounded-full bg-gradient-to-br from-blue-400 to-blue-600 flex items-center justify-center text-5xl font-bold text-white shadow-md relative z-10">
            {call.contactName?.[0]?.toUpperCase()}
          </div>
        </div>
        <div className="text-center mt-4">
          <p className="text-white/60 text-base">Incoming video call</p>
          <p className="text-white text-4xl font-semibold mt-1">{call.contactName}</p>
        </div>
      </div>

      <div className="flex items-center justify-center gap-20 w-full">
        <div className="flex flex-col items-center gap-3">
          <button onClick={decline}
            className="w-20 h-20 rounded-full bg-red-500 active:bg-red-600 flex items-center justify-center shadow-md active:scale-90 transition-transform touch-manipulation">
            <svg className="w-9 h-9 text-white" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.27-.27.68-.35 1.02-.18 1.12.45 2.35.68 3.58.68.55 0 1 .45 1 1V20c0 .55-.45 1-1 1C9.61 21 3 14.39 3 6c0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.12.32.03.7-.17.97L6.6 10.8z" transform="rotate(135 12 12)"/>
            </svg>
          </button>
          <span className="text-white/50 text-sm">Decline</span>
        </div>
        <div className="flex flex-col items-center gap-3">
          <button onClick={answer}
            className="w-20 h-20 rounded-full bg-green-500 active:bg-green-600 flex items-center justify-center shadow-md active:scale-90 transition-transform touch-manipulation">
            <svg className="w-9 h-9 text-white" viewBox="0 0 24 24" fill="currentColor">
              <path d="M20.01 15.38c-1.23 0-2.42-.2-3.53-.56-.35-.12-.74-.03-1.01.24l-1.57 1.97c-2.83-1.35-5.48-3.9-6.89-6.83l1.95-1.66c.27-.28.35-.67.24-1.02-.37-1.11-.56-2.3-.56-3.53 0-.54-.45-.99-.99-.99H4.19C3.65 3 3 3.24 3 3.99 3 13.28 10.73 21 20.01 21c.71 0 .99-.63.99-1.18v-3.45c0-.54-.45-.99-.99-.99z"/>
            </svg>
          </button>
          <span className="text-white/50 text-sm">Answer</span>
        </div>
      </div>
    </div>
  )
}

// ── Accessibility contact picker (full-screen) ────────────────
function AccessibilityPicker({ contacts, onCall, onClose }) {
  return (
    <div className="absolute inset-0 z-40 bg-black/90 flex flex-col select-none">
      {/* Header */}
      <div className="flex items-center justify-between px-8 pt-8 pb-4 flex-shrink-0">
        <h2 className="text-white text-3xl font-bold">Who would you like to call?</h2>
        <button
          onClick={onClose}
          className="text-white/50 active:text-white/80 text-lg font-medium px-5 py-3 rounded-2xl border border-white/20 active:bg-white/10 transition-colors touch-manipulation"
        >
          Cancel
        </button>
      </div>

      {/* Contact grid */}
      <div className="flex-1 overflow-hidden px-6 pb-8">
        <div className={`h-full grid gap-5 content-center ${
          contacts.length <= 2 ? 'grid-cols-2' :
          contacts.length <= 4 ? 'grid-cols-2' :
          'grid-cols-3'
        }`}>
          {contacts.map((contact, i) => {
            const color = contactColor(contact, i)
            return (
              <button
                key={contact.contactId}
                onClick={() => onCall(contact)}
                className="flex flex-col items-center justify-center gap-4 rounded-3xl bg-white/10 border border-white/15 active:bg-white/20 active:scale-95 transition-all touch-manipulation py-8 px-4"
              >
                <Avatar
                  name={contact.name}
                  photoUrl={contact.profilePhotoUrl}
                  color={color}
                  size="w-24 h-24"
                  textSize="text-4xl"
                />
                <span className="text-white font-bold text-xl leading-tight text-center">
                  {contact.name}
                </span>
              </button>
            )
          })}
        </div>
      </div>
    </div>
  )
}

// ── Contact button ────────────────────────────────────────────
function ContactButton({ contact, color, delay, onCall, compact }) {
  return (
    <button
      onClick={() => onCall(contact)}
      style={{ animationDelay: `${delay}ms` }}
      className={`animate-slide-up flex flex-col items-center justify-center rounded-3xl bg-white/10 border border-white/10 shadow-md active:scale-95 transition-transform touch-manipulation ${
        compact ? 'w-full h-24' : 'w-32 h-28'
      }`}
    >
      <Avatar
        name={contact.name}
        photoUrl={contact.profilePhotoUrl}
        color={color}
        size={compact ? 'w-12 h-12' : 'w-14 h-14'}
        textSize={compact ? 'text-lg' : 'text-xl'}
      />
      <span className="text-white font-semibold text-xs mt-1.5 leading-tight text-center truncate w-full px-1.5">
        {contact.name}
      </span>
    </button>
  )
}

// ── Battery indicator ─────────────────────────────────────────
function BatteryIndicator({ battery }) {
  const pct      = Math.round(battery.level * 100)
  const isLow    = pct <= 20 && !battery.charging
  const isMed    = pct <= 40 && !battery.charging && !isLow
  const barColor = battery.charging ? 'bg-green-400'
                 : isLow            ? 'bg-red-400'
                 : isMed            ? 'bg-yellow-400'
                 :                    'bg-white'

  return (
    <div className="flex items-center gap-1.5 opacity-60">
      {/* Battery body */}
      <div className="relative flex items-center">
        <div className="w-7 h-3.5 rounded-sm border border-white/60 p-px flex items-center">
          <div
            className={`h-full rounded-sm transition-all ${barColor}`}
            style={{ width: `${pct}%` }}
          />
        </div>
        {/* Terminal nub */}
        <div className="w-0.5 h-1.5 bg-white/60 rounded-r-sm ml-px" />
        {/* Charging bolt */}
        {battery.charging && (
          <span className="absolute inset-0 flex items-center justify-center text-white text-[8px] font-bold leading-none">
            ⚡
          </span>
        )}
      </div>
      <span className={`text-xs font-medium ${isLow ? 'text-red-400' : 'text-white'}`}>
        {pct}%
      </span>
    </div>
  )
}

// ── Avatar ────────────────────────────────────────────────────
function Avatar({ name, photoUrl, color, size, textSize, ring }) {
  return (
    <div className={`${size} rounded-full ${color} flex items-center justify-center overflow-hidden flex-shrink-0 ${ring ? 'ring-4 ring-white/25' : ''}`}>
      {photoUrl ? (
        <img src={photoUrl} alt={name} className="w-full h-full object-cover" />
      ) : (
        <span className={`text-white font-bold ${textSize}`}>{name?.[0]?.toUpperCase()}</span>
      )}
    </div>
  )
}
