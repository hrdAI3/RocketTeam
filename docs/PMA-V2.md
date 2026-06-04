# PMA v2 — 「模拟即预测」真闭环版设计稿

**Status:** draft · 2026-05-18
**Owners:** team
**Supersedes:** PMA v1 (`src/pma/coordinator.ts`)

---

## 1 · 立场

"模拟即预测"是项目核心信念。参考 Aaru：persona 高保真 + 多轨迹采样 → 涌现预测。

v1 名义上是模拟，实际是 **LLM 一次自评 + 规则选 top1**。三大缺陷：

1. **persona 凭 prompt 编故事** — `personalAgentSystemPrompt()` 只塞了 profile JSON，agent 凭空打分 0-10
2. **一锤子，不是 Monte Carlo** — 每候选 1 次推理，没有分布、没有方差
3. **没闭环** — 预测完不回流，永远学不会校准

v2 目标：把这三件做对。

---

## 2 · 北极星指标

| 指标 | v1 | v2 目标 |
|---|---|---|
| top1 命中率 (predicted = actual assignee) | 未度量 | ≥ 65% (3 月内) |
| 完成时间预言误差 (MAPE) | N/A | ≤ 30% |
| Calibration 误差 (置信度 vs 实际成功率) | N/A | ≤ 0.10 |
| 卡点预言命中率 (predicted stuck_topic ⊃ actual) | N/A | ≥ 40% |
| 每次预测成本 | ~N agents × LLM | ≤ 2× v1 (vector 路免费) |

---

## 3 · 架构 — 四层

```
┌─────────────────────────────────────────────────────────────┐
│ L0  DATA  事件层 (append-only jsonl)                         │
│      cc.tool_result · cc.session_recap · cc.quota_snapshot   │
│      task.outcome · prediction.made · prediction.observed    │
└─────────────────────────────────────────────────────────────┘
                            ▲
                            │ outcome 回流
┌─────────────────────────────────────────────────────────────┐
│ L1  INDEX  行为索引层 (nightly cron, snapshot 落盘)           │
│      ToolUsageVector · StuckTopics · ReworkRate              │
│      DurationModel · CollabSuccess · QuotaState              │
│      CalibrationTable                                        │
└─────────────────────────────────────────────────────────────┘
                            ▲
                            │ 读
┌─────────────────────────────────────────────────────────────┐
│ L2  FINGERPRINT  任务指纹层 (per task, 24h cache)             │
│      skills_needed · tools_needed · risk_topics              │
│      estimated_effort · importance/urgency                   │
└─────────────────────────────────────────────────────────────┘
                            ▲
                            │ 喂
┌─────────────────────────────────────────────────────────────┐
│ L3  PREDICT  预测层 (三路融合 + Monte Carlo)                  │
│   A. vector_match   (cosine, 0 token)                        │
│   B. persona_eval   (LLM 自评, behavior-grounded prompt)     │
│   C. trajectory_mc  (N=20 仅 top-K, 输出分布)                │
│   → fuse → calibrate → Decision + Trajectory                 │
└─────────────────────────────────────────────────────────────┘
                            │
                            ▼
                    PMADecisionV2 + 多人轨迹
```

---

## 4 · L0 数据闭环 — 必抓事件

### 4.1 现有 4 路 extractor (复用，不重写)
- **CC** (`src/extractors/cc_session.ts`): `cc.token_usage` · `cc.tool_called` · `cc.stuck_signal` · `cc.session_started/ended`
- **GitHub** (`src/extractors/github.ts`): `gh.pr_opened/merged` · `gh.review_requested/submitted` · `gh.commit_pushed`
- **Slack** (`src/extractors/slack.ts`): `slack.mention` · `slack.question_unanswered` · `slack.channel_activity`
- **Meeting** (`src/extractors/meeting.ts`): `meeting.action_item` · `meeting.name_mentioned` · `meeting.decision`

### 4.2 必须补 (M1) — 跨 4 源

**CC 侧**

| 事件 | 来源 | 字段 |
|---|---|---|
| `cc.tool_result` | PostToolUse hook | `tool, exit_code, latency_ms, error_summary?` |
| `cc.session_recap` | SessionEnd hook (stop_hook_summary frame) | `duration_ms, files_changed[], tokens, stuck_count, completed?` |
| `cc.quota_snapshot` | 每会话末 + 每日 cron | `agent_name, used_cny, limit_cny, period_resets_at` |

