/** The coding service boundary. Commands keep their identity across transport retries. */
export type RunnerCommand = {
  type: string;
  commandId: string;
  threadId: string;
  createdAt: string;
  [key: string]: unknown;
};
export type RunnerActivity = {
  id: string; kind: string; summary: string; tone: string;
  turnId: string | null; sequence?: number; createdAt?: string;
  payload: Record<string, unknown> | null;
};
export type RunnerThread = {
  id: string; projectId: string; branch: string | null; worktreePath: string | null;
  messages: Array<{ id: string; role: string; text: string; turnId: string | null; streaming?: boolean }>;
  activities: RunnerActivity[];
  latestTurn: { turnId: string; state: "running" | "completed" | "interrupted" | "error"; assistantMessageId?: string | null } | null;
  session: { status: string; lastError: string | null; activeTurnId: string | null } | null;
};
export type ReplayResult = { events: Array<{ sequence: number; activity: RunnerActivity }>; snapshot?: { sequence: number; thread: RunnerThread } };
export interface Runner {
  projects(): Promise<Array<{ id: string; workspaceRoot: string }>>;
  snapshot(threadId: string): Promise<{ sequence: number; thread: RunnerThread } | null>;
  replay(threadId: string, afterSequence: number): Promise<ReplayResult>;
  dispatch(command: RunnerCommand): Promise<void>;
}
