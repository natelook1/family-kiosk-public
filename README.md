# Family Kiosk System

A comprehensive, secure, and remote-managed video calling and digital photo frame solution designed specifically for seniors. This project transforms a standard Android tablet into a dedicated, locked-down communication hub.

## 🏗 Architecture Overview

The system is composed of five core architectural components:
1.  **Two Android APKs**: 
    *   **Kiosk APK (`/kiosk-apk`)**: Dedicated senior device owner app that enforces kiosk mode and provides a hardware bridge for the UI.
    *   **Family APK (`/family-apk`)**: Wrapper app for family members to receive push notifications and manage calls.
2.  **Two Web Apps**: React interfaces for the **Kiosk UI** (`/kiosk-app`) and the **Family App** (`/family-app`).
3.  **Backend & Admin UI**: A Node.js API (`/backend/api`) that also hosts the **Admin UI** (`/admin-ui`) as a static site.
4.  **R2 Photo Upload Cache**: A **Cloudflare R2** bucket used as a high-performance staging area for photo uploads and asset distribution (including APK binaries).
5.  **LiveKit Server:** An external or self-hosted WebRTC stack used for high-quality, low-latency video and audio communication.

## 🌐 Infrastructure & Deployment

The system is architected for High Availability (HA) and zero-downtime deployments utilizing a self-hosted private cloud topology:
* **Container Orchestration:** Hosted as a multi-node replicated stack inside a **Docker Swarm cluster** on Linux VMs.
* **Hypervisor Fabric:** Managed across a **3-node Proxmox VE HA Cluster**, enabling instant node failover and split-brain mitigation.
* **Edge Routing & Ingress:** Exposes secure API gateway traffic through **Traefik v3** acting as the cluster reverse proxy, protected behind a zero-trust **Cloudflare Tunnel** network mesh (eliminating the need for open firewall inbound ports).

## ✨ Key Features

### Kiosk Experience
*   **Zero-Touch Operation:** Incoming calls can be answered with a single tap. The screen automatically wakes and bypasses keyguards on incoming calls.
*   **Hardened Kiosk Mode:** Enforces Lock Task Mode (Screen Pinning) via Device Policy Manager. Prevents users from exiting the app or accessing system settings.
*   **Remote Management:** Admins can remotely adjust volume, brightness, font scale, and screen orientation via the backend.
*   **Automated Continuous Deployment (OTA):** Employs an automated Over-The-Air deployment lifecycle manager to pull validated binary releases seamlessly without manual maintenance cycles.
*   **Intelligent Audio Routing:** Specifically handles Bluetooth SCO (Synchronous Connection Oriented) protocols to ensure seamless compatibility with hearing aids and specialized senior headsets.
*   **Proactive Maintenance:** Implements scheduled daily system restarts and "Last-Gasp" error reporting, where uncaught exceptions are flushed to the backend synchronously before process termination.

### Family Features
*   **Secure Pairing:** Simple QR code or deep-link pairing to link a family member's device to a specific patient.
*   **Native Android App & PWA:** Full dark-themed UI matching across both the Family APK and the web PWA (`family-call.looknet.ca`), with avatar, status rings, and accent colour theming.
*   **Video Calls:** One-tap outbound calls with ringback tone, PiP mode, and intelligent audio routing (speaker, earpiece, Bluetooth SCO).
*   **Call Declined Feedback:** When the kiosk recipient declines, the LiveKit room is deleted server-side and the caller receives immediate "Call declined" feedback.
*   **Callback Requests:** Family can send "Thinking of you" notifications that appear as "Call Me" prompts on the kiosk.
*   **Recent Call History:** Shows the last 3 calls with answered/declined/missed status.
*   **Pull-to-Refresh:** Swipe down to force-refresh patient status and call history.
*   **Push Notifications:** Web push (PWA) and FCM (Android APK) with notification-action decline support.
*   **OTA Updates:** Family APK self-updates via the same OTA pipeline as the kiosk APK.

