// Schema v2 — MiroFish-inspired simulation domain.
// Source of truth: ARCHITECTURE-v2-mirofish.md

// ============== Graph layer ==============

export type EntityType = 'Person' | 'Project' | 'Task' | 'Skill' | 'Meeting';
export type EdgeKind =
  | 'leads'
  | 'pairs_with'
  | 'blocks'
  | 'mentioned_in'
  | 'overrode'
  | 'praises'
  | 'absent_at'
  | 'has_skill';

export interface EvidenceRef {
  source: 'meeting' | 'task_outcome' | 'self_report' | 'override' | 'org_chart';
  source_id: string;          // e.g. "meeting/产品讨论-0428.txt"
  speaker?: string;           // org canonical name
  ts_range?: [string, string];
  quote: string;              // <= 200 chars
  extracted_at: string;
}

export interface GraphEntity {
  id: string;
  type: EntityType;
  name: string;
  attrs: Record<string, unknown>;
  source_refs: EvidenceRef[];
}

export interface GraphEdge {
  id: string;
  kind: EdgeKind;
  from: string;
  to: string;
  weight?: number;
  evidence: EvidenceRef[];
  ts: string;
}

// ============== Persona layer ==============

export type Tier = 'deep' | 'lite' | 'stub';
export type Department = '产品' | '研发' | '职能' | '运营' | '老板';
export type Energy = 'high' | 'normal' | 'low' | 'burnt' | 'unknown';
export type WorkerKind = 'human' | 'ai';

export interface CapabilityNode {
  name: string;
  level: 1 | 2 | 3 | 4 | 5;
  evidence: EvidenceRef[];
}

export interface ActiveAssignment {
  proj_id: string;
  role: string;
  evidence: EvidenceRef[];
}

export interface CollabPair {
  name: string;
  evidence: EvidenceRef[];
}

// Per-person agent instance. Each human owns their own Claude Code.
// Profile builds up via the human's interactions with their agent — not a
// shared singleton. PMA can assign tasks to a person's specific agent instance.
export interface AgentInstance {
  vendor: 'Anthropic' | string;
  model_handle: 'claude-code' | string;
  display_name: string; // e.g. "张三 的 Claude Code"
  // Quota tracking
  quota_period: 'daily' | 'weekly' | 'monthly';
  quota_used_cny?: number;
  quota_limit_cny?: number;
  // Behavior signals — built up from real chat logs
  current_tasks: Array<{ task_id?: string; description: string; started_at: string }>;
  past_tasks: Array<{ task_id?: string; description: string; finished_at: string; outcome?: 'success' | 'partial' | 'failed' }>;
  strengths_observed: string[]; // "owner 经常让它写测试" / "处理类型重构很稳"
  weaknesses_observed: string[]; // "复杂状态推理时容易丢上下文"
  collaboration_style: string; // "owner 倾向多次小批次让 agent 修，每次先 review"
  tools_enabled: string[]; // ['code_edit', 'shell', ...]
  notes?: string;
  last_active_at?: string;
}

export interface TeamMemberProfile {
  // Identity (org-canonical name, never alias)
  name: string;
  // Always 'human' for new schema. Field kept for type compat with old AI-only profiles.
  kind?: WorkerKind;
  dept: Department;
  role: string;
  join_date: string | null;
  tier: Tier;
  // Each member's owned Claude Code instance. PMA can target either the person
  // or their agent. Empty when person hasn't been provisioned one.
  agents?: {
    claude_code?: AgentInstance;
  };
  // Legacy AI-only profile shim (when kind === 'ai'). New schema uses per-person
  // agents above; kept for backward compat with any existing standalone AI files.
  ai_meta?: {
    vendor: string;
    model_handle: string;
    tools: string[];
    parallelism: number;
    cost_per_task_cny?: number;
    avg_latency_minutes?: number;
    typical_tasks: string[];
    failure_modes: string[];
  };

  // MiroFish persona — narrative, not field bag
  bio: string;            // 1-line characterizing quote
  persona: string;        // 100-300 char narrative paragraph

  // Domain-specific 6 dimensions
  capabilities: {
    domains: CapabilityNode[];
    skills: CapabilityNode[];
  };
  workload: {
    active: ActiveAssignment[];
    blocked_on: Array<{ by: string; evidence: EvidenceRef[] }>;
    hard_constraints: Array<{ kind: string; value: string; evidence: EvidenceRef[] }>;
  };
  energy: {
    current: Energy;
    evidence: EvidenceRef[];
  };
  collab: {
    pairs_well_with: CollabPair[];
    pairs_poorly_with: CollabPair[];
  };
  trajectory: {
    learning_focus: string[];
    stretch_appetite: 'low' | 'medium' | 'high' | 'unknown';
    evidence: EvidenceRef[];
  };

