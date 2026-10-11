'use strict';

(() => {
    const TOKEN_KEY = 'bootup.token';
    const VIEW_KEY = 'bootup.view';
    const LOOK_KEY = 'bootup.look';
    const app = document.getElementById('app');

    // localStorage kann im privaten Modus oder bei gesperrten Daten fehlschlagen
    const store = {
        get(key) { try { return localStorage.getItem(key); } catch (e) { return null; } },
        set(key, val) { try { localStorage.setItem(key, val); } catch (e) { /* ignorieren */ } },
        del(key) { try { localStorage.removeItem(key); } catch (e) { /* ignorieren */ } }
    };

    function randomId() {
        try {
            const a = new Uint8Array(8);
            crypto.getRandomValues(a);
            return Array.from(a, b => b.toString(16).padStart(2, '0')).join('');
        } catch (e) { return String(Date.now()) + Math.floor(Math.random() * 1e6); }
    }

    const S = {
        token: store.get(TOKEN_KEY) || '',
        data: null,               // letzter Snapshot vom Server (alle Geräte)
        cfg: null,                // Darstellung (Namen, Sichtbarkeit, Reihenfolge, Design)
        display: [],              // sichtbare Etagen/Räume/Geräte nach Anwendung von cfg
        index: new Map(),         // deviceId -> { dev, floor, room } (nur sichtbare Geräte)
        cards: new Map(),         // deviceId -> DOM-Element (nur aktuelle Ansicht)
        view: 'overview',         // 'overview' | 'fav' | 'floor:<Name>' | 'settings'
        prevView: 'overview',
        open: new Set(),          // aufgeklappte Einträge im Einstellungsbereich
        clientId: randomId(),
        saving: false,
        saveDirty: false,
        saveTimer: null,
        es: null,                 // EventSource
        sseUp: false,
        hadError: false,
        busy: new Set(),          // Geräte, die gerade bedient werden (kein Neuzeichnen)
        netError: false,
        mainDirty: false
    };

    // ---- kleine Helfer ---------------------------------------------------
    function h(tag, props, ...children) {
        const el = document.createElement(tag);
        for (const [k, v] of Object.entries(props || {})) {
            if (v === null || v === undefined || v === false) continue;
            if (k === 'class') el.className = v;
            else if (k === 'text') el.textContent = v;
            else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
            else el.setAttribute(k, v === true ? '' : v);
        }
        for (const c of children.flat()) {
            if (c === null || c === undefined || c === false) continue;
            el.append(c.nodeType ? c : document.createTextNode(String(c)));
        }
        return el;
    }

    const fmtTemp = v => (typeof v === 'number' ? v.toFixed(1).replace('.', ',') + ' °C' : '–');

    let toastTimer = null;
    function toast(msg, bad) {
        let t = document.querySelector('.toast');
        if (!t) { t = h('div', { class: 'toast' }); document.body.append(t); }
        t.textContent = msg;
        t.className = 'toast show' + (bad ? ' bad' : '');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(() => { t.className = 'toast'; }, bad ? 4000 : 1800);
    }

    // ---- API ---------------------------------------------------------------
    async function api(path, opts = {}) {
        const headers = { Authorization: 'Bearer ' + S.token };
        if (opts.body) headers['Content-Type'] = 'application/json';
        let res;
        try {
            res = await fetch(path, { ...opts, headers, cache: 'no-store' });
        } catch (e) {
            const err = new Error('Server nicht erreichbar');
            err.network = true;
            throw err;
        }
        let body = null;
        try { body = await res.json(); } catch (e) { /* kein JSON */ }
        if (res.status === 401) {
            const err = new Error('Token ungültig');
            err.status = 401;
            throw err;
        }
        if (!res.ok) {
            const err = new Error((body && body.error) || 'Fehler ' + res.status);
            err.status = res.status;
            throw err;
        }
        return body;
    }

    async function send(cmd, okMsg) {
        try {
            await api('/api/command', { method: 'POST', body: JSON.stringify(cmd) });
            if (okMsg) toast(okMsg);
        } catch (e) {
            if (e.status === 401) return showLogin('Token ungültig – bitte erneut anmelden.');
            toast(e.message, true);
            throw e;
        }
    }

    // ---- Darstellung (Konfiguration) -----------------------------------------
    const own = (obj, k) => (obj && Object.prototype.hasOwnProperty.call(obj, k) ? obj[k] : undefined);

    function emptyCfg() {
        return {
            title: '', theme: 'auto', accent: '', density: 'normal', showOverview: true, showFavorites: true,
            tiles: { alarm: true, windows: true, motion: true, lights: true },
            lists: { windows: true, motion: true, lights: true, blinds: true, temps: true },
            floors: {}, rooms: {}, devices: {}, order: { floors: [], rooms: {}, devices: {} }
        };
    }

    // fehlende Felder auffüllen (Server liefert immer ein vollständiges Objekt)
    function normalizeCfg(c) {
        const d = emptyCfg();
        const x = c && typeof c === 'object' ? c : {};
        const o = x.order && typeof x.order === 'object' ? x.order : {};
        return {
            ...d, ...x,
            tiles: { ...d.tiles, ...(x.tiles || {}) },
            lists: { ...d.lists, ...(x.lists || {}) },
            floors: x.floors || {}, rooms: x.rooms || {}, devices: x.devices || {},
            order: { floors: o.floors || [], rooms: o.rooms || {}, devices: o.devices || {} }
        };
    }

    function contrastText(hex) {
        const n = parseInt(hex.slice(1), 16);
        const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
        return lum > 0.62 ? '#111111' : '#ffffff';
    }

    // Design anwenden: Hell/Dunkel, Akzentfarbe, Dichte, Titel
    function applyLook() {
        const c = S.cfg || emptyCfg();
        const root = document.documentElement;
        if (c.theme === 'light' || c.theme === 'dark') root.setAttribute('data-theme', c.theme);
        else root.removeAttribute('data-theme');
        if (/^#[0-9a-f]{6}$/i.test(c.accent)) {
            root.style.setProperty('--accent', c.accent);
            root.style.setProperty('--accent-text', contrastText(c.accent));
        } else {
            root.style.removeProperty('--accent');
            root.style.removeProperty('--accent-text');
        }
        document.body.classList.toggle('compact', c.density === 'compact');
        document.title = c.title || (S.data && S.data.project) || 'myHomeControl';
        store.set(LOOK_KEY, JSON.stringify({ theme: c.theme, accent: c.accent, density: c.density }));
    }

    // Reihenfolge anwenden: Einträge laut Liste zuerst, Rest in Originalreihenfolge
    function orderBy(items, keyFn, order) {
        const pos = new Map((order || []).map((k, i) => [k, i]));
        return items.map((it, i) => ({ it, i, p: pos.has(keyFn(it)) ? pos.get(keyFn(it)) : Infinity }))
            .sort((a, b) => (a.p === Infinity && b.p === Infinity ? a.i - b.i : a.p - b.p))
            .map(x => x.it);
    }

    // Sichtbare Struktur mit Anzeigenamen/Symbolen aufbauen
    function buildDisplay() {
        const cfg = S.cfg;
        S.index.clear();
        S.display = [];
        for (const f of orderBy(S.data.floors, x => x.name, cfg.order.floors)) {
            const fc = own(cfg.floors, f.name) || {};
            if (fc.hidden) continue;
            const rcfg = own(cfg.rooms, f.name) || {};
            const rorder = own(cfg.order.rooms, f.name) || [];
            const dorder = own(cfg.order.devices, f.name) || {};
            const floor = { key: f.name, name: fc.name || f.name, rooms: [] };
            for (const r of orderBy(f.rooms, x => x.name, rorder)) {
                const rc = own(rcfg, r.name) || {};
                if (rc.hidden) continue;
                const room = { key: r.name, name: rc.name || r.name, devices: [] };
                for (const d of orderBy(r.devices, x => x.id, own(dorder, r.name) || [])) {
                    const dc = own(cfg.devices, d.id) || {};
                    if (dc.hidden) continue;
                    // values bleibt dasselbe Objekt, damit Live-Updates ankommen
                    const dev = { ...d, name: dc.name || d.name, icon: dc.icon || '', favorite: !!dc.favorite };
                    room.devices.push(dev);
                    S.index.set(dev.id, { dev, floor: floor.name, room: room.name });
                }
                if (room.devices.length) floor.rooms.push(room);
            }
            if (floor.rooms.length) S.display.push(floor);
        }
    }

    function favorites() {
        return [...S.index.values()].filter(e => e.dev.favorite).map(e => e.dev);
    }

    // verfügbare Tabs: [{view, label}]
    function tabList() {
        const tabs = [];
        if (S.cfg.showOverview) tabs.push({ view: 'overview', label: 'Übersicht' });
        if (S.cfg.showFavorites && favorites().length) tabs.push({ view: 'fav', label: '★ Favoriten' });
        for (const f of S.display) tabs.push({ view: 'floor:' + f.key, label: f.name });
        return tabs;
    }

    function ensureValidView() {
        if (S.view === 'settings') return;
        const tabs = tabList();
        if (!tabs.some(t => t.view === S.view)) S.view = tabs.length ? tabs[0].view : 'settings';
    }

    // Änderungen speichern: sofort anzeigen, nach kurzer Pause zum Server senden
    function saveConfig() {
        applyLook();
        S.saveDirty = true;
        clearTimeout(S.saveTimer);
        S.saveTimer = setTimeout(flushSave, 400);
    }

    async function flushSave() {
        if (S.saving) return;                  // läuft schon; danach erneut
        if (!S.saveDirty) return;
        S.saving = true;
        S.saveDirty = false;
        try {
            await api('/api/config', { method: 'POST', body: JSON.stringify({ config: S.cfg, clientId: S.clientId }) });
        } catch (e) {
            if (e.status === 401) { S.saving = false; return showLogin('Token ungültig – bitte erneut anmelden.'); }
            toast('Speichern fehlgeschlagen: ' + e.message, true);
            S.saveDirty = true;
        }
        S.saving = false;
        if (S.saveDirty && !document.hidden) setTimeout(flushSave, 1500);
    }

    // ---- Daten laden ---------------------------------------------------------
    async function loadData() {
        try {
            S.data = await api('/api/state');
            S.netError = false;
        } catch (e) {
            if (e.status === 401) return showLogin('Token ungültig – bitte erneut anmelden.');
            S.netError = true;
            if (!S.data) return showLogin(e.message, true);
            renderAll();
            return;
        }
        // eigene, noch nicht gespeicherte Änderungen nicht überschreiben
        if (!S.saveDirty && !S.saving) S.cfg = normalizeCfg(S.data.config);
        else if (!S.cfg) S.cfg = normalizeCfg(S.data.config);
        applyLook();
        buildDisplay();
        ensureValidView();
        renderAll();
    }

    // ---- Live-Verbindung -------------------------------------------------------
    function connectEvents() {
        if (S.es) { S.es.close(); S.es = null; }
        const es = new EventSource('/api/events?token=' + encodeURIComponent(S.token));
        S.es = es;

        es.onopen = () => {
            S.sseUp = true;
            updateStatus();
            if (S.hadError) { S.hadError = false; loadData(); } // verpasste Änderungen nachholen
        };
        es.onmessage = ev => {
            let msg;
            try { msg = JSON.parse(ev.data); } catch (e) { return; }
            handleEvent(msg);
        };
        es.onerror = () => {
            S.sseUp = false;
            S.hadError = true;
            updateStatus();
            if (es.readyState === 2) setTimeout(() => { if (S.token) { loadData().then(connectEvents); } }, 3000);
        };
    }

    function handleEvent(msg) {
        if (msg.type === 'value') {
            const entry = S.index.get(msg.device);
            if (!entry) return;
            entry.dev.values[msg.field] = msg.value;
            if (S.view === 'overview') scheduleMainRender();
            else if (S.view !== 'settings' && !S.busy.has(msg.device)) updateCard(msg.device);
        } else if (msg.type === 'connection') {
            S.data.connected = msg.connected;
            updateStatus();
        } else if (msg.type === 'structure') {
            loadData();
        } else if (msg.type === 'config') {
            if (msg.by === S.clientId) return;               // eigene Änderung
            if (S.saveDirty || S.saving) return;             // lokale Änderung hat Vorrang
            S.cfg = normalizeCfg(msg.config);
            applyLook();
            buildDisplay();
            ensureValidView();
            const typing = document.activeElement && document.activeElement.tagName === 'INPUT';
            if (S.view === 'settings' && typing) return;     // nicht beim Tippen stören
            renderAll();
        }
    }

    function scheduleMainRender() {
        if (S.mainDirty) return;
        S.mainDirty = true;
        requestAnimationFrame(() => { S.mainDirty = false; renderMain(); });
    }

    // ---- Anmeldung ---------------------------------------------------------------
    function showLogin(message, isError) {
        if (S.es) { S.es.close(); S.es = null; }
        if (!isError) { S.token = ''; store.del(TOKEN_KEY); }
        const input = h('input', { type: 'password', placeholder: 'Zugangs-Token', autocomplete: 'current-password', autocapitalize: 'off', autocorrect: 'off' });
        const err = h('p', { class: 'error', text: message || '' });
        const submit = () => {
            const val = input.value.trim();
            if (!val) return;
            S.token = val;
            store.set(TOKEN_KEY, val);
            start();
        };
        input.addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
        app.replaceChildren(h('div', { class: 'login' },
            h('h1', { text: isError ? 'Keine Verbindung' : 'myHomeControl' }),
            h('p', { text: isError ? 'Der Server ist gerade nicht erreichbar.' : 'Bitte Zugangs-Token eingeben.' }),
            isError ? null : input,
            h('button', { class: 'btn primary', text: isError ? 'Erneut versuchen' : 'Anmelden', onclick: isError ? start : submit }),
            err));
        if (!isError) input.focus();
    }

    // ---- Zeichnen ----------------------------------------------------------------
    const projectTitle = () => (S.cfg && S.cfg.title) || (S.data && S.data.project) || 'Zuhause';

    function renderAll() {
        const banner = h('div', { id: 'banner' });
        const inSettings = S.view === 'settings';
        app.replaceChildren(
            h('header', { class: 'top' },
                h('div', { class: 'top-row' },
                    h('div', { class: 'title', text: inSettings ? 'Einstellungen' : projectTitle() }),
                    h('span', { class: 'dot', id: 'dot', title: 'Verbindungsstatus' }),
                    inSettings
                        ? h('button', { class: 'btn primary done', text: 'Fertig', onclick: closeSettings })
                        : [
                            h('button', { class: 'icon-btn', 'aria-label': 'Aktualisieren', text: '↻', onclick: () => { loadData(); toast('Aktualisiert'); } }),
                            h('button', { class: 'icon-btn', 'aria-label': 'Einstellungen', text: '⚙︎', onclick: openSettings })
                        ]),
                inSettings ? null : renderTabs()),
            h('main', { id: 'main' }, banner));
        renderMain();
        updateStatus();
    }

    function openSettings() {
        S.prevView = S.view;
        S.view = 'settings';
        renderAll();
        window.scrollTo(0, 0);
    }

    function closeSettings() {
        clearTimeout(S.saveTimer);
        flushSave();
        S.view = S.prevView && S.prevView !== 'settings' ? S.prevView : 'overview';
        buildDisplay();
        ensureValidView();
        renderAll();
        window.scrollTo(0, 0);
    }

    function renderTabs() {
        const tabs = h('nav', { class: 'tabs' });
        for (const t of tabList()) {
            tabs.append(h('button', {
                class: 'tab' + (S.view === t.view ? ' active' : ''),
                text: t.label,
                onclick: () => { S.view = t.view; store.set(VIEW_KEY, t.view); renderAll(); window.scrollTo(0, 0); }
            }));
        }
        return tabs;
    }

    function updateStatus() {
        const dot = document.getElementById('dot');
        const banner = document.getElementById('banner');
        if (!dot || !banner) return;
        const live = S.sseUp && S.data && S.data.connected;
        dot.className = 'dot' + (live ? ' live' : '');
        banner.replaceChildren();
        if (S.netError) banner.append(h('div', { class: 'banner', text: 'Server nicht erreichbar – Werte evtl. veraltet.' }));
        else if (S.data && !S.data.connected) banner.append(h('div', { class: 'banner', text: 'Verbindung zu BootUp unterbrochen – Werte evtl. veraltet.' }));
        else if (!S.sseUp) banner.append(h('div', { class: 'banner', text: 'Live-Verbindung getrennt – verbinde neu …' }));
    }

    function renderMain() {
        const main = document.getElementById('main');
        if (!main) return;
        const banner = document.getElementById('banner') || h('div', { id: 'banner' });
        main.replaceChildren(banner);
        S.cards.clear();
        if (S.view === 'settings') main.append(...settingsView());
        else if (S.view === 'overview') main.append(...overview());
        else if (S.view === 'fav') main.append(...favView());
        else {
            const floor = S.display.find(f => 'floor:' + f.key === S.view);
            main.append(...(floor ? floorView(floor) : [h('div', { class: 'empty', text: 'Nichts zu zeigen. Über ⚙︎ Etagen oder Geräte einblenden.' })]));
        }
        updateStatus();
    }

    // ---- Ansicht: Etage ---------------------------------------------------------
    function floorView(floor) {
        const out = [];
        for (const room of floor.rooms) {
            out.push(h('h2', { class: 'room', text: room.name }));
            const grid = h('div', { class: 'grid' });
            for (const dev of room.devices) {
                const card = renderCard(dev);
                S.cards.set(dev.id, card);
                grid.append(card);
            }
            out.push(grid);
        }
        if (!out.length) out.push(h('div', { class: 'empty', text: 'Keine Räume.' }));
        return out;
    }

    function favView() {
        const grid = h('div', { class: 'grid' });
        for (const dev of favorites()) {
            const card = renderCard(dev);
            S.cards.set(dev.id, card);
            grid.append(card);
        }
        return [grid];
    }

    function updateCard(id) {
        const old = S.cards.get(id);
        const entry = S.index.get(id);
        if (!old || !entry) return;
        const fresh = renderCard(entry.dev);
        old.replaceWith(fresh);
        S.cards.set(id, fresh);
    }

    // ---- Statusinterpretation (Werte laut BootUp-API) ----------------------------
    const blindText = s => ({ OPEN: 'Offen', CLOSED: 'Geschlossen', INTERMEDIATE: 'Teilweise' }[s] || s || '–');
    function windowInfo(s) {
        if (s === 'CLOSE') return { text: 'Geschlossen', cls: 'ok' };
        if (s === 'TILT') return { text: 'Gekippt', cls: 'warn' };
        if (s === 'OPEN') return { text: 'Offen', cls: 'bad' };
        return { text: 'Unbekannt', cls: '' };
    }
    function occupancyInfo(s) {
        if (s === 'NONE' || s === undefined || s === null) return { text: 'Ruhig', active: false };
        if (s === 'UNKNOWN') return { text: 'Unbekannt', active: false };
        return { text: 'Bewegung', active: true };
    }
    const alarmText = s => ({ SensorActive: 'Sensoren aktiv' }[s] || s || '–');

    // ---- Karten ---------------------------------------------------------------
    function renderCard(dev) {
        switch (dev.type) {
            case 'DeviceStateSwitch': return switchCard(dev);
            case 'DeviceStateBlind': return blindCard(dev);
            case 'DeviceStateThermostat': return thermostatCard(dev);
            case 'DeviceStateWindowHandle': return windowCard(dev);
            case 'DeviceStateOccupancy': return occupancyCard(dev);
            case 'DeviceStateAlarmSystem': return alarmCard(dev);
            case 'DeviceStateSceneController': return sceneCard(dev);
            default:
                return h('div', { class: 'card' }, h('div', { class: 'card-head' },
                    h('div', { class: 'card-icon', text: '❔' }),
                    h('div', { class: 'card-name', text: dev.name }),
                    h('span', { class: 'card-sub', text: 'nicht unterstützt' })));
        }
    }

    function head(icon, name, right) {
        return h('div', { class: 'card-head' },
            h('div', { class: 'card-icon', text: icon }),
            h('div', { class: 'card-name', text: name }),
            right || null);
    }

    function switchToggle(dev) {
        const on = !!dev.values.state;
        const btn = h('button', { class: 'toggle', role: 'switch', 'aria-checked': String(on), 'aria-label': dev.name });
        btn.addEventListener('click', async () => {
            const next = !(dev.values.state);
            dev.values.state = next;              // sofort sichtbar (optimistisch)
            btn.setAttribute('aria-checked', String(next));
            btn.disabled = true;
            try {
                await send({ device: dev.id, field: 'state', value: next });
            } catch (e) {
                dev.values.state = !next;         // Fehler: zurücksetzen
                btn.setAttribute('aria-checked', String(!next));
            } finally {
                btn.disabled = false;
                if (S.view === 'overview') scheduleMainRender();
            }
        });
        return btn;
    }

    function switchCard(dev) {
        return h('div', { class: 'card', 'data-id': dev.id }, head(dev.icon || '💡', dev.name, switchToggle(dev)));
    }

    function blindCard(dev) {
        const pos = typeof dev.values.position === 'number' ? dev.values.position : 0;
        const label = h('div', { class: 'card-sub' });
        const setLabel = p => { label.textContent = `${p} % geschlossen`; };
        setLabel(pos);

        const slider = h('input', { class: 'slider', type: 'range', min: '0', max: '100', step: '1', value: String(pos), 'aria-label': 'Position ' + dev.name });
        let releaseTimer = null;
        slider.addEventListener('input', () => { S.busy.add(dev.id); clearTimeout(releaseTimer); setLabel(slider.value); });
        slider.addEventListener('change', async () => {
            try { await send({ device: dev.id, field: 'position', value: Number(slider.value) }); } catch (e) { /* Toast zeigt Fehler */ }
            releaseTimer = setTimeout(() => { S.busy.delete(dev.id); updateCard(dev.id); }, 1500);
        });

        const cmd = (value, msg) => async () => { try { await send({ device: dev.id, field: 'position', value }, msg); } catch (e) { /* Toast */ } };

        // Anstellen: kurz fahren und stoppen; Dauer und Stopp übernimmt der Adapter
        const nudge = (dir, label) => {
            const btn = h('button', { class: 'btn', text: label });
            btn.addEventListener('click', async () => {
                btn.disabled = true;
                try { await send({ device: dev.id, field: 'nudge', value: dir }); } catch (e) { /* Toast */ }
                btn.disabled = false;
            });
            return btn;
        };

        return h('div', { class: 'card', 'data-id': dev.id },
            head(dev.icon || '▤', dev.name, h('span', { class: 'badge', text: blindText(dev.values.state) })),
            h('div', { class: 'card-body' },
                label, slider,
                h('div', { class: 'btn-row' },
                    h('button', { class: 'btn', text: '▲ Auf', onclick: cmd('OPEN') }),
                    h('button', { class: 'btn', text: '■ Stopp', onclick: cmd('STOP') }),
                    h('button', { class: 'btn', text: '▼ Zu', onclick: cmd('CLOSE') })),
                h('div', { class: 'btn-row nudge' },
                    nudge('UP', '▲ Anstellen'),
                    nudge('DOWN', '▼ Anstellen'))));
    }

    // Thermostat: Ist- und Solltemperatur nur zur Anzeige (Sollwert ist in der App nicht änderbar)
    function thermostatCard(dev) {
        return h('div', { class: 'card', 'data-id': dev.id },
            head(dev.icon || '🌡️', dev.name),
            h('div', { class: 'card-body thermo' },
                h('div', { class: 'temp' },
                    h('div', { class: 'big', text: fmtTemp(dev.values.actual) }),
                    h('div', { class: 'set', text: 'Soll ' + fmtTemp(dev.values.setpoint) }))));
    }

    function windowCard(dev) {
        const info = windowInfo(dev.values.state);
        return h('div', { class: 'card', 'data-id': dev.id }, head(dev.icon || '🪟', dev.name, h('span', { class: 'badge ' + info.cls, text: info.text })));
    }

    function occupancyCard(dev) {
        const info = occupancyInfo(dev.values.state);
        const b = dev.values.brightness;
        return h('div', { class: 'card', 'data-id': dev.id },
            head(dev.icon || '🚶', dev.name, h('span', { class: 'badge ' + (info.active ? 'warn' : ''), text: info.text })),
            typeof b === 'number' ? h('div', { class: 'card-body card-sub', text: 'Helligkeit: ' + b }) : null);
    }

    function alarmCard(dev) {
        return h('div', { class: 'card', 'data-id': dev.id }, head(dev.icon || '🛡️', dev.name, h('span', { class: 'badge ok', text: alarmText(dev.values.state) })));
    }

    function sceneCard(dev) {
        const list = h('div', { class: 'scene-list' });
        for (const scene of dev.scenes || []) {
            const btn = h('button', { class: 'btn', text: scene.name });
            btn.addEventListener('click', async () => {
                btn.disabled = true;
                try { await send({ device: dev.id, field: 'scene', scene: scene.id }, `„${scene.name}“ gestartet`); } catch (e) { /* Toast */ }
                setTimeout(() => { btn.disabled = false; }, 1200);
            });
            list.append(btn);
        }
        return h('div', { class: 'card', 'data-id': dev.id },
            head(dev.icon || '🎬', dev.name),
            h('div', { class: 'card-body' }, (dev.scenes || []).length ? list : h('div', { class: 'card-sub', text: 'Keine Szenen' })));
    }

    // ---- Ansicht: Übersicht --------------------------------------------------------
    function overview() {
        const all = [...S.index.values()];
        const of = type => all.filter(e => e.dev.type === type);

        const alarms = of('DeviceStateAlarmSystem');
        const windows = of('DeviceStateWindowHandle').filter(e => ['OPEN', 'TILT'].includes(e.dev.values.state));
        const motion = of('DeviceStateOccupancy').filter(e => occupancyInfo(e.dev.values.state).active);
        const lightsOn = of('DeviceStateSwitch').filter(e => e.dev.values.state === true);
        const blinds = of('DeviceStateBlind');
        const thermostats = of('DeviceStateThermostat');

        const tile = (label, value, cls, wide) => h('div', { class: 'tile' + (wide ? ' wide' : '') },
            h('div', { class: 'label', text: label }),
            h('div', { class: 'value ' + (cls || '') + (wide ? ' small' : ''), text: value }));

        const T = S.cfg.tiles, L = S.cfg.lists;
        const tiles = h('div', { class: 'tiles' },
            T.alarm && alarms.length ? tile('Alarmanlage', alarms.map(a => alarmText(a.dev.values.state)).join(' · '), 'ok', true) : null,
            T.windows ? tile('Fenster offen', windows.length ? String(windows.length) : 'Alle zu', windows.length ? 'bad' : 'ok') : null,
            T.motion ? tile('Bewegung', motion.length ? String(motion.length) : 'Keine', motion.length ? 'warn' : '') : null,
            T.lights ? tile('Eingeschaltet', String(lightsOn.length), '') : null);

        const out = [];
        if (tiles.childElementCount) out.push(tiles);

        const section = (title, rows) => {
            out.push(h('h2', { class: 'room', text: title }));
            out.push(h('div', { class: 'list' }, rows.length ? rows : h('div', { class: 'empty', text: 'Keine' })));
        };
        const where = e => `${e.floor} · ${e.room}`;
        const row = (e, right) => h('div', { class: 'row' },
            h('div', { class: 'grow' }, h('div', { class: 'name', text: e.dev.name }), h('div', { class: 'where', text: where(e) })),
            right);

        if (L.windows && windows.length) section('Fenster nicht geschlossen', windows.map(e => {
            const info = windowInfo(e.dev.values.state);
            return row(e, h('span', { class: 'badge ' + info.cls, text: info.text }));
        }));
        if (L.motion && motion.length) section('Bewegung erkannt', motion.map(e => row(e, h('span', { class: 'badge warn', text: occupancyInfo(e.dev.values.state).text }))));
        if (L.lights && lightsOn.length) section('Eingeschaltet', lightsOn.map(e => row(e, switchToggle(e.dev))));
        if (L.blinds && blinds.length) {
            const closed = e => (typeof e.dev.values.position === 'number' ? e.dev.values.position : null);
            section('Jalousien', blinds.map(e => {
                const pos = closed(e);
                const bar = h('div', { class: 'bar' }, h('div', { class: 'bar-fill' }));
                bar.firstChild.style.width = (pos === null ? 0 : pos) + '%';
                return h('div', { class: 'row blind-row' },
                    h('div', { class: 'grow' },
                        h('div', { class: 'name', text: e.dev.name }),
                        h('div', { class: 'where', text: where(e) }),
                        bar),
                    h('div', { class: 'blind-val' },
                        h('div', { class: 'val', text: pos === null ? '–' : pos + ' %' }),
                        h('div', { class: 'where', text: pos === null ? blindText(e.dev.values.state) : (pos === 0 ? 'Offen' : pos === 100 ? 'Geschlossen' : 'geschlossen') })));
            }));
        }
        if (L.temps && thermostats.length) section('Temperaturen', thermostats.map(e => h('div', { class: 'row' },
            h('div', { class: 'grow' }, h('div', { class: 'name', text: e.room }), h('div', { class: 'where', text: `${e.floor} · Soll ${fmtTemp(e.dev.values.setpoint)}` })),
            h('div', { class: 'val', text: fmtTemp(e.dev.values.actual) }))));

        if (!out.length) out.push(h('div', { class: 'empty', text: 'Die Übersicht ist leer. Kacheln und Listen lassen sich unter ⚙︎ einblenden.' }));
        return out;
    }

    // ---- Einstellungen ------------------------------------------------------------
    const TYPE_LABEL = {
        DeviceStateSwitch: 'Schalter', DeviceStateBlind: 'Jalousie', DeviceStateThermostat: 'Thermostat',
        DeviceStateWindowHandle: 'Fenster', DeviceStateOccupancy: 'Bewegung', DeviceStateAlarmSystem: 'Alarmanlage',
        DeviceStateSceneController: 'Szenen'
    };
    const ICONS = ['💡', '🔆', '🛋️', '🛏️', '🍽️', '🚿', '🚪', '🪟', '▤', '🌡️', '🔥', '❄️', '🚶', '🛡️', '🎬', '🔌', '📺', '🌿', '🚗', '⭐'];
    const ACCENTS = ['#1f6feb', '#1a8f4c', '#e8590c', '#d92d20', '#7048e8', '#d6336c', '#0c8599', '#667085'];

    // Eintrag in einer Konfigurationsgruppe ändern; leere Werte entfernen den Eintrag
    function patchEntry(group, key, patch) {
        const cur = { ...(own(group, key) || {}), ...patch };
        for (const k of Object.keys(cur)) if (cur[k] === '' || cur[k] === false || cur[k] === undefined) delete cur[k];
        if (Object.keys(cur).length) group[key] = cur; else delete group[key];
    }

    function moveKey(keys, key, dir) {
        const i = keys.indexOf(key), j = i + dir;
        if (i < 0 || j < 0 || j >= keys.length) return keys;
        const out = keys.slice();
        [out[i], out[j]] = [out[j], out[i]];
        return out;
    }

    function settingsView() {
        const cfg = S.cfg;
        const out = [];
        const changed = rerender => { saveConfig(); if (rerender) renderMain(); };
        const section = (title, rows) => {
            out.push(h('h2', { class: 'room', text: title }));
            out.push(h('div', { class: 'list' }, rows));
        };

        const toggleRow = (label, get, set) => {
            const btn = h('button', { class: 'toggle', role: 'switch', 'aria-checked': String(!!get()), 'aria-label': label });
            btn.addEventListener('click', () => {
                const next = !get();
                set(next);
                btn.setAttribute('aria-checked', String(next));
                changed(false);
            });
            return h('div', { class: 'row' }, h('div', { class: 'grow' }, h('div', { class: 'name', text: label })), btn);
        };
        const seg = (options, get, set) => h('div', { class: 'seg' }, options.map(([v, l]) =>
            h('button', { class: 'seg-btn' + (get() === v ? ' active' : ''), text: l, onclick: () => { set(v); changed(true); } })));
        const field = (label, control) => h('div', { class: 'row field' }, h('div', { class: 'name', text: label }), control);

        // -- Darstellung
        const titleInput = h('input', { class: 'text', type: 'text', maxlength: '40', placeholder: (S.data && S.data.project) || 'Zuhause', value: cfg.title, 'aria-label': 'Titel' });
        titleInput.addEventListener('change', () => { cfg.title = titleInput.value.trim().slice(0, 40); changed(false); });

        const swatches = h('div', { class: 'swatches' });
        for (const c of ACCENTS) {
            const b = h('button', { class: 'swatch' + (cfg.accent === c ? ' active' : ''), 'aria-label': 'Akzentfarbe ' + c });
            b.style.background = c;
            b.addEventListener('click', () => { cfg.accent = c; changed(true); });
            swatches.append(b);
        }
        const picker = h('input', { class: 'picker', type: 'color', value: /^#[0-9a-f]{6}$/i.test(cfg.accent) ? cfg.accent : '#1f6feb', 'aria-label': 'Eigene Farbe' });
        picker.addEventListener('change', () => { cfg.accent = picker.value.toLowerCase(); changed(true); });
        swatches.append(picker);

        section('Darstellung', [
            field('Titel', titleInput),
            field('Design', seg([['auto', 'Automatisch'], ['light', 'Hell'], ['dark', 'Dunkel']], () => cfg.theme, v => { cfg.theme = v; })),
            field('Dichte', seg([['normal', 'Normal'], ['compact', 'Kompakt']], () => cfg.density, v => { cfg.density = v; })),
            field('Akzentfarbe', swatches),
            cfg.accent ? h('div', { class: 'row' }, h('button', { class: 'btn', text: 'Standardfarbe', onclick: () => { cfg.accent = ''; changed(true); } })) : null
        ]);

        // -- Übersicht
        section('Seiten', [
            toggleRow('Übersicht anzeigen', () => cfg.showOverview, v => { cfg.showOverview = v; }),
            toggleRow('Favoriten anzeigen', () => cfg.showFavorites, v => { cfg.showFavorites = v; })
        ]);
        const tl = { alarm: 'Alarmanlage', windows: 'Fenster offen', motion: 'Bewegung', lights: 'Eingeschaltet' };
        section('Kacheln in der Übersicht', Object.entries(tl).map(([k, l]) => toggleRow(l, () => cfg.tiles[k], v => { cfg.tiles[k] = v; })));
        const ll = { windows: 'Offene Fenster', motion: 'Bewegung erkannt', lights: 'Eingeschaltete Geräte', blinds: 'Jalousien (Prozent geschlossen)', temps: 'Temperaturen' };
        section('Listen in der Übersicht', Object.entries(ll).map(([k, l]) => toggleRow(l, () => cfg.lists[k], v => { cfg.lists[k] = v; })));

        // -- Etagen / Räume / Geräte
        const editRow = o => {
            const input = h('input', { class: 'text', type: 'text', maxlength: '40', value: o.custom || '', placeholder: o.original, 'aria-label': 'Name' });
            input.addEventListener('change', () => {
                const v = input.value.trim();
                o.onName(v === o.original ? '' : v.slice(0, 40));
                changed(false);
            });
            const controls = h('div', { class: 'ctl' },
                o.extra || null,
                h('button', { class: 'pill' + (o.hidden ? ' off' : ''), text: o.hidden ? 'Versteckt' : 'Sichtbar', onclick: () => { o.onHide(!o.hidden); changed(true); } }),
                h('button', { class: 'pill sq', text: '▲', 'aria-label': 'Nach oben', onclick: () => { o.onMove(-1); changed(true); } }),
                h('button', { class: 'pill sq', text: '▼', 'aria-label': 'Nach unten', onclick: () => { o.onMove(1); changed(true); } }));
            const lead = o.toggle
                ? h('button', { class: 'expand', text: o.open ? '▾' : '▸', 'aria-label': o.open ? 'Zuklappen' : 'Aufklappen', onclick: () => { if (S.open.has(o.id)) S.open.delete(o.id); else S.open.add(o.id); renderMain(); } })
                : h('span', { class: 'expand' });
            return h('div', { class: 'edit depth' + o.depth + (o.hidden ? ' dim' : '') },
                h('div', { class: 'edit-top' }, lead, input, o.meta ? h('span', { class: 'meta', text: o.meta }) : null),
                controls);
        };

        const rows = [];
        const floors = orderBy(S.data.floors, x => x.name, cfg.order.floors);
        for (const f of floors) {
            const fid = 'f:' + f.name;
            const fc = own(cfg.floors, f.name) || {};
            rows.push(editRow({
                depth: 0, id: fid, toggle: true, open: S.open.has(fid), original: f.name, custom: fc.name, hidden: !!fc.hidden,
                meta: f.rooms.length + ' Räume',
                onName: v => patchEntry(cfg.floors, f.name, { name: v }),
                onHide: v => patchEntry(cfg.floors, f.name, { hidden: v }),
                onMove: d => { cfg.order.floors = moveKey(floors.map(x => x.name), f.name, d); }
            }));
            if (!S.open.has(fid)) continue;

            const rooms = orderBy(f.rooms, x => x.name, own(cfg.order.rooms, f.name));
            if (!own(cfg.rooms, f.name)) cfg.rooms[f.name] = {};
            const rcfg = cfg.rooms[f.name];
            for (const r of rooms) {
                const rid = 'r:' + f.name + '\u0000' + r.name;
                const rc = own(rcfg, r.name) || {};
                rows.push(editRow({
                    depth: 1, id: rid, toggle: true, open: S.open.has(rid), original: r.name, custom: rc.name, hidden: !!rc.hidden,
                    meta: r.devices.length + ' Geräte',
                    extra: (() => {
                        const anyVisible = r.devices.some(d => !(own(cfg.devices, d.id) || {}).hidden);
                        return h('button', {
                            class: 'pill', text: anyVisible ? 'Alle Geräte verstecken' : 'Alle Geräte zeigen',
                            onclick: () => { r.devices.forEach(d => patchEntry(cfg.devices, d.id, { hidden: anyVisible })); changed(true); }
                        });
                    })(),
                    onName: v => patchEntry(rcfg, r.name, { name: v }),
                    onHide: v => patchEntry(rcfg, r.name, { hidden: v }),
                    onMove: d => { cfg.order.rooms[f.name] = moveKey(rooms.map(x => x.name), r.name, d); }
                }));
                if (!S.open.has(rid)) continue;

                const dorderAll = own(cfg.order.devices, f.name) || {};
                const devs = orderBy(r.devices, x => x.id, own(dorderAll, r.name));
                for (const d of devs) {
                    const dc = own(cfg.devices, d.id) || {};
                    const sel = h('select', { class: 'pill icon-sel', 'aria-label': 'Symbol' },
                        h('option', { value: '', text: 'Symbol' }),
                        ICONS.map(i => h('option', { value: i, text: i, selected: dc.icon === i })));
                    sel.addEventListener('change', () => { patchEntry(cfg.devices, d.id, { icon: sel.value }); changed(true); });
                    rows.push(editRow({
                        depth: 2, id: 'd:' + d.id, original: d.name, custom: dc.name, hidden: !!dc.hidden,
                        meta: TYPE_LABEL[d.type] || '',
                        extra: [
                            sel,
                            h('button', { class: 'pill sq star' + (dc.favorite ? ' on' : ''), text: dc.favorite ? '★' : '☆', 'aria-label': 'Favorit', onclick: () => { patchEntry(cfg.devices, d.id, { favorite: !dc.favorite }); changed(true); } })
                        ],
                        onName: v => patchEntry(cfg.devices, d.id, { name: v }),
                        onHide: v => patchEntry(cfg.devices, d.id, { hidden: v }),
                        onMove: dir => {
                            if (!own(cfg.order.devices, f.name)) cfg.order.devices[f.name] = {};
                            cfg.order.devices[f.name][r.name] = moveKey(devs.map(x => x.id), d.id, dir);
                        }
                    }));
                }
            }
        }
        out.push(h('h2', { class: 'room', text: 'Etagen, Räume & Geräte' }));
        out.push(h('p', { class: 'hint', text: 'Etage und Raum aufklappen, dann pro Gerät Name ändern (leer = Originalname) und Sichtbar/Versteckt wählen. Versteckte Geräte werden nur ausgeblendet, nicht gesperrt.' }));
        out.push(h('div', { class: 'btn-row bulk' },
            h('button', { class: 'btn', text: 'Alles aufklappen', onclick: () => {
                for (const f of S.data.floors) { S.open.add('f:' + f.name); for (const r of f.rooms) S.open.add('r:' + f.name + '\u0000' + r.name); }
                renderMain();
            } }),
            h('button', { class: 'btn', text: 'Alles zuklappen', onclick: () => { S.open.clear(); renderMain(); } })));
        out.push(h('div', { class: 'list' }, rows.length ? rows : h('div', { class: 'empty', text: 'Keine Geräte geladen.' })));

        out.push(h('div', { class: 'reset' },
            h('button', { class: 'btn', text: 'Alles auf Standard zurücksetzen', onclick: () => {
                if (!window.confirm('Wirklich alle Anpassungen (Namen, Sichtbarkeit, Reihenfolge, Design) zurücksetzen?')) return;
                S.cfg = emptyCfg();
                saveConfig();
                renderMain();
            } })));
        return out;
    }

    // ---- Start -----------------------------------------------------------------------
    async function start() {
        if (!S.token) return showLogin();
        const savedView = store.get(VIEW_KEY);
        if (savedView && savedView !== 'settings' && savedView.length < 130) S.view = savedView;
        await loadData();
        if (S.token && S.data) connectEvents();
    }

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible' || !S.token || !S.data) return;
        loadData();
        if (!S.es || S.es.readyState === 2) connectEvents();
    });

    // zuletzt verwendetes Design sofort anwenden (kein Aufblitzen)
    try {
        const look = JSON.parse(store.get(LOOK_KEY) || 'null');
        if (look && typeof look === 'object') { S.cfg = { ...emptyCfg(), theme: look.theme, accent: look.accent || '', density: look.density }; applyLook(); S.cfg = null; }
    } catch (e) { /* ignorieren */ }

    start();
})();
