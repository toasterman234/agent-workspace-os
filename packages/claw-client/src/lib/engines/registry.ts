import type { Engine, EngineFactory } from "./types";

const builders = new Map<string, EngineFactory>();

/** Register a factory for a given engine type (e.g. "openclaw", "acp"). */
export function registerEngine(type: string, factory: EngineFactory): void {
  builders.set(type, factory);
}

/** Build an engine instance from a typed config block. */
export function buildEngine(
  config: Record<string, unknown>,
  events: Record<string, unknown>,
): Engine {
  const type = (config["type"] as string) ?? "openclaw";
  const factory = builders.get(type);
  if (!factory) {
    throw new Error(`No engine factory registered for type "${type}"`);
  }
  return factory(config, events);
}
