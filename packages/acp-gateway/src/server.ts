import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join, extname } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { AdapterRegistry } from "./adapters/registry.js";
import type { GatewayDB } from "./db.js";
import type { RequestFrame, ResponseFrame } from "./protocol.js";
import { RpcDispatcher } from "./rpc.js";
import type { RunController } from "./runtime/RunController.js";
import type { SessionController } from "./runtime/SessionController.js";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".js": "application/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export interface GatewayServerOptions {
  port: number;
  staticDir: string; // path to claw-client build output
  wsPath?: string; // WebSocket path, default "/ws"
}

export interface GatewayRuntime {
  db: GatewayDB;
  registry: AdapterRegistry;
  runs: RunController;
  sessions: SessionController;
  agentCwd?: string;
}

export function createGatewayServer(
  runtime: GatewayRuntime,
  options: GatewayServerOptions,
): ReturnType<typeof createServer> {
  const dispatcher = new RpcDispatcher(
    runtime.db,
    runtime.registry,
    runtime.runs,
    runtime.sessions,
    runtime.agentCwd,
  );
  const wsPath = options.wsPath ?? "/ws";

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Health check
    if (req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, uptime: process.uptime() }));
      return;
    }

    // Serve static files
    serveStatic(res, req.url ?? "/", options.staticDir);
  });

  // WebSocket upgrade handling
  server.on("upgrade", (req, socket, head) => {
    if (req.url !== wsPath) {
      socket.destroy();
      return;
    }

    const wss = new WebSocketServer({ noServer: true });
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      handleWsConnection(ws, dispatcher);
    });
  });

  return server;
}

function serveStatic(res: ServerResponse, url: string, staticDir: string): void {
  // Normalize and prevent directory traversal
  let pathname = url.split("?")[0] ?? "/";
  if (pathname === "/") pathname = "/index.html";

  // Rewrite /plugins/openclawos/* → /* (build uses basePath for OpenClaw plugin)
  const pluginPrefix = "/plugins/openclawos";
  if (pathname.startsWith(pluginPrefix + "/")) {
    pathname = pathname.slice(pluginPrefix.length);
  }

  const filePath = join(staticDir, pathname);
  if (!filePath.startsWith(staticDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  if (!existsSync(filePath)) {
    // SPA fallback: serve index.html for any non-file path
    const indexPath = join(staticDir, "index.html");
    if (existsSync(indexPath)) {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(readFileSync(indexPath, "utf-8"));
      return;
    }
    res.writeHead(404);
    res.end("Not Found");
    return;
  }

  const ext = extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] ?? "application/octet-stream";
  res.writeHead(200, { "Content-Type": contentType });
  res.end(readFileSync(filePath));
}

function handleWsConnection(ws: WebSocket, dispatcher: RpcDispatcher): void {
  console.log("[acp:ws] client connected");

  ws.on("message", async (data: Buffer) => {
    let frame: RequestFrame;
    try {
      frame = JSON.parse(data.toString()) as RequestFrame;
    } catch {
      const err: ResponseFrame = {
        type: "res",
        id: "0",
        ok: false,
        error: "invalid JSON",
      };
      ws.send(JSON.stringify(err));
      return;
    }

    if (frame.type !== "req") {
      const err: ResponseFrame = {
        type: "res",
        id: frame.id ?? "0",
        ok: false,
        error: "expected req frame",
      };
      ws.send(JSON.stringify(err));
      return;
    }

    const response = await dispatcher.dispatch(frame, ws);
    ws.send(JSON.stringify(response));
  });

  ws.on("close", () => {
    console.log("[acp:ws] client disconnected");
  });

  ws.on("error", (err: Error) => {
    console.error("[acp:ws] error:", err.message);
  });
}
