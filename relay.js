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
// The controller owns one loopback HTTP socket, not one socket per request ID.
const requestQueue = [];
let activeRequest = null;
const MAX_QUEUED_REQUESTS = 16;
const REQUEST_IDLE_MS = 60000;
const MAX_BODY_CHUNK = 3500;

function sendError(res, status, error, code) {
    if (!res.headersSent) {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: false, error, code }));
    } else {
        // A partial download is not a successful HTTP response.
        res.destroy();
    }
}

function finishRequest(job, { abort = false, status, error } = {}) {
    if (job === activeRequest) {
        activeRequest = null;
        if (abort && job.ws.readyState === 1) {
            job.ws.send(createFrame(FRAME_REQ_ABORT, FLAG_ERROR, job.id, null), () => {});
        }
    } else {
        const index = requestQueue.indexOf(job);
        if (index < 0) return;
        requestQueue.splice(index, 1);
    }
    clearTimeout(job.timer);
    job.req.resume(); // Drain any unforwarded body without buffering it.
    if (status && !job.res.destroyed) sendError(job.res, status, error);
    queueMicrotask(startNextRequest);
}

function startNextRequest() {
    if (activeRequest || requestQueue.length === 0) return;
    const job = requestQueue.shift();
    activeRequest = job;
    clearTimeout(job.timer);
    job.timer = setTimeout(() => finishRequest(job, {
        abort: true, status: 504, error: 'No progress forwarding the request to the controller for 60 seconds',
    }), REQUEST_IDLE_MS);
    void forwardRequest(job);
}

async function sendRequestFrame(job, type, flags, payload) {
    if (job !== activeRequest || job.ws.readyState !== 1) return false;
    await new Promise((resolve, reject) => {
        job.ws.send(createFrame(type, flags, job.id, payload), err => err ? reject(err) : resolve());
    });
    if (job !== activeRequest) return false;
    if (type === FRAME_REQ_BODY && payload) job.forwardedBytes += payload.length;
    job.timer.refresh();
    return true;
}

async function forwardRequest(job) {
    const { req } = job;
    const headers = {};
    for (const [key, value] of Object.entries(req.headers)) {
        if (key !== 'authorization' && key !== 'host' && key !== 'connection') headers[key] = value;
    }
    const hasBody = Number(req.headers['content-length']) > 0 || Boolean(req.headers['transfer-encoding']);
    const meta = Buffer.from(JSON.stringify({ method: req.method, path: req.url, headers }));
    try {
        if (!await sendRequestFrame(job, FRAME_REQ_START, hasBody ? FLAG_NONE : FLAG_EOF, meta)) return;
        if (!hasBody) return;
        for await (const chunk of req.iterator({ destroyOnReturn: false })) {
            for (let i = 0; i < chunk.length; i += MAX_BODY_CHUNK) {
                if (!await sendRequestFrame(job, FRAME_REQ_BODY, FLAG_NONE, chunk.subarray(i, i + MAX_BODY_CHUNK))) return;
            }
        }
        await sendRequestFrame(job, FRAME_REQ_BODY, FLAG_EOF, null);
    } catch (err) {
        finishRequest(job, { abort: true, status: 502, error: 'Could not forward the request to the controller' });
        console.warn(`Request ${job.id} forwarding failed: ${err.message}`);
    }
}

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
        req.resume();
        const path = req.url.split('?', 1)[0];
        if (req.method !== 'GET' || path === '/api' || path.startsWith('/api/')) {
            sendError(res, 503, 'The controller tunnel is offline. Wait for it to reconnect, then retry.', 'TUNNEL_OFFLINE');
            return;
        }
        res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
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

    if (req.headers['transfer-encoding']) {
        req.resume();
        sendError(res, 411, 'The controller requires a fixed Content-Length for request bodies');
        return;
    }
    if (requestQueue.length >= MAX_QUEUED_REQUESTS) {
        req.resume();
        sendError(res, 503, 'Controller is busy; retry after the current operation finishes.', 'CONTROLLER_BUSY');
        return;
    }

    const job = { id: nextRequestId++, req, res, ws: activeDeviceSocket, forwardedBytes: 0 };
    if (nextRequestId >= 0x7fffffff) nextRequestId = 1;
    job.timer = setTimeout(() => finishRequest(job, {
        status: 504, error: 'Timed out waiting for the controller to finish another request',
    }), REQUEST_IDLE_MS);
    req.on('error', () => finishRequest(job, { abort: true, status: 502, error: 'Browser request was interrupted' }));
    res.on('close', () => finishRequest(job, { abort: true }));
    requestQueue.push(job);
    startNextRequest();
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

        const job = activeRequest;
        if (!job || job.ws !== ws || job.id !== requestId) return;

        const { res } = job;
        job.timer.refresh();

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
                finishRequest(job, { abort: true, status: 502, error: 'Malformed response headers from controller' });
            }
        } else if (type === FRAME_RES_DATA) {
            if (payload.length > 0) {
                res.write(payload);
            }
            if ((flags & FLAG_EOF) !== 0) {
                finishRequest(job);
                res.end();
            }
        } else if (type === FRAME_RES_ABORT) {
            finishRequest(job, { status: 502, error: 'Controller aborted the request' });
        }
    });

    ws.on('close', (code, reason) => {
        console.log(`[Tunnel] Controller disconnected (code: ${code}, reason: ${reason})`);
        if (activeDeviceSocket === ws) activeDeviceSocket = null;
        const failure = { status: 502, error: 'Controller connection closed prematurely' };
        if (activeRequest?.ws === ws) {
            const job = activeRequest;
            const expectedBytes = Number(job.req.headers['content-length']) || 0;
            console.warn(`[Tunnel] Disconnected during request ${job.id} (${job.req.method}): ${job.forwardedBytes}/${expectedBytes} body bytes sent to WebSocket`);
            finishRequest(job, failure);
        }
        for (const job of [...requestQueue]) {
            if (job.ws === ws) finishRequest(job, failure);
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

