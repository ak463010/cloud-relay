# BS Fountain Controller - Cloud Relay Server

This lightweight Node.js relay server allows you to remotely access and configure your BS Fountain Controller from anywhere in the world **without port forwarding**, dynamic DNS, or public IP addresses.

---

## How It Works

1. The **ESP32-S3 Controller** establishes an outbound secure WebSocket connection (`wss://your-relay-host/device-tunnel`) to this server as soon as it connects to Wi-Fi.
2. When you open `https://your-relay-host` in your web browser (phone or laptop), this relay server:
   - Authenticates you (via HTTP Basic Auth).
   - Multiplexes your browser's HTTP requests directly to the ESP32 through the open WebSocket tunnel.
   - Streams the ESP32's responses, web UI, SD card file transfers, and APIs back to your browser with zero latency.

---

## Environment Variables

| Variable | Required | Default | Description |
| :--- | :---: | :---: | :--- |
| `PORT` | Optional | `8080` | Port for the HTTP and WebSocket server. |
| `TUNNEL_TOKEN` | **Yes** | — | Secret pre-shared key. Must match the token configured in the controller's NVS storage. |
| `WEB_USERNAME` | Optional | `admin` | Username for remote web browser access. |
| `WEB_PASSWORD` | Recommended | `""` | Password for remote web browser access. If unset, access is unauthenticated. |

---

## Free Cloud Deployment (1-Click Options)

### Option A: Render.com (Free Web Service)
1. Fork or push this repository to GitHub.
2. Sign up at [Render.com](https://render.com).
3. Create a **New Web Service** pointing to your repository.
4. Set:
   - **Root Directory**: `tools/cloud-relay`
   - **Runtime**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node relay.js`
5. Under **Environment Variables**, add:
   - `TUNNEL_TOKEN`: Your secret token (e.g. `my-fountain-secure-token-2026`)
   - `WEB_PASSWORD`: Your chosen admin password for remote access
6. Render gives you an HTTPS URL: `https://your-fountain-relay.onrender.com`.

---

### Option B: Local Testing (or Self-Hosted VPS)

```bash
cd tools/cloud-relay
npm install
export TUNNEL_TOKEN="my-secret-token"
export WEB_PASSWORD="my-secure-password"
node relay.js
```

---

## Configuring the Controller

1. On the controller's local configuration page:
   - Set `tunnel.enabled`: `true`
   - Set `tunnel.server_url`: `wss://your-fountain-relay.onrender.com/device-tunnel`
   - Set `tunnel.device_id`: `fountain-01`
2. Save the settings.
3. Open `/api/tunnel/credentials` or use the commissioning API to save your `TUNNEL_TOKEN` into the controller's internal encrypted NVS.
4. You can now access your controller anywhere at `https://your-fountain-relay.onrender.com`!
