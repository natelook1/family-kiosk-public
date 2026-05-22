import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { createPatient } from '../api/patients'

export default function NewPatient() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [name, setName] = useState('')

  const mutation = useMutation({
    mutationFn: createPatient,
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['patients'] })
      navigate(`/patients/${data.patientId}`)
    },
  })

  const handleSubmit = (e) => {
    e.preventDefault()
    mutation.mutate({ name })
  }

  return (
    <div className="max-w-md space-y-6">
      <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">New Patient</h1>
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
            Patient name
          </label>
          <input
            className="w-full border dark:border-gray-600 rounded px-3 py-2 text-sm bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-blue-500"
            placeholder="e.g. Margaret"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
          />
        </div>
        <div className="flex gap-3">
          <button
            type="submit"
            disabled={mutation.isPending}
            className="bg-blue-600 text-white text-sm px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-50"
          >
            {mutation.isPending ? 'Creating...' : 'Create Patient'}
          </button>
          <button
            type="button"
            onClick={() => navigate('/')}
            className="text-sm px-4 py-2 rounded border dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
          >
            Cancel
          </button>
        </div>
        {mutation.isError && (
          <p className="text-red-600 dark:text-red-400 text-sm">{mutation.error.message}</p>
        )}
      </form>
    </div>
  )
}
