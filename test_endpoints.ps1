# =============================================================
#  Family Kiosk Backend Health Check
#  Tests all Hono/SQLite webhook endpoints with logic validation
#  and generates a formatted health report.
# =============================================================

param(
    [string]$BaseUrl        = "https://YOUR_DOMAIN/webhook",
    [string]$RootUrl        = "https://YOUR_DOMAIN",
    [string]$ApiKey         = "YOUR_API_KEY",
    [int]   $ThrottleMs     = 0   # e.g. 200 when running via VPN to avoid CF rate limits
)

$script:Headers = @{ "x-api-key" = $ApiKey; "Content-Type" = "application/json" }
$Results  = [System.Collections.Generic.List[PSCustomObject]]::new()

function ts { Get-Date -Format "HH:mm:ss.fff" }

function Invoke-Test {
    param(
        [string]      $Name,
        [string]      $Method,
        [string]      $Path,
        [hashtable]   $ExtraHeaders = @{},
        [object]      $Body         = $null,
        [scriptblock] $Validate,
        [int[]]       $PassOnCodes  = @(),
        [string]      $Base         = $BaseUrl,
        [int]         $TimeoutSec   = 15
    )

    $url = "$Base$Path"
    $url += if ($url -match "\?") { "&_t=$(Get-Random)" } else { "?_t=$(Get-Random)" }

    $h = $script:Headers.Clone()
    if ($ExtraHeaders) { foreach ($k in $ExtraHeaders.Keys) { $h[$k] = $ExtraHeaders[$k] } }

    $rec = [PSCustomObject]@{ Name=$Name; Pass=$false; Code=$null; Ms=$null; Note="" }

    try {
        $p = @{ Uri=$url; Method=$Method; Headers=$h; ErrorAction="Stop"; TimeoutSec=$TimeoutSec }
        if ($Body) { $p.Body = ($Body | ConvertTo-Json -Depth 10 -Compress) }

        $t0       = [datetime]::UtcNow
        $response = Invoke-RestMethod @p
        if ($response -is [array] -and $response.Count -eq 1) { $response = $response[0] }

        $rec.Ms   = [math]::Round(([datetime]::UtcNow - $t0).TotalMilliseconds)
        $rec.Code = 200

        $vr = & $Validate $response
        if ($vr -eq $true) { $rec.Pass=$true; $rec.Note="OK" }
        else {
            $errDump = if ($response) {
                if ($response.error) { " (Error: $($response.error))" }
                else { " (Raw: $(($response | ConvertTo-Json -Compress -Depth 3) -replace '\"',"'"))" }
            } else { "" }
            $rec.Note = if ($vr) { "$vr$errDump" } else { "Validation returned false$errDump" }
        }
        $script:Results.Add($rec)
        if ($ThrottleMs -gt 0) { Start-Sleep -Milliseconds $ThrottleMs }
        return $response

    } catch {
        if ($t0) { $rec.Ms = [math]::Round(([datetime]::UtcNow - $t0).TotalMilliseconds) }
        $rec.Code = [int]($_.Exception.Response.StatusCode)
        $msg = $_.Exception.Message -replace "`n"," "
        if ($_.Exception.Response) {
            try {
                $reader  = [System.IO.StreamReader]::new($_.Exception.Response.GetResponseStream())
                $errBody = $reader.ReadToEnd()
                if ($errBody) { $json = $errBody | ConvertFrom-Json; if ($json.message) { $msg = $json.message } }
            } catch {}
        }
        if ($PassOnCodes -contains $rec.Code) { $rec.Pass=$true; $rec.Note="OK ($($rec.Code))" }
        else { $rec.Note = $msg }
        $script:Results.Add($rec)
        if ($ThrottleMs -gt 0) { Start-Sleep -Milliseconds $ThrottleMs }
        return $null
    }
}

# ─────────────────────────────────────────────────────────────
Write-Host ""
Write-Host ("=" * 62) -ForegroundColor Cyan
Write-Host "  Family Kiosk Backend Health Check" -ForegroundColor Cyan
Write-Host "  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -ForegroundColor Cyan
Write-Host "  $BaseUrl" -ForegroundColor Cyan
Write-Host ("=" * 62) -ForegroundColor Cyan
Write-Host ""

# =============================================================
#  PHASE 0: HEALTH
# =============================================================
Write-Host "[ Phase 0: Health ]" -ForegroundColor Yellow

$null = Invoke-Test -Name "Health: GET /health" -Method GET -Path "/health" -Base $RootUrl -Validate {
    param($r)
    if (-not $r.ok) { return "ok != true" }
    $true
}

# =============================================================
#  PHASE 1: CONNECTIVITY (all endpoints, 400/404 counts as OK)
# =============================================================
Write-Host ""
Write-Host "[ Phase 1: Connectivity ]" -ForegroundColor Yellow

$Endpoints = @(
    # Patients
    @{ Name="Patients List";              Method="GET";    Path="/admin/patients/list" }
    @{ Name="Patients Create";            Method="POST";   Path="/admin/patients/create" }
    @{ Name="Patients Get";               Method="GET";    Path="/admin/patients/get" }
    @{ Name="Patients Update";            Method="PUT";    Path="/admin/patients/update" }
    @{ Name="Patients Delete";            Method="DELETE"; Path="/admin/patients/delete" }
    # Contacts
    @{ Name="Contacts List";              Method="GET";    Path="/admin/contacts/list" }
    @{ Name="Contacts Create";            Method="POST";   Path="/admin/contacts/create" }
    @{ Name="Contacts Update";            Method="PUT";    Path="/admin/contacts/update" }
    @{ Name="Contacts Delete";            Method="DELETE"; Path="/admin/contacts/delete" }
    @{ Name="Contacts Reorder";           Method="PUT";    Path="/admin/contacts/order" }
    @{ Name="Contact Photo URL";          Method="POST";   Path="/admin/contacts/upload-photo-url" }
    @{ Name="Contact Devices List";       Method="GET";    Path="/admin/contacts/x/devices" }
    @{ Name="Contact Device Delete";      Method="DELETE"; Path="/admin/contacts/x/devices/y" }
    # Photos
    @{ Name="Photos List";                Method="GET";    Path="/admin/photos/list" }
    @{ Name="Photos Upload URL";          Method="POST";   Path="/admin/photos/upload-url" }
    @{ Name="Photos Confirm";             Method="POST";   Path="/admin/photos/confirm" }
    @{ Name="Photos Delete";              Method="DELETE"; Path="/admin/photos/delete" }
    @{ Name="Photos Reorder";             Method="PUT";    Path="/admin/photos/order" }
    @{ Name="Photos Caption";             Method="PUT";    Path="/admin/photos/caption" }
    @{ Name="Photos Migrate Thumbs";      Method="POST";   Path="/admin/photos/migrate-thumbnails"; TimeoutSec=300 }
    # Call requests
    @{ Name="Call Request Create";        Method="POST";   Path="/admin/patients/x/call-request" }
    @{ Name="Call Request Cancel";        Method="DELETE"; Path="/admin/call-request/x" }
    # Kiosk settings
    @{ Name="Settings Get";               Method="GET";    Path="/admin/patients/x/settings" }
    @{ Name="Settings Update";            Method="PUT";    Path="/admin/patients/x/settings" }
    # Tablet commands
    @{ Name="Tablet Command";             Method="POST";   Path="/admin/tablet/x/command" }
    # Tablet
    @{ Name="Tablet Register";            Method="POST";   Path="/tablet/register" }
    @{ Name="Tablet Sync";                Method="GET";    Path="/tablet/x/sync" }
    @{ Name="Tablet Wake";                Method="POST";   Path="/admin/tablet/x/wake" }
    @{ Name="Tablet Dismiss Request";     Method="POST";   Path="/tablet/dismiss-call-request/x" }
    # Storage report + device health
    @{ Name="Tablet Storage Report";      Method="POST";   Path="/tablet/x/storage-report" }
    @{ Name="Admin Device Storage";       Method="GET";    Path="/admin/tablet/x/storage" }
    # Device logs
    @{ Name="Tablet Log Upload";          Method="POST";   Path="/tablet/x/logs";                       Base=$RootUrl }
    @{ Name="Admin Device Logs";          Method="GET";    Path="/admin/tablet/x/logs?level=W&limit=100" }
    # APK releases
    @{ Name="Admin APK Latest";           Method="GET";    Path="/admin/apk/latest" }
    @{ Name="Admin APK Upload URL";       Method="POST";   Path="/admin/apk/upload-url" }
    @{ Name="Admin APK Release";          Method="POST";   Path="/admin/apk/release" }
    @{ Name="Admin APK Delete";           Method="DELETE"; Path="/admin/apk/release/999" }
    # Livekit calling
    @{ Name="Call Initiate";              Method="POST";   Path="/call/initiate" }
    @{ Name="Call Invite";                Method="POST";   Path="/call/invite" }
    @{ Name="Call Join";                  Method="POST";   Path="/call/join";                           Base=$RootUrl }
    @{ Name="Call Kiosk Join";            Method="POST";   Path="/call/kiosk-join";                     Base=$RootUrl }
    # Family device pairing
    @{ Name="Pairing Token";              Method="POST";   Path="/admin/contacts/x/pairing-token" }
    @{ Name="Family Pair";                Method="POST";   Path="/family/pair";                         Base=$RootUrl }
    @{ Name="Family FCM Update";          Method="PUT";    Path="/family/device/x/fcm-token";           Base=$RootUrl }
    @{ Name="Family Push Sub";            Method="PUT";    Path="/family/device/x/push-subscription";   Base=$RootUrl }
    @{ Name="Family Initiate Call";       Method="POST";   Path="/family/device/x/call";                Base=$RootUrl; ExtraPassCodes=@(409) }
    # Kiosk APK update check (public, no auth)
    @{ Name="Kiosk APK Latest";           Method="GET";    Path="/kiosk/apk/latest";                    Base=$RootUrl }
    @{ Name="Kiosk APK Download";         Method="GET";    Path="/kiosk/apk/download";                  Base=$RootUrl }
    # Family APK releases (admin)
    @{ Name="Admin Family APK Latest";    Method="GET";    Path="/admin/family-apk/latest" }
    @{ Name="Admin Family APK Upload URL";Method="POST";   Path="/admin/family-apk/upload-url" }
    @{ Name="Admin Family APK Release";   Method="POST";   Path="/admin/family-apk/release" }
    @{ Name="Admin Family APK Delete";    Method="DELETE"; Path="/admin/family-apk/release/999" }
    # Family APK update check (public, no auth)
    @{ Name="Family APK Latest";          Method="GET";    Path="/family/apk/latest";                   Base=$RootUrl }
    @{ Name="Family APK Download";        Method="GET";    Path="/family/apk/download";                 Base=$RootUrl }
    # Family APK push update
    @{ Name="Admin Family APK Push Update"; Method="POST"; Path="/admin/family-apk/push-update" }
    # Kiosk-side incoming call
    @{ Name="Kiosk Incoming Call";        Method="GET";    Path="/kiosk/patient/x/incoming-call?deviceId=y"; Base=$RootUrl }
    @{ Name="Kiosk Answer Call";          Method="POST";   Path="/kiosk/incoming-call/x/answer";        Base=$RootUrl }
    @{ Name="Kiosk Decline Call";         Method="POST";   Path="/kiosk/incoming-call/x/decline";       Base=$RootUrl }
    # Patient in-call status
    @{ Name="Patient Status";             Method="GET";    Path="/family/device/x/patient-status";      Base=$RootUrl }
    # Family callback request
    @{ Name="Family Callback Request";    Method="POST";   Path="/family/device/x/callback-request";    Base=$RootUrl }
    @{ Name="Family Callback Cancel";     Method="DELETE"; Path="/family/device/x/callback-request/y";  Base=$RootUrl }
    # Family PWA decline (from push notification action)
    @{ Name="Family PWA Decline Call";    Method="POST";   Path="/family/device/x/call/decline";        Base=$RootUrl }
    # Family call history
    @{ Name="Family Call History";        Method="GET";    Path="/family/device/x/call-history";        Base=$RootUrl }
    # Patient avatar upload
    @{ Name="Patient Avatar Upload URL";  Method="POST";   Path="/admin/patients/upload-avatar-url" }
    # Livekit webhook (unsigned → 401)
    @{ Name="Livekit Webhook";            Method="POST";   Path="/webhooks/livekit";                    Base=$RootUrl }
    # Admin room confirm/delete (test/debug)
    @{ Name="Admin Room Confirm";         Method="POST";   Path="/admin/rooms/nonexistent/confirm";     ExtraPassCodes=@(404) }
    @{ Name="Admin Room Delete";          Method="DELETE"; Path="/admin/rooms/nonexistent" }
)

foreach ($e in $Endpoints) {
    $t1         = [datetime]::UtcNow
    $base       = if ($e.Base) { $e.Base } else { $BaseUrl }
    $timeout    = if ($e.TimeoutSec) { $e.TimeoutSec } else { 15 }
    $passCodes  = @(400,401,404,405) + $(if ($e.ExtraPassCodes) { $e.ExtraPassCodes } else { @() })
    Write-Host ("  [$(ts)] -> {0,-10} {1}... " -f $e.Method, $e.Path) -NoNewline -ForegroundColor DarkGray
    $null = Invoke-Test -Name "Conn: $($e.Name)" -Method $e.Method -Path $e.Path `
        -PassOnCodes $passCodes -Validate { param($r) $true } -Base $base -TimeoutSec $timeout
    Write-Host "$([math]::Round(([datetime]::UtcNow - $t1).TotalMilliseconds))ms" -ForegroundColor DarkGray
}

# =============================================================
#  PHASE 2: AUTH ENFORCEMENT
# =============================================================
Write-Host ""
Write-Host "[ Phase 2: Auth Enforcement ]" -ForegroundColor Yellow

# Endpoints that require x-api-key should return 401 on bad key
$authEndpoints = @(
    @{ Name="patients/list";   Method="GET";  Path="/admin/patients/list" }
    @{ Name="photos/list";     Method="GET";  Path="/admin/photos/list" }
    @{ Name="tablet/sync";     Method="GET";  Path="/admin/tablet/E2E-TABLET/storage" }
)
foreach ($e in $authEndpoints) {
    $null = Invoke-Test -Name "Auth: Bad key on $($e.Name)" -Method $e.Method -Path $e.Path `
        -ExtraHeaders @{ "x-api-key" = "WRONG-KEY-XYZ" } `
        -Validate { param($r) "Should have returned 401" } `
        -PassOnCodes @(401)
}

$null = Invoke-Test -Name "Auth: /call/join requires device token (401)" -Method POST -Path "/call/join" -Base $RootUrl `
    -ExtraHeaders @{ "x-api-key" = "" } `
    -Body @{ roomName="test-room"; deviceId="test-device" } `
    -Validate { param($r) "Should have returned 401" } `
    -PassOnCodes @(401)

$null = Invoke-Test -Name "Auth: /call/kiosk-join requires api key (401)" -Method POST -Path "/call/kiosk-join" -Base $RootUrl `
    -ExtraHeaders @{ "x-api-key" = "" } `
    -Body @{ roomName="test-room"; patientId="test-patient" } `
    -Validate { param($r) "Should have returned 401" } `
    -PassOnCodes @(401)

$null = Invoke-Test -Name "Auth: /kiosk/patient requires api key (401)" -Method GET -Path "/kiosk/patient/x/incoming-call" -Base $RootUrl `
    -ExtraHeaders @{ "x-api-key" = "" } `
    -Validate { param($r) "Should have returned 401" } `
    -PassOnCodes @(401)

$null = Invoke-Test -Name "Auth: /family/device/call requires device token (401)" -Method POST -Path "/family/device/x/call" -Base $RootUrl `
    -ExtraHeaders @{ "x-api-key" = "" } `
    -Validate { param($r) "Should have returned 401" } `
    -PassOnCodes @(401)

$null = Invoke-Test -Name "Auth: /family/device/call/decline requires device token (401)" -Method POST -Path "/family/device/x/call/decline" -Base $RootUrl `
    -ExtraHeaders @{ "x-device-token" = "bad-token" } `
    -Body @{ roomName="test-room" } `
    -Validate { param($r) "Should have returned 401" } `
    -PassOnCodes @(401)

$null = Invoke-Test -Name "Auth: /kiosk/patient/incoming-call returns null without deviceId" -Method GET -Path "/kiosk/patient/x/incoming-call" -Base $RootUrl `
    -Validate { param($r)
        # Invoke-RestMethod deserialises JSON null as empty string or $null — both are acceptable
        if ($r -ne $null -and $r -ne "" -and $r -ne "null") { return "expected null when deviceId omitted, got: $($r | ConvertTo-Json -Compress)" }
        $true
    }

$null = Invoke-Test -Name "Auth: /kiosk/apk/latest public (no key)" -Method GET -Path "/kiosk/apk/latest" -Base $RootUrl `
    -ExtraHeaders @{ "x-api-key" = "" } `
    -Validate { param($r)
        if ($null -eq $r.version) { return "version missing" }
        $true
    }

$null = Invoke-Test -Name "Auth: /family/apk/latest public (no key)" -Method GET -Path "/family/apk/latest" -Base $RootUrl `
    -ExtraHeaders @{ "x-api-key" = "" } `
    -Validate { param($r)
        if ($null -eq $r.version) { return "version missing" }
        $true
    }

# =============================================================
#  PHASE 2b: CORS
# =============================================================
Write-Host ""
Write-Host "[ Phase 2b: CORS ]" -ForegroundColor Yellow

function Test-Cors {
    param([string]$Name, [string]$Url, [string]$Origin)
    $rec = [PSCustomObject]@{ Name=$Name; Pass=$false; Code=$null; Ms=$null; Note="" }
    $t0  = [datetime]::UtcNow
    try {
        $resp = Invoke-WebRequest -Uri $Url -Method OPTIONS -Headers @{
            "Origin"                         = $Origin
            "Access-Control-Request-Method"  = "GET"
            "Access-Control-Request-Headers" = "x-api-key"
        } -UseBasicParsing -ErrorAction Stop -TimeoutSec 15
        $rec.Ms   = [math]::Round(([datetime]::UtcNow - $t0).TotalMilliseconds)
        $rec.Code = [int]$resp.StatusCode
        $acao = $resp.Headers["Access-Control-Allow-Origin"]
        if (($rec.Code -eq 204 -or $rec.Code -eq 200) -and $acao -eq $Origin) {
            $rec.Pass = $true; $rec.Note = "OK (ACAO: $acao, status=$($rec.Code))"
        } else {
            $rec.Note = "status=$($rec.Code) ACAO='$acao' (expected 200/204 + '$Origin')"
        }
    } catch {
        $rec.Ms   = [math]::Round(([datetime]::UtcNow - $t0).TotalMilliseconds)
        $rec.Code = [int]($_.Exception.Response.StatusCode)
        $rec.Note = "Exception: $($_.Exception.Message -replace '`n',' ')"
    }
    $script:Results.Add($rec)
    if ($ThrottleMs -gt 0) { Start-Sleep -Milliseconds $ThrottleMs }
}

