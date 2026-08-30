/**
 * dsh-agent-room — browser API layer: client-side projections of the host
 * types plus the HTTP endpoints of /agent-room-api.
 */

/* ----------------------------- types (client projection) ----------------------------- */

export interface ApiMember {
  agentId: string;
  nickname: string;
  role: "owner" | "member";
  joinedAt: string;
  capabilities?: string[];
  manualCapabilities?: string[];
  roles?: string[];
}

export interface ApiRevoked {
  agentId: string;
  nickname?: string;
  revokedAt: string;
  by: string;
  reason?: string;
}

export interface ApiTask {
  taskId: string;
  title: string;
  description?: string;
  status: "todo" | "doing" | "review" | "done" | "rejected";
  assignee?: string;
  claimable?: boolean;
  requiredCapabilities?: string[];
  requiredRoles?: string[];
  acceptance?: string;
  handoff?: { done: string; basis?: string; next: string; risk?: string };
  createdBy: string;
  judge?: { mode: "controller" | "auto"; note?: string };
  comments?: Array<{ agentId: string; ts: string; text: string }>;
  createdAt?: string;
  updatedAt?: string;
}

export interface ApiDiscoveredRoom {
  roomId: string;
  title: string;
  authMode: "open" | "password";
  memberCount: number;
  addresses: string[];
  nickname: string;
}

/** How this node reaches a room: direct LAN socket, relay bridge, or none. */
export interface ApiBridge {
  kind: "none" | "relay" | "direct";
  state: "none" | "connecting" | "open" | "disconnected" | "reconnecting" | "closed";
  address?: string;
}

export interface ApiRoom {
  roomId: string;
  title: string;
  type: "persistent" | "temporary";
  status: "open" | "suspended" | "closed";
  owned: boolean;
  authMode: "open" | "password";
  autoMode: boolean;
  allowHumanTakeover: boolean;
  controllerAgentId: string;
  serverAddress?: string;
  memberCount: number;
  members: ApiMember[];
  tasks: ApiTask[];
  revoked?: ApiRevoked[];
  autoReply?: boolean;
  latestSeq?: number;
  bridge?: ApiBridge;
}

export interface ApiMessage {
  seq: number;
  from: string;
  fromNickname: string;
  ts: string;
  text: string;
  human?: boolean;
  mentions?: string[];
}

export interface RoomState {
  identity: { agentId: string; nickname: string; capabilities: string[] };
  node?: { hostname: string; addresses?: string[] };
  relay?: { address?: string; configured: boolean };
  discovered?: ApiDiscoveredRoom[];
  rooms: ApiRoom[];
}

/* ----------------------------- api helpers ----------------------------- */

export async function api<T = unknown>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json()) as { ok: boolean; data?: T; error?: string };
  if (!json.ok || !response.ok) throw new Error(json.error ?? `HTTP ${response.status}`);
  return json.data as T;
}

export const stateApi = () => api<RoomState>("/agent-room-api/state");

export const messagesApi = (roomId: string, before?: number) =>
  api<{ messages: ApiMessage[] }>(
    `/agent-room-api/rooms/${encodeURIComponent(roomId)}/messages${before !== undefined ? `?before=${before}` : ""}`,
  );

export const relayConfigApi = {
  get: () => api<{ address?: string; configured: boolean }>("/agent-room-api/relay-config"),
  set: (relay?: string) => api<{ relay: string | null }>("/agent-room-api/relay-config", { relay }),
};

/**
 * Open an SSE stream of browser events. Resolves an unsubscribe function.
 * The caller must treat failures as non-fatal (polling is the fallback).
 */
export function subscribeEvents(onEvent: (event: { kind: string; roomId?: string; [k: string]: unknown }) => void): () => void {
  let source: EventSource | null = null;
  let closed = false;
  try {
    if (typeof EventSource === "undefined") return () => {};
    source = new EventSource("/agent-room-api/events");
    source.onmessage = () => {};
    const kinds = ["chat", "task", "system", "connection", "members", "state"];
    for (const kind of kinds) {
      source.addEventListener(kind, (e) => {
        try {
          onEvent(JSON.parse((e as MessageEvent).data));
        } catch {
          /* malformed event — ignore */
        }
      });
    }
  } catch {
    /* EventSource unavailable (e.g. non-browser env) — fall back to polling */
  }
  return () => {
    closed = true;
    try {
      source?.close();
    } catch {
      /* ignore */
    }
    source = null;
  };
}
