#!/usr/bin/env node
/**
 * IMAP-MCP-Server.
 * Standard: Streamable HTTP (für Docker/TrueNAS). TRANSPORT=stdio für lokalen Betrieb.
 */
import { timingSafeEqual } from "node:crypto";
import { createMcpExpressApp } from "@modelcontextprotocol/express";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import type { NextFunction, Request, Response } from "express";
import { config } from "./config.js";
import { withClient } from "./imap.js";
import { registerReadTools } from "./tools/read.js";
import { registerWriteTools } from "./tools/write.js";

const VERSION = "1.0.0";

function createServer(): McpServer {
  const server = new McpServer(
    { name: "imap-mcp-server", version: VERSION },
    {
      instructions:
        "Zugriff auf ein IMAP-Postfach. UIDs gelten nur innerhalb eines Ordners: immer den Ordner mitgeben, aus dem die UID stammt. " +
        "Ordnernamen mit mail_list_folders ermitteln. Vor mail_send_email Empfänger und Text mit dem Nutzer abstimmen; im Zweifel mail_save_draft nutzen."
    }
  );
  registerReadTools(server);
  if (!config.readOnly) registerWriteTools(server);
  return server;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

if (config.http.transport === "stdio") {
  serveStdio(createServer);
  console.error("imap-mcp-server läuft über stdio");
} else {
  const token = config.http.authToken;
  if (!token && !config.http.allowNoAuth) {
    console.error("MCP_AUTH_TOKEN fehlt. Einen langen Zufallswert setzen (z. B. `openssl rand -hex 32`) oder ALLOW_NO_AUTH=true (nur im abgeschotteten LAN).");
    process.exit(1);
  }
  if (token && token.length < 24) {
    console.error("MCP_AUTH_TOKEN ist zu kurz (mindestens 24 Zeichen).");
    process.exit(1);
  }

  const handler = createMcpHandler(createServer, {
    onerror: error => console.error("MCP-Fehler:", error)
  });
  const app = createMcpExpressApp({
    host: config.http.host,
    ...(config.http.allowedHosts.length ? { allowedHosts: config.http.allowedHosts } : {})
  });
  app.set("trust proxy", true);
  const nodeHandler = toNodeHandler(handler);

  // Token entweder als "Authorization: Bearer <token>" oder im Pfad /mcp/<token>
  // (Letzteres für Clients wie claude.ai, die keine eigenen Header erlauben).
  const requireToken = (req: Request, res: Response, next: NextFunction) => {
    if (!token) return next();
    const header = req.headers.authorization ?? "";
    const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    const pathToken = typeof req.params.token === "string" ? req.params.token : "";
    if ((bearer && safeEqual(bearer, token)) || (pathToken && safeEqual(pathToken, token))) return next();
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Unauthorized" }, id: null });
  };

  app.all("/mcp", requireToken, (req, res) => void nodeHandler(req, res, req.body));
  app.all("/mcp/:token", requireToken, (req, res) => void nodeHandler(req, res, req.body));

  // Healthcheck für Docker: ?imap=1 prüft zusätzlich die IMAP-Anmeldung
  app.get("/health", async (req, res) => {
    if (req.query.imap === undefined) {
      res.json({ status: "ok", version: VERSION });
      return;
    }
    try {
      await withClient(async () => undefined);
      res.json({ status: "ok", version: VERSION, imap: "ok" });
    } catch (error) {
      res.status(503).json({ status: "error", imap: (error as Error).message });
    }
  });

  app.listen(config.http.port, config.http.host, () => {
    console.error(
      `imap-mcp-server ${VERSION} hört auf http://${config.http.host}:${config.http.port}/mcp ` +
        `(IMAP ${config.imap.user}@${config.imap.host}, SMTP ${config.smtp ? "an" : "aus"}, ${config.readOnly ? "nur lesen" : "lesen+schreiben"})`
    );
  });
}
