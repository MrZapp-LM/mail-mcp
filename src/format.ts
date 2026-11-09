/**
 * Gemeinsame Typen, Schemas und Formatierung für Tool-Antworten.
 */
import type { FetchMessageObject, MessageAddressObject, MessageStructureObject } from "imapflow";
import * as z from "zod/v4";
import { CHARACTER_LIMIT } from "./config.js";

export enum ResponseFormat {
  MARKDOWN = "markdown",
  JSON = "json"
}

export const responseFormatField = z
  .enum(ResponseFormat)
  .default(ResponseFormat.MARKDOWN)
  .describe("'markdown' für lesbaren Text (Standard), 'json' für strukturierte Daten");

export const folderField = z
  .string()
  .min(1)
  .default("INBOX")
  .describe("Ordnerpfad wie von mail_list_folders geliefert, z. B. 'INBOX' oder 'INBOX/Rechnungen'. Standard: INBOX");

export const uidsField = z
  .array(z.number().int().positive())
  .min(1)
  .max(500)
  .describe("UIDs der Nachrichten im angegebenen Ordner (aus mail_list_messages oder mail_search)");

export interface MessageSummary {
  uid: number;
  date: string | null;
  from: string;
  to: string[];
  subject: string;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  has_attachments: boolean;
  size: number;
  message_id: string | null;
}

export function formatAddress(address: MessageAddressObject | undefined): string {
  if (!address) return "";
  if (address.name && address.address) return `${address.name} <${address.address}>`;
  return address.address ?? address.name ?? "";
}

function hasAttachments(node: MessageStructureObject | undefined): boolean {
  if (!node) return false;
  if (node.disposition === "attachment") return true;
  if (node.disposition === "inline" && node.dispositionParameters?.filename) return true;
  return (node.childNodes ?? []).some(hasAttachments);
}

function toIso(date: Date | string | undefined): string | null {
  if (!date) return null;
  const d = date instanceof Date ? date : new Date(date);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export function summarize(msg: FetchMessageObject): MessageSummary {
  const flags = msg.flags ?? new Set<string>();
  return {
    uid: msg.uid,
    date: toIso(msg.envelope?.date ?? msg.internalDate),
    from: (msg.envelope?.from ?? []).map(formatAddress).join(", "),
    to: (msg.envelope?.to ?? []).map(formatAddress),
    subject: msg.envelope?.subject ?? "(kein Betreff)",
    seen: flags.has("\\Seen"),
    flagged: flags.has("\\Flagged"),
    answered: flags.has("\\Answered"),
    has_attachments: hasAttachments(msg.bodyStructure),
    size: msg.size ?? 0,
    message_id: msg.envelope?.messageId ?? null
  };
}

export function formatDate(iso: string | null): string {
  if (!iso) return "unbekannt";
  return new Date(iso).toLocaleString("de-DE", { timeZone: process.env.TZ || "Europe/Berlin" });
}

export function summaryLine(m: MessageSummary): string {
  const marks = [m.seen ? "" : "🔵 ungelesen", m.flagged ? "⭐ markiert" : "", m.answered ? "↩ beantwortet" : "", m.has_attachments ? "📎" : ""]
    .filter(Boolean)
    .join(" ");
  return `- **${m.subject}** (UID ${m.uid})\n  Von: ${m.from} · ${formatDate(m.date)}${marks ? ` · ${marks}` : ""}`;
}

export interface Page {
  folder: string;
  total: number;
  count: number;
  offset: number;
  messages: MessageSummary[];
  has_more: boolean;
  next_offset?: number;
}

/**
 * Baut eine Seite und kürzt sie (weniger Nachrichten, nie abgeschnittener Text),
 * bis sie unter CHARACTER_LIMIT bleibt.
 */
export function renderPage(
  title: string,
  folder: string,
  total: number,
  offset: number,
  messages: MessageSummary[],
  format: ResponseFormat
): { text: string; page: Page } {
  const render = (items: MessageSummary[]) => {
    const nextOffset = offset + items.length;
    const hasMore = total > nextOffset;
    const page: Page = {
      folder,
      total,
      count: items.length,
      offset,
      messages: items,
      has_more: hasMore,
      ...(hasMore ? { next_offset: nextOffset } : {})
    };
    if (format === ResponseFormat.JSON) return { page, text: JSON.stringify(page, null, 2) };
    if (items.length === 0) return { page, text: `${title}\n\nKeine Nachrichten gefunden.` };
    const lines = [title, `${items.length} von ${total} (ab Position ${offset}), neueste zuerst.`, "", items.map(summaryLine).join("\n")];
    if (hasMore) lines.push("", `Weitere Nachrichten: erneut mit offset=${nextOffset} aufrufen.`);
    return { page, text: lines.join("\n") };
  };
  let items = messages;
  let result = render(items);
  while (items.length > 1 && result.text.length > CHARACTER_LIMIT) {
    items = items.slice(0, Math.ceil(items.length / 2));
    result = render(items);
  }
  return result;
}

export function textResult(text: string) {
  return { content: [{ type: "text" as const, text }] };
}