  // 16-type personality (Myers-Briggs). Inferred from communication style.
  mbti?: string;

  // Alias detection
  transcript_misspellings: string[];

  // Memory references
  recent_overrides: EvidenceRef[];
  recent_praises: EvidenceRef[];
  recent_objections: EvidenceRef[];

  _meta: {
    schema_version: 2;
    bootstrapped_at: string;
    evolution_count: number;
    source_files: string[];
    eligible_for_query: boolean;
  };
}

// Backward compat: v1 code that imported PersonalAgentProfile / EnergyLevel
// continues to compile. New code should use TeamMemberProfile / Energy.
export type PersonalAgentProfile = TeamMemberProfile;
export type EnergyLevel = Energy;

// ============== Simulation layer ==============

export type ActionType = 'BID' | 'DEFER' | 'RECOMMEND_SPLIT' | 'OBJECT' | 'COMMIT' | 'REFINED_BID';
export type Track = 'optimistic' | 'skeptical';

export type AgentActionPayload =
  | { type: 'BID'; capability_fit: number; load_fit: number; collab_fit: number; reason: string }
  | { type: 'DEFER'; recommend: string; reason: string }
  | {
      type: 'RECOMMEND_SPLIT';
      subtasks: Array<{ subtask: string; assignee: string; reason: string }>;
      reason?: string;
    }
  | { type: 'OBJECT'; against: string; reason: string }
  | { type: 'COMMIT'; subtask: string; reason?: string }
  | {
      type: 'REFINED_BID';
      capability_fit: number;
      load_fit: number;
      collab_fit: number;
      delta_capability: number; // signed change vs R1 BID
      delta_load: number;
      delta_collab: number;
      reason: string; // why scores changed (or didn't)
    };

export interface AgentAction {
  round_num: number;
  ts: string;
  track: Track;
  agent_name: string;
  action_type: ActionType;
  payload: AgentActionPayload;
  evidence_cited: EvidenceRef[];
  latency_ms: number;
  success: boolean;
}

export interface RoundSummary {
  round_num: number;
  track: Track;
  start_ts: string;
  end_ts: string;
  active_agents: string[];
  actions: AgentAction[];
  converged: boolean;
}

export interface SimulationConfig {
  task_id: string;
  task_description: string;
  rounds: number;
  eligible_agents: string[];
  excluded_with_reason: Record<string, string>;
  action_types: ActionType[];
  splittable: boolean;
  expected_subtasks: string[];
  tracks: Track[];
  per_round_timeout_ms: number;
  total_budget_ms: number;
  // Priority + strategy. Drives whom to include + how many rounds.
  priority?: Priority;
  strategy?: SimStrategy;
  can_interrupt?: boolean;
}

export interface SimulationRunState {
  sim_id: string;
  status: 'idle' | 'preparing' | 'running' | 'paused' | 'completed' | 'failed';
  config: SimulationConfig;
  current_round: number;
  rounds_a: RoundSummary[];
  rounds_b: RoundSummary[];
  started_at: string;
  finished_at?: string;
  error?: string;
}

// ============== Decision + Report ==============

export interface SubtaskAssignment {
  subtask: string;
  assignee: string;
  capability_fit: number;
  load_fit: number;
  collab_fit: number;
  rationale: string;
  evidence_cited: EvidenceRef[];
}

export interface PMADecisionV2 {
  task_id: string;
  task_description: string;
  decomposition?: SubtaskAssignment[];
  top1?: string | null;
  top1_subtask?: SubtaskAssignment;
  alternatives: string[];
  confidence: number;
  rationale: string;
  sim_replay_id: string;
  track_a_summary: string;
  track_b_summary: string;
  ground_truth_evidence_count: number;
  reason_if_null?: string;
  // Confidence inputs (so UI can explain how the score was reached).
  tracks_agree?: boolean;
  converged?: boolean;
  // Execution mode — Pair-aware.
  mode?: ExecutionMode;
  ts: string;
}

// ============== Team resources layer ==============
// Shared institutional assets: emails, API keys, licenses, domains, etc.
// First-class data so PMA can answer "this task needs X — who owns X?"

export type ResourceType =
  | 'account' // shared login (gmail, twitter, etc.)
  | 'api_key' // OpenAI / MiniMax / Stripe / etc.
  | 'license' // Apple developer / Adobe / Figma seat
  | 'domain' // company.com / app.com
  | 'subscription' // Notion / Vercel / etc.
  | 'cloud' // AWS / GCP / Cloudflare account
  | 'cert' // SSL cert / signing cert
  | 'other';

