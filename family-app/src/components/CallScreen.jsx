import { useEffect, useRef, useState, useCallback } from 'react'
import { Room, RoomEvent, Track, createLocalTracks, ConnectionQuality } from 'livekit-client'
import { ACCENT_CLASSES } from './Settings'
import { joinCall } from '../api'

function nativeStatus(msg) { window.FamilyBridge?.updateStatus?.(msg) }

export default function CallScreen({
  roomName, deviceId, deviceToken, displayName, patientName,
  preConnectData, settings, onEnd,
}) {
  const accent     = ACCENT_CLASSES[settings?.accentColor] || ACCENT_CLASSES.green
  const autoHide   = settings?.controlsAutoHide  ?? false
  const camDefault = settings?.cameraOnByDefault ?? true

  const [connected, setConnected]         = useState(false)
  const [micMuted, setMicMuted]           = useState(false)
  const [camOff, setCamOff]               = useState(!camDefault)
  const [elapsed, setElapsed]             = useState(0)
  const [remotes, setRemotes]             = useState([])
  const [noAnswer, setNoAnswer]           = useState(false)
  const [declined, setDeclined]           = useState(false)
  const [controlsVisible, setControlsVisible] = useState(true)
  // 'speaker' | 'handset' | 'bluetooth'
  const [audioOutput, setAudioOutput]     = useState('speaker')
  const [connQuality, setConnQuality]     = useState(null)

  const roomRef        = useRef(null)
  const localVideoRef  = useRef(null)
  const localTracks    = useRef([])
  const timerRef       = useRef(null)
  const ringTimeoutRef = useRef(null)
  const hideTimerRef   = useRef(null)
  const hasHadRemotes  = useRef(false)

  // Auto-hide controls
  const scheduleHide = useCallback(() => {
    if (!autoHide) return
    clearTimeout(hideTimerRef.current)
    hideTimerRef.current = setTimeout(() => setControlsVisible(false), 4000)
  }, [autoHide])

  function showControls() { setControlsVisible(true); scheduleHide() }

  useEffect(() => {
    if (autoHide && connected) scheduleHide()
    return () => clearTimeout(hideTimerRef.current)
  }, [autoHide, connected, scheduleHide])

  // ── Connect ──────────────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false

    async function connect() {
      try {
        let token, wsUrl
        if (preConnectData?.token && preConnectData?.wsUrl) {
          ;({ token, wsUrl } = preConnectData)
        } else {
          nativeStatus('Getting call token…')
          const devToken = deviceToken || localStorage.getItem('family_device_token') || ''
          ;({ token, wsUrl } = await joinCall(roomName, deviceId, devToken, displayName))
        }
        if (cancelled) return

        nativeStatus('Connecting to room…')
        const room = new Room({ adaptiveStream: true, dynacast: true })
        roomRef.current = room

        room.on(RoomEvent.Connected, () => {
          if (cancelled) return
          nativeStatus('Waiting for patient…')
          setConnected(true)
          window.FamilyBridge?.enableSpeakerphone?.()
          setRemotes(Array.from(room.remoteParticipants.values()))
          if (!timerRef.current) timerRef.current = setInterval(() => setElapsed(e => e + 1), 1000)
        })

        room.on(RoomEvent.ConnectionQualityChanged, (quality, participant) => {
          if (participant === room.localParticipant) {
            setConnQuality(quality)
          }
        })

        room.on(RoomEvent.ParticipantConnected, () => {
          if (cancelled) return
          hasHadRemotes.current = true
          setRemotes(Array.from(room.remoteParticipants.values()))
          nativeStatus('')
        })

        room.on(RoomEvent.TrackSubscribed, (track) => {
          if (track.kind === Track.Kind.Audio) {
            track.attach()
            window.FamilyBridge?.enableSpeakerphone?.()
          }
          nativeStatus('')
        })

        room.on(RoomEvent.TrackUnsubscribed, (track) => {
          if (track.kind === Track.Kind.Audio) track.detach()
        })

        room.on(RoomEvent.ParticipantDisconnected, () => {
          if (cancelled) return
          setRemotes(Array.from(room.remoteParticipants.values()))
          if (hasHadRemotes.current && room.remoteParticipants.size === 0) hangUp()
        })

        room.on(RoomEvent.Disconnected, () => {
          if (cancelled) return
          if (!hasHadRemotes.current) {
            setDeclined(true)
            nativeStatus('Call declined')
            setTimeout(hangUp, 2000)
          } else {
            hangUp()
          }
        })

        await room.connect(wsUrl, token)
        if (cancelled) { room.disconnect(); return }

        nativeStatus('Starting camera…')
        const tracks = await createLocalTracks({ audio: true, video: camDefault })
        localTracks.current = tracks
        for (const t of tracks) {
          await room.localParticipant.publishTrack(t)
          if (t.kind === Track.Kind.Video && localVideoRef.current) t.attach(localVideoRef.current)
        }
        nativeStatus('Waiting for patient…')

        if (!cancelled && room.remoteParticipants.size > 0) {
          hasHadRemotes.current = true
          setRemotes(Array.from(room.remoteParticipants.values()))
          setConnected(true)
          nativeStatus('')
          window.FamilyBridge?.enableSpeakerphone?.()
          if (!timerRef.current) timerRef.current = setInterval(() => setElapsed(e => e + 1), 1000)
          for (const p of room.remoteParticipants.values()) {
            for (const pub of p.trackPublications.values()) {
              if (pub.isSubscribed && pub.track?.kind === Track.Kind.Audio) pub.track.attach()
            }
          }
        }
      } catch (err) {
        console.error('[family-call] connect error', err)
        nativeStatus(`Failed: ${err.message}`)
        if (!cancelled) setTimeout(hangUp, 2000)
      }
    }

    connect()
    return () => { cancelled = true; cleanup() }
  }, []) // eslint-disable-line

  // 45s ring timeout
  useEffect(() => {
    if (!connected || hasHadRemotes.current || remotes.length > 0) return
    ringTimeoutRef.current = setTimeout(() => {
      setNoAnswer(true)
      nativeStatus('No answer')
      setTimeout(hangUp, 2000)
    }, 45_000)
    return () => clearTimeout(ringTimeoutRef.current)
  }, [connected]) // eslint-disable-line

  const cleanup = useCallback(() => {
    clearInterval(timerRef.current)
    clearTimeout(ringTimeoutRef.current)
    clearTimeout(hideTimerRef.current)
    for (const t of localTracks.current) { t.stop(); t.detach() }
    localTracks.current = []
    roomRef.current?.disconnect()
    roomRef.current = null
  }, [])

  const hangUp = useCallback(() => { cleanup(); setTimeout(onEnd, 600) }, [cleanup, onEnd])

  async function toggleMic() {
    if (!roomRef.current) return
    await roomRef.current.localParticipant.setMicrophoneEnabled(micMuted)
    setMicMuted(m => !m)
    showControls()
  }

  async function toggleCam() {
    if (!roomRef.current) return
    await roomRef.current.localParticipant.setCameraEnabled(camOff)
    setCamOff(c => !c)
    showControls()
  }

  function setAudio(mode) {
    // 'handset' → earpiece + force cam off for privacy
    // 'speaker' / 'bluetooth' → route audio, leave cam as-is
    setAudioOutput(mode)
    if (mode === 'handset') {
      // turn cam off when switching to earpiece (privacy expectation)
      if (!camOff && roomRef.current) {
        roomRef.current.localParticipant.setCameraEnabled(false)
        setCamOff(true)
      }
      window.FamilyBridge?.switchAudioOutput?.('handset')
    } else {
      window.FamilyBridge?.switchAudioOutput?.(mode)
    }
    showControls()
  }

  const elapsedFmt = [Math.floor(elapsed / 3600), Math.floor((elapsed % 3600) / 60), elapsed % 60]
    .filter((v, i) => i > 0 || v > 0)
    .map(v => String(v).padStart(2, '0'))
    .join(':')

  const num = remotes.length
  const gridClass = num <= 1 ? 'w-full h-full grid grid-cols-1'
    : num === 2 ? 'w-full h-full grid grid-cols-2'
    : 'w-full h-full grid grid-cols-2 grid-rows-2'

  const controlsShown = !autoHide || controlsVisible

  return (
    <div
      className="relative w-full h-full bg-black overflow-hidden select-none"
      onClick={autoHide ? showControls : undefined}
    >
      {/* Remote video grid */}
      {num > 0 ? (
        <div className={gridClass}>
          {remotes.map(p => <RemoteParticipant key={p.sid} participant={p} />)}
        </div>
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-b from-gray-900 to-black">
          <div className="w-32 h-32 rounded-full bg-gradient-to-br from-blue-500 to-indigo-700 flex items-center justify-center text-5xl font-bold text-white mb-6 shadow-2xl">
            {patientName?.[0]?.toUpperCase()}
          </div>
          <p className="text-white text-2xl font-semibold">{patientName}</p>
          <p className="text-white/40 text-sm mt-2">
            {declined ? 'Call declined' : noAnswer ? 'No answer' : connected ? 'Calling…' : 'Connecting…'}
          </p>
        </div>
      )}

      {/* Top bar — name + timer + signal quality */}
      {connected && num > 0 && (
        <div className={`absolute top-0 inset-x-0 px-5 pt-safe-or-10 pb-6 bg-gradient-to-b from-black/70 to-transparent pointer-events-none transition-opacity duration-300 ${!controlsShown ? 'opacity-0' : 'opacity-100'}`}>
          <div className="flex justify-between items-center">
            <p className="text-white text-lg font-semibold drop-shadow-md">
              {remotes.map(r => r.name).join(', ')}
            </p>
            <div className="flex items-center gap-2">
              {connQuality && <SignalIcon quality={connQuality} />}
              <p className="text-white/80 text-base tabular-nums font-medium drop-shadow-md">{elapsedFmt}</p>
            </div>
          </div>
        </div>
      )}

      {/* PiP self-view */}
      <div className="absolute bottom-40 right-4 w-24 h-36 rounded-2xl overflow-hidden border-2 border-white/20 shadow-2xl bg-gray-900">
        <video ref={localVideoRef} autoPlay playsInline muted
          className={`w-full h-full object-cover scale-x-[-1] transition-opacity duration-300 ${camOff ? 'opacity-0' : 'opacity-100'}`}
        />
        {camOff && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1">
            <svg className="w-6 h-6 text-white/30" viewBox="0 0 24 24" fill="currentColor">
              <path d="M21 6.5l-4 4V7c0-.55-.45-1-1-1H9.82L21 17.18V6.5zM3.27 2L2 3.27 4.73 6H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.21 0 .39-.08.54-.18L19.73 21 21 19.73 3.27 2z"/>
            </svg>
            <span className="text-white/20 text-[10px]">Cam off</span>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className={`absolute bottom-0 inset-x-0 pb-safe-or-10 pt-2 px-6 bg-gradient-to-t from-black/90 to-transparent transition-opacity duration-300 ${!controlsShown ? 'opacity-0 pointer-events-none' : 'opacity-100'}`}>

        {/* Primary row: mic · cam · end call */}
        <div className="flex items-center justify-center gap-6 mb-4">
          <ControlBtn active={micMuted} onPress={toggleMic} label={micMuted ? 'Unmute' : 'Mute'}>
            {micMuted ? <MicOffIcon /> : <MicIcon />}
          </ControlBtn>

          <ControlBtn active={camOff} onPress={toggleCam} label={camOff ? 'Show cam' : 'Hide cam'}>
            {camOff ? <CamOffIcon /> : <CamIcon />}
          </ControlBtn>

          <button onClick={hangUp}
            className="w-[72px] h-[72px] rounded-full bg-red-500 active:bg-red-600 flex items-center justify-center shadow-2xl active:scale-90 transition-transform touch-manipulation">
            <EndCallIcon />
          </button>
        </div>

        {/* Audio output row: handset · speaker · bluetooth */}
        <div className="flex items-center justify-center gap-3 mb-1">
          {AUDIO_MODES.map(({ key, label, icon }) => (
            <button
              key={key}
              onClick={() => setAudio(key)}
              className={`flex flex-col items-center gap-1 px-4 py-2 rounded-2xl touch-manipulation transition-colors ${
                audioOutput === key
                  ? 'bg-white/20 text-white'
                  : 'text-white/35 active:bg-white/10'
              }`}
            >
              <span className="w-5 h-5">{icon}</span>
              <span className="text-[10px] font-medium">{label}</span>
            </button>
          ))}
        </div>

      </div>
    </div>
  )
}

