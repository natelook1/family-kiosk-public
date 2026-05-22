import { useState, useRef, useEffect } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { QRCodeSVG } from 'qrcode.react'
import {
  createContact, updateContact, deleteContact,
  uploadContactPhoto, generatePairingToken,
  getContactDevices, removeContactDevice,
} from '../api/contacts'
import { requestCallBack, cancelCallRequest } from '../api/patients'

const inputCls = 'w-full border dark:border-gray-600 rounded px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500'

const FAMILY_APP_URL = import.meta.env.VITE_FAMILY_APP_URL || 'https://family-call.looknet.ca'

// Must match AVATAR_COLORS in KioskScreen
const COLOR_OPTIONS = [
  { value: 'bg-rose-500',    label: 'Rose',    swatch: '#f43f5e' },
  { value: 'bg-blue-500',    label: 'Blue',    swatch: '#3b82f6' },
  { value: 'bg-emerald-500', label: 'Green',   swatch: '#10b981' },
  { value: 'bg-violet-500',  label: 'Violet',  swatch: '#8b5cf6' },
  { value: 'bg-amber-500',   label: 'Amber',   swatch: '#f59e0b' },
  { value: 'bg-teal-500',    label: 'Teal',    swatch: '#14b8a6' },
  { value: 'bg-pink-500',    label: 'Pink',    swatch: '#ec4899' },
  { value: 'bg-indigo-500',  label: 'Indigo',  swatch: '#6366f1' },
]

function ColorPicker({ value, onChange }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs text-gray-500 dark:text-gray-400">Avatar colour</p>
      <div className="flex items-center gap-2 flex-wrap">
        <button
          type="button"
          onClick={() => onChange('')}
          title="Auto (follows position)"
          className={`w-7 h-7 rounded-full border-2 flex items-center justify-center transition-all ${
            !value
              ? 'border-blue-500 scale-110'
              : 'border-gray-300 dark:border-gray-600 hover:border-gray-400'
          } bg-gradient-to-br from-gray-300 via-gray-400 to-gray-500`}
        >
          {!value && <span className="text-white text-xs font-bold">✓</span>}
        </button>
        {COLOR_OPTIONS.map(opt => (
          <button
            key={opt.value}
            type="button"
            onClick={() => onChange(opt.value)}
            title={opt.label}
            className={`w-7 h-7 rounded-full border-2 transition-all ${
              value === opt.value
                ? 'border-blue-500 scale-110'
                : 'border-transparent hover:border-gray-400'
            }`}
            style={{ backgroundColor: opt.swatch }}
          >
            {value === opt.value && <span className="text-white text-xs font-bold flex items-center justify-center w-full h-full">✓</span>}
          </button>
        ))}
      </div>
      <p className="text-xs text-gray-400 dark:text-gray-500">
        {value ? `Fixed colour — same on every kiosk` : 'Auto — rotates by contact position'}
      </p>
    </div>
  )
}

// ── Photo uploader ─────────────────────────────────────────────
function ContactPhotoUploader({ name, photoUrl, onChange }) {
  const fileRef                       = useRef(null)
  const [preview, setPreview]         = useState(photoUrl || '')
  const [uploading, setUploading]     = useState(false)
  const [uploadError, setUploadError] = useState('')

  async function handleFile(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    setUploadError('')
    try {
      const publicUrl = await uploadContactPhoto(file)
      setPreview(publicUrl)
      onChange(publicUrl)
    } catch (err) {
      setUploadError('Upload failed. Try again.')
      console.error(err)
    } finally {
      setUploading(false)
      e.target.value = ''
    }
  }

  return (
    <div className="flex items-center gap-3">
      <div className="w-14 h-14 rounded-full bg-gray-200 dark:bg-gray-600 overflow-hidden flex-shrink-0 flex items-center justify-center border dark:border-gray-500">
        {preview
          ? <img src={preview} alt="" className="w-full h-full object-cover" />
          : <span className="text-gray-500 dark:text-gray-300 text-lg font-semibold">{name?.[0]?.toUpperCase() || '?'}</span>
        }
      </div>
      <div className="space-y-1">
        <input type="file" accept="image/*" className="hidden" ref={fileRef} onChange={handleFile} />
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading}
            className="text-xs text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-50">
            {uploading ? 'Uploading…' : preview ? 'Change photo' : '+ Upload photo'}
          </button>
          {preview && !uploading && (
            <button type="button" onClick={() => { setPreview(''); onChange('') }}
              className="text-xs text-red-500 dark:text-red-400 hover:underline">
              Remove
            </button>
          )}
        </div>
        {uploadError && <p className="text-xs text-red-500">{uploadError}</p>}
        <p className="text-xs text-gray-400 dark:text-gray-500">JPG, PNG, HEIC — shown on the kiosk</p>
      </div>
    </div>
  )
}

