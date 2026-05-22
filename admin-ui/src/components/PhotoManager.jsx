import { useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { uploadPhoto, deletePhoto, updatePhotoCaption } from '../api/photos'

// ── Caption input — auto-saves on blur ────────────────────────
function CaptionInput({ photo, patientId }) {
  const qc = useQueryClient()
  const [value, setValue]   = useState(photo.caption ?? '')
  const [saved, setSaved]   = useState(true)
  const [saving, setSaving] = useState(false)

  const mutation = useMutation({
    mutationFn: (caption) => updatePhotoCaption(photo.photoId, caption),
    onSuccess: () => {
      setSaving(false)
      setSaved(true)
      qc.invalidateQueries({ queryKey: ['patient', patientId] })
    },
    onError: () => setSaving(false),
  })

  function handleBlur() {
    const trimmed = value.trim()
    // Only save if changed
    if (trimmed === (photo.caption ?? '')) return
    setSaving(true)
    setSaved(false)
    mutation.mutate(trimmed)
  }

  return (
    <div className="relative">
      <input
        type="text"
        value={value}
        onChange={(e) => { setValue(e.target.value); setSaved(false) }}
        onBlur={handleBlur}
        placeholder="Add a note for this photo…"
        maxLength={120}
        className="w-full text-xs bg-gray-50 dark:bg-gray-900 border border-gray-200 dark:border-gray-700 rounded-b-lg px-3 py-2 text-gray-700 dark:text-gray-300 placeholder-gray-400 dark:placeholder-gray-600 focus:outline-none focus:ring-1 focus:ring-blue-500 focus:border-blue-500"
      />
      {/* Tiny save-state indicator */}
      {!saved && (
        <span className="absolute right-2 top-1/2 -translate-y-1/2 text-[10px] text-gray-400">
          {saving ? 'saving…' : ''}
        </span>
      )}
    </div>
  )
}

// ── Photo card ────────────────────────────────────────────────
function PhotoCard({ photo, patientId, onDelete }) {
  return (
    <div className="rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 group">
      {/* Thumbnail */}
      <div className="relative aspect-video bg-gray-100 dark:bg-gray-700">
        <img src={photo.thumbnailUrl || photo.url} alt="" className="w-full h-full object-cover" />
        <button
          onClick={onDelete}
          className="absolute top-1.5 right-1.5 bg-black/60 hover:bg-black/80 text-white text-xs rounded px-2 py-0.5 opacity-0 group-hover:opacity-100 transition-opacity"
        >
          Remove
        </button>
        {/* Caption badge on hover */}
        {photo.caption && (
          <div className="absolute bottom-0 inset-x-0 bg-black/50 px-2 py-1 opacity-0 group-hover:opacity-100 transition-opacity">
            <p className="text-white text-xs truncate italic">{photo.caption}</p>
          </div>
        )}
      </div>

      {/* Caption input */}
      <CaptionInput photo={photo} patientId={patientId} />
    </div>
  )
}

// ── PhotoManager ──────────────────────────────────────────────
export default function PhotoManager({ patientId, photos }) {
  const qc         = useQueryClient()
  const fileInputRef = useRef()

  const uploadMutation = useMutation({
    mutationFn: (file) => uploadPhoto(patientId, file),
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['patient', patientId] }),
  })

  const deleteMutation = useMutation({
    mutationFn: deletePhoto,
    onSuccess:  () => qc.invalidateQueries({ queryKey: ['patient', patientId] }),
  })

  const handleFiles = (e) => {
    Array.from(e.target.files).forEach((file) => uploadMutation.mutate(file))
    e.target.value = ''
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-medium text-gray-900 dark:text-white">
            Slideshow Photos ({photos.length})
          </h2>
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
            Notes appear on the kiosk while each photo is displayed.
          </p>
        </div>
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploadMutation.isPending}
          className="text-sm bg-blue-600 text-white px-3 py-1.5 rounded hover:bg-blue-700 disabled:opacity-50"
        >
          {uploadMutation.isPending ? 'Uploading…' : 'Upload Photos'}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/heic"
          multiple
          className="hidden"
          onChange={handleFiles}
        />
      </div>

      {uploadMutation.isError && (
        <p className="text-red-600 dark:text-red-400 text-sm">{uploadMutation.error.message}</p>
      )}

      {photos.length === 0 ? (
        <div
          className="border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg p-12 text-center text-gray-400 dark:text-gray-500 cursor-pointer hover:border-gray-400 dark:hover:border-gray-500 transition-colors"
          onClick={() => fileInputRef.current?.click()}
        >
          <p className="text-sm">Click to upload photos for the slideshow</p>
          <p className="text-xs mt-1 text-gray-400 dark:text-gray-600">You can add a note to each photo after uploading</p>
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-4">
          {photos.map((photo) => (
            <PhotoCard
              key={photo.photoId}
              photo={photo}
              patientId={patientId}
              onDelete={() => {
                if (confirm('Remove this photo?')) deleteMutation.mutate(photo.photoId)
              }}
            />
          ))}
        </div>
      )}
    </div>
  )
}
