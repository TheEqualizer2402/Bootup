# ioBroker.bootup

ioBroker-Adapter für das **BootUp myHomeControl** SmartHome-System (Cloud- oder lokale REST-API) mit integrierter **iPhone-Web-App**.

## Funktionen

- Lesen und Schreiben: Schalter, Jalousien, Thermostate, Szenen
- Lesen: Fenstergriffe, Alarmanlage, Anwesenheit/Bewegung
- Echtzeit-Updates über BootUp-Notifications (Long-Polling)
- Umschaltung Cloud / lokal (HTTP oder HTTPS)
- iPhone-Web-App (PWA) zum Überwachen und Steuern, direkt vom Adapter ausgeliefert

## Installation / Update

Als Benutzer `iobroker` auf dem Server:

```bash
cd /opt/iobroker
npm install https://github.com/TheEqualizer2402/Bootup.git --production
iobroker upload bootup
iobroker restart bootup.0
```

## Konfiguration

| Einstellung | Bedeutung |
|---|---|
| API-Key | BootUp-API-Schlüssel (`X-API-KEY`) |
| Verbindungsart | Cloud oder lokal |
| Cloud-Host / Basis-Pfad | Standard: `www.bootup.ch`, `/mhccloudserver/api/v1` |
| Lokale IP / Port / Protokoll | z. B. `192.168.178.35`, `4443`, `http` |
| Abfrageintervall | Sekunden für den vollständigen Abgleich |
| Web-App aktivieren | Startet den Web-Server der iPhone-App |
| Web-App-Port | Standard `8095` |
| Web-App-Token | Pflicht, mindestens 8 Zeichen (Passwort für die App) |

## iPhone-App einrichten

1. In den Instanzeinstellungen **Web-App aktivieren**, einen **Token** (mind. 8 Zeichen) und ggf. den Port setzen, speichern.
2. Auf dem iPhone in **Safari** `http://<server-ip>:8095/` öffnen und den Token eingeben.
3. **Teilen → Zum Home-Bildschirm**. Die App startet danach wie eine normale App.

Die App zeigt Etagen und Räume, eine Übersicht (Alarmanlage, offene Fenster, Bewegung, eingeschaltete Geräte, Jalousien) und aktualisiert sich live.

## Aussehen anpassen

In der App oben rechts auf **⚙︎** tippen:

- **Darstellung**: Titel, Hell/Dunkel/Automatisch, Akzentfarbe, Dichte (Normal/Kompakt)
- **Seiten**: Übersicht und Favoriten ein-/ausblenden; einzelne Kacheln und Listen der Übersicht wählen
- **Etagen, Räume & Geräte**: aufklappen, Namen antippen zum Umbenennen (leer = Originalname), **Sichtbar/Versteckt**, ▲▼ zum Sortieren, ★ Favorit, Symbol wählen

Änderungen werden sofort angewendet und im Adapter gespeichert (State `info.webConfig`, Teil der ioBroker-Sicherung). Alle iPhones sehen dieselbe Darstellung und werden live aktualisiert. Die Original-Namen in ioBroker/BootUp bleiben unverändert. Versteckte Geräte sind nur ausgeblendet, nicht gesperrt.

## Sicherheit

- Der Web-Server startet nur mit gesetztem Token (mind. 8 Zeichen).
- Token-Vergleich zeitkonstant, Sperre pro IP nach 10 Fehlversuchen (10 Minuten).
- Strenge Eingabeprüfung der Befehle, strikte Content-Security-Policy, keine Fremdquellen.
- Die App läuft per **HTTP im lokalen Netz**. Den Port **nicht** ins Internet weiterleiten. Für Zugriff von unterwegs ein VPN (z. B. WireGuard) verwenden.

## Datenpunkte

Unter `bootup.0.<Etage>.<Raum>.<Gerät>` (Name statt ID, die ID steht in `native`). Änderungen an beschreibbaren Datenpunkten (ack=false) werden an BootUp gesendet.

## Changelog

### 0.7.0
- Web-App: Etagen, Räume und Geräte ausblenden, umbenennen und sortieren; Favoriten, Symbole, Design, Akzentfarbe, kompakte Ansicht

### 0.6.0
- iPhone-Web-App (PWA) mit Token-Schutz und Live-Updates

### 0.5.0
- HTTP/HTTPS-Auswahl für lokale Verbindung

Frühere Versionen siehe `io-package.json`.

## Lizenz

MIT
