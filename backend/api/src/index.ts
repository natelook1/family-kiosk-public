import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import Database from 'better-sqlite3'
import { v4 as uuidv4 } from 'uuid'
import { S3Client, DeleteObjectCommand, PutObjectCommand, GetObjectCommand } from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { AccessToken, RoomServiceClient, WebhookReceiver } from 'livekit-server-sdk'
import fs from 'fs'
import crypto from 'crypto'
import webpush from 'web-push'

// ============================================================
// Config
// ============================================================
function readSecret(secretName: string, envFallback?: string): string {
  try {
    return fs.readFileSync(`/run/secrets/${secretName}`, 'utf8').trim()
  } catch {
    return (envFallback ? process.env[envFallback] : undefined) || ''
  }
}

const API_KEY           = readSecret('family_api_key',      'API_KEY')
const LIVEKIT_API_KEY   = readSecret('livekit_api_key',     'LIVEKIT_API_KEY')
const LIVEKIT_API_SECRET= readSecret('livekit_api_secret',  'LIVEKIT_API_SECRET')
const FCM_SERVICE_ACCOUNT  = readSecret('fcm_service_account',  'FCM_SERVICE_ACCOUNT')
const VAPID_PUBLIC_KEY     = readSecret('vapid_public_key',     'VAPID_PUBLIC_KEY')
const VAPID_PRIVATE_KEY    = readSecret('vapid_private_key',    'VAPID_PRIVATE_KEY')
const LIVEKIT_WS_URL       = process.env.LIVEKIT_WS_URL || ''

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails('mailto:natelook@gmail.com', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY)
}
const PORT              = parseInt(process.env.PORT || '3000')
const DB_PATH           = process.env.DB_PATH || '/data/family-kiosk.db'

// ============================================================
// Database — synchronous, no connection pool, no network
// ============================================================
const db = new Database(DB_PATH)

