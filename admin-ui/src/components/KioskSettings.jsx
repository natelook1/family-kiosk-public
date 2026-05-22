import { useState, useEffect, useRef } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getKioskSettings, updateKioskSettings, sendTabletCommand, getDeviceStorage } from '../api/patients'
import { getApkLatest, getApkUploadUrl, recordApkRelease } from '../api/apk'
import { getFamilyApkLatest, getFamilyApkUploadUrl, recordFamilyApkRelease, pushFamilyApkUpdate } from '../api/familyApk'

// ── Shared UI primitives ──────────────────────────────────────────

function SliderRow({ label, hint, value, onChange, min, max, step = 1, unit = '' }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <div>
          <span className="text-sm font-medium text-gray-800 dark:text-gray-200">{label}</span>
          {hint && <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">{hint}</p>}
        </div>
        <span className="text-sm font-mono text-gray-700 dark:text-gray-300 min-w-[3rem] text-right">
          {value}{unit}
        </span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-blue-500"
      />
    </div>
  )
}

function TimeSelect({ label, value, onChange }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-gray-700 dark:text-gray-300">{label}</span>
      <select
        value={value} onChange={(e) => onChange(Number(e.target.value))}
        className="text-sm border dark:border-gray-600 rounded px-2 py-1 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
      >
        {Array.from({ length: 24 }, (_, h) => (
          <option key={h} value={h}>
            {String(h).padStart(2, '0')}:00 ({h === 0 ? 'midnight' : h < 12 ? `${h}am` : h === 12 ? 'noon' : `${h - 12}pm`})
          </option>
        ))}
      </select>
    </div>
  )
}

// ── Device health helpers ─────────────────────────────────────────

