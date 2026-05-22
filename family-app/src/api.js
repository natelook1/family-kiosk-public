const API_BASE = import.meta.env.VITE_API_BASE || 'https://family.looknet.ca'
const VAPID_PUB_KEY = import.meta.env.VITE_VAPID_PUBLIC_KEY || ''

function urlBase64ToUint8Array(base64) {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4)
  const b64 = (base64 + pad).replace(/-/g, '+').replace(/_/g, '/')
  return Uint8Array.from(atob(b64), c => c.charCodeAt(0))
}

export async function pairDevice(token, deviceId) {
  const res = await fetch(`${API_BASE}/family/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token, deviceId, fcmToken: '', platform: 'web' }),
  })
  if (!res.ok) throw new Error(`pair failed (${res.status})`)
  return res.json()
}

export async function subscribeToPush(deviceId, deviceToken) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !VAPID_PUB_KEY) return
  const reg = await navigator.serviceWorker.ready
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') return null
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(VAPID_PUB_KEY),
  })
  await fetch(`${API_BASE}/family/device/${deviceId}/push-subscription`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-device-token': deviceToken || '' },
    body: JSON.stringify({ subscription: sub }),
  })
  return sub
}

export async function getPatientStatus(deviceId, deviceToken) {
  const res = await fetch(`${API_BASE}/family/device/${deviceId}/patient-status`, {
    headers: { 'x-device-token': deviceToken },
  })
  if (!res.ok) throw new Error(`status failed (${res.status})`)
  return res.json()
}

export async function requestCallback(deviceId, deviceToken) {
  const res = await fetch(`${API_BASE}/family/device/${deviceId}/callback-request`, {
    method: 'POST',
    headers: { 'x-device-token': deviceToken },
  })
  if (!res.ok) throw new Error(`callback request failed (${res.status})`)
  return res.json()
}

export async function cancelCallback(deviceId, deviceToken, requestId) {
  const res = await fetch(`${API_BASE}/family/device/${deviceId}/callback-request/${requestId}`, {
    method: 'DELETE',
    headers: { 'x-device-token': deviceToken },
  })
  if (!res.ok) throw new Error(`cancel callback failed (${res.status})`)
}

export async function getCallHistory(deviceId, deviceToken) {
  const res = await fetch(`${API_BASE}/family/device/${deviceId}/call-history`, {
    headers: { 'x-device-token': deviceToken },
  })
  if (!res.ok) throw new Error(`call-history failed (${res.status})`)
  return res.json()
}

export async function joinCall(roomName, deviceId, deviceToken, displayName) {
  const res = await fetch(`${API_BASE}/call/join`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-device-token': deviceToken },
    body: JSON.stringify({ roomName, deviceId, familyName: displayName }),
  })
  if (!res.ok) throw new Error(`join failed (${res.status})`)
  return res.json()
}

export { API_BASE }