**GitHub 侧**

| 事件 | 来源 | 字段 |
|---|---|---|
| `gh.ci_failed` | workflow run API (schema 已定义未发) | `pr, workflow, failed_jobs[], duration_ms` |
| `gh.pr_scope` | PR diff stat | `pr, loc_added, loc_deleted, files_changed, dirs_touched[]` |
| `gh.commit_revert` | commit message 含 "Revert" 或 force-push | `repo, commit, reverts` (rework 强信号) |
| `gh.review_comment_depth` | review API comments[] | `pr, reviewer, n_comments, n_blocking` |

**Slack 侧**

| 事件 | 来源 | 字段 |
|---|---|---|
| `slack.thread_resolved` | unanswered 后被回复 (反事件) | `thread_ts, resolved_by, latency_min` |
| `slack.reaction` | reaction_added | `msg_ts, user, emoji, target_user` (sentiment + 协作信号) |
| `slack.decision_marker` | text 含 `DECIDED:` / `决定:` | `thread_ts, summary, owner?` |
| `slack.help_request` | `?` + @mention 模式 | `asker, asked, topic` |

**Meeting 侧**

| 事件 | 来源 | 字段 |
|---|---|---|
| `meeting.attendance` | transcript speaker 列表 | `meeting_id, attendees[]` |
| `meeting.speaker_time` | speaker 段落字数 | `meeting_id, person, char_count, dominance_ratio` |
| `meeting.decision_linked` | 离线 join meeting.decision × gh.pr (语义匹) | `decision_id, pr_url` (决策血脉) |

**任务 + 预测闭环 (跨源)**

| 事件 | 来源 | 字段 |
|---|---|---|
| `task.assigned` | services/tasks 状态机 | `task_id, agent, ts` |
| `task.outcome` | 同上 | `task_id, status, duration_d, blocked_minutes` |
| `task.rework_detected` | 离线 join: CC files_changed × 24h 内再改 + `gh.commit_revert` | `task_id, n_reworks` |
| `prediction.made` | coordinator v2 出口 | 整个 PMADecisionV2 |
| `prediction.observed` | outcome 监听器 join | `task_id, predicted, actual, match, time_error_d` |

### 4.3 落地点
所有事件走 `src/lib/events.ts` 的 mutex append，落 `private/events.jsonl`。新事件 schema 加进 `src/types/events.ts`。

---

## 5 · L1 行为索引层

新模块 `src/index/behavior.ts`。每晚 cron 跑一遍，按 agent × window 落快照：
`private/index/behavior_{YYYY-MM-DD}.json`

### 5.1 Schema

