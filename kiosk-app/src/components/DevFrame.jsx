import { useState, useEffect, useCallback } from 'react'

const PORTRAIT  = { w: 800,  h: 1280 }
const LANDSCAPE = { w: 1280, h: 800  }

function getScale(dim) {
  const availW = window.innerWidth  - 48
  const availH = window.innerHeight - 120
  return Math.min(availW / dim.w, availH / dim.h, 1)
}

export default function DevFrame({ children }) {
  const [landscape, setLandscape] = useState(false)
  const dim = landscape ? LANDSCAPE : PORTRAIT

  const [scale, setScale] = useState(() => getScale(landscape ? LANDSCAPE : PORTRAIT))

  const recalc = useCallback(() => {
    setScale(getScale(landscape ? LANDSCAPE : PORTRAIT))
  }, [landscape])

  useEffect(() => {
    setScale(getScale(dim))
    window.addEventListener('resize', recalc)
    return () => window.removeEventListener('resize', recalc)
  }, [dim, recalc])

  const frameW = Math.round(dim.w * scale)
  const frameH = Math.round(dim.h * scale)

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center gap-4 p-6"
      style={{ background: '#1a1a2e' }}
    >
      {/* Dev controls */}
      <div className="flex items-center gap-3">
        <span className="text-xs text-gray-400 font-mono">
          DEV — {dim.w}×{dim.h}
        </span>
        <button
          onClick={() => setLandscape(l => !l)}
          className="flex items-center gap-1.5 text-xs bg-gray-700 hover:bg-gray-600 text-gray-200 px-3 py-1.5 rounded transition-colors"
        >
          <RotateIcon />
          Rotate
        </button>
      </div>

      {/* Tablet frame — sized to the scaled dimensions so no dead space */}
      <div
        className="relative flex-shrink-0"
        style={{
          width:  frameW,
          height: frameH,
          borderRadius: 24 * scale,
          overflow: 'hidden',
          border: `${Math.round(8 * scale)}px solid #333`,
          background: '#000',
        }}
      >
        <div
          style={{
            width:  dim.w,
            height: dim.h,
            transform: `scale(${scale})`,
            transformOrigin: 'top left',
            position: 'absolute',
            top: 0,
            left: 0,
          }}
        >
          {children}
        </div>
      </div>
    </div>
  )
}

function RotateIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
    </svg>
  )
}
