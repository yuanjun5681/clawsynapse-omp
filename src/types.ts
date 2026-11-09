export interface Config {
  endpoint: string;
  dataDir: string;
  stateDir: string;
  botIds: string[];
  pollIntervalMs: number;
  tokenFiles: Record<string, string>;
}

export interface RequestKey {
  botId: string;
  messageId: string;
}

export interface RequestMetadata extends RequestKey {
  type: "chat.message" | "task.assign";
  from: string;
  timestamp: number;
  requestId?: string;
  runId?: string;
  sessionKey?: string;
}

export interface ObservationState {
  revision: number;
  cursors: Record<string, number>;
  unread: RequestMetadata[];
}

export interface BotConnection {
  botId: string;
  state: "connecting" | "connected" | "offline" | "error" | "paused";
  detail?: string;
}

export interface ObserverView {
  observation: ObservationState;
  bots: BotConnection[];
  /** Display-only names, scoped by receiving Bot and sender ID; never persisted as identity. */
  peerNames: Record<string, Record<string, string>>;
}

export interface ObserverOptions {
  onChange: (view: ObserverView) => void;
  /** Schedule through the host's managed timer; return an idempotent cancel function. */
  schedule: (callback: () => void, ms: number) => () => void;
}

export const LIMITS = {
  responseBytes: 8 * 1024 * 1024,
  metadataBytes: 8 * 1024,
  unreadCount: 1000,
  unreadBytes: 8 * 1024 * 1024,
  scopes: 128,
  databaseBytes: 64 * 1024 * 1024,
  historyBytes: 64 * 1024 * 1024,
  lineBytes: 8 * 1024 * 1024,
  entries: 100000,
  candidates: 10000,
  cacheBytes: 128 * 1024 * 1024,
  pagesPerRound: 5,
  timeoutMs: 3000,
} as const;
