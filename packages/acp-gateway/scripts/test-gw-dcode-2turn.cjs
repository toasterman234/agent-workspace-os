// Verifies DCode (ACP adapter) multi-turn behavior: two chat.send calls on the
// SAME session should reuse one long-lived `dcode --acp` process (same pid)
// across turns, and both turns must reach a terminal state.
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

function extractPid(log) {
  // No direct pid log line in gateway output today; we rely on agents.list
  // "running"/pid payload instead once a turn has started.
  return null;
}

setTimeout(() => {
  http
    .get("http://localhost:18791/health", () => {
      const WebSocket = require(wsPath);
      const ws = new WebSocket("ws://localhost:18791/ws");
      let sessionId = null;
      let turn = 0;
      let reqId = 0;
      let finalsSeen = 0;
      let pidTurn1 = null;
      let pidTurn2 = null;

      function pidCheck(cb) {
        reqId++;
        const id = String(reqId);
        const onMsg = (raw) => {
          const f = JSON.parse(raw);
          if (f.type === "res" && f.id === id) {
            ws.removeListener("message", onMsg);
            const dcode = (f.payload?.agents || []).find((a) => a.id === "dcode");
            cb(dcode);
          }
        };
        ws.on("message", onMsg);
        ws.send(JSON.stringify({ type: "req", id, method: "agents.list" }));
      }

      function sendTurn(text) {
        turn++;
        reqId++;
        console.log(`\n--- TURN ${turn}: sending "${text}" (sessionId=${sessionId}) ---`);
        ws.send(
          JSON.stringify({
            type: "req",
            id: String(reqId),
            method: "chat.send",
            params: { agentId: "dcode", sessionId, message: text },
          }),
        );
      }

      ws.on("open", () => sendTurn("Reply with exactly the single word: ALPHA"));

      ws.on("message", (raw) => {
        const f = JSON.parse(raw);
        if (f.type === "res") {
          console.log("RPC:", f.ok ? "OK" : "FAIL", f.payload || f.error);
          if (f.ok && f.payload?.sessionId) sessionId = f.payload.sessionId;
        } else {
          if (f.payload?.data?.text) console.log("TEXT:", f.payload.data.text.slice(0, 200));
          if (f.payload?.state === "final" || f.payload?.state === "error") {
            finalsSeen++;
            console.log("GOT FINAL for turn", turn, "state:", f.payload.state);
            pidCheck((dcode) => {
              if (turn === 1) {
                pidTurn1 = dcode?.pid;
                console.log("pid after turn 1:", pidTurn1, "running:", dcode?.running);
                setTimeout(() => sendTurn("Reply with exactly the single word: BETA"), 500);
              } else {
                pidTurn2 = dcode?.pid;
                console.log("pid after turn 2:", pidTurn2, "running:", dcode?.running);
                console.log("\n=== DONE. finalsSeen:", finalsSeen, "===");
                console.log(
                  "SAME PROCESS ACROSS TURNS:",
                  pidTurn1 && pidTurn2 && pidTurn1 === pidTurn2,
                );
                ws.close();
                proc.kill();
                process.exit(finalsSeen === 2 && pidTurn1 === pidTurn2 ? 0 : 1);
              }
            });
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
  console.log("TIMEOUT — likely stuck run");
  console.log("GW LOG TAIL:", gwLog.slice(-3000));
  proc.kill();
  process.exit(1);
}, 90000);
