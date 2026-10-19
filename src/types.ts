export type Question = {
  id: string;
  question: string;
  detail?: string;
  header?: string;
  multiSelect?: boolean;
  options?: { label: string; description?: string }[];
};
export type Pending = {
  rpcId: string;
  type: string;
  sessionId: string;
  approvalId?: string;
  toolName?: string;
  reason?: string;
  questions?: Question[];
};
export type Session = {
  sessionId: string;
  running: boolean;
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
  connection: string;
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
  pending: Pending[];
  activity: Record<
    string,
    {
      status: string;
      tool?: string;
      message?: string;
      at?: number;
      seq?: number;
      tools?: Record<string, string>;
      reaction?: { mood: string; at: number; until: number };
      linger?: { mood: string; until: number };
    }
  >;
  lastInteractionAt?: number;
  completions: { id: string; sessionId: string; at: number }[];
  balance: {
    balances: { currency: string; total: number }[];
    updatedAt: number;
    stale?: boolean;
  } | null;
  balanceError: string;
  config: {
    endpoint: string;
    cwd: string;
    alwaysOnTop: boolean;
    expression?: string;
    idleExpressions?: boolean;
    animations?: boolean;
    petScale?: number;
    chatSize?: "small" | "medium" | "large";
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