// Per-patient call rate limit: prevent spamming the kiosk (45s cooldown)
const callRateLimit = new Map<string, number>()
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
  CREATE TABLE IF NOT EXISTS device_logs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id  TEXT    NOT NULL,
    logged_at  INTEGER NOT NULL,
    level      TEXT    NOT NULL,
    tag        TEXT    NOT NULL,
    message    TEXT    NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_device_logs_logged_at ON device_logs (logged_at);
  CREATE INDEX IF NOT EXISTS idx_device_logs_device_id ON device_logs (device_id);

  CREATE TABLE IF NOT EXISTS patients (
    patient_id  TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    status      TEXT NOT NULL DEFAULT 'active',
    device_id   TEXT,
    created_at  TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS contacts (
    contact_id        TEXT PRIMARY KEY,
    patient_id        TEXT NOT NULL REFERENCES patients(patient_id),
    name              TEXT NOT NULL,
    whatsapp_number   TEXT NOT NULL,
    profile_photo_url TEXT NOT NULL DEFAULT '',
    sort_order        INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS photos (
    photo_id   TEXT PRIMARY KEY,
    patient_id TEXT NOT NULL REFERENCES patients(patient_id),
    url        TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS pending_uploads (
    photo_id   TEXT PRIMARY KEY,
    patient_id TEXT NOT NULL,
    s3_key     TEXT NOT NULL,
    public_url TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tablet_commands (
    device_id TEXT PRIMARY KEY,
    command   TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS call_requests (
    request_id TEXT    PRIMARY KEY,
    patient_id TEXT    NOT NULL,
    contact_id TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    dismissed  INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS incoming_calls (
    call_id    TEXT    PRIMARY KEY,
    patient_id TEXT    NOT NULL,
    contact_id TEXT    NOT NULL,
    room_name  TEXT    NOT NULL,
    created_at INTEGER NOT NULL,
    answered   INTEGER NOT NULL DEFAULT 0,
    declined   INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS kiosk_settings (
    patient_id       TEXT    PRIMARY KEY,
    slide_interval   INTEGER NOT NULL DEFAULT 8,
    resume_delay     INTEGER NOT NULL DEFAULT 3,
    night_start      INTEGER NOT NULL DEFAULT 21,
    night_end        INTEGER NOT NULL DEFAULT 7,
    night_brightness INTEGER NOT NULL DEFAULT 25,
    night_enabled    INTEGER NOT NULL DEFAULT 1,
    ken_burns        INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS family_devices (
    device_id     TEXT    PRIMARY KEY,
    contact_id    TEXT    NOT NULL REFERENCES contacts(contact_id) ON DELETE CASCADE,
    fcm_token     TEXT    NOT NULL,
    platform      TEXT    NOT NULL DEFAULT 'android',
    registered_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pairing_tokens (
    token      TEXT    PRIMARY KEY,
    contact_id TEXT    NOT NULL REFERENCES contacts(contact_id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS active_rooms (
    room_name  TEXT    PRIMARY KEY,
    patient_id TEXT    NOT NULL,
    started_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS room_invites (
    room_name  TEXT    NOT NULL,
    contact_id TEXT    NOT NULL,
    PRIMARY KEY (room_name, contact_id)
  );

  CREATE TABLE IF NOT EXISTS apk_releases (
    version     INTEGER PRIMARY KEY,
    url         TEXT NOT NULL,
    sha256      TEXT NOT NULL,
    released_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS family_apk_releases (
    version     INTEGER PRIMARY KEY,
    url         TEXT NOT NULL,
    sha256      TEXT NOT NULL,
    released_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS device_storage (
    device_id          TEXT    PRIMARY KEY,
    cache_bytes        INTEGER NOT NULL DEFAULT 0,
    free_bytes         INTEGER NOT NULL DEFAULT 0,
    cached_photo_count INTEGER NOT NULL DEFAULT 0,
    battery_level      INTEGER NOT NULL DEFAULT -1,
    battery_charging   INTEGER NOT NULL DEFAULT 0,
    lock_task_active   INTEGER NOT NULL DEFAULT 0,
    uptime_ms          INTEGER NOT NULL DEFAULT 0,
    wifi_ssid          TEXT    NOT NULL DEFAULT '',
    wifi_signal        INTEGER NOT NULL DEFAULT -1,
    wifi_connected     INTEGER NOT NULL DEFAULT 0,
    reported_at        INTEGER NOT NULL DEFAULT 0
  );
`)

// Safe migrations — no-op if column already exists
try { db.exec(`ALTER TABLE photos          ADD COLUMN caption           TEXT NOT NULL DEFAULT ''`)  } catch {}
try { db.exec(`ALTER TABLE contacts        ADD COLUMN call_type         TEXT NOT NULL DEFAULT 'video'`) } catch {}
try { db.exec(`ALTER TABLE family_devices  ADD COLUMN push_subscription TEXT`) } catch {}
try { db.exec(`ALTER TABLE call_requests   ADD COLUMN room_name         TEXT`) } catch {}
try { db.exec(`ALTER TABLE kiosk_settings  ADD COLUMN ken_burns         INTEGER NOT NULL DEFAULT 1`) } catch {}
try { db.exec(`ALTER TABLE kiosk_settings  ADD COLUMN unlock_pin        TEXT    NOT NULL DEFAULT '1234'`) } catch {}
try { db.exec(`ALTER TABLE kiosk_settings  ADD COLUMN restart_hour      INTEGER NOT NULL DEFAULT -1`) } catch {}
try { db.exec(`ALTER TABLE family_devices  ADD COLUMN device_token TEXT`) } catch {}
// confirmed=0: room created by family but Livekit hasn't started it yet (5-min provisional TTL)
// confirmed=1: Livekit room_started fired — real call in progress (4-hour TTL)
try { db.exec(`ALTER TABLE active_rooms    ADD COLUMN confirmed         INTEGER NOT NULL DEFAULT 0`) } catch {}
try { db.exec(`ALTER TABLE kiosk_settings  ADD COLUMN ringtone           TEXT    NOT NULL DEFAULT 'digital'`) } catch {}
try { db.exec(`ALTER TABLE photos          ADD COLUMN thumbnail_url     TEXT    NOT NULL DEFAULT ''`) } catch {}
try { db.exec(`ALTER TABLE device_storage  ADD COLUMN wifi_available    TEXT    NOT NULL DEFAULT '[]'`) } catch {}
try { db.exec(`ALTER TABLE device_storage  ADD COLUMN wifi_known        TEXT    NOT NULL DEFAULT '[]'`) } catch {}
try { db.exec(`ALTER TABLE device_storage  ADD COLUMN total_bytes       INTEGER NOT NULL DEFAULT 0`) } catch {}
// New kiosk settings
try { db.exec(`ALTER TABLE kiosk_settings  ADD COLUMN ring_volume       INTEGER NOT NULL DEFAULT 80`) } catch {}
try { db.exec(`ALTER TABLE kiosk_settings  ADD COLUMN screen_timeout_ms INTEGER NOT NULL DEFAULT 60000`) } catch {}
try { db.exec(`ALTER TABLE kiosk_settings  ADD COLUMN timezone          TEXT    NOT NULL DEFAULT ''`) } catch {}
try { db.exec(`ALTER TABLE kiosk_settings  ADD COLUMN font_scale        REAL    NOT NULL DEFAULT 1.0`) } catch {}
try { db.exec(`ALTER TABLE kiosk_settings  ADD COLUMN orientation       TEXT    NOT NULL DEFAULT 'landscape'`) } catch {}
try { db.exec(`ALTER TABLE kiosk_settings  ADD COLUMN bt_device_address TEXT    NOT NULL DEFAULT ''`) } catch {}
// New device health fields
try { db.exec(`ALTER TABLE device_storage  ADD COLUMN device_manufacturer TEXT NOT NULL DEFAULT ''`) } catch {}
try { db.exec(`ALTER TABLE device_storage  ADD COLUMN device_model        TEXT NOT NULL DEFAULT ''`) } catch {}
try { db.exec(`ALTER TABLE device_storage  ADD COLUMN android_version     TEXT NOT NULL DEFAULT ''`) } catch {}
try { db.exec(`ALTER TABLE device_storage  ADD COLUMN android_sdk         INTEGER NOT NULL DEFAULT 0`) } catch {}
try { db.exec(`ALTER TABLE device_storage  ADD COLUMN timezone_str        TEXT NOT NULL DEFAULT ''`) } catch {}
try { db.exec(`ALTER TABLE device_storage  ADD COLUMN volume_ring         INTEGER NOT NULL DEFAULT -1`) } catch {}
try { db.exec(`ALTER TABLE device_storage  ADD COLUMN bt_connected        INTEGER NOT NULL DEFAULT 0`) } catch {}
try { db.exec(`ALTER TABLE device_storage  ADD COLUMN bt_device_name      TEXT NOT NULL DEFAULT ''`) } catch {}
try { db.exec(`ALTER TABLE device_storage  ADD COLUMN bt_devices          TEXT NOT NULL DEFAULT '[]'`) } catch {}
try { db.exec(`ALTER TABLE device_storage  ADD COLUMN ringtones           TEXT NOT NULL DEFAULT '[]'`) } catch {}
try { db.exec(`ALTER TABLE device_storage  ADD COLUMN font_scale          REAL NOT NULL DEFAULT 1.0`) } catch {}
try { db.exec(`ALTER TABLE device_storage  ADD COLUMN orientation         TEXT NOT NULL DEFAULT 'landscape'`) } catch {}
try { db.exec(`ALTER TABLE device_storage  ADD COLUMN apk_version         INTEGER NOT NULL DEFAULT 0`) } catch {}
try { db.exec(`ALTER TABLE device_storage  ADD COLUMN ram_total_bytes      INTEGER NOT NULL DEFAULT 0`) } catch {}
try { db.exec(`ALTER TABLE device_storage  ADD COLUMN ram_used_bytes       INTEGER NOT NULL DEFAULT 0`) } catch {}
try { db.exec(`ALTER TABLE device_storage  ADD COLUMN ram_low_memory       INTEGER NOT NULL DEFAULT 0`) } catch {}
try { db.exec(`ALTER TABLE patients        ADD COLUMN profile_photo_url   TEXT    NOT NULL DEFAULT ''`) } catch {}
try { db.exec(`ALTER TABLE contacts        ADD COLUMN color               TEXT    NOT NULL DEFAULT ''`) } catch {}
try { db.exec(`ALTER TABLE kiosk_settings  ADD COLUMN accessibility_mode  INTEGER NOT NULL DEFAULT 0`) } catch {}

console.log(`[db] opened ${DB_PATH}`)

// ============================================================
// R2 / S3-compatible client
// ============================================================
const R2_ACCOUNT_ID = process.env.R2_ACCOUNT_ID || ''
const R2_BUCKET     = process.env.R2_BUCKET_NAME || ''
const R2_PUBLIC_URL = (process.env.R2_PUBLIC_URL || '').replace(/\/$/, '')

const s3 = new S3Client({
  region: 'auto',
  endpoint: R2_ACCOUNT_ID ? `https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com` : undefined,
  credentials: {
    accessKeyId:     readSecret('r2_access_key_id',     'R2_ACCESS_KEY_ID'),
    secretAccessKey: readSecret('r2_secret_access_key', 'R2_SECRET_ACCESS_KEY'),
  },
})

// ============================================================
// App
// ============================================================
const ALLOWED_ORIGINS = [
  'https://family.looknet.ca',
  'https://family-kiosk.looknet.ca',
  'https://family-admin.looknet.ca',
  'https://family-call.looknet.ca',
  'https://family-kiosk.pages.dev',
  'https://family-kiosk-admin.pages.dev',
]

const app = new Hono()

// Request logger
app.use('*', async (c, next) => {
  const start = Date.now()
  await next()
  console.log(`[req] ${c.req.method} ${c.req.path} ${c.res.status} ${Date.now() - start}ms`)
})

// CORS
function applyCors(c: any) {
  const origin = c.req.header('origin') || ''
  if (ALLOWED_ORIGINS.includes(origin)) {
    c.header('Access-Control-Allow-Origin', origin)
    c.header('Vary', 'Origin')
  }
  c.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS,HEAD')
  c.header('Access-Control-Allow-Headers', 'Content-Type,Authorization,x-api-key,x-device-id,x-device-token')
  c.header('Access-Control-Max-Age', '86400')
}

app.use('*', async (c, next) => {
  applyCors(c)
  if (c.req.method === 'OPTIONS') return c.body(null, 204)
  await next()
})

// Ensure CORS headers survive unhandled errors
app.onError((err, c) => {
  applyCors(c)
  console.error('[unhandled]', err)
  return c.json({ error: 'Internal server error' }, 500)
})

// Health — no auth, keeps Cloudflare Tunnel connection warm
app.get('/health', (c) => c.json({ ok: true }))

// Auth
app.use('/webhook/*', async (c, next) => {
  const key = c.req.header('x-api-key')
  if (!API_KEY || key !== API_KEY) return c.json({ error: 'Unauthorized' }, 401)
  await next()
})

app.use('/kiosk/patient/*', async (c, next) => {
  const key = c.req.header('x-api-key')
  if (!API_KEY || key !== API_KEY) return c.json({ error: 'Unauthorized' }, 401)
  await next()
})

app.use('/kiosk/incoming-call/*', async (c, next) => {
  const key = c.req.header('x-api-key')
  if (!API_KEY || key !== API_KEY) return c.json({ error: 'Unauthorized' }, 401)
  await next()
})

app.use('/call/kiosk-join', async (c, next) => {
  const key = c.req.header('x-api-key')
  if (!API_KEY || key !== API_KEY) return c.json({ error: 'Unauthorized' }, 401)
  await next()
})

function verifyDeviceToken(deviceId: string, token: string | null | undefined): boolean {
  if (!token) return false
  const row = db.prepare(`SELECT device_token FROM family_devices WHERE device_id = ?`).get(deviceId) as { device_token: string | null } | undefined
  if (!row?.device_token) return false
  try {
    const a = Buffer.from(token)
    const b = Buffer.from(row.device_token)
    if (a.length !== b.length) return false
    return crypto.timingSafeEqual(a, b)
  } catch { return false }
}

// ============================================================
// PATIENTS
// ============================================================

app.get('/webhook/admin/patients/list', (c) => {
  const patients = db.prepare(`
    SELECT p.patient_id AS patientId, p.name, p.status, NULLIF(p.device_id, '') AS deviceId, p.created_at AS createdAt,
           NULLIF(p.profile_photo_url, '') AS profilePhotoUrl,
           (SELECT COUNT(*) FROM contacts WHERE patient_id = p.patient_id) AS contactCount,
           (SELECT COUNT(*) FROM photos WHERE patient_id = p.patient_id) AS photoCount,
           IFNULL(ds.cached_photo_count, 0) AS cachedPhotoCount
    FROM patients p
    LEFT JOIN device_storage ds ON ds.device_id = p.device_id
  `).all()
  return c.json({ patients })
})

app.post('/webhook/admin/patients/create', async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>))
  const name = body.name as string | undefined
  if (!name) return c.json({ success: false, error: 'name is required' }, 400)

  const patientId = uuidv4()
  const createdAt = new Date().toISOString()
  db.prepare(`INSERT INTO patients (patient_id, name, status, created_at) VALUES (?, ?, 'active', ?)`).run(patientId, name, createdAt)
  return c.json({ patientId, name, status: 'active', createdAt })
})

app.get('/webhook/admin/patients/get', (c) => {
  const patientId = c.req.query('patientId')
  if (!patientId) return c.json({ success: false, error: 'patientId required' }, 400)

  const p = db.prepare(`
    SELECT p.patient_id AS patientId, p.name, p.status, NULLIF(p.device_id, '') AS deviceId, p.created_at AS createdAt,
           NULLIF(p.profile_photo_url, '') AS profilePhotoUrl,
           IFNULL(ds.cached_photo_count, 0) AS cachedPhotoCount
    FROM patients p
    LEFT JOIN device_storage ds ON ds.device_id = p.device_id
    WHERE p.patient_id = ?
  `).get(patientId) as Record<string, unknown> | undefined
  if (!p) return c.json({ patientId: null })

  const contacts = db.prepare(`
    SELECT c.contact_id AS contactId, c.patient_id AS patientId, c.name,
           NULLIF(c.profile_photo_url, '') AS profilePhotoUrl,
           c.call_type AS callType, NULLIF(c.color, '') AS color,
           c.sort_order AS "order",
           COUNT(fd.device_id) AS deviceCount
    FROM contacts c
    LEFT JOIN family_devices fd ON fd.contact_id = c.contact_id
    WHERE c.patient_id = ? GROUP BY c.contact_id ORDER BY c.sort_order
  `).all(patientId)

  const photos = db.prepare(`
    SELECT photo_id AS photoId, url, NULLIF(thumbnail_url, '') AS thumbnailUrl,
           NULLIF(caption, '') AS caption, sort_order AS "order"
    FROM photos WHERE patient_id = ? ORDER BY sort_order
  `).all(patientId)

  const callRequests = db.prepare(`
    SELECT cr.request_id AS requestId, cr.contact_id AS contactId, c.name,
           NULLIF(c.profile_photo_url, '') AS profilePhotoUrl,
           cr.created_at AS createdAt, cr.room_name AS roomName
    FROM call_requests cr
    JOIN contacts c ON c.contact_id = cr.contact_id
    WHERE cr.patient_id = ? AND cr.dismissed = 0
    ORDER BY cr.created_at
  `).all(patientId)

  const settingsRow = db.prepare(`SELECT * FROM kiosk_settings WHERE patient_id = ?`).get(patientId) as Record<string, unknown> | undefined
  const settings = {
    slideInterval:   (settingsRow?.slide_interval   ?? 8)  as number,
    resumeDelay:     (settingsRow?.resume_delay      ?? 3)  as number,
    nightStart:      (settingsRow?.night_start       ?? 21) as number,
    nightEnd:        (settingsRow?.night_end         ?? 7)  as number,
    nightBrightness: (settingsRow?.night_brightness  ?? 25) as number,
    nightEnabled:    ((settingsRow?.night_enabled    ?? 1) as number) === 1,
    kenBurns:        ((settingsRow?.ken_burns        ?? 1) as number) === 1,
  }

  return c.json({ ...p, contacts, photos, callRequests, settings })
})

app.put('/webhook/admin/patients/update', async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>))
  const patientId = body.patientId as string | undefined
  if (!patientId) return c.json({ success: false, error: 'patientId required' }, 400)

  if (!db.prepare(`SELECT patient_id FROM patients WHERE patient_id = ?`).get(patientId))
    return c.json({ success: false, error: 'Patient not found' }, 404)

  if (body.name)     db.prepare(`UPDATE patients SET name      = ? WHERE patient_id = ?`).run(body.name, patientId)
  if (body.status)   db.prepare(`UPDATE patients SET status    = ? WHERE patient_id = ?`).run(body.status, patientId)
  if (body.deviceId !== undefined) db.prepare(`UPDATE patients SET device_id = ? WHERE patient_id = ?`).run(body.deviceId || null, patientId)
  if (body.profilePhotoUrl !== undefined) db.prepare(`UPDATE patients SET profile_photo_url = ? WHERE patient_id = ?`).run(body.profilePhotoUrl || '', patientId)

  const updated = db.prepare(`
    SELECT patient_id AS patientId, name, status, NULLIF(device_id, '') AS deviceId, created_at AS createdAt,
           NULLIF(profile_photo_url, '') AS profilePhotoUrl
    FROM patients WHERE patient_id = ?
  `).get(patientId)
  return c.json(updated)
})

app.delete('/webhook/admin/patients/delete', (c) => {
  const patientId = c.req.query('patientId')
  if (!patientId) return c.json({ success: false, error: 'patientId required' }, 400)

  if (!db.prepare(`SELECT patient_id FROM patients WHERE patient_id = ?`).get(patientId))
    return c.json({ success: false, error: 'Patient not found' }, 404)

  db.transaction(() => {
    db.prepare(`DELETE FROM call_requests   WHERE patient_id = ?`).run(patientId)
    db.prepare(`DELETE FROM kiosk_settings  WHERE patient_id = ?`).run(patientId)
    db.prepare(`DELETE FROM contacts        WHERE patient_id = ?`).run(patientId)
    db.prepare(`DELETE FROM photos          WHERE patient_id = ?`).run(patientId)
    db.prepare(`DELETE FROM pending_uploads WHERE patient_id = ?`).run(patientId)
    db.prepare(`DELETE FROM active_rooms    WHERE patient_id = ?`).run(patientId)
    db.prepare(`DELETE FROM patients        WHERE patient_id = ?`).run(patientId)
  })()

  return c.json({ success: true })
})

// ============================================================
// CONTACTS
// ============================================================

app.get('/webhook/admin/contacts/list', (c) => {
  const patientId = c.req.query('patientId')
  if (!patientId) return c.json({ success: false, error: 'patientId required' }, 400)

  const contacts = db.prepare(`
    SELECT c.contact_id AS contactId, c.patient_id AS patientId, c.name,
           NULLIF(c.profile_photo_url, '') AS profilePhotoUrl,
           c.call_type AS callType, NULLIF(c.color, '') AS color,
           c.sort_order AS "order",
           COUNT(fd.device_id) AS deviceCount
    FROM contacts c
    LEFT JOIN family_devices fd ON fd.contact_id = c.contact_id
    WHERE c.patient_id = ? GROUP BY c.contact_id ORDER BY c.sort_order
  `).all(patientId)
  return c.json({ contacts })
})

app.post('/webhook/admin/contacts/create', async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>))
  const patientId      = (c.req.query('patientId') || body.patientId) as string | undefined
  const name           = body.name           as string | undefined
  const profilePhotoUrl= (body.profilePhotoUrl as string | undefined) || ''

  if (!patientId || !name)
    return c.json({ success: false, error: 'patientId and name are required' }, 400)

  if (!db.prepare(`SELECT patient_id FROM patients WHERE patient_id = ?`).get(patientId))
    return c.json({ success: false, error: 'Patient not found' }, 404)

  const count = (db.prepare(`SELECT COUNT(*) AS n FROM contacts WHERE patient_id = ?`).get(patientId) as { n: number }).n
  if (count >= 10) return c.json({ success: false, error: 'Maximum 10 contacts allowed' }, 400)

  const contactId = uuidv4()
  db.prepare(`
    INSERT INTO contacts (contact_id, patient_id, name, whatsapp_number, profile_photo_url, sort_order)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(contactId, patientId, name, '', profilePhotoUrl, count)

  return c.json({ contactId, name, profilePhotoUrl: profilePhotoUrl || null, order: count })
})

app.put('/webhook/admin/contacts/update', async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>))
  const contactId = body.contactId as string | undefined
  if (!contactId) return c.json({ success: false, error: 'contactId required' }, 400)

  if (!db.prepare(`SELECT contact_id FROM contacts WHERE contact_id = ?`).get(contactId))
    return c.json({ success: false, error: 'Contact not found' }, 404)

  if (body.name)                          db.prepare(`UPDATE contacts SET name              = ? WHERE contact_id = ?`).run(body.name,           contactId)
  if (body.whatsappNumber)                db.prepare(`UPDATE contacts SET whatsapp_number   = ? WHERE contact_id = ?`).run(body.whatsappNumber,  contactId)
  if (body.callType)                      db.prepare(`UPDATE contacts SET call_type         = ? WHERE contact_id = ?`).run(body.callType,        contactId)
  if (body.profilePhotoUrl !== undefined) db.prepare(`UPDATE contacts SET profile_photo_url = ? WHERE contact_id = ?`).run(body.profilePhotoUrl || '', contactId)
  if (body.color !== undefined)           db.prepare(`UPDATE contacts SET color             = ? WHERE contact_id = ?`).run(body.color || '',      contactId)

  const updated = db.prepare(`
    SELECT c.contact_id AS contactId, c.patient_id AS patientId, c.name,
           NULLIF(c.profile_photo_url, '') AS profilePhotoUrl,
           c.call_type AS callType, NULLIF(c.color, '') AS color,
           c.sort_order AS "order",
           COUNT(fd.device_id) AS deviceCount
    FROM contacts c
    LEFT JOIN family_devices fd ON fd.contact_id = c.contact_id
    WHERE c.contact_id = ? GROUP BY c.contact_id
  `).get(contactId)
  return c.json(updated)
})

app.delete('/webhook/admin/contacts/delete', (c) => {
  const contactId = c.req.query('contactId')
  if (!contactId) return c.json({ success: false, error: 'contactId required' }, 400)

  const ct = db.prepare(`SELECT patient_id FROM contacts WHERE contact_id = ?`).get(contactId) as { patient_id: string } | undefined
  if (!ct) return c.json({ success: false, error: 'Contact not found' }, 404)

  db.prepare(`DELETE FROM contacts WHERE contact_id = ?`).run(contactId)

  // Re-sequence sort_order
  const remaining = db.prepare(`SELECT contact_id FROM contacts WHERE patient_id = ? ORDER BY sort_order`).all(ct.patient_id) as { contact_id: string }[]
  const reorder   = db.prepare(`UPDATE contacts SET sort_order = ? WHERE contact_id = ?`)
  db.transaction(() => { remaining.forEach((r, i) => reorder.run(i, r.contact_id)) })()

  return c.json({ success: true })
})

app.put('/webhook/admin/contacts/order', async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>))
  const patientId  = body.patientId  as string | undefined
  const contactIds = body.contactIds as string[] | undefined
  if (!patientId || !Array.isArray(contactIds))
    return c.json({ success: false, error: 'patientId and contactIds[] required' }, 400)

  const reorder = db.prepare(`UPDATE contacts SET sort_order = ? WHERE contact_id = ? AND patient_id = ?`)
  db.transaction(() => { contactIds.forEach((cid, i) => reorder.run(i, cid, patientId)) })()

  return c.json({ success: true })
})

app.post('/webhook/admin/contacts/upload-photo-url', async (c) => {
  const body        = await c.req.json().catch(() => ({} as Record<string, unknown>))
  const contentType = (body.contentType as string) || 'image/jpeg'
  const filename    = (body.filename    as string) || 'photo.jpg'

  if (!R2_BUCKET) return c.json({ error: 'R2 not configured' }, 503)

  const ext       = (filename.split('.').pop() || 'jpg').toLowerCase()
  const key       = `photos/contact-${uuidv4()}.${ext}`
  const cmd       = new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, ContentType: contentType })
  const uploadUrl = await getSignedUrl(s3, cmd, { expiresIn: 3600 })
  const publicUrl = `${R2_PUBLIC_URL}/${key}`

  return c.json({ uploadUrl, publicUrl })
})

app.post('/webhook/admin/patients/upload-avatar-url', async (c) => {
  const body        = await c.req.json().catch(() => ({} as Record<string, unknown>))
  const contentType = (body.contentType as string) || 'image/jpeg'
  const filename    = (body.filename    as string) || 'photo.jpg'

  if (!R2_BUCKET) return c.json({ error: 'R2 not configured' }, 503)

  const ext       = (filename.split('.').pop() || 'jpg').toLowerCase()
  const key       = `photos/patient-avatar-${uuidv4()}.${ext}`
  const cmd       = new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, ContentType: contentType })
  const uploadUrl = await getSignedUrl(s3, cmd, { expiresIn: 3600 })
  const publicUrl = `${R2_PUBLIC_URL}/${key}`

  return c.json({ uploadUrl, publicUrl })
})

// ============================================================
// PHOTOS
// ============================================================

app.get('/webhook/admin/photos/list', (c) => {
  const patientId = c.req.query('patientId')
  if (!patientId) return c.json({ success: false, error: 'patientId required' }, 400)

  const photos = db.prepare(`
    SELECT photo_id AS photoId, url, NULLIF(thumbnail_url, '') AS thumbnailUrl,
           NULLIF(caption, '') AS caption, sort_order AS "order"
    FROM photos WHERE patient_id = ? ORDER BY sort_order
  `).all(patientId)
  return c.json({ photos })
})

app.post('/webhook/admin/photos/upload-url', async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>))
  const patientId   = body.patientId   as string | undefined
  const contentType = (body.contentType as string | undefined) || 'image/webp'
  if (!patientId) return c.json({ success: false, error: 'patientId required' }, 400)
  if (!R2_BUCKET) return c.json({ error: 'R2 not configured' }, 503)

  const photoId        = uuidv4()
  const key            = `patients/${patientId}/${photoId}/photo.webp`
  const thumbKey       = `patients/${patientId}/${photoId}/thumb.webp`
  const publicUrl      = `${R2_PUBLIC_URL}/${key}`
  const thumbPublicUrl = `${R2_PUBLIC_URL}/${thumbKey}`

  db.prepare(`INSERT INTO pending_uploads (photo_id, patient_id, s3_key, public_url, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(photoId, patientId, key, publicUrl, Date.now())

  const [uploadUrl, thumbUploadUrl] = await Promise.all([
    getSignedUrl(s3, new PutObjectCommand({ Bucket: R2_BUCKET, Key: key,      ContentType: contentType }),   { expiresIn: 3600 }),
    getSignedUrl(s3, new PutObjectCommand({ Bucket: R2_BUCKET, Key: thumbKey, ContentType: 'image/webp' }), { expiresIn: 3600 }),
  ])

  return c.json({ photoId, uploadUrl, publicUrl, thumbUploadUrl, thumbPublicUrl })
})

app.post('/webhook/admin/photos/confirm', async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>))
  const patientId = body.patientId as string | undefined
  const photoId   = body.photoId   as string | undefined
  if (!patientId || !photoId) return c.json({ success: false, error: 'patientId and photoId required' }, 400)

  const pending  = db.prepare(`SELECT public_url FROM pending_uploads WHERE photo_id = ?`).get(photoId) as { public_url: string } | undefined
  const url      = pending?.public_url || (body.url as string) || `${R2_PUBLIC_URL}/patients/${patientId}/${photoId}/photo.webp`
  if (pending) db.prepare(`DELETE FROM pending_uploads WHERE photo_id = ?`).run(photoId)

  // thumbnailUrl may be passed by client; fall back to deterministic path
  const thumbUrl = (body.thumbnailUrl as string) || `${R2_PUBLIC_URL}/patients/${patientId}/${photoId}/thumb.webp`
  const order    = (db.prepare(`SELECT COUNT(*) AS n FROM photos WHERE patient_id = ?`).get(patientId) as { n: number }).n
  db.prepare(`INSERT INTO photos (photo_id, patient_id, url, thumbnail_url, sort_order) VALUES (?, ?, ?, ?, ?)`)
    .run(photoId, patientId, url, thumbUrl, order)

  return c.json({ photoId, url, thumbnailUrl: thumbUrl, order })
})

app.delete('/webhook/admin/photos/delete', async (c) => {
  const photoId = c.req.query('photoId')
  if (!photoId) return c.json({ success: false, error: 'photoId required' }, 400)

  const ph = db.prepare(`SELECT patient_id, url, thumbnail_url FROM photos WHERE photo_id = ?`).get(photoId) as { patient_id: string; url: string; thumbnail_url: string } | undefined
  if (!ph) return c.json({ success: false, error: 'Photo not found' }, 404)

  if (R2_BUCKET) {
    const keys = [ph.url, ph.thumbnail_url].filter(Boolean).map(u => u.replace(`${R2_PUBLIC_URL}/`, ''))
    for (const key of keys) {
      try { await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key })) }
      catch (err) { console.error('[r2] delete error:', err) }
    }
  }

  db.prepare(`DELETE FROM photos WHERE photo_id = ?`).run(photoId)

  const remaining = db.prepare(`SELECT photo_id FROM photos WHERE patient_id = ? ORDER BY sort_order`).all(ph.patient_id) as { photo_id: string }[]
  const reorder   = db.prepare(`UPDATE photos SET sort_order = ? WHERE photo_id = ?`)
  db.transaction(() => { remaining.forEach((r, i) => reorder.run(i, r.photo_id)) })()

  return c.json({ success: true })
})

app.put('/webhook/admin/photos/order', async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>))
  const patientId = body.patientId as string | undefined
  const photoIds  = body.photoIds  as string[] | undefined
  if (!patientId || !Array.isArray(photoIds))
    return c.json({ success: false, error: 'patientId and photoIds[] required' }, 400)

  const reorder = db.prepare(`UPDATE photos SET sort_order = ? WHERE photo_id = ? AND patient_id = ?`)
  db.transaction(() => { photoIds.forEach((pid, i) => reorder.run(i, pid, patientId)) })()

  return c.json({ success: true })
})

app.put('/webhook/admin/photos/caption', async (c) => {
  const body    = await c.req.json().catch(() => ({} as Record<string, unknown>))
  const photoId = body.photoId as string | undefined
  const caption = (body.caption as string | undefined) ?? ''
  if (!photoId) return c.json({ error: 'photoId required' }, 400)

  const result = db.prepare(`UPDATE photos SET caption = ? WHERE photo_id = ?`).run(caption, photoId)
  if (result.changes === 0) return c.json({ error: 'Photo not found' }, 404)
  return c.json({ photoId, caption: caption || null })
})

// One-shot migration: creates thumbnails for every photo that doesn't have one yet.
// Downloads the original from its public URL, resizes to 600px WebP, uploads to R2.
app.post('/webhook/admin/photos/migrate-thumbnails', async (c) => {
  if (!R2_BUCKET) return c.json({ error: 'R2 not configured' }, 503)

  const photos = db.prepare(`
    SELECT photo_id AS photoId, patient_id AS patientId, url
    FROM photos WHERE thumbnail_url = '' ORDER BY sort_order
  `).all() as { photoId: string; patientId: string; url: string }[]

  if (photos.length === 0) return c.json({ total: 0, ok: 0, failed: 0, results: [] })

  const { default: sharp } = await import('sharp')
  const results: { photoId: string; ok: boolean; thumbUrl?: string; error?: string }[] = []

  for (const photo of photos) {
    try {
      const resp = await fetch(photo.url)
      if (!resp.ok) throw new Error(`HTTP ${resp.status} fetching ${photo.url}`)
      const buf = Buffer.from(await resp.arrayBuffer())

      const thumbBuf = await sharp(buf)
        .resize(600, 600, { fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 75 })
        .toBuffer()

      const thumbKey = `patients/${photo.patientId}/${photo.photoId}/thumb.webp`
      const thumbUrl = `${R2_PUBLIC_URL}/${thumbKey}`

      await s3.send(new PutObjectCommand({
        Bucket:      R2_BUCKET,
        Key:         thumbKey,
        Body:        thumbBuf,
        ContentType: 'image/webp',
      }))

      db.prepare(`UPDATE photos SET thumbnail_url = ? WHERE photo_id = ?`).run(thumbUrl, photo.photoId)
      results.push({ photoId: photo.photoId, ok: true, thumbUrl })
    } catch (err) {
      results.push({ photoId: photo.photoId, ok: false, error: String(err) })
    }
  }

  const ok     = results.filter(r => r.ok).length
  const failed = results.filter(r => !r.ok).length
  return c.json({ total: photos.length, ok, failed, results })
})

// ============================================================
// TABLET
// ============================================================

app.post('/webhook/tablet/register', async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>))
  const deviceId = body.deviceId as string | undefined
  if (!deviceId) return c.json({ success: false, error: 'deviceId required' }, 400)
  // Registration just acknowledges the device ID; pairing to a patient happens via admin UI
  return c.json({ success: true })
})

app.get('/webhook/tablet/:deviceId/sync', (c) => {
  const deviceId = c.req.param('deviceId')

  const p = db.prepare(`
    SELECT patient_id AS patientId, name, status
    FROM patients WHERE device_id = ?
  `).get(deviceId) as { patientId: string; name: string; status: string } | undefined
  if (!p) return c.json({ success: false, error: 'Device not paired' }, 404)

  const contacts = db.prepare(`
    SELECT contact_id AS contactId, name, whatsapp_number AS whatsappNumber,
           call_type AS callType, NULLIF(profile_photo_url, '') AS profilePhotoUrl,
           NULLIF(color, '') AS color, sort_order AS "order"
    FROM contacts WHERE patient_id = ? ORDER BY sort_order
  `).all(p.patientId)

  const photos = db.prepare(`
    SELECT photo_id AS photoId, url, NULLIF(thumbnail_url, '') AS thumbnailUrl,
           NULLIF(caption, '') AS caption, sort_order AS "order"
    FROM photos WHERE patient_id = ? ORDER BY sort_order
  `).all(p.patientId)

  const callRequests = db.prepare(`
    SELECT cr.request_id AS requestId, cr.contact_id AS contactId, c.name,
           NULLIF(c.profile_photo_url, '') AS profilePhotoUrl,
           cr.created_at AS createdAt
    FROM call_requests cr
    JOIN contacts c ON c.contact_id = cr.contact_id
    WHERE cr.patient_id = ? AND cr.dismissed = 0
    ORDER BY cr.created_at
  `).all(p.patientId)

  const settingsRow = db.prepare(`SELECT * FROM kiosk_settings WHERE patient_id = ?`).get(p.patientId) as Record<string, unknown> | undefined
  const settings = {
    slideInterval:     (settingsRow?.slide_interval      ?? 8)  as number,
    resumeDelay:       (settingsRow?.resume_delay         ?? 3)  as number,
    nightStart:        (settingsRow?.night_start          ?? 21) as number,
    nightEnd:          (settingsRow?.night_end            ?? 7)  as number,
    nightBrightness:   (settingsRow?.night_brightness     ?? 25) as number,
    nightEnabled:      ((settingsRow?.night_enabled       ?? 1) as number) === 1,
    kenBurns:          ((settingsRow?.ken_burns           ?? 1) as number) === 1,
    unlockPin:         (settingsRow?.unlock_pin           ?? '1234') as string,
    restartHour:       (settingsRow?.restart_hour         ?? -1)  as number,
    ringtone:          (settingsRow?.ringtone             ?? 'digital') as string,
    ringVolume:        (settingsRow?.ring_volume          ?? 80)  as number,
    screenTimeoutMs:   (settingsRow?.screen_timeout_ms    ?? 60000) as number,
    timezone:          (settingsRow?.timezone             ?? '') as string,
    fontScale:         (settingsRow?.font_scale           ?? 1.0) as number,
    orientation:       (settingsRow?.orientation          ?? 'landscape') as string,
    btDeviceAddress:   (settingsRow?.bt_device_address    ?? '') as string,
    accessibilityMode: ((settingsRow?.accessibility_mode  ?? 0) as number) === 1,
  }

  // Consume any pending one-shot command (delete-on-read); parse JSON if structured
  const cmdRow = db.prepare(`SELECT command FROM tablet_commands WHERE device_id = ?`).get(deviceId) as { command: string } | undefined
  if (cmdRow) db.prepare(`DELETE FROM tablet_commands WHERE device_id = ?`).run(deviceId)
  let command: unknown = cmdRow?.command ?? null
  if (command && typeof command === 'string') {
    try { command = JSON.parse(command) } catch {}
  }

  return c.json({ ...p, contacts, photos, callRequests, settings, command })
})

// Send a one-shot command to a tablet.
// Legacy string commands: "reload" | "reset"
// Structured object commands: { type: "restart" } | { type: "set-brightness", level: 0.7 }
//   | { type: "wifi-add", ssid, password, security } | { type: "clear-cache" }
app.post('/webhook/admin/tablet/:deviceId/command', async (c) => {
  const deviceId = c.req.param('deviceId')
  const body     = await c.req.json().catch(() => ({} as Record<string, unknown>))
  const rawCmd   = body.command

  if (rawCmd === undefined) return c.json({ error: 'command required' }, 400)

  const stored = typeof rawCmd === 'string' ? rawCmd : JSON.stringify(rawCmd)

  db.prepare(`
    INSERT INTO tablet_commands (device_id, command) VALUES (?, ?)
    ON CONFLICT(device_id) DO UPDATE SET command = excluded.command
  `).run(deviceId, stored)

  return c.json({ queued: true, deviceId, command: rawCmd })
})

// Admin: wake a crashed tablet by spoofing an incoming call
app.post('/webhook/admin/tablet/:deviceId/wake', async (c) => {
  const deviceId = c.req.param('deviceId')
  const p = db.prepare(`SELECT patient_id FROM patients WHERE device_id = ?`).get(deviceId) as { patient_id: string } | undefined
  if (!p) return c.json({ error: 'Device not paired to a patient' }, 404)

  // Find any contact to attach the fake call to (so the tablet's INNER JOIN succeeds)
  const contact = db.prepare(`SELECT contact_id FROM contacts WHERE patient_id = ? LIMIT 1`).get(p.patient_id) as { contact_id: string } | undefined
  if (!contact) return c.json({ error: 'Patient has no contacts to spoof a call from' }, 400)

  const callId = `wake-${Date.now()}`
  db.prepare(`
    INSERT INTO incoming_calls (call_id, patient_id, contact_id, room_name, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(callId, p.patient_id, contact.contact_id, 'dummy-room', Date.now())

  return c.json({ success: true, callId, message: "Tablet screen will wake up within 3 seconds" })
})

// ============================================================
// CALL REQUESTS
// ============================================================

// Admin: queue a "call me back" request from a specific contact
app.post('/webhook/admin/patients/:patientId/call-request', async (c) => {
  const patientId = c.req.param('patientId')
  const body      = await c.req.json().catch(() => ({} as Record<string, unknown>))
  const contactId = body.contactId as string | undefined
  if (!contactId) return c.json({ error: 'contactId required' }, 400)

  if (!db.prepare(`SELECT patient_id FROM patients WHERE patient_id = ?`).get(patientId))
    return c.json({ error: 'Patient not found' }, 404)
  if (!db.prepare(`SELECT contact_id FROM contacts WHERE contact_id = ? AND patient_id = ?`).get(contactId, patientId))
    return c.json({ error: 'Contact not found for this patient' }, 404)

  const requestId = uuidv4()
  const now       = Date.now()
  db.prepare(`INSERT INTO call_requests (request_id, patient_id, contact_id, created_at) VALUES (?, ?, ?, ?)`)
    .run(requestId, patientId, contactId, now)

  return c.json({ requestId, contactId, createdAt: now })
})

// Admin: cancel a pending call request
app.delete('/webhook/admin/call-request/:requestId', (c) => {
  const requestId = c.req.param('requestId')
  const result = db.prepare(`UPDATE call_requests SET dismissed = 1 WHERE request_id = ? AND dismissed = 0`).run(requestId)
  if (result.changes === 0) return c.json({ error: 'Request not found or already dismissed' }, 404)
  return c.json({ success: true })
})

// Tablet: dismiss a call request (patient tapped "Maybe later" or called)
app.post('/webhook/tablet/dismiss-call-request/:requestId', (c) => {
  const requestId = c.req.param('requestId')
  db.prepare(`UPDATE call_requests SET dismissed = 1 WHERE request_id = ?`).run(requestId)
  return c.json({ success: true })
})

// ============================================================
// KIOSK SETTINGS
// ============================================================

// Admin: get settings for a patient (returns defaults if not set)
app.get('/webhook/admin/patients/:patientId/settings', (c) => {
  const patientId  = c.req.param('patientId')
  if (!db.prepare(`SELECT patient_id FROM patients WHERE patient_id = ?`).get(patientId))
    return c.json({ error: 'Patient not found' }, 404)
  const settingsRow = db.prepare(`SELECT * FROM kiosk_settings WHERE patient_id = ?`).get(patientId) as Record<string, unknown> | undefined
  return c.json({
    slideInterval:     (settingsRow?.slide_interval      ?? 8)  as number,
    resumeDelay:       (settingsRow?.resume_delay         ?? 3)  as number,
    nightStart:        (settingsRow?.night_start          ?? 21) as number,
    nightEnd:          (settingsRow?.night_end            ?? 7)  as number,
    nightBrightness:   (settingsRow?.night_brightness     ?? 25) as number,
    nightEnabled:      ((settingsRow?.night_enabled       ?? 1) as number) === 1,
    kenBurns:          ((settingsRow?.ken_burns           ?? 1) as number) === 1,
    unlockPin:         (settingsRow?.unlock_pin           ?? '1234') as string,
    restartHour:       (settingsRow?.restart_hour         ?? -1)  as number,
    ringtone:          (settingsRow?.ringtone             ?? 'digital') as string,
    ringVolume:        (settingsRow?.ring_volume          ?? 80)  as number,
    screenTimeoutMs:   (settingsRow?.screen_timeout_ms    ?? 60000) as number,
    timezone:          (settingsRow?.timezone             ?? '') as string,
    fontScale:         (settingsRow?.font_scale           ?? 1.0) as number,
    orientation:       (settingsRow?.orientation          ?? 'landscape') as string,
    btDeviceAddress:   (settingsRow?.bt_device_address    ?? '') as string,
    accessibilityMode: ((settingsRow?.accessibility_mode  ?? 0) as number) === 1,
  })
})

// Admin: update settings for a patient
app.put('/webhook/admin/patients/:patientId/settings', async (c) => {
  const patientId = c.req.param('patientId')
  const body      = await c.req.json().catch(() => ({} as Record<string, unknown>))

  if (!db.prepare(`SELECT patient_id FROM patients WHERE patient_id = ?`).get(patientId))
    return c.json({ error: 'Patient not found' }, 404)

  const ringtone = (() => {
    const v = body.ringtone as string
    if (!v) return 'digital'
    if (['digital', 'classic', 'gentle'].includes(v)) return v
    if (/^(content|file):\/\//.test(v)) return v
    return 'digital'
  })()
  const orientation = ['landscape', 'portrait', 'auto'].includes(body.orientation as string)
    ? body.orientation : 'landscape'
  const fontScale   = Math.min(2.0, Math.max(0.8, Number(body.fontScale ?? 1.0) || 1.0))
  const ringVolume  = Math.min(100, Math.max(0, Number(body.ringVolume ?? 80) | 0))

  db.prepare(`
    INSERT INTO kiosk_settings (
      patient_id, slide_interval, resume_delay, night_start, night_end, night_brightness,
      night_enabled, ken_burns, unlock_pin, restart_hour, ringtone,
      ring_volume, screen_timeout_ms, timezone, font_scale, orientation, bt_device_address,
      accessibility_mode
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(patient_id) DO UPDATE SET
      slide_interval     = excluded.slide_interval,
      resume_delay       = excluded.resume_delay,
      night_start        = excluded.night_start,
      night_end          = excluded.night_end,
      night_brightness   = excluded.night_brightness,
      night_enabled      = excluded.night_enabled,
      ken_burns          = excluded.ken_burns,
      unlock_pin         = excluded.unlock_pin,
      restart_hour       = excluded.restart_hour,
      ringtone           = excluded.ringtone,
      ring_volume        = excluded.ring_volume,
      screen_timeout_ms  = excluded.screen_timeout_ms,
      timezone           = excluded.timezone,
      font_scale         = excluded.font_scale,
      orientation        = excluded.orientation,
      bt_device_address  = excluded.bt_device_address,
      accessibility_mode = excluded.accessibility_mode
  `).run(
    patientId,
    body.slideInterval      ?? 8,
    body.resumeDelay        ?? 3,
    body.nightStart         ?? 21,
    body.nightEnd           ?? 7,
    body.nightBrightness    ?? 25,
    body.nightEnabled       === false ? 0 : 1,
    body.kenBurns           === false ? 0 : 1,
    String(body.unlockPin   ?? '1234'),
    body.restartHour        ?? -1,
    ringtone,
    ringVolume,
    body.screenTimeoutMs    ?? 60000,
    String(body.timezone    ?? ''),
    fontScale,
    orientation,
    String(body.btDeviceAddress ?? ''),
    body.accessibilityMode  === true ? 1 : 0,
  )

  const settingsRow = db.prepare(`SELECT * FROM kiosk_settings WHERE patient_id = ?`).get(patientId) as Record<string, unknown>
  return c.json({
    slideInterval:     settingsRow.slide_interval     as number,
    resumeDelay:       settingsRow.resume_delay        as number,
    nightStart:        settingsRow.night_start         as number,
    nightEnd:          settingsRow.night_end           as number,
    nightBrightness:   settingsRow.night_brightness    as number,
    nightEnabled:      (settingsRow.night_enabled      as number) === 1,
    kenBurns:          (settingsRow.ken_burns          as number) === 1,
    unlockPin:         settingsRow.unlock_pin          as string,
    restartHour:       settingsRow.restart_hour        as number,
    ringtone:          settingsRow.ringtone            as string,
    ringVolume:        settingsRow.ring_volume         as number,
    screenTimeoutMs:   settingsRow.screen_timeout_ms   as number,
    timezone:          settingsRow.timezone            as string,
    fontScale:         settingsRow.font_scale          as number,
    orientation:       settingsRow.orientation         as string,
    btDeviceAddress:   settingsRow.bt_device_address   as string,
    accessibilityMode: (settingsRow.accessibility_mode as number) === 1,
  })
})

// ============================================================
// LIVEKIT CALLING
// ============================================================

function makeLivekitToken(roomName: string, identity: string, isPublisher: boolean, displayName: string) {
  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity,
    name: displayName,
    ttl: 3600, // 1 hour
  })
  at.addGrant({
    roomJoin:     true,
    room:         roomName,
    canPublish:   isPublisher,
    canSubscribe: true,
  })
  return at.toJwt()
}

