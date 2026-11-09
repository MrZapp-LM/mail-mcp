/**
 * IMAP-Zugriff: eine kurze Verbindung pro Tool-Aufruf. Das ist robust gegen
 * Verbindungsabbrüche (NAS-Standby, Provider-Timeouts) und braucht keinen Zustand.
 */
import { ImapFlow, type ListResponse } from "imapflow";
import { config } from "./config.js";

export class MailError extends Error {}

/** Holt die Antwort des Servers aus einem imapflow-Fehler ("Command failed" allein hilft niemandem). */
export function imapErrorText(error: unknown): string {
  const e = error as { responseText?: string; serverResponseCode?: string; message?: string };
  return [e?.serverResponseCode, e?.responseText ?? e?.message ?? String(error)].filter(Boolean).join(": ");
}

function createClient(): ImapFlow {
  return new ImapFlow({
    host: config.imap.host,
    port: config.imap.port,
    secure: config.imap.secure,
    auth: { user: config.imap.user, pass: config.imap.password },
    tls: { rejectUnauthorized: config.imap.rejectUnauthorized },
    logger: false,
    connectionTimeout: 20_000,
    greetingTimeout: 15_000,
    socketTimeout: 120_000
  });
}

function describeConnectError(error: unknown): string {
  const e = error as { authenticationFailed?: boolean; code?: string; message?: string; responseText?: string };
  if (e?.authenticationFailed) {
    return "IMAP-Anmeldung fehlgeschlagen. IMAP_USER/IMAP_PASSWORD prüfen (bei Gmail/Outlook/GMX ggf. ein App-Passwort verwenden).";
  }
  if (e?.code === "ENOTFOUND" || e?.code === "EAI_AGAIN") {
    return `IMAP-Server "${config.imap.host}" nicht gefunden. IMAP_HOST prüfen.`;
  }
  if (e?.code === "ECONNREFUSED" || e?.code === "ETIMEDOUT" || e?.code === "CONNECT_TIMEOUT") {
    return `Keine Verbindung zu ${config.imap.host}:${config.imap.port}. Port/IMAP_SECURE prüfen (993 = TLS, 143 = STARTTLS).`;
  }
  return `IMAP-Fehler: ${e?.responseText ?? e?.message ?? String(error)}`;
}

/** Öffnet eine Verbindung, führt fn aus und meldet sich wieder ab. */
export async function withClient<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  const client = createClient();
  // Verhindert, dass ein Socket-Fehler nach dem Logout den Prozess beendet
  client.on("error", err => console.error("IMAP-Verbindungsfehler:", err?.message ?? err));
  try {
    await client.connect();
  } catch (error) {
    throw new MailError(describeConnectError(error));
  }
  try {
    return await fn(client);
  } catch (error) {
    if (error instanceof MailError) throw error;
    throw new MailError(`IMAP-Fehler: ${imapErrorText(error)}`);
  } finally {
    await client.logout().catch(() => client.close());
  }
}

/** Öffnet einen Ordner (mit Lock) und führt fn darin aus. */
export async function withMailbox<T>(folder: string, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
  return withClient(async client => {
    let lock;
    try {
      lock = await client.getMailboxLock(folder);
    } catch {
      throw new MailError(`Ordner "${folder}" nicht gefunden. Mit mail_list_folders die genauen Ordnernamen (path) abrufen.`);
    }
    try {
      return await fn(client);
    } finally {
      lock.release();
    }
  });
}

export type SpecialFolder = "sent" | "drafts" | "trash" | "junk" | "archive";

const SPECIAL_USE: Record<SpecialFolder, string> = {
  sent: "\\Sent",
  drafts: "\\Drafts",
  trash: "\\Trash",
  junk: "\\Junk",
  archive: "\\Archive"
};

const NAME_GUESSES: Record<SpecialFolder, string[]> = {
  sent: ["sent", "gesendet", "gesendete objekte", "gesendete elemente", "sent items", "sent messages", "sent mail"],
  drafts: ["drafts", "entwürfe", "entwurf", "draft"],
  trash: ["trash", "papierkorb", "gelöschte elemente", "gelöschte objekte", "deleted items", "deleted messages", "bin"],
  junk: ["junk", "spam", "junk-e-mail", "junk e-mail"],
  archive: ["archive", "archiv", "all mail"]
};

/** Findet Gesendet/Entwürfe/Papierkorb über SPECIAL-USE, Override oder Namensraten. */
export async function findSpecialFolder(client: ImapFlow, kind: SpecialFolder, list?: ListResponse[]): Promise<string | undefined> {
  const override = (config.folders as Record<string, string | undefined>)[kind];
  if (override) return override;
  const folders = list ?? (await client.list());
  const bySpecialUse = folders.find(f => f.specialUse === SPECIAL_USE[kind]);
  if (bySpecialUse) return bySpecialUse.path;
  const guesses = NAME_GUESSES[kind];
  const byName = folders.find(f => guesses.includes(f.name.toLowerCase()));
  return byName?.path;
}

/** Wandelt eine UID-Liste in einen IMAP-Bereich um. */
export function uidRange(uids: number[]): string {
  return [...new Set(uids)].join(",");
}
