'use strict';

const utils = require('@iobroker/adapter-core');
const https = require('https');
const http = require('http');

class Bootup extends utils.Adapter {
    constructor(options) {
        super({
            ...options,
            name: 'bootup'
        });

        this.deviceIndex = {};   // stateId -> {guid, pathRef, controllerGuid?, type}
        this.guidIndex = {};     // guid -> stateId (Umkehrindex, für eingehende Notifications)
        this.stateCache = {};    // stateId -> letzter bekannter Wert
        this.pollTimer = null;

        this.subscriberId = null;         // aktuelle Notification-Subscription
        this.notificationsActive = false; // Flag zum sauberen Beenden der Poll-Schleife beim Unload
        this.shuttingDown = false;        // verhindert DB-Zugriffe nach Beginn des Shutdowns
        this.pendingNotificationReq = null; // laufender Long-Poll-Request, zum Abbrechen beim Unload

        this.on('ready', this.onReady.bind(this));
        this.on('stateChange', this.onStateChange.bind(this));
        this.on('unload', this.onUnload.bind(this));
    }

    // -------------------------------------------------------------------
    async onReady() {
        if (!this.config.apiKey) {
            this.log.error('Kein API-Key konfiguriert. Bitte in den Instanz-Einstellungen eintragen.');
            return;
        }

        // Verbindungsart: Cloud (BootUp-Server im Internet) oder Lokal
        // (eigener Server im lokalen Netz, meist mit selbstsigniertem Zertifikat).
        const connectionType = this.config.connectionType || 'cloud';

        if (connectionType === 'local') {
            // Häufiger Stolperstein: falls versehentlich "https://" oder ein
            // Pfad mit im Feld steht, hier automatisch bereinigen, statt mit
            // einem kryptischen TLS-Fehler zu scheitern.
            let localHost = (this.config.localHost || '').trim();
            localHost = localHost.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');

            this.host = localHost;
            this.port = Number(this.config.localPort) > 0 ? Number(this.config.localPort) : 4443;
            this.basePath = '/v1'; // lokaler Dienst nutzt kürzeren Pfad ohne /mhccloudserver/api
            // Viele lokale Geräte/Gateways sprechen intern reines HTTP statt
            // HTTPS - daher konfigurierbar, Standard ist HTTP.
            this.protocol = (this.config.localProtocol || 'http').toLowerCase();
            this.lib = this.protocol === 'https' ? https : http;
            this.rejectUnauthorized = false; // falls doch HTTPS: lokaler Dienst nutzt i.d.R. ein selbstsigniertes Zertifikat
            this.minTlsVersion = 'TLSv1';
            this.maxTlsVersion = 'TLSv1.2';

            if (!this.host) {
                this.log.error('Verbindungsart "Lokal" ausgewählt, aber keine lokale Host-Adresse konfiguriert.');
                return;
            }
        } else {
            this.host = this.config.host || 'www.bootup.ch';
            this.port = 443;
            this.basePath = this.config.basePath || '/mhccloudserver/api/v1';
            this.protocol = 'https';
            this.lib = https;
            this.rejectUnauthorized = true; // Cloud nutzt ein gültiges, vertrauenswürdiges Zertifikat
            this.minTlsVersion = undefined; // Cloud: Standard-Mindestversion von Node.js verwenden
            this.maxTlsVersion = undefined; // Cloud: Standard-Höchstversion von Node.js verwenden (TLS 1.3)
        }

        this.log.info(`Verbindung: ${connectionType === 'local' ? 'Lokal' : 'Cloud'} (${this.protocol}://${this.host}:${this.port}${this.basePath})`);
        this.log.debug(`Verbindungsdetails: protocol=${this.protocol} host="${this.host}" port=${this.port} rejectUnauthorized=${this.rejectUnauthorized}`);

        const pollSeconds = Number(this.config.pollInterval) > 0 ? Number(this.config.pollInterval) : 60;

        this.subscribeStates('*');

        await this.updateStatesFromProject();

        // Vollabgleich als Sicherheitsnetz (falls Notifications mal ausfallen
        // sollten) - läuft parallel zu den Notifications, daher reicht ein
        // größeres Intervall als früher völlig aus.
        this.pollTimer = this.setInterval(() => this.updateStatesFromProject(), pollSeconds * 1000);

        // Echtzeit-Updates per Long-Polling-Notifications starten (läuft im
        // Hintergrund weiter, blockiert onReady nicht).
        this.notificationsActive = true;
        this.startNotifications();
    }

