export default function Settings({ settings, onUpdate, onClose }) {
  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-end justify-center">
      <div className="w-full max-w-md bg-[#1c1c1e] rounded-t-3xl pb-safe overflow-hidden animate-slide-up">

        {/* Handle */}
        <div className="flex justify-center pt-3 pb-2">
          <div className="w-10 h-1 rounded-full bg-white/20" />
        </div>

        <div className="px-6 pb-8">
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-white text-xl font-semibold">Settings</h2>
            <button onClick={onClose} className="text-white/50 text-sm active:text-white touch-manipulation">Done</button>
          </div>

          {/* Controls auto-hide */}
          <SettingRow
            label="Auto-hide call controls"
            description="Controls fade after 4 s; tap screen to show"
          >
            <Toggle
              value={settings.controlsAutoHide}
              onChange={v => onUpdate({ controlsAutoHide: v })}
            />
          </SettingRow>

          {/* Camera on by default */}
          <SettingRow
            label="Camera on when answering"
            description="Start each call with camera enabled"
          >
            <Toggle
              value={settings.cameraOnByDefault}
              onChange={v => onUpdate({ cameraOnByDefault: v })}
            />
          </SettingRow>


          {/* Accent color */}
          <div className="mt-4">
            <p className="text-white/70 text-sm mb-3">Accent colour</p>
            <div className="flex gap-3">
              {ACCENTS.map(({ key, bg }) => (
                <button
                  key={key}
                  onClick={() => onUpdate({ accentColor: key })}
                  className={`w-10 h-10 rounded-full ${bg} flex items-center justify-center touch-manipulation transition-transform active:scale-90`}
                >
                  {settings.accentColor === key && (
                    <svg className="w-5 h-5 text-white" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/>
                    </svg>
                  )}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

const ACCENTS = [
  { key: 'green',  bg: 'bg-green-500' },
  { key: 'blue',   bg: 'bg-blue-500' },
  { key: 'purple', bg: 'bg-purple-500' },
  { key: 'orange', bg: 'bg-orange-500' },
]

export const ACCENT_CLASSES = {
  green:  { bg: 'bg-green-500',  activeBg: 'active:bg-green-600',  text: 'text-green-400',  ring: 'ring-green-500' },
  blue:   { bg: 'bg-blue-500',   activeBg: 'active:bg-blue-600',   text: 'text-blue-400',   ring: 'ring-blue-500' },
  purple: { bg: 'bg-purple-500', activeBg: 'active:bg-purple-600', text: 'text-purple-400', ring: 'ring-purple-500' },
  orange: { bg: 'bg-orange-500', activeBg: 'active:bg-orange-600', text: 'text-orange-400', ring: 'ring-orange-500' },
}

function SettingRow({ label, description, children }) {
  return (
    <div className="flex items-center justify-between py-4 border-b border-white/8">
      <div className="flex-1 pr-4">
        <p className="text-white text-base">{label}</p>
        {description && <p className="text-white/40 text-xs mt-0.5">{description}</p>}
      </div>
      {children}
    </div>
  )
}

function Toggle({ value, onChange }) {
  return (
    <button
      role="switch"
      aria-checked={value}
      onClick={() => onChange(!value)}
      className={`relative w-12 h-7 rounded-full transition-colors duration-200 touch-manipulation ${value ? 'bg-green-500' : 'bg-white/20'}`}
    >
      <span className={`absolute top-1 left-1 w-5 h-5 rounded-full bg-white shadow transition-transform duration-200 ${value ? 'translate-x-5' : 'translate-x-0'}`} />
    </button>
  )
}
