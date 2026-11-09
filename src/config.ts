/**
 * Konfiguration aus Umgebungsvariablen. Wird einmal beim Start gelesen.
 */

function env(name: string, fallback?: string): string | undefined {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") return fallback;
  return value.trim();
}

function bool(name: string, fallback: boolean): boolean {
  const value = env(name);
  if (value === undefined) return fallback;
  return ["1", "true", "yes", "on", "ja"].includes(value.toLowerCase());
}

function int(name: string, fallback: number): number {
  const value = env(name);
  if (value === undefined) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) throw new Error(`${name} muss eine Zahl sein, ist aber "${value}"`);
  return parsed;
}

function required(name: string): string {
  const value = env(name);
  if (!value) {
    console.error(`Fehlende Umgebungsvariable: ${name}`);
    process.exit(1);
  }
  return value;
}

const imapSecure = bool("IMAP_SECURE", true);

export const config = {
  imap: {
    host: required("IMAP_HOST"),
    port: int("IMAP_PORT", imapSecure ? 993 : 143),
    secure: imapSecure,
    user: required("IMAP_USER"),
    password: required("IMAP_PASSWORD"),
    rejectUnauthorized: bool("IMAP_TLS_REJECT_UNAUTHORIZED", true)
  },
  smtp: env("SMTP_HOST")
    ? {
        host: env("SMTP_HOST") as string,
        port: int("SMTP_PORT", bool("SMTP_SECURE", true) ? 465 : 587),
        secure: bool("SMTP_SECURE", true),
        user: env("SMTP_USER", env("IMAP_USER")) as string,
        password: env("SMTP_PASSWORD", env("IMAP_PASSWORD")) as string,
        rejectUnauthorized: bool("SMTP_TLS_REJECT_UNAUTHORIZED", true)
      }
    : undefined,
  /** Absender für gesendete Mails und Entwürfe, z. B. "Paul <paul@example.com>" */
  from: env("MAIL_FROM", env("SMTP_USER", env("IMAP_USER"))) as string,
  /** Gesendete Mails per IMAP in den Gesendet-Ordner legen (aus, wenn der Provider das selbst tut, z. B. Gmail) */
  saveSent: bool("SAVE_SENT", true),
  /** Nur lesende Tools anbieten */
  readOnly: bool("READ_ONLY", false),
  /** Ordnernamen überschreiben, falls die automatische Erkennung (SPECIAL-USE) nicht greift */
  folders: {
    sent: env("FOLDER_SENT"),
    drafts: env("FOLDER_DRAFTS"),
    trash: env("FOLDER_TRASH")
  },
  http: {
    transport: (env("TRANSPORT", "http") as string).toLowerCase(),
    host: env("HOST", "0.0.0.0") as string,
    port: int("PORT", 3000),
    authToken: env("MCP_AUTH_TOKEN"),
    allowNoAuth: bool("ALLOW_NO_AUTH", false),
    allowedHosts: (env("ALLOWED_HOSTS", "") as string)
      .split(",")
      .map(h => h.trim())
      .filter(Boolean)
  }
};

export const CHARACTER_LIMIT = 25_000;
