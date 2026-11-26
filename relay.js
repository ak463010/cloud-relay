/**
 * BS Fountain Controller - Secure Cloud Relay Server
 *
 * Bridges remote browser requests to an ESP32-S3 fountain controller
 * over an outbound WebSocket reverse tunnel (no port forwarding required).
 */

const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = parseInt(process.env.PORT || '8080', 10);
const TUNNEL_TOKEN = process.env.TUNNEL_TOKEN || 'change-this-to-a-secure-secret-token';
const WEB_USERNAME = process.env.WEB_USERNAME || 'admin';
const WEB_PASSWORD = process.env.WEB_PASSWORD || ''; // If empty, basic auth is disabled

// Protocol Constants
const FRAME_REQ_START = 0x01;
const FRAME_REQ_BODY  = 0x02;
const FRAME_REQ_ABORT = 0x03;
const FRAME_RES_START = 0x81;
const FRAME_RES_DATA  = 0x82;
const FRAME_RES_ABORT = 0x83;

const FLAG_NONE  = 0x00;
const FLAG_EOF   = 0x01;
const FLAG_ERROR = 0x02;

let activeDeviceSocket = null;
let activeDeviceId = 'unknown';
let nextRequestId = 1;
const pendingRequests = new Map(); // requestId -> { req, res, timer }

function createFrame(type, flags, requestId, payloadBuffer) {
    const len = payloadBuffer ? payloadBuffer.length : 0;
    const frame = Buffer.alloc(8 + len);
    frame.writeUInt8(type, 0);
    frame.writeUInt8(flags, 1);
    frame.writeUInt16BE(len, 2);
    frame.writeUInt32BE(requestId, 4);
    if (len > 0) {
        payloadBuffer.copy(frame, 8);
    }
    return frame;
}

