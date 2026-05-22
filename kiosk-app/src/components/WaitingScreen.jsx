import { useState } from 'react'

export default function WaitingScreen({ deviceId }) {
  const [confirmReset, setConfirmReset] = useState(false)

  function handleReset() {
    localStorage.removeItem('kiosk_device_id')
    window.location.reload()
  }

  return (
    <div className="w-full h-full flex flex-col items-center justify-center bg-gray-950 p-8 animate-fade-in">
      <div className="text-center">
        {/* Pulse indicator */}
        <div className="relative mx-auto mb-10 w-16 h-16">
          <div className="absolute inset-0 rounded-full bg-blue-500/30 animate-ping" />
          <div className="relative w-16 h-16 rounded-full bg-blue-500/20 border border-blue-500/40 flex items-center justify-center">
            <div className="w-4 h-4 rounded-full bg-blue-400" />
          </div>
        </div>

        <h2 className="text-2xl font-semibold text-white mb-2">Waiting for setup</h2>
        <p className="text-gray-500 text-sm mb-10 max-w-xs leading-relaxed">
          Open the admin panel and assign a patient to this device.
        </p>

        {/* Device ID badge — tap to get change option */}
        <button
          onClick={() => setConfirmReset(r => !r)}
          className="inline-block bg-gray-900 border border-gray-800 rounded-2xl px-7 py-4 text-left touch-manipulation"
        >
          <span className="text-xs text-gray-600 block mb-1.5 uppercase tracking-widest">Device ID</span>
          <span className="text-xl font-mono font-bold text-white tracking-widest">{deviceId}</span>
        </button>

        {/* Change ID panel — revealed by tapping the badge */}
        {confirmReset && (
          <div className="mt-4 animate-fade-in space-y-3">
            <p className="text-sm text-gray-400">
              Reset this tablet to enter a different device ID?
            </p>
            <div className="flex gap-3 justify-center">
              <button
                onClick={handleReset}
                className="bg-red-600 active:bg-red-700 text-white text-sm font-semibold px-5 py-2.5 rounded-xl transition-colors touch-manipulation"
              >
                Reset
              </button>
              <button
                onClick={() => setConfirmReset(false)}
                className="text-gray-500 text-sm px-5 py-2.5 rounded-xl border border-gray-700 touch-manipulation"
              >
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
