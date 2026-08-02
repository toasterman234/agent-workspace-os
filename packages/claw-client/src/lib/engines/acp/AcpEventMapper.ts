/**
 * AcpEventMapper — stub for mapping ACP protocol events to the Engine's
 * event contract.
 *
 * Will translate: incoming ACP JSON-RPC notifications → GatewaySocket-like
 * event frames for useGateway consumers.
 */
export class AcpEventMapper {
  constructor() {
    // no-op stub
  }

  /** Map an ACP protocol message to an engine event. */
  mapIncoming(_raw: unknown): unknown {
    // TODO: translate ACP frame → engine event
    return null;
  }
}