// HTTP Server for Browser Clients
const server = http.createServer((req, res) => {
    // Health / liveness check endpoint for orchestrators (Dokploy, Docker, Traefik, K8s)
    if (req.url === '/health' || req.url === '/ping') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            status: 'ok',
            deviceConnected: !!(activeDeviceSocket && activeDeviceSocket.readyState === 1),
            deviceId: activeDeviceId,
            uptime: Math.floor(process.uptime())
        }));
        return;
    }

    // Basic Auth Gate (if WEB_PASSWORD is set)
    if (WEB_PASSWORD) {
        const authHeader = req.headers['authorization'];
        if (!authHeader || !authHeader.startsWith('Basic ')) {
            res.writeHead(401, {
                'WWW-Authenticate': 'Basic realm="BS Fountain Controller Remote Access"',
                'Content-Type': 'text/plain'
            });
            res.end('Authentication required');
            return;
        }

        const credentials = Buffer.from(authHeader.slice(6), 'base64').toString('utf8');
        const [user, pass] = credentials.split(':');
        if (user !== WEB_USERNAME || pass !== WEB_PASSWORD) {
            res.writeHead(403, { 'Content-Type': 'text/plain' });
            res.end('Access denied: Invalid credentials');
            return;
        }
    }

    if (!activeDeviceSocket || activeDeviceSocket.readyState !== 1) {
        res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`
            <!doctype html>
            <html>
            <head><title>Controller Offline - BSFC</title><meta name="viewport" content="width=device-width,initial-scale=1"></head>
            <body style="font-family:sans-serif;background:#0d1117;color:#c9d1d9;text-align:center;padding:50px 20px;">
                <h1 style="color:#f85149;">Controller Offline</h1>
                <p>The Fountain Controller is not currently connected to this cloud relay.</p>
                <p style="font-size:13px;color:#8b949e;">Ensure the controller has Wi-Fi internet access and has been commissioned with the matching tunnel token.</p>
                <button onclick="location.reload()" style="background:#238636;color:white;border:none;padding:10px 20px;border-radius:6px;cursor:pointer;margin-top:20px;">Check Again</button>
            </body>
            </html>
        `);
        return;
    }

    const requestId = nextRequestId++;
    if (nextRequestId >= 0x7fffffff) nextRequestId = 1;

    // Request Timeout Guard (60 seconds)
    const timeout = setTimeout(() => {
        if (pendingRequests.has(requestId)) {
            pendingRequests.delete(requestId);
            if (!res.headersSent) {
                res.writeHead(504, { 'Content-Type': 'text/plain' });
                res.end('Gateway Timeout: Controller did not respond in time');
            } else {
                res.end();
            }
            if (activeDeviceSocket && activeDeviceSocket.readyState === 1) {
                activeDeviceSocket.send(createFrame(FRAME_REQ_ABORT, FLAG_ERROR, requestId, null));
            }
        }
    }, 60000);

    pendingRequests.set(requestId, { req, res, timeout });

    // Sanitize headers to forward to ESP32
    const forwardHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
        const lower = k.toLowerCase();
        if (lower !== 'authorization' && lower !== 'host' && lower !== 'connection') {
            forwardHeaders[lower] = v;
        }
    }

    const startPayload = Buffer.from(JSON.stringify({
        method: req.method,
        path: req.url,
        headers: forwardHeaders
    }), 'utf8');

    // Detect if this request has a body
    const hasBody = req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH';

    if (!hasBody) {
        // Send REQ_START with FLAG_EOF
        activeDeviceSocket.send(createFrame(FRAME_REQ_START, FLAG_EOF, requestId, startPayload));
    } else {
        // Send REQ_START
        activeDeviceSocket.send(createFrame(FRAME_REQ_START, FLAG_NONE, requestId, startPayload));

        req.on('data', chunk => {
            if (activeDeviceSocket && activeDeviceSocket.readyState === 1) {
                const MAX_CHUNK = 3500;
                for (let i = 0; i < chunk.length; i += MAX_CHUNK) {
                    const sub = chunk.subarray(i, Math.min(chunk.length, i + MAX_CHUNK));
                    activeDeviceSocket.send(createFrame(FRAME_REQ_BODY, FLAG_NONE, requestId, sub));
                }
            }
        });

        req.on('end', () => {
            if (activeDeviceSocket && activeDeviceSocket.readyState === 1) {
                activeDeviceSocket.send(createFrame(FRAME_REQ_BODY, FLAG_EOF, requestId, Buffer.alloc(0)));
            }
        });

        req.on('error', err => {
            console.error(`Request ${requestId} read error:`, err);
            if (pendingRequests.has(requestId)) {
                clearTimeout(timeout);
                pendingRequests.delete(requestId);
            }
            if (activeDeviceSocket && activeDeviceSocket.readyState === 1) {
                activeDeviceSocket.send(createFrame(FRAME_REQ_ABORT, FLAG_ERROR, requestId, null));
            }
        });
    }
});

// WebSocket Server for ESP32-S3 Controller
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (url.pathname !== '/device-tunnel' && url.pathname !== '/tunnel') {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
    }

    // Verify Authentication Token
    const authHeader = req.headers['authorization'] || '';
    const tokenQuery = url.searchParams.get('token') || '';
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : tokenQuery.trim();

    if (bearerToken !== TUNNEL_TOKEN) {
        console.warn(`[Tunnel] Unauthorized connection attempt from ${req.socket.remoteAddress}`);
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
    }

    const deviceId = req.headers['x-device-id'] || url.searchParams.get('device') || 'default-controller';

    wss.handleUpgrade(req, socket, head, ws => {
        wss.emit('connection', ws, req, deviceId);
    });
});