// Kiosk: Henry taps a contact — create room, return kiosk token, notify family
app.post('/webhook/call/initiate', async (c) => {
  const body      = await c.req.json().catch(() => ({} as Record<string, unknown>))
  const patientId = body.patientId as string
  const contactId = body.contactId as string

  if (!patientId || !contactId)
    return c.json({ error: 'patientId and contactId are required' }, 400)

  // Rate limit: one outgoing call per patient per 45 seconds
  const lastCall = callRateLimit.get(patientId) ?? 0
  if (Date.now() - lastCall < 45_000)
    return c.json({ error: 'Please wait before calling again' }, 429)
  callRateLimit.set(patientId, Date.now())

  const patient = db.prepare(`SELECT * FROM patients WHERE patient_id = ?`).get(patientId) as Record<string, string> | undefined
  const contact = db.prepare(`SELECT * FROM contacts WHERE contact_id = ? AND patient_id = ?`).get(contactId, patientId) as Record<string, string> | undefined

  if (!patient) return c.json({ error: 'Patient not found' }, 404)
  if (!contact) return c.json({ error: 'Contact not found' }, 404)

  const roomName   = `call-${patientId}-${contactId}-${Date.now()}`
  const kioskToken = await makeLivekitToken(roomName, `patient-${patientId}`, true, patient.name)

  db.prepare(`INSERT OR REPLACE INTO active_rooms (room_name, patient_id, started_at) VALUES (?, ?, ?)`)
    .run(roomName, patientId, Date.now())

  db.prepare(`INSERT OR IGNORE INTO room_invites (room_name, contact_id) VALUES (?, ?)`).run(roomName, contactId)

  // Notify all registered family devices for this contact
  const devices = db.prepare(`SELECT * FROM family_devices WHERE contact_id = ?`).all(contactId) as { device_id: string; device_token: string | null; fcm_token: string; platform: string; push_subscription: string | null }[]
  const baseJoinUrl = `${process.env.FAMILY_APP_URL || 'https://family-call.looknet.ca'}?room=${roomName}&contact=${encodeURIComponent(contact.name)}&patient=${encodeURIComponent(patient.name)}`

  for (const device of devices) {
    if (device.platform === 'android' && FCM_SERVICE_ACCOUNT) {
      const joinUrl = `${baseJoinUrl}`
      await sendFcmNotification(device.fcm_token, {
        title: `${patient.name} wants to call`,
        body:  'Tap to answer',
        data:  { roomName, joinUrl, patientName: patient.name, contactName: contact.name },
      }).catch(err => console.error('[fcm] send failed:', err))
    }
    if (device.platform === 'web' && device.push_subscription && VAPID_PUBLIC_KEY) {
      // Include deviceId + deviceToken in the URL so the SW can decline on behalf of the user
      const joinUrl = `${baseJoinUrl}&deviceId=${encodeURIComponent(device.device_id)}&deviceToken=${encodeURIComponent(device.device_token ?? '')}`
      webpush.sendNotification(
        JSON.parse(device.push_subscription),
        JSON.stringify({ title: `${patient.name} wants to call`, body: 'Tap to answer', url: joinUrl })
      ).catch(err => console.error('[webpush] send failed:', err))
    }
  }

  return c.json({ roomName, token: await kioskToken, wsUrl: LIVEKIT_WS_URL })
})

