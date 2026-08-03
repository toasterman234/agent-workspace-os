"use client";

import { createOpenClawAGUIMapper } from "@/lib/chat/openclaw-agui-mapper";
import type {
  AgentInfo,
  ArtifactRecord,
  ArtifactStore,
  ArtifactSummary,
  ConversationStore,
  Engine,
  EngineCapabilities,
  ModelInfo,
  SessionInfo,
  StoredMessage,
} from "../types";

const log = (...args: unknown[]) => console.info("[claw:acp]", ...args);
const warn = (...args: unknown[]) => console.warn("[claw:acp]", ...args);

// ── Internal typed shapes for RPC responses ──────────────────────────────

interface RpcAgentResponse {
  id: string;
  name: string;
  type: string;
  running: boolean;
  pid?: number;
}

interface RpcModelResponse {
  id: string;
  name: string;
  provider: string;
}

interface RpcSessionResponse {
  id: string;
  agentId: string;
  title?: string;
  createdAt: string;
  updatedAt?: string;
}

interface RpcAgentEvent {
  stream: string;
  runId: string;
  data: { delta: string; text?: string };
}

interface RpcChatEvent {
  runId: string;
  sessionKey: string;
  state: "delta" | "final" | "aborted" | "error";
  stopReason?: string;
  errorMessage?: string;
}

type RpcPayload = Record<string, unknown>;

/**
 * AcpEngine — browser-side engine that connects to the standalone ACP
 * gateway over WebSocket. Uses the same req/res/event frame protocol
 * as the gateway, enabling the existing AG-UI event mapper to work
 * unchanged.
 */
export class AcpEngine implements Engine {
  readonly id: string;

  readonly capabilities: EngineCapabilities = {
    loadSession: true,
    listSessions: true,
    deleteSessions: true,
    multiAgent: true,
    sessionConfig: false,
    artifacts: true,
    apps: false,
    uploads: false,
    crons: false,
    notifications: false,
  };

  readonly conversations: ConversationStore;
  readonly artifacts: ArtifactStore;

  private ws: WebSocket | null = null;
  private gatewayUrl: string;
  private pending = new Map<
    string,
    (res: { ok: true; payload?: RpcPayload } | { ok: false; error?: string }) => void
  >();
  private _agents: AgentInfo[] = [];
  /** Maps a UI thread id (== agentId for the synthetic "main" thread) to the
   * gateway's real session id, so repeated sends/history reuse one session. */
  private sessionByThread = new Map<string, string>();
  private eventHandlers = new Map<string, Set<(payload: RpcPayload) => void>>();
  private _connectPromise: Promise<void> | null = null;
  private _messageCounter = 0;

  private onConnectionStateChange: (state: string) => void;
  private onKnownAgentIdsChanged: (ids: Set<string>) => void;
  private onModelDefaultsChanged: (defaults: {
    workspaceDefault: string | null;
    byAgent: Map<string, string>;
    defaultAgentId: string | null;
  }) => void;

