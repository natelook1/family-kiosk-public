import React, { useState } from 'react'

export default function ShareApp() {
  // Replace with your API URL config if needed (e.g. import.meta.env.VITE_API_URL)
  const apiBaseUrl = 'https://family.looknet.ca'
  const downloadUrl = `${apiBaseUrl}/family/apk/download`
  const qrCodeUrl = `https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=${encodeURIComponent(downloadUrl)}`
  
  const [copied, setCopied] = useState(false)

  const handleCopy = () => {
    navigator.clipboard.writeText(downloadUrl)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="max-w-2xl mx-auto p-6">
      <h1 className="text-2xl font-bold text-gray-900 mb-4">Share Family App</h1>
      <p className="text-gray-600 mb-8">
        Family members can use the link or scan the QR code below to download the latest Android app. 
        They will be prompted to allow installing unknown apps.
      </p>

      <div className="bg-white p-6 rounded-lg shadow border border-gray-200 flex flex-col items-center">
        <h2 className="text-lg font-semibold mb-4 text-center">Scan to Download</h2>
        <img src={qrCodeUrl} alt="QR Code" className="w-48 h-48 mb-6 border p-2 rounded" />
        
        <div className="w-full">
          <label className="block text-sm font-medium text-gray-700 mb-1">Direct Link</label>
          <div className="flex gap-2">
            <input
              type="text"
              readOnly
              value={downloadUrl}
              className="flex-1 p-2 bg-gray-50 border border-gray-300 rounded text-gray-700 w-full"
            />
            <button
              onClick={handleCopy}
              className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 whitespace-nowrap"
            >
              {copied ? 'Copied!' : 'Copy Link'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}