```ts
interface AgentBehaviorSnapshot {
  agent_name: string;
  window_days: 30 | 90;
  as_of: string;

  // === CC 来源 ===
  tool_usage: Record<string, number>;          // {Bash: 312, Edit: 89, ...}
  tool_failure_rate: Record<string, number>;   // {Bash: 0.04} (cc.tool_result.exit_code)
  tool_vector_normalized: number[];

  // === 跨源 stuck_topics (CC stuck_signal + gh.ci_failed cluster + slack.help_request topic + meeting blocker) ===
  stuck_topics: Array<{
    topic: string;
    count: number;
    sources: Array<'cc'|'gh'|'slack'|'meeting'>;   // 多源命中 = 强信号
    last_at: string;
    sample_quote: string;
  }>;

  // === 跨源 task_outcomes (task.outcome + gh.pr_merged 时长 + gh.commit_revert 计数) ===
  task_outcomes: {
    n_completed: number;
    n_aborted: number;
    n_reworked: number;
    duration_p50_days: number;
    duration_p90_days: number;
    rework_rate: number;
  };

  // === 跨源 collab_pairs (gh 共改 PR + slack mention + meeting co-attendance + reaction 互动) ===
  collab_pairs: Array<{
    with: string;
    success_rate: number;
    n: number;
    edge_weights: {
      gh_coauthor: number;        // 共改 PR 数
      gh_review_back_forth: number;
      slack_mention: number;
      slack_reaction: number;
      meeting_co_attended: number;
    };
  }>;

  // === GitHub 来源 ===
  gh_scope: {
    avg_loc_per_pr: number;
    dirs_touched: Record<string, number>;       // 路径前缀直方图 → domain 证据
    ci_failure_rate: number;
    avg_review_comments_per_pr: number;
  };

  // === Slack 来源 ===
  slack_signals: {
    avg_response_latency_min: number;           // 自己被 @ 后多久回
    unanswered_to_me: number;                   // 提的问题被晾着的数 (求助受阻)
    decisions_authored: number;                 // 自己主导 DECIDED: 次数
    reaction_received_rate: number;             // 别人给自己消息加 reaction 的比例 (社群温度)
  };

  // === Meeting 来源 ===
  meeting_signals: {
    attendance_rate: number;
    speaker_dominance_p50: number;              // 在场时占麦比例 (高=主导者, 低=安静)
    action_items_owned: number;
    decisions_authored: number;
    name_mention_received: number;              // 被他人提及次数 (影响力代理)
  };

  // === Quota ===
  quota: {
    used_cny: number;
    limit_cny: number;
    period_resets_at: string;
    headroom_ratio: number;
  };

  // === 跨源 energy 推断 ===
  energy_inferred: 'high'|'normal'|'low'|'burnt';
  // 规则 (多源加权, 任一过线即触发):
  //   CC tokens/hr 跌出 30d p20  → low contributor
  //   slack avg_response_latency_min > p80         → low contributor
  //   meeting speaker_dominance 突然降到自身均值的 50% → low contributor
  //   cc.stuck_signal/d > 3 OR gh.ci_failed/d > 2  → low contributor
  //   ≥3 个 low → burnt
  //   ≥1 个 low → low
  //   else normal / high (高需要 tokens/hr > p80 且 0 stuck)
}
```

### 5.2 Calibration Table
独立结构 `private/index/calibration.json`，每周 cron 更新：

```ts
interface CalibrationTable {
  as_of: string;
  n_predictions: number;

  // 分桶 — 预测置信度 vs 实际命中
  confidence_bins: Array<{
    range: [number, number];   // e.g. [0.7, 0.8]
    n: number;
    actual_top1_match_rate: number;
    actual_on_time_rate: number;
  }>;

  // 全局校准函数 (isotonic regression 拟合)
  isotonic_breakpoints: Array<{raw: number, calibrated: number}>;

  // 每人偏差
  per_agent_bias: Record<string, {
    capability_self_bias: number;   // 自评 - 实际 (正=高估)
    duration_bias: number;
  }>;
}
```

---

## 6 · L2 任务指纹层

新模块 `src/predict/fingerprint.ts`。

### 6.1 LLM 抽取一次（24h cache by hash of description）

```ts
interface TaskFingerprint {
  task_id: string;
  description_hash: string;

  skills_needed: Array<{skill: string, weight: number}>;  // {react: 0.8, css: 0.4}
  tools_needed: string[];        // ['Bash', 'Edit', 'WebFetch'] — 对 tool_vector
  risk_topics: string[];          // ['docker', 'aws-iam'] — 对 stuck_topics
  est_effort_days: number;
  est_tokens: number;

  quality_bar: 'demo'|'internal'|'external';
  importance: 'high'|'low';
  urgency: 'high'|'low';
  splittable: boolean;
  expected_subtasks?: string[];

  // === 跨源上下文锚定 (这是关键升级) ===
  linked_context: {
    // 任务描述里出现的 PR / issue / commit 引用 → 拉 GH 上下文
    gh_refs: Array<{type: 'pr'|'issue'|'commit', repo: string, id: string, title: string, files_touched?: string[]}>;
    // 任务描述里提到的人 / 任务来自的会议决策
    meeting_decisions: Array<{meeting_id: string, decision_text: string, owner?: string, ts: string}>;
    // 任务描述匹到的 slack 线程 (近 7d 含关键词)
    slack_threads: Array<{thread_ts: string, channel: string, summary: string, asker: string}>;
    // 同 dirs 历史 PR → 历史承接人
    historical_owners: Array<{name: string, n_prs: number, last_at: string}>;
  };

  extracted_at: string;
  extractor_version: string;
}
```

