import client from './client'

export const getDeviceLogs = (deviceId, params = {}) =>
  client.get(`/admin/tablet/${deviceId}/logs`, { params })
