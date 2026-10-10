'use strict';

// Kleiner HTTP-Server, der die iPhone-Web-App (PWA aus /www) ausliefert und
// eine schmale JSON-API bereitstellt:
//   GET  /api/state    kompletter Snapshot (Etagen -> Räume -> Geräte)
//   GET  /api/events   Server-Sent-Events mit Live-Änderungen
//   POST /api/command  Befehl an ein Gerät
// Alle /api/*-Aufrufe sind per Token geschützt (Authorization: Bearer <token>,
// bei EventSource als ?token=<token>, da EventSource keine Header setzen kann).

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STATIC_FILES = {
    '/': ['index.html', 'text/html; charset=utf-8'],
    '/index.html': ['index.html', 'text/html; charset=utf-8'],
    '/app.js': ['app.js', 'application/javascript; charset=utf-8'],
    '/app.css': ['app.css', 'text/css; charset=utf-8'],
    '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json'],
    '/icon-192.png': ['icon-192.png', 'image/png'],
    '/icon-512.png': ['icon-512.png', 'image/png'],
    '/apple-touch-icon.png': ['apple-touch-icon.png', 'image/png']
};

const MAX_BODY_BYTES = 4096;
const MAX_CONFIG_BYTES = 128 * 1024;
const MAX_SSE_CLIENTS = 20;
const MAX_FAILED_AUTH = 10;               // Fehlversuche pro IP ...
const FAIL_WINDOW_MS = 10 * 60 * 1000;    // ... innerhalb dieses Zeitfensters
const BLOCK_MS = 10 * 60 * 1000;          // danach so lange gesperrt

class WebServer {
    /**
     * @param {object} adapter  Adapter-Instanz (log, setInterval, clearInterval)
     * @param {object} api      { getSnapshot(), executeCommand(cmd) }
     * @param {object} opts     { port, token, wwwDir }
     */
    constructor(adapter, api, opts) {
        this.adapter = adapter;
        this.api = api;
        this.port = opts.port;
        this.tokenHash = crypto.createHash('sha256').update(String(opts.token)).digest();
        this.wwwDir = opts.wwwDir || path.join(__dirname, '..', 'www');

        this.files = {};          // Pfad -> { body, type }
        this.sseClients = new Set();
        this.failures = new Map(); // ip -> { count, first, blockedUntil }
        this.server = null;
        this.heartbeat = null;
    }

    start() {
        // Statische Dateien einmalig einlesen
        for (const [urlPath, [file, type]] of Object.entries(STATIC_FILES)) {
            this.files[urlPath] = { body: fs.readFileSync(path.join(this.wwwDir, file)), type };
        }

        this.server = http.createServer((req, res) => this.handle(req, res));
        this.server.on('error', err => {
            this.adapter.log.error(`Web-Server-Fehler: ${err.message}` +
                (err.code === 'EADDRINUSE' ? ` (Port ${this.port} ist bereits belegt - anderen Port wählen)` : ''));
        });
        this.server.listen(this.port, '0.0.0.0', () => {
            this.adapter.log.info(`Web-App erreichbar auf Port ${this.port} (http://<server-ip>:${this.port}/)`);
        });

        this.heartbeat = this.adapter.setInterval(() => {
            for (const res of this.sseClients) res.write(': ping\n\n');
        }, 20000);
    }

    stop() {
        if (this.heartbeat) this.adapter.clearInterval(this.heartbeat);
        for (const res of this.sseClients) {
            try { res.end(); } catch (e) { /* ignorieren */ }
        }
        this.sseClients.clear();
        if (this.server) {
            this.server.close();
            if (typeof this.server.closeAllConnections === 'function') this.server.closeAllConnections();
            this.server = null;
        }
    }

    // Ereignis an alle verbundenen Apps senden
    broadcast(event) {
        if (!this.sseClients.size) return;
        const data = `data: ${JSON.stringify(event)}\n\n`;
        for (const res of this.sseClients) res.write(data);
    }

    // ---- Anfragen ------------------------------------------------------
    handle(req, res) {
        try {
            const url = new URL(req.url, 'http://localhost');
            const p = url.pathname;

            res.setHeader('X-Content-Type-Options', 'nosniff');
            res.setHeader('Referrer-Policy', 'no-referrer');

            if (STATIC_FILES[p]) {
                if (req.method !== 'GET' && req.method !== 'HEAD') return this.sendJson(res, 405, { error: 'Methode nicht erlaubt' });
                return this.sendStatic(req, res, p);
            }
            if (p.startsWith('/api/')) return this.handleApi(req, res, url);
            return this.sendJson(res, 404, { error: 'Nicht gefunden' });
        } catch (err) {
            this.adapter.log.error('Web-Server: unerwarteter Fehler: ' + err.message);
            if (!res.headersSent) this.sendJson(res, 500, { error: 'Interner Fehler' });
        }
    }

    sendStatic(req, res, p) {
        const f = this.files[p];
        const headers = {
            'Content-Type': f.type,
            'Content-Length': f.body.length,
            'Cache-Control': 'no-cache'
        };
        if (f.type.startsWith('text/html')) {
            // Striktes CSP: nur eigene Dateien, keine Fremdquellen
            headers['Content-Security-Policy'] =
                "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'";
        }
        res.writeHead(200, headers);
        res.end(req.method === 'HEAD' ? undefined : f.body);
    }

