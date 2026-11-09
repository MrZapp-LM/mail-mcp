/**
 * Selbsttest gegen einen echten IMAP/SMTP-Server (z. B. GreenMail aus docker-compose.test.yml).
 * Startet den gebauten Server per HTTP, ruft alle Tools auf und endet mit Fehlercode bei Problemen.
 *
 *   docker compose -f docker-compose.test.yml up -d
 *   npm run build && npm run smoke
 */
import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/client";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import nodemailer from "nodemailer";

const TOKEN = "smoke-test-token-0123456789abcdef";
const PORT = 3999;
const env = {
  ...process.env,
  IMAP_HOST: process.env.IMAP_HOST ?? "127.0.0.1",
  IMAP_PORT: process.env.IMAP_PORT ?? "3143",
  IMAP_SECURE: "false",
  IMAP_USER: process.env.IMAP_USER ?? "paul",
  IMAP_PASSWORD: process.env.IMAP_PASSWORD ?? "secret",
  SMTP_HOST: process.env.SMTP_HOST ?? "127.0.0.1",
  SMTP_PORT: process.env.SMTP_PORT ?? "3025",
  SMTP_SECURE: "false",
  MAIL_FROM: "Paul <paul@test.local>",
  MCP_AUTH_TOKEN: TOKEN,
  PORT: String(PORT),
  HOST: "127.0.0.1"
};

// Testmails einliefern
const smtp = nodemailer.createTransport({ host: env.SMTP_HOST, port: Number(env.SMTP_PORT), secure: false, auth: { user: "paul", pass: "secret" } });
const stamp = Date.now();
await smtp.sendMail({
  from: "Amazon <versand@amazon.de>",
  to: "paul@test.local",
  subject: `Ihre Rechnung ${stamp}`,
  text: "Hallo Paul,\nanbei die Rechnung. Vertragsnummer 4711.\nGrüße",
  attachments: [{ filename: "rechnung.csv", content: "posten;betrag\nKabel;9,99\n" }]
});
await smtp.sendMail({ from: "Oma <oma@test.local>", to: "paul@test.local", subject: `Sonntag Kaffee ${stamp}`, text: "Kommst du Sonntag?" });
await sleep(500);

const server = spawn("node", ["dist/index.js"], { env, stdio: ["ignore", "inherit", "inherit"] });
let failed = false;
try {
  await sleep(1500);

  // Ohne Token muss abgelehnt werden
  const unauth = await fetch(`http://127.0.0.1:${PORT}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  assert.equal(unauth.status, 401, "ohne Token muss 401 kommen");
  const health = await fetch(`http://127.0.0.1:${PORT}/health?imap=1`);
  assert.equal(health.status, 200, "Healthcheck mit IMAP muss ok sein");

  // Token im Pfad
  const client = new Client({ name: "smoke", version: "1.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${PORT}/mcp/${TOKEN}`)));

  const call = async (name: string, args: Record<string, unknown>) => {
    const r = await client.callTool({ name, arguments: args });
    assert.ok(!r.isError, `${name} fehlgeschlagen: ${JSON.stringify(r.content)}`);
    return r;
  };

  const { tools } = await client.listTools();
  console.error("Tools:", tools.map(t => t.name).join(", "));
  assert.ok(tools.some(t => t.name === "mail_send_email"));

  for (const f of ["Sent", "Drafts", "Trash", "Archiv"]) await call("mail_create_folder", { path: f });
  const folders = await call("mail_list_folders", { response_format: "json" });
  console.error((folders.content as { text: string }[])[0].text);

  const list = await call("mail_list_messages", { folder: "INBOX", limit: 10, response_format: "json" });
  const page = list.structuredContent as { messages: { uid: number; subject: string; seen: boolean; has_attachments: boolean }[] };
  assert.ok(page.messages.length >= 2);
  console.error((await call("mail_list_messages", { limit: 5 })).content);

  const search = await call("mail_search", { from: "versand@amazon.de", subject: String(stamp), response_format: "json" });
  const hits = (search.structuredContent as typeof page).messages;
  assert.equal(hits.length, 1, "genau ein Treffer für Amazon");
  const uid = hits[0].uid;
  assert.ok(hits[0].has_attachments, "Anhang erkannt");

  const msg = await call("mail_get_message", { uid, response_format: "json" });
  const m = msg.structuredContent as { body: string; attachments: { filename: string }[]; seen: boolean };
  assert.match(m.body, /Vertragsnummer 4711/);
  assert.equal(m.attachments[0].filename, "rechnung.csv");
  assert.equal(m.seen, false, "Lesen darf nicht als gelesen markieren");
  console.error((await call("mail_get_message", { uid })).content);

  const att = await call("mail_get_attachment", { uid, index: 0 });
  assert.match((att.content as { text: string }[])[0].text, /Kabel;9,99/);

  await call("mail_set_flags", { uids: [uid], seen: true, flagged: true });
  const unread = await call("mail_search", { subject: String(stamp), unread: true, response_format: "json" });
  assert.equal((unread.structuredContent as typeof page).messages.length, 1, "nur noch eine ungelesen");

  // Antwort als Entwurf, dann echt senden
  const oma = (await call("mail_search", { from: "oma@test.local", subject: String(stamp), response_format: "json" })).structuredContent as typeof page;
  const omaUid = oma.messages[0].uid;
  console.error((await call("mail_save_draft", { reply_to_uid: omaUid, body: "Ja, gerne!" })).content);
  console.error((await call("mail_send_email", { reply_to_uid: omaUid, body: "Ja, ich komme!" })).content);
  const sent = await call("mail_search", { folder: "Sent", subject: `Re: Sonntag Kaffee ${stamp}`, response_format: "json" });
  assert.equal((sent.structuredContent as typeof page).messages.length, 1, "Kopie im Gesendet-Ordner");
  const answered = await call("mail_search", { subject: `Sonntag Kaffee ${stamp}`, answered: true, response_format: "json" });
  assert.ok((answered.structuredContent as typeof page).messages.some(x => x.uid === omaUid), "Original als beantwortet markiert");

  await call("mail_move_messages", { uids: [uid], destination: "Archiv" });
  const archived = await call("mail_search", { folder: "Archiv", subject: String(stamp), response_format: "json" });
  const archUid = (archived.structuredContent as typeof page).messages[0].uid;
  await call("mail_delete_messages", { folder: "Archiv", uids: [archUid] });
  const trash = await call("mail_search", { folder: "Trash", subject: String(stamp), response_format: "json" });
  assert.equal((trash.structuredContent as typeof page).messages.length, 1, "im Papierkorb");

  // Fehlerfälle müssen lesbare Tool-Fehler liefern
  const bad = await client.callTool({ name: "mail_list_messages", arguments: { folder: "GibtEsNicht" } });
  assert.equal(bad.isError, true);
  console.error("Erwarteter Fehler:", JSON.stringify(bad.content));
  const badUid = await client.callTool({ name: "mail_get_message", arguments: { uid: 999999 } });
  assert.equal(badUid.isError, true);

  await client.close();
  console.error("\nSmoke-Test bestanden ✅");
} catch (error) {
  failed = true;
  console.error("Smoke-Test fehlgeschlagen ❌", error);
} finally {
  server.kill();
}
process.exit(failed ? 1 : 0);
