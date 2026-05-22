import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { getPatients, deletePatient } from '../api/patients'

export default function Dashboard() {
  const qc = useQueryClient()

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['patients'],
    queryFn: getPatients,
  })

  const deleteMutation = useMutation({
    mutationFn: deletePatient,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['patients'] }),
    onError: (err) => alert(`Delete failed: ${err.message}`),
  })

  if (isLoading) return (
    <div className="flex items-center gap-2 text-gray-500 dark:text-gray-400">
      <div className="w-4 h-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin" />
      Loading...
    </div>
  )
  if (isError) return (
    <div className="text-center py-16 space-y-3">
      <p className="text-red-600 dark:text-red-400 font-medium">Could not reach server</p>
      <p className="text-sm text-gray-400 dark:text-gray-500">{error.message}</p>
      <button
        onClick={() => qc.refetchQueries({ queryKey: ['patients'] })}
        className="text-sm text-blue-600 dark:text-blue-400 hover:underline"
      >
        Retry
      </button>
    </div>
  )

  const patients = data?.patients ?? []

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold text-gray-900 dark:text-white">Patients</h1>

      {patients.length === 0 ? (
        <div className="text-center py-16 text-gray-400 dark:text-gray-500">
          <p>No patients yet.</p>
          <Link to="/patients/new" className="text-blue-600 dark:text-blue-400 hover:underline text-sm mt-2 inline-block">
            Add the first patient
          </Link>
        </div>
      ) : (
        <ul className="space-y-3">
          {patients.map((p) => (
            <li key={p.patientId} className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg px-5 py-4 flex items-center justify-between">
              <div>
                <Link
                  to={`/patients/${p.patientId}`}
                  className="font-medium text-gray-900 dark:text-white hover:text-blue-600 dark:hover:text-blue-400"
                >
                  {p.name}
                </Link>
                <p className="text-xs text-gray-400 dark:text-gray-500 mt-0.5">
                  {p.contactCount} contact{p.contactCount !== 1 ? 's' : ''} &middot;{' '}
                  {p.photoCount} photo{p.photoCount !== 1 ? 's' : ''} &middot;{' '}
                  {p.deviceId ? 'Tablet paired' : 'No tablet paired'} &middot;{' '}
                  <span className={p.status === 'active' ? 'text-green-600 dark:text-green-400' : 'text-gray-400 dark:text-gray-500'}>
                    {p.status}
                  </span>
                </p>
              </div>
              <div className="flex gap-3">
                <Link
                  to={`/patients/${p.patientId}`}
                  className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-800 dark:hover:text-white"
                >
                  Manage
                </Link>
                <button
                  disabled={deleteMutation.isPending}
                  onClick={() => {
                    if (confirm(`Delete ${p.name}? This cannot be undone.`)) {
                      deleteMutation.mutate(p.patientId)
                    }
                  }}
                  className="text-sm text-red-500 hover:text-red-700 dark:hover:text-red-400 disabled:opacity-40 disabled:cursor-wait"
                >
                  {deleteMutation.isPending ? 'Deleting…' : 'Delete'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
