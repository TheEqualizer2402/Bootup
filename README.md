# ioBroker.bootup

Verbindet ioBroker mit der BootUp myHomeControl Cloud-API.

## Workflow: GitHub als zentrale Codebasis

Dieses Projekt wird über ein privates GitHub-Repository verwaltet. Der
Server, auf dem ioBroker läuft, zieht sich den Code direkt von dort per
`git clone` / `git pull` - es müssen keine Dateien mehr manuell per ZIP
kopiert werden.

### Einmalige Ersteinrichtung auf dem ioBroker-Server

```bash
cd /opt/iobroker/node_modules
git clone https://github.com/DEIN-USERNAME/DEIN-REPO-NAME.git iobroker.bootup
cd iobroker.bootup
npm install --production
cd /opt/iobroker
iobroker upload bootup
iobroker add bootup
```

Bei einem privaten Repo fragt Git beim Klonen nach Zugangsdaten:
- Username: dein GitHub-Benutzername
- Passwort: ein Personal Access Token (kein normales Passwort) -
  erstellbar unter GitHub → Profilbild → Settings → Developer settings →
  Personal access tokens → Generate new token (Scope: `repo`)

Danach über die Admin-Oberfläche die Instanz `bootup.0` konfigurieren
(siehe Abschnitt "Konfiguration" unten) und starten.

### Bei jedem künftigen Update

```bash
cd /opt/iobroker/node_modules/iobroker.bootup
git pull
npm install --production        # nur nötig, falls sich package.json geändert hat
cd /opt/iobroker
iobroker upload bootup          # nur nötig, falls sich admin/jsonConfig.json geändert hat
iobroker restart bootup.0
```

## Installation zum Testen (lokal, ohne npm-Veröffentlichung)

Am einfachsten mit dem offiziellen Dev-Server-Tool testen (läuft mit echtem
laufenden ioBroker-Testinstanz, ohne dass etwas veröffentlicht werden muss):

```bash
cd iobroker.bootup
npm install
npx @iobroker/dev-server setup
npx @iobroker/dev-server watch
```

Der Dev-Server startet eine lokale ioBroker-Admin-Oberfläche (Standard:
http://localhost:8081), in der du den Adapter direkt konfigurieren und testen
kannst - Änderungen am Code werden automatisch neu geladen.

## Alternative: Manuell in eine bestehende ioBroker-Installation einbinden

1. Diesen Ordner nach
   `<iobroker-installationspfad>/node_modules/iobroker.bootup` kopieren
   (Ordnername muss exakt `iobroker.bootup` lauten, alles klein geschrieben).
2. Im ioBroker-Installationsverzeichnis:
   ```bash
   iobroker upload bootup
   iobroker add bootup
   ```
3. In der Admin-Oberfläche unter "Instanzen" die neue Instanz `bootup.0`
   konfigurieren: API-Key eintragen, ggf. Host/Base-Path/Poll-Intervall
   anpassen, speichern.
4. Instanz starten.

## Konfiguration

| Feld | Beschreibung |
|---|---|
| X-API-KEY | Dein geheimer BootUp-API-Schlüssel |
| Host | Standard: `www.bootup.ch` |
| API Base-Path | Standard: `/mhccloudserver/api/v1` |
| Abfrage-Intervall (Sekunden) | Wie oft der Projektstatus per Poll abgefragt wird |

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

## Veröffentlichung als "richtiger" Adapter (optional, später)

Falls du den Adapter auch offiziell im ioBroker-Adapter-Store anbieten
möchtest, braucht es zusätzlich: echtes Icon (`admin/bootup.png`, 32x32 und
`admin/bootup-icon.png`), ein Git-Repository, ESLint-Konformität und den
offiziellen Review-Prozess über `@iobroker/create-adapter`. Für den privaten
Gebrauch (siehe oben) ist das alles nicht nötig.