export interface TeamResource {
  id: string;
  type: ResourceType;
  name: string; // human label, e.g. "公司 Gmail" / "OpenAI Production Key"
  vendor: string; // gmail / openai / aws / apple / figma / notion / ...
  identifier?: string; // visible (non-secret): account name, key prefix, license seat ID
  credential_encrypted?: string; // encrypted secret (optional — sometimes only metadata stored)
  owners: string[]; // member names — primary maintainers
  users_with_access: string[]; // member names — who can use it
  monthly_cost_cny?: number; // soft estimate
  expires_at?: string; // ISO date for renewals
  metadata?: Record<string, string>; // freeform — billing email, plan tier, region
  notes?: string;
  created_at: string;
  updated_at: string;
}

// Backward compat: v1 PMADecision shape (used by existing /api/tasks code)
export interface AgentResponse {
  agent_name: string;
  capability_fit: number | null;
  load_fit: number | null;
  reason: string;
  fallback?: boolean;
}

export interface PMADecision {
  task_description: string;
  top1: string | null;
  top1_capability: number | null;
  top1_load: number | null;
  confidence: number;
  rationale: string;
  alternatives: string[];
  all_responses: AgentResponse[];
  reason_if_null?: string;
  mode?: ExecutionMode;
  ts: string;
}

export type QualityBar = 'demo' | 'internal' | 'external';
// Priority levels (P0 highest). Mapping:
// P0: 重要 + 紧急   — 立即处理，可中断当前工作
// P1: 重要 + 不紧急 — 战略级 stretch（最有杠杆）
// P2: 不重要 + 紧急 — 委派/AI 优先，可中断当前工作
// P3: 不重要 + 不紧急 — 默认 AI 处理或延后
export type Importance = 'high' | 'low';
export type Urgency = 'high' | 'low';
export type Priority = 'P0' | 'P1' | 'P2' | 'P3';

export function computePriority(importance: Importance, urgency: Urgency): Priority {
  if (importance === 'high' && urgency === 'high') return 'P0';
  if (importance === 'high' && urgency === 'low') return 'P1';
  if (importance === 'low' && urgency === 'high') return 'P2';
  return 'P3';
}

export function canInterrupt(p: Priority): boolean {
  return p === 'P0' || p === 'P1';
}

export const PRIORITY_LABEL: Record<Priority, string> = {
  P0: 'P0 · 重要 + 紧急',
  P1: 'P1 · 重要 + 不紧急',
  P2: 'P2 · 不重要 + 紧急',
  P3: 'P3 · 不重要 + 不紧急'
};

export const PRIORITY_GUIDANCE: Record<Priority, string> = {
  P0: '立即处理。挑最稳的承接人单点突破。可打断该人当前工作。允许跨团队请求资源。',
  P1: '战略级，最有杠杆。给成长曲线上的人 stretch。多轮深度推演。',
  P2: '委派或并行。优先 AI agent；其次找 capacity 高的人。可打断该人当前工作。',
  P3: '默认 AI 批处理或延后。除非真人有学习兴趣，否则不投入主力时间。'
};

// Sim strategy chosen per priority — replaces the dual-track optimistic/skeptical
// approach. Each strategy is a single converging line of reasoning, but with
// different policies (whom to include, how many rounds, who reviews).
export type SimStrategy = 'concentrated' | 'delegate' | 'stretch_review' | 'ai_batch';

export const STRATEGY_BY_PRIORITY: Record<Priority, SimStrategy> = {
  P0: 'concentrated',
  P1: 'stretch_review',
  P2: 'delegate',
  P3: 'ai_batch'
};

export const STRATEGY_LABEL: Record<SimStrategy, string> = {
  concentrated: '集中承接',
  delegate: '委派优先',
  stretch_review: '成长导向',
  ai_batch: 'AI 批处理'
};

export const STRATEGY_DESCRIPTION: Record<SimStrategy, string> = {
  concentrated: '挑最稳的人主做。短轮快速收敛。可打断对方当前工作。',
  delegate: '优先把任务交给 AI agent。如不适合 AI，找当前 load 最低的人。',
  stretch_review: '给成长曲线上的人 stretch 机会主做。允许多轮迭代。',
  ai_batch: '默认全交给 AI agent。短轮（1-2 round）确认 capacity 即可。'
};

export const STRATEGY_ROUNDS: Record<SimStrategy, number> = {
  concentrated: 3,
  delegate: 2,
  stretch_review: 4,
  ai_batch: 2
};

