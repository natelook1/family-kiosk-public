import { useEffect, useRef, useState, useCallback } from 'react'
import {
  Room,
  RoomEvent,
  Track,
  createLocalTracks,
  ConnectionState,
} from 'livekit-client'

const API_BASE = import.meta.env.VITE_API_BASE || '/webhook'
const API_ROOT = API_BASE.replace(/\/webhook$/, '') || ''
const API_KEY  = import.meta.env.VITE_API_KEY  || 'devkey'

// ── CallScreen ────────────────────────────────────────────────
// Full-screen Messenger-style call UI using Livekit WebRTC.
// Handles: connecting, ringing, connected, mic/camera toggles, end call.
export default function CallScreen({ patient, contact, onEnd }) {
  const [phase, setPhase]           = useState('connecting') // connecting | ringing | connected | ended
  const [micMuted, setMicMuted]     = useState(false)
  const [camOff, setCamOff]         = useState(false)
  const [remoteHasVideo, setRemoteHasVideo] = useState(false)
  const [elapsed, setElapsed]       = useState(0)
  const [currentRoomName, setCurrentRoomName] = useState(contact.roomName || null)
  const [remotes, setRemotes]       = useState([])
  const [showInvite, setShowInvite] = useState(false)

  const roomRef         = useRef(null)
  const localVideoRef   = useRef(null)   // PiP self-view
  const remoteVideoRef  = useRef(null)   // full-screen remote
  const localTrackRefs  = useRef([])
  const timerRef        = useRef(null)
  const ringTimeoutRef  = useRef(null)
  const endedRef        = useRef(false)  // guard against re-entrant hangUp
  const hasHadParticipants = useRef(false)

  // ── Connect to Livekit ────────────────────────────────────────
  useEffect(() => {
    let cancelled = false

    async function connect() {
      try {
        // If contact has a roomName, family initiated — join existing room
        const res = contact.roomName
          ? await fetch(`${API_ROOT}/call/kiosk-join`, {
              method:  'POST',
              headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
              body:    JSON.stringify({ roomName: contact.roomName, patientId: patient.patientId }),
            })
          : await fetch(`${API_BASE}/call/initiate`, {
              method:  'POST',
              headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
              body:    JSON.stringify({ patientId: patient.patientId, contactId: contact.contactId }),
            })
        if (!res.ok) throw new Error('join failed')
        const { token, wsUrl, roomName } = await res.json()
        if (cancelled) return

        const room = new Room({ adaptiveStream: true, dynacast: true })
        roomRef.current = room
        if (roomName) setCurrentRoomName(roomName)

        room.on(RoomEvent.ParticipantConnected, () => {
          if (!cancelled) {
            hasHadParticipants.current = true
            setRemotes(Array.from(room.remoteParticipants.values()))
            setPhase('connected')
            if (!timerRef.current) timerRef.current = setInterval(() => setElapsed(e => e + 1), 1000)
          }
        })

        room.on(RoomEvent.TrackSubscribed, (track) => {
          if (track.kind === Track.Kind.Audio) {
            track.attach()
          }
        })

        room.on(RoomEvent.TrackUnsubscribed, (track) => {
          if (track.kind === Track.Kind.Audio) track.detach()
        })

        room.on(RoomEvent.ParticipantDisconnected, () => {
          if (!cancelled) {
            setRemotes(Array.from(room.remoteParticipants.values()))
            // Auto hang-up if everyone else has left
            if (hasHadParticipants.current && room.remoteParticipants.size === 0) hangUp()
          }
        })

        room.on(RoomEvent.Disconnected, () => {
          if (!cancelled) hangUp()
        })

        await room.connect(wsUrl, token)
        if (cancelled) { room.disconnect(); return }

        const callType = contact.callType ?? 'video'
        const tracks = await createLocalTracks({
          audio: true,
          video: callType === 'video',
        })
        localTrackRefs.current = tracks

        for (const track of tracks) {
          await room.localParticipant.publishTrack(track)
          if (track.kind === Track.Kind.Video && localVideoRef.current) {
            track.attach(localVideoRef.current)
          }
        }

        // For family-initiated calls: family is already in the room when we join.
        // ParticipantConnected only fires for *new* participants, so we must check
        // for existing ones after connect + publish.
        if (!cancelled) {
          if (room.remoteParticipants.size > 0) {
            hasHadParticipants.current = true
            setRemotes(Array.from(room.remoteParticipants.values()))
            setPhase('connected')
            timerRef.current = setInterval(() => setElapsed(e => e + 1), 1000)
            for (const participant of room.remoteParticipants.values()) {
              for (const pub of participant.trackPublications.values()) {
                if (pub.isSubscribed && pub.track) {
                  if (pub.track.kind === Track.Kind.Audio) pub.track.attach()
                }
              }
            }
          } else {
            setPhase('ringing')
          }
        }
      } catch (err) {
        console.error('[call] connect error', err?.name, err?.message, err)
        if (!cancelled) hangUp()
      }
    }

    connect()

    return () => {
      cancelled = true
      cleanup()
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Ringback tone + 45s ring timeout while waiting for family to answer
  useEffect(() => {
    if (phase !== 'ringing') {
      window.Android?.stopRingback?.()
      clearTimeout(ringTimeoutRef.current)
      return
    }
    window.Android?.startRingback?.()
    ringTimeoutRef.current = setTimeout(() => {
      hangUp()
    }, 45_000)
    return () => {
      window.Android?.stopRingback?.()
      clearTimeout(ringTimeoutRef.current)
    }
  }, [phase]) // eslint-disable-line react-hooks/exhaustive-deps

  const cleanup = useCallback(() => {
    clearInterval(timerRef.current)
    clearTimeout(ringTimeoutRef.current)
    window.Android?.stopRingback?.()
    for (const t of localTrackRefs.current) {
      try { t.stop() } catch {}
      try { t.detach() } catch {}
    }
    localTrackRefs.current = []
    // Null the ref BEFORE calling disconnect — LiveKit fires RoomEvent.Disconnected
    // synchronously inside disconnect(), which would re-enter hangUp/cleanup if ref
    // is still set, causing "Cannot close a closed AudioContext".
    if (roomRef.current) {
      const room = roomRef.current
      roomRef.current = null
      try { room.disconnect() } catch {}
    }
  }, [])

  const hangUp = useCallback(() => {
    if (endedRef.current) return
    endedRef.current = true
    cleanup()
    setPhase('ended')
    setTimeout(onEnd, 800) // brief pause so user sees "Call ended"
  }, [cleanup, onEnd])

  // ── Mic toggle ────────────────────────────────────────────────
  async function toggleMic() {
    const room = roomRef.current
    if (!room) return
    const enabled = !micMuted
    await room.localParticipant.setMicrophoneEnabled(enabled)
    setMicMuted(!enabled)
  }

  // ── Camera toggle ─────────────────────────────────────────────
  async function toggleCam() {
    const room = roomRef.current
    if (!room) return
    const enabled = !camOff
    await room.localParticipant.setCameraEnabled(enabled)
    setCamOff(!enabled)
  }

  const elapsedFmt = [
    Math.floor(elapsed / 3600),
    Math.floor((elapsed % 3600) / 60),
    elapsed % 60,
  ]
    .filter((v, i) => i > 0 || v > 0)
    .map(v => String(v).padStart(2, '0'))
    .join(':')

  const isVideo = (contact.callType ?? 'video') === 'video'

  // ── Invite Modal Logic ─────────────────────────────────────────
  const availableContacts = patient.contacts?.filter(c => 
    c.contactId !== contact.contactId && 
    !remotes.some(r => r.name === c.name)
  ) || []

  async function inviteContact(c) {
    if (!currentRoomName) return
    try {
      await fetch(`${API_BASE}/call/invite`, {
        method: 'POST',
        headers: { 'x-api-key': API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ patientId: patient.patientId, contactId: c.contactId, roomName: currentRoomName })
      })
      setShowInvite(false)
    } catch (err) {
      console.error('Invite failed', err)
    }
  }

  // Responsive Grid Logic
  const num = remotes.length
  let gridClass = "w-full h-full "
  if (num <= 1) gridClass += "grid grid-cols-1 grid-rows-1"
  else if (num === 2) gridClass += "grid grid-cols-2 grid-rows-1"
  else if (num === 3 || num === 4) gridClass += "grid grid-cols-2 grid-rows-2"
  else gridClass += "flex flex-wrap"

  // ── Render ────────────────────────────────────────────────────
  return (
    <div className="absolute inset-0 bg-black flex flex-col overflow-hidden select-none">

      {/* Remote Video Grid */}
      {num > 0 ? (
        <div className={gridClass}>
          {remotes.map(p => <RemoteParticipant key={p.sid} participant={p} contacts={patient.contacts} />)}
        </div>
      ) : (
        <div className="absolute inset-0 flex flex-col items-center justify-center bg-gradient-to-b from-gray-900 to-gray-950">
          <ContactAvatar contact={contact} size="w-36 h-36" textSize="text-5xl" />
          <p className="text-white text-3xl font-semibold mt-6">{contact.name}</p>
          <p className="text-white/50 text-base mt-2">
            {phase === 'connecting' && 'Connecting…'}
            {phase === 'ringing'    && 'Calling…'}
            {phase === 'connected'  && (isVideo ? 'Camera off' : 'Voice call')}
            {phase === 'ended'      && 'Call ended'}
          </p>
          {phase === 'connected' && (
            <p className="text-white/30 text-sm mt-1 tabular-nums">{elapsedFmt}</p>
          )}
        </div>
      )}

      {/* Top bar — name + timer */}
      {(phase === 'connected' || phase === 'ringing') && (
        <div className="absolute top-0 inset-x-0 px-6 pt-10 pb-6 bg-gradient-to-b from-black/70 to-transparent pointer-events-none z-10">
          <div className="flex justify-between items-start">
            <p className="text-white text-xl font-semibold drop-shadow-md">
              {num > 0 ? remotes.map(r => r.name).join(', ') : contact.name}
            </p>
            {phase === 'connected' && (
              <p className="text-white/80 text-lg tabular-nums font-medium drop-shadow-md">{elapsedFmt}</p>
            )}
          </div>
          {phase === 'ringing' && (
            <p className="text-white/60 text-sm mt-0.5 drop-shadow-md">Calling…</p>
          )}
        </div>
      )}

      {/* PiP self-view — bottom-right */}
      {isVideo && (
        <div className="absolute bottom-40 right-5 w-28 h-44 rounded-2xl overflow-hidden border-2 border-white/20 shadow-2xl bg-gray-800 z-10">
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            className={`w-full h-full object-cover scale-x-[-1] transition-opacity duration-300 ${
              camOff ? 'opacity-0' : 'opacity-100'
            }`}
          />
          {camOff && (
            <div className="absolute inset-0 flex items-center justify-center bg-gray-800">
              <ContactAvatar contact={contact} size="w-12 h-12" textSize="text-lg" self />
            </div>
          )}
        </div>
      )}

      {/* Bottom controls */}
      <div className="absolute bottom-0 inset-x-0 pb-14 px-8 bg-gradient-to-t from-black/80 to-transparent">
        <div className="flex items-center justify-center gap-8">

          {/* Mic */}
          <ControlButton
            active={micMuted}
            onPress={toggleMic}
            label={micMuted ? 'Unmute' : 'Mute'}
            icon={micMuted ? <MicOffIcon /> : <MicIcon />}
          />

          {/* End call */}
          <button
            onClick={hangUp}
            className="w-20 h-20 rounded-full bg-red-500 active:bg-red-600 flex items-center justify-center shadow-2xl active:scale-90 transition-transform touch-manipulation"
          >
            <EndCallIcon />
          </button>

          {/* Camera (only for video calls) */}
          {isVideo ? (
            <ControlButton
              active={camOff}
              onPress={toggleCam}
              label={camOff ? 'Show cam' : 'Hide cam'}
              icon={camOff ? <CamOffIcon /> : <CamIcon />}
            />
          ) : (
            <div className="w-16 h-16" /> /* spacer to keep end-call centred */
          )}

            {/* Add Person */}
            {(phase === 'connected' || phase === 'ringing') && patient.contacts?.length > 1 && (
              <ControlButton
                active={showInvite}
                onPress={() => setShowInvite(true)}
                label="Add Person"
                icon={<AddPersonIcon />}
              />
            )}
        </div>
      </div>

      {/* Invite Modal Overlay */}
      {showInvite && (
        <div className="absolute inset-0 z-50 bg-black/80 backdrop-blur-sm flex flex-col items-center justify-start pt-24 px-8 select-none animate-fade-in">
          <h2 className="text-3xl text-white font-semibold mb-10">Add someone to this call</h2>
          <div className="flex flex-wrap justify-center gap-6 w-full max-w-3xl">
            {availableContacts.map(c => (
              <button
                key={c.contactId}
                onClick={() => inviteContact(c)}
                className="flex flex-col items-center gap-4 bg-white/10 p-6 rounded-3xl border border-white/20 active:scale-95 transition-transform w-44"
              >
                <ContactAvatar contact={c} size="w-20 h-20" textSize="text-3xl" />
                <span className="text-white text-lg font-medium text-center leading-tight truncate w-full">{c.name}</span>
              </button>
            ))}
            {availableContacts.length === 0 && (
              <p className="text-white/50 text-xl mt-10">No other family members available.</p>
            )}
          </div>
          <button
            onClick={() => setShowInvite(false)}
            className="mt-16 px-10 py-4 bg-white/20 text-white rounded-full text-xl font-medium active:bg-white/30 transition-colors touch-manipulation"
          >
            Cancel
          </button>
        </div>
      )}
    </div>
  )
}

// ── Sub-components ─────────────────────────────────────────────

function RemoteParticipant({ participant, contacts }) {
  const videoRef = useRef(null)
  const [hasVideo, setHasVideo] = useState(false)
  const contact = contacts?.find(c => c.name === participant.name)

  useEffect(() => {
    const updateVideo = () => {
      const pub = Array.from(participant.trackPublications.values()).find(p => p.kind === Track.Kind.Video)
      if (pub?.isSubscribed && pub.track) {
        setHasVideo(true)
        if (videoRef.current) pub.track.attach(videoRef.current)
      } else {
        setHasVideo(false)
      }
    }
    updateVideo()
    participant.on('trackSubscribed', updateVideo)
    participant.on('trackUnsubscribed', updateVideo)
    participant.on('trackMuted', updateVideo)
    participant.on('trackUnmuted', updateVideo)
    return () => {
      participant.off('trackSubscribed', updateVideo)
      participant.off('trackUnsubscribed', updateVideo)
      participant.off('trackMuted', updateVideo)
      participant.off('trackUnmuted', updateVideo)
    }
  }, [participant])

  return (
    <div className="relative w-full h-full bg-gray-900 border border-black flex items-center justify-center overflow-hidden">
      <video ref={videoRef} autoPlay playsInline muted className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-500 ${hasVideo ? 'opacity-100' : 'opacity-0'}`} />
      {!hasVideo && (
        <div className="flex flex-col items-center justify-center z-10">
          {contact?.profilePhotoUrl ? (
            <img src={contact.profilePhotoUrl} alt="" className="w-32 h-32 rounded-full object-cover shadow-xl border-4 border-white/20 mb-4" />
          ) : (
            <div className="w-24 h-24 rounded-full bg-blue-500 flex items-center justify-center text-4xl font-bold text-white mb-4 shadow-xl">
              {participant.name?.[0]?.toUpperCase() || '?'}
            </div>
          )}
        </div>
      )}
      <div className="absolute bottom-4 left-4 bg-black/60 px-3 py-1.5 rounded-lg backdrop-blur-md text-white text-sm font-medium z-20">
        {participant.name}
      </div>
    </div>
  )
}

function ControlButton({ active, onPress, label, icon }) {
  return (
    <button
      onClick={onPress}
      className={`flex flex-col items-center gap-1.5 touch-manipulation`}
    >
      <div className={`w-16 h-16 rounded-full flex items-center justify-center transition-colors active:scale-90 ${
        active ? 'bg-white' : 'bg-white/20'
      }`}>
        <span className={active ? 'text-black' : 'text-white'}>{icon}</span>
      </div>
      <span className="text-white/60 text-xs">{label}</span>
    </button>
  )
}

function ContactAvatar({ contact, size, textSize, self }) {
  const COLORS = ['bg-rose-500','bg-blue-500','bg-emerald-500','bg-violet-500','bg-amber-500']
  const color  = COLORS[contact.name?.charCodeAt(0) % COLORS.length] || 'bg-gray-500'
  return (
    <div className={`${size} rounded-full ${color} flex items-center justify-center overflow-hidden flex-shrink-0`}>
      {!self && contact.profilePhotoUrl ? (
        <img src={contact.profilePhotoUrl} alt={contact.name} className="w-full h-full object-cover" />
      ) : (
        <span className={`text-white font-bold ${textSize}`}>
          {contact.name?.[0]?.toUpperCase()}
        </span>
      )}
    </div>
  )
}

// ── Icons ──────────────────────────────────────────────────────

function MicIcon() {
  return (
    <svg className="w-7 h-7" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm5.91-3c-.49 0-.9.36-.98.85C16.52 14.2 14.47 16 12 16s-4.52-1.8-4.93-4.15c-.08-.49-.49-.85-.98-.85-.61 0-1.09.54-1 1.14.49 3 2.89 5.35 5.91 5.78V20c0 .55.45 1 1 1s1-.45 1-1v-2.08c3.02-.43 5.42-2.78 5.91-5.78.1-.6-.39-1.14-1-1.14z"/>
    </svg>
  )
}

function AddPersonIcon() {
  return (
    <svg className="w-7 h-7" viewBox="0 0 24 24" fill="currentColor">
      <path d="M15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm-9-2V7H4v3H1v2h3v3h2v-3h3v-2H6zm9 4c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
    </svg>
  )
}

function MicOffIcon() {
  return (
    <svg className="w-7 h-7" viewBox="0 0 24 24" fill="currentColor">
      <path d="M19 11h-1.7c0 .74-.16 1.43-.43 2.05l1.23 1.23c.56-.98.9-2.09.9-3.28zm-4.02.17c0-.06.02-.11.02-.17V5c0-1.66-1.34-3-3-3S9 3.34 9 5v.18l5.98 5.99zM4.27 3L3 4.27l6.01 6.01V11c0 1.66 1.34 3 3 3 .23 0 .44-.03.65-.08l1.66 1.66c-.71.33-1.5.52-2.31.52-2.76 0-5.3-2.1-5.3-5.1H5c0 3.41 2.72 6.23 6 6.72V20c0 .55.45 1 1 1s1-.45 1-1v-3.28c.91-.13 1.77-.45 2.54-.9L19.73 21 21 19.73 4.27 3z"/>
    </svg>
  )
}

function CamIcon() {
  return (
    <svg className="w-7 h-7" viewBox="0 0 24 24" fill="currentColor">
      <path d="M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z"/>
    </svg>
  )
}

function CamOffIcon() {
  return (
    <svg className="w-7 h-7" viewBox="0 0 24 24" fill="currentColor">
      <path d="M21 6.5l-4 4V7c0-.55-.45-1-1-1H9.82L21 17.18V6.5zM3.27 2L2 3.27 4.73 6H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.21 0 .39-.08.54-.18L19.73 21 21 19.73 3.27 2z"/>
    </svg>
  )
}

function EndCallIcon() {
  return (
    <svg className="w-9 h-9 text-white" viewBox="0 0 24 24" fill="currentColor">
      <path d="M6.6 10.8c1.4 2.8 3.8 5.1 6.6 6.6l2.2-2.2c.27-.27.68-.35 1.02-.18 1.12.45 2.35.68 3.58.68.55 0 1 .45 1 1V20c0 .55-.45 1-1 1C9.61 21 3 14.39 3 6c0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.12.32.03.7-.17.97L6.6 10.8z" transform="rotate(135 12 12)"/>
    </svg>
  )
}