// Kiosk: Invite another contact to an ongoing call
app.post('/webhook/call/invite', async (c) => {
  const body = await c.req.json().catch(() => ({} as Record<string, unknown>))
  const patientId = body.patientId as string
  const contactId = body.contactId as string
  const roomName  = body.roomName  as string

  if (!patientId || !contactId || !roomName) return c.json({ error: 'patientId, contactId, and roomName required' }, 400)

  const patient = db.prepare(`SELECT * FROM patients WHERE patient_id = ?`).get(patientId) as Record<string, string> | undefined
  const contact = db.prepare(`SELECT * FROM contacts WHERE contact_id = ? AND patient_id = ?`).get(contactId, patientId) as Record<string, string> | undefined
  if (!patient || !contact) return c.json({ error: 'Patient or Contact not found' }, 404)

  db.prepare(`INSERT OR IGNORE INTO room_invites (room_name, contact_id) VALUES (?, ?)`).run(roomName, contactId)

  const devices = db.prepare(`SELECT * FROM family_devices WHERE contact_id = ?`).all(contactId) as { device_id: string; device_token: string | null; fcm_token: string; platform: string; push_subscription: string | null }[]
  const baseJoinUrl = `${process.env.FAMILY_APP_URL || 'https://family-call.looknet.ca'}?room=${roomName}&contact=${encodeURIComponent(contact.name)}&patient=${encodeURIComponent(patient.name)}`

  for (const device of devices) {
    if (device.platform === 'android' && FCM_SERVICE_ACCOUNT) {
      await sendFcmNotification(device.fcm_token, {
        title: `${patient.name} added you to a call`,
        body:  'Tap to join them',
        data:  { roomName, joinUrl: baseJoinUrl, patientName: patient.name, contactName: contact.name },
      }).catch(err => console.error('[fcm] send failed:', err))
    }
    if (device.platform === 'web' && device.push_subscription && VAPID_PUBLIC_KEY) {
      const joinUrl = `${baseJoinUrl}&deviceId=${encodeURIComponent(device.device_id)}&deviceToken=${encodeURIComponent(device.device_token ?? '')}`
      webpush.sendNotification(JSON.parse(device.push_subscription), JSON.stringify({ title: `${patient.name} added you to a call`, body: 'Tap to join them', url: joinUrl })).catch(err => console.error('[webpush] send failed:', err))
    }
  }
  return c.json({ success: true })
})