// Nature of the work — drives ai_eligibility heuristic and skill match.
export type TaskKind =
  | 'code'        // 编码 / 重构 / 修 bug
  | 'research'    // 调研 / 学习 / 数据分析
  | 'writing'     // 文档 / PR / 邮件 / 帖子
  | 'design'      // 视觉 / 交互 / 信息架构
  | 'comms'       // 跨团队沟通 / 客户对话 / 谈判
  | 'ops'         // 运维 / 流程跑批 / 后台操作
  | 'experiment'  // 跑实验 / A/B / 试错
  | 'strategy'    // 战略决策 / 优先级排序
  | 'mixed';      // 多模态 — 倾向拆分

// Where AI agent (Claude Code) fits.
export type AIEligibility =
  | 'full'        // 全交 AI（编码、批量数据、跑脚本）
  | 'assisted'    // AI 辅助，人主驾驶（写作、调研）
  | 'human_only'; // 必须人来（战略决策、客户沟通、信任关系）

// How human + AI cooperate on this task.
export type CollabTopology =
  | 'solo'      // 一个人 / 一个 agent 单干
  | 'split'     // 拆子任务并行
  | 'pair';     // 结对，实时协作

// How recommended candidate executes.
export type ExecutionMode =
  | 'human_only'  // 纯人，agent 不参与
  | 'agent_led'   // agent 主做（一等公民）
  | 'co_pilot'    // 人驾驶，agent 实时辅助
  | 'split';      // 子任务路由到不同 Pair

export interface TaskBrief {
  description: string;
  start_at?: string; // ISO date YYYY-MM-DD; default = today
  deadline?: string; // ISO date YYYY-MM-DD; required for rollout
  estimated_effort_days?: number; // person-days, fractional ok (0.5)
  quality_bar?: QualityBar;
  importance?: Importance;
  urgency?: Urgency;
  dependencies?: string[]; // task IDs or freetext blockers
  inputs_ready?: boolean; // material ready or research first
  failure_cost?: 'soft' | 'hard'; // soft deadline vs hard
  stakeholders?: string[]; // who reviews/approves
  // Nature — LLM extracted from description, drives recommendation mode.
  task_kind?: TaskKind;
  ai_eligibility?: AIEligibility;
  collab_topology?: CollabTopology;
  required_skills?: string[]; // skill tags the LLM extracts
}

export interface Task extends TaskBrief {
  id: string;
  decision: PMADecision | PMADecisionV2 | null; // null while推演ing
  status: 'predicting' | 'predicted' | 'accepted' | 'overridden' | 'completed';
  sim_id?: string; // when status === 'predicting', points to live sim
  override_to?: string;
  override_reason?: string;
  created_at: string;
  updated_at: string;
}

export interface TimelineEvent {
  ts: string;
  type:
    | 'task_predicted'
    | 'task_overridden'
    | 'task_accepted'
    | 'evolution_applied'
    | 'bootstrap'
    | 'override'
    | 'agent_action'
    | 'sim_started'
    | 'sim_completed';
  agent_name?: string;
  task_id?: string;
  sim_id?: string;
  round_num?: number;
  track?: Track;
  summary: string;
  detail?: Record<string, unknown>;
}

export interface EvolutionDiff {
  agent_name: string;
  patches: Array<{ op: 'add' | 'replace' | 'remove'; path: string; value?: unknown; old?: unknown }>;
  human_summary: string[];
}

export interface BootstrapStatus {
  phase: 1 | 2 | 'idle' | 'done' | 'error';
  current: number;
  total: number;
  message: string;
  started_at: string;
  finished_at?: string;
  error?: string;
}

// Report Agent chat session
export interface ReportSessionTurn {
  role: 'user' | 'report_agent';
  content: string;
  ts: string;
}

export interface ReportSession {
  sim_id: string;
  decision: PMADecisionV2;
  conversation: ReportSessionTurn[];
  mini_sims_run: string[];
}

// Constants
export const EVOLVABLE_PATH_PREFIXES = [
  '/workload',
  '/energy',
  '/collab',
  '/trajectory',
  '/recent_overrides',
  '/recent_praises',
  '/recent_objections',
  '/capabilities'
];

export const ENERGY_LEVELS: Energy[] = ['high', 'normal', 'low', 'burnt', 'unknown'];
export const SCHEMA_VERSION = 2;
export const ALL_ACTION_TYPES: ActionType[] = ['BID', 'DEFER', 'RECOMMEND_SPLIT', 'OBJECT', 'COMMIT', 'REFINED_BID'];
export const ALL_TRACKS: Track[] = ['optimistic', 'skeptical'];
