import { useMemo } from 'react'

export function useDevice(overrideId, overrideToken) {
  return useMemo(() => ({
    deviceId:    overrideId    || localStorage.getItem('family_device_id')    || '',
    deviceToken: overrideToken || localStorage.getItem('family_device_token') || '',
  }), [overrideId, overrideToken])
}
