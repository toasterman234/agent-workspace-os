export type GatewayUrlValidation = { ok: true } | { ok: false; error: string };

/**
 * Client-side gateway URL check. Catches the common typos (missing protocol,
 * `http://` instead of `ws://`, port out of range) before we hand the URL to
 * `new WebSocket()`, which would either throw synchronously or silently fail
 * to connect — both bad UX. Defense-in-depth: the socket layer also catches
 * a sync throw and surfaces UNREACHABLE.
 */
export function validateGatewayUrl(raw: string, engineType?: string): GatewayUrlValidation {
  if (!raw) return { ok: false, error: "Gateway URL is required." };
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return {
      ok: false,
      error: "Not a valid URL. Use ws://host:port or wss://host:port.",
    };
  }
  // ACP gateways use HTTP for the static UI and /ws for WebSocket — accept http:// too
  const validProtocols =
    engineType === "acp" ? ["ws:", "wss:", "http:", "https:"] : ["ws:", "wss:"];
  if (!validProtocols.includes(parsed.protocol)) {
    const hint =
      engineType === "acp"
        ? "Use http:// for ACP gateways (WS auto-detected on /ws)."
        : "Use ws:// for local or wss:// for remote.";
    return { ok: false, error: `Unsupported protocol "${parsed.protocol}". ${hint}` };
  }
  if (!parsed.hostname) {
    return { ok: false, error: "URL is missing a hostname." };
  }
  return { ok: true };
}