**linked_context 怎么填:** `fingerprint.ts` LLM 抽完基础字段后，并行做 4 个 lookup:
1. regex 抽 `#\d+` / `PR-\d+` / commit SHA → 查 events.jsonl 里的 gh.* 事件
2. 描述里出现的姓名 → 匹近 14d `meeting.action_item` / `meeting.decision` owner = 此人
3. 任务关键词 (topk 名词) → 全文匹近 7d `slack.help_request` / `slack.thread_resolved`
4. 描述里出现的文件 / 目录 → 匹 `gh_scope.dirs_touched` 历史承接人

---

## 7 · L3 预测层 — 三路融合

### 7.1 Path A · Vector match (0 token)

```ts
score_A(c) = cosine(fp.tools_needed_onehot, c.tool_vector_normalized)
           × (1 - tool_failure_rate_weighted(c, fp.tools_needed))
```

冷启动 friendly：30 天数据足够就用 30 天窗，否则退 90 天，再否则用 dept/role 先验。

### 7.2 Path B · Persona LLM eval (升级版)

**关键改动**：`personalAgentSystemPrompt()` 注入 behavior snapshot 摘要。

```ts
function personalAgentSystemPrompt(profile, snapshot, fingerprint): string {
  return `你是 ${profile.name} 的 personal agent。

[静态画像]
${JSON.stringify(profile, null, 2)}

[近 30 天行为快照 — 实测可信, 跨 CC/GH/Slack/Meeting 4 源]

CC 行为:
- 工具: Bash×${...} Edit×${...} (失败率 ${...}%)
- 卡点 (多源标记 *): ${snapshot.stuck_topics.slice(0,5).map(t => t.sources.length>=2 ? '*'+t.topic : t.topic).join(', ')}
- 完工节奏: 中位 ${...}d / p90 ${...}d / rework ${...}%
- quota 余 ${(snapshot.quota.headroom_ratio*100).toFixed(0)}%

GitHub 行为:
- 平均 PR 规模 ${snapshot.gh_scope.avg_loc_per_pr} 行
- 常改目录: ${topDirs(snapshot.gh_scope.dirs_touched, 3)}
- CI 失败率 ${(snapshot.gh_scope.ci_failure_rate*100).toFixed(0)}%
- 平均 review 评论数 ${snapshot.gh_scope.avg_review_comments_per_pr} (高=被挑刺多)

Slack 行为:
- @ 我后响应中位 ${snapshot.slack_signals.avg_response_latency_min}min
- 我提的问题被晾 ${snapshot.slack_signals.unanswered_to_me} 条
- 主导决策 ${snapshot.slack_signals.decisions_authored} 次

Meeting 行为:
- 出勤率 ${snapshot.meeting_signals.attendance_rate}
- 占麦比 p50 ${snapshot.meeting_signals.speaker_dominance_p50} (高=话语权)
- 承接 action item ${snapshot.meeting_signals.action_items_owned} 个
- 被他人提及 ${snapshot.meeting_signals.name_mention_received} 次

跨源 energy 推断: ${snapshot.energy_inferred}

[任务上下文锚]
${formatLinkedContext(fingerprint.linked_context)}
// 例: "此任务关联 PR#142 (auth/), 你近 30d 在 auth/ 改了 8 个 PR"
//     "会议 2026-05-10 王总点名了你做这块"
//     "slack 上李四上周在 #infra 问类似问题被晾 3 天"

模拟规则:
- 诚实评估, 引证据, 不夸大
- 评分必须引用至少 2 条不同源的快照证据 (CC + GH, 或 Slack + Meeting...)
- 多源命中的卡点 (带 * 的) 权重更高, 因为被独立验证过`;
}
```

输出仍为 `{capability_fit, load_fit, reason}`。

### 7.3 Path C · Monte Carlo trajectory (N=20, 仅 top-K=3)

新模块 `src/predict/trajectory_sim.ts`。

