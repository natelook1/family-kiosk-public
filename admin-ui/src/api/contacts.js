import client from './client'

export const getContacts = (patientId) =>
  client.get(`/admin/contacts/list?patientId=${patientId}`)

export const createContact = (patientId, data) =>
  client.post('/admin/contacts/create', { patientId, ...data })

export const updateContact = (contactId, data) =>
  client.put('/admin/contacts/update', { contactId, ...data })

export const deleteContact = (contactId) =>
  client.delete(`/admin/contacts/delete?contactId=${contactId}`)

export const reorderContacts = (patientId, order) =>
  client.put('/admin/contacts/order', { patientId, order })

export const generatePairingToken = (contactId) =>
  client.post(`/admin/contacts/${contactId}/pairing-token`)

export const getContactDevices = (contactId) =>
  client.get(`/admin/contacts/${contactId}/devices`)

export const removeContactDevice = (contactId, deviceId) =>
  client.delete(`/admin/contacts/${contactId}/devices/${deviceId}`)

export const getContactPhotoUploadUrl = (filename, contentType) =>
  client.post('/admin/contacts/upload-photo-url', { filename, contentType })

export async function uploadContactPhoto(file) {
  const { uploadUrl, publicUrl } = await getContactPhotoUploadUrl(file.name, file.type)
  await fetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type },
    body: file,
  })
  return publicUrl
}
