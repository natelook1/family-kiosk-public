import { useState, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getPatient, updatePatient, uploadPatientAvatar } from '../api/patients'
import ContactManager from '../components/ContactManager'
import PhotoManager from '../components/PhotoManager'
import KioskSettings from '../components/KioskSettings'
import DeviceLogs from '../components/DeviceLogs'

const TABS = ['contacts', 'photos', 'settings', 'logs']

export default function PatientDetail() {
  const { patientId } = useParams()
  const navigate      = useNavigate()
  const qc            = useQueryClient()
  const [tab, setTab]                 = useState('contacts')
  const [editingName, setEditingName] = useState(false)
  const [nameInput, setNameInput]     = useState('')
  const [editingDevice, setEditingDevice] = useState(false)
  const [deviceInput, setDeviceInput] = useState('')
  const [avatarUploading, setAvatarUploading] = useState(false)
  const avatarInputRef = useRef(null)

  const { data: patient, isLoading, isError, error } = useQuery({
    queryKey: ['patient', patientId],
    queryFn:  () => getPatient(patientId),
  })

  const updateMutation = useMutation({
    mutationFn: (data) => updatePatient(patientId, data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['patient', patientId] })
      setEditingName(false)
    },
  })

  if (isLoading) return <p className="text-gray-500 dark:text-gray-400">Loading…</p>
  if (isError)   return <p className="text-red-600 dark:text-red-400">{error.message}</p>

  return (
    <div className="space-y-6">
      {/* ── Header ──────────────────────────────────────────────── */}
      <div className="flex items-start justify-between">
        <div>
          <button onClick={() => navigate('/')}
            className="text-sm text-gray-400 dark:text-gray-500 hover:text-gray-600 dark:hover:text-gray-300 mb-2 block">
            &larr; All patients
          </button>

          {/* Avatar */}
          <div className="flex items-center gap-3 mb-2">
            <input type="file" accept="image/*" className="hidden" ref={avatarInputRef}
              onChange={async (e) => {
                const file = e.target.files?.[0]
                if (!file) return
                setAvatarUploading(true)
                try {
                  const url = await uploadPatientAvatar(file)
                  await updateMutation.mutateAsync({ profilePhotoUrl: url })
                } catch { /* silent */ } finally {
                  setAvatarUploading(false)
                  e.target.value = ''
                }
              }}
            />
            <button
              onClick={() => avatarInputRef.current?.click()}
              disabled={avatarUploading}
              className="w-14 h-14 rounded-full overflow-hidden flex-shrink-0 border-2 border-dashed border-gray-300 dark:border-gray-600 hover:border-blue-400 transition-colors group relative"
              title={patient.profilePhotoUrl ? 'Change avatar' : 'Upload avatar'}
            >
              {patient.profilePhotoUrl
                ? <img src={patient.profilePhotoUrl} alt={patient.name} className="w-full h-full object-cover" />
                : <span className="w-full h-full flex items-center justify-center text-xl font-bold text-gray-400 dark:text-gray-500 bg-gray-100 dark:bg-gray-800">
                    {patient.name?.[0]?.toUpperCase() || '?'}
                  </span>
              }
              <span className="absolute inset-0 bg-black/40 hidden group-hover:flex items-center justify-center text-white text-xs rounded-full">
                {avatarUploading ? '…' : '✎'}
              </span>
            </button>
          </div>

          {editingName ? (
            <form onSubmit={(e) => { e.preventDefault(); updateMutation.mutate({ name: nameInput }) }}
              className="flex gap-2 items-center">
              <input
                className="border dark:border-gray-600 rounded px-2 py-1 text-lg font-semibold bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                value={nameInput}
                onChange={(e) => setNameInput(e.target.value)}
                autoFocus required
              />
              <button type="submit" disabled={updateMutation.isPending}
                className="text-sm text-blue-600 dark:text-blue-400 hover:underline">Save</button>
              <button type="button" onClick={() => setEditingName(false)}
                className="text-sm text-gray-400 dark:text-gray-500 hover:underline">Cancel</button>
            </form>
          ) : (
            <h1
              className="text-2xl font-semibold text-gray-900 dark:text-white cursor-pointer hover:text-blue-600 dark:hover:text-blue-400"
              onClick={() => { setNameInput(patient.name); setEditingName(true) }}
              title="Click to rename"
            >
              {patient.name}
            </h1>
          )}

          <div className="flex items-center gap-2 mt-1 flex-wrap">
            {editingDevice ? (
              <form onSubmit={(e) => { e.preventDefault(); updateMutation.mutate({ deviceId: deviceInput.trim().toUpperCase() || null }); setEditingDevice(false) }}
                className="flex items-center gap-2">
                <input
                  className="border dark:border-gray-600 rounded px-2 py-0.5 text-xs font-mono bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-1 focus:ring-blue-500 w-36 uppercase"
                  value={deviceInput}
                  onChange={(e) => setDeviceInput(e.target.value.toUpperCase())}
                  placeholder="TABLET-001" autoFocus
                />
                <button type="submit" className="text-xs text-blue-600 dark:text-blue-400 hover:underline">Save</button>
                <button type="button" onClick={() => setEditingDevice(false)} className="text-xs text-gray-400 hover:underline">Cancel</button>
              </form>
            ) : (
              <button
                onClick={() => { setDeviceInput(patient.deviceId || ''); setEditingDevice(true) }}
                className="text-xs text-gray-400 dark:text-gray-500 hover:text-blue-600 dark:hover:text-blue-400 transition-colors"
                title="Click to pair a tablet"
              >
                {patient.deviceId
                  ? <>Tablet: <span className="font-mono">{patient.deviceId}</span> &middot; <span className="text-blue-500">change</span></>
                  : '+ Pair tablet'}
              </button>
            )}
            <span className="text-gray-300 dark:text-gray-600 text-xs">&middot;</span>
            <span className={`text-xs ${patient.status === 'active' ? 'text-green-600 dark:text-green-400' : 'text-gray-400 dark:text-gray-500'}`}>
              {patient.status}
            </span>

            {/* Live call-request badge */}
            {(patient.callRequests?.length ?? 0) > 0 && (
              <>
                <span className="text-gray-300 dark:text-gray-600 text-xs">&middot;</span>
                <button
                  onClick={() => setTab('contacts')}
                  className="flex items-center gap-1 text-xs text-rose-500 dark:text-rose-400"
                >
                  <span className="w-1.5 h-1.5 rounded-full bg-rose-500 animate-pulse inline-block" />
                  {patient.callRequests.length} pending call request{patient.callRequests.length !== 1 ? 's' : ''}
                </button>
              </>
            )}
          </div>
        </div>

        <button
          onClick={() => updateMutation.mutate({ status: patient.status === 'active' ? 'inactive' : 'active' })}
          className="text-sm border dark:border-gray-600 rounded px-3 py-1.5 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
        >
          Mark {patient.status === 'active' ? 'inactive' : 'active'}
        </button>
      </div>

      {/* ── Tabs ────────────────────────────────────────────────── */}
      <div className="border-b border-gray-200 dark:border-gray-700 flex gap-6">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`pb-2 text-sm font-medium capitalize border-b-2 transition-colors ${
              tab === t
                ? 'border-blue-600 text-blue-600 dark:text-blue-400 dark:border-blue-400'
                : 'border-transparent text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-gray-200'
            }`}
          >
            {t}
            {t === 'contacts' && (patient.callRequests?.length ?? 0) > 0 && (
              <span className="ml-1.5 inline-flex items-center justify-center w-4 h-4 rounded-full bg-rose-500 text-white text-[10px] font-bold">
                {patient.callRequests.length}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── Tab content ─────────────────────────────────────────── */}
      {tab === 'contacts' && (
        <ContactManager
          patientId={patientId}
          contacts={patient.contacts ?? []}
          callRequests={patient.callRequests ?? []}
        />
      )}
      {tab === 'photos' && (
        <PhotoManager patientId={patientId} photos={patient.photos ?? []} />
      )}
      {tab === 'settings' && (
        <KioskSettings patientId={patientId} deviceId={patient.deviceId} />
      )}
      {tab === 'logs' && (
        <DeviceLogs deviceId={patient.deviceId} />
      )}
    </div>
  )
}