  constructor(
    gatewayUrl: string,
    onConnectionStateChange?: (state: string) => void,
    onKnownAgentIdsChanged?: (ids: Set<string>) => void,
    onModelDefaultsChanged?: (defaults: {
      workspaceDefault: string | null;
      byAgent: Map<string, string>;
      defaultAgentId: string | null;
    }) => void,
  ) {
    this.id = "acp";
    this.gatewayUrl = gatewayUrl;
    this.onConnectionStateChange = onConnectionStateChange ?? (() => {});
    this.onKnownAgentIdsChanged = onKnownAgentIdsChanged ?? (() => {});
    this.onModelDefaultsChanged = onModelDefaultsChanged ?? (() => {});
    log("AcpEngine created, gateway:", gatewayUrl);

    // Closure over `this` so store methods can call engine.rpc()
    const engine: AcpEngine["rpc"] = (...args) => this.rpc(...args);
    const resolveSessionId: AcpEngine["resolveSessionId"] = (threadId) =>
      this.resolveSessionId(threadId);

    this.conversations = {
      listSessions: async (agentId?: string): Promise<SessionInfo[]> => {
        const params: RpcPayload = {};
        if (agentId) params["agentId"] = agentId;
        const res = await engine("sessions.list", params);
        if (!res.ok || !res.payload) return [];
        const sessions = (res.payload["sessions"] as RpcSessionResponse[] | undefined) ?? [];
        return sessions.map((s) => ({
          id: s.id,
          agentId: s.agentId,
          title: s.title,
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
        }));
      },

      getSession: async (sessionId: string): Promise<SessionInfo | null> => {
        const res = await engine("sessions.list", {});
        if (!res.ok || !res.payload) return null;
        const sessions = (res.payload["sessions"] as RpcSessionResponse[] | undefined) ?? [];
        const found = sessions.find((s) => s.id === sessionId);
        return found
          ? {
              id: found.id,
              agentId: found.agentId,
              title: found.title,
              createdAt: found.createdAt,
            }
          : null;
      },

      createSession: async (agentId: string, title?: string): Promise<SessionInfo> => {
        const params: RpcPayload = { agentId };
        if (title) params["title"] = title;
        const res = await engine("sessions.create", params);
        if (!res.ok || !res.payload) {
          return { id: "", agentId, createdAt: new Date().toISOString() };
        }
        const s = res.payload["session"] as RpcSessionResponse;
        return {
          id: s.id,
          agentId: s.agentId,
          title: s.title,
          createdAt: s.createdAt,
        };
      },

      deleteSession: async (sessionId: string): Promise<void> => {
        await engine("sessions.delete", { sessionId });
      },

      renameSession: async (_sessionId: string, _title: string): Promise<void> => {
        // not supported by ACP gateway yet — no-op
      },

      loadHistory: async (threadId: string): Promise<StoredMessage[]> => {
        const sessionId = await resolveSessionId(threadId);
        if (!sessionId) return [];
        const res = await engine("chat.history", { sessionId });
        if (!res.ok || !res.payload) return [];
        const msgs =
          (res.payload["messages"] as
            | Array<{ id: string; role: string; content: string | null }>
            | undefined) ?? [];
        return msgs.map((m) => {
          if (m.role === "activity") {
            return {
              id: m.id,
              role: "activity" as const,
              activityType: "note",
              content: { text: m.content ?? "" },
            } satisfies StoredMessage;
          }
          if (m.role === "assistant") {
            return {
              id: m.id,
              role: "assistant" as const,
              content: m.content,
            } satisfies StoredMessage;
          }
          return {
            id: m.id,
            role: "user" as const,
            content: typeof m.content === "string" ? m.content : "",
          } satisfies StoredMessage;
        });
      },

      getSessionConfig: async (): Promise<Record<string, string>> => ({}),
      setSessionConfig: async (): Promise<void> => {},
    };

    this.artifacts = {
      listArtifacts: async (kind?: string): Promise<ArtifactSummary[]> => {
        try {
          const params: RpcPayload = {};
          if (kind) params["kind"] = kind;
          const res = await engine("artifacts.list", params);
          if (!res.ok) return [];
          const items = (res.payload?.["artifacts"] as
            | Array<Record<string, unknown>>
            | undefined) ?? [];
          return items.map((a) => ({
            id: a["id"] as string,
            kind: a["kind"] as string,
            title: a["title"] as string,
            source: a["source"] as ArtifactSummary["source"],
            createdAt: a["createdAt"] as string,
            updatedAt: a["updatedAt"] as string,
          }));
        } catch {
          return [];
        }
      },

      getArtifact: async (artifactId: string): Promise<ArtifactRecord | null> => {
        try {
          const res = await engine("artifacts.get", { id: artifactId });
          if (!res.ok || !res.payload) return null;
          const a = res.payload["artifact"] as Record<string, unknown> | null;
          if (!a) return null;
          return a as unknown as ArtifactRecord;
        } catch {
          return null;
        }
      },

      deleteArtifact: async (artifactId: string): Promise<void> => {
        await engine("artifacts.delete", { id: artifactId });
      },
    };
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this._connectPromise) return this._connectPromise;

    this.onConnectionStateChange("CONNECTING");

