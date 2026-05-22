export default function ToastContainer({ toasts, onDismiss }) {
  if (!toasts.length) return null
  return (
    <div className="fixed bottom-safe-or-6 inset-x-0 flex flex-col items-center gap-2 z-[100] pointer-events-none px-4">
      {toasts.map(t => (
        <Toast key={t.id} toast={t} onDismiss={onDismiss} />
      ))}
    </div>
  )
}

function Toast({ toast, onDismiss }) {
  const colors = {
    info:    'bg-[#2c2c2e] text-white',
    success: 'bg-green-600 text-white',
    error:   'bg-red-600 text-white',
    warning: 'bg-orange-500 text-white',
  }
  return (
    <button
      onClick={() => onDismiss(toast.id)}
      className={`pointer-events-auto px-5 py-3 rounded-2xl shadow-2xl text-sm font-medium max-w-xs text-center animate-toast-in ${colors[toast.type] || colors.info}`}
    >
      {toast.message}
    </button>
  )
}
