/**
 * Ändernde Tools: Flags setzen, verschieben, löschen, Ordner anlegen, Entwürfe, Senden.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import type { ImapFlow } from "imapflow";
import nodemailer from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import * as z from "zod/v4";
import { config } from "../config.js";
import { folderField, textResult, uidsField } from "../format.js";
import { findSpecialFolder, imapErrorText, MailError, uidRange, withClient, withMailbox } from "../imap.js";

// ---- Flags, Verschieben, Löschen, Ordner ----

export function registerWriteTools(server: McpServer): void {
  server.registerTool(
    "mail_set_flags",
    {
      title: "Status setzen",
      description: `Setzt oder entfernt den Status von Nachrichten: gelesen, markiert (Stern/Fahne), beantwortet.

Nur die angegebenen Felder werden geändert. Beispiel: "Markiere UID 42 und 43 als gelesen" -> uids=[42,43], seen=true`,
      inputSchema: z.strictObject({
        folder: folderField,
        uids: uidsField,
        seen: z.boolean().optional().describe("true = gelesen, false = ungelesen"),
        flagged: z.boolean().optional().describe("true = markieren, false = Markierung entfernen"),
        answered: z.boolean().optional().describe("true = als beantwortet kennzeichnen, false = entfernen")
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ folder, uids, seen, flagged, answered }) => {
      const changes: Array<[string, boolean | undefined]> = [
        ["\\Seen", seen],
        ["\\Flagged", flagged],
        ["\\Answered", answered]
      ];
      const add = changes.filter(([, v]) => v === true).map(([f]) => f);
      const remove = changes.filter(([, v]) => v === false).map(([f]) => f);
      if (add.length === 0 && remove.length === 0) {
        throw new MailError("Nichts zu ändern: mindestens eines von seen, flagged oder answered angeben.");
      }
      await withMailbox(folder, async client => {
        const range = uidRange(uids);
        if (add.length) await client.messageFlagsAdd(range, add, { uid: true });
        if (remove.length) await client.messageFlagsRemove(range, remove, { uid: true });
      });
      const parts = [...add.map(f => `+${f}`), ...remove.map(f => `-${f}`)].join(" ");
      return textResult(`${uids.length} Nachricht(en) in ${folder} geändert: ${parts}`);
    }
  );

  server.registerTool(
    "mail_move_messages",
    {
      title: "Nachrichten verschieben",
      description: `Verschiebt Nachrichten in einen anderen Ordner (z. B. Archiv, Unterordner, Spam).

Die UIDs ändern sich dabei; im Zielordner neu suchen. Ordnernamen liefert mail_list_folders, neue Ordner legt mail_create_folder an.`,
      inputSchema: z.strictObject({
        folder: folderField.describe("Quellordner"),
        uids: uidsField,
        destination: z.string().min(1).describe("Zielordner (path aus mail_list_folders)")
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    async ({ folder, uids, destination }) => {
      const result = await withMailbox(folder, client => client.messageMove(uidRange(uids), destination, { uid: true }));
      if (!result) {
        throw new MailError(`Verschieben nach "${destination}" fehlgeschlagen. Existiert der Ordner? Mit mail_list_folders prüfen.`);
      }
      const moved = result.uidMap ? result.uidMap.size : uids.length;
      return textResult(`${moved} Nachricht(en) von ${folder} nach ${destination} verschoben.`);
    }
  );

  server.registerTool(
    "mail_delete_messages",
    {
      title: "Nachrichten löschen",
      description: `Löscht Nachrichten. Standard: in den Papierkorb verschieben (wiederherstellbar).

permanent=true löscht endgültig (nicht wiederherstellbar). Nachrichten, die schon im Papierkorb liegen, werden immer endgültig gelöscht.`,
      inputSchema: z.strictObject({
        folder: folderField,
        uids: uidsField,
        permanent: z.boolean().default(false).describe("true = endgültig löschen statt Papierkorb")
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
    },
    async ({ folder, uids, permanent }) => {
      const message = await withClient(async client => {
        const trash = await findSpecialFolder(client, "trash");
        const lock = await client.getMailboxLock(folder).catch(() => {
          throw new MailError(`Ordner "${folder}" nicht gefunden. Mit mail_list_folders prüfen.`);
        });
        try {
          const range = uidRange(uids);
          if (!permanent && trash && trash !== folder) {
            const moved = await client.messageMove(range, trash, { uid: true });
            if (!moved) throw new MailError(`Verschieben in den Papierkorb (${trash}) fehlgeschlagen.`);
            return `${uids.length} Nachricht(en) in den Papierkorb (${trash}) verschoben.`;
          }
          if (!permanent && !trash) {
            throw new MailError("Kein Papierkorb-Ordner gefunden. FOLDER_TRASH setzen oder permanent=true verwenden.");
          }
          await client.messageDelete(range, { uid: true });
          return `${uids.length} Nachricht(en) in ${folder} endgültig gelöscht.`;
        } finally {
          lock.release();
        }
      });
      return textResult(message);
    }
  );

  server.registerTool(
    "mail_create_folder",
    {
      title: "Ordner anlegen",
      description: `Legt einen neuen Ordner an. Unterordner mit dem Trennzeichen des Servers angeben (meist '/' oder '.'; siehe Pfade in mail_list_folders), z. B. 'INBOX/Rechnungen'.`,
      inputSchema: z.strictObject({
        path: z.string().min(1).max(200).describe("Vollständiger Pfad des neuen Ordners")
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async ({ path }) => {
      const message = await withClient(async client => {
        const existing = await client.list();
        if (existing.some(f => f.path === path)) return `Ordner "${path}" existiert bereits.`;
        try {
          const result = await client.mailboxCreate(path);
          return `Ordner "${result.path}" angelegt.`;
        } catch (error) {
          throw new MailError(`Ordner "${path}" konnte nicht angelegt werden: ${imapErrorText(error)}`);
        }
      });
      return textResult(message);
    }
  );

  registerComposeTools(server);
}

// ---- Entwürfe und Versand ----

const composeShape = {
  to: z.array(z.string().min(3)).max(50).optional().describe("Empfänger, z. B. ['Max <max@example.com>']. Bei Antworten optional (dann an den Absender)"),
  cc: z.array(z.string().min(3)).max(50).optional().describe("Cc-Empfänger"),
  bcc: z.array(z.string().min(3)).max(50).optional().describe("Bcc-Empfänger"),
  subject: z.string().max(500).optional().describe("Betreff. Bei Antworten optional (dann 'Re: …')"),
  body: z.string().min(1).max(200_000).describe("Nachrichtentext als Klartext"),
  html: z.string().max(500_000).optional().describe("Optionale HTML-Version des Texts"),
  reply_to_uid: z.number().int().positive().optional().describe("UID der Nachricht, auf die geantwortet wird (setzt Threading-Header)"),
  reply_folder: z.string().min(1).default("INBOX").describe("Ordner der Nachricht aus reply_to_uid"),
  reply_all: z.boolean().default(false).describe("Bei Antwort alle ursprünglichen Empfänger in Cc übernehmen")
};

type ComposeInput = {
  to?: string[];
  cc?: string[];
  bcc?: string[];
  subject?: string;
  body: string;
  html?: string;
  reply_to_uid?: number;
  reply_folder: string;
  reply_all: boolean;
};

interface ReplyContext {
  to: string[];
  cc: string[];
  subject: string;
  inReplyTo?: string;
  references?: string[];
}

function ownAddress(): string {
  const match = /<([^>]+)>/.exec(config.from);
  return (match ? match[1] : config.from).toLowerCase();
}

async function loadReplyContext(client: ImapFlow, folder: string, uid: number, replyAll: boolean): Promise<ReplyContext> {
  const lock = await client.getMailboxLock(folder).catch(() => {
    throw new MailError(`Ordner "${folder}" nicht gefunden.`);
  });
  try {
    const msg = await client.fetchOne(String(uid), { uid: true, envelope: true, headers: ["references"] }, { uid: true });
    if (!msg || !msg.envelope) throw new MailError(`Nachricht UID ${uid} in ${folder} nicht gefunden.`);
    const env = msg.envelope;
    const fmt = (a: { name?: string; address?: string }) => (a.name ? `${a.name} <${a.address}>` : (a.address ?? ""));
    const replyTarget = env.replyTo?.length ? env.replyTo : (env.from ?? []);
    const me = ownAddress();
    const cc = replyAll
      ? [...(env.to ?? []), ...(env.cc ?? [])].filter(a => a.address && a.address.toLowerCase() !== me).map(fmt)
      : [];
    const refHeader = msg.headers?.toString("utf8").replace(/^references:\s*/i, "").replace(/\r?\n\s+/g, " ").trim();
    const references = [...(refHeader ? refHeader.split(/\s+/).filter(Boolean) : []), ...(env.messageId ? [env.messageId] : [])];
    const subject = env.subject ?? "";
    return {
      to: replyTarget.map(fmt),
      cc,
      subject: /^(re|aw|antw):/i.test(subject) ? subject : `Re: ${subject}`,
      inReplyTo: env.messageId,
      references
    };
  } finally {
    lock.release();
  }
}

