// Reproduces the "stuck at running" bug: two chat.send calls on the SAME session,
// mirroring what AcpEngine.resolveSessionId() does (reuse one session per thread).
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");

const wsPath = require.resolve("ws");
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
  http
    .get("http://localhost:18791/health", () => {
      const WebSocket = require(wsPath);
      const ws = new WebSocket("ws://localhost:18791/ws");
      let sessionId = null;
      let turn = 0;
      let reqId = 0;
      let finalsSeen = 0;

      function sendTurn(text) {
        turn++;
        reqId++;
        console.log(`\n--- TURN ${turn}: sending "${text}" (sessionId=${sessionId}) ---`);
        ws.send(
          JSON.stringify({
            type: "req",
            id: String(reqId),
            method: "chat.send",
            params: { agentId: "codex", sessionId, message: text },
          }),
        );
      }

      ws.on("open", () => sendTurn("say the word ALPHA and nothing else"));

      ws.on("message", (raw) => {
        const f = JSON.parse(raw);
        if (f.type === "res") {
          console.log("RPC:", f.ok ? "OK" : "FAIL", f.payload);
          if (f.ok && f.payload?.sessionId) sessionId = f.payload.sessionId;
        } else {
          const label = `${f.event}:${f.payload?.stream || f.payload?.state || "?"}`;
          if (f.payload?.data?.text) console.log("TEXT:", f.payload.data.text.slice(0, 120));
          if (f.payload?.state === "final" || f.payload?.state === "error") {
            finalsSeen++;
            console.log("GOT FINAL for turn", turn, "state:", f.payload.state);
            if (turn === 1) {
              setTimeout(() => sendTurn("say the word BETA and nothing else"), 500);
            } else {
              console.log("\n=== DONE. finalsSeen:", finalsSeen, "===");
              ws.close();
              proc.kill();
              process.exit(0);
            }
          }
        }
      });
    })
    .on("error", (e) => {
      console.log("HTTP FAIL:", e.message);
      proc.kill();
      process.exit(1);
    });
}, 4000);

setTimeout(() => {
  console.log("TIMEOUT — likely stuck run reproduced");
  console.log("GW LOG TAIL:", gwLog.slice(-2000));
  proc.kill();
  process.exit(1);
}, 60000);