    this._connectPromise = new Promise((resolve, reject) => {
      const wsUrl = this.gatewayUrl.replace(/^http/, "ws") + "/ws";
      log("connecting to", wsUrl);
      const ws = new WebSocket(wsUrl);

      ws.onopen = () => {
        log("connected");
        this.ws = ws;
        this.onConnectionStateChange("CONNECTED");
        resolve();
        void this.listAgents().then((agents) => {
          this.onKnownAgentIdsChanged(new Set(agents.map((a) => a.id)));
          this.onModelDefaultsChanged({
            workspaceDefault: null,
            byAgent: new Map(),
            defaultAgentId: agents[0]?.id ?? null,
          });
        });
      };

      ws.onmessage = (event: MessageEvent) => {
        const raw = JSON.parse(event.data as string) as RpcPayload;
        if (raw["type"] === "res" && typeof raw["id"] === "string") {
          this.pending.get(raw["id"])?.({
            ok: !!raw["ok"],
            payload: raw["payload"] as RpcPayload | undefined,
            error: raw["error"] as string | undefined,
          });
          this.pending.delete(raw["id"]);
          return;
        }
        if (raw["type"] === "event" && typeof raw["event"] === "string") {
          const handlers = this.eventHandlers.get(raw["event"]);
          if (handlers) {
            for (const h of handlers) h(raw["payload"] as RpcPayload);
          }
        }
      };

      ws.onerror = (err) => {
        warn("WebSocket error", err);
        this.onConnectionStateChange("UNREACHABLE");
        if (!this._connectPromise) return;
        reject(new Error("WebSocket connection failed"));
        this._connectPromise = null;
      };

      ws.onclose = () => {
        log("disconnected");
        this.ws = null;
        this.onConnectionStateChange("DISCONNECTED");
      };
    });

