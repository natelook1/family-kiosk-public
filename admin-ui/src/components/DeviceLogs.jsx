import { useState, useCallback } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getDeviceLogs } from '../api/logs'

const LEVEL_COLORS = {
  E: 'text-red-600 dark:text-red-400',
  W: 'text-yellow-600 dark:text-yellow-400',
  I: 'text-blue-600 dark:text-blue-400',
  D: 'text-gray-500 dark:text-gray-400',
  V: 'text-gray-400 dark:text-gray-500',
}

const LEVEL_LABELS = { E: 'ERROR', W: 'WARN', I: 'INFO', D: 'DEBUG', V: 'VERBOSE' }
const LEVELS = ['E', 'W', 'I', 'D', 'V']

export default function DeviceLogs({ deviceId }) {
  const [filterLevel, setFilterLevel] = useState('W')
  const [filterTag,   setFilterTag]   = useState('')
  const [filterText,  setFilterText]  = useState('')
  const [limit,       setLimit]       = useState(500)

  // Committed filter state — only sent to server when user clicks Apply or changes limit/level
  const [committed, setCommitted] = useState({ level: 'W', tag: '', text: '', limit: 500 })

  const apply = useCallback(() => {
    setCommitted({ level: filterLevel, tag: filterTag, text: filterText, limit })
  }, [filterLevel, filterTag, filterText, limit])

  // Re-fetch when committed params or limit changes
  const queryParams = {
    limit:  committed.limit,
    level:  committed.level || undefined,
    tag:    committed.tag   || undefined,
    text:   committed.text  || undefined,
  }

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['device-logs', deviceId, queryParams],
    queryFn:  () => getDeviceLogs(deviceId, queryParams),
    enabled:  !!deviceId,
    refetchInterval: 5 * 60 * 1000,
  })

  const logs = data?.logs ?? []

  if (!deviceId) return (
    <p className="text-sm text-gray-500 dark:text-gray-400">No device paired — no logs available.</p>
  )

  return (
    <div className="space-y-3">
      {/* Filters */}
      <div className="flex flex-wrap gap-2 items-center">
        <select
          value={filterLevel}
          onChange={e => { setFilterLevel(e.target.value); setCommitted(c => ({ ...c, level: e.target.value })) }}
          className="text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200"
        >
          {LEVELS.map(l => (
            <option key={l} value={l}>{LEVEL_LABELS[l]} and above</option>
          ))}
        </select>

        <input
          type="text"
          placeholder="Tag (exact)…"
          value={filterTag}
          onChange={e => setFilterTag(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && apply()}
          className="text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 w-36"
        />

        <input
          type="text"
          placeholder="Search message…"
          value={filterText}
          onChange={e => setFilterText(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && apply()}
          className="text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 w-48"
        />

        <button
          onClick={apply}
          disabled={isFetching}
          className="text-sm px-3 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50"
        >
          Apply
        </button>

        <select
          value={limit}
          onChange={e => { const n = Number(e.target.value); setLimit(n); setCommitted(c => ({ ...c, limit: n })) }}
          className="text-sm border border-gray-300 dark:border-gray-600 rounded px-2 py-1 bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200"
        >
          {[100, 250, 500, 1000, 2000].map(n => <option key={n} value={n}>Last {n}</option>)}
        </select>

        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="text-sm px-3 py-1 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 rounded hover:bg-gray-200 dark:hover:bg-gray-600 disabled:opacity-50"
        >
          {isFetching ? 'Refreshing…' : 'Refresh'}
        </button>

        <span className="text-xs text-gray-400 dark:text-gray-500 ml-auto">
          {logs.length} entries · auto-refreshes every 5 min
        </span>
      </div>

      {/* Log table */}
      {isLoading && <p className="text-sm text-gray-500 dark:text-gray-400">Loading logs…</p>}
      {isError   && <p className="text-sm text-red-600 dark:text-red-400">{error.message}</p>}

      {!isLoading && !isError && logs.length === 0 && (
        <p className="text-sm text-gray-500 dark:text-gray-400">No logs match the current filters.</p>
      )}

      {logs.length > 0 && (
        <div className="overflow-x-auto rounded border border-gray-200 dark:border-gray-700">
          <table className="w-full text-xs font-mono">
            <thead>
              <tr className="bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-300 text-left">
                <th className="px-3 py-2 whitespace-nowrap">Time</th>
                <th className="px-3 py-2">Level</th>
                <th className="px-3 py-2">Tag</th>
                <th className="px-3 py-2 w-full">Message</th>
              </tr>
            </thead>
            <tbody>
              {logs.map((log, i) => (
                <tr
                  key={log.id ?? i}
                  className="border-t border-gray-200 dark:border-gray-700 hover:bg-gray-50 dark:hover:bg-gray-800/50"
                >
                  <td className="px-3 py-1 whitespace-nowrap text-gray-400 dark:text-gray-500">
                    {new Date(log.loggedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                    <span className="hidden sm:inline"> {new Date(log.loggedAt).toLocaleDateString()}</span>
                  </td>
                  <td className={`px-3 py-1 font-bold whitespace-nowrap ${LEVEL_COLORS[log.level] ?? ''}`}>
                    {log.level}
                  </td>
                  <td className="px-3 py-1 whitespace-nowrap text-gray-600 dark:text-gray-300">
                    {log.tag}
                  </td>
                  <td className="px-3 py-1 break-all text-gray-800 dark:text-gray-100">
                    {log.message}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