// Family app / PWA: get a token to join an existing room
app.post('/call/join', async (c) => {
  const body        = await c.req.json().catch(() => ({} as Record<string, unknown>))
  const roomName    = body.roomName   as string
  const deviceId    = body.deviceId   as string
  const familyName  = body.familyName as string | undefined
  const deviceToken = c.req.header('x-device-token')

  if (!roomName || !deviceId)
    return c.json({ error: 'roomName and deviceId are required' }, 400)

  if (!verifyDeviceToken(deviceId, deviceToken))
    return c.json({ error: 'Unauthorized' }, 401)

  const device  = db.prepare(`SELECT fd.*, c.name AS contact_name FROM family_devices fd JOIN contacts c ON c.contact_id = fd.contact_id WHERE fd.device_id = ?`).get(deviceId) as Record<string, string> | undefined
  const display = familyName || device?.contact_name || 'Family'
  const token   = await makeLivekitToken(roomName, `family-${deviceId}`, true, display)

  return c.json({ token, wsUrl: LIVEKIT_WS_URL })
})

// Kiosk: join an existing room created by family (no API key required)
app.post('/call/kiosk-join', async (c) => {
  const body      = await c.req.json().catch(() => ({} as Record<string, unknown>))
  const roomName  = body.roomName  as string
  const patientId = body.patientId as string

  if (!roomName || !patientId)
    return c.json({ error: 'roomName and patientId are required' }, 400)

  const patient = db.prepare(`SELECT name FROM patients WHERE patient_id = ?`).get(patientId) as { name: string } | undefined
  if (!patient) return c.json({ error: 'Patient not found' }, 404)

  const token = await makeLivekitToken(roomName, `patient-${patientId}`, true, patient.name)
  return c.json({ token, wsUrl: LIVEKIT_WS_URL })
})

// Kiosk: poll for incoming calls from family
app.get('/kiosk/patient/:patientId/incoming-call', (c) => {
  const patientId = c.req.param('patientId')
  const deviceId  = c.req.query('deviceId')

  // deviceId is required — reject unauthenticated polls
  if (!deviceId) return c.json(null)
  const registered = db.prepare(`SELECT patient_id FROM patients WHERE device_id = ?`).get(deviceId) as { patient_id: string } | undefined
  if (!registered || registered.patient_id !== patientId) return c.json(null)

  const cutoff    = Date.now() - 90_000 // ignore calls older than 90s
  const call      = db.prepare(`
    SELECT ic.call_id AS callId, ic.contact_id AS contactId, ic.room_name AS roomName, c.name AS contactName,
           NULLIF(c.profile_photo_url, '') AS profilePhotoUrl
    FROM incoming_calls ic
    JOIN contacts c ON c.contact_id = ic.contact_id
    WHERE ic.patient_id = ? AND ic.answered = 0 AND ic.declined = 0 AND ic.created_at > ?
    ORDER BY ic.created_at
    LIMIT 1
  `).get(patientId, cutoff)
  return c.json(call ?? null)
})

app.post('/kiosk/incoming-call/:callId/answer', (c) => {
  db.prepare(`UPDATE incoming_calls SET answered = 1 WHERE call_id = ?`).run(c.req.param('callId'))
  return c.json({ success: true })
})

