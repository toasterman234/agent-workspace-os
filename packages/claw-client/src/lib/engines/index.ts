/**
 * Engines barrel — registers known engine factories with the registry.
 * Import this module once at app startup before calling buildEngine().
 *
 * Each registered factory receives a raw config dict + events dict and
 * returns an Engine. The registry dispatches on config.type (defaults to
 * "openclaw").
 */
import { OpenClawEngine } from "./openclaw/OpenClawEngine";
import { registerEngine } from "./registry";
import type { Engine, OpenClawEngineConfig } from "./types";

registerEngine("openclaw", (config, events): Engine => {
  const oc = config as unknown as OpenClawEngineConfig;
  return new OpenClawEngine(
    {
      id: oc.id,
      name: oc.name,
      enabled: oc.enabled,
      type: "openclaw",
      gatewayUrl: oc.gatewayUrl ?? "",
      token: oc.token,
      deviceToken: oc.deviceToken,
    },
    events as unknown as ConstructorParameters<typeof OpenClawEngine>[1],
  );
});
