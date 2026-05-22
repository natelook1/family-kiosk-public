const API_BASE = self.location.origin

self.addEventListener('push', event => {
  if (!event.data) return
  const data = event.data.json()

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      // Wake any open app window — it handles its own incoming-call UI
      for (const client of list) {
        if (client.url.startsWith(self.location.origin)) {
          client.postMessage({ type: 'incoming-call', url: data.url })
        }
      }

      // Only show OS notification when no window is in the foreground
      if (list.some(c => c.focused)) return

      const isIos = /iphone|ipad|ipod/i.test(self.navigator?.userAgent ?? '')
      return self.registration.showNotification(data.title, {
        body:  data.body,
        icon:  '/apple-touch-icon-180.png',
        badge: '/apple-touch-icon-120.png',
        data:  { url: data.url },
        ...(isIos ? {} : {
          actions: [
            { action: 'answer',  title: '📞 Answer' },
            { action: 'decline', title: '❌ Decline' },
          ],
          requireInteraction: true,
          vibrate: [500, 200, 500, 200, 500, 200, 500, 200, 500],
        }),
        tag:       'incoming-call',
        renotify:  true,
        silent:    false,
      })
    })
  )
})

self.addEventListener('notificationclick', event => {
  event.notification.close()

  if (event.action === 'decline') {
    // deviceId, deviceToken, and room are embedded in the push URL by the backend
    // so the SW can authenticate the decline without opening the app.
    event.waitUntil(
      (async () => {
        try {
          const url         = new URL(event.notification.data.url)
          const deviceId    = url.searchParams.get('deviceId')
          const deviceToken = url.searchParams.get('deviceToken')
          const room        = url.searchParams.get('room')
          if (deviceId && deviceToken && room) {
            await fetch(`${API_BASE}/family/device/${encodeURIComponent(deviceId)}/call/decline`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-device-token': deviceToken },
              body: JSON.stringify({ roomName: room }),
            })
          }
        } catch {}
      })()
    )
    return
  }

  const url = event.notification.data.url
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const client of list) {
        if (client.url.startsWith(self.location.origin) && 'focus' in client) {
          client.navigate(url)
          return client.focus()
        }
      }
      return clients.openWindow(url)
    })
  )
})
