# mail-mcp

Ein eigener MCP-Server für dein IMAP-Postfach. Läuft als Docker-Container (z. B. auf TrueNAS SCALE) und gibt Claude Zugriff auf deine Mails: lesen, suchen, sortieren, Entwürfe anlegen und optional per SMTP senden.

Funktioniert mit jedem Anbieter, der IMAP kann: eigener Mailserver, GMX, Web.de, Posteo, mailbox.org, IONOS, Strato, Gmail, Outlook/Office 365 (mit App-Passwort, sofern der Anbieter Basic-Auth für IMAP noch zulässt).

## Tools

| Tool | Was es tut | Ändert etwas? |
|---|---|---|
| `mail_list_folders` | Ordner mit Anzahl gesamt/ungelesen, erkennt Gesendet/Entwürfe/Papierkorb | nein |
| `mail_list_messages` | Neueste Nachrichten eines Ordners, optional nur ungelesene | nein |
| `mail_search` | Suche nach Absender, Empfänger, Betreff, Text, Zeitraum, Status | nein |
| `mail_get_message` | Ganze Nachricht als Text inkl. Anhangsliste (markiert **nicht** als gelesen) | nein |
| `mail_get_attachment` | Anhang als Text, Bild oder Datei (bis 8 MB) | nein |
| `mail_set_flags` | gelesen/ungelesen, markiert, beantwortet | ja |
| `mail_move_messages` | In anderen Ordner verschieben | ja |
| `mail_delete_messages` | In den Papierkorb (Standard) oder endgültig löschen | ja |
| `mail_create_folder` | Ordner anlegen | ja |
| `mail_save_draft` | Entwurf speichern (auch als Antwort mit korrektem Threading) | ja |
| `mail_send_email` | Sofort senden per SMTP, Kopie in „Gesendet“ | ja, nur wenn SMTP konfiguriert |

Mit `READ_ONLY=true` werden nur die lesenden Tools angeboten.

## Konfiguration

Alles läuft über Umgebungsvariablen (Vorlage: [`.env.example`](.env.example)).

| Variable | Pflicht | Standard | Bedeutung |
|---|---|---|---|
| `IMAP_HOST` | ja | | z. B. `imap.gmx.net` |
| `IMAP_PORT` | | `993` | `993` (TLS) oder `143` (STARTTLS) |
| `IMAP_SECURE` | | `true` | `true` für Port 993, `false` für 143 |
| `IMAP_USER` | ja | | Benutzername, meist die Mailadresse |
| `IMAP_PASSWORD` | ja | | Passwort bzw. App-Passwort |
| `SMTP_HOST` | | | gesetzt = Senden aktiv, leer = kein `mail_send_email` |
| `SMTP_PORT` | | `465` | `465` (TLS) oder `587` (STARTTLS, dann `SMTP_SECURE=false`) |
| `SMTP_SECURE` | | `true` | |
| `SMTP_USER` / `SMTP_PASSWORD` | | IMAP-Werte | nur nötig, wenn abweichend |
| `MAIL_FROM` | | `IMAP_USER` | Absender, z. B. `Paul <paul@example.com>` |
| `SAVE_SENT` | | `true` | Kopie in „Gesendet“ ablegen. Bei Gmail `false` (macht Gmail selbst) |
| `FOLDER_SENT` / `FOLDER_DRAFTS` / `FOLDER_TRASH` | | automatisch | nur falls die Erkennung nicht klappt |
| `MCP_AUTH_TOKEN` | ja* | | Geheimer Zugriffsschlüssel, mind. 24 Zeichen (`openssl rand -hex 32`) |
| `ALLOW_NO_AUTH` | | `false` | `true` erlaubt Betrieb ohne Token (nur im abgeschotteten LAN!) |
| `READ_ONLY` | | `false` | nur lesende Tools |
| `ALLOWED_HOSTS` | | | erlaubte Hostnamen, kommagetrennt (Schutz vor DNS-Rebinding) |
| `PORT` | | `3000` | |
| `TZ` | | `Europe/Berlin` | Zeitzone für Datumsanzeige |
| `TRANSPORT` | | `http` | `stdio` für lokalen Betrieb ohne Docker |

### Zugriffsschutz

Der Server verlangt den Token auf zwei Arten (eine reicht):

- Header `Authorization: Bearer <MCP_AUTH_TOKEN>` an `http://<nas>:30993/mcp`
- oder im Pfad: `http://<nas>:30993/mcp/<MCP_AUTH_TOKEN>` (für Clients, in denen man keine Header setzen kann, z. B. benutzerdefinierte Connectors in claude.ai)

Behandle die URL mit Token im Pfad wie ein Passwort.

## Installation auf TrueNAS SCALE

Getestet ist das Vorgehen für TrueNAS SCALE ab 24.10 („Electric Eel“), wo Apps als Docker-Container laufen.

