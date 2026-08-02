// Test script for the ACP gateway
// Usage: pkill -f "tsx.*index"; sleep 1; cd packages/acp-gateway && node scripts/test-gw.cjs
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");
const fs = require("fs");

// Resolve ws from gateway node_modules
const wsPath = require.resolve("ws");
// The gateway is started separately

// Start gateway
const gatewayDir = path.resolve(__dirname, "..");
const proc = spawn("npx", ["tsx", "src/index.ts"], {
  cwd: gatewayDir,
  stdio: "pipe",
  env: { ...process.env },
});
let gwLog = "";
proc.stdout.on("data", (d) => (gwLog += d));
proc.stderr.on("data", (d) => (gwLog += d));

setTimeout(() => {
  // Health check
  http
    .get("http://localhost:18791/health", (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => {
        console.log("HEALTH:", data);

        // WebSocket test
        const WebSocket = require(wsPath);
        const ws = new WebSocket("ws://localhost:18791/ws");
        const events = [];
        let done = false;

        ws.on("open", () => {
          ws.send(
            JSON.stringify({
              type: "req",
              id: "1",
              method: "chat.send",
              params: { agentId: "codex", message: "say hello" },
            }),
          );
        });

        ws.on("message", (raw) => {
          const f = JSON.parse(raw);
          if (f.type === "res") {
            console.log("RPC:", f.ok ? "OK" : "FAIL");
          } else {
            const label = `${f.event}:${f.payload?.stream || f.payload?.state || "?"}`;
            events.push(label);
            if (f.payload?.data?.text) console.log("TEXT:", f.payload.data.text.slice(0, 80));
            if (f.payload?.state === "final" && !done) {
              done = true;
              console.log("EVENTS:", events);
              console.log("TOTAL:", events.length);
              ws.close();
              proc.kill();
              process.exit(0);
            }
          }
        });
      });
    })
    .on("error", (e) => {
      console.log("HTTP FAIL:", e.message);
      console.log("GW LOG:", gwLog.slice(0, 500));
      proc.kill();
      process.exit(1);
    });
}, 4000);

setTimeout(() => {
  console.log("TIMEOUT");
  console.log("GW LOG:", gwLog.slice(0, 1000));
  proc.kill();
  process.exit(1);
}, 40000);