    sendJson(res, status, obj) {
        const body = JSON.stringify(obj);
        res.writeHead(status, {
            'Content-Type': 'application/json; charset=utf-8',
            'Content-Length': Buffer.byteLength(body),
            'Cache-Control': 'no-store'
        });
        res.end(body);
    }

    // ---- Authentifizierung --------------------------------------------
    clientIp(req) {
        return req.socket.remoteAddress || 'unknown';
    }

    isBlocked(ip) {
        const f = this.failures.get(ip);
        return !!(f && f.blockedUntil && f.blockedUntil > Date.now());
    }

    registerFailure(ip) {
        const now = Date.now();
        if (this.failures.size > 1000) this.failures.clear(); // Speicher begrenzen
        let f = this.failures.get(ip);
        if (!f || now - f.first > FAIL_WINDOW_MS) f = { count: 0, first: now, blockedUntil: 0 };
        f.count++;
        if (f.count >= MAX_FAILED_AUTH) {
            f.blockedUntil = now + BLOCK_MS;
            this.adapter.log.warn(`Web-App: zu viele fehlgeschlagene Anmeldeversuche von ${ip} - für 10 Minuten gesperrt.`);
        }
        this.failures.set(ip, f);
    }

    isAuthorized(req, url) {
        const header = req.headers['authorization'] || '';
        const supplied = header.startsWith('Bearer ') ? header.slice(7) : (url.searchParams.get('token') || '');
        const hash = crypto.createHash('sha256').update(supplied).digest();
        return crypto.timingSafeEqual(hash, this.tokenHash);
    }

    // ---- API -----------------------------------------------------------
    handleApi(req, res, url) {
        const ip = this.clientIp(req);
        if (this.isBlocked(ip)) return this.sendJson(res, 429, { error: 'Zu viele Fehlversuche, bitte später erneut versuchen' });

        if (!this.isAuthorized(req, url)) {
            this.registerFailure(ip);
            return this.sendJson(res, 401, { error: 'Nicht autorisiert' });
        }
        this.failures.delete(ip);

        const p = url.pathname;

        if (p === '/api/state' && req.method === 'GET') {
            return this.sendJson(res, 200, this.api.getSnapshot());
        }

        if (p === '/api/events' && req.method === 'GET') {
            if (this.sseClients.size >= MAX_SSE_CLIENTS) return this.sendJson(res, 503, { error: 'Zu viele Verbindungen' });
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-store',
                'Connection': 'keep-alive',
                'X-Accel-Buffering': 'no'
            });
            res.write('retry: 3000\n\n');
            this.sseClients.add(res);
            req.on('close', () => this.sseClients.delete(res));
            return;
        }

        if (p === '/api/command' && req.method === 'POST') {
            return this.readJson(req, res, MAX_BODY_BYTES, async body => {
                await this.api.executeCommand(body);
                return { ok: true };
            });
        }

        if (p === '/api/config' && req.method === 'POST') {
            return this.readJson(req, res, MAX_CONFIG_BYTES, async body => {
                if (!body || typeof body !== 'object' || Array.isArray(body) || !body.config) {
                    throw Object.assign(new Error('Ungültige Anfrage'), { status: 400 });
                }
                const by = typeof body.clientId === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(body.clientId) ? body.clientId : '';
                await this.api.saveConfig(body.config, by);
                return { ok: true };
            });
        }

        return this.sendJson(res, 404, { error: 'Nicht gefunden' });
    }

    // JSON-Body mit Größenlimit lesen und an handler(body) übergeben
    readJson(req, res, limit, handler) {
        if (!(req.headers['content-type'] || '').includes('application/json')) {
            return this.sendJson(res, 415, { error: 'Content-Type muss application/json sein' });
        }

        let size = 0;
        const chunks = [];
        let aborted = false;

        req.on('data', chunk => {
            if (aborted) return;
            size += chunk.length;
            if (size > limit) {
                aborted = true;
                chunks.length = 0;
                // Regulär antworten und die Verbindung danach schließen (statt
                // sie abrupt zu kappen); weitere Daten werden verworfen.
                res.setHeader('Connection', 'close');
                this.sendJson(res, 413, { error: 'Anfrage zu groß' });
                return;
            }
            chunks.push(chunk);
        });

        req.on('end', async () => {
            if (aborted) return;
            let body;
            try {
                body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            } catch (e) {
                return this.sendJson(res, 400, { error: 'Ungültiges JSON' });
            }
            try {
                this.sendJson(res, 200, await handler(body));
            } catch (err) {
                const status = err.status || 500;
                if (status >= 500 && status !== 502 && status !== 503) {
                    this.adapter.log.error('Web-App-Anfrage fehlgeschlagen: ' + err.message);
                }
                this.sendJson(res, status, { error: status === 500 ? 'Interner Fehler' : err.message });
            }
        });
    }
}

module.exports = WebServer;