// ── Remote participant tile ────────────────────────────────────────────────

function RemoteParticipant({ participant }) {
  const videoRef  = useRef(null)
  const [hasVideo, setHasVideo] = useState(false)

  useEffect(() => {
    const update = () => {
      const pub = Array.from(participant.trackPublications.values())
        .find(p => p.kind === Track.Kind.Video)
      if (pub?.isSubscribed && pub.track) {
        setHasVideo(true)
        if (videoRef.current) pub.track.attach(videoRef.current)
      } else {
        setHasVideo(false)
      }
    }
    update()
    participant.on('trackSubscribed',   update)
    participant.on('trackUnsubscribed', update)
    participant.on('trackMuted',        update)
    participant.on('trackUnmuted',      update)
    return () => {
      participant.off('trackSubscribed',   update)
      participant.off('trackUnsubscribed', update)
      participant.off('trackMuted',        update)
      participant.off('trackUnmuted',      update)
    }
  }, [participant])

  return (
    <div className="relative w-full h-full bg-gray-900 border border-black flex items-center justify-center overflow-hidden">
      <video ref={videoRef} autoPlay playsInline muted
        className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-500 ${hasVideo ? 'opacity-100' : 'opacity-0'}`}
      />
      {!hasVideo && (
        <div className="w-24 h-24 rounded-full bg-gradient-to-br from-blue-500 to-indigo-700 flex items-center justify-center text-4xl font-bold text-white shadow-xl z-10">
          {participant.name?.[0]?.toUpperCase() || '?'}
        </div>
      )}
      <div className="absolute bottom-3 left-3 bg-black/60 px-2.5 py-1 rounded-lg backdrop-blur-md text-white text-xs font-medium z-20">
        {participant.name}
      </div>
    </div>
  )
}

// ── Control button ────────────────────────────────────────────────────────

function ControlBtn({ active, onPress, label, children }) {
  return (
    <button onClick={onPress} className="flex flex-col items-center gap-1.5 touch-manipulation">
      <div className={`w-14 h-14 rounded-full flex items-center justify-center transition-colors active:scale-90 ${active ? 'bg-white' : 'bg-white/20'}`}>
        <span className={active ? 'text-black' : 'text-white'}>{children}</span>
      </div>
      <span className="text-white/50 text-[11px]">{label}</span>
    </button>
  )
}

// ── Signal quality indicator ──────────────────────────────────────────────

function SignalIcon({ quality }) {
  const bars = quality === ConnectionQuality.Excellent ? 3
    : quality === ConnectionQuality.Good ? 2
    : quality === ConnectionQuality.Poor ? 1
    : 0
  const color = bars === 3 ? 'text-green-400' : bars === 2 ? 'text-yellow-400' : bars === 1 ? 'text-orange-400' : 'text-red-400'
  return (
    <div className={`flex items-end gap-0.5 ${color}`} title={`Signal: ${quality}`}>
      {[1, 2, 3].map(b => (
        <div key={b} className={`w-1 rounded-sm ${b <= bars ? 'opacity-100' : 'opacity-20'} bg-current`}
          style={{ height: `${b * 4 + 2}px` }} />
      ))}
    </div>
  )
}

// ── Icons ─────────────────────────────────────────────────────────────────

// ── Audio mode config ─────────────────────────────────────────────────────

const AUDIO_MODES = [
  {
    key: 'handset',
    label: 'Handset',
    icon: <svg viewBox="0 0 24 24" fill="currentColor"><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.27-.27.68-.35 1.02-.18 1.12.45 2.35.68 3.58.68.55 0 1 .45 1 1V20c0 .55-.45 1-1 1C9.61 21 3 14.39 3 6c0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.12.32.03.7-.17.97L6.6 10.8z"/></svg>,
  },
  {
    key: 'speaker',
    label: 'Speaker',
    icon: <svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/></svg>,
  },
  {
    key: 'bluetooth',
    label: 'Bluetooth',
    icon: <svg viewBox="0 0 24 24" fill="currentColor"><path d="M17.71 7.71L12 2h-1v7.59L6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 11 14.41V22h1l5.71-5.71-4.3-4.29 4.3-4.29zM13 5.83l1.88 1.88L13 9.59V5.83zm1.88 10.46L13 18.17v-3.76l1.88 1.88z"/></svg>,
  },
]

// ── Icons ─────────────────────────────────────────────────────────────────

function MicIcon()     { return <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z"/></svg> }
function MicOffIcon()  { return <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor"><path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.34 3 3 3 .23 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V20c0 .55.45 1 1 1s1-.45 1-1v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/></svg> }
function CamIcon()     { return <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor"><path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/></svg> }
function CamOffIcon()  { return <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor"><path d="M21 6.5l-4 4V7c0-.55-.45-1-1-1H9.82L21 17.18V6.5zM3.27 2L2 3.27 4.73 6H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.21 0 .39-.08.54-.18L19.73 21 21 19.73 3.27 2z"/></svg> }
function EndCallIcon() { return <svg className="w-8 h-8 text-white" viewBox="0 0 24 24" fill="currentColor"><path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.27-.27.68-.35 1.02-.18 1.12.45 2.35.68 3.58.68.55 0 1 .45 1 1V20c0 .55-.45 1-1 1C9.61 21 3 14.39 3 6c0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.12.32.03.7-.17.97L6.6 10.8z" transform="rotate(135 12 12)"/></svg> }