async function buildMessage(client: ImapFlow, input: ComposeInput) {
  const reply = input.reply_to_uid ? await loadReplyContext(client, input.reply_folder, input.reply_to_uid, input.reply_all) : undefined;
  const to = input.to?.length ? input.to : (reply?.to ?? []);
  const cc = [...(input.cc ?? []), ...(reply?.cc ?? [])];
  const subject = input.subject ?? reply?.subject;
  if (to.length === 0) throw new MailError("Kein Empfänger: 'to' angeben (oder reply_to_uid für eine Antwort).");
  if (!subject) throw new MailError("Kein Betreff: 'subject' angeben.");
  const options = {
    from: config.from,
    to,
    cc: cc.length ? cc : undefined,
    bcc: input.bcc?.length ? input.bcc : undefined,
    subject,
    text: input.body,
    html: input.html,
    inReplyTo: reply?.inReplyTo,
    references: reply?.references?.length ? reply.references : undefined
  };
  const raw = await new MailComposer(options).compile().build();
  return { options, raw, reply };
}

function registerComposeTools(server: McpServer): void {
  server.registerTool(
    "mail_save_draft",
    {
      title: "Entwurf speichern",
      description: `Speichert eine E-Mail als Entwurf im Entwürfe-Ordner, ohne sie zu senden. Sicherer Weg, damit der Nutzer vor dem Versand im Mailprogramm prüft.

Für Antworten reply_to_uid (und reply_folder) angeben: Empfänger, 'Re:'-Betreff und Threading werden automatisch gesetzt.`,
      inputSchema: z.strictObject(composeShape),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    async input => {
      const result = await withClient(async client => {
        const drafts = await findSpecialFolder(client, "drafts");
        if (!drafts) throw new MailError("Kein Entwürfe-Ordner gefunden. FOLDER_DRAFTS setzen.");
        const { options, raw } = await buildMessage(client, input);
        const appended = await client.append(drafts, raw, ["\\Draft", "\\Seen"]);
        return { drafts, options, uid: appended ? appended.uid : undefined };
      });
      return textResult(
        `Entwurf "${result.options.subject}" an ${result.options.to.join(", ")} in ${result.drafts} gespeichert${result.uid ? ` (UID ${result.uid})` : ""}.`
      );
    }
  );

  if (!config.smtp) return;
  const smtp = config.smtp;
  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: { user: smtp.user, pass: smtp.password },
    tls: { rejectUnauthorized: smtp.rejectUnauthorized }
  });

  server.registerTool(
    "mail_send_email",
    {
      title: "E-Mail senden",
      description: `Sendet eine E-Mail sofort per SMTP. Nicht rückgängig zu machen: im Zweifel vorher mit dem Nutzer Empfänger, Betreff und Text abstimmen oder mail_save_draft verwenden.

Für Antworten reply_to_uid (und reply_folder) angeben: Empfänger, 'Re:'-Betreff und Threading werden automatisch gesetzt und das Original als beantwortet markiert. Eine Kopie landet im Gesendet-Ordner.`,
      inputSchema: z.strictObject(composeShape),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    async input => {
      const notes: string[] = [];
      const sent = await withClient(async client => {
        const { options, raw, reply } = await buildMessage(client, input);
        let info;
        try {
          // Bcc steht nicht in den Kopfzeilen der Rohnachricht, daher den SMTP-Umschlag explizit setzen
          const envelope = { from: options.from, to: [...options.to, ...(options.cc ?? []), ...(options.bcc ?? [])] };
          info = await transporter.sendMail({ envelope, raw });
        } catch (error) {
          const e = error as { code?: string; message?: string };
          if (e.code === "EAUTH") throw new MailError("SMTP-Anmeldung fehlgeschlagen. SMTP_USER/SMTP_PASSWORD prüfen.");
          throw new MailError(`Senden fehlgeschlagen: ${e.message ?? String(error)}`);
        }
        if (config.saveSent) {
          const sentFolder = await findSpecialFolder(client, "sent");
          if (sentFolder) {
            await client.append(sentFolder, raw, ["\\Seen"]).catch(() => notes.push("Kopie im Gesendet-Ordner konnte nicht gespeichert werden."));
          } else {
            notes.push("Kein Gesendet-Ordner gefunden (FOLDER_SENT setzen), keine Kopie gespeichert.");
          }
        }
        if (reply && input.reply_to_uid) {
          const lock = await client.getMailboxLock(input.reply_folder);
          try {
            await client.messageFlagsAdd(String(input.reply_to_uid), ["\\Answered"], { uid: true });
          } finally {
            lock.release();
          }
        }
        return { options, info };
      });
      const recipients = [...sent.options.to, ...(sent.options.cc ?? []), ...(sent.options.bcc ?? [])];
      return textResult(
        [`E-Mail "${sent.options.subject}" an ${recipients.join(", ")} gesendet.`, `Message-ID: ${sent.info.messageId ?? "unbekannt"}`, ...notes].join("\n")
      );
    }
  );
}