**算法**:
```
for each candidate c in topK_after(A,B):
  for run in 1..N=20:
    sample energy ~ snapshot.energy_distribution
    sample collab_partner ~ snapshot.collab_pairs (prob by success_rate)
    sample tool_budget ~ Poisson(fp.est_tokens × c.tool_efficiency)

    simulate_day_by_day:
      for d in 1..ceil(fp.est_effort_days × c.duration_bias):
        // 卡点采样
        for topic in fp.risk_topics:
          if topic ∈ c.stuck_topics:
            p_stuck = c.stuck_topics[topic].count / total_stuck
            if rand() < p_stuck: record stuck(topic, d)
        // 协作触发
        if rand() < 0.3 × collab_partner.success_rate:
          record collab(partner, d)

    record run_outcome(completed, duration, stucks, collabs, rework?)

  aggregate:
    p_complete_on_time = sum(completed within est_effort) / N
    duration_p50, p90
    predicted_stuck_topics = topic→p across runs
    expected_collab = partner→p across runs
    quota_breach_p = sum(used > limit) / N
```

每候选 N=20 是纯数学模拟，**不调 LLM**。耗时可忽略。

### 7.4 Fuse

```ts
// 配置式权重，可通过 calibration 调
const W = { vector: 0.25, llm_cap: 0.45, traj_success: 0.30 };

fused_capability(c) = W.vector × score_A(c)
                    + W.llm_cap × llm_eval(c).capability_fit / 10
                    + W.traj_success × traj.p_complete_on_time

fused_load(c) = 0.5 × (quota.headroom_ratio)
              + 0.3 × llm_eval(c).load_fit / 10
              + 0.2 × (1 - traj.quota_breach_p)

raw_confidence(c) = √(fused_capability × fused_load)
calibrated_confidence(c) = calibration.apply(raw_confidence(c))
```

### 7.5 决策规则

```
sort by calibrated_confidence DESC
gate: top1.fused_capability < 0.5 → null (reason: no_suitable)
gate: top1.fused_load < 0.2       → null (reason: all_burnt)
gate: top1.quota_breach_p > 0.6   → swap with alt or null (reason: quota_blocked)
alternatives = within 0.1 of top1
```

---

## 8 · L4 闭环

### 8.1 outcome listener (`src/services/prediction_outcome.ts`)

监听 `task.outcome` 事件，找对应 `prediction.made`，emit `prediction.observed`：

```ts
interface PredictionObservation {
  task_id: string;
  prediction_ts: string;
  outcome_ts: string;
  predicted_top1: string|null;
  actual_assignee: string|null;
  top1_match: boolean;
  predicted_duration_d: number;
  actual_duration_d: number;
  predicted_stuck_topics: string[];
  actual_stuck_topics: string[];
  stuck_recall: number;          // |intersection| / |actual|
  stuck_precision: number;
  rework_predicted: number;
  rework_actual: number;
  confidence_calibrated: number;
}
```

### 8.2 Weekly calibration job

`tools/cron/run_calibration.ts`：
- 拉 30 天 `prediction.observed`
- 按 confidence 分桶算实际命中率
- isotonic regression 拟合校准函数
- 更新 `private/index/calibration.json`

---

## 9 · Schema 完整版 — PMADecisionV2

```ts
interface PMADecisionV2 {
  task_id: string;
  fingerprint: TaskFingerprint;        // 嵌入

  // 决策
  top1: string | null;
  alternatives: string[];
  raw_confidence: number;
  calibrated_confidence: number;
  reason_if_null?: 'no_agents'|'no_suitable'|'quota_blocked'|'all_burnt';
  rationale: string;                    // LLM 写的解释

  // 候选画像
  candidates: Array<{
    name: string;
    is_ai_agent: boolean;

    // 三路得分
    score_vector: number;
    score_llm: { capability_fit: number; load_fit: number; reason: string };
    score_trajectory: {
      n_runs: number;
      p_complete_on_time: number;
      duration_p50_d: number;
      duration_p90_d: number;
      predicted_stuck_topics: Array<{topic: string; p: number}>;
      expected_collab: Array<{with: string; p: number}>;
      expected_rework: number;
      quota_breach_p: number;
    };

    // 融合
    fused_capability: number;
    fused_load: number;
    calibrated_confidence: number;

    // 引用
    behavior_snapshot_ref: string;       // path: index/behavior_YYYY-MM-DD.json#agent
  }>;

  ts: string;
  predictor_version: string;             // "pma-v2.0.0"
}
```

