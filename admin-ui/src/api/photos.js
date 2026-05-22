import client from './client'

export const getPhotos = (patientId) =>
  client.get(`/admin/photos/list?patientId=${patientId}`)

export const getUploadUrl = (patientId, contentType = 'image/webp') =>
  client.post('/admin/photos/upload-url', { patientId, contentType })

export const confirmUpload = (patientId, photoId, thumbnailUrl) =>
  client.post('/admin/photos/confirm', { patientId, photoId, thumbnailUrl })

export const deletePhoto = (photoId) =>
  client.delete(`/admin/photos/delete?photoId=${photoId}`)

export const reorderPhotos = (patientId, order) =>
  client.put('/admin/photos/order', { patientId, order })

export const updatePhotoCaption = (photoId, caption) =>
  client.put('/admin/photos/caption', { photoId, caption })

export const migrateThumbnails = () =>
  client.post('/admin/photos/migrate-thumbnails', {})

// ── Image processing ──────────────────────────────────────────

function isHeic(file) {
  return (
    file.type === 'image/heic' ||
    file.type === 'image/heif' ||
    /\.hei[cf]$/i.test(file.name)
  )
}

// Load blob into an HTMLImageElement. Returns the img element.
function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(blob)
    img.onload = () => { URL.revokeObjectURL(url); resolve(img) }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Image failed to load')) }
    img.src = url
  })
}

// Draw img onto a canvas scaled to maxPx on longest edge, encode as WebP.
function encodeWebP(img, maxPx, quality) {
  let w = img.naturalWidth
  let h = img.naturalHeight
  if (w > maxPx || h > maxPx) {
    if (w >= h) { h = Math.round(h * maxPx / w); w = maxPx }
    else        { w = Math.round(w * maxPx / h); h = maxPx }
  }
  const canvas = document.createElement('canvas')
  canvas.width  = w
  canvas.height = h
  canvas.getContext('2d').drawImage(img, 0, 0, w, h)
  return new Promise((resolve, reject) =>
    canvas.toBlob(
      b => (b ? resolve(b) : reject(new Error('WebP encoding failed'))),
      'image/webp',
      quality,
    )
  )
}

// Convert a File to { full: Blob, thumb: Blob } — both WebP.
async function processFile(file) {
  let source = file

  if (isHeic(file)) {
    // Lazy-load heic2any only when needed (~2 MB WASM, no point bundling always)
    const { default: heic2any } = await import('heic2any')
    const result = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 })
    source = Array.isArray(result) ? result[0] : result
  }

  const img = await loadImage(source)

  // Encode both sizes from the same decoded image element
  const [full, thumb] = await Promise.all([
    encodeWebP(img, 1920, 0.85),
    encodeWebP(img,  600, 0.75),
  ])

  return { full, thumb }
}

// ── Main upload entry point ───────────────────────────────────

export async function uploadPhoto(patientId, file) {
  const { full, thumb } = await processFile(file)

  const { photoId, uploadUrl, thumbUploadUrl, thumbPublicUrl } =
    await getUploadUrl(patientId, 'image/webp')

  await Promise.all([
    fetch(uploadUrl,      { method: 'PUT', headers: { 'Content-Type': 'image/webp' }, body: full }),
    fetch(thumbUploadUrl, { method: 'PUT', headers: { 'Content-Type': 'image/webp' }, body: thumb }),
  ])

  return confirmUpload(patientId, photoId, thumbPublicUrl)
}
