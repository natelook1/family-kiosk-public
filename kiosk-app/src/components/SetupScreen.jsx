import { useState } from 'react'

export default function SetupScreen({ onRegister }) {
  const [deviceId, setDeviceId] = useState('')
  const [busy, setBusy]         = useState(false)
  const [error, setError]       = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    const id = deviceId.trim().toUpperCase()
    if (!id) return
    setBusy(true)
    setError('')
    try {
      await onRegister(id)
    } catch {
      setError('Could not reach server. Check your connection and try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="w-full h-full flex flex-col items-center justify-center bg-gray-950 p-8 animate-fade-in">
      <div className="w-full max-w-sm text-center">
        <div className="text-5xl mb-6">📱</div>
        <h1 className="text-3xl font-bold text-white mb-2">Family Kiosk</h1>
        <p className="text-gray-500 text-sm mb-10 leading-relaxed">
          Enter the device ID from the admin panel to link this tablet.
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="text"
            value={deviceId}
            onChange={e => setDeviceId(e.target.value.toUpperCase())}
            placeholder="e.g. TABLET-001"
            maxLength={32}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="characters"
            spellCheck={false}
            className="w-full text-center text-2xl tracking-widest bg-gray-900 border border-gray-700 text-white rounded-2xl px-4 py-5 placeholder-gray-600 focus:outline-none focus:border-blue-500 touch-manipulation"
          />
          {error && <p className="text-red-400 text-sm">{error}</p>}
          <button
            type="submit"
            disabled={busy || !deviceId.trim()}
            className="w-full bg-blue-600 active:bg-blue-700 disabled:opacity-40 text-white text-lg font-semibold py-5 rounded-2xl transition-colors touch-manipulation"
          >
            {busy ? 'Connecting…' : 'Connect'}
          </button>
        </form>
      </div>
    </div>
  )
}