function fmtBytes(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)} GB`
  if (n >= 1e6) return `${(n / 1e6).toFixed(0)} MB`
  return `${(n / 1e3).toFixed(0)} KB`
}

function fmtUptime(ms) {
  const s = Math.floor(ms / 1000)
  const d = Math.floor(s / 86400)
  const h = Math.floor((s % 86400) / 3600)
  const m = Math.floor((s % 3600) / 60)
  if (d > 0) return `${d}d ${h}h`
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}

function WifiDots({ signal }) {
  return (
    <span className="font-mono text-xs">
      {[0,1,2,3,4].map(i => (
        <span key={i} className={i <= signal ? 'text-green-500' : 'text-gray-300 dark:text-gray-600'}>●</span>
      ))}
    </span>
  )
}

function StorageBar({ freeBytes, cacheBytes, totalBytes }) {
  const hasTotal = totalBytes > 0
  const usedBytes = hasTotal ? totalBytes - freeBytes : 0
  const otherBytes = Math.max(0, usedBytes - cacheBytes)

  const cachePct  = hasTotal ? (cacheBytes  / totalBytes) * 100 : 0
  const otherPct  = hasTotal ? (otherBytes  / totalBytes) * 100 : 0
  const freePct   = hasTotal ? (freeBytes   / totalBytes) * 100 : 100

  const freeColor = freeBytes < 100e6 ? 'text-red-500' : freeBytes < 500e6 ? 'text-yellow-500' : 'text-gray-800 dark:text-gray-200'

  return (
    <div className="space-y-1 w-full">
      {hasTotal && (
        <div className="flex h-2 w-full rounded-full overflow-hidden bg-gray-100 dark:bg-gray-700">
          <div className="bg-gray-400 dark:bg-gray-500 transition-all" style={{ width: `${otherPct}%` }} />
          <div className="bg-blue-400 dark:bg-blue-500 transition-all"  style={{ width: `${cachePct}%` }} />
          <div className="bg-gray-100 dark:bg-gray-700 transition-all"  style={{ width: `${freePct}%` }} />
        </div>
      )}
      <div className="flex items-center gap-2 text-xs">
        <span className={freeColor}>{fmtBytes(freeBytes)} free</span>
        {hasTotal && <span className="text-gray-400 dark:text-gray-500">of {fmtBytes(totalBytes)}</span>}
      </div>
      {hasTotal && (
        <div className="flex items-center gap-3 text-xs text-gray-400 dark:text-gray-500">
          <span><span className="inline-block w-2 h-2 rounded-sm bg-blue-400 dark:bg-blue-500 mr-1" />Photos {fmtBytes(cacheBytes)}</span>
          <span><span className="inline-block w-2 h-2 rounded-sm bg-gray-400 dark:bg-gray-500 mr-1" />Other {fmtBytes(otherBytes)}</span>
        </div>
      )}
    </div>
  )
}

function MemoryBar({ ramUsedBytes, ramTotalBytes, ramLowMemory }) {
  if (!ramTotalBytes) return <span className="text-gray-400 dark:text-gray-500">—</span>
  const usedPct = Math.min(100, (ramUsedBytes / ramTotalBytes) * 100)
  const freePct = 100 - usedPct
  const isHigh  = usedPct > 85
  const isMed   = usedPct > 65
  const barColor = ramLowMemory || isHigh ? 'bg-red-400 dark:bg-red-500'
                 : isMed                  ? 'bg-yellow-400 dark:bg-yellow-500'
                 :                          'bg-violet-400 dark:bg-violet-500'
  const freeColor = ramLowMemory || isHigh ? 'text-red-500'
                  : isMed                  ? 'text-yellow-500'
                  :                          'text-gray-800 dark:text-gray-200'
  return (
    <div className="space-y-1 w-full">
      <div className="flex h-2 w-full rounded-full overflow-hidden bg-gray-100 dark:bg-gray-700">
        <div className={`${barColor} transition-all`} style={{ width: `${usedPct}%` }} />
        <div className="bg-gray-100 dark:bg-gray-700 transition-all" style={{ width: `${freePct}%` }} />
      </div>
      <div className="flex items-center gap-2 text-xs">
        <span className={freeColor}>{fmtBytes(ramTotalBytes - ramUsedBytes)} free</span>
        <span className="text-gray-400 dark:text-gray-500">of {fmtBytes(ramTotalBytes)}</span>
        {ramLowMemory && <span className="text-red-500 font-semibold">low memory!</span>}
      </div>
    </div>
  )
}

// ── APK upload helpers ────────────────────────────────────────────

async function sha256hex(file) {
  const buf    = await file.arrayBuffer()
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('')
}

// ── Sub-tab nav ───────────────────────────────────────────────────

function SubTabs({ tabs, active, onChange }) {
  return (
    <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-lg p-1 mb-6">
      {tabs.map(({ id, label }) => (
        <button
          key={id}
          onClick={() => onChange(id)}
          className={`flex-1 text-xs font-medium py-1.5 px-2 rounded-md transition-colors ${
            active === id
              ? 'bg-white dark:bg-gray-700 text-gray-900 dark:text-white shadow-sm'
              : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300'
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────

export default function KioskSettings({ patientId, deviceId }) {
  const qc = useQueryClient()

  const { data: saved, isLoading } = useQuery({
    queryKey: ['kiosk-settings', patientId],
    queryFn:  () => getKioskSettings(patientId),
  })

  const { data: health } = useQuery({
    queryKey:  ['device-storage', deviceId],
    queryFn:   () => deviceId ? getDeviceStorage(deviceId) : null,
    enabled:   !!deviceId,
    refetchInterval: 60_000,
  })

  const { data: apkInfo, refetch: refetchApk } = useQuery({
    queryKey: ['apk-latest'],
    queryFn:  getApkLatest,
  })

  const { data: familyApkInfo, refetch: refetchFamilyApk } = useQuery({
    queryKey: ['family-apk-latest'],
    queryFn:  getFamilyApkLatest,
  })

  const [form, setForm] = useState(null)
  useEffect(() => { if (saved && !form) setForm(saved) }, [saved])

  // Sub-tab state — default to 'status' if device is known, else 'settings'
  const [subTab, setSubTab] = useState(deviceId ? 'status' : 'settings')

  // WiFi form state
  const [wifi, setWifi] = useState({ ssid: '', password: '', security: 'WPA' })

  // Kiosk APK upload state
  const [apkFile, setApkFile]           = useState(null)
  const [apkSha, setApkSha]             = useState('')
  const [apkStatus, setApkStatus]       = useState('')
  const [apkUploading, setApkUploading] = useState(false)
  const apkInputRef = useRef()

  // Family APK upload state
  const [famFile, setFamFile]           = useState(null)
  const [famSha, setFamSha]             = useState('')
  const [famStatus, setFamStatus]       = useState('')
  const [famUploading, setFamUploading] = useState(false)
  const famInputRef = useRef()

  const pushUpdateMutation = useMutation({
    mutationFn: pushFamilyApkUpdate,
  })

  // PIN show/hide
  const [showPin, setShowPin] = useState(false)

  const saveMutation = useMutation({
    mutationFn: (data) => updateKioskSettings(patientId, data),
    onSuccess:  (data) => {
      qc.invalidateQueries({ queryKey: ['kiosk-settings', patientId] })
      qc.invalidateQueries({ queryKey: ['patient', patientId] })
      setForm(data)
    },
  })

  const commandMutation = useMutation({
    mutationFn: ({ command }) => sendTabletCommand(deviceId, command),
  })

  const wifiMutation = useMutation({
    mutationFn: () => sendTabletCommand(deviceId, {
      type: 'wifi-add', ssid: wifi.ssid, password: wifi.password, security: wifi.security,
    }),
    onSuccess: () => setWifi(w => ({ ...w, password: '' })),
  })

  const wakeMutation = useMutation({
    mutationFn: async () => {
      const apiBase = import.meta.env.VITE_API_BASE || '/webhook'
      const apiKey  = import.meta.env.VITE_API_KEY  || 'devkey'
      const res = await fetch(`${apiBase}/admin/tablet/${deviceId}/wake`, {
        method: 'POST',
        headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' }
      })
      if (!res.ok) throw new Error('Failed to wake tablet')
      return res.json()
    }
  })

  if (isLoading || !form) return <p className="text-sm text-gray-400 dark:text-gray-500">Loading…</p>

  const set = (key) => (val) => setForm(f => ({ ...f, [key]: val }))
  const isDirty = JSON.stringify(form) !== JSON.stringify(saved)
  const isOnline = health?.reportedAt && (Date.now() - health.reportedAt) < 10 * 60 * 1000

  async function handleApkSelect(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setApkFile(file)
    setApkStatus('Computing SHA-256…')
    const hash = await sha256hex(file)
    setApkSha(hash)
    setApkStatus(`SHA-256: ${hash.slice(0, 16)}…`)
  }

  async function handleApkUpload() {
    if (!apkFile || !apkSha) return
    const version = apkInfo?.version ? apkInfo.version + 1 : 2
    setApkUploading(true)
    setApkStatus('Getting upload URL…')
    try {
      const { uploadUrl, publicUrl } = await getApkUploadUrl(version)
      setApkStatus('Uploading…')
      const res = await fetch(uploadUrl, {
        method: 'PUT',
        body:   apkFile,
        headers: { 'Content-Type': 'application/vnd.android.package-archive' },
      })
      if (!res.ok) throw new Error(`Upload failed (${res.status})`)
      setApkStatus('Recording release…')
      await recordApkRelease({ version, url: publicUrl, sha256: apkSha })
      setApkStatus(`v${version} released successfully`)
      setApkFile(null)
      setApkSha('')
      refetchApk()
    } catch (err) {
      setApkStatus(`Error: ${err.message}`)
    } finally {
      setApkUploading(false)
    }
  }

  async function handleFamApkSelect(e) {
    const file = e.target.files?.[0]
    if (!file) return
    setFamFile(file)
    setFamStatus('Computing SHA-256…')
    const hash = await sha256hex(file)
    setFamSha(hash)
    setFamStatus(`SHA-256: ${hash.slice(0, 16)}…`)
  }

  async function handleFamApkUpload() {
    if (!famFile || !famSha) return
    const version = familyApkInfo?.version ? familyApkInfo.version + 1 : 2
    setFamUploading(true)
    setFamStatus('Getting upload URL…')
    try {
      const { uploadUrl, publicUrl } = await getFamilyApkUploadUrl(version)
      setFamStatus('Uploading…')
      const res = await fetch(uploadUrl, {
        method: 'PUT',
        body:   famFile,
        headers: { 'Content-Type': 'application/vnd.android.package-archive' },
      })
      if (!res.ok) throw new Error(`Upload failed (${res.status})`)
      setFamStatus('Recording release…')
      await recordFamilyApkRelease({ version, url: publicUrl, sha256: famSha })
      setFamStatus(`v${version} released successfully`)
      setFamFile(null)
      setFamSha('')
      refetchFamilyApk()
    } catch (err) {
      setFamStatus(`Error: ${err.message}`)
    } finally {
      setFamUploading(false)
    }
  }

  const subTabs = [
    ...(deviceId ? [{ id: 'status', label: 'Status' }] : []),
    { id: 'settings', label: 'Settings' },
    ...(deviceId ? [{ id: 'remote', label: 'Remote' }] : []),
    { id: 'updates', label: 'Updates' },
  ]

  return (
    <div className="max-w-lg">
      <SubTabs tabs={subTabs} active={subTab} onChange={setSubTab} />

      {/* ── STATUS tab ────────────────────────────────────────────── */}
      {subTab === 'status' && (
        <div className="space-y-6">
          {deviceId && health ? (
            <section className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Device Status
                </h3>
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                  isOnline ? 'bg-green-100 text-green-700 dark:bg-green-900/40 dark:text-green-400'
                           : 'bg-red-100 text-red-700 dark:bg-red-900/40 dark:text-red-400'
                }`}>
                  {isOnline ? '● Online' : '● Offline'}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
                <div className="text-gray-500 dark:text-gray-400">Battery</div>
                <div className="font-medium text-gray-800 dark:text-gray-200">
                  {health.batteryLevel >= 0 ? `${health.batteryLevel}%${health.batteryCharging ? ' ⚡' : ''}` : '—'}
                </div>

                <div className="text-gray-500 dark:text-gray-400">Kiosk lock</div>
                <div className={`font-medium ${health.lockTaskActive ? 'text-green-600 dark:text-green-400' : 'text-red-500'}`}>
                  {health.lockTaskActive ? 'Locked' : 'Not locked ⚠'}
                </div>

                <div className="text-gray-500 dark:text-gray-400">Uptime</div>
                <div className="font-medium text-gray-800 dark:text-gray-200">
                  {health.uptimeMs > 0 ? fmtUptime(health.uptimeMs) : '—'}
                </div>

                <div className="text-gray-500 dark:text-gray-400">WiFi</div>
                <div className="font-medium text-gray-800 dark:text-gray-200 flex items-center gap-1.5">
                  {health.wifiConnected
                    ? <><span>{health.wifiSsid || 'Connected'}</span><WifiDots signal={health.wifiSignal} /></>
                    : <span className="text-red-500">Disconnected</span>
                  }
                </div>

                <div className="text-gray-500 dark:text-gray-400">Storage</div>
                <div className="font-medium text-gray-800 dark:text-gray-200">
                  <StorageBar
                    freeBytes={health.freeBytes}
                    cacheBytes={health.cacheBytes}
                    totalBytes={health.totalBytes}
                  />
                </div>

                <div className="text-gray-500 dark:text-gray-400">RAM</div>
                <div className="font-medium text-gray-800 dark:text-gray-200">
                  <MemoryBar
                    ramUsedBytes={health.ramUsedBytes}
                    ramTotalBytes={health.ramTotalBytes}
                    ramLowMemory={health.ramLowMemory}
                  />
                </div>

                <div className="text-gray-500 dark:text-gray-400">Photo cache</div>
                <div className="font-medium text-gray-800 dark:text-gray-200">
                  {health.cachedPhotoCount} photos · {fmtBytes(health.cacheBytes)}
                </div>

                <div className="text-gray-500 dark:text-gray-400">APK version</div>
                <div className={`font-medium font-mono ${
                  !health?.apkVersion ? 'text-gray-400 dark:text-gray-500'
                  : health.apkVersion < apkInfo?.version ? 'text-amber-500'
                  : 'text-green-600 dark:text-green-400'
                }`}>
                  {health?.apkVersion > 0 ? `v${health.apkVersion}` : '—'}
                  {health?.apkVersion > 0 && apkInfo?.version > 0 && (
                    <span className="ml-2 text-xs font-sans">
                      {health.apkVersion < apkInfo.version
                        ? <span className="text-amber-500">update pending</span>
                        : <span className="text-green-600 dark:text-green-400">up to date</span>
                      }
                    </span>
                  )}
                </div>

                <div className="text-gray-500 dark:text-gray-400">Last reported</div>
                <div className="text-gray-700 dark:text-gray-300">
                  {health.reportedAt ? new Date(health.reportedAt).toLocaleTimeString() : '—'}
                </div>
              </div>
            </section>
          ) : (
            <p className="text-sm text-gray-400 dark:text-gray-500">
              {deviceId ? 'Waiting for tablet to report in…' : 'No tablet paired to this patient.'}
            </p>
          )}
        </div>
      )}

      {/* ── SETTINGS tab ──────────────────────────────────────────── */}
      {subTab === 'settings' && (
        <div className="space-y-8">

          {/* Accessibility */}
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Accessibility
            </h3>
            <div className="flex items-center justify-between">
              <div>
                <span className="text-sm font-medium text-gray-800 dark:text-gray-200">Easy-call mode</span>
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                  Replaces contact strip with a large "Video Call" button. Pressing it opens a full-screen contact picker — designed for elderly or infirm users.
                </p>
              </div>
              <label className="flex items-center gap-2 cursor-pointer ml-4 flex-shrink-0">
                <span className="text-xs text-gray-500 dark:text-gray-400">{form.accessibilityMode ? 'On' : 'Off'}</span>
                <button type="button" onClick={() => set('accessibilityMode')(!form.accessibilityMode)}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                    form.accessibilityMode ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'
                  }`}
                >
                  <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
                    form.accessibilityMode ? 'translate-x-4' : 'translate-x-1'
                  }`} />
                </button>
              </label>
            </div>
          </section>

          {/* Ringtone */}
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Ringtone
            </h3>
            <select
              value={form.ringtone ?? 'digital'}
              onChange={(e) => set('ringtone')(e.target.value)}
              className="w-full text-sm border dark:border-gray-600 rounded px-2 py-1.5 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="digital">Digital — Two short beeps</option>
              <option value="classic">Classic — Old telephone ring</option>
              <option value="gentle">Gentle — Soft chime</option>
              {health?.ringtones?.length > 0 && (
                <optgroup label="Device ringtones">
                  {health.ringtones.map(({ name, uri }) => (
                    <option key={uri} value={uri}>{name}</option>
                  ))}
                </optgroup>
              )}
            </select>
            {!health?.ringtones?.length && (
              <p className="text-xs text-gray-400 dark:text-gray-500 italic">
                Sync the tablet to load device ringtones
              </p>
            )}
          </section>

          {/* Audio */}
          <section className="space-y-4">
            <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Audio
            </h3>
            <SliderRow
              label="Ring volume" hint="Applies to ring, call, and media streams"
              value={form.ringVolume ?? 80} onChange={set('ringVolume')}
              min={0} max={100} unit="%"
            />
          </section>

          {/* Display */}
          <section className="space-y-4">
            <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Display
            </h3>
            <div className="flex items-center justify-between">
              <div>
                <span className="text-sm font-medium text-gray-800 dark:text-gray-200">Screen timeout</span>
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">Time before screen locks · 0 = never</p>
              </div>
              <select value={form.screenTimeoutMs ?? 60000} onChange={(e) => set('screenTimeoutMs')(Number(e.target.value))}
                className="text-sm border dark:border-gray-600 rounded px-2 py-1 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value={0}>Never</option>
                <option value={15000}>15 s</option>
                <option value={30000}>30 s</option>
                <option value={60000}>1 min</option>
                <option value={120000}>2 min</option>
                <option value={300000}>5 min</option>
                <option value={600000}>10 min</option>
              </select>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <span className="text-sm font-medium text-gray-800 dark:text-gray-200">Text size</span>
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">Scales all text in the kiosk app</p>
              </div>
              <select value={form.fontScale ?? 1.0} onChange={(e) => set('fontScale')(Number(e.target.value))}
                className="text-sm border dark:border-gray-600 rounded px-2 py-1 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value={0.9}>Small</option>
                <option value={1.0}>Normal</option>
                <option value={1.25}>Large</option>
                <option value={1.5}>Larger</option>
                <option value={2.0}>Largest</option>
              </select>
            </div>
            <div className="flex items-center justify-between">
              <div>
                <span className="text-sm font-medium text-gray-800 dark:text-gray-200">Orientation</span>
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">Screen rotation lock</p>
              </div>
              <div className="flex gap-2">
                {['landscape', 'portrait', 'auto'].map(o => (
                  <button key={o} type="button"
                    onClick={() => set('orientation')(o)}
                    className={`text-xs px-3 py-1.5 rounded border transition-colors ${
                      (form.orientation ?? 'landscape') === o
                        ? 'bg-blue-600 border-blue-600 text-white'
                        : 'border-gray-300 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:border-blue-400'
                    }`}>
                    {o.charAt(0).toUpperCase() + o.slice(1)}
                  </button>
                ))}
              </div>
            </div>
          </section>

          {/* System */}
          <section className="space-y-4">
            <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              System
            </h3>
            <div className="flex items-center justify-between">
              <div>
                <span className="text-sm font-medium text-gray-800 dark:text-gray-200">Timezone</span>
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                  Affects night mode · leave blank to keep device default
                  {health?.timezone ? ` · currently ${health.timezone}` : ''}
                </p>
              </div>
              <select value={form.timezone ?? ''} onChange={(e) => set('timezone')(e.target.value)}
                className="text-sm border dark:border-gray-600 rounded px-2 py-1 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="">Device default</option>
                <optgroup label="Canada">
                  <option value="America/Vancouver">Pacific — Vancouver</option>
                  <option value="America/Edmonton">Mountain — Edmonton</option>
                  <option value="America/Winnipeg">Central — Winnipeg</option>
                  <option value="America/Toronto">Eastern — Toronto</option>
                  <option value="America/Halifax">Atlantic — Halifax</option>
                  <option value="America/St_Johns">Newfoundland — St. John's</option>
                </optgroup>
                <optgroup label="United States">
                  <option value="America/Los_Angeles">Pacific — Los Angeles</option>
                  <option value="America/Denver">Mountain — Denver</option>
                  <option value="America/Chicago">Central — Chicago</option>
                  <option value="America/New_York">Eastern — New York</option>
                  <option value="America/Phoenix">Arizona (no DST)</option>
                  <option value="Pacific/Honolulu">Hawaii</option>
                  <option value="America/Anchorage">Alaska</option>
                </optgroup>
                <optgroup label="Other">
                  <option value="UTC">UTC</option>
                  <option value="Europe/London">London</option>
                  <option value="Europe/Paris">Paris / Berlin</option>
                </optgroup>
              </select>
            </div>
          </section>

          {/* Bluetooth */}
          <section className="space-y-3">
            <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Bluetooth headset
            </h3>
            <p className="text-xs text-gray-400 dark:text-gray-500">
              Set a preferred device and the tablet will route call audio through it automatically.
              {health?.btConnected && health?.btDeviceName
                ? ` Currently connected: ${health.btDeviceName}.`
                : !health?.btDevices?.length ? ' Pair a headset on the tablet first.' : ''}
            </p>
            {(health?.btDevices?.length > 0) ? (
              <div className="flex flex-col gap-2">
                <label className="flex items-center gap-3 cursor-pointer">
                  <input type="radio" name="btDevice" value=""
                    checked={!(form.btDeviceAddress)}
                    onChange={() => set('btDeviceAddress')('')}
                    className="accent-blue-600" />
                  <span className="text-sm text-gray-800 dark:text-gray-200">None (speakerphone)</span>
                </label>
                {health.btDevices.map(({ name, address, connected }) => (
                  <label key={address} className="flex items-center gap-3 cursor-pointer">
                    <input type="radio" name="btDevice" value={address}
                      checked={(form.btDeviceAddress ?? '') === address}
                      onChange={() => set('btDeviceAddress')(address)}
                      className="accent-blue-600" />
                    <span className="text-sm text-gray-800 dark:text-gray-200">{name}</span>
                    {connected && <span className="text-xs text-green-500">connected</span>}
                  </label>
                ))}
              </div>
            ) : (
              <p className="text-xs text-gray-400 dark:text-gray-500 italic">
                No paired Bluetooth devices reported yet
              </p>
            )}
          </section>

          {/* Device (PIN, daily restart) */}
          <section className="space-y-4">
            <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Device
            </h3>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <div>
                  <span className="text-sm font-medium text-gray-800 dark:text-gray-200">Staff unlock PIN</span>
                  <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">4–8 digits · delivered on next sync</p>
                </div>
              </div>
              <div className="flex gap-2">
                <input
                  type={showPin ? 'text' : 'password'}
                  value={form.unlockPin ?? '1234'}
                  onChange={(e) => {
                    const v = e.target.value.replace(/\D/g, '').slice(0, 8)
                    set('unlockPin')(v)
                  }}
                  placeholder="1234"
                  className="w-32 text-sm border dark:border-gray-600 rounded px-3 py-1.5 bg-white dark:bg-gray-700 text-gray-900 dark:text-white font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <button
                  onClick={() => setShowPin(s => !s)}
                  className="text-xs text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
                >
                  {showPin ? 'Hide' : 'Show'}
                </button>
              </div>
              {form.unlockPin && (form.unlockPin.length < 4 || !/^\d+$/.test(form.unlockPin)) && (
                <p className="text-xs text-red-500">Must be 4–8 digits</p>
              )}
            </div>

            <div className="flex items-center justify-between">
              <div>
                <span className="text-sm font-medium text-gray-800 dark:text-gray-200">Daily restart (UTC)</span>
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">Restarts app at this hour each night</p>
              </div>
              <select
                value={form.restartHour ?? -1}
                onChange={(e) => set('restartHour')(Number(e.target.value))}
                className="text-sm border dark:border-gray-600 rounded px-2 py-1 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value={-1}>Disabled</option>
                {Array.from({ length: 24 }, (_, h) => (
                  <option key={h} value={h}>
                    {String(h).padStart(2, '0')}:00 UTC
                  </option>
                ))}
              </select>
            </div>
          </section>

          {/* Slideshow */}
          <section className="space-y-4">
            <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Slideshow
            </h3>
            <SliderRow
              label="Photo duration" hint="How long each photo is shown"
              value={form.slideInterval} onChange={set('slideInterval')}
              min={4} max={20} unit="s"
            />
            <SliderRow
              label="Resume delay after a call" hint="Pause before slideshow restarts after hanging up"
              value={form.resumeDelay} onChange={set('resumeDelay')}
              min={0} max={15} unit="s"
            />
            <div className="flex items-center justify-between">
              <div>
                <span className="text-sm font-medium text-gray-800 dark:text-gray-200">Ken Burns effect</span>
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">Slow zoom and pan on photos</p>
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <span className="text-xs text-gray-500 dark:text-gray-400">{form.kenBurns ? 'On' : 'Off'}</span>
                <button type="button" onClick={() => set('kenBurns')(!form.kenBurns)}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                    form.kenBurns ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'
                  }`}
                >
                  <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
                    form.kenBurns ? 'translate-x-4' : 'translate-x-1'
                  }`} />
                </button>
              </label>
            </div>
          </section>

          {/* Night mode */}
          <section className="space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                Night Mode
              </h3>
              <label className="flex items-center gap-2 cursor-pointer">
                <span className="text-xs text-gray-500 dark:text-gray-400">{form.nightEnabled ? 'On' : 'Off'}</span>
                <button type="button" onClick={() => set('nightEnabled')(!form.nightEnabled)}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                    form.nightEnabled ? 'bg-blue-600' : 'bg-gray-300 dark:bg-gray-600'
                  }`}
                >
                  <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white shadow transition-transform ${
                    form.nightEnabled ? 'translate-x-4' : 'translate-x-1'
                  }`} />
                </button>
              </label>
            </div>
            {form.nightEnabled && (
              <>
                <TimeSelect label="Dim from" value={form.nightStart} onChange={set('nightStart')} />
                <TimeSelect label="Until"    value={form.nightEnd}   onChange={set('nightEnd')} />
                <SliderRow
                  label="Night brightness" hint="Screen brightness during night hours"
                  value={form.nightBrightness} onChange={set('nightBrightness')}
                  min={5} max={80} unit="%"
                />
              </>
            )}
          </section>

          {/* Save — sticky footer */}
          <div className="sticky bottom-0 z-10 flex items-center gap-3 py-3 px-1 bg-white dark:bg-gray-900 border-t dark:border-gray-700">
            <button
              onClick={() => saveMutation.mutate(form)}
              disabled={saveMutation.isPending || !isDirty}
              className="bg-blue-600 text-white text-sm px-5 py-2 rounded-lg hover:bg-blue-700 disabled:opacity-40 transition-colors"
            >
              {saveMutation.isPending ? 'Saving…' : 'Save settings'}
            </button>
            {isDirty && (
              <button onClick={() => setForm(saved)} className="text-sm text-gray-400 dark:text-gray-500 hover:underline">
                Reset
              </button>
            )}
            {saveMutation.isSuccess && !isDirty && (
              <span className="text-xs text-green-600 dark:text-green-400">Saved — takes effect on next sync</span>
            )}
          </div>
        </div>
      )}

      {/* ── REMOTE tab ────────────────────────────────────────────── */}
      {subTab === 'remote' && deviceId && (
        <div className="space-y-8">

          {/* Remote Control */}
          <section className="space-y-4">
            <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Remote Control
            </h3>
            <p className="text-xs text-gray-400 dark:text-gray-500">Commands execute on next sync (within 60 s).</p>

            <div className="flex gap-3 flex-wrap">
          <button onClick={() => wakeMutation.mutate()}
            disabled={wakeMutation.isPending}
            className="text-sm border border-blue-300 dark:border-blue-800 rounded-lg px-4 py-2 text-blue-700 dark:text-blue-400 bg-blue-50 dark:bg-blue-900/20 hover:bg-blue-100 dark:hover:bg-blue-900/40 font-semibold disabled:opacity-50 transition-colors">
            {wakeMutation.isPending ? 'Waking…' : 'Wake tablet'}
          </button>
              <button onClick={() => commandMutation.mutate({ command: 'reload' })}
                disabled={commandMutation.isPending}
                className="text-sm border dark:border-gray-600 rounded-lg px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 transition-colors">
                Reload app
              </button>
              <button onClick={() => commandMutation.mutate({ command: { type: 'restart' } })}
                disabled={commandMutation.isPending}
                className="text-sm border dark:border-gray-600 rounded-lg px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 transition-colors">
                Restart app
              </button>
              <button onClick={() => commandMutation.mutate({ command: { type: 'clear-cache' } })}
                disabled={commandMutation.isPending}
                className="text-sm border dark:border-gray-600 rounded-lg px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-50 transition-colors">
                Clear photo cache
              </button>
              <button
                onClick={() => { if (confirm('Clear device pairing and return to setup screen?')) commandMutation.mutate({ command: 'reset' }) }}
                disabled={commandMutation.isPending}
                className="text-sm border border-red-300 dark:border-red-800 rounded-lg px-4 py-2 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-50 transition-colors">
                Reset pairing
              </button>
              <button
                onClick={() => { if (confirm('FACTORY RESET this tablet? This will erase all data and cannot be undone.')) commandMutation.mutate({ command: { type: 'factory-reset' } }) }}
                disabled={commandMutation.isPending}
                className="text-sm border border-red-500 dark:border-red-600 rounded-lg px-4 py-2 text-red-700 dark:text-red-300 bg-red-50 dark:bg-red-900/20 hover:bg-red-100 dark:hover:bg-red-900/40 font-semibold disabled:opacity-50 transition-colors">
                Factory reset
              </button>
            </div>

            <div className="space-y-1.5">
              <BrightnessControl deviceId={deviceId} />
            </div>

            {commandMutation.isSuccess && <p className="text-xs text-green-600 dark:text-green-400">Command queued.</p>}
            {commandMutation.isError   && <p className="text-xs text-red-500">{commandMutation.error?.message}</p>}
        {wakeMutation.isSuccess && <p className="text-xs text-green-600 dark:text-green-400">Wake signal sent! Screen will turn on in ~3 seconds.</p>}
        {wakeMutation.isError   && <p className="text-xs text-red-500">{wakeMutation.error?.message}</p>}
          </section>

          {/* WiFi */}
          <section className="space-y-4 pt-2 border-t dark:border-gray-700">
            <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              WiFi Network
            </h3>

            {health && (
              <div className="flex items-center gap-2 text-sm">
                <span className="text-gray-500 dark:text-gray-400 w-24 shrink-0">Connected</span>
                {health.wifiConnected
                  ? <span className="font-medium text-gray-800 dark:text-gray-200 flex items-center gap-1.5">
                      {health.wifiSsid || 'Unknown'}<WifiDots signal={health.wifiSignal} />
                    </span>
                  : <span className="text-red-500 font-medium">Disconnected</span>
                }
              </div>
            )}

            {health?.wifiAvailable?.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  Available networks
                </p>
                <select
                  value={wifi.ssid}
                  onChange={(e) => {
                    const net = health.wifiAvailable.find(n => n.ssid === e.target.value)
                    setWifi(w => ({ ...w, ssid: e.target.value, security: net?.security || 'WPA' }))
                  }}
                  className="w-full text-sm border dark:border-gray-600 rounded px-2 py-1.5 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Select a network…</option>
                  {health.wifiAvailable.map((net) => (
                    <option key={net.ssid} value={net.ssid}>
                      {net.ssid}{health.wifiSsid === net.ssid ? ' ✓' : ''} · {net.security === 'OPEN' ? 'Open' : 'WPA'}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {health?.wifiKnown?.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase tracking-wider">
                  App-provisioned networks
                </p>
                <div className="flex flex-wrap gap-1.5">
                  {health.wifiKnown.map((net) => (
                    <span
                      key={net.ssid}
                      className={`text-xs px-2 py-1 rounded-full border ${
                        health.wifiSsid === net.ssid
                          ? 'bg-green-50 dark:bg-green-900/30 border-green-300 dark:border-green-700 text-green-700 dark:text-green-400'
                          : 'bg-gray-50 dark:bg-gray-700 border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300'
                      }`}
                    >
                      {net.ssid}{health.wifiSsid === net.ssid ? ' ✓' : ''}
                    </span>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-2 pt-1">
              <p className="text-xs text-gray-400 dark:text-gray-500">
                Push new credentials to the tablet (Device Owner required). Password is never stored.
              </p>
              <input type="text" placeholder="Network name (SSID)"
                value={wifi.ssid} onChange={(e) => setWifi(w => ({ ...w, ssid: e.target.value }))}
                className="w-full text-sm border dark:border-gray-600 rounded px-3 py-1.5 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <input type="password" placeholder="Password"
                value={wifi.password} onChange={(e) => setWifi(w => ({ ...w, password: e.target.value }))}
                className="w-full text-sm border dark:border-gray-600 rounded px-3 py-1.5 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <div className="flex items-center gap-3">
                <select value={wifi.security} onChange={(e) => setWifi(w => ({ ...w, security: e.target.value }))}
                  className="text-sm border dark:border-gray-600 rounded px-2 py-1.5 bg-white dark:bg-gray-700 text-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500">
                  <option value="WPA">WPA / WPA2</option>
                  <option value="OPEN">Open (no password)</option>
                </select>
                <button onClick={() => wifiMutation.mutate()} disabled={!wifi.ssid || wifiMutation.isPending}
                  className="text-sm bg-blue-600 text-white px-4 py-1.5 rounded-lg hover:bg-blue-700 disabled:opacity-40 transition-colors">
                  {wifiMutation.isPending ? 'Sending…' : 'Push to tablet'}
                </button>
              </div>
            </div>
            {wifiMutation.isSuccess && <p className="text-xs text-green-600 dark:text-green-400">WiFi command queued.</p>}
          </section>
        </div>
      )}

      {/* ── UPDATES tab ───────────────────────────────────────────── */}
      {subTab === 'updates' && (
        <div className="space-y-8">

          {/* Kiosk APK */}
          <section className="space-y-4">
            <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Kiosk APK
            </h3>
            <div className="grid grid-cols-2 gap-2 text-center">
              <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
                <div className="text-xs text-gray-400 dark:text-gray-500 mb-1">Current release</div>
                <div className="font-mono font-semibold text-gray-800 dark:text-gray-200">
                  {apkInfo?.version > 0 ? `v${apkInfo.version}` : '—'}
                </div>
              </div>
              <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
                <div className="text-xs text-gray-400 dark:text-gray-500 mb-1">On tablet</div>
                <div className={`font-mono font-semibold ${
                  !health?.apkVersion ? 'text-gray-400 dark:text-gray-500'
                  : health.apkVersion < apkInfo?.version ? 'text-amber-500'
                  : 'text-green-600 dark:text-green-400'
                }`}>
                  {health?.apkVersion > 0 ? `v${health.apkVersion}` : '—'}
                </div>
                {health?.apkVersion > 0 && apkInfo?.version > 0 && (
                  <div className="text-xs mt-0.5">
                    {health.apkVersion < apkInfo.version
                      ? <span className="text-amber-500">update pending</span>
                      : <span className="text-green-600 dark:text-green-400">up to date</span>
                    }
                  </div>
                )}
              </div>
            </div>
            <div className="space-y-3">
              <div>
                <input ref={apkInputRef} type="file" accept=".apk" className="hidden" onChange={handleApkSelect} />
                <button onClick={() => apkInputRef.current?.click()}
                  className="text-sm border dark:border-gray-600 rounded-lg px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors">
                  {apkFile ? apkFile.name : 'Select .apk file'}
                </button>
              </div>
              {apkStatus && (
                <p className="text-xs font-mono text-gray-500 dark:text-gray-400 break-all">{apkStatus}</p>
              )}
              {apkFile && apkSha && (
                <button onClick={handleApkUpload} disabled={apkUploading}
                  className="text-sm bg-green-600 text-white px-5 py-2 rounded-lg hover:bg-green-700 disabled:opacity-40 transition-colors">
                  {apkUploading ? 'Uploading…' : `Upload & release v${apkInfo?.version ? apkInfo.version + 1 : 2}`}
                </button>
              )}
            </div>
          </section>

          {/* Family APK */}
          <section className="space-y-4 pt-2 border-t dark:border-gray-700">
            <h3 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
              Family App APK
            </h3>
            <div className="grid grid-cols-1 gap-2 text-center">
              <div className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3">
                <div className="text-xs text-gray-400 dark:text-gray-500 mb-1">Current release</div>
                <div className="font-mono font-semibold text-gray-800 dark:text-gray-200">
                  {familyApkInfo?.version > 0 ? `v${familyApkInfo.version}` : '—'}
                </div>
              </div>
            </div>
            <div className="space-y-3">
              <div>
                <input ref={famInputRef} type="file" accept=".apk" className="hidden" onChange={handleFamApkSelect} />
                <button onClick={() => famInputRef.current?.click()}
                  className="text-sm border dark:border-gray-600 rounded-lg px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors">
                  {famFile ? famFile.name : 'Select .apk file'}
                </button>
              </div>
              {famStatus && (
                <p className="text-xs font-mono text-gray-500 dark:text-gray-400 break-all">{famStatus}</p>
              )}
              {famFile && famSha && (
                <button onClick={handleFamApkUpload} disabled={famUploading}
                  className="text-sm bg-green-600 text-white px-5 py-2 rounded-lg hover:bg-green-700 disabled:opacity-40 transition-colors">
                  {famUploading ? 'Uploading…' : `Upload & release v${familyApkInfo?.version ? familyApkInfo.version + 1 : 2}`}
                </button>
              )}
            </div>
            {familyApkInfo?.version > 0 && (
              <div className="pt-2 border-t dark:border-gray-700 space-y-2">
                <button
                  onClick={() => pushUpdateMutation.mutate()}
                  disabled={pushUpdateMutation.isPending}
                  className="text-sm border dark:border-gray-600 rounded-lg px-4 py-2 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-40 transition-colors"
                >
                  {pushUpdateMutation.isPending ? 'Pushing…' : 'Push update to all devices'}
                </button>
                {pushUpdateMutation.isSuccess && (
                  <p className="text-xs text-green-600 dark:text-green-400">
                    Sent to {pushUpdateMutation.data?.sent ?? 0} device{pushUpdateMutation.data?.sent !== 1 ? 's' : ''}
                    {pushUpdateMutation.data?.failed > 0 ? ` · ${pushUpdateMutation.data.failed} failed` : ''}
                  </p>
                )}
                {pushUpdateMutation.isError && (
                  <p className="text-xs text-red-500">{pushUpdateMutation.error?.message}</p>
                )}
              </div>
            )}
          </section>

        </div>
      )}
    </div>
  )
}

// ── Brightness control (separate to avoid re-render on drag) ──────

function BrightnessControl({ deviceId }) {
  const [brightness, setBrightness] = useState(70)
  const mut = useMutation({
    mutationFn: (level) => sendTabletCommand(deviceId, { type: 'set-brightness', level: level / 100 }),
  })

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-gray-800 dark:text-gray-200">Screen brightness</span>
        <span className="text-sm font-mono text-gray-700 dark:text-gray-300">{brightness}%</span>
      </div>
      <div className="flex items-center gap-3">
        <input type="range" min={5} max={100} value={brightness}
          onChange={(e) => setBrightness(Number(e.target.value))}
          className="flex-1 accent-blue-500"
        />
        <button
          onClick={() => mut.mutate(brightness)}
          disabled={mut.isPending}
          className="text-xs border dark:border-gray-600 rounded px-3 py-1 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 disabled:opacity-40 transition-colors"
        >
          {mut.isPending ? 'Setting…' : 'Set'}
        </button>
      </div>
      {mut.isSuccess && <p className="text-xs text-green-600 dark:text-green-400">Brightness command queued.</p>}
    </div>
  )
}
