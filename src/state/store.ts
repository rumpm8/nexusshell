import { create } from "zustand";

export type WorkerStatus = "idle" | "working" | "error";

export interface Worker {
  workerId: string;
  name: string;
  avatar: string;
  zone: number;
  status: WorkerStatus;
  currentTask: string;
  progress: number;
  tokensUsed: number;
  costUsd: number;
  successCount: number;
  failCount: number;
  lastActivity: string | null;
  recentOutputs: string[];
}

export interface Metrics {
  notesIndexed: number;
  tasksCompleted: number;
  messagesProcessed: number;
  pnlUsd: number;
  apiCostUsd: number;
  postsPublished: number;
  emailsHandled: number;
  notesWritten: number;
  pnlHistory: number[];
  costHistory: number[];
  activityHistory: number[];
}

export interface ActivityEvent {
  id: number;
  workerId: string;
  kind: string;
  description: string;
  status: "ok" | "fail";
  ts: string;
}

// ── persistent chat state ────────────────────────────────────────────────────
// Lives in the global store so ChatNexus never loses messages when you
// navigate away. The component just reads/writes here — no local state.
export interface ChatMsg {
  id: number;
  role: "user" | "nexus" | "tool" | "error";
  text: string;
  timestamp: string;
}

export type View =
  "command" | "trading" | "agents" | "workspace" | "studio" | "odysseus" | "connections" | "nexus";

let _chatMsgId = 1;
export function nextChatId() { return _chatMsgId++; }

interface NexusState {
  workers: Worker[];
  metrics: Metrics;
  feed: ActivityEvent[];
  settingsOpen: boolean;
  dataSource: "mock" | "live";
  view: View;

  // ── chat persistence ──
  chatMsgs: ChatMsg[];
  chatBusy: boolean;
  chatBusyText: string;
  chatHistory: { role: string; text: string }[];
  pushChatMsg: (msg: ChatMsg) => void;
  setChatBusy: (busy: boolean, text?: string) => void;
  pushChatHistory: (role: string, text: string) => void;

  setView: (v: View) => void;
  setSettingsOpen: (open: boolean) => void;
  updateWorker: (workerId: string, patch: Partial<Worker>) => void;
  bumpMetrics: (patch: Partial<Metrics>) => void;
  pushActivity: (e: Omit<ActivityEvent, "id">) => void;
}

const seedWorkers: Worker[] = [
  {
    workerId: "scalperx", name: "ScalperX", avatar: "⚡", zone: 0,
    status: "idle", currentTask: "Scanning trending Solana pairs",
    progress: 0, tokensUsed: 0, costUsd: 0, successCount: 0, failCount: 0,
    lastActivity: null, recentOutputs: [],
  },
  {
    workerId: "night_watch", name: "NightWatch", avatar: "🌙", zone: 1,
    status: "idle", currentTask: "Waiting for RSI oversold confluence",
    progress: 0, tokensUsed: 0, costUsd: 0, successCount: 0, failCount: 0,
    lastActivity: null, recentOutputs: [],
  },
  {
    workerId: "librarian", name: "Vault Librarian", avatar: "📚", zone: 2,
    status: "idle", currentTask: "Indexing Obsidian vault",
    progress: 0, tokensUsed: 0, costUsd: 0, successCount: 0, failCount: 0,
    lastActivity: null, recentOutputs: [],
  },
  {
    workerId: "postman", name: "Postman", avatar: "✉️", zone: 3,
    status: "idle", currentTask: "Gmail not connected",
    progress: 0, tokensUsed: 0, costUsd: 0, successCount: 0, failCount: 0,
    lastActivity: null, recentOutputs: [],
  },
  {
    workerId: "publisher", name: "Publisher", avatar: "📣", zone: 4,
    status: "idle", currentTask: "Social accounts not connected",
    progress: 0, tokensUsed: 0, costUsd: 0, successCount: 0, failCount: 0,
    lastActivity: null, recentOutputs: [],
  },
  {
    workerId: "treasurer", name: "Treasurer", avatar: "💰", zone: 5,
    status: "idle", currentTask: "Wallet not connected",
    progress: 0, tokensUsed: 0, costUsd: 0, successCount: 0, failCount: 0,
    lastActivity: null, recentOutputs: [],
  },
];

let nextActivityId = 1;

export const useNexus = create<NexusState>((set) => ({
  workers: seedWorkers,
  metrics: {
    notesIndexed: 0, tasksCompleted: 0, messagesProcessed: 0,
    pnlUsd: 0, apiCostUsd: 0, postsPublished: 0, emailsHandled: 0,
    notesWritten: 0,
    pnlHistory: [], costHistory: [], activityHistory: [],
  },
  feed: [],
  settingsOpen: false,
  dataSource: "mock",
  view: "command",

  // ── chat — seeded with greeting, persists forever ──
  chatMsgs: [{
    id: 0, role: "nexus",
    text: "NEXUS online. I can read the brain, snapshot the traders, and command the controller. What do you need?",
    timestamp: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
  }],
  chatBusy: false,
  chatBusyText: "processing",
  chatHistory: [],

  pushChatMsg: (msg) =>
    set((s) => ({ chatMsgs: [...s.chatMsgs, msg] })),

  setChatBusy: (busy, text) =>
    set({ chatBusy: busy, chatBusyText: text ?? "processing" }),

  pushChatHistory: (role, text) =>
    set((s) => ({
      chatHistory: [...s.chatHistory, { role, text }].slice(-12),
    })),

  setView: (view) => set({ view }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  updateWorker: (workerId, patch) =>
    set((s) => ({
      workers: s.workers.map((w) =>
        w.workerId === workerId ? { ...w, ...patch } : w,
      ),
    })),
  bumpMetrics: (patch) =>
    set((s) => ({ metrics: { ...s.metrics, ...patch } })),
  pushActivity: (e) =>
    set((s) => ({
      feed: [{ ...e, id: nextActivityId++ }, ...s.feed].slice(0, 60),
    })),
}));
