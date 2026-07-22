# ioBroker.bootup

Verbindet ioBroker mit der BootUp myHomeControl Cloud-API.

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

## Veröffentlichung als "richtiger" Adapter (optional, später)

Falls du den Adapter auch offiziell im ioBroker-Adapter-Store anbieten
möchtest, braucht es zusätzlich: echtes Icon (`admin/bootup.png`, 32x32 und
`admin/bootup-icon.png`), ein Git-Repository, ESLint-Konformität und den
offiziellen Review-Prozess über `@iobroker/create-adapter`. Für den privaten
Gebrauch (siehe oben) ist das alles nicht nötig.
