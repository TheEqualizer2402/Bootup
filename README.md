# ioBroker.bootup

Verbindet ioBroker mit der BootUp myHomeControl API (Cloud oder lokal).

## Workflow: GitHub als zentrale Codebasis

Dieses Projekt wird über ein GitHub-Repository verwaltet. Der Server, auf
dem ioBroker läuft, zieht sich den Code direkt von dort per `npm install`
(Git-URL) - es müssen keine Dateien mehr manuell per ZIP kopiert werden.

### Einmalige Ersteinrichtung auf dem ioBroker-Server

```bash
cd /opt/iobroker
npm install https://github.com/TheEqualizer2402/Bootup.git --production
iobroker upload bootup
iobroker add bootup
```

Danach über die Admin-Oberfläche die Instanz `bootup.0` konfigurieren
(siehe Abschnitt "Konfiguration" unten) und starten.

### Bei jedem künftigen Update

```bash
cd /opt/iobroker
npm install https://github.com/TheEqualizer2402/Bootup.git --production
iobroker upload bootup          # nur nötig, falls sich admin/jsonConfig.json geändert hat
iobroker restart bootup.0
```

## Konfiguration

| Feld | Beschreibung |
|---|---|
| X-API-KEY | Dein geheimer BootUp-API-Schlüssel |
| Verbindungsart | "Cloud" (BootUp-Server im Internet) oder "Lokal" (eigener Server im lokalen Netz) |
| Host / API Base-Path | Nur bei Cloud-Verbindung, Standard: `www.bootup.ch` / `/mhccloudserver/api/v1` |
| Lokale IP-Adresse / Port / Protokoll | Nur bei lokaler Verbindung, z.B. `192.168.1.50` / `4443` / `HTTP` (viele lokale Geräte sprechen reines HTTP) |
| Abfrage-Intervall (Sekunden) | Sicherheitsnetz zusätzlich zu den Echtzeit-Notifications |

**Hinweis zur lokalen Verbindung:** Der API-Pfad ist dabei fest auf `/v1`
gesetzt (kürzer als der Cloud-Pfad). Da lokale Server meist ein
selbstsigniertes Zertifikat verwenden, wird die Zertifikatsprüfung für
diese Verbindung automatisch deaktiviert.

## Unterstützte Gerätetypen

- Switches (lesen + schreiben)
- Blinds / Jalousien (lesen + schreiben, Position 0-100 oder OPEN/CLOSE/STOP)
- Thermostate (lesen + schreiben der Solltemperatur)
- Szenen (auslösen per Button-State)
- WindowHandles, AlarmSystem, Occupancy (nur lesend)

## Echtzeit-Updates (Notifications)

Der Adapter abonniert beim Start automatisch die BootUp-Notifications im
Long-Polling-Modus (kein Webhook, kein offener Port nötig). Zustandsänderungen
werden dadurch nahezu in Echtzeit übernommen, statt erst beim nächsten
Poll-Intervall. Der reguläre Voll-Abgleich (`pollInterval`) läuft weiterhin
im Hintergrund als Sicherheitsnetz, falls die Notification-Verbindung mal
unterbrochen sein sollte.

## Installation zum Testen (lokal, ohne npm-Veröffentlichung)

```bash
cd iobroker.bootup
npm install
npx @iobroker/dev-server setup
npx @iobroker/dev-server watch
```

Startet eine lokale ioBroker-Admin-Oberfläche (Standard:
http://localhost:8081), in der du den Adapter direkt konfigurieren und
testen kannst - Änderungen am Code werden automatisch neu geladen.
