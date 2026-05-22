import { useState, useCallback } from 'react'

const DEFAULTS = {
  controlsAutoHide: false,
  cameraOnByDefault: true,
  accentColor: 'green',
}

function load() {
  try {
    const raw = localStorage.getItem('fk_settings')
    return raw ? { ...DEFAULTS, ...JSON.parse(raw) } : DEFAULTS
  } catch {
    return DEFAULTS
  }
}

export function useSettings() {
  const [settings, setSettings] = useState(load)

  const update = useCallback((patch) => {
    setSettings(prev => {
      const next = { ...prev, ...patch }
      localStorage.setItem('fk_settings', JSON.stringify(next))
      return next
    })
  }, [])

  return [settings, update]
}