Test-Cors -Name "CORS: kiosk origin allowed (preflight)" `
    -Url "$RootUrl/kiosk/patient/x/incoming-call" `
    -Origin "https://YOUR_KIOSK_DOMAIN"

Test-Cors -Name "CORS: family-call origin allowed (preflight)" `
    -Url "$RootUrl/family/device/x/patient-status" `
    -Origin "https://YOUR_FAMILY_APP_URL"

Test-Cors -Name "CORS: admin origin allowed (preflight)" `
    -Url "$BaseUrl/admin/patients/list" `
    -Origin "https://family-admin.looknet.ca"

# Unknown origin should not get ACAO header (not a hard failure — just no header)
$rec = [PSCustomObject]@{ Name="CORS: unknown origin rejected"; Pass=$false; Code=$null; Ms=$null; Note="" }
$t0 = [datetime]::UtcNow
try {
    $resp = Invoke-WebRequest -Uri "$RootUrl/family/apk/latest" -Method OPTIONS -Headers @{
        "Origin"                        = "https://evil.example.com"
        "Access-Control-Request-Method" = "GET"
    } -UseBasicParsing -ErrorAction Stop -TimeoutSec 15
    $rec.Ms   = [math]::Round(([datetime]::UtcNow - $t0).TotalMilliseconds)
    $rec.Code = [int]$resp.StatusCode
    $acao     = $resp.Headers["Access-Control-Allow-Origin"]
    if ($acao -and $acao -ne "") {
        $rec.Note = "ACAO header present for unknown origin: '$acao'"
    } else {
        $rec.Pass = $true; $rec.Note = "OK (no ACAO for unknown origin)"
    }
} catch {
    $rec.Ms   = [math]::Round(([datetime]::UtcNow - $t0).TotalMilliseconds)
    $rec.Code = [int]($_.Exception.Response.StatusCode)
    $rec.Note = "Exception: $($_.Exception.Message -replace '`n',' ')"
}
$script:Results.Add($rec)

# =============================================================
#  PHASE 3: E2E SCENARIO
# =============================================================
Write-Host ""
Write-Host "[ Phase 3: E2E Logic ]" -ForegroundColor Yellow

