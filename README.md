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