    onUnload(callback) {
        try {
            // Sofort setzen, damit keine weiteren DB-Schreibzugriffe mehr
            // versucht werden, auch wenn noch asynchrone Operationen laufen.
            this.shuttingDown = true;
            this.notificationsActive = false;

            if (this.pollTimer) this.clearInterval(this.pollTimer);

            // Laufenden Long-Poll-Request aktiv abbrechen, statt bis zu
            // 55 Sekunden auf eine Antwort zu warten - vermeidet, dass eine
            // verspätete Antwort nach Verbindungsschluss noch verarbeitet wird.
            if (this.pendingNotificationReq) {
                this.pendingNotificationReq.destroy();
                this.pendingNotificationReq = null;
            }

            if (this.subscriberId) {
                // Best-effort Unsubscribe, damit BootUp die Subscriber-Resource
                // sofort freigibt statt erst nach ~1h Timeout.
                this.apiRequest('DELETE', `${this.basePath}/notifications/${this.subscriberId}/unsubscribe`)
                    .catch(() => {}) // Fehler beim Abmelden sind unkritisch, Adapter wird sowieso beendet
                    .finally(() => callback());
            } else {
                callback();
            }
        } catch (e) {
            callback();
        }
    }

    // ---- Generischer API-Call ------------------------------------------
    // query: Objekt mit Query-Parametern, z.B. {state: 'ON'} -> ?state=ON
    // jsonBody: optionales Objekt, das als JSON-Body mitgeschickt wird (z.B. beim Subscribe)
    apiRequest(method, path, query, jsonBody) {
        return new Promise((resolve, reject) => {
            let fullPath = path;
            if (query && Object.keys(query).length) {
                const qs = Object.entries(query)
                    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
                    .join('&');
                fullPath += (path.includes('?') ? '&' : '?') + qs;
            }

            const payload = jsonBody !== undefined ? JSON.stringify(jsonBody) : null;

            const options = {
                hostname: this.host,
                port: this.port,
                path: fullPath,
                method,
                headers: {
                    'X-API-KEY': this.config.apiKey,
                    'Accept': 'application/json',
                    'Content-Type': 'application/json'
                }
            };
            if (this.protocol === 'https') {
                options.rejectUnauthorized = this.rejectUnauthorized;
                if (this.minTlsVersion) options.minVersion = this.minTlsVersion;
                if (this.maxTlsVersion) options.maxVersion = this.maxTlsVersion;
            }
            if (payload) {
                options.headers['Content-Length'] = Buffer.byteLength(payload);
            }

            const req = this.lib.request(options, res => {
                let data = '';
                res.on('data', chunk => (data += chunk));
                res.on('end', () => {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            resolve(data ? JSON.parse(data) : null);
                        } catch (e) {
                            resolve(data);
                        }
                    } else {
                        const err = new Error(`HTTP ${res.statusCode} bei ${path}: ${data}`);
                        err.statusCode = res.statusCode;
                        reject(err);
                    }
                });
            });

            req.on('error', reject);
            if (payload) req.write(payload);
            req.end();
        });
    }

    fetchProject() {
        return this.apiRequest('GET', `${this.basePath}/project`);
    }

    // ---- Hilfsfunktionen -------------------------------------------------
    static sanitize(str) {
        return String(str)
            .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
            .replace(/Ä/g, 'Ae').replace(/Ö/g, 'Oe').replace(/Ü/g, 'Ue')
            .replace(/[^a-zA-Z0-9_]+/g, '_')
            .replace(/^_+|_+$/g, '');
    }

    // Rundet Temperaturwerte auf 1 Nachkommastelle (z.B. 23.6862745 -> 23.7).
    static roundTemp(value) {
        if (value === undefined || value === null || isNaN(value)) return value;
        return Math.round(Number(value) * 10) / 10;
    }

    async ensureAndSetState(id, value, common) {
        if (this.shuttingDown) return; // keine DB-Zugriffe mehr nach Beginn des Shutdowns

        await this.setObjectNotExistsAsync(id, {
            type: 'state',
            common: {
                name: common.name || id,
                type: common.type || 'mixed',
                role: common.role || 'state',
                read: true,
                write: !!common.write,
                unit: common.unit || ''
            },
            native: {}
        });

        const prev = this.stateCache[id];
        if (prev !== undefined && prev !== value) {
            this.log.info(`Zustandsänderung "${common.name || id}" (${id}): ${prev} -> ${value}`);
        }
        this.stateCache[id] = value;

        await this.setStateAsync(id, { val: value, ack: true });
    }

    // Sorgt für einen sauberen Anzeigenamen im Objektbaum (unabhängig von der
    // technischen ID, die z.B. bei Geräten ein GUID-Kürzel enthalten kann).
    async ensureFolder(id, name) {
        if (this.shuttingDown) return;
        await this.extendObjectAsync(id, { type: 'folder', common: { name } });
    }

    async ensureChannel(id, name) {
        if (this.shuttingDown) return;
        await this.extendObjectAsync(id, { type: 'channel', common: { name } });
    }

    // ---- Ein einzelnes Device auf States abbilden -------------------------
    async processDevice(device, baseId) {
        const guid = device.Guid;
        const pathRef = device.PathRef;
        const type = device.DeviceStateType;

        // Anzeigename im Objektbaum = reiner Gerätename (ohne GUID-Kürzel).
        await this.ensureChannel(baseId, device.Name);

        this.deviceIndex[baseId] = { guid, pathRef, type };
        this.guidIndex[guid] = baseId;

        await this.ensureAndSetState(`${baseId}.guid`, guid, { name: 'Guid', type: 'string' });

        switch (type) {
            case 'DeviceStateThermostat':
                await this.ensureAndSetState(`${baseId}.actual`, Bootup.roundTemp(device.TemperatureActual), {
                    name: 'Ist-Temperatur', type: 'number', role: 'value.temperature', unit: '°C'
                });
                await this.ensureAndSetState(`${baseId}.setpoint`, Bootup.roundTemp(device.TemperatureSetpoing), {
                    name: 'Soll-Temperatur', type: 'number', role: 'level.temperature', unit: '°C', write: true
                });
                break;

            case 'DeviceStateBlind':
                await this.ensureAndSetState(`${baseId}.state`, device.State, {
                    name: 'Zustand', type: 'string', role: 'text'
                });
                if (device.Position !== undefined) {
                    await this.ensureAndSetState(`${baseId}.position`, device.Position, {
                        name: 'Position (%)', type: 'number', role: 'level.blind', unit: '%', write: true
                    });
                }
                break;

            case 'DeviceStateSwitch':
                await this.ensureAndSetState(`${baseId}.state`, device.State === 'ON', {
                    name: 'Zustand', type: 'boolean', role: 'switch', write: true
                });
                break;

            case 'DeviceStateWindowHandle':
                await this.ensureAndSetState(`${baseId}.state`, device.State, {
                    name: 'Fenstergriff', type: 'string', role: 'text'
                });
                break;

            case 'DeviceStateAlarmSystem':
                await this.ensureAndSetState(`${baseId}.state`, device.State, {
                    name: 'Alarmstatus', type: 'string', role: 'text'
                });
                break;

            case 'DeviceStateOccupancy':
                await this.ensureAndSetState(`${baseId}.state`, device.State, {
                    name: 'Präsenz', type: 'string', role: 'text'
                });
                await this.ensureAndSetState(`${baseId}.brightness`, device.Brightness, {
                    name: 'Helligkeit', type: 'number', role: 'value.brightness'
                });
                break;

            case 'DeviceStateSceneController':
                for (const scene of device.Scenes || []) {
                    const sceneId = `${baseId}.scene_${Bootup.sanitize(scene.Name)}`;
                    this.deviceIndex[sceneId] = {
                        guid: scene.Guid,
                        controllerGuid: device.Guid,
                        pathRef: scene.PathRef,
                        type: 'DeviceStateScene'
                    };
                    await this.ensureAndSetState(sceneId, false, {
                        name: scene.Name, type: 'boolean', role: 'button', write: true
                    });
                }
                break;

            default:
                await this.ensureAndSetState(`${baseId}.raw`, JSON.stringify(device), {
                    name: 'Rohdaten', type: 'string', role: 'json'
                });
        }
    }

    // ---- Projektbaum (Floors/Rooms/Devices) rekursiv durchlaufen ----------
    async processProject(project) {
        let count = 0;
        for (const floor of project.Floors || []) {
            const floorName = Bootup.sanitize(floor.Name);
            await this.ensureFolder(floorName, floor.Name);

            for (const room of floor.Rooms || []) {
                const roomName = Bootup.sanitize(room.Name);
                const roomId = `${floorName}.${roomName}`;
                await this.ensureFolder(roomId, room.Name);

                for (const device of room.Devices || []) {
                    const devName = Bootup.sanitize(device.Name) + '_' + device.Guid.slice(0, 8);
                    const baseId = `${roomId}.${devName}`;
                    await this.processDevice(device, baseId);
                    count++;
                }
            }
        }
        return count;
    }

    async updateStatesFromProject() {
        if (this.shuttingDown) return;
        try {
            const project = await this.fetchProject();
            if (this.shuttingDown) return; // Antwort kam erst nach Shutdown-Beginn
            const count = await this.processProject(project);
            await this.setStateAsync('info.connection', { val: true, ack: true });
            this.log.info(`${count} Geräte aktualisiert.`);
        } catch (err) {
            if (this.shuttingDown) return;
            await this.setStateAsync('info.connection', { val: false, ack: true });
            this.log.error('Fehler beim Abrufen des Projekts: ' + err.message);
        }
    }

    // ---- Zustand SETZEN -----------------------------------------------
    // PATCH .../switches/{deviceId}?state=ON|OFF
    // PATCH .../blinds/{deviceId}?position=<0-100|OPEN|CLOSE|STOP>
    // PATCH .../thermostats/{deviceId}?temperaturesetpoint=<Grad>
    // PATCH .../scenes/{sceneControllerId}/{sceneId}   (kein Query-Parameter)
    setDeviceState(pathRef, guid, paramName, value) {
        const path = `${this.basePath}/${pathRef}/${guid}`;
        return this.apiRequest('PATCH', path, { [paramName]: value });
    }

    setSwitch(baseId, on) {
        const info = this.deviceIndex[baseId];
        if (!info) throw new Error(`Unbekannte Device-ID: ${baseId}`);
        return this.setDeviceState(info.pathRef, info.guid, 'state', on ? 'ON' : 'OFF');
    }

    setBlindPosition(baseId, position) {
        const info = this.deviceIndex[baseId];
        if (!info) throw new Error(`Unbekannte Device-ID: ${baseId}`);
        return this.setDeviceState(info.pathRef, info.guid, 'position', position);
    }

    setThermostatSetpoint(baseId, temperature) {
        const info = this.deviceIndex[baseId];
        if (!info) throw new Error(`Unbekannte Device-ID: ${baseId}`);
        return this.setDeviceState(info.pathRef, info.guid, 'temperaturesetpoint', temperature);
    }

    triggerScene(baseId) {
        const info = this.deviceIndex[baseId];
        if (!info) throw new Error(`Unbekannte Device-ID: ${baseId}`);
        const path = `${this.basePath}/scenes/${info.controllerGuid}/${info.guid}`;
        return this.apiRequest('PATCH', path);
    }

    // ---- Auf State-Änderungen reagieren und an BootUp senden --------------
    async onStateChange(id, state) {
        if (!state) return; // State wurde gelöscht

        const relId = id.replace(`${this.namespace}.`, '');

        if (relId.startsWith('info.')) return; // eigene info.*-States ignorieren

        this.log.debug(`State-Änderung empfangen: ${relId} = ${state.val} (ack=${state.ack})`);

        if (state.ack) return; // nur auf "von außen" gesetzte Befehle reagieren

        const suffix = relId.split('.').pop();

        try {
            if (suffix.startsWith('scene_')) {
                this.log.info(`Löse Szene aus: ${relId}`);
                await this.triggerScene(relId);
            } else {
                const baseId = relId.replace(/\.(state|position|setpoint)$/, '');
                if (suffix === 'state' && typeof state.val === 'boolean') {
                    this.log.info(`Setze Schalter ${baseId}: ${state.val}`);
                    await this.setSwitch(baseId, state.val);
                } else if (suffix === 'position') {
                    this.log.info(`Setze Jalousie-Position ${baseId}: ${state.val}`);
                    await this.setBlindPosition(baseId, state.val);
                } else if (suffix === 'setpoint') {
                    this.log.info(`Setze Solltemperatur ${baseId}: ${state.val}`);
                    await this.setThermostatSetpoint(baseId, state.val);
                } else {
                    return; // kein bekannter schreibbarer Suffix
                }
            }
            this.log.info(`${relId} erfolgreich an BootUp übermittelt.`);
            await this.updateStatesFromProject();
        } catch (err) {
            this.log.error(`Fehler beim Schreiben von ${relId}: ` + err.message);
        }
    }

    // ---- Notifications (Long-Polling) --------------------------------
    // POST /notifications/subscribe  Body: {callbackUrl: null}  -> {SubscriberId}
    // callbackUrl=null aktiviert den Polling-Modus (kein Webhook, kein
    // offener Port auf unserer Seite nötig).
    async subscribeNotifications() {
        const res = await this.apiRequest('POST', `${this.basePath}/notifications/subscribe`, null, { callbackUrl: null });
        this.subscriberId = res && (res.SubscriberId || res.subscriberId);
        if (!this.subscriberId) {
            throw new Error('Subscribe-Antwort enthielt keine SubscriberId: ' + JSON.stringify(res));
        }
        this.log.info(`Notifications abonniert (SubscriberId: ${this.subscriberId}).`);
    }

    // Führt den blockierenden GET-Call für Notifications direkt aus (statt
    // über die generische apiRequest()), damit wir das zugrundeliegende
    // http-Request-Objekt referenzieren und beim Adapter-Stopp aktiv
    // abbrechen können (statt bis zu timeoutSec Sekunden zu warten).
    pendForNotifications(subscriberId, timeoutSec) {
        return new Promise((resolve, reject) => {
            const path = `${this.basePath}/notifications/${subscriberId}?timeoutSec=${timeoutSec}`;
            const options = {
                hostname: this.host,
                port: this.port,
                path,
                method: 'GET',
                headers: {
                    'X-API-KEY': this.config.apiKey,
                    'Accept': 'application/json'
                }
            };
            if (this.protocol === 'https') {
                options.rejectUnauthorized = this.rejectUnauthorized;
                if (this.minTlsVersion) options.minVersion = this.minTlsVersion;
                if (this.maxTlsVersion) options.maxVersion = this.maxTlsVersion;
            }

            const req = this.lib.request(options, res => {
                let data = '';
                res.on('data', chunk => (data += chunk));
                res.on('end', () => {
                    this.pendingNotificationReq = null;
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        try {
                            resolve(data ? JSON.parse(data) : null);
                        } catch (e) {
                            resolve(null);
                        }
                    } else {
                        const err = new Error(`HTTP ${res.statusCode} bei ${path}: ${data}`);
                        err.statusCode = res.statusCode;
                        reject(err);
                    }
                });
            });

            req.on('error', err => {
                this.pendingNotificationReq = null;
                // Beim absichtlichen Abbrechen (destroy() in onUnload) ist ein
                // Fehler hier normal und erwartet - nicht als echten Fehler behandeln.
                if (this.shuttingDown) {
                    resolve(null);
                } else {
                    reject(err);
                }
            });

            this.pendingNotificationReq = req;
            req.end();
        });
    }

    // Startet die Endlosschleife, die pending auf Notifications wartet.
    // Läuft im Hintergrund, bis this.notificationsActive = false gesetzt wird.
    async startNotifications() {
        while (this.notificationsActive) {
            try {
                if (!this.subscriberId) {
                    await this.subscribeNotifications();
                }

                const timeoutSec = 55; // < 60s Subscriber-Timeout laut Doku, konservativ gewählt
                const result = await this.pendForNotifications(this.subscriberId, timeoutSec);

                if (this.shuttingDown) return; // Antwort kam erst nach Shutdown-Beginn -> verwerfen

                if (result) {
                    await this.processNotifications(result);
                }
                // Sofort wieder in die nächste Wartephase - kein Sleep nötig,
                // der GET-Call selbst blockiert ja schon bis zu timeoutSec Sekunden.
            } catch (err) {
                if (this.shuttingDown) return;

                if (err.statusCode === 404) {
                    // Subscriber ist abgelaufen/ungültig geworden -> neu abonnieren
                    this.log.warn('Notification-Subscription abgelaufen, abonniere neu...');
                    this.subscriberId = null;
                } else {
                    this.log.error('Fehler beim Warten auf Notifications: ' + err.message);
                    // Kurze Pause, um bei dauerhaften Fehlern (z.B. Netzwerk down)
                    // nicht in einer Endlosschleife die API zu fluten.
                    await new Promise(resolve => this.setTimeout(resolve, 10000));
                }
            }
        }
    }

    // Verarbeitet eine Notification-Antwort mit "Devices" und "Rooms" Arrays.
    async processNotifications(result) {
        for (const deviceNotification of result.Devices || []) {
            await this.applyDeviceNotification(deviceNotification);
        }
        for (const roomNotification of result.Rooms || []) {
            await this.applyRoomNotification(roomNotification);
        }
    }

    async applyDeviceNotification(notification) {
        const type = notification.NotificationType;
        const state = notification.DeviceState;

        if (type === 'DeviceCreated' || type === 'DeviceDeleted') {
            // Struktur betroffen (neues Gerät / Gerät entfernt) - dafür reicht
            // ein kompletter Neuaufbau des Baums am einfachsten und sichersten.
            this.log.info(`Notification: ${type} (Guid: ${state && state.Guid}) - baue Baum neu auf.`);
            await this.updateStatesFromProject();
            return;
        }

        // DeviceStateChanged / DeviceStateUpdate: nur die betroffenen Werte aktualisieren
        if (!state || !state.Guid) return;
        const baseId = this.guidIndex[state.Guid];
        if (!baseId) {
            // Unbekanntes Gerät (z.B. Notification kam vor dem ersten
            // vollständigen Projekt-Abgleich an) -> sicherheitshalber neu abgleichen
            this.log.debug(`Notification für unbekanntes Gerät (Guid: ${state.Guid}) - baue Baum neu auf.`);
            await this.updateStatesFromProject();
            return;
        }

        await this.applyDeviceStateFields(baseId, state);
    }

    // Aktualisiert nur die State-Werte eines bereits bekannten Geräts
    // (Objekte/Channels existieren schon, nur die Werte ändern sich).
    async applyDeviceStateFields(baseId, state) {
        const type = state.DeviceStateType || (this.deviceIndex[baseId] && this.deviceIndex[baseId].type);

        switch (type) {
            case 'DeviceStateThermostat':
                if (state.TemperatureActual !== undefined) {
                    await this.ensureAndSetState(`${baseId}.actual`, Bootup.roundTemp(state.TemperatureActual), {
                        name: 'Ist-Temperatur', type: 'number', role: 'value.temperature', unit: '°C'
                    });
                }
                if (state.TemperatureSetpoing !== undefined) {
                    await this.ensureAndSetState(`${baseId}.setpoint`, Bootup.roundTemp(state.TemperatureSetpoing), {
                        name: 'Soll-Temperatur', type: 'number', role: 'level.temperature', unit: '°C', write: true
                    });
                }
                break;

            case 'DeviceStateBlind':
                if (state.State !== undefined) {
                    await this.ensureAndSetState(`${baseId}.state`, state.State, {
                        name: 'Zustand', type: 'string', role: 'text'
                    });
                }
                if (state.Position !== undefined) {
                    await this.ensureAndSetState(`${baseId}.position`, state.Position, {
                        name: 'Position (%)', type: 'number', role: 'level.blind', unit: '%', write: true
                    });
                }
                break;

            case 'DeviceStateSwitch':
                if (state.State !== undefined) {
                    await this.ensureAndSetState(`${baseId}.state`, state.State === 'ON', {
                        name: 'Zustand', type: 'boolean', role: 'switch', write: true
                    });
                }
                break;

            case 'DeviceStateWindowHandle':
                if (state.State !== undefined) {
                    await this.ensureAndSetState(`${baseId}.state`, state.State, {
                        name: 'Fenstergriff', type: 'string', role: 'text'
                    });
                }
                break;

            case 'DeviceStateAlarmSystem':
                if (state.State !== undefined) {
                    await this.ensureAndSetState(`${baseId}.state`, state.State, {
                        name: 'Alarmstatus', type: 'string', role: 'text'
                    });
                }
                break;

            case 'DeviceStateOccupancy':
                if (state.State !== undefined) {
                    await this.ensureAndSetState(`${baseId}.state`, state.State, {
                        name: 'Präsenz', type: 'string', role: 'text'
                    });
                }
                if (state.Brightness !== undefined) {
                    await this.ensureAndSetState(`${baseId}.brightness`, state.Brightness, {
                        name: 'Helligkeit', type: 'number', role: 'value.brightness'
                    });
                }
                break;

            default:
                // Unbekannter/nicht separat behandelter Typ - sicherheitshalber
                // kompletten Baum neu abgleichen, damit nichts verloren geht.
                this.log.debug(`Notification mit unbekanntem DeviceStateType "${type}" - baue Baum neu auf.`);
                await this.updateStatesFromProject();
        }
    }

    async applyRoomNotification(notification) {
        const type = notification.NotificationType;
        const state = notification.RoomState;

        // Räume/Etagen können neu angelegt, gelöscht oder umbenannt werden -
        // dafür reicht ein kompletter Neuaufbau am einfachsten und sichersten,
        // da sich sonst auch IDs verschieben könnten.
        this.log.info(`Notification: ${type} (Raum/Etage: ${state && state.Name}) - baue Baum neu auf.`);
        await this.updateStatesFromProject();
    }
}

if (require.main !== module) {
    module.exports = options => new Bootup(options);
} else {
    new Bootup();
}