---

## 10 · 实施路径

### M1 — 数据闭环 (1 周, 解锁一切)

| # | 任务 | 文件 |
|---|---|---|
| 1.1 | PostToolUse hook 实现 + 通过 collector emit `cc.tool_result` | `Matrix-Riven/collector/...` + `.claude/hooks/` |
| 1.2 | SessionEnd hook emit `cc.session_recap` | 同上 |
| 1.3 | 扩展 `src/extractors/cc_session.ts` 解析新两种 | `src/extractors/cc_session.ts` |
| 1.4 | tasks 服务 emit `task.outcome` | `src/services/tasks.ts` |
| 1.5 | rework 离线 join（task.outcome × file edit 24h 内） | `src/services/rework_detect.ts` (新) |
| 1.6 | `prediction.made` & `prediction.observed` 落事件 | `src/services/prediction_outcome.ts` (新) |
| 1.7 | events.ts 扩 schema | `src/types/events.ts` |

**Exit criteria:** 一个完整 task 从 predict → assigned → completed → observed 在 `events.jsonl` 上能拼起来。

### M2 — 行为索引 + 任务指纹 (1 周)

| # | 任务 | 文件 |
|---|---|---|
| 2.1 | `behavior.ts` 6 个 builder | `src/index/behavior.ts` (新) |
| 2.2 | nightly cron | `tools/cron/build_behavior_index.ts` (新) |
| 2.3 | stuck_topics 聚类（用 small embedding model 或简单关键词） | `src/index/stuck_cluster.ts` (新) |
| 2.4 | `fingerprint.ts` + cache | `src/predict/fingerprint.ts` (新) |
| 2.5 | `personalAgentSystemPrompt` 注入 snapshot 摘要 | `src/pma/system_prompts.ts` |

**Exit criteria:** 任意一人能产出 `behavior_2026-05-18.json`；任意 task 能拿到 fingerprint。

### M3 — 三路融合 + Monte Carlo + 校准 (2 周)

| # | 任务 | 文件 |
|---|---|---|
| 3.1 | vector_match cosine | `src/predict/vector_match.ts` (新) |
| 3.2 | trajectory_sim N=20 | `src/predict/trajectory_sim.ts` (新) |
| 3.3 | fuse 加权 + gate | `src/predict/fuse.ts` (新) |
| 3.4 | calibrate isotonic | `src/predict/calibrate.ts` (新) |
| 3.5 | `coordinator_v2.ts` 装配 | `src/pma/coordinator_v2.ts` (新) |
| 3.6 | weekly calibration cron | `tools/cron/run_calibration.ts` (新) |
| 3.7 | 回放测试 (100 条历史 task) | `tests/predict/replay.test.ts` (新) |

**Exit criteria:** 历史 task replay：v2 top1 命中率 ≥ v1 + 10%。

### M4 — 上线 + 验证 (持续)

| # | 任务 | 备注 |
|---|---|---|
| 4.1 | `PMA_VERSION=v2` feature flag | `coordinator.ts` 路由 |
| 4.2 | dashboard：top1 命中率 / calibration / 轨迹召回 | `src/app/admin/predictions/` |
| 4.3 | 4 周后 v1 退役 | 删 `coordinator.ts`，rename v2 |

---

## 11 · 风险 + 缓解

| 风险 | 缓解 |
|---|---|
| LLM 多次调用成本 | fingerprint 24h cache；Monte Carlo 是纯数学不调 LLM；vector 路 0 token |
| 索引污染 | 每日快照按日存档，calibration 用历史快照不当下索引 |
| 冷启动数据稀疏 | vector 路冷启可工作；trajectory 退化为 1-shot；calibration 用全局先验 |
| stuck_topics 聚类质量差 | 先用关键词，accumulate 后升级 embedding；离线复跑可回填 |
| AI agent (Claude Code) 没有 stuck 信号 | 用 tool_result.exit_code != 0 + 重试次数代替 |
| Hook 没装 / 装错 / 版本飘 | 加 `hook.healthcheck` 事件每会话首报 hookVersion；missing 出 anomaly |