## 🚀 Getting Started

### Backend Deployment
The backend is deployed to the production environment using a PowerShell script that handles building the Docker image and updating the Swarm stack via a code server:

```powershell
.\deploy-backend.ps1
```

### Kiosk APK Provisioning
To enable full kiosk restrictions, the app must be set as the **Device Owner**.

1. Build the release APK using the provided `build.gradle.kts` configuration.
2. Factory reset your target Android tablet.
3. On the "Welcome" screen, tap the screen 6 times in the same spot to trigger the QR setup.
4. Alternatively, install the APK via ADB and run:
   ```bash
   adb shell dpm set-device-owner ca.looknet.familykiosk/.DeviceAdminReceiver
   ```

### Family App Setup
1.  Navigate to `/family-app`.
2.  Configure environment variables (e.g., `.env`) to point to your Backend API.
3.  Run `npm run dev` to start the web interface.

## 🛠 Technical Details

### Hardware Integration (JS Bridge)
The Kiosk UI interacts with Android hardware through the `KioskJsInterface`. Key methods include:
*   **Transparent Proxying:** The Kotlin layer intercepts `WebView` requests via `shouldInterceptRequest`, serving locally cached R2 assets to ensure offline-first slideshow performance.
*   **Policy-Based Permissioning:** Automatically grants sensitive hardware permissions (Camera/Mic) via `DevicePolicyManager` to eliminate user-facing prompts.

### Lean Backend Architecture
*   **SDK-less Cloud Integrations:** Implemented Google OAuth2 and FCM v1 signaling manually using the native Node `crypto` library to minimize container footprint and avoid heavy dependency chains.
*   **Synchronous SQLite Reliability:** Utilizes SQLite in WAL mode with a synchronous processing model to guarantee data integrity and zero-latency lookups for kiosk heartbeats.

### Database Schema
The system uses SQLite (Better-SQLite3) with WAL mode enabled for performance. Key tables:
*   `patients`: Core patient/elder records.
*   `contacts`: Family members linked to patients.
*   `device_storage`: Heartbeat data and health reports from the tablets.
*   `active_rooms`: Real-time tracking of LiveKit sessions.

### 🧪 Automated End-to-End (E2E) Testing
The backend engine includes a rigorous automated test pipeline (`test_endpoints.ps1`) that executes logic validation across all layers before production delivery:
* **Lifecycle State Validation:** Simulates full E2E scenarios including safe dynamic schema mutations (Patient/Contact creation, photo ordering updates).
* **Deterministic Database Cleanups:** Automatically targets, traps, and isolates E2E test data mutations to prevent production database drift.
* **Auth Enforcement Verification:** Validates negative-case security scenarios, ensuring unauthorized or unsigned requests (e.g., bad API keys or invalid device tokens) are rigorously dropped with standard `401 Unauthorized` responses.

### Environment Variables
| Variable | Description |
| :--- | :--- |
| `API_KEY` | Shared secret for Admin/Webhook routes |
| `LIVEKIT_API_KEY` | LiveKit authentication keys |
| `LIVEKIT_WS_URL` | LiveKit signaling server URL |
| `R2_BUCKET_NAME` | Cloudflare R2 or S3 bucket destination for media and APK assets |
| `FCM_SERVICE_ACCOUNT` | JSON string stringified for Firebase Cloud Messaging authorization |

## 🔒 Security
*   **Device Token Auth:** Family devices use a unique `device_token` generated during pairing for all sensitive API operations.
*   **Timing-Safe Comparisons:** Utilizes standard constant-time cryptographic tools for verifying device tokens to mitigate side-channel timing attacks.
*   **Private Scopes:** Sensitive device logs and storage health reports are strictly restricted to authenticated admin/tablet scopes.

## 📜 License
Proprietary - Looknet Infrastructure.