import client from './client'

export const getFamilyApkLatest     = ()        => client.get('/admin/family-apk/latest')
export const getFamilyApkUploadUrl  = (version) => client.post('/admin/family-apk/upload-url', { version })
export const recordFamilyApkRelease = (data)    => client.post('/admin/family-apk/release', data)
export const pushFamilyApkUpdate    = ()        => client.post('/admin/family-apk/push-update', {})