---

## 12 · 多源信号整合 — 5 个交叉模式

单源信号噪声大、易作弊。多源交叉是 v2 真正能甩开 v1 的地方。

### 12.1 Stuck 三角验证 (CC ∩ GH ∩ Slack)
单源 stuck = 假阳概率高 (CC 一句 "i'm stuck" 可能只是吐槽)。三源命中 = 必真。
```
张三 stuck on "aws-iam" 触发条件:
  CC: cc.stuck_signal 含 "aws"/"iam"/"creds"   (近 7d)
  GH: gh.ci_failed 在 infra/ 目录 PR             (近 7d)
  Slack: slack.help_request 中 @ ops 含 "权限"   (近 7d)
≥2 源命中 → stuck_topics[].sources.length ≥ 2 → 打 *, 模拟时权重 2x
```

### 12.2 Energy 多源融合 (CC + Slack + Meeting)
单源 energy 很噪。三源一致才下"burnt"判断。
```
CC tokens/hr 跌 + Slack 响应慢 + Meeting 占麦降 → burnt (高信度)
仅 CC 跌                                        → low (中信度)
任 1 源好 + 其余无信号                          → normal (无证据反证)
```

### 12.3 Collab Graph 多边加权
v1 `collab.pairs_well_with` 只有名字。v2 是带 5 类边权的图:
```
edge(张三, 李四) = {
  gh_coauthor: 12,             // 共改 PR 12 个
  gh_review_back_forth: 8,     // 互相 review 8 次
  slack_mention: 47,           // 互 @
  slack_reaction: 31,          // 互点 reaction (社群温度代理)
  meeting_co_attended: 23      // 共同出席
}
success_rate = (共改 PR 内 merged 数) / (共改 PR 总数)
```
Monte Carlo 模拟时, 协作伙伴采样按这些边权加权, 不是均匀。

### 12.4 Skills Evidence 跨源证据链
v1 `capabilities.skills` 是 hand-curated + LLM 总结, 易飘。v2 自动凑证据链:
```
张三 "react" skill, evidence 链:
  GH:      改 src/components/*.tsx 47 次, react-router 8 次 (gh_scope.dirs_touched)
  CC:      Edit *.tsx 312 次, 用 react 关键词工具调用 28 次
  Slack:   answered 12 个 #frontend 问题 (slack 提取的技术 Q&A)
  Meeting: 被点名讲 "前端架构" 3 次 (meeting.name_mentioned context)
strength = 4/4 源支持 → 强证据
```
LLM 不再 hand-wave "张三懂 react", 而是有 4 路独立观测。

### 12.5 Decision Lineage = 校准金矿
**这是闭环的关键发现:** 决策有明确血脉, 可追责。
```
meeting.decision (2026-05-10, "迁移到 postgres", owner: 张三)
  ↓ link by 语义匹 + 时间窗
gh.pr_opened (2026-05-12, "migrate to postgres", author: 张三)
  ↓ link by task_id
prediction.made (2026-05-09, predicted top1: 张三)
  ↓
gh.pr_merged (2026-05-22) ← 完成
  or
slack 后续 "张三这事还没动" + meeting 复盘 "X 没做完" ← 失败
```
**这条血脉是 calibration table 的最佳数据源** — 比任务系统自报 outcome 更难造假。
M3 实现时 `prediction.observed` 优先按 decision lineage 算 ground truth。

---

## 13 · 不做什么 (out of scope)

- 多 task 并发调度 (M5+)
- 跨团队 / 跨项目预测
- Real-time stream learning (calibration 是周级别 ok)
- 替代 sim/config_generator.ts 的高阶博弈 (那是另一条线，留着)

---

## 14 · 取舍说明

- **三路融合 ≠ 必须全跑**：vector 路对每个人都跑（廉价）；LLM 自评和 trajectory 只对 vector 路 top-K 跑。冷启时退化为「全员 LLM 自评」≈ v1。
- **Calibration 是周级别**：不追求实时，因为预测样本本来稀疏，日级别噪声大。
- **轨迹预测不替代决策**：人类 leader 看到「预测会在 docker 卡 70%」可以提前介入，这才是产品价值；不是要 100% 准。
