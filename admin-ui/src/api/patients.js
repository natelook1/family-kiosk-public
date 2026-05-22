import client from './client'

export const getPatients  = ()           => client.get('/admin/patients/list')
export const getPatient   = (patientId)  => client.get(`/admin/patients/get?patientId=${patientId}`)
export const createPatient = (data)      => client.post('/admin/patients/create', data)
export const updatePatient = (patientId, data) => client.put('/admin/patients/update', { patientId, ...data })
export const deletePatient = (patientId) => client.delete(`/admin/patients/delete?patientId=${patientId}`)

// Patient avatar
export async function uploadPatientAvatar(file) {
  const { uploadUrl, publicUrl } = await client.post('/admin/patients/upload-avatar-url', {
    contentType: file.type,
    filename:    file.name,
  })
  await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': file.type }, body: file })
  return publicUrl
}

// Kiosk settings
export const getKioskSettings    = (patientId)         => client.get(`/admin/patients/${patientId}/settings`)
export const updateKioskSettings = (patientId, data)   => client.put(`/admin/patients/${patientId}/settings`, data)

// Call-back requests
export const requestCallBack = (patientId, contactId) =>
  client.post(`/admin/patients/${patientId}/call-request`, { contactId })

export const cancelCallRequest = (requestId) =>
  client.delete(`/admin/call-request/${requestId}`)

// Remote tablet control
export const sendTabletCommand = (deviceId, command) =>
  client.post(`/admin/tablet/${deviceId}/command`, { command })

// Device health (storage, battery, WiFi, etc.)
export const getDeviceStorage = (deviceId) =>
  client.get(`/admin/tablet/${deviceId}/storage`)