wss.on('connection', (ws, req, deviceId) => {
    console.log(`[Tunnel] Controller connected! Device ID: ${deviceId} (${req.socket.remoteAddress})`);

    // If an existing device was connected, close the previous one
    if (activeDeviceSocket && activeDeviceSocket !== ws) {
        try {
            activeDeviceSocket.close(1000, 'Replaced by new connection');
        } catch (_) {}
    }

    activeDeviceSocket = ws;
    activeDeviceId = deviceId;

    ws.on('message', data => {
        if (!Buffer.isBuffer(data) || data.length < 8) return;

        const type = data.readUInt8(0);
        const flags = data.readUInt8(1);
        const length = data.readUInt16BE(2);
        const requestId = data.readUInt32BE(4);
        const payload = data.subarray(8, 8 + length);

        const pending = pendingRequests.get(requestId);
        if (!pending) return;

        const { res, timeout } = pending;

        if (type === FRAME_RES_START) {
            try {
                const meta = JSON.parse(payload.toString('utf8'));
                const cleanHeaders = {};
                if (meta.headers && typeof meta.headers === 'object') {
                    for (const [k, v] of Object.entries(meta.headers)) {
                        const lower = k.toLowerCase();
                        if (lower !== 'connection' && lower !== 'transfer-encoding' && lower !== 'keep-alive') {
                            cleanHeaders[k] = v;
                        }
                    }
                }
                res.writeHead(meta.status || 200, meta.statusText || 'OK', cleanHeaders);
            } catch (err) {
                console.error(`Error parsing RES_START JSON for req ${requestId}:`, err);
                clearTimeout(timeout);
                pendingRequests.delete(requestId);
                res.writeHead(502, { 'Content-Type': 'text/plain' });
                res.end('Bad Gateway: Malformed response headers from controller');
            }
        } else if (type === FRAME_RES_DATA) {
            if (payload.length > 0) {
                res.write(payload);
            }
            if ((flags & FLAG_EOF) !== 0) {
                clearTimeout(timeout);
                pendingRequests.delete(requestId);
                res.end();
            }
        } else if (type === FRAME_RES_ABORT) {
            clearTimeout(timeout);
            pendingRequests.delete(requestId);
            if (!res.headersSent) {
                res.writeHead(502, { 'Content-Type': 'text/plain' });
                res.end('Bad Gateway: Controller aborted response');
            } else {
                res.end();
            }
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`[Tunnel] Controller disconnected (code: ${code}, reason: ${reason})`);
        if (activeDeviceSocket === ws) {
            activeDeviceSocket = null;
            // Clean up any pending requests
            for (const [id, pending] of pendingRequests.entries()) {
                clearTimeout(pending.timeout);
                if (!pending.res.headersSent) {
                    pending.res.writeHead(502, { 'Content-Type': 'text/plain' });
                    pending.res.end('Bad Gateway: Controller connection closed prematurely');
                } else {
                    pending.res.end();
                }
            }
            pendingRequests.clear();
        }
    });

    ws.on('error', err => {
        console.error('[Tunnel] WebSocket error:', err);
    });
});

server.listen(PORT, () => {
    console.log(`=======================================================`);
    console.log(` BS Fountain Controller Cloud Relay running on port ${PORT}`);
    console.log(` Remote Web Interface: http://localhost:${PORT}`);
    console.log(` Device Tunnel Endpoint: ws://localhost:${PORT}/device-tunnel`);
    console.log(` Health Check: http://localhost:${PORT}/health`);
    console.log(`=======================================================`);
});

// Graceful shutdown handling for container orchestrators (SIGTERM / SIGINT)
const shutdown = (signal) => {
    console.log(`[Relay] Received ${signal}, shutting down gracefully...`);
    if (activeDeviceSocket) {
        try {
            activeDeviceSocket.close(1001, 'Server shutting down');
        } catch (_) {}
    }
    server.close(() => {
        console.log('[Relay] Server closed cleanly.');
        process.exit(0);
    });
    // Force exit after 5 seconds if lingering connections keep loop open
    setTimeout(() => {
        console.warn('[Relay] Forcing process exit.');
        process.exit(0);
    }, 5000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