### 1. Image bereitstellen

Bei jedem Push auf `main` baut GitHub Actions das Image und legt es als `ghcr.io/mrzapp-lm/mail-mcp:latest` ab (amd64 und arm64).

Ist das Repository privat, ist auch das Image privat. Dann entweder:
- auf GitHub unter **Packages → mail-mcp → Package settings** die Sichtbarkeit auf *Public* stellen (das Image enthält keine Zugangsdaten), oder
- in TrueNAS unter **Apps → Configuration → Manage Container Image Registries** `ghcr.io` mit deinem GitHub-Benutzernamen und einem Personal Access Token (Recht `read:packages`) hinterlegen.

### 2. App anlegen

**Apps → Discover Apps → ⋮ (oben rechts) → Install via YAML**, Name z. B. `mail-mcp`, und folgendes einfügen (Werte anpassen):

```yaml
services:
  mail-mcp:
    image: ghcr.io/mrzapp-lm/mail-mcp:latest
    restart: unless-stopped
    ports:
      - "30993:3000"
    environment:
      IMAP_HOST: imap.example.com
      IMAP_PORT: "993"
      IMAP_USER: paul@example.com
      IMAP_PASSWORD: "app-passwort"
      # Senden (optional, sonst die nächsten 4 Zeilen weglassen)
      SMTP_HOST: smtp.example.com
      SMTP_PORT: "465"
      MAIL_FROM: "Paul <paul@example.com>"
      SAVE_SENT: "true"
      MCP_AUTH_TOKEN: "hier-ein-langer-zufallswert"
      TZ: Europe/Berlin
```

Links steht der Port auf dem NAS (hier 30993, weil 3000 auf TrueNAS oft schon belegt ist), rechts der Port im Container (immer 3000). Ist 30993 auch belegt, links einen anderen freien Port nehmen, z. B. `"30994:3000"`. Rechts bleibt immer 3000.

### 3. Prüfen

Im Browser: `http://<nas-ip>:30993/health?imap=1`
Erwartet: `{"status":"ok","version":"1.0.0","imap":"ok"}`. Steht dort ein Fehler, sagt die Meldung, was nicht passt (Login, Host, Port).

Logs: in TrueNAS bei der App unter **Workloads → Logs**.

### Updates

Neues Image: in TrueNAS bei der App **Update** bzw. die App neu deployen (zieht `latest` neu). Alternativ mit festen Versions-Tags (`v1.0.0`) arbeiten.

### Ohne TrueNAS-Oberfläche

Auf jedem Docker-Host mit Compose:

```bash
cp .env.example .env   # Werte eintragen
docker compose up -d
```

## Mit Claude verbinden

### Claude Code (im LAN oder per VPN/Tailscale)

```bash
claude mcp add --transport http mail http://<nas-ip>:30993/mcp \
  --header "Authorization: Bearer <MCP_AUTH_TOKEN>"
```

### Claude Desktop

In `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mail": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://<nas-ip>:30993/mcp", "--allow-http",
               "--header", "Authorization: Bearer <MCP_AUTH_TOKEN>"]
    }
  }
}
```

### claude.ai (Web/App) als benutzerdefinierter Connector

claude.ai ruft den Server aus dem Internet auf, nicht aus deinem Heimnetz. Dafür braucht der Server eine öffentlich erreichbare **HTTPS**-Adresse, z. B. über:

- einen Reverse Proxy mit Zertifikat (Nginx Proxy Manager, Traefik, Caddy) und Portweiterleitung, oder
- einen Cloudflare Tunnel (keine offenen Ports am Router nötig), oder
- Tailscale Funnel.

Dann in claude.ai unter **Einstellungen → Connectors → Benutzerdefinierten Connector hinzufügen** als URL eintragen:

```
https://mail-mcp.deine-domain.de/mcp/<MCP_AUTH_TOKEN>
```

Tipp: Setze dann `ALLOWED_HOSTS=mail-mcp.deine-domain.de` und überlege, ob `READ_ONLY=true` für den Anfang reicht.

## Entwicklung

```bash
npm install
npm run build
docker compose -f docker-compose.test.yml up -d   # Test-Mailserver (GreenMail)
npm run smoke                                      # ruft alle Tools gegen den Testserver auf
```

Lokal ohne Docker (stdio, z. B. für Claude Desktop direkt):

```bash
TRANSPORT=stdio IMAP_HOST=... IMAP_USER=... IMAP_PASSWORD=... node dist/index.js
```

Gebaut mit dem offiziellen MCP TypeScript SDK v2 (`@modelcontextprotocol/server`), [imapflow](https://github.com/postalsys/imapflow), [mailparser](https://github.com/nodemailer/mailparser) und [nodemailer](https://nodemailer.com/).
