import client from './client'

export const getApkLatest     = ()       => client.get('/admin/apk/latest')
export const getApkUploadUrl  = (version) => client.post('/admin/apk/upload-url', { version })
export const recordApkRelease = (data)   => client.post('/admin/apk/release', data)
