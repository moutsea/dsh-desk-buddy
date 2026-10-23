export type Provider = "dsh" | "codex";
export type Question = {
  id: string;
  question: string;
  detail?: string;
  header?: string;
  multiSelect?: boolean;
  isSecret?: boolean;
  options?: { label: string; description?: string }[];
};
export type Pending = {
  provider?: Provider;
  rpcId: string;
  type: string;
  sessionId: string;
  approvalId?: string;
  toolName?: string;
  reason?: string;
  questions?: Question[];
  choices?: { value: string; label: string; detail?: string }[];
};
export type Session = {
  provider?: Provider;
  readOnly?: boolean;
  sessionId: string;
  running: boolean;
  // False while reconnecting until a fresh list or live runtime event arrives.
  runningKnown?: boolean;
  lastTurn?: {
    key: string;
    status?: string;
    startedAt?: number;
    historical?: boolean;
  };
  blank: boolean;
  cwd?: string;
  title?: string;
  updatedAt: number;
  projections?: { asOfSeq: number; values: Record<string, any> };
};
export type AppState = {
  managed?: boolean;
  surface: {
    section: "chat" | "expressions" | "settings" | null;
    side: "left" | "right";
    pet: { x: number; y: number };
    contentWidth: number;
    contentHeight: number;
    contentTop: number;
  };
  connections?: Record<
    Provider,
    { status: string; message: string; host: AppState["host"]; epoch?: number }
  >;
  connection: string;
  connectionEpoch: number;
  connectionMessage: string;
  host: { version: string; model?: string; cwd: string } | null;
  sessions: Session[];
  selectedId: string;
  events: any[];
  liveAssistant?: Record<
    string,
    { attemptId: string; revision: number; text: string } | null
  >;
  hasMore: boolean;
  historyReload?: { error: string } | null;
  pending: Pending[];
  progressEntries?: Record<
    string,
    {
      active: boolean;
      hidden: boolean;
      turn: string | null;
      status: string;
      completedAt?: number;
    }
  >;
  activity: Record<
    string,
    {
      status?: string;
      tool?: string;
      toolSummary?: string;
      toolDetails?: Record<string, string>;
      preview?: string;
      message?: string;
      at?: number;
      seq?: number;
      turn?: string;
      metadataRevision?: number;
      tools?: Record<string, string>;
      reaction?: { mood: string; at: number; until: number };
      linger?: { mood: string; until: number };
    }
  >;
  lastInteractionAt?: number;
  completions: { id: string; sessionId: string; at: number }[];
  taskSounds?: {
    id: string;
    kind: "started" | "failure";
    sessionId: string;
    at: number;
  }[];
  balance: {
    balances: { currency: string; total: number }[];
    updatedAt: number;
    stale?: boolean;
  } | null;
  balanceError: string;
  config: {
    provider?: Provider;
    enabledProviders?: Provider[];
    codexEndpoint?: string;
    endpoint: string;
    cwd: string;
    alwaysOnTop: boolean;
    expression?: string;
    idleExpressions?: boolean;
    animations?: boolean;
    petScale?: number;
    chatSize?: "small" | "medium" | "large";
    progressBubbles?: boolean;
    sounds?: import("./sounds").SoundSettings;
  };
};
declare global {
  interface Window {
    desktop?: {
      invoke: (action: string, payload?: any) => Promise<any>;
      subscribe: (callback: (state: AppState) => void) => () => void;
      subscribeSurface?: (
        callback: (surface: AppState["surface"]) => void,
      ) => () => void;
      subscribeVisibility?: (
        callback: (visible: boolean) => void,
      ) => () => void;
    };
  }
}