// ── Contact form ───────────────────────────────────────────────
function ContactForm({ patientId, contact, onDone }) {
  const qc     = useQueryClient()
  const isEdit = !!contact
  const [form, setForm] = useState({
    name:            contact?.name            ?? '',
    profilePhotoUrl: contact?.profilePhotoUrl ?? '',
    color:           contact?.color           ?? '',
  })

  const mutation = useMutation({
    mutationFn: (data) =>
      isEdit ? updateContact(contact.contactId, data) : createContact(patientId, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['patient', patientId] }); onDone() },
  })

  return (
    <form onSubmit={(e) => { e.preventDefault(); mutation.mutate(form) }} className="space-y-4">
      <ContactPhotoUploader
        name={form.name}
        photoUrl={form.profilePhotoUrl}
        onChange={(url) => setForm(f => ({ ...f, profilePhotoUrl: url }))}
      />
      <input className={inputCls} placeholder="Name" value={form.name} required
        onChange={(e) => setForm(f => ({ ...f, name: e.target.value }))} />
      <ColorPicker
        value={form.color}
        onChange={(c) => setForm(f => ({ ...f, color: c }))}
      />
      <div className="flex gap-2">
        <button type="submit" disabled={mutation.isPending}
          className="bg-blue-600 text-white text-sm px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50">
          {mutation.isPending ? 'Saving…' : isEdit ? 'Update' : 'Add Contact'}
        </button>
        <button type="button" onClick={onDone}
          className="text-sm px-4 py-2 rounded border dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700">
          Cancel
        </button>
      </div>
      {mutation.isError && <p className="text-red-600 dark:text-red-400 text-sm">{mutation.error.message}</p>}
    </form>
  )
}

