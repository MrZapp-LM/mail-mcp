/**
 * Lesende Tools: Ordner, Nachrichtenlisten, Suche, Nachricht, Anhang.
 */
import type { McpServer } from "@modelcontextprotocol/server";
import type { ImapFlow, SearchObject } from "imapflow";
import { simpleParser } from "mailparser";
import * as z from "zod/v4";
import { CHARACTER_LIMIT } from "../config.js";
import {
  folderField,
  formatAddress,
  formatDate,
  renderPage,
  ResponseFormat,
  responseFormatField,
  summarize,
  textResult,
  type MessageSummary
} from "../format.js";
import { MailError, withClient, withMailbox } from "../imap.js";

const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true } as const;

const SUMMARY_QUERY = { uid: true, envelope: true, flags: true, bodyStructure: true, size: true, internalDate: true } as const;

/** Sucht im geöffneten Ordner, sortiert neueste zuerst und holt eine Seite. */
async function searchPage(
  client: ImapFlow,
  criteria: SearchObject,
  limit: number,
  offset: number
): Promise<{ total: number; messages: MessageSummary[] }> {
  const found = await client.search(criteria, { uid: true });
  const uids = (found || []).sort((a, b) => b - a);
  const pageUids = uids.slice(offset, offset + limit);
  if (pageUids.length === 0) return { total: uids.length, messages: [] };
  const fetched = await client.fetchAll(pageUids.join(","), SUMMARY_QUERY, { uid: true });
  const messages = fetched.map(summarize).sort((a, b) => b.uid - a.uid);
  return { total: uids.length, messages };
}

function pageResult(title: string, folder: string, total: number, offset: number, messages: MessageSummary[], format: ResponseFormat) {
  const { text, page } = renderPage(title, folder, total, offset, messages, format);
  if (format === ResponseFormat.JSON) return { content: [{ type: "text" as const, text }], structuredContent: { ...page } };
  return textResult(text);
}

const paging = {
  limit: z.number().int().min(1).max(100).default(20).describe("Maximale Anzahl Nachrichten (1–100, Standard 20)"),
  offset: z.number().int().min(0).default(0).describe("Anzahl zu überspringender Nachrichten, für die nächste Seite")
};

const dateField = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Format JJJJ-MM-TT")
  .describe("Datum im Format JJJJ-MM-TT, z. B. '2026-11-01'");

/** Lädt eine Nachricht vollständig und parst sie. */
async function loadParsed(client: ImapFlow, uid: number) {
  const msg = await client.fetchOne(String(uid), { uid: true, source: true, flags: true }, { uid: true });
  if (!msg || !msg.source) {
    throw new MailError(`Keine Nachricht mit UID ${uid} in diesem Ordner. UIDs gelten nur pro Ordner; mit mail_list_messages oder mail_search prüfen.`);
  }
  const parsed = await simpleParser(msg.source);
  return { msg, parsed };
}

