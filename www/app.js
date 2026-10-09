'use strict';

(() => {
    const TOKEN_KEY = 'bootup.token';
    const VIEW_KEY = 'bootup.view';
    const app = document.getElementById('app');

    // localStorage kann im privaten Modus oder bei gesperrten Daten fehlschlagen
    const store = {
        get(key) { try { return localStorage.getItem(key); } catch (e) { return null; } },
        set(key, val) { try { localStorage.setItem(key, val); } catch (e) { /* ignorieren */ } },
        del(key) { try { localStorage.removeItem(key); } catch (e) { /* ignorieren */ } }
    };

    const S = {
        token: store.get(TOKEN_KEY) || '',
        data: null,               // letzter Snapshot vom Server
        index: new Map(),         // deviceId -> { dev, floor, room }
        cards: new Map(),         // deviceId -> DOM-Element (nur aktuelle Etagenansicht)
        view: 'overview',         // 'overview' oder Etagen-Nummer
        es: null,                 // EventSource
        sseUp: false,
        hadError: false,
        busy: new Set(),          // Geräte, die gerade bedient werden (kein Neuzeichnen)
        pendingSetpoint: new Map(),
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

    // ---- Daten laden ---------------------------------------------------------
    function buildIndex() {
        S.index.clear();
        for (const floor of S.data.floors) {
            for (const room of floor.rooms) {
                for (const dev of room.devices) S.index.set(dev.id, { dev, floor: floor.name, room: room.name });
            }
        }
    }

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
        buildIndex();
        if (S.view !== 'overview' && !S.data.floors[S.view]) S.view = 'overview';
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
            else if (!S.busy.has(msg.device)) updateCard(msg.device);
        } else if (msg.type === 'connection') {
            S.data.connected = msg.connected;
            updateStatus();
        } else if (msg.type === 'structure') {
            loadData();
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
    function renderAll() {
        const banner = h('div', { id: 'banner' });
        app.replaceChildren(
            h('header', { class: 'top' },
                h('div', { class: 'top-row' },
                    h('div', { class: 'title', text: S.data.project || 'Zuhause' }),
                    h('span', { class: 'dot', id: 'dot', title: 'Verbindungsstatus' }),
                    h('button', { class: 'icon-btn', 'aria-label': 'Aktualisieren', text: '↻', onclick: () => { loadData(); toast('Aktualisiert'); } })),
                renderTabs()),
            h('main', { id: 'main' }, banner));
        renderMain();
        updateStatus();
    }

    function renderTabs() {
        const tabs = h('nav', { class: 'tabs' });
        const add = (label, view) => {
            tabs.append(h('button', {
                class: 'tab' + (S.view === view ? ' active' : ''),
                text: label,
                onclick: () => { S.view = view; store.set(VIEW_KEY, String(view)); renderAll(); window.scrollTo(0, 0); }
            }));
        };
        add('Übersicht', 'overview');
        S.data.floors.forEach((f, i) => add(f.name, i));
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
        if (S.view === 'overview') main.append(...overview());
        else main.append(...floorView(S.data.floors[S.view]));
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
        return h('div', { class: 'card', 'data-id': dev.id }, head('💡', dev.name, switchToggle(dev)));
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

        return h('div', { class: 'card', 'data-id': dev.id },
            head('▤', dev.name, h('span', { class: 'badge', text: blindText(dev.values.state) })),
            h('div', { class: 'card-body' },
                label, slider,
                h('div', { class: 'btn-row' },
                    h('button', { class: 'btn', text: '▲ Auf', onclick: cmd('OPEN') }),
                    h('button', { class: 'btn', text: '■ Stopp', onclick: cmd('STOP') }),
                    h('button', { class: 'btn', text: '▼ Zu', onclick: cmd('CLOSE') }))));
    }

    function thermostatCard(dev) {
        const actual = dev.values.actual;
        const setpoint = S.pendingSetpoint.has(dev.id) ? S.pendingSetpoint.get(dev.id) : dev.values.setpoint;
        const setEl = h('div', { class: 'set', text: 'Soll ' + fmtTemp(setpoint) });
        let timer = null;

        const step = delta => () => {
            const base = S.pendingSetpoint.has(dev.id) ? S.pendingSetpoint.get(dev.id) : (typeof dev.values.setpoint === 'number' ? dev.values.setpoint : 20);
            const next = Math.min(30, Math.max(5, Math.round((base + delta) * 2) / 2));
            S.pendingSetpoint.set(dev.id, next);
            S.busy.add(dev.id);
            setEl.textContent = 'Soll ' + fmtTemp(next);
            clearTimeout(timer);
            timer = setTimeout(async () => {
                try { await send({ device: dev.id, field: 'setpoint', value: next }, `Soll ${fmtTemp(next)}`); } catch (e) { /* Toast */ }
                S.pendingSetpoint.delete(dev.id);
                S.busy.delete(dev.id);
                setTimeout(() => updateCard(dev.id), 1500);
            }, 800);
        };

        return h('div', { class: 'card', 'data-id': dev.id },
            head('🌡️', dev.name),
            h('div', { class: 'card-body thermo' },
                h('button', { class: 'btn step', text: '−', 'aria-label': 'Kälter', onclick: step(-0.5) }),
                h('div', { class: 'temp' }, h('div', { class: 'big', text: fmtTemp(actual) }), setEl),
                h('button', { class: 'btn step', text: '+', 'aria-label': 'Wärmer', onclick: step(0.5) })));
    }

    function windowCard(dev) {
        const info = windowInfo(dev.values.state);
        return h('div', { class: 'card', 'data-id': dev.id }, head('🪟', dev.name, h('span', { class: 'badge ' + info.cls, text: info.text })));
    }

    function occupancyCard(dev) {
        const info = occupancyInfo(dev.values.state);
        const b = dev.values.brightness;
        return h('div', { class: 'card', 'data-id': dev.id },
            head('🚶', dev.name, h('span', { class: 'badge ' + (info.active ? 'warn' : ''), text: info.text })),
            typeof b === 'number' ? h('div', { class: 'card-body card-sub', text: 'Helligkeit: ' + b }) : null);
    }

    function alarmCard(dev) {
        return h('div', { class: 'card', 'data-id': dev.id }, head('🛡️', dev.name, h('span', { class: 'badge ok', text: alarmText(dev.values.state) })));
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
            head('🎬', dev.name),
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
        const blindsOpen = of('DeviceStateBlind').filter(e => e.dev.values.state !== 'CLOSED');
        const thermostats = of('DeviceStateThermostat');

        const tile = (label, value, cls, wide) => h('div', { class: 'tile' + (wide ? ' wide' : '') },
            h('div', { class: 'label', text: label }),
            h('div', { class: 'value ' + (cls || '') + (wide ? ' small' : ''), text: value }));

        const tiles = h('div', { class: 'tiles' },
            alarms.length ? tile('Alarmanlage', alarms.map(a => alarmText(a.dev.values.state)).join(' · '), 'ok', true) : null,
            tile('Fenster offen', windows.length ? String(windows.length) : 'Alle zu', windows.length ? 'bad' : 'ok'),
            tile('Bewegung', motion.length ? String(motion.length) : 'Keine', motion.length ? 'warn' : ''),
            tile('Eingeschaltet', String(lightsOn.length), ''),
            tile('Jalousien offen', String(blindsOpen.length), ''));

        const out = [tiles];

        const section = (title, rows) => {
            out.push(h('h2', { class: 'room', text: title }));
            out.push(h('div', { class: 'list' }, rows.length ? rows : h('div', { class: 'empty', text: 'Keine' })));
        };
        const where = e => `${e.floor} · ${e.room}`;
        const row = (e, right) => h('div', { class: 'row' },
            h('div', { class: 'grow' }, h('div', { class: 'name', text: e.dev.name }), h('div', { class: 'where', text: where(e) })),
            right);

        if (windows.length) section('Fenster nicht geschlossen', windows.map(e => {
            const info = windowInfo(e.dev.values.state);
            return row(e, h('span', { class: 'badge ' + info.cls, text: info.text }));
        }));
        if (motion.length) section('Bewegung erkannt', motion.map(e => row(e, h('span', { class: 'badge warn', text: occupancyInfo(e.dev.values.state).text }))));
        if (lightsOn.length) section('Eingeschaltet', lightsOn.map(e => row(e, switchToggle(e.dev))));
        if (thermostats.length) section('Temperaturen', thermostats.map(e => h('div', { class: 'row' },
            h('div', { class: 'grow' }, h('div', { class: 'name', text: e.room }), h('div', { class: 'where', text: `${e.floor} · Soll ${fmtTemp(e.dev.values.setpoint)}` })),
            h('div', { class: 'val', text: fmtTemp(e.dev.values.actual) }))));

        return out;
    }

    // ---- Start -----------------------------------------------------------------------
    async function start() {
        if (!S.token) return showLogin();
        const savedView = store.get(VIEW_KEY);
        if (savedView && savedView !== 'overview' && /^\d+$/.test(savedView)) S.view = Number(savedView);
        await loadData();
        if (S.token && S.data) connectEvents();
    }

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState !== 'visible' || !S.token || !S.data) return;
        loadData();
        if (!S.es || S.es.readyState === 2) connectEvents();
    });

    start();
})();