    return this._connectPromise;
  }

  async disconnect(): Promise<void> {
    this._connectPromise = null;
    this.ws?.close();
    this.ws = null;
    this.pending.clear();
    this.eventHandlers.clear();
  }

  // ── RPC ───────────────────────────────────────────────────────────────

  private async rpc(
    method: string,
    params?: RpcPayload,
  ): Promise<{ ok: true; payload?: RpcPayload } | { ok: false; error?: string }> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return { ok: false, error: "not connected" };
    }
    const id = String(++this._messageCounter);
    return new Promise((resolve) => {
      this.pending.set(id, resolve);
      this.ws!.send(JSON.stringify({ type: "req", id, method, params }));
    });
  }

  /** Resolve a UI thread id to a real gateway session id, creating one on
   * first use and caching it for subsequent sends/history loads. Returns ""
   * if the thread id isn't a known agent (e.g. before `listAgents` runs). */
  private async resolveSessionId(threadId: string): Promise<string> {
    const cached = this.sessionByThread.get(threadId);
    if (cached) return cached;

    const isAgentId = this._agents.length === 0 || this._agents.some((a) => a.id === threadId);
    if (!isAgentId) return "";

    const existing = await this.rpc("sessions.list", { agentId: threadId });
    const sessions =
      (existing.ok && (existing.payload?.["sessions"] as RpcSessionResponse[] | undefined)) || [];
    if (sessions.length > 0) {
      const sessionId = sessions[0]!.id;
      this.sessionByThread.set(threadId, sessionId);
      return sessionId;
    }

    const created = await this.rpc("sessions.create", { agentId: threadId });
    if (!created.ok || !created.payload) return "";
    const sessionId = (created.payload["session"] as RpcSessionResponse).id;
    this.sessionByThread.set(threadId, sessionId);
    return sessionId;
  }

  private onEvent(event: string, handler: (payload: RpcPayload) => void): () => void {
    let handlers = this.eventHandlers.get(event);
    if (!handlers) {
      handlers = new Set();
      this.eventHandlers.set(event, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers?.delete(handler);
    };
  }

  // ── Engine: orchestration ─────────────────────────────────────────────

  async listAgents(): Promise<AgentInfo[]> {
    const res = await this.rpc("agents.list");
    if (!res.ok || !res.payload) return [];
    const agents = (res.payload["agents"] as RpcAgentResponse[] | undefined) ?? [];
    this._agents = agents.map((a) => ({
      id: a.id,
      name: a.name ?? a.id,
    }));
    return this._agents;
  }

  async listModels(): Promise<ModelInfo[]> {
    const res = await this.rpc("models.list");
    if (!res.ok || !res.payload) return [];
    const models = (res.payload["models"] as RpcModelResponse[] | undefined) ?? [];
    return models.map((m) => ({
      id: m.id,
      name: m.name ?? m.id,
      provider: m.provider ?? "unknown",
    }));
  }

  async sendMessage(
    threadId: string,
    messages: unknown[],
    abortController: AbortController,
  ): Promise<Response> {
    const agentId = this._agents.some((a) => a.id === threadId) ? threadId : "codex";
    const sessionId = await this.resolveSessionId(threadId);
    const lastMsg = messages[messages.length - 1] as
      | { role?: string; content?: unknown }
      | undefined;
    const content = lastMsg?.content;
    const text =
      typeof content === "string"
        ? content
        : Array.isArray(content)
          ? content
              .filter((c: unknown) => (c as { type?: string })?.type === "text")
              .map((c: unknown) => (c as { text?: string })?.text ?? "")
              .join("")
          : "";

    const encoder = new TextEncoder();
    let ctrl!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        ctrl = c;
      },
    });

    const write = (evt: RpcPayload) => {
      try {
        ctrl.enqueue(encoder.encode(JSON.stringify(evt) + "\n"));
      } catch {
        /* closed */
      }
    };

    const closeStream = () => {
      try {
        ctrl.close();
      } catch {
        /* already closed */
      }
    };

    abortController.signal.addEventListener("abort", () => {
      closeStream();
    });

    const mapper = createOpenClawAGUIMapper(write);

    const unsubAgent = this.onEvent("agent", (payload: RpcPayload) => {
      const evt = payload as unknown as RpcAgentEvent;
      if (!evt.stream || !evt.data) return;
      const runId = evt.runId ?? "0";
      const ts = Date.now() / 1000;

      const base = { runId, seq: 0, ts };
      if (evt.stream === "assistant") {
        mapper.onAgentEvent({
          ...base,
          stream: "assistant",
          data: { delta: evt.data.delta ?? "", text: evt.data.text },
        });
      } else if (evt.stream === "thinking") {
        mapper.onAgentEvent({
          ...base,
          stream: "thinking",
          data: { delta: evt.data.delta ?? "", text: evt.data.text },
        });
      } else if (evt.stream === "tool") {
        mapper.onAgentEvent({
          ...base,
          stream: "tool",
          data: evt.data as unknown as Record<string, unknown>,
        } as Parameters<typeof mapper.onAgentEvent>[0]);
      } else if (evt.stream === "lifecycle") {
        mapper.onAgentEvent({
          ...base,
          stream: "lifecycle",
          data: evt.data as unknown as Record<string, unknown>,
        } as Parameters<typeof mapper.onAgentEvent>[0]);
      }
    });

    const unsubChat = this.onEvent("chat", (payload: RpcPayload) => {
      const evt = payload as unknown as RpcChatEvent;
      mapper.onChatEvent({
        runId: evt.runId ?? "0",
        sessionKey: evt.sessionKey ?? "",
        seq: 0,
        state: evt.state ?? "final",
        stopReason: evt.stopReason,
        errorMessage: evt.errorMessage,
      });
      unsubAgent();
      unsubChat();
    });

    const res = await this.rpc("chat.send", {
      agentId,
      sessionId: sessionId || undefined,
      message: text,
    });

    if (!res.ok) {
      write({
        type: "RUN_ERROR",
        message: res.error ?? "chat.send failed",
      });
      closeStream();
    }

    return new Response(stream, {
      status: 200,
      headers: { "Content-Type": "application/octet-stream" },
    });
  }

  async abort(sessionId: string): Promise<void> {
    const agentId = this._agents.some((a) => a.id === sessionId) ? sessionId : "codex";
    await this.rpc("chat.abort", { agentId });
  }

  /** One synthetic "main" thread per registered agent, so the UI has a
   * target thread before any session has been created. */
  async fetchThreadList(): Promise<
    Array<{
      id: string;
      title: string;
      createdAt: number;
      clawKind: "main" | "extra";
      clawAgentId: string;
    }>
  > {
    const agents = this._agents.length > 0 ? this._agents : await this.listAgents();
    return agents.map((a) => ({
      id: a.id,
      title: a.name ?? a.id,
      createdAt: Date.now(),
      clawKind: "main" as const,
      clawAgentId: a.id,
    }));
  }
}

/** Factory for use with EngineRegistry. Takes gateway URL from config. */
export function createAcpEngine(
  config: Record<string, unknown>,
  events?: Record<string, unknown>,
): AcpEngine {
  const url = (config["gatewayUrl"] as string) ?? "http://localhost:18791";
  const onConnectionStateChange = events?.["onConnectionStateChange"] as
    | ((state: string) => void)
    | undefined;
  const onKnownAgentIdsChanged = events?.["onKnownAgentIdsChanged"] as
    | ((ids: Set<string>) => void)
    | undefined;
  const onModelDefaultsChanged = events?.["onModelDefaultsChanged"] as
    | ((defaults: {
        workspaceDefault: string | null;
        byAgent: Map<string, string>;
        defaultAgentId: string | null;
      }) => void)
    | undefined;
  return new AcpEngine(
    url as string,
    onConnectionStateChange,
    onKnownAgentIdsChanged,
    onModelDefaultsChanged,
  );
}
