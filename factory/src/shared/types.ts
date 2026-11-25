export const ITEM_STATUSES = ['draft', 'ready', 'queued', 'active', 'blocked', 'done', 'cancelled'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];
export const RUN_STATUSES = ['pending', 'running', 'paused', 'completed', 'failed', 'cancelled'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];
export const NODE_STATUSES = ['pending', 'running', 'completed', 'failed', 'skipped'] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];
export const TIERS = ['heavy', 'standard', 'light'] as const;
export type Tier = (typeof TIERS)[number];
export type GateDecision = 'approve' | 'reject' | 'override';
export type EventType =
  | 'item.created' | 'item.updated' | 'run.created' | 'run.updated'
  | 'node.updated' | 'gate.opened' | 'gate.closed' | 'retro.recorded' | 'main.red' | 'main.green';

export interface WorkItem {
  id: number; parent_id: number | null; type: string; title: string; body: string;
  spec_path: string | null; tier: Tier | null; test_cmd: string | null; priority: number;
  status: ItemStatus; source_ref: string | null; created_at: string; updated_at: string;
}
export interface Run {
  id: number; item_id: number; template: string; attempt: number; status: RunStatus;
  branch: string | null; worktree: string | null; pr_number: number | null; pr_url: string | null; head_sha: string | null;
  cost_usd: number; started_at: string | null; ended_at: string | null;
}
export interface NodeRun {
  id: number; run_id: number; node: string; iteration: number; status: NodeStatus;
  model: string | null; session_file: string | null; cost_usd: number; output: string | null;
  started_at: string | null; ended_at: string | null;
}
export interface Gate {
  id: number; run_id: number; node: string; kind: string; question: string;
  recommendation: string | null; opened_at: string; closed_at: string | null;
  decision: GateDecision | null; note: string | null;
}
/** A gate with its run's PR; pr_url is null until the run opens one. */
export interface GateWithPr extends Gate { pr_number: number | null; pr_url: string | null }
export interface FactoryEvent {
  seq: number; item_id: number | null; run_id: number | null; node: string | null;
  type: EventType; data: Record<string, unknown>; at: string;
}
/** Health of `origin/main` under `config.defaultTestCmd`; in GET /api/health as `main` (null until first checked). */
export interface MainHealth { sha: string; status: 'green' | 'red'; checked_at: string }
export interface Activity { run_id: number; node: string; text: string; at: string } // transient, never persisted
export interface BatchItem {          // POST /api/items/batch input (import + CLI)
  ref: string; parent_ref?: string; depends_on_refs?: string[];
  type?: string; title: string; body?: string; spec_path?: string | null; tier?: Tier | null;
  test_cmd?: string | null; priority?: number; status?: ItemStatus; source_ref?: string | null;
}
export interface BatchResult { ids: Record<string, number>; created: string[]; skipped: string[] }
export interface ItemSummary extends WorkItem { open_deps: number }   // GET /api/items
export interface ItemDetail { item: WorkItem; deps: WorkItem[]; dependents: WorkItem[]; children: WorkItem[]; runs: Run[] }
export interface RunDetail { run: Run; node_runs: NodeRun[]; gates: GateWithPr[] }
export interface Retro {
  run_id: number; failures: string[]; findings: string[]; rework_count: number;
  cost_usd: number; duration_s: number; notes: string;
}
export interface Config {
  port: number;
  roles: {
    planner: string;
    executor: Record<Tier, string>;
    reviewer: Record<string, string>; // author model family -> reviewer model
  };
  caps: { sessionMinutes: number; sessionCostUsd: number; itemCostUsd: number };
  loop: { maxBuildAttempts: number; maxReviewRounds: number; maxParallel: number };
  git: { stateCommitPrefix: string; stateCommitDebounceSec: number };
  defaultTestCmd: string;
}