// ── Pairing panel ──────────────────────────────────────────────
function PairingPanel({ contact, onClose }) {
  const qc = useQueryClient()
  const [state, setState] = useState('idle') // idle | loading | ready | error
  const [token, setToken] = useState(null)
  const [expiresAt, setExpiresAt] = useState(null)
  const [devices, setDevices] = useState([])
  const [removing, setRemoving] = useState(null)

  useEffect(() => {
    getContactDevices(contact.contactId).then(d => setDevices(d.devices || []))
  }, [contact.contactId])

  async function removeDevice(deviceId) {
    setRemoving(deviceId)
    await removeContactDevice(contact.contactId, deviceId)
    setDevices(d => d.filter(x => x.deviceId !== deviceId))
    qc.invalidateQueries({ queryKey: ['patient'] })
    setRemoving(null)
  }

  const [qrMode, setQrMode] = useState('web') // 'web' | 'apk'
  const deepLink = token ? `familykiosk://pair?token=${token}` : null
  const webLink  = token ? `${FAMILY_APP_URL}?pair=${token}` : null
  const activeLink = qrMode === 'web' ? webLink : deepLink

  async function generate() {
    setState('loading')
    try {
      const data = await generatePairingToken(contact.contactId)
      setToken(data.token)
      setExpiresAt(data.expiresAt)
      setState('ready')
    } catch {
      setState('error')
    }
  }

  const minutesLeft = expiresAt
    ? Math.max(0, Math.round((expiresAt - Date.now()) / 60000))
    : 0

  return (
    <div className="border-t dark:border-gray-700 px-4 py-4 bg-blue-50 dark:bg-blue-900/20 space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm font-medium text-blue-800 dark:text-blue-200">
          Pair family device for {contact.name}
        </p>
        <button onClick={onClose} className="text-xs text-gray-500 dark:text-gray-400 hover:underline">
          Close
        </button>
      </div>

      {devices.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-blue-800 dark:text-blue-200">Paired devices</p>
          {devices.map(d => (
            <div key={d.deviceId} className="flex items-center justify-between text-xs text-gray-600 dark:text-gray-400 bg-white dark:bg-gray-700 rounded px-2 py-1.5">
              <span>{d.platform === 'web' ? '🌐 Browser' : '📱 Android'} · {new Date(d.registeredAt).toLocaleDateString()}</span>
              <button onClick={() => removeDevice(d.deviceId)} disabled={removing === d.deviceId}
                className="text-red-500 hover:text-red-700 disabled:opacity-50 ml-2">
                {removing === d.deviceId ? 'Removing…' : 'Remove'}
              </button>
            </div>
          ))}
        </div>
      )}

      {state === 'idle' && (
        <div className="space-y-2">
          <p className="text-xs text-blue-700 dark:text-blue-300">
            Generate a one-time code for the family member to scan or tap.
          </p>
          <button onClick={generate}
            className="text-sm bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded">
            Generate pairing code
          </button>
        </div>
      )}

      {state === 'loading' && (
        <p className="text-sm text-blue-700 dark:text-blue-300">Generating…</p>
      )}

      {state === 'error' && (
        <p className="text-sm text-red-600 dark:text-red-400">
          Failed to generate code. <button onClick={generate} className="underline">Try again</button>
        </p>
      )}

      {state === 'ready' && token && (
        <div className="space-y-3">
          {/* Toggle */}
          <div className="flex rounded-lg border dark:border-gray-600 overflow-hidden w-fit text-xs">
            {[['web', 'iPhone / Browser'], ['apk', 'Android App']].map(([mode, label]) => (
              <button key={mode} type="button" onClick={() => setQrMode(mode)}
                className={`px-3 py-1.5 transition-colors ${qrMode === mode ? 'bg-blue-600 text-white' : 'bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-600'}`}>
                {label}
              </button>
            ))}
          </div>
          {/* QR code */}
          <div className="flex gap-4 items-start">
            <div className="bg-white p-2 rounded-lg border dark:border-gray-600 flex-shrink-0">
              <QRCodeSVG value={activeLink} size={140} />
            </div>
            <div className="space-y-2 min-w-0">
              <p className="text-xs text-gray-500 dark:text-gray-400">Expires in ~{minutesLeft} min</p>
              <a href={activeLink} target="_blank" rel="noreferrer"
                className="inline-block text-xs bg-blue-100 dark:bg-blue-800 text-blue-700 dark:text-blue-200 px-3 py-1.5 rounded font-mono break-all">
                {activeLink}
              </a>
              {qrMode === 'apk' && (
                <div className="text-xs text-gray-500 dark:text-gray-400">
                  <span>Or enter code manually:</span>
                  <button
                    onClick={() => navigator.clipboard.writeText(token)}
                    className="ml-2 font-mono bg-gray-100 dark:bg-gray-700 px-2 py-0.5 rounded hover:bg-gray-200 dark:hover:bg-gray-600 transition-colors"
                    title="Click to copy"
                  >{token}</button>
                </div>
              )}
            </div>
          </div>
          <button onClick={generate} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">
            Generate new code
          </button>
        </div>
      )}
    </div>
  )
}