# -- Cleanup stale E2E data ------------------------------------
Write-Host "  [$(ts)] Cleaning stale E2E data..." -ForegroundColor DarkGray
try {
    $lr = Invoke-RestMethod -Uri "$BaseUrl/admin/patients/list" -Method GET -Headers $script:Headers -TimeoutSec 15
    if ($lr -is [array]) { $lr = $lr[0] }
    $stale = $lr.patients | Where-Object { $_.name -like "E2E*" }
    foreach ($s in $stale) {
        $null = Invoke-RestMethod -Uri "$BaseUrl/admin/patients/delete?patientId=$([string]$s.patientId)" `
            -Method DELETE -Headers $script:Headers -TimeoutSec 15
        Write-Host "  [$(ts)] Removed stale patient: $($s.patientId)" -ForegroundColor DarkGray
    }
} catch { Write-Host "  [$(ts)] Cleanup warning: $($_.Exception.Message)" -ForegroundColor Yellow }

# -- Create patient + contacts ---------------------------------
Write-Host "  [$(ts)] Creating E2E patient + contacts..." -ForegroundColor DarkGray
$pr = Invoke-RestMethod -Uri "$BaseUrl/admin/patients/create" -Method POST -Headers $script:Headers -TimeoutSec 15 `
    -Body '{"name":"E2E Test Patient"}'
if ($pr -is [array]) { $pr = $pr[0] }
$e2ePid = [string]$pr.patientId
Write-Host "  [$(ts)] Patient: $e2ePid" -ForegroundColor DarkGray

$cr = Invoke-RestMethod -Uri "$BaseUrl/admin/contacts/create" -Method POST -Headers $script:Headers -TimeoutSec 15 `
    -Body "{`"patientId`":`"$e2ePid`",`"name`":`"E2E Contact`",`"callType`":`"video`"}"
if ($cr -is [array]) { $cr = $cr[0] }
$cid = [string]$cr.contactId

$cr2 = Invoke-RestMethod -Uri "$BaseUrl/admin/contacts/create" -Method POST -Headers $script:Headers -TimeoutSec 15 `
    -Body "{`"patientId`":`"$e2ePid`",`"name`":`"E2E Contact 2`",`"callType`":`"video`"}"
if ($cr2 -is [array]) { $cr2 = $cr2[0] }
$cid2 = [string]$cr2.contactId
Write-Host "  [$(ts)] Contacts: $cid / $cid2" -ForegroundColor DarkGray

# Register + assign tablet
$null = Invoke-RestMethod -Uri "$BaseUrl/tablet/register" -Method POST -Headers $script:Headers -TimeoutSec 15 `
    -Body '{"deviceId":"E2E-TABLET"}'
$null = Invoke-RestMethod -Uri "$BaseUrl/admin/patients/update" -Method PUT -Headers $script:Headers -TimeoutSec 15 `
    -Body "{`"patientId`":`"$e2ePid`",`"deviceId`":`"E2E-TABLET`"}"

Write-Host "  [$(ts)] Running E2E assertions..." -ForegroundColor DarkGray

# ── Patient / contact CRUD ────────────────────────────────────
$null = Invoke-Test -Name "E2E: Get patient" -Method GET -Path "/admin/patients/get?patientId=$e2ePid" -Validate {
    param($r)
    if ($r.patientId -ne $e2ePid)         { return "patientId mismatch" }
    if ($r.name -ne "E2E Test Patient")    { return "name mismatch" }
    if ($null -eq $r.contacts)             { return "no contacts array" }
    if ($null -eq $r.callRequests)         { return "no callRequests array" }
    if ($null -eq $r.settings)             { return "no settings object" }
    $true
}

$null = Invoke-Test -Name "E2E: Patient has no avatar initially" -Method GET -Path "/admin/patients/get?patientId=$e2ePid" -Validate {
    param($r)
    if ($r.PSObject.Properties.Name -notcontains 'profilePhotoUrl') { return "profilePhotoUrl field missing from response" }
    $true
}

$null = Invoke-Test -Name "E2E: Set patient avatar URL" -Method PUT -Path "/admin/patients/update" `
    -Body @{ patientId=$e2ePid; profilePhotoUrl="https://example.com/test-avatar.jpg" } -Validate {
    param($r)
    if ($r.profilePhotoUrl -ne "https://example.com/test-avatar.jpg") { return "profilePhotoUrl not saved: $($r.profilePhotoUrl)" }
    $true
}

$null = Invoke-Test -Name "E2E: Patient get reflects avatar" -Method GET -Path "/admin/patients/get?patientId=$e2ePid" -Validate {
    param($r)
    if ($r.profilePhotoUrl -ne "https://example.com/test-avatar.jpg") { return "profilePhotoUrl not in get: $($r.profilePhotoUrl)" }
    $true
}

$null = Invoke-Test -Name "E2E: Clear patient avatar" -Method PUT -Path "/admin/patients/update" `
    -Body @{ patientId=$e2ePid; profilePhotoUrl="" } -Validate {
    param($r)
    if ($null -ne $r.profilePhotoUrl) { return "profilePhotoUrl should be null after clear: $($r.profilePhotoUrl)" }
    $true
}

$null = Invoke-Test -Name "E2E: Both contacts in list" -Method GET -Path "/admin/contacts/list?patientId=$e2ePid" -Validate {
    param($r)
    $c1 = $r.contacts | Where-Object { $_.contactId -eq $cid }
    $c2 = $r.contacts | Where-Object { $_.contactId -eq $cid2 }
    if (-not $c1)                   { return "contact 1 not in list" }
    if (-not $c2)                   { return "contact 2 not in list" }
    if ($c1.callType -ne "video")   { return "callType mismatch: $($c1.callType)" }
    $true
}

$null = Invoke-Test -Name "E2E: Update contact" -Method PUT -Path "/admin/contacts/update" `
    -Body @{ contactId=$cid; name="E2E Contact Updated" } -Validate {
    param($r)
    if ($r.name -ne "E2E Contact Updated") { return "name not updated: $($r.name)" }
    $true
}

$null = Invoke-Test -Name "E2E: Set contact color" -Method PUT -Path "/admin/contacts/update" `
    -Body @{ contactId=$cid; color="bg-rose-500" } -Validate {
    param($r)
    if ($r.color -ne "bg-rose-500") { return "color not saved: $($r.color)" }
    $true
}

$null = Invoke-Test -Name "E2E: Contact color in list" -Method GET -Path "/admin/contacts/list?patientId=$e2ePid" -Validate {
    param($r)
    $c = $r.contacts | Where-Object { $_.contactId -eq $cid }
    if (-not $c)                    { return "contact not found" }
    if ($c.color -ne "bg-rose-500") { return "color not in list: $($c.color)" }
    $true
}

$null = Invoke-Test -Name "E2E: Contact color in tablet sync" -Method GET -Path "/tablet/E2E-TABLET/sync" -Validate {
    param($r)
    $c = $r.contacts | Where-Object { $_.contactId -eq $cid }
    if (-not $c)                    { return "contact not in sync" }
    if ($c.color -ne "bg-rose-500") { return "color not in sync: $($c.color)" }
    $true
}

$null = Invoke-Test -Name "E2E: Clear contact color (auto)" -Method PUT -Path "/admin/contacts/update" `
    -Body @{ contactId=$cid; color="" } -Validate {
    param($r)
    if ($null -ne $r.color) { return "color should be null after clear: $($r.color)" }
    $true
}

# ── Contact reorder ───────────────────────────────────────────
$null = Invoke-Test -Name "E2E: Reorder contacts (cid2 first)" -Method PUT -Path "/admin/contacts/order" `
    -Body @{ patientId=$e2ePid; contactIds=@($cid2, $cid) } -Validate {
    param($r)
    if (-not $r.success) { return "success != true" }
    $true
}

$null = Invoke-Test -Name "E2E: Contact order reflected in list" -Method GET -Path "/admin/contacts/list?patientId=$e2ePid" -Validate {
    param($r)
    $first = $r.contacts[0]
    if ($first.contactId -ne $cid2) { return "expected $cid2 first, got $($first.contactId)" }
    $true
}

# ── Photo lifecycle ───────────────────────────────────────────
$pu1Raw = Invoke-Test -Name "E2E: Get photo 1 upload URL" -Method POST -Path "/admin/photos/upload-url" `
    -Body @{ patientId=$e2ePid; contentType="image/webp" } -Validate {
    param($r)
    if (-not $r.photoId)        { return "photoId missing" }
    if (-not $r.uploadUrl)      { return "uploadUrl missing" }
    if (-not $r.publicUrl)      { return "publicUrl missing" }
    if (-not $r.thumbUploadUrl) { return "thumbUploadUrl missing" }
    if (-not $r.thumbPublicUrl) { return "thumbPublicUrl missing" }
    if ($r.publicUrl      -notmatch "photos\.looknet\.ca") { return "publicUrl wrong domain: $($r.publicUrl)" }
    if ($r.thumbPublicUrl -notmatch "photos\.looknet\.ca") { return "thumbPublicUrl wrong domain: $($r.thumbPublicUrl)" }
    if ($r.publicUrl      -notmatch "photo\.webp$")        { return "publicUrl should end photo.webp: $($r.publicUrl)" }
    if ($r.thumbPublicUrl -notmatch "thumb\.webp$")        { return "thumbPublicUrl should end thumb.webp: $($r.thumbPublicUrl)" }
    $true
}
$photoId1 = [string]$pu1Raw.photoId

$null = Invoke-Test -Name "E2E: Confirm photo 1" -Method POST -Path "/admin/photos/confirm" `
    -Body @{ patientId=$e2ePid; photoId=$photoId1; thumbnailUrl=[string]$pu1Raw.thumbPublicUrl } -Validate {
    param($r)
    if (-not $r.photoId)      { return "photoId missing" }
    if (-not $r.thumbnailUrl) { return "thumbnailUrl missing" }
    $true
}

$pu2Raw = Invoke-Test -Name "E2E: Get photo 2 upload URL" -Method POST -Path "/admin/photos/upload-url" `
    -Body @{ patientId=$e2ePid; contentType="image/webp" } -Validate {
    param($r)
    if (-not $r.photoId) { return "photoId missing" }
    $true
}
$photoId2 = [string]$pu2Raw.photoId

$null = Invoke-Test -Name "E2E: Confirm photo 2" -Method POST -Path "/admin/photos/confirm" `
    -Body @{ patientId=$e2ePid; photoId=$photoId2; thumbnailUrl=[string]$pu2Raw.thumbPublicUrl } -Validate {
    param($r) if (-not $r.photoId) { return "photoId missing" } $true
}

$null = Invoke-Test -Name "E2E: Both photos in list" -Method GET -Path "/admin/photos/list?patientId=$e2ePid" -Validate {
    param($r)
    $p1 = $r.photos | Where-Object { $_.photoId -eq $photoId1 }
    $p2 = $r.photos | Where-Object { $_.photoId -eq $photoId2 }
    if (-not $p1) { return "photo 1 not in list" }
    if (-not $p2) { return "photo 2 not in list" }
    if (-not $p1.thumbnailUrl) { return "photo 1 missing thumbnailUrl" }
    $true
}

$null = Invoke-Test -Name "E2E: Reorder photos (photo2 first)" -Method PUT -Path "/admin/photos/order" `
    -Body @{ patientId=$e2ePid; photoIds=@($photoId2, $photoId1) } -Validate {
    param($r)
    if (-not $r.success) { return "success != true" }
    $true
}

$null = Invoke-Test -Name "E2E: Photo order reflected in list" -Method GET -Path "/admin/photos/list?patientId=$e2ePid" -Validate {
    param($r)
    if ($r.photos[0].photoId -ne $photoId2) { return "expected $photoId2 first, got $($r.photos[0].photoId)" }
    $true
}

# Caption lifecycle
$null = Invoke-Test -Name "E2E: Set photo caption" -Method PUT -Path "/admin/photos/caption" `
    -Body @{ photoId=$photoId1; caption="A lovely memory from summer" } -Validate {
    param($r)
    if ($r.photoId -ne $photoId1)                          { return "photoId mismatch" }
    if ($r.caption -ne "A lovely memory from summer")      { return "caption not echoed: $($r.caption)" }
    $true
}

$null = Invoke-Test -Name "E2E: Caption visible in patient/get" -Method GET -Path "/admin/patients/get?patientId=$e2ePid" -Validate {
    param($r)
    $photo = $r.photos | Where-Object { $_.photoId -eq $photoId1 }
    if (-not $photo)                                       { return "photo not in patient/get" }
    if ($photo.caption -ne "A lovely memory from summer")  { return "caption mismatch: $($photo.caption)" }
    $true
}

$null = Invoke-Test -Name "E2E: Caption visible in tablet sync" -Method GET -Path "/tablet/E2E-TABLET/sync" -Validate {
    param($r)
    $photo = $r.photos | Where-Object { $_.photoId -eq $photoId1 }
    if (-not $photo)                                      { return "photo not in sync" }
    if (-not $photo.thumbnailUrl)                         { return "thumbnailUrl missing from sync" }
    if ($photo.caption -ne "A lovely memory from summer") { return "caption not in sync: $($photo.caption)" }
    $true
}

$null = Invoke-Test -Name "E2E: Clear photo caption" -Method PUT -Path "/admin/photos/caption" `
    -Body @{ photoId=$photoId1; caption="" } -Validate {
    param($r)
    if ($r.photoId -ne $photoId1)  { return "photoId mismatch" }
    if ($null -ne $r.caption)      { return "caption should be null: $($r.caption)" }
    $true
}

$null = Invoke-Test -Name "E2E: Caption null after clear" -Method GET -Path "/admin/photos/list?patientId=$e2ePid" -Validate {
    param($r)
    $p = $r.photos | Where-Object { $_.photoId -eq $photoId1 }
    if (-not $p)    { return "photo missing" }
    if ($p.caption) { return "caption should be null: $($p.caption)" }
    $true
}

# Delete photo 1 and verify photo 2 survives
$null = Invoke-Test -Name "E2E: Delete photo 1" -Method DELETE -Path "/admin/photos/delete?photoId=$photoId1" -Validate {
    param($r)
    if (-not $r.success) { return "success != true" }
    $true
}

$null = Invoke-Test -Name "E2E: Photo 1 gone, photo 2 remains" -Method GET -Path "/admin/photos/list?patientId=$e2ePid" -Validate {
    param($r)
    $gone = $r.photos | Where-Object { $_.photoId -eq $photoId1 }
    $kept = $r.photos | Where-Object { $_.photoId -eq $photoId2 }
    if ($gone) { return "deleted photo still in list" }
    if (-not $kept) { return "photo 2 missing after photo 1 delete" }
    $true
}

# ── Contact photo upload URL ──────────────────────────────────
$null = Invoke-Test -Name "E2E: Contact photo upload URL" -Method POST -Path "/admin/contacts/upload-photo-url" `
    -Body @{ filename="avatar.jpg"; contentType="image/jpeg" } -Validate {
    param($r)
    if (-not $r.uploadUrl) { return "uploadUrl missing" }
    if (-not $r.publicUrl) { return "publicUrl missing" }
    if ($r.publicUrl -notmatch "photos\.looknet\.ca/photos/") { return "publicUrl wrong prefix: $($r.publicUrl)" }
    $true
}

# ── Kiosk settings ────────────────────────────────────────────
$null = Invoke-Test -Name "E2E: Get default settings" -Method GET -Path "/admin/patients/$e2ePid/settings" -Validate {
    param($r)
    if ($r.slideInterval      -lt 1)         { return "slideInterval bad: $($r.slideInterval)" }
    if ($null -eq $r.nightEnabled)           { return "nightEnabled missing" }
    if ($null -eq $r.kenBurns)               { return "kenBurns missing" }
    if (-not $r.ringtone)                    { return "ringtone missing" }
    if ($r.ringtone           -ne "digital") { return "ringtone default wrong: $($r.ringtone)" }
    if ($null -eq $r.ringVolume)             { return "ringVolume missing" }
    if ($null -eq $r.screenTimeoutMs)        { return "screenTimeoutMs missing" }
    if ($null -eq $r.fontScale)              { return "fontScale missing" }
    if ($null -eq $r.orientation)            { return "orientation missing" }
    if ($null -eq $r.btDeviceAddress)        { return "btDeviceAddress missing" }
    if ($null -eq $r.accessibilityMode)      { return "accessibilityMode missing" }
    if ($r.accessibilityMode  -ne $false)    { return "accessibilityMode default wrong: $($r.accessibilityMode)" }
    $true
}

$null = Invoke-Test -Name "E2E: Save custom settings" -Method PUT -Path "/admin/patients/$e2ePid/settings" `
    -Body @{ slideInterval=12; resumeDelay=5; nightStart=22; nightEnd=6; nightBrightness=15; nightEnabled=$true; kenBurns=$false; ringtone="classic"; ringVolume=75; screenTimeoutMs=120000; fontScale=1.25; orientation="portrait" } -Validate {
    param($r)
    if ($r.slideInterval   -ne 12)       { return "slideInterval not saved: $($r.slideInterval)" }
    if ($r.resumeDelay     -ne 5)        { return "resumeDelay not saved: $($r.resumeDelay)" }
    if ($r.nightStart      -ne 22)       { return "nightStart not saved: $($r.nightStart)" }
    if ($r.nightBrightness -ne 15)       { return "nightBrightness not saved: $($r.nightBrightness)" }
    if ($r.kenBurns        -ne $false)   { return "kenBurns not saved: $($r.kenBurns)" }
    if ($r.ringtone        -ne "classic"){ return "ringtone not saved: $($r.ringtone)" }
    if ($r.ringVolume      -ne 75)       { return "ringVolume not saved: $($r.ringVolume)" }
    if ($r.screenTimeoutMs -ne 120000)   { return "screenTimeoutMs not saved: $($r.screenTimeoutMs)" }
    if ($r.fontScale       -ne 1.25)     { return "fontScale not saved: $($r.fontScale)" }
    if ($r.orientation     -ne "portrait"){ return "orientation not saved: $($r.orientation)" }
    $true
}

$null = Invoke-Test -Name "E2E: Save unlockPin + restartHour + system settings" -Method PUT -Path "/admin/patients/$e2ePid/settings" `
    -Body @{ slideInterval=12; resumeDelay=5; nightStart=22; nightEnd=6; nightBrightness=15; nightEnabled=$true; kenBurns=$false; unlockPin="5678"; restartHour=3; ringtone="gentle"; ringVolume=80; screenTimeoutMs=60000; timezone="America/Toronto"; fontScale=1.0; orientation="landscape"; btDeviceAddress="AA:BB:CC:DD:EE:FF"; accessibilityMode=$true } -Validate {
    param($r)
    if ($r.unlockPin         -ne "5678")             { return "unlockPin not saved: $($r.unlockPin)" }
    if ($r.restartHour       -ne 3)                  { return "restartHour not saved: $($r.restartHour)" }
    if ($r.ringtone          -ne "gentle")            { return "ringtone not saved: $($r.ringtone)" }
    if ($r.ringVolume        -ne 80)                  { return "ringVolume not saved: $($r.ringVolume)" }
    if ($r.timezone          -ne "America/Toronto")   { return "timezone not saved: $($r.timezone)" }
    if ($r.fontScale         -ne 1.0)                 { return "fontScale not saved: $($r.fontScale)" }
    if ($r.orientation       -ne "landscape")         { return "orientation not saved: $($r.orientation)" }
    if ($r.btDeviceAddress   -ne "AA:BB:CC:DD:EE:FF") { return "btDeviceAddress not saved: $($r.btDeviceAddress)" }
    if ($r.accessibilityMode -ne $true)               { return "accessibilityMode not saved: $($r.accessibilityMode)" }
    $true
}

$null = Invoke-Test -Name "E2E: Settings in tablet sync" -Method GET -Path "/tablet/E2E-TABLET/sync" -Validate {
    param($r)
    if (-not $r.settings)                                    { return "settings missing from sync" }
    if ($r.settings.unlockPin        -ne "5678")             { return "unlockPin not in sync: $($r.settings.unlockPin)" }
    if ($r.settings.restartHour      -ne 3)                  { return "restartHour not in sync: $($r.settings.restartHour)" }
    if ($r.settings.slideInterval    -ne 12)                 { return "slideInterval not in sync: $($r.settings.slideInterval)" }
    if ($r.settings.ringtone         -ne "gentle")           { return "ringtone not in sync: $($r.settings.ringtone)" }
    if ($r.settings.ringVolume       -ne 80)                 { return "ringVolume not in sync: $($r.settings.ringVolume)" }
    if ($r.settings.timezone         -ne "America/Toronto")  { return "timezone not in sync: $($r.settings.timezone)" }
    if ($r.settings.fontScale        -ne 1.0)                { return "fontScale not in sync: $($r.settings.fontScale)" }
    if ($r.settings.orientation      -ne "landscape")        { return "orientation not in sync: $($r.settings.orientation)" }
    if ($r.settings.btDeviceAddress  -ne "AA:BB:CC:DD:EE:FF") { return "btDeviceAddress not in sync: $($r.settings.btDeviceAddress)" }
    if ($r.settings.accessibilityMode -ne $true)             { return "accessibilityMode not in sync: $($r.settings.accessibilityMode)" }
    $true
}

# ── Structured tablet commands ────────────────────────────────
$null = Invoke-Test -Name "E2E: Queue structured restart command" -Method POST -Path "/admin/tablet/E2E-TABLET/command" `
    -Body @{ command=@{ type="restart" } } -Validate {
    param($r)
    if (-not $r.queued) { return "queued != true" }
    $true
}

$null = Invoke-Test -Name "E2E: Sync delivers structured command" -Method GET -Path "/tablet/E2E-TABLET/sync" -Validate {
    param($r)
    if (-not $r.command)               { return "command missing" }
    if ($r.command.type -ne "restart") { return "command.type mismatch: $($r.command.type)" }
    $true
}

$null = Invoke-Test -Name "E2E: Structured command consumed on next sync" -Method GET -Path "/tablet/E2E-TABLET/sync" -Validate {
    param($r)
    if ($null -ne $r.command) { return "command should be null: $($r.command)" }
    $true
}

$null = Invoke-Test -Name "E2E: Queue wifi-add command" -Method POST -Path "/admin/tablet/E2E-TABLET/command" `
    -Body @{ command=@{ type="wifi-add"; ssid="TestNet"; password="secret"; security="WPA" } } -Validate {
    param($r) if (-not $r.queued) { return "queued != true" } $true
}

$null = Invoke-Test -Name "E2E: Sync delivers wifi-add command" -Method GET -Path "/tablet/E2E-TABLET/sync" -Validate {
    param($r)
    if (-not $r.command)                { return "command missing" }
    if ($r.command.type -ne "wifi-add") { return "type mismatch: $($r.command.type)" }
    if ($r.command.ssid -ne "TestNet")  { return "ssid mismatch: $($r.command.ssid)" }
    $true
}

$wakeRaw = Invoke-Test -Name "E2E: Wake tablet (spoofed call)" -Method POST -Path "/admin/tablet/E2E-TABLET/wake" -Validate {
    param($r)
    if (-not $r.success) { return "success != true" }
    if (-not $r.callId)  { return "callId missing" }
    $true
}
if ($wakeRaw.callId) {
    $null = Invoke-Test -Name "E2E: Clean up spoofed wake call" -Method POST -Path "/kiosk/incoming-call/$($wakeRaw.callId)/decline" -Base $RootUrl -Validate {
        param($r) if (-not $r.success) { return "success != true" } $true
    }
}

# ── Storage report ────────────────────────────────────────────
$null = Invoke-Test -Name "E2E: Tablet posts storage report" -Method POST -Path "/tablet/E2E-TABLET/storage-report" `
    -Body @{
        cacheBytes=5242880; freeBytes=2000000000; totalBytes=8000000000; cachedPhotoCount=12; batteryLevel=85
        batteryCharging=$true; lockTaskActive=$true; uptimeMs=3600000
        wifiSsid="HomeNet"; wifiSignal=4; wifiConnected=$true
        wifiAvailable=@(
            @{ ssid="HomeNet";    signal=4; security="WPA"  }
            @{ ssid="GuestNet";   signal=2; security="OPEN" }
        )
        wifiKnown=@(
            @{ ssid="HomeNet" }
            @{ ssid="OldOffice" }
        )
        volumeRing=80; btConnected=$false; btDeviceName=""; btDevices=@()
        ringtones=@(
            @{ name="Classic Ring"; uri="content://media/internal/audio/media/1" }
            @{ name="Beep Once";    uri="content://media/internal/audio/media/2" }
        )
        deviceManufacturer="Samsung"; deviceModel="SM-T510"; androidVersion="12"; androidSdk=31
        timezone="America/Toronto"; fontScale=1.0; orientation="landscape"; apkVersion=46
        ramTotalBytes=8000000000; ramUsedBytes=3000000000; ramLowMemory=$false
    } -Validate {
    param($r) if (-not $r.ok) { return "ok != true" } $true
}

$null = Invoke-Test -Name "E2E: Admin fetches device health" -Method GET -Path "/admin/tablet/E2E-TABLET/storage" -Validate {
    param($r)
    if ($null -eq $r)                       { return "null response" }
    if ($r.batteryLevel    -ne 85)          { return "batteryLevel mismatch: $($r.batteryLevel)" }
    if ($r.batteryCharging -ne $true)       { return "batteryCharging mismatch" }
    if ($r.lockTaskActive  -ne $true)       { return "lockTaskActive mismatch" }
    if ($r.cachedPhotoCount -ne 12)         { return "cachedPhotoCount mismatch: $($r.cachedPhotoCount)" }
    if ($r.totalBytes      -ne 8000000000)  { return "totalBytes mismatch: $($r.totalBytes)" }
    if ($r.wifiSsid        -ne "HomeNet")   { return "wifiSsid mismatch: $($r.wifiSsid)" }
    if ($null -eq $r.wifiAvailable)         { return "wifiAvailable missing" }
    if ($r.wifiAvailable.Count -ne 2)       { return "wifiAvailable count: $($r.wifiAvailable.Count)" }
    if ($r.wifiAvailable[0].ssid -ne "HomeNet") { return "wifiAvailable[0].ssid mismatch" }
    if ($null -eq $r.wifiKnown)             { return "wifiKnown missing" }
    if ($r.wifiKnown.Count -ne 2)           { return "wifiKnown count: $($r.wifiKnown.Count)" }
    if ($r.wifiKnown[0].ssid -ne "HomeNet") { return "wifiKnown[0].ssid mismatch" }
    if ($r.volumeRing      -ne 80)          { return "volumeRing mismatch: $($r.volumeRing)" }
    if ($null -eq $r.btDevices)             { return "btDevices missing" }
    if ($null -eq $r.ringtones)             { return "ringtones missing" }
    if ($r.ringtones.Count -ne 2)           { return "ringtones count: $($r.ringtones.Count)" }
    if ($r.ringtones[0].name -ne "Classic Ring") { return "ringtones[0].name mismatch" }
    if ($r.deviceManufacturer -ne "Samsung") { return "deviceManufacturer mismatch: $($r.deviceManufacturer)" }
    if ($r.deviceModel     -ne "SM-T510")   { return "deviceModel mismatch: $($r.deviceModel)" }
    if ($r.androidVersion  -ne "12")        { return "androidVersion mismatch: $($r.androidVersion)" }
    if ($r.timezone        -ne "America/Toronto") { return "timezone mismatch: $($r.timezone)" }
    if ($r.fontScale       -ne 1.0)         { return "fontScale mismatch: $($r.fontScale)" }
    if ($r.orientation     -ne "landscape") { return "orientation mismatch: $($r.orientation)" }
    if ($r.apkVersion      -ne 46)          { return "apkVersion mismatch: $($r.apkVersion)" }
    if ($null -eq $r.reportedAt)            { return "reportedAt missing" }
    if ($r.ramTotalBytes -ne 8000000000)   { return "ramTotalBytes mismatch: $($r.ramTotalBytes)" }
    if ($r.ramUsedBytes  -ne 3000000000)   { return "ramUsedBytes mismatch: $($r.ramUsedBytes)" }
    if ($r.ramLowMemory  -ne $false)       { return "ramLowMemory mismatch: $($r.ramLowMemory)" }
    $true
}

# ── Device logs ───────────────────────────────────────────────
$logTs = [int64]([datetime]::UtcNow - [datetime]::new(1970,1,1)).TotalMilliseconds

$null = Invoke-Test -Name "E2E: Tablet uploads log lines" -Method POST -Path "/tablet/E2E-TABLET/logs" -Base $RootUrl `
    -Body @{ lines=@(
        @{ loggedAt=$logTs - 2000; level="I"; tag="KioskCallSvc"; message="poll ok" }
        @{ loggedAt=$logTs - 1000; level="W"; tag="FamilyKiosk";  message="slow response 1234ms" }
        @{ loggedAt=$logTs;        level="E"; tag="KioskUpdate";  message="update check failed" }
    )} -Validate {
    param($r)
    if (-not $r.ok)            { return "ok != true" }
    if ($r.inserted -ne 3)     { return "inserted should be 3: $($r.inserted)" }
    $true
}

$null = Invoke-Test -Name "E2E: Admin fetches device logs (unfiltered)" -Method GET -Path "/admin/tablet/E2E-TABLET/logs?level=V" -Validate {
    param($r)
    if ($null -eq $r.logs)         { return "logs array missing" }
    if ($r.logs.Count -lt 3)       { return "expected >= 3 logs: $($r.logs.Count)" }
    $found = $r.logs | Where-Object { $_.tag -eq "KioskUpdate" }
    if (-not $found)               { return "KioskUpdate log not found" }
    if ($found.level -ne "E")      { return "level mismatch: $($found.level)" }
    $true
}

$null = Invoke-Test -Name "E2E: Device logs since filter works" -Method GET -Path "/admin/tablet/E2E-TABLET/logs?since=$($logTs)&level=V" -Validate {
    param($r)
    if ($null -eq $r.logs) { return "logs array missing" }
    $old = $r.logs | Where-Object { $_.loggedAt -le $logTs }
    if ($old) { return "since filter not working - old log returned" }
    $true
}

$null = Invoke-Test -Name "E2E: Device logs level=E returns only errors" -Method GET -Path "/admin/tablet/E2E-TABLET/logs?level=E&limit=500" -Validate {
    param($r)
    if ($null -eq $r.logs) { return "logs array missing" }
    $nonError = $r.logs | Where-Object { $_.level -ne "E" }
    if ($nonError) { return "non-error log returned with level=E filter: $($nonError[0].level) / $($nonError[0].tag)" }
    $found = $r.logs | Where-Object { $_.tag -eq "KioskUpdate" }
    if (-not $found) { return "KioskUpdate error log not returned with level=E filter" }
    $true
}

$null = Invoke-Test -Name "E2E: Device logs level=W excludes INFO" -Method GET -Path "/admin/tablet/E2E-TABLET/logs?level=W&limit=500" -Validate {
    param($r)
    if ($null -eq $r.logs) { return "logs array missing" }
    $infoOrBelow = $r.logs | Where-Object { $_.level -eq "I" -or $_.level -eq "D" -or $_.level -eq "V" }
    if ($infoOrBelow) { return "INFO/DEBUG/VERBOSE returned with level=W filter: $($infoOrBelow[0].level)" }
    $warnFound = $r.logs | Where-Object { $_.tag -eq "FamilyKiosk" }
    if (-not $warnFound) { return "WARN log not returned with level=W filter" }
    $true
}

$null = Invoke-Test -Name "E2E: Device logs tag filter returns only that tag" -Method GET -Path "/admin/tablet/E2E-TABLET/logs?level=V&tag=KioskCallSvc&limit=500" -Validate {
    param($r)
    if ($null -eq $r.logs) { return "logs array missing" }
    $wrongTag = $r.logs | Where-Object { $_.tag -ne "KioskCallSvc" }
    if ($wrongTag) { return "tag filter leak: got tag=$($wrongTag[0].tag)" }
    if ($r.logs.Count -lt 1) { return "expected at least 1 KioskCallSvc log" }
    $true
}

$null = Invoke-Test -Name "E2E: Device logs text search finds substring" -Method GET -Path "/admin/tablet/E2E-TABLET/logs?level=V&text=slow+response&limit=500" -Validate {
    param($r)
    if ($null -eq $r.logs) { return "logs array missing" }
    if ($r.logs.Count -lt 1) { return "expected at least 1 result for 'slow response'" }
    $notMatching = $r.logs | Where-Object { $_.message -notmatch "slow response" }
    if ($notMatching) { return "text filter leak: message='$($notMatching[0].message)'" }
    $true
}

$null = Invoke-Test -Name "E2E: Device logs text search no match returns empty" -Method GET -Path "/admin/tablet/E2E-TABLET/logs?level=V&text=XYZZY_NOMATCH_12345&limit=500" -Validate {
    param($r)
    if ($null -eq $r.logs) { return "logs array missing" }
    if ($r.logs.Count -ne 0) { return "expected 0 results for nonsense text: $($r.logs.Count)" }
    $true
}

# Insert a log with a timestamp older than the 7-day TTL; the next upload should trigger cleanup and remove it
$staleTs = $logTs - (8 * 24 * 60 * 60 * 1000)
$null = Invoke-Test -Name "E2E: Stale logs are purged on next upload" -Method POST -Path "/tablet/E2E-TABLET/logs" -Base $RootUrl `
    -Body @{ lines=@(
        @{ loggedAt=$staleTs; level="I"; tag="StaleTest"; message="should be deleted" }
    )} -Validate { param($r) if (-not $r.ok) { return "ok != true" }; $true }
# Trigger another upload to cause the TTL cleanup to run, then verify the stale log is gone
$null = Invoke-Test -Name "E2E: Stale log absent after TTL cleanup" -Method POST -Path "/tablet/E2E-TABLET/logs" -Base $RootUrl `
    -Body @{ lines=@(@{ loggedAt=$logTs; level="I"; tag="TriggerCleanup"; message="trigger cleanup" }) } `
    -Validate { param($r) if (-not $r.ok) { return "ok != true" }; $true }
$null = Invoke-Test -Name "E2E: Stale log not returned after cleanup" -Method GET -Path "/admin/tablet/E2E-TABLET/logs?since=0&limit=2000" -Validate {
    param($r)
    if ($null -eq $r.logs) { return "logs array missing" }
    $stale = $r.logs | Where-Object { $_.tag -eq "StaleTest" }
    if ($stale) { return "stale log still present after TTL cleanup" }
    $true
}

# Flood test: send 500 log lines and verify the server responds in under 2 seconds (index should make cleanup fast)
$floodLines = 1..500 | ForEach-Object { @{ loggedAt=$logTs - $_; level="I"; tag="FloodTest"; message="flood line $_" } }
$floodStart = Get-Date
$null = Invoke-Test -Name "E2E: Log flood (500 lines) completes quickly" -Method POST -Path "/tablet/E2E-TABLET/logs" -Base $RootUrl `
    -Body @{ lines=$floodLines } -Validate {
    param($r)
    $elapsed = ((Get-Date) - $floodStart).TotalSeconds
    if (-not $r.ok)         { return "ok != true" }
    if ($r.inserted -ne 500){ return "inserted should be 500: $($r.inserted)" }
    if ($elapsed -gt 2.0)   { return "flood took too long: $([math]::Round($elapsed,2))s (index may be missing)" }
    $true
}

# ── APK releases ──────────────────────────────────────────────
$null = Invoke-Test -Name "E2E: APK latest exists" -Method GET -Path "/admin/apk/latest" -Validate {
    param($r)
    if ($null -eq $r.version) { return "version field missing" }
    $true
}

$null = Invoke-Test -Name "E2E: Record APK release v999" -Method POST -Path "/admin/apk/release" `
    -Body @{ version=999; url="https://photos.looknet.ca/apk/family-kiosk-v999.apk"; sha256="abc123def456abc123def456abc123def456abc123def456abc123def456abc1" } -Validate {
    param($r) if (-not $r.ok) { return "ok != true" } $true
}

$null = Invoke-Test -Name "E2E: APK latest returns v999" -Method GET -Path "/admin/apk/latest" -Validate {
    param($r)
    if ($r.version -ne 999) { return "version mismatch: $($r.version)" }
    if (-not $r.url)         { return "url missing" }
    if (-not $r.sha256)      { return "sha256 missing" }
    $true
}

$null = Invoke-Test -Name "E2E: Delete APK release v999" -Method DELETE -Path "/admin/apk/release/999" -Validate {
    param($r) if (-not $r.success) { return "success != true" } $true
}

$null = Invoke-Test -Name "E2E: Public APK endpoint (v999 gone)" -Method GET -Path "/kiosk/apk/latest" -Base $RootUrl -Validate {
    param($r)
    if ($null -eq $r.version) { return "version field missing" }
    if ($r.version -eq 999)   { return "deleted v999 still returned" }
    $true
}

# ── Family APK releases ───────────────────────────────────────
$null = Invoke-Test -Name "E2E: Family APK latest exists" -Method GET -Path "/admin/family-apk/latest" -Validate {
    param($r)
    if ($null -eq $r.version) { return "version field missing" }
    $true
}

$null = Invoke-Test -Name "E2E: Record family APK release v999" -Method POST -Path "/admin/family-apk/release" `
    -Body @{ version=999; url="https://photos.looknet.ca/apk/family-app-v999.apk"; sha256="abc123def456abc123def456abc123def456abc123def456abc123def456abc1" } -Validate {
    param($r) if (-not $r.ok) { return "ok != true" } $true
}

$null = Invoke-Test -Name "E2E: Family APK latest returns v999" -Method GET -Path "/admin/family-apk/latest" -Validate {
    param($r)
    if ($r.version -ne 999) { return "version mismatch: $($r.version)" }
    if (-not $r.url)         { return "url missing" }
    if (-not $r.sha256)      { return "sha256 missing" }
    $true
}

$null = Invoke-Test -Name "E2E: Public family APK endpoint returns v999" -Method GET -Path "/family/apk/latest" -Base $RootUrl -Validate {
    param($r)
    if ($r.version -ne 999) { return "version mismatch: $($r.version)" }
    if (-not $r.url)         { return "url missing" }
    if (-not $r.sha256)      { return "sha256 missing" }
    $true
}

$null = Invoke-Test -Name "E2E: Delete family APK release v999" -Method DELETE -Path "/admin/family-apk/release/999" -Validate {
    param($r) if (-not $r.success) { return "success != true" } $true
}

$null = Invoke-Test -Name "E2E: Public family APK endpoint (v999 gone)" -Method GET -Path "/family/apk/latest" -Base $RootUrl -Validate {
    param($r)
    if ($null -eq $r.version) { return "version field missing" }
    if ($r.version -eq 999)   { return "deleted v999 still returned" }
    $true
}

$null = Invoke-Test -Name "E2E: Push update FCM (0 devices OK)" -Method POST -Path "/admin/family-apk/push-update" -Validate {
    param($r)
    if ($null -eq $r.sent)   { return "sent field missing" }
    if ($null -eq $r.failed) { return "failed field missing" }
    $true
}

# ── Call request lifecycle ────────────────────────────────────
$reqRaw = Invoke-Test -Name "E2E: Create call request" -Method POST -Path "/admin/patients/$e2ePid/call-request" `
    -Body @{ contactId=$cid } -Validate {
    param($r)
    if (-not $r.requestId)           { return "requestId missing" }
    if ($r.contactId -ne $cid)       { return "contactId mismatch" }
    $true
}
$rid = [string]$reqRaw.requestId

$null = Invoke-Test -Name "E2E: Request visible in patient/get" -Method GET -Path "/admin/patients/get?patientId=$e2ePid" -Validate {
    param($r)
    $found = $r.callRequests | Where-Object { $_.requestId -eq $rid }
    if (-not $found)                            { return "call request not in callRequests" }
    if ($found.name -ne "E2E Contact Updated")  { return "contact name wrong: $($found.name)" }
    $true
}

$null = Invoke-Test -Name "E2E: Request in tablet sync" -Method GET -Path "/tablet/E2E-TABLET/sync" -Validate {
    param($r)
    $found = $r.callRequests | Where-Object { $_.requestId -eq $rid }
    if (-not $found)                  { return "call request not in sync" }
    if (-not $r.settings)             { return "settings missing from sync" }
    if ($r.settings.slideInterval -ne 12) { return "settings wrong in sync" }
    $true
}

$null = Invoke-Test -Name "E2E: Tablet dismisses call request" -Method POST -Path "/tablet/dismiss-call-request/$rid" -Validate {
    param($r) if (-not $r.success) { return "success != true" } $true
}

$null = Invoke-Test -Name "E2E: Request gone after dismiss" -Method GET -Path "/admin/patients/get?patientId=$e2ePid" -Validate {
    param($r)
    $found = $r.callRequests | Where-Object { $_.requestId -eq $rid }
    if ($found) { return "request still present after dismiss" }
    $true
}

$req2 = Invoke-Test -Name "E2E: Admin cancels call request" -Method POST -Path "/admin/patients/$e2ePid/call-request" `
    -Body @{ contactId=$cid } -Validate {
    param($r) if (-not $r.requestId) { return "requestId missing" } $true
}
$rid2 = [string]$req2.requestId

$null = Invoke-Test -Name "E2E: Admin cancel succeeds" -Method DELETE -Path "/admin/call-request/$rid2" -Validate {
    param($r) if (-not $r.success) { return "success != true" } $true
}

$null = Invoke-Test -Name "E2E: Cancelled request gone" -Method GET -Path "/admin/patients/get?patientId=$e2ePid" -Validate {
    param($r)
    $found = $r.callRequests | Where-Object { $_.requestId -eq $rid2 }
    if ($found) { return "cancelled request still present" }
    $true
}

# ── Tablet commands (legacy string format) ────────────────────
$null = Invoke-Test -Name "E2E: Queue reload command" -Method POST -Path "/admin/tablet/E2E-TABLET/command" `
    -Body @{ command="reload" } -Validate {
    param($r)
    if (-not $r.queued)          { return "queued != true" }
    if ($r.command -ne "reload") { return "command mismatch: $($r.command)" }
    $true
}

$null = Invoke-Test -Name "E2E: Sync delivers + consumes reload" -Method GET -Path "/tablet/E2E-TABLET/sync" -Validate {
    param($r)
    if ($r.command -ne "reload") { return "command not in sync: $($r.command)" }
    $true
}

$null = Invoke-Test -Name "E2E: Command null on next sync" -Method GET -Path "/tablet/E2E-TABLET/sync" -Validate {
    param($r)
    if ($null -ne $r.command) { return "command should be null: $($r.command)" }
    $true
}

# ── Family device pairing ─────────────────────────────────────
$tokenRaw = Invoke-Test -Name "E2E: Generate pairing token" -Method POST -Path "/admin/contacts/$cid/pairing-token" -Validate {
    param($r)
    if (-not $r.token)     { return "token missing" }
    if (-not $r.expiresAt) { return "expiresAt missing" }
    $true
}
$pairingToken = [string]$tokenRaw.token

$pairRaw = Invoke-Test -Name "E2E: Family pair device" -Method POST -Path "/family/pair" -Base $RootUrl `
    -Body @{ token=$pairingToken; fcmToken="E2E-FCM-TOKEN"; deviceId="E2E-FAMILY-DEVICE"; platform="android" } -Validate {
    param($r)
    if (-not $r.success)     { return "success != true" }
    if (-not $r.patientName) { return "patientName missing" }
    if (-not $r.contactId)   { return "contactId missing" }
    if (-not $r.deviceToken) { return "deviceToken missing" }
    if ($r.PSObject.Properties.Name -notcontains 'patientPhotoUrl') { return "patientPhotoUrl field missing from pair response" }
    $true
}
$e2eDeviceToken   = [string]$pairRaw.deviceToken
$e2eDeviceHeaders = @{ "x-device-token" = $e2eDeviceToken }

$null = Invoke-Test -Name "E2E: Pairing token consumed (can't reuse)" -Method POST -Path "/family/pair" -Base $RootUrl `
    -Body @{ token=$pairingToken; fcmToken="E2E-FCM-2"; deviceId="E2E-FAMILY-DEVICE-2"; platform="android" } `
    -Validate { param($r) "Token should be consumed" } `
    -PassOnCodes @(401)

$null = Invoke-Test -Name "E2E: Device count updated in contacts" -Method GET -Path "/admin/contacts/list?patientId=$e2ePid" -Validate {
    param($r)
    $found = $r.contacts | Where-Object { $_.contactId -eq $cid }
    if (-not $found)              { return "contact not found" }
    if ($found.deviceCount -lt 1) { return "deviceCount should be >= 1: $($found.deviceCount)" }
    $true
}

$null = Invoke-Test -Name "E2E: Device list has E2E-FAMILY-DEVICE" -Method GET -Path "/admin/contacts/$cid/devices" -Validate {
    param($r)
    if ($null -eq $r.devices) { return "devices array missing" }
    $found = $r.devices | Where-Object { $_.deviceId -eq "E2E-FAMILY-DEVICE" }
    if (-not $found)              { return "E2E-FAMILY-DEVICE not in devices" }
    if ($found.platform -ne "android") { return "platform mismatch: $($found.platform)" }
    if (-not $found.registeredAt) { return "registeredAt missing" }
    $true
}

$null = Invoke-Test -Name "E2E: Update FCM token" -Method PUT -Path "/family/device/E2E-FAMILY-DEVICE/fcm-token" -Base $RootUrl `
    -ExtraHeaders $e2eDeviceHeaders `
    -Body @{ fcmToken="E2E-FCM-TOKEN-UPDATED" } -Validate {
    param($r)
    if (-not $r.success) { return "success != true" }
    $true
}

$null = Invoke-Test -Name "E2E: Update push subscription" -Method PUT -Path "/family/device/E2E-FAMILY-DEVICE/push-subscription" -Base $RootUrl `
    -ExtraHeaders $e2eDeviceHeaders `
    -Body @{ subscription=@{ endpoint="https://fcm.googleapis.com/fcm/send/fake"; keys=@{ auth="fake-auth"; p256dh="fake-key" } } } -Validate {
    param($r)
    if (-not $r.success) { return "success != true" }
    $true
}

# ── Patient in-call status ────────────────────────────────────
$null = Invoke-Test -Name "E2E: Patient not in call initially" -Method GET -Path "/family/device/E2E-FAMILY-DEVICE/patient-status" -Base $RootUrl `
    -ExtraHeaders $e2eDeviceHeaders -Validate {
    param($r)
    if ($r.inCall -ne $false) { return "inCall should be false: $($r.inCall)" }
    if ($r.PSObject.Properties.Name -notcontains 'patientPhotoUrl') { return "patientPhotoUrl field missing from patient-status" }
    $true
}

# ── Kiosk-initiated call flow ─────────────────────────────────
$null = Invoke-Test -Name "E2E: No incoming call before initiation" -Method GET -Path "/kiosk/patient/$e2ePid/incoming-call?deviceId=E2E-TABLET" -Base $RootUrl -Validate {
    param($r)
    if ($null -ne $r -and $r -ne "null") { return "expected null: $($r | ConvertTo-Json -Compress)" }
    $true
}

$kioskInitRaw = Invoke-Test -Name "E2E: Kiosk initiates call" -Method POST -Path "/call/initiate" `
    -Body @{ patientId=$e2ePid; contactId=$cid } -Validate {
    param($r)
    if (-not $r.roomName) { return "roomName missing" }
    if (-not $r.token)    { return "token missing" }
    if (-not $r.wsUrl)    { return "wsUrl missing" }
    $true
}
$kioskRoom = [string]$kioskInitRaw.roomName

$null = Invoke-Test -Name "E2E: Family joins kiosk-initiated room" -Method POST -Path "/call/kiosk-join" -Base $RootUrl `
    -Body @{ roomName=$kioskRoom; patientId=$e2ePid } -Validate {
    param($r)
    if (-not $r.token) { return "token missing" }
    if (-not $r.wsUrl) { return "wsUrl missing" }
    $true
}

# Rate limit: immediate second initiate should return 429
$null = Invoke-Test -Name "E2E: Rate limit on rapid call/initiate" -Method POST -Path "/call/initiate" `
    -Body @{ patientId=$e2ePid; contactId=$cid } `
    -Validate { param($r) "Should have returned 429" } `
    -PassOnCodes @(429)

# Busy signal: confirm the room so the patient appears in an active call,
# then verify the family endpoint returns 409
$null = Invoke-Test -Name "E2E: Confirm room (simulate LiveKit room_started)" -Method POST -Path "/admin/rooms/$kioskRoom/confirm" -Validate {
    param($r) if (-not $r.ok) { return "ok != true" } $true
}

$null = Invoke-Test -Name "E2E: Family call returns 409 when kiosk busy" -Method POST -Path "/family/device/E2E-FAMILY-DEVICE/call" -Base $RootUrl `
    -ExtraHeaders $e2eDeviceHeaders `
    -Validate { param($r) "Should have returned 409 (busy)" } `
    -PassOnCodes @(409)


# Remove the confirmed room so the family-initiated call tests start clean
$null = Invoke-Test -Name "E2E: Delete confirmed room (cleanup)" -Method DELETE -Path "/admin/rooms/$kioskRoom" -Validate {
    param($r) if (-not $r.ok) { return "ok != true" } $true
}

# ── Family-initiated call flow ────────────────────────────────
$callRaw = Invoke-Test -Name "E2E: Family initiates call" -Method POST -Path "/family/device/E2E-FAMILY-DEVICE/call" -Base $RootUrl `
    -ExtraHeaders $e2eDeviceHeaders -Validate {
    param($r)
    if (-not $r.roomName) { return "roomName missing" }
    if (-not $r.joinUrl)  { return "joinUrl missing" }
    if (-not $r.callId)   { return "callId missing" }
    if (-not $r.token)    { return "token missing" }
    if (-not $r.wsUrl)    { return "wsUrl missing" }
    if ($r.joinUrl -notmatch "caller=1") { return "joinUrl missing caller=1: $($r.joinUrl)" }
    $true
}
$e2eCallId = [string]$callRaw.callId
$e2eRoom   = [string]$callRaw.roomName

$null = Invoke-Test -Name "E2E: Kiosk invites contact to room" -Method POST -Path "/call/invite" `
    -Body @{ patientId=$e2ePid; contactId=$cid; roomName=$e2eRoom } -Validate {
    param($r) if (-not $r.success) { return "success != true" } $true
}

# ── Invite a second contact (cid2) and verify they see joinUrl ─
$token2Raw = Invoke-Test -Name "E2E: Generate pairing token for contact 2" -Method POST -Path "/admin/contacts/$cid2/pairing-token" -Validate {
    param($r)
    if (-not $r.token) { return "token missing" }
    $true
}
$pairingToken2 = [string]$token2Raw.token

$pair2Raw = Invoke-Test -Name "E2E: Pair device for contact 2" -Method POST -Path "/family/pair" -Base $RootUrl `
    -Body @{ token=$pairingToken2; fcmToken="E2E-FCM-C2"; deviceId="E2E-FAMILY-DEVICE-C2"; platform="android" } -Validate {
    param($r)
    if (-not $r.success)     { return "success != true" }
    if (-not $r.deviceToken) { return "deviceToken missing" }
    $true
}
$e2eDevice2Token   = [string]$pair2Raw.deviceToken
$e2eDevice2Headers = @{ "x-device-token" = $e2eDevice2Token }

$null = Invoke-Test -Name "E2E: Contact 2 not invited yet (no joinUrl)" -Method GET -Path "/family/device/E2E-FAMILY-DEVICE-C2/patient-status" -Base $RootUrl `
    -ExtraHeaders $e2eDevice2Headers -Validate {
    param($r)
    if ($r.inCall -ne $true)  { return "inCall should be true (active room exists): $($r.inCall)" }
    if ($r.joinUrl)           { return "joinUrl should be absent before invite: $($r.joinUrl)" }
    $true
}

$null = Invoke-Test -Name "E2E: Kiosk invites contact 2 to room" -Method POST -Path "/call/invite" `
    -Body @{ patientId=$e2ePid; contactId=$cid2; roomName=$e2eRoom } -Validate {
    param($r) if (-not $r.success) { return "success != true" } $true
}

$null = Invoke-Test -Name "E2E: Contact 2 sees joinUrl after invite" -Method GET -Path "/family/device/E2E-FAMILY-DEVICE-C2/patient-status" -Base $RootUrl `
    -ExtraHeaders $e2eDevice2Headers -Validate {
    param($r)
    if ($r.inCall -ne $true)  { return "inCall should be true: $($r.inCall)" }
    if (-not $r.joinUrl)      { return "joinUrl missing after invite (room_invites insert failed)" }
    if ($r.joinUrl -notmatch $e2eRoom) { return "joinUrl doesn't contain roomName: $($r.joinUrl)" }
    $true
}

$null = Invoke-Test -Name "E2E: Unpair contact 2 device" -Method DELETE -Path "/admin/contacts/$cid2/devices/E2E-FAMILY-DEVICE-C2" -Validate {
    param($r) if (-not $r.success) { return "success != true" } $true
}

$null = Invoke-Test -Name "E2E: Kiosk sees incoming call" -Method GET -Path "/kiosk/patient/$e2ePid/incoming-call?deviceId=E2E-TABLET" -Base $RootUrl -Validate {
    param($r)
    if ($null -eq $r -or $r -eq "null") { return "expected a call, got null" }
    if ($r.callId -ne $e2eCallId)        { return "callId mismatch: $($r.callId)" }
    if (-not $r.roomName)                { return "roomName missing" }
    if (-not $r.contactName)             { return "contactName missing" }
    if (-not $r.contactId)               { return "contactId missing" }
    $true
}

$null = Invoke-Test -Name "E2E: Patient in-call after family initiates" -Method GET -Path "/family/device/E2E-FAMILY-DEVICE/patient-status" -Base $RootUrl `
    -ExtraHeaders $e2eDeviceHeaders -Validate {
    param($r)
    if ($r.inCall -ne $true)  { return "inCall should be true: $($r.inCall)" }
    if (-not $r.joinUrl)      { return "joinUrl missing (invite not recorded in room_invites)" }
    if ($r.joinUrl -notmatch "caller=1") { return "joinUrl missing caller=1: $($r.joinUrl)" }
    $true
}

$null = Invoke-Test -Name "E2E: Kiosk answers call" -Method POST -Path "/kiosk/incoming-call/$e2eCallId/answer" -Base $RootUrl -Validate {
    param($r) if (-not $r.success) { return "success != true" } $true
}

$null = Invoke-Test -Name "E2E: Answered call gone from poll" -Method GET -Path "/kiosk/patient/$e2ePid/incoming-call?deviceId=E2E-TABLET" -Base $RootUrl -Validate {
    param($r)
    if ($null -ne $r -and $r -ne "null") { return "call should be gone: $($r.callId)" }
    $true
}

# Decline flow: family starts another call, kiosk declines it
$call2Raw = Invoke-Test -Name "E2E: Family initiates second call (decline test)" -Method POST -Path "/family/device/E2E-FAMILY-DEVICE/call" -Base $RootUrl `
    -ExtraHeaders $e2eDeviceHeaders -Validate {
    param($r)
    if (-not $r.callId) { return "callId missing" }
    $true
}
$e2eCallId2 = [string]$call2Raw.callId

$null = Invoke-Test -Name "E2E: Kiosk declines call" -Method POST -Path "/kiosk/incoming-call/$e2eCallId2/decline" -Base $RootUrl -Validate {
    param($r) if (-not $r.success) { return "success != true" } $true
}

$null = Invoke-Test -Name "E2E: Declined call absent from poll" -Method GET -Path "/kiosk/patient/$e2ePid/incoming-call?deviceId=E2E-TABLET" -Base $RootUrl -Validate {
    param($r)
    if ($null -ne $r -and $r -ne "null") { return "declined call still visible: $($r.callId)" }
    $true
}

# PWA decline: family starts another call, PWA declines via the SW endpoint
$call3Raw = Invoke-Test -Name "E2E: Family initiates third call (PWA decline test)" -Method POST -Path "/family/device/E2E-FAMILY-DEVICE/call" -Base $RootUrl `
    -ExtraHeaders $e2eDeviceHeaders -Validate {
    param($r)
    if (-not $r.roomName) { return "roomName missing" }
    $true
}
$e2eRoom3 = [string]$call3Raw.roomName

$null = Invoke-Test -Name "E2E: PWA declines call (family/device/call/decline)" -Method POST -Path "/family/device/E2E-FAMILY-DEVICE/call/decline" -Base $RootUrl `
    -ExtraHeaders $e2eDeviceHeaders `
    -Body @{ roomName=$e2eRoom3 } -Validate {
    param($r)
    if (-not $r.success) { return "success != true" }
    $true
}

$null = Invoke-Test -Name "E2E: PWA-declined call absent from kiosk poll" -Method GET -Path "/kiosk/patient/$e2ePid/incoming-call?deviceId=E2E-TABLET" -Base $RootUrl -Validate {
    param($r)
    if ($null -ne $r -and $r -ne "null") { return "PWA-declined call still visible: $($r.callId)" }
    $true
}

$null = Invoke-Test -Name "E2E: PWA decline idempotent (second call returns success)" -Method POST -Path "/family/device/E2E-FAMILY-DEVICE/call/decline" -Base $RootUrl `
    -ExtraHeaders $e2eDeviceHeaders `
    -Body @{ roomName=$e2eRoom3 } -Validate {
    param($r)
    if (-not $r.success) { return "idempotent decline should still return success" }
    $true
}

$null = Invoke-Test -Name "E2E: PWA decline wrong token returns 401" -Method POST -Path "/family/device/E2E-FAMILY-DEVICE/call/decline" -Base $RootUrl `
    -ExtraHeaders @{ "x-device-token" = "completely-wrong-token" } `
    -Body @{ roomName=$e2eRoom3 } `
    -Validate { param($r) "Should have returned 401" } `
    -PassOnCodes @(401)

# ── Callback request flow ─────────────────────────────────────
$cbRaw = Invoke-Test -Name "E2E: Family requests callback" -Method POST -Path "/family/device/E2E-FAMILY-DEVICE/callback-request" -Base $RootUrl `
    -ExtraHeaders $e2eDeviceHeaders -Body @{} -Validate {
    param($r)
    if (-not $r.requestId) { return "requestId missing" }
    if (-not $r.createdAt) { return "createdAt missing" }
    if ($r.existing -eq $true) { return "should not be existing on first request" }
    $true
}
$e2eCbRequestId = [string]$cbRaw.requestId

$null = Invoke-Test -Name "E2E: Duplicate callback returns existing" -Method POST -Path "/family/device/E2E-FAMILY-DEVICE/callback-request" -Base $RootUrl `
    -ExtraHeaders $e2eDeviceHeaders -Body @{} -Validate {
    param($r)
    if (-not $r.requestId)    { return "requestId missing" }
    if ($r.existing -ne $true) { return "existing should be true on duplicate: $($r.existing)" }
    $true
}

$null = Invoke-Test -Name "E2E: Tablet sync shows callback request" -Method GET -Path "/tablet/E2E-TABLET/sync" -Validate {
    param($r)
    if ($null -eq $r.callRequests) { return "callRequests missing from sync" }
    $found = $r.callRequests | Where-Object { $_.requestId -eq $e2eCbRequestId }
    if (-not $found) { return "callback request $e2eCbRequestId not in sync" }
    $true
}

$null = Invoke-Test -Name "E2E: Family cancels callback" -Method DELETE -Path "/family/device/E2E-FAMILY-DEVICE/callback-request/$e2eCbRequestId" -Base $RootUrl `
    -ExtraHeaders $e2eDeviceHeaders -Validate {
    param($r) if (-not $r.success) { return "success != true" } $true
}

$null = Invoke-Test -Name "E2E: Cancel same request again returns 404" -Method DELETE -Path "/family/device/E2E-FAMILY-DEVICE/callback-request/$e2eCbRequestId" -Base $RootUrl `
    -ExtraHeaders $e2eDeviceHeaders -Validate { param($r) "should fail" } `
    -PassOnCodes @(404)

$null = Invoke-Test -Name "E2E: Tablet sync no longer shows callback" -Method GET -Path "/tablet/E2E-TABLET/sync" -Validate {
    param($r)
    if ($null -eq $r.callRequests) { return "callRequests missing from sync" }
    $found = $r.callRequests | Where-Object { $_.requestId -eq $e2eCbRequestId }
    if ($found) { return "cancelled callback still in sync" }
    $true
}

# ── Family device management ──────────────────────────────────
$null = Invoke-Test -Name "E2E: Unpair family device" -Method DELETE -Path "/admin/contacts/$cid/devices/E2E-FAMILY-DEVICE" -Validate {
    param($r) if (-not $r.success) { return "success != true" } $true
}

$null = Invoke-Test -Name "E2E: Device gone after unpair" -Method GET -Path "/admin/contacts/$cid/devices" -Validate {
    param($r)
    $found = $r.devices | Where-Object { $_.deviceId -eq "E2E-FAMILY-DEVICE" }
    if ($found) { return "device still present after unpair" }
    $true
}

$null = Invoke-Test -Name "E2E: Device count 0 after unpair" -Method GET -Path "/admin/contacts/list?patientId=$e2ePid" -Validate {
    param($r)
    $found = $r.contacts | Where-Object { $_.contactId -eq $cid }
    if ($found.deviceCount -ne 0) { return "deviceCount should be 0: $($found.deviceCount)" }
    $true
}

# ── Cleanup ───────────────────────────────────────────────────
$null = Invoke-Test -Name "E2E: Delete contact 2" -Method DELETE -Path "/admin/contacts/delete?contactId=$cid2" -Validate {
    param($r) if (-not $r.success) { return "success != true" } $true
}

$null = Invoke-Test -Name "E2E: Delete contact" -Method DELETE -Path "/admin/contacts/delete?contactId=$cid" -Validate {
    param($r) if (-not $r.success) { return "success != true" } $true
}

$null = Invoke-Test -Name "E2E: Delete patient (cascade)" -Method DELETE -Path "/admin/patients/delete?patientId=$e2ePid" -Validate {
    param($r) if (-not $r.success) { return "success != true" } $true
}

$null = Invoke-Test -Name "E2E: Patient gone after delete" -Method GET -Path "/admin/patients/get?patientId=$e2ePid" -Validate {
    param($r)
    if ($r.patientId) { return "patient still exists" }
    $true
}

# =============================================================
#  PHASE 4: INPUT VALIDATION (400 / 401 checks)
# =============================================================
Write-Host ""
Write-Host "[ Phase 4: Input Validation ]" -ForegroundColor Yellow

$validations = @(
    # Patients
    @{ Name="Validation: Create patient - missing name";       Method="POST"; Path="/admin/patients/create";            Body=@{};                                          Codes=@(400) }
    @{ Name="Validation: Get patient - missing patientId";     Method="GET";  Path="/admin/patients/get";                Body=$null;                                        Codes=@(400) }
    # Contacts
    @{ Name="Validation: Create contact - missing patientId";  Method="POST"; Path="/admin/contacts/create";            Body=@{ name="X" };                                Codes=@(400) }
    @{ Name="Validation: Contacts reorder - missing fields";   Method="PUT";  Path="/admin/contacts/order";             Body=@{ patientId="x" };                           Codes=@(400) }
    # Photos
    @{ Name="Validation: Photo upload - missing patientId";    Method="POST"; Path="/admin/photos/upload-url";          Body=@{};                                          Codes=@(400) }
    @{ Name="Validation: Photo confirm - missing photoId";     Method="POST"; Path="/admin/photos/confirm";             Body=@{ patientId="x" };                           Codes=@(400) }
    @{ Name="Validation: Photo delete - missing photoId";      Method="DELETE";Path="/admin/photos/delete";             Body=$null;                                        Codes=@(400) }
    @{ Name="Validation: Photos reorder - missing fields";     Method="PUT";  Path="/admin/photos/order";               Body=@{ patientId="x" };                           Codes=@(400) }
    # Calling
    @{ Name="Validation: Call initiate - missing patientId";   Method="POST"; Path="/call/initiate";                    Body=@{ contactId="x" };                           Codes=@(400) }
    @{ Name="Validation: Call invite - missing roomName";      Method="POST"; Path="/call/invite";                      Body=@{ patientId="x"; contactId="y" };            Codes=@(400) }
    @{ Name="Validation: Call join - missing roomName";        Method="POST"; Path="/call/join";       Base=$RootUrl;   Body=@{ deviceId="x" };                            Codes=@(400) }
    @{ Name="Validation: Call join - missing deviceId";        Method="POST"; Path="/call/join";       Base=$RootUrl;   Body=@{ roomName="x" };                            Codes=@(400) }
    @{ Name="Validation: Kiosk join - missing patientId";      Method="POST"; Path="/call/kiosk-join"; Base=$RootUrl;   Body=@{ roomName="x" };                            Codes=@(400) }
    @{ Name="Validation: Tablet wake - unknown device";        Method="POST"; Path="/admin/tablet/NONEXISTENT/wake"; Body=$null;                                       Codes=@(404) }
    # Family pairing
    @{ Name="Validation: Family pair - missing token";         Method="POST"; Path="/family/pair";     Base=$RootUrl;   Body=@{ deviceId="x" };                            Codes=@(400) }
    @{ Name="Validation: Family pair - expired/bad token";     Method="POST"; Path="/family/pair";     Base=$RootUrl;   Body=@{ token="BAD-TOKEN-XYZ"; deviceId="x" };     Codes=@(401) }
    @{ Name="Validation: FCM update - no device token (401)";   Method="PUT";  Path="/family/device/x/fcm-token"; Base=$RootUrl; Body=@{};                                 Codes=@(401) }
    @{ Name="Validation: FCM update - unknown device (401)";   Method="PUT";  Path="/family/device/NONEXISTENT-DEV/fcm-token"; Base=$RootUrl; Body=@{ fcmToken="T" };     Codes=@(401) }
    @{ Name="Validation: Push sub - no device token (401)";    Method="PUT";  Path="/family/device/x/push-subscription"; Base=$RootUrl; Body=@{};                         Codes=@(401) }
    # Settings
    @{ Name="Validation: Settings - unknown patient";          Method="GET";  Path="/admin/patients/NONEXISTENT-P/settings"; Body=$null;                                   Codes=@(400,404) }
)

foreach ($v in $validations) {
    $base = if ($v.Base) { $v.Base } else { $BaseUrl }
    $null = Invoke-Test -Name $v.Name -Method $v.Method -Path $v.Path -Base $base `
        -Body $v.Body `
        -Validate { param($r) "Expected $($v.Codes -join '/') but got 200" } `
        -PassOnCodes $v.Codes
}

# =============================================================
#  HEALTH REPORT
# =============================================================
$pass  = ($Results | Where-Object { $_.Pass }).Count
$fail  = ($Results | Where-Object { -not $_.Pass }).Count
$total = $Results.Count

Write-Host ""
Write-Host ("=" * 62) -ForegroundColor Cyan
Write-Host ("  HEALTH REPORT  -  $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')") -ForegroundColor Cyan
Write-Host ("=" * 62) -ForegroundColor Cyan
Write-Host ""
Write-Host ("  {0,-44} {1,-6} {2,6} {3}" -f "TEST", "STATUS", "MS", "NOTE")
Write-Host ("  " + ("-" * 60))

foreach ($r in $Results) {
    $color  = if ($r.Pass) { "Green" } else { "Red" }
    $status = if ($r.Pass) { "PASS"  } else { "FAIL" }
    $ms     = if ($r.Ms)   { "$($r.Ms)ms" } else { "n/a" }
    $note   = if ($r.Note.Length -gt 26) { $r.Note.Substring(0,23) + "..." } else { $r.Note }
    Write-Host ("  {0,-44} " -f $r.Name) -NoNewline
    Write-Host ("{0,-6} " -f $status) -ForegroundColor $color -NoNewline
    Write-Host ("{0,6} {1}" -f $ms, $note)
}

Write-Host ""
Write-Host ("  " + ("-" * 60))
$sc = if ($fail -eq 0) { "Green" } else { "Red" }
Write-Host ("  Result: {0}/{1} passed" -f $pass, $total) -ForegroundColor $sc

if ($fail -gt 0) {
    Write-Host ""
    Write-Host "  FAILURES:" -ForegroundColor Red
    $Results | Where-Object { -not $_.Pass } | ForEach-Object {
        Write-Host ("    X {0}: {1}" -f $_.Name, $_.Note) -ForegroundColor Red
    }
}

Write-Host ""
Write-Host ("=" * 62) -ForegroundColor Cyan
Write-Host ""