export function registerReadTools(server: McpServer): void {
  server.registerTool(
    "mail_list_folders",
    {
      title: "Ordner auflisten",
      description: `Listet alle IMAP-Ordner mit Pfad, Sonderfunktion (Gesendet, Entwürfe, Papierkorb, Spam, Archiv) sowie Anzahl gesamt/ungelesen.

Den Wert 'path' als 'folder' in den anderen Tools verwenden. Zuerst aufrufen, wenn der genaue Ordnername unbekannt ist.`,
      inputSchema: z.strictObject({ response_format: responseFormatField }),
      annotations: READ_ONLY
    },
    async ({ response_format }) => {
      const folders = await withClient(client => client.list({ statusQuery: { messages: true, unseen: true } }));
      const items = folders
        .filter(f => !f.flags?.has("\\Noselect"))
        .map(f => ({
          path: f.path,
          name: f.name,
          special_use: f.specialUse ?? null,
          messages: f.status?.messages ?? null,
          unseen: f.status?.unseen ?? null
        }));
      if (response_format === ResponseFormat.JSON) {
        const data = { folders: items };
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
      }
      const lines = ["# Ordner", ""];
      for (const f of items) {
        const special = f.special_use ? ` · ${f.special_use.replace("\\", "")}` : "";
        const counts = f.messages !== null ? ` · ${f.messages} Nachrichten, ${f.unseen ?? 0} ungelesen` : "";
        lines.push(`- \`${f.path}\`${special}${counts}`);
      }
      return textResult(lines.join("\n"));
    }
  );

  server.registerTool(
    "mail_list_messages",
    {
      title: "Nachrichten auflisten",
      description: `Listet die neuesten Nachrichten eines Ordners (neueste zuerst) mit UID, Absender, Betreff, Datum und Status.

Für gezielte Filter (Absender, Betreff, Zeitraum, Volltext) stattdessen mail_search nutzen. Den Inhalt einer Nachricht liefert mail_get_message mit der UID.

Beispiele:
  - "Was ist heute reingekommen?" -> folder="INBOX", limit=20
  - "Zeig nur Ungelesenes" -> unread_only=true`,
      inputSchema: z.strictObject({
        folder: folderField,
        unread_only: z.boolean().default(false).describe("Nur ungelesene Nachrichten"),
        ...paging,
        response_format: responseFormatField
      }),
      annotations: READ_ONLY
    },
    async ({ folder, unread_only, limit, offset, response_format }) => {
      const criteria: SearchObject = unread_only ? { seen: false } : { all: true };
      const { total, messages } = await withMailbox(folder, client => searchPage(client, criteria, limit, offset));
      const title = `# ${unread_only ? "Ungelesene Nachrichten" : "Nachrichten"} in ${folder}`;
      return pageResult(title, folder, total, offset, messages, response_format);
    }
  );

  server.registerTool(
    "mail_search",
    {
      title: "Nachrichten suchen",
      description: `Durchsucht einen Ordner per IMAP-Suche. Alle angegebenen Kriterien müssen zutreffen (UND). Ergebnis: neueste zuerst, mit UIDs.

Die Suche läuft auf dem Mailserver; Teilwörter funktionieren meist, Groß-/Kleinschreibung egal.

Beispiele:
  - "Mails von Amazon im Oktober" -> from="amazon", since="2026-10-01", before="2026-11-01"
  - "Rechnung im Betreff" -> subject="Rechnung"
  - "Irgendwo steht 'Vertragsnummer'" -> text="Vertragsnummer"
  - "Markierte ungelesene Mails" -> flagged=true, unread=true`,
      inputSchema: z.strictObject({
        folder: folderField,
        from: z.string().min(1).optional().describe("Teil von Absendername oder -adresse"),
        to: z.string().min(1).optional().describe("Teil von Empfängername oder -adresse"),
        subject: z.string().min(1).optional().describe("Text im Betreff"),
        body: z.string().min(1).optional().describe("Text im Nachrichtentext"),
        text: z.string().min(1).optional().describe("Text irgendwo in Kopfzeilen oder Inhalt"),
        since: dateField.optional().describe("Empfangen am oder nach diesem Datum (JJJJ-MM-TT)"),
        before: dateField.optional().describe("Empfangen vor diesem Datum (JJJJ-MM-TT)"),
        unread: z.boolean().optional().describe("true = nur ungelesene, false = nur gelesene"),
        flagged: z.boolean().optional().describe("true = nur markierte, false = nur nicht markierte"),
        answered: z.boolean().optional().describe("true = nur beantwortete, false = nur unbeantwortete"),
        ...paging,
        response_format: responseFormatField
      }),
      annotations: READ_ONLY
    },
    async ({ folder, from, to, subject, body, text, since, before, unread, flagged, answered, limit, offset, response_format }) => {
      const criteria: SearchObject = {};
      if (from) criteria.from = from;
      if (to) criteria.to = to;
      if (subject) criteria.subject = subject;
      if (body) criteria.body = body;
      if (text) criteria.text = text;
      if (since) criteria.since = since;
      if (before) criteria.before = before;
      if (unread !== undefined) criteria.seen = !unread;
      if (flagged !== undefined) criteria.flagged = flagged;
      if (answered !== undefined) criteria.answered = answered;
      if (Object.keys(criteria).length === 0) criteria.all = true;

      const { total, messages } = await withMailbox(folder, client => searchPage(client, criteria, limit, offset));
      const described = Object.entries({ from, to, subject, body, text, since, before, unread, flagged, answered })
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join(", ");
      return pageResult(`# Suche in ${folder}${described ? ` (${described})` : ""}`, folder, total, offset, messages, response_format);
    }
  );

  server.registerTool(
    "mail_get_message",
    {
      title: "Nachricht lesen",
      description: `Liest eine Nachricht vollständig: Kopfzeilen, Text und Liste der Anhänge (mit Index für mail_get_attachment).

Markiert die Nachricht NICHT als gelesen (dafür mail_set_flags). HTML-Mails werden als Text geliefert. Lange Texte werden nach max_body_chars gekürzt.`,
      inputSchema: z.strictObject({
        folder: folderField,
        uid: z.number().int().positive().describe("UID der Nachricht im Ordner"),
        max_body_chars: z.number().int().min(500).max(CHARACTER_LIMIT).default(15_000).describe("Maximale Länge des Nachrichtentexts"),
        include_html: z.boolean().default(false).describe("Zusätzlich den rohen HTML-Teil liefern (selten nötig)"),
        response_format: responseFormatField
      }),
      annotations: READ_ONLY
    },
    async ({ folder, uid, max_body_chars, include_html, response_format }) => {
      const { msg, parsed } = await withMailbox(folder, client => loadParsed(client, uid));
      const addr = (v: typeof parsed.to): string[] =>
        (Array.isArray(v) ? v : v ? [v] : []).flatMap(a => a.value.map(x => formatAddress({ name: x.name, address: x.address })));

      let bodyText = parsed.text ?? "";
      const truncated = bodyText.length > max_body_chars;
      if (truncated) bodyText = bodyText.slice(0, max_body_chars);

      const attachments = parsed.attachments.map((a, index) => ({
        index,
        filename: a.filename ?? `anhang-${index}`,
        content_type: a.contentType,
        size: a.size,
        inline: a.contentDisposition === "inline"
      }));
      const flags = msg.flags ?? new Set<string>();
      const data = {
        folder,
        uid,
        message_id: parsed.messageId ?? null,
        date: parsed.date ? parsed.date.toISOString() : null,
        from: addr(parsed.from),
        to: addr(parsed.to),
        cc: addr(parsed.cc),
        reply_to: addr(parsed.replyTo),
        subject: parsed.subject ?? "(kein Betreff)",
        seen: flags.has("\\Seen"),
        flagged: flags.has("\\Flagged"),
        body: bodyText,
        body_truncated: truncated,
        attachments,
        ...(include_html && typeof parsed.html === "string" ? { html: parsed.html.slice(0, max_body_chars) } : {})
      };

      if (response_format === ResponseFormat.JSON) {
        return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }], structuredContent: data };
      }
      const lines = [
        `# ${data.subject}`,
        `- Von: ${data.from.join(", ")}`,
        `- An: ${data.to.join(", ")}`,
        ...(data.cc.length ? [`- Cc: ${data.cc.join(", ")}`] : []),
        ...(data.reply_to.length ? [`- Antwort an: ${data.reply_to.join(", ")}`] : []),
        `- Datum: ${formatDate(data.date)}`,
        `- Ordner/UID: ${folder} / ${uid}`,
        ""
      ];
      if (attachments.length) {
        lines.push("## Anhänge", ...attachments.map(a => `- [${a.index}] ${a.filename} (${a.content_type}, ${Math.round(a.size / 1024)} KB)`), "");
      }
      lines.push("## Inhalt", "", bodyText || "(kein Textinhalt)");
      if (truncated) lines.push("", `… gekürzt nach ${max_body_chars} Zeichen. Für mehr max_body_chars erhöhen.`);
      if (data.html) lines.push("", "## HTML", "", data.html);
      return textResult(lines.join("\n"));
    }
  );

  server.registerTool(
    "mail_get_attachment",
    {
      title: "Anhang abrufen",
      description: `Liefert den Inhalt eines Anhangs. Textdateien (txt, csv, json, xml, html, ics …) kommen als Text, Bilder als Bild, alles andere (z. B. PDF) als eingebettete Datei (Base64).

Den Index liefert mail_get_message in der Anhangsliste.`,
      inputSchema: z.strictObject({
        folder: folderField,
        uid: z.number().int().positive().describe("UID der Nachricht im Ordner"),
        index: z.number().int().min(0).describe("Index des Anhangs aus mail_get_message")
      }),
      annotations: READ_ONLY
    },
    async ({ folder, uid, index }) => {
      const { parsed } = await withMailbox(folder, client => loadParsed(client, uid));
      const att = parsed.attachments[index];
      if (!att) {
        throw new MailError(`Anhang ${index} gibt es nicht; die Nachricht hat ${parsed.attachments.length} Anhänge (Index ab 0).`);
      }
      const filename = att.filename ?? `anhang-${index}`;
      const type = att.contentType.toLowerCase();
      const isText =
        type.startsWith("text/") || ["application/json", "application/xml", "application/ics", "application/csv"].includes(type) || type.endsWith("+xml");
      if (isText) {
        let text = att.content.toString("utf8");
        const cut = text.length > CHARACTER_LIMIT;
        if (cut) text = text.slice(0, CHARACTER_LIMIT);
        return textResult(`# ${filename} (${type})\n\n${text}${cut ? `\n\n… gekürzt nach ${CHARACTER_LIMIT} Zeichen.` : ""}`);
      }
      const MAX_BINARY = 8 * 1024 * 1024;
      if (att.size > MAX_BINARY) {
        throw new MailError(`Anhang "${filename}" ist ${Math.round(att.size / 1024 / 1024)} MB groß; maximal 8 MB können übertragen werden.`);
      }
      const data = att.content.toString("base64");
      if (type.startsWith("image/")) {
        return {
          content: [
            { type: "text", text: `${filename} (${type}, ${Math.round(att.size / 1024)} KB)` },
            { type: "image", data, mimeType: type }
          ]
        };
      }
      return {
        content: [
          { type: "text", text: `${filename} (${type}, ${Math.round(att.size / 1024)} KB)` },
          { type: "resource", resource: { uri: `mail://${encodeURIComponent(folder)}/${uid}/attachments/${index}/${encodeURIComponent(filename)}`, mimeType: type, blob: data } }
        ]
      };
    }
  );
}