// ── Single contact row ─────────────────────────────────────────
function ContactRow({ contact, patientId, callRequests, onEdit, onDelete }) {
  const qc         = useQueryClient()
  const pending    = callRequests.filter(r => r.contactId === contact.contactId)
  const hasPending = pending.length > 0
  const [requesting, setRequesting] = useState(false)
  const [showPairing, setShowPairing] = useState(false)

  const callBackMutation = useMutation({
    mutationFn: () => requestCallBack(patientId, contact.contactId),
    onSuccess:  () => { qc.invalidateQueries({ queryKey: ['patient', patientId] }); setRequesting(false) },
  })

  const cancelMutation = useMutation({
    mutationFn: (requestId) => cancelCallRequest(requestId),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['patient', patientId] }),
  })

  return (
    <li className="border dark:border-gray-700 rounded-lg bg-white dark:bg-gray-800 overflow-hidden">
      {/* Main row */}
      <div className="flex items-center justify-between p-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-gray-200 dark:bg-gray-600 overflow-hidden flex-shrink-0 flex items-center justify-center">
            {contact.profilePhotoUrl
              ? <img src={contact.profilePhotoUrl} alt={contact.name} className="w-full h-full object-cover" />
              : <span className="text-gray-500 dark:text-gray-300 text-sm font-semibold">{contact.name[0]?.toUpperCase()}</span>
            }
          </div>
          <div>
            <div className="flex items-center gap-2">
              <p className="font-medium text-sm text-gray-900 dark:text-white">{contact.name}</p>
              {contact.color && (() => {
                const opt = COLOR_OPTIONS.find(o => o.value === contact.color)
                return opt ? (
                  <span
                    className="w-3 h-3 rounded-full flex-shrink-0"
                    style={{ backgroundColor: opt.swatch }}
                    title={opt.label}
                  />
                ) : null
              })()}
            </div>
            <p className="text-xs text-gray-400 dark:text-gray-500">
              {contact.deviceCount > 0
                ? `${contact.deviceCount} device${contact.deviceCount > 1 ? 's' : ''} paired`
                : 'No device paired'}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => { setShowPairing(p => !p); setRequesting(false) }}
            className="text-xs text-blue-500 dark:text-blue-400 hover:underline"
            title="Pair a family member's phone"
          >
            Pair device
          </button>
          {!requesting && !hasPending && (
            <button onClick={() => { setRequesting(true); setShowPairing(false) }}
              className="text-xs text-rose-500 dark:text-rose-400 hover:underline"
              title="Ask the kiosk to show a call-back request">
              Request call
            </button>
          )}
          <button onClick={onEdit}
            className="text-xs text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white">
            Edit
          </button>
          <button onClick={onDelete}
            className="text-xs text-red-500 hover:text-red-700 dark:hover:text-red-400">
            Remove
          </button>
        </div>
      </div>

      {/* Pairing panel */}
      {showPairing && (
        <PairingPanel contact={contact} onClose={() => setShowPairing(false)} />
      )}

      {/* Call-back confirm panel */}
      {requesting && (
        <div className="border-t dark:border-gray-700 px-3 py-2.5 bg-rose-50 dark:bg-rose-900/20 flex items-center justify-between gap-3">
          <p className="text-xs text-rose-700 dark:text-rose-300">
            Show <strong>{contact.name}</strong> a "call me back" notification on the kiosk?
          </p>
          <div className="flex gap-2 flex-shrink-0">
            <button onClick={() => callBackMutation.mutate()} disabled={callBackMutation.isPending}
              className="text-xs bg-rose-500 hover:bg-rose-600 text-white px-3 py-1 rounded disabled:opacity-50">
              {callBackMutation.isPending ? 'Sending…' : 'Send'}
            </button>
            <button onClick={() => setRequesting(false)}
              className="text-xs text-gray-500 dark:text-gray-400 hover:underline">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Pending requests banner */}
      {hasPending && (
        <div className="border-t dark:border-gray-700 px-3 py-2 bg-rose-50 dark:bg-rose-900/20 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="w-2 h-2 rounded-full bg-rose-500 animate-pulse inline-block" />
            <span className="text-xs text-rose-700 dark:text-rose-300 font-medium">
              Call-back request pending on kiosk
            </span>
          </div>
          <button onClick={() => pending.forEach(r => cancelMutation.mutate(r.requestId))}
            disabled={cancelMutation.isPending}
            className="text-xs text-gray-500 dark:text-gray-400 hover:underline disabled:opacity-50">
            Cancel
          </button>
        </div>
      )}
    </li>
  )
}

// ── ContactManager ─────────────────────────────────────────────
export default function ContactManager({ patientId, contacts, callRequests = [] }) {
  const qc      = useQueryClient()
  const [editing, setEditing] = useState(null)
  const [adding, setAdding]   = useState(false)

  const deleteMutation = useMutation({
    mutationFn: deleteContact,
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['patient', patientId] }),
  })

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium text-gray-900 dark:text-white">
          Contacts ({contacts.length}/10)
        </h2>
        {contacts.length < 10 && !adding && (
          <button onClick={() => setAdding(true)}
            className="text-sm text-blue-600 dark:text-blue-400 hover:underline">
            + Add contact
          </button>
        )}
      </div>

      {adding && (
        <div className="border dark:border-gray-700 rounded-lg p-4 bg-gray-50 dark:bg-gray-800">
          <ContactForm patientId={patientId} onDone={() => setAdding(false)} />
        </div>
      )}

      <ul className="space-y-2">
        {contacts.map((c) =>
          editing === c.contactId ? (
            <li key={c.contactId} className="border dark:border-gray-700 rounded-lg p-3 bg-white dark:bg-gray-800">
              <ContactForm patientId={patientId} contact={c} onDone={() => setEditing(null)} />
            </li>
          ) : (
            <ContactRow
              key={c.contactId}
              contact={c}
              patientId={patientId}
              callRequests={callRequests}
              onEdit={() => setEditing(c.contactId)}
              onDelete={() => { if (confirm(`Remove ${c.name}?`)) deleteMutation.mutate(c.contactId) }}
            />
          )
        )}
      </ul>
    </div>
  )
}
