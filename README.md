# ChatVZ – Render + PostgreSQL

Diese Version ersetzt SQLite durch PostgreSQL und ist für einen einfachen kostenlosen Render-Test vorbereitet.

## Lokal

Voraussetzung: Node.js 20+ und eine PostgreSQL-Datenbank.

```bash
npm install
npm start
```

Dann `http://localhost:3000` öffnen.

## Render

1. Projekt in ein GitHub-Repository hochladen.
2. In Render das Repository verbinden.
3. `render.yaml` verwenden (Blueprint) oder einen Web Service anlegen.
4. Das PostgreSQL-Database-Service mit dem Backend verbinden.
5. Render setzt `DATABASE_URL`; `JWT_SECRET` wird per `generateValue` erzeugt.
6. Nach dem Deploy die Backend-URL öffnen und `/api/health` prüfen.

Das Frontend kann direkt mit diesem Backend laufen. Wenn du das Frontend separat auf Netlify hostest, muss die Frontend-Konfiguration später auf die Backend-URL zeigen und die WebSocket-URL entsprechend `wss://...` verwenden.

## Wichtig

Die kostenlose Render-Instanz kann bei Inaktivität schlafen. Für einen öffentlichen Dauerbetrieb und viele gleichzeitige Nutzer ist ein bezahlter Dienst sinnvoller.

Für eine echte größere Plattform kommen später Rate-Limits, Moderation, E-Mail-Verifizierung/Passwort-Reset, Bildspeicher, Backups, Logging und ggf. Redis/PubSub für mehrere Backend-Instanzen dazu.


## Launch-Check

Vor einem öffentlichen Launch müssen in Render zusätzlich gesetzt werden:

- `ADMIN_USER_ID`: die numerische ID deines Admin-Accounts. Nach der ersten Registrierung kann sie über die Datenbank ermittelt werden.
- `JWT_SECRET`: wird von Render automatisch erzeugt.

Die Anwendung enthält jetzt:
- Meldungen für Nutzer und Chat-Bilder
- Admin-Endpunkte für offene Meldungen
- Account-Löschung inklusive zugehöriger Upload-Dateien
- Rate-Limits für Login, Registrierung, Meldungen und WebSocket-Nachrichten
- Schutz davor, dass WebSocket-Clients fremde Upload-Pfade als Bilder einschleusen

**Vor dem öffentlichen Launch noch manuell erledigen:** echtes Impressum, Datenschutzerklärung und rechtlich passende Nutzungsbedingungen mit den tatsächlichen Betreiberangaben ergänzen. Die derzeitige UI weist beim Registrieren darauf hin, ersetzt aber keine individuelle Rechtsprüfung.

**Wichtig für Render Free:** lokale Upload-Dateien sind nicht dauerhaft. Für einen öffentlichen Betrieb mit wichtigen Nutzerbildern sollte später Object Storage bzw. ein dauerhafter Speicher verwendet werden.