app.post('/kiosk/incoming-call/:callId/decline', async (c) => {
  const callId = c.req.param('callId')
  db.prepare(`UPDATE incoming_calls SET declined = 1 WHERE call_id = ?`).run(callId)
  const row = db.prepare(`SELECT room_name FROM incoming_calls WHERE call_id = ?`).get(callId) as { room_name: string } | undefined
  if (row?.room_name) {
    try {
      const svc = new RoomServiceClient(LIVEKIT_WS_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
      await svc.deleteRoom(row.room_name)
    } catch { /* room may already be gone */ }
    db.prepare(`DELETE FROM active_rooms WHERE room_name = ?`).run(row.room_name)
    db.prepare(`DELETE FROM room_invites WHERE room_name = ?`).run(row.room_name)
  }
  return c.json({ success: true })
})

// Family APK: initiate a call to the patient
app.post('/family/device/:deviceId/call', async (c) => {
  const deviceId = c.req.param('deviceId')
  if (!verifyDeviceToken(deviceId, c.req.header('x-device-token')))
    return c.json({ error: 'Unauthorized' }, 401)
  const device   = db.prepare(`
    SELECT fd.contact_id, c.name AS contactName, c.patient_id, p.name AS patientName
    FROM family_devices fd
    JOIN contacts c ON c.contact_id = fd.contact_id
    JOIN patients p ON p.patient_id = c.patient_id
    WHERE fd.device_id = ?
  `).get(deviceId) as { contact_id: string; contactName: string; patient_id: string; patientName: string } | undefined

  if (!device) return c.json({ error: 'Device not registered' }, 404)

  // Busy check: reject if the kiosk is already in a confirmed active call
  const stale4h = Date.now() - 4 * 60 * 60 * 1000
  const busy = db.prepare(`
    SELECT 1 FROM active_rooms WHERE patient_id = ? AND confirmed = 1 AND started_at > ? LIMIT 1
  `).get(device.patient_id, stale4h)
  if (busy) return c.json({ busy: true }, 409)

  const roomName = `call-${device.patient_id}-${device.contact_id}-${Date.now()}`
  const token    = await makeLivekitToken(roomName, `family-${deviceId}`, true, device.contactName)
  const callId   = uuidv4()

  db.prepare(`INSERT INTO incoming_calls (call_id, patient_id, contact_id, room_name, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(callId, device.patient_id, device.contact_id, roomName, Date.now())

  db.prepare(`INSERT OR REPLACE INTO active_rooms (room_name, patient_id, started_at) VALUES (?, ?, ?)`)
    .run(roomName, device.patient_id, Date.now())

  // Family initiator gets an invite so they can rejoin if they drop out
  db.prepare(`INSERT OR IGNORE INTO room_invites (room_name, contact_id) VALUES (?, ?)`).run(roomName, device.contact_id)

  const joinUrl = `${process.env.FAMILY_APP_URL || 'https://family-call.looknet.ca'}?room=${roomName}&contact=${encodeURIComponent(device.contactName)}&patient=${encodeURIComponent(device.patientName)}&caller=1`

  return c.json({ roomName, token, wsUrl: LIVEKIT_WS_URL, joinUrl, patientName: device.patientName, callId })
})

// Livekit webhook — clears active room when call ends
app.post('/webhooks/livekit', async (c) => {
  const body       = await c.req.text()
  const authHeader = c.req.header('Authorization') ?? ''
  try {
    const receiver = new WebhookReceiver(LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
    const event    = await receiver.receive(body, authHeader)
    if (event.event === 'room_started' && event.room?.name) {
      // Livekit confirmed the room is live — mark confirmed and refresh TTL
      db.prepare(`UPDATE active_rooms SET confirmed = 1, started_at = ? WHERE room_name = ?`).run(Date.now(), event.room.name)
    }
    if (event.event === 'participant_left' && event.room?.name) {
      // If the patient leaves, end the call for everyone to prevent ghost calls
      if (event.participant?.identity?.startsWith('patient-')) {
        db.prepare(`DELETE FROM active_rooms WHERE room_name = ?`).run(event.room.name)
        db.prepare(`DELETE FROM room_invites WHERE room_name = ?`).run(event.room.name)
      }
    }
    if (event.event === 'room_finished' && event.room?.name) {
      db.prepare(`DELETE FROM active_rooms WHERE room_name = ?`).run(event.room.name)
      db.prepare(`DELETE FROM room_invites WHERE room_name = ?`).run(event.room.name)
    }
  } catch {
    return c.json({ error: 'invalid signature' }, 401)
  }
  return c.json({ ok: true })
})

// Admin: force-confirm an active room (test/debug only — requires API key)
app.post('/webhook/admin/rooms/:roomName/confirm', (c) => {
  const roomName = c.req.param('roomName')
  const result   = db.prepare(`UPDATE active_rooms SET confirmed = 1, started_at = ? WHERE room_name = ?`).run(Date.now(), roomName)
  if (result.changes === 0) return c.json({ error: 'Room not found' }, 404)
  return c.json({ ok: true })
})

// Admin: delete an active room (test/debug only — requires API key)
app.delete('/webhook/admin/rooms/:roomName', (c) => {
  const roomName = c.req.param('roomName')
  db.prepare(`DELETE FROM active_rooms  WHERE room_name = ?`).run(roomName)
  db.prepare(`DELETE FROM room_invites  WHERE room_name = ?`).run(roomName)
  return c.json({ ok: true })
})

// Family APK: check if patient is currently on a call
app.get('/family/device/:deviceId/patient-status', (c) => {
  const deviceId = c.req.param('deviceId')
  if (!verifyDeviceToken(deviceId, c.req.header('x-device-token')))
    return c.json({ error: 'Unauthorized' }, 401)
  const device = db.prepare(`
    SELECT c.contact_id, c.name AS contactName, c.patient_id, p.name AS patientName,
           NULLIF(p.profile_photo_url, '') AS patientPhotoUrl,
           p.device_id AS kioskDeviceId
    FROM family_devices fd
    JOIN contacts c ON c.contact_id = fd.contact_id
    JOIN patients p ON p.patient_id = c.patient_id
    WHERE fd.device_id = ?
  `).get(deviceId) as { contact_id: string; contactName: string; patient_id: string; patientName: string; patientPhotoUrl: string | null; kioskDeviceId: string } | undefined
  if (!device) return c.json({ inCall: false })
  const stale4h  = Date.now() - 4 * 60 * 60 * 1000
  const stale5m  = Date.now() - 5 * 60 * 1000
  const active = db.prepare(`
    SELECT ar.room_name, EXISTS(SELECT 1 FROM room_invites ri WHERE ri.room_name = ar.room_name AND ri.contact_id = ?) AS is_invited
    FROM active_rooms ar
    WHERE patient_id = ?
      AND ((confirmed = 1 AND started_at > ?) OR (confirmed = 0 AND started_at > ?))
    ORDER BY started_at DESC LIMIT 1
  `).get(device.contact_id, device.patient_id, stale4h, stale5m) as { room_name: string, is_invited: number } | undefined
  // Pull kiosk last-seen from the storage-report heartbeat
  const heartbeat = db.prepare(`SELECT reported_at FROM device_storage WHERE device_id = ?`)
    .get(device.kioskDeviceId) as { reported_at: number } | undefined
  const photoUrl   = device.patientPhotoUrl ?? null
  const lastSeenAt = heartbeat?.reported_at ?? null
  const base       = { patientName: device.patientName, patientPhotoUrl: photoUrl, lastSeenAt }
  if (active) {
    if (active.is_invited === 1) return c.json({ ...base, inCall: true, joinUrl: `${process.env.FAMILY_APP_URL || 'https://family-call.looknet.ca'}?room=${active.room_name}&contact=${encodeURIComponent(device.contactName)}&patient=${encodeURIComponent(device.patientName)}&caller=1` })
    return c.json({ ...base, inCall: true })
  }
  return c.json({ ...base, inCall: false })
})

// Family: recent call history (last 20 calls involving this device's patient)
app.get('/family/device/:deviceId/call-history', (c) => {
  const deviceId = c.req.param('deviceId')
  if (!verifyDeviceToken(deviceId, c.req.header('x-device-token')))
    return c.json({ error: 'Unauthorized' }, 401)
  const device = db.prepare(`
    SELECT c.patient_id
    FROM family_devices fd
    JOIN contacts c ON c.contact_id = fd.contact_id
    WHERE fd.device_id = ?
  `).get(deviceId) as { patient_id: string } | undefined
  if (!device) return c.json({ calls: [] })
  const calls = db.prepare(`
    SELECT ic.call_id    AS callId,
           ic.created_at AS startedAt,
           ic.answered,
           ic.declined,
           co.name       AS contactName
    FROM incoming_calls ic
    JOIN contacts co ON co.contact_id = ic.contact_id
    WHERE ic.patient_id = ?
      AND ic.room_name != 'dummy-room'
    ORDER BY ic.created_at DESC
    LIMIT 20
  `).all(device.patient_id) as { callId: string; startedAt: number; answered: number; declined: number; contactName: string }[]
  return c.json({ calls })
})

// Family PWA: decline an incoming call from the notification action (SW posts here)
app.post('/family/device/:deviceId/call/decline', async (c) => {
  const deviceId = c.req.param('deviceId')
  if (!verifyDeviceToken(deviceId, c.req.header('x-device-token')))
    return c.json({ error: 'Unauthorized' }, 401)

  const body = await c.req.json().catch(() => ({} as Record<string, unknown>))
  const roomName = body.roomName as string | undefined
  if (!roomName) return c.json({ error: 'roomName required' }, 400)

  const call = db.prepare(`SELECT call_id FROM incoming_calls WHERE room_name = ? AND declined = 0 AND answered = 0`).get(roomName) as { call_id: string } | undefined
  if (!call) return c.json({ success: true }) // already handled

  db.prepare(`UPDATE incoming_calls SET declined = 1 WHERE call_id = ?`).run(call.call_id)
  try {
    const svc = new RoomServiceClient(LIVEKIT_WS_URL, LIVEKIT_API_KEY, LIVEKIT_API_SECRET)
    await svc.deleteRoom(roomName)
  } catch { /* room may already be gone */ }
  db.prepare(`DELETE FROM active_rooms WHERE room_name = ?`).run(roomName)
  db.prepare(`DELETE FROM room_invites WHERE room_name = ?`).run(roomName)

  return c.json({ success: true })
})

// Family: request a callback from the patient's kiosk
app.post('/family/device/:deviceId/callback-request', (c) => {
  const deviceId = c.req.param('deviceId')
  if (!verifyDeviceToken(deviceId, c.req.header('x-device-token')))
    return c.json({ error: 'Unauthorized' }, 401)

  const device = db.prepare(`
    SELECT fd.contact_id, c.patient_id
    FROM family_devices fd
    JOIN contacts c ON c.contact_id = fd.contact_id
    WHERE fd.device_id = ?
  `).get(deviceId) as { contact_id: string; patient_id: string } | undefined
  if (!device) return c.json({ error: 'Device not registered' }, 404)

  // Return existing pending request rather than stacking duplicates
  const existing = db.prepare(`
    SELECT request_id, created_at FROM call_requests
    WHERE patient_id = ? AND contact_id = ? AND dismissed = 0
    ORDER BY created_at DESC LIMIT 1
  `).get(device.patient_id, device.contact_id) as { request_id: string; created_at: number } | undefined
  if (existing) return c.json({ requestId: existing.request_id, createdAt: existing.created_at, existing: true })

  const requestId = uuidv4()
  const now       = Date.now()
  db.prepare(`INSERT INTO call_requests (request_id, patient_id, contact_id, created_at) VALUES (?, ?, ?, ?)`)
    .run(requestId, device.patient_id, device.contact_id, now)

  return c.json({ requestId, createdAt: now })
})

// Family: cancel a pending callback request
app.delete('/family/device/:deviceId/callback-request/:requestId', (c) => {
  const deviceId  = c.req.param('deviceId')
  const requestId = c.req.param('requestId')
  if (!verifyDeviceToken(deviceId, c.req.header('x-device-token')))
    return c.json({ error: 'Unauthorized' }, 401)

  const device = db.prepare(`
    SELECT fd.contact_id FROM family_devices fd
    JOIN contacts c ON c.contact_id = fd.contact_id
    WHERE fd.device_id = ?
  `).get(deviceId) as { contact_id: string } | undefined
  if (!device) return c.json({ error: 'Device not registered' }, 404)

  const result = db.prepare(`
    UPDATE call_requests SET dismissed = 1
    WHERE request_id = ? AND contact_id = ? AND dismissed = 0
  `).run(requestId, device.contact_id)
  if (result.changes === 0) return c.json({ error: 'Request not found or already dismissed' }, 404)
  return c.json({ success: true })
})

// ── FCM v1 helpers ─────────────────────────────────────────────

function makeFcmJwt(sa: { client_email: string; private_key: string }): string {
  const now = Math.floor(Date.now() / 1000)
  const header  = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
  const body    = Buffer.from(JSON.stringify({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })).toString('base64url')
  const sign = crypto.createSign('RSA-SHA256')
  sign.update(`${header}.${body}`)
  return `${header}.${body}.${sign.sign(sa.private_key, 'base64url')}`
}

async function getFcmAccessToken(sa: { client_email: string; private_key: string }): Promise<string> {
  const res  = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion:  makeFcmJwt(sa),
    }),
  })
  const json = await res.json() as { access_token: string }
  return json.access_token
}

async function sendFcmNotification(fcmToken: string, payload: { title: string; body: string; data: Record<string, string> }) {
  const sa          = JSON.parse(FCM_SERVICE_ACCOUNT) as { client_email: string; private_key: string; project_id: string }
  const accessToken = await getFcmAccessToken(sa)
  await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({
      message: {
        token:   fcmToken,
        // Data-only message — no `notification` field. When `notification` is present,
        // the FCM SDK swallows the message in the background and never calls
        // onMessageReceived, so IncomingCallActivity and the custom ringer never fire.
        data:    { ...payload.data, title: payload.title, body: payload.body },
        android: { priority: 'high' },
      },
    }),
  })
}

// ============================================================
// FAMILY DEVICE PAIRING
// ============================================================

// Admin: list paired devices for a contact
app.get('/webhook/admin/contacts/:contactId/devices', (c) => {
  const contactId = c.req.param('contactId')
  const devices = db.prepare(`
    SELECT device_id AS deviceId, platform, registered_at AS registeredAt
    FROM family_devices WHERE contact_id = ? ORDER BY registered_at DESC
  `).all(contactId)
  return c.json({ devices })
})

// Admin: remove a paired device
app.delete('/webhook/admin/contacts/:contactId/devices/:deviceId', (c) => {
  const { contactId, deviceId } = c.req.param()
  db.prepare(`DELETE FROM family_devices WHERE device_id = ? AND contact_id = ?`).run(deviceId, contactId)
  return c.json({ success: true })
})

// Admin: generate a pairing token for a contact (shown as QR code in admin UI)
app.post('/webhook/admin/contacts/:contactId/pairing-token', (c) => {
  const contactId = c.req.param('contactId')
  if (!db.prepare(`SELECT contact_id FROM contacts WHERE contact_id = ?`).get(contactId))
    return c.json({ error: 'Contact not found' }, 404)

  // Clean up expired tokens for this contact
  db.prepare(`DELETE FROM pairing_tokens WHERE contact_id = ? OR expires_at < ?`).run(contactId, Date.now())

  const token     = uuidv4()
  const expiresAt = Date.now() + 15 * 60 * 1000 // 15 minutes
  db.prepare(`INSERT INTO pairing_tokens (token, contact_id, expires_at) VALUES (?, ?, ?)`).run(token, contactId, expiresAt)

  return c.json({ token, expiresAt })
})

// Family APK: redeem pairing token and register device + FCM token (no API key required)
app.post('/family/pair', async (c) => {
  const body      = await c.req.json().catch(() => ({} as Record<string, unknown>))
  const token     = body.token    as string
  const fcmToken  = body.fcmToken as string
  const deviceId  = body.deviceId as string
  const platform  = (body.platform as string) || 'android'

  if (!token || !deviceId)
    return c.json({ error: 'token and deviceId are required' }, 400)

  const row = db.prepare(`SELECT * FROM pairing_tokens WHERE token = ? AND expires_at > ?`).get(token, Date.now()) as { contact_id: string } | undefined
  if (!row) return c.json({ error: 'Invalid or expired pairing token' }, 401)

  const deviceToken = crypto.randomBytes(32).toString('hex')

  db.prepare(`
    INSERT INTO family_devices (device_id, contact_id, fcm_token, platform, registered_at, device_token)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET fcm_token = excluded.fcm_token, platform = excluded.platform, registered_at = excluded.registered_at, device_token = excluded.device_token
  `).run(deviceId, row.contact_id, fcmToken, platform, Date.now(), deviceToken)

  // Consume the pairing token
  db.prepare(`DELETE FROM pairing_tokens WHERE token = ?`).run(token)

  const contact = db.prepare(`SELECT c.name, p.name AS patientName, NULLIF(p.profile_photo_url, '') AS patientPhotoUrl FROM contacts c JOIN patients p ON p.patient_id = c.patient_id WHERE c.contact_id = ?`).get(row.contact_id) as { name: string; patientName: string; patientPhotoUrl: string | null }
  return c.json({ success: true, contactId: row.contact_id, contactName: contact.name, patientName: contact.patientName, patientPhotoUrl: contact.patientPhotoUrl, deviceToken })
})

// Family APK: update FCM token (called on app start if token refreshed)
app.put('/family/device/:deviceId/fcm-token', async (c) => {
  const deviceId = c.req.param('deviceId')
  if (!verifyDeviceToken(deviceId, c.req.header('x-device-token')))
    return c.json({ error: 'Unauthorized' }, 401)
  const body     = await c.req.json().catch(() => ({} as Record<string, unknown>))
  const fcmToken = body.fcmToken as string

  if (!fcmToken) return c.json({ error: 'fcmToken required' }, 400)

  const result = db.prepare(`UPDATE family_devices SET fcm_token = ? WHERE device_id = ?`).run(fcmToken, deviceId)
  if (result.changes === 0) return c.json({ error: 'Device not found' }, 404)

  return c.json({ success: true })
})

// Family PWA: save or update Web Push subscription
app.put('/family/device/:deviceId/push-subscription', async (c) => {
  const deviceId   = c.req.param('deviceId')
  if (!verifyDeviceToken(deviceId, c.req.header('x-device-token')))
    return c.json({ error: 'Unauthorized' }, 401)
  const body       = await c.req.json().catch(() => ({} as Record<string, unknown>))
  const sub        = body.subscription

  if (!sub) return c.json({ error: 'subscription required' }, 400)

  const result = db.prepare(`UPDATE family_devices SET push_subscription = ? WHERE device_id = ?`)
    .run(JSON.stringify(sub), deviceId)
  if (result.changes === 0) return c.json({ error: 'Device not found' }, 404)

  return c.json({ success: true })
})

// ============================================================
// STORAGE REPORT (tablet → backend)
// ============================================================

app.post('/webhook/tablet/:deviceId/storage-report', async (c) => {
  const deviceId = c.req.param('deviceId')
  const body     = await c.req.json().catch(() => ({} as Record<string, unknown>))

  db.prepare(`
    INSERT INTO device_storage (
      device_id, cache_bytes, free_bytes, total_bytes, cached_photo_count,
      battery_level, battery_charging, lock_task_active, uptime_ms,
      wifi_ssid, wifi_signal, wifi_connected, wifi_available, wifi_known,
      volume_ring, bt_connected, bt_device_name, bt_devices, ringtones,
      device_manufacturer, device_model, android_version, android_sdk,
      timezone_str, font_scale, orientation, apk_version,
      ram_total_bytes, ram_used_bytes, ram_low_memory, reported_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(device_id) DO UPDATE SET
      cache_bytes        = excluded.cache_bytes,
      free_bytes         = excluded.free_bytes,
      total_bytes        = excluded.total_bytes,
      cached_photo_count = excluded.cached_photo_count,
      battery_level      = excluded.battery_level,
      battery_charging   = excluded.battery_charging,
      lock_task_active   = excluded.lock_task_active,
      uptime_ms          = excluded.uptime_ms,
      wifi_ssid          = excluded.wifi_ssid,
      wifi_signal        = excluded.wifi_signal,
      wifi_connected     = excluded.wifi_connected,
      wifi_available     = excluded.wifi_available,
      wifi_known         = excluded.wifi_known,
      volume_ring        = excluded.volume_ring,
      bt_connected       = excluded.bt_connected,
      bt_device_name     = excluded.bt_device_name,
      bt_devices         = excluded.bt_devices,
      ringtones          = excluded.ringtones,
      device_manufacturer = excluded.device_manufacturer,
      device_model       = excluded.device_model,
      android_version    = excluded.android_version,
      android_sdk        = excluded.android_sdk,
      timezone_str       = excluded.timezone_str,
      font_scale         = excluded.font_scale,
      orientation        = excluded.orientation,
      apk_version        = excluded.apk_version,
      ram_total_bytes    = excluded.ram_total_bytes,
      ram_used_bytes     = excluded.ram_used_bytes,
      ram_low_memory     = excluded.ram_low_memory,
      reported_at        = excluded.reported_at
  `).run(
    deviceId,
    body.cacheBytes        ?? 0,
    body.freeBytes         ?? 0,
    body.totalBytes        ?? 0,
    body.cachedPhotoCount  ?? 0,
    body.batteryLevel      ?? -1,
    body.batteryCharging   ? 1 : 0,
    body.lockTaskActive    ? 1 : 0,
    body.uptimeMs          ?? 0,
    body.wifiSsid          ?? '',
    body.wifiSignal        ?? -1,
    body.wifiConnected     ? 1 : 0,
    JSON.stringify(Array.isArray(body.wifiAvailable) ? body.wifiAvailable : []),
    JSON.stringify(Array.isArray(body.wifiKnown)     ? body.wifiKnown     : []),
    body.volumeRing        ?? -1,
    body.btConnected       ? 1 : 0,
    body.btDeviceName      ?? '',
    JSON.stringify(Array.isArray(body.btDevices)  ? body.btDevices  : []),
    JSON.stringify(Array.isArray(body.ringtones)  ? body.ringtones  : []),
    body.deviceManufacturer ?? '',
    body.deviceModel        ?? '',
    body.androidVersion     ?? '',
    body.androidSdk         ?? 0,
    body.timezone           ?? '',
    body.fontScale          ?? 1.0,
    body.orientation        ?? 'landscape',
    body.apkVersion         ?? 0,
    body.ramTotalBytes      ?? 0,
    body.ramUsedBytes       ?? 0,
    body.ramLowMemory       ? 1 : 0,
    Date.now(),
  )

  return c.json({ ok: true })
})

// Admin: fetch device health report for a tablet
app.get('/webhook/admin/tablet/:deviceId/storage', (c) => {
  const deviceId = c.req.param('deviceId')
  const row = db.prepare(`SELECT * FROM device_storage WHERE device_id = ?`).get(deviceId) as Record<string, unknown> | undefined
  if (!row) return c.json(null)
  return c.json({
    cacheBytes:          row.cache_bytes         as number,
    freeBytes:           row.free_bytes          as number,
    totalBytes:          row.total_bytes         as number,
    cachedPhotoCount:    row.cached_photo_count  as number,
    batteryLevel:        row.battery_level       as number,
    batteryCharging:     (row.battery_charging   as number) === 1,
    lockTaskActive:      (row.lock_task_active   as number) === 1,
    uptimeMs:            row.uptime_ms           as number,
    wifiSsid:            row.wifi_ssid           as string,
    wifiSignal:          row.wifi_signal         as number,
    wifiConnected:       (row.wifi_connected     as number) === 1,
    wifiAvailable:       JSON.parse((row.wifi_available as string) || '[]'),
    wifiKnown:           JSON.parse((row.wifi_known     as string) || '[]'),
    volumeRing:          row.volume_ring         as number,
    btConnected:         (row.bt_connected       as number) === 1,
    btDeviceName:        row.bt_device_name      as string,
    btDevices:           JSON.parse((row.bt_devices  as string) || '[]'),
    ringtones:           JSON.parse((row.ringtones   as string) || '[]'),
    deviceManufacturer:  row.device_manufacturer as string,
    deviceModel:         row.device_model        as string,
    androidVersion:      row.android_version     as string,
    androidSdk:          row.android_sdk         as number,
    timezone:            row.timezone_str        as string,
    fontScale:           row.font_scale          as number,
    orientation:         row.orientation         as string,
    apkVersion:          row.apk_version         as number,
    ramTotalBytes:       row.ram_total_bytes     as number,
    ramUsedBytes:        row.ram_used_bytes      as number,
    ramLowMemory:        (row.ram_low_memory     as number) === 1,
    reportedAt:          row.reported_at         as number,
  })
})

// ============================================================
// DEVICE LOGS
// ============================================================

const LOG_TTL_MS = 7 * 24 * 60 * 60 * 1000

app.post('/tablet/:deviceId/logs', async (c) => {
  const deviceId = c.req.param('deviceId')
  const body     = await c.req.json().catch(() => ({} as Record<string, unknown>))
  const lines    = body.lines as Array<{ loggedAt: number; level: string; tag: string; message: string }> | undefined
  if (!Array.isArray(lines) || lines.length === 0) return c.json({ ok: true, inserted: 0 })

  const cutoff = Date.now() - LOG_TTL_MS
  db.prepare(`DELETE FROM device_logs WHERE logged_at < ?`).run(cutoff)

  const insert = db.prepare(`INSERT INTO device_logs (device_id, logged_at, level, tag, message) VALUES (?, ?, ?, ?, ?)`)
  const insertMany = db.transaction((rows: typeof lines) => {
    for (const r of rows) {
      insert.run(deviceId, r.loggedAt ?? Date.now(), (r.level ?? 'I').slice(0, 1), (r.tag ?? '').slice(0, 64), (r.message ?? '').slice(0, 2048))
    }
  })
  insertMany(lines)
  return c.json({ ok: true, inserted: lines.length })
})

app.get('/webhook/admin/tablet/:deviceId/logs', (c) => {
  const deviceId   = c.req.param('deviceId')
  const limit      = Math.min(parseInt(c.req.query('limit') ?? '500'), 2000)
  const since      = parseInt(c.req.query('since') ?? '0')
  const levelParam = c.req.query('level')   // e.g. "E", "W", "I", "D", "V"
  const tagParam   = c.req.query('tag')     // exact tag match
  const textParam  = c.req.query('text')    // substring match on message

  // Level hierarchy — only return rows at or above the requested severity
  const LEVELS = ['V', 'D', 'I', 'W', 'E']
  const minIdx = levelParam ? LEVELS.indexOf(levelParam.toUpperCase()) : 0
  const allowedLevels = minIdx >= 0 ? LEVELS.slice(minIdx) : LEVELS

  const conditions: string[] = ['device_id = ?', 'logged_at > ?']
  const params: unknown[]    = [deviceId, since]

  if (allowedLevels.length < LEVELS.length) {
    conditions.push(`level IN (${allowedLevels.map(() => '?').join(',')})`)
    params.push(...allowedLevels)
  }
  if (tagParam) {
    conditions.push('tag = ?')
    params.push(tagParam)
  }
  if (textParam) {
    conditions.push('message LIKE ?')
    params.push(`%${textParam}%`)
  }

  params.push(limit)
  const logs = db.prepare(`
    SELECT id, logged_at AS loggedAt, level, tag, message
    FROM device_logs
    WHERE ${conditions.join(' AND ')}
    ORDER BY logged_at DESC LIMIT ?
  `).all(...params)
  return c.json({ logs })
})

// ============================================================
// APK RELEASES
// ============================================================

// Public — kiosk APK polls this (no auth)
app.get('/kiosk/apk/latest', (c) => {
  const row = db.prepare(`SELECT * FROM apk_releases ORDER BY version DESC LIMIT 1`).get() as Record<string, unknown> | undefined
  if (!row) return c.json({ version: 0 })
  return c.json({ version: row.version, url: row.url, sha256: row.sha256 })
})

// Public — download latest APK via presigned R2 URL (no auth, for provisioning)
app.get('/kiosk/apk/download', async (c) => {
  const row = db.prepare(`SELECT * FROM apk_releases ORDER BY version DESC LIMIT 1`).get() as Record<string, unknown> | undefined
  if (!row) return c.json({ error: 'no release' }, 404)
  if (!R2_BUCKET) return c.json({ error: 'R2 not configured' }, 503)

  const key = (row.url as string).split(`${R2_PUBLIC_URL}/`)[1] ?? `apk/family-kiosk-v${row.version}.apk`
  const cmd = new GetObjectCommand({ Bucket: R2_BUCKET, Key: key })
  const obj = await s3.send(cmd)
  if (!obj.Body) return c.json({ error: 'empty object' }, 500)

      return new Response(obj.Body as ReadableStream, {
    headers: {
      'Content-Type':        'application/vnd.android.package-archive',
      'Content-Length':      String(obj.ContentLength ?? ''),
      'Content-Disposition': `attachment; filename="family-kiosk-v${row.version}.apk"`,
      'Cache-Control':       'public, max-age=3600',
    },
  })
})


// Admin: get latest APK info (authed)
app.get('/webhook/admin/apk/latest', (c) => {
  const row = db.prepare(`SELECT * FROM apk_releases ORDER BY version DESC LIMIT 1`).get() as Record<string, unknown> | undefined
  if (!row) return c.json({ version: 0 })
  return c.json({ version: row.version, url: row.url, sha256: row.sha256, releasedAt: row.released_at })
})

// Admin: get presigned upload URL for a new APK
app.post('/webhook/admin/apk/upload-url', async (c) => {
  const body    = await c.req.json().catch(() => ({} as Record<string, unknown>))
  const version = body.version as number | undefined
  if (!version) return c.json({ error: 'version required' }, 400)
  if (!R2_BUCKET) return c.json({ error: 'R2 not configured' }, 503)

  const key       = `apk/family-kiosk-v${version}.apk`
  const cmd       = new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, ContentType: 'application/vnd.android.package-archive' })
  const uploadUrl = await getSignedUrl(s3, cmd, { expiresIn: 3600 })
  const publicUrl = `${R2_PUBLIC_URL}/${key}`

  return c.json({ uploadUrl, publicUrl })
})

// Admin: record a new APK release after upload
app.post('/webhook/admin/apk/release', async (c) => {
  const body    = await c.req.json().catch(() => ({} as Record<string, unknown>))
  const version = body.version as number | undefined
  const url     = body.url     as string | undefined
  const sha256  = body.sha256  as string | undefined

  if (!version || !url || !sha256) return c.json({ error: 'version, url, sha256 required' }, 400)

  db.prepare(`
    INSERT INTO apk_releases (version, url, sha256, released_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(version) DO UPDATE SET url = excluded.url, sha256 = excluded.sha256, released_at = excluded.released_at
  `).run(version, url, sha256, Date.now())

  return c.json({ ok: true, version })
})

// Admin: delete an APK release
app.delete('/webhook/admin/apk/release/:version', async (c) => {
  const version = parseInt(c.req.param('version'))
  if (isNaN(version)) return c.json({ error: 'invalid version' }, 400)

  const release = db.prepare(`SELECT url FROM apk_releases WHERE version = ?`).get(version) as { url: string } | undefined
  if (!release) return c.json({ error: 'Release not found' }, 404)

  // Clean up the actual APK file from R2
  if (R2_BUCKET && release.url.startsWith(R2_PUBLIC_URL)) {
    try {
      const key = release.url.replace(`${R2_PUBLIC_URL}/`, '')
      await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }))
    } catch (err) {
      console.error('[r2] delete apk error:', err)
    }
  }

  db.prepare(`DELETE FROM apk_releases WHERE version = ?`).run(version)
  return c.json({ success: true, version })
})

// ============================================================
// FAMILY APK RELEASES
// ============================================================

// Public — family app polls this (no auth)
app.get('/family/apk/latest', (c) => {
  const row = db.prepare(`SELECT * FROM family_apk_releases ORDER BY version DESC LIMIT 1`).get() as Record<string, unknown> | undefined
  if (!row) return c.json({ version: 0 })
  return c.json({ version: row.version, url: row.url, sha256: row.sha256 })
})

// Public — download latest family APK via presigned R2 URL
app.get('/family/apk/download', async (c) => {
  const row = db.prepare(`SELECT * FROM family_apk_releases ORDER BY version DESC LIMIT 1`).get() as Record<string, unknown> | undefined
  if (!row) return c.json({ error: 'no release' }, 404)
  if (!R2_BUCKET) return c.json({ error: 'R2 not configured' }, 503)

  const key = (row.url as string).split(`${R2_PUBLIC_URL}/`)[1] ?? `apk/family-app-v${row.version}.apk`
  const cmd = new GetObjectCommand({ Bucket: R2_BUCKET, Key: key })
  const obj = await s3.send(cmd)
  if (!obj.Body) return c.json({ error: 'empty object' }, 500)

  return new Response(obj.Body as ReadableStream, {
    headers: {
      'Content-Type':        'application/vnd.android.package-archive',
      'Content-Length':      String(obj.ContentLength ?? ''),
      'Content-Disposition': `attachment; filename="family-app-v${row.version}.apk"`,
      'Cache-Control':       'public, max-age=3600',
    },
  })
})

// Admin: get latest family APK info (authed)
app.get('/webhook/admin/family-apk/latest', (c) => {
  const row = db.prepare(`SELECT * FROM family_apk_releases ORDER BY version DESC LIMIT 1`).get() as Record<string, unknown> | undefined
  if (!row) return c.json({ version: 0 })
  return c.json({ version: row.version, url: row.url, sha256: row.sha256, releasedAt: row.released_at })
})

// Admin: get presigned upload URL for a new family APK
app.post('/webhook/admin/family-apk/upload-url', async (c) => {
  const body    = await c.req.json().catch(() => ({} as Record<string, unknown>))
  const version = body.version as number | undefined
  if (!version) return c.json({ error: 'version required' }, 400)
  if (!R2_BUCKET) return c.json({ error: 'R2 not configured' }, 503)

  const key       = `apk/family-app-v${version}.apk`
  const cmd       = new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, ContentType: 'application/vnd.android.package-archive' })
  const uploadUrl = await getSignedUrl(s3, cmd, { expiresIn: 3600 })
  const publicUrl = `${R2_PUBLIC_URL}/${key}`

  return c.json({ uploadUrl, publicUrl })
})

// Admin: record a new family APK release after upload
app.post('/webhook/admin/family-apk/release', async (c) => {
  const body    = await c.req.json().catch(() => ({} as Record<string, unknown>))
  const version = body.version as number | undefined
  const url     = body.url     as string | undefined
  const sha256  = body.sha256  as string | undefined

  if (!version || !url || !sha256) return c.json({ error: 'version, url, sha256 required' }, 400)

  db.prepare(`
    INSERT INTO family_apk_releases (version, url, sha256, released_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(version) DO UPDATE SET url = excluded.url, sha256 = excluded.sha256, released_at = excluded.released_at
  `).run(version, url, sha256, Date.now())

  return c.json({ ok: true, version })
})

// Admin: push an FCM update_check message to all paired Android family devices
app.post('/webhook/admin/family-apk/push-update', async (c) => {
  if (!FCM_SERVICE_ACCOUNT) return c.json({ error: 'FCM not configured' }, 503)

  const devices = db.prepare(`SELECT device_id, fcm_token FROM family_devices WHERE platform = 'android'`).all() as { device_id: string; fcm_token: string }[]
  if (devices.length === 0) return c.json({ sent: 0, failed: 0 })

  let sent = 0, failed = 0
  await Promise.all(devices.map(async (d) => {
    try {
      await sendFcmNotification(d.fcm_token, { title: '', body: '', data: { type: 'update_check' } })
      sent++
    } catch (err) {
      console.error(`[fcm] update_check failed for ${d.device_id}:`, err)
      failed++
    }
  }))

  return c.json({ sent, failed })
})

// Admin: delete a family APK release
app.delete('/webhook/admin/family-apk/release/:version', async (c) => {
  const version = parseInt(c.req.param('version'))
  if (isNaN(version)) return c.json({ error: 'invalid version' }, 400)

  const release = db.prepare(`SELECT url FROM family_apk_releases WHERE version = ?`).get(version) as { url: string } | undefined
  if (!release) return c.json({ error: 'Release not found' }, 404)

  if (R2_BUCKET && release.url.startsWith(R2_PUBLIC_URL)) {
    try {
      const key = release.url.replace(`${R2_PUBLIC_URL}/`, '')
      await s3.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key }))
    } catch (err) {
      console.error('[r2] delete family apk error:', err)
    }
  }

  db.prepare(`DELETE FROM family_apk_releases WHERE version = ?`).run(version)
  return c.json({ success: true, version })
})

// ============================================================
// START
// ============================================================
serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`[api] listening on :${PORT}`)
})
