# Anomaly Engine + CC-Native Briefing — Design Spec (v4)

> Date: 2026-05-11
> Owner: dai
> Status: DRAFT — awaiting user review
> Supersedes: `UX-CC-FIRST.md` v2 (列表页双模式卡 / 折叠详情页方案) — v4 重新组织一级页面定位

---

## 0. TL;DR

产品定位从 v3 的「LLM-only `/today` briefing」升级为 v4「4 数据源 → Anomaly Engine → CC-Native Briefing」。

四个数据源进入后，原本被 cold read 判为「跑在 LLM narrative 上」的 9/10 anomaly 规则现在可以跑在真信号上：

| 源 | 状态 | 用途 |
|---|---|---|
| Slack | 已接 (existing `src/lib/slack.ts`) | 频道消息、提及、无回复 thread |
| GitHub | 部分接 (existing `src/lib/github.ts`) | RocketTeam / TeamBrain 两 repo 起步：PR、commit、review-pending |
| Meetings | 本地 txt (existing `src/lib/meetings.ts`) | 行动项、点名、决策 |
| **CC SESSIONS** | **新建** (external server `http://192.168.22.88:8080`) | 每人 CC 实际跑啥、token 用量、卡点自报、tool 调用 |

产品的主接口是 leader 笔记本上的 Claude Code，**不是 web**。MCP server 是一等公民，web 是可选 glance pane（推迟到 leader 主动要才建）。

四件套：
1. `team:today` MCP prompt — 三档异常 briefing
2. `team:flag` MCP tool — leader 真实兜底通道
3. `team:dispatch` MCP tool — 复用现有 parse + sim/start
4. `team:ask <agent>` MCP tool — 直接问某 personal agent

异常 = 9 条规则跑在 events.jsonl 上，severity 三档：act-now / next-glance / fyi。

---

## 1. 受众与诉求重定义

### 1.1 受众

- **User = 安子岩**（公司产品 + 研发负责人）。**唯一 UI 用户。**
- **Subjects = 24 名团队成员的 personal agents**（不是 UI 用户，跑在 PMA 下）。
- **Web 受众假设撤销**：UX-CC-FIRST.md §1.3「23 成员找彼此」是 demo 期假设，demo 已结束。23 人不再使用 web。

### 1.2 安子岩的两条诉求

1. 一级页面信息冗余太多，只想看异常。
2. 派任务在 web 输入累，希望 CC 里聊完直接 dispatch。

### 1.3 受众设计目标（按优先序）

1. **CC-native primary**：leader 主要在他笔记本 CC 里完成所有动作。零二次输入。
2. **Pull on demand**：leader 自定节奏 (`/loop /today 30m`)，无系统主动 push。
3. **Web 是 read-only glance**（推迟到 leader 主动要才建）：当前所有页面降级为「深入」folder，给 leader 当 debug pane。

---

## 2. 架构

### 2.1 层次图

```
┌─ 4 Sources ─────────────────────────────────────────────────┐
│  GitHub        Slack       Meetings    CC SESSIONS          │
│  (REST + poll) (existing)  (local txt) (192.168.22.88:8080) │
└─────┬────────────┬───────────┬──────────────┬───────────────┘
      ▼            ▼           ▼              ▼
┌─ Signal Extractors (src/extractors/*) ─────────────────────┐
│  per-source: normalize → typed events                       │
└────────────────────────────┬───────────────────────────────┘
                             ▼
              ┌─ events table (unified timeline) ─┐
              │ {seq, ts, source, type, subject,   │
              │  evidence, raw_ref}               │
              └─────┬────────────────────────────┘
                    │
        ┌───────────┴────────────┐
        ▼                        ▼
┌─ Auto-evolve fn ─┐    ┌─ Anomaly Engine ──────┐
│ per-event route  │    │ 9 rules over events    │
│ to personal      │    │ → typed anomalies      │
│ agent profile    │    │ → events.anomaly       │
└──────────────────┘    └────────────┬──────────┘
                                     ▼
              ┌──────────────────────────────────┐
              │ team:today prompt                │
              │   inputs: open anomalies +       │
              │           recent events +        │
              │           leader-attested flags  │
              │   output: act-now/next-glance/   │
              │           fyi markdown           │
              └────────────────────┬─────────────┘
                                   ▼
                  ┌────────────────────────────┐
                  │  MCP Server                 │
                  │   - team:today (prompt)     │
                  │   - team:flag (tool)        │
                  │   - team:dispatch (tool)    │
                  │   - team:ask (tool)         │
                  │   - team:resolve (tool)     │
                  └────────────────┬───────────┘
                                   ▼
                  ┌────────────────────────────┐
                  │  Leader's CC                │
                  │   /loop /today 30m          │
                  │   /dispatch <ctx>           │
                  │   /flag <concern>           │
                  └────────────────────────────┘
```

### 2.2 模块边界

- `src/extractors/<source>/` — 拉数据，吐 events，无业务逻辑。
- `src/lib/events.ts` — events 读写 + cursor 管理（per-source last-synced）。
- `src/anomaly/` — 9 条规则函数 + engine 调度。纯函数 over events。
- `src/evolve/` — 事件路由到 personal agent profile，触发 LLM evolve。
- `src/mcp/` — MCP server，5 个工具/prompt。
- `src/app/api/today/route.ts` — `team:today` 的 HTTP 镜像（给 web glance 留接口，但 web 暂不建）。

依赖方向：API/MCP → services (anomaly/evolve/today) → infra (events + agents + tasks) → extractors。

### 2.3 数据持久化

短期：复用现有 jsonl/json 文件 + 加 `data/events.jsonl` 统一时间线。
长期：按 BACKEND-REDESIGN.md §3 迁 SQLite。本 spec 不依赖 SQLite。`events` 用 jsonl + 文件锁（同 `src/lib/timeline.ts` 模式）。

---

## 3. Events 模型

### 3.1 统一 event schema

```ts
type Event = {
  seq: number;                                // 自增
  ts: string;                                 // ISO8601
  source: 'github' | 'slack' | 'meeting' | 'cc_session' | 'system' | 'leader';
  type: string;                               // 见 §3.2
  subject: {
    kind: 'agent' | 'task' | 'sim' | 'repo' | 'channel' | 'meeting' | 'system';
    ref: string;                              // agent name | task id | repo name | etc
  };
  actor?: string;                             // 操作者，agent name / email / 'system'
  evidence: {
    quote?: string;                           // 原文（meeting / slack message / CC session msg）
    fields?: Record<string, unknown>;         // 结构化字段（PR number / commit sha / sim id）
  };
  raw_ref?: string;                           // 回链：URL / 文件路径 / session id
};
```

存储：`data/events.jsonl`（append-only，mutex 保护）。读端按 `seq` 顺序。

### 3.2 Event types（v1）

GitHub:
- `gh.pr_opened`、`gh.pr_merged`、`gh.pr_closed`
- `gh.review_requested`、`gh.review_submitted`
- `gh.commit_pushed`、`gh.ci_failed`

Slack:
- `slack.mention`（被点名）
- `slack.question_unanswered`（>12h 无回复 thread）
- `slack.channel_activity`（统计型，每日一条 summary）

Meeting:
- `meeting.action_item`（行动项）
- `meeting.name_mentioned`（点名）
- `meeting.decision`

CC SESSIONS:
- `cc.session_started`、`cc.session_ended`
- `cc.token_usage`（每 session 一条总量）
- `cc.tool_called`（commit、edit、test、run 等大类）
- `cc.stuck_signal`（含「等」「拿不到」「权限」等卡点关键词）
- `cc.topic_extracted`（每 session 一条 topic summary）

System / Leader:
- `task.created`、`task.dispatched`、`task.accepted`、`task.overridden`、`task.completed`
- `sim.predicted`、`sim.committed`
- `agent.evolved`
- `leader.flag`（来自 `team:flag`）
- `anomaly.opened`、`anomaly.resolved`、`anomaly.snoozed`

### 3.3 Subject 解析（critical）

CC SESSIONS / GitHub / Slack 各有自己的用户标识：

| 源 | 用户标识 | 解析到 agent name |
|---|---|---|
| CC SESSIONS | email (`duck@libz.ai`) | `src/lib/identity.ts` 维护 email ↔ name 映射表 |
| GitHub | login (`zhouzy90`) | 同上 |
| Slack | user_id (`U01ABC`) | 同上 + slack name 兜底 |
| Meeting | 文字姓名 | 直接对 |

`src/lib/identity.ts` v1 用静态 JSON 映射：

```json
{
  "邮箱": {
    "duck@libz.ai": "戴昊然",
    "thomas@libz.ai": "孙润峰",
    "liboze2026@163.com": "李博泽"
  },
  "github": { "zhouzy90": "周子焱" },
  "slack": { "U01ABC": "安子岩" }
}
```

未知用户 → event 仍记录，subject.ref = raw identifier，留 unresolved。

---

## 4. Extractors

### 4.1 CC SESSIONS extractor (`src/extractors/cc_session/`)

API contract (探测确认):

```
GET /api/users                             → { users: string[] }
GET /api/dates?user=<email>                → { dates: ["YYYY-MM-DD"] }
GET /api/sessions?user=<email>&date=<d>    → { sessions: [{id, ext, size, mtime}] }
GET /api/file?user=<email>&date=<d>&id=<sid>&ext=<jsonl> → raw bytes
```

Sync 策略：
- 每 5 min 跑一次 `syncCcSessions()`
- 维护 cursor `data/sync_state/cc_sessions.json`: `{ [email]: { last_synced_mtime } }`
- 对每个 user：列 dates（近 30d），对每 date 列 sessions，对每 session 拉 file，解析为 events
- 已解析过的 session（mtime ≤ cursor）跳过

解析（每行 jsonl）→ events:
- session header → `cc.session_started`
- tool_use 类型 → `cc.tool_called`（按 tool name 归类）
- assistant message 含 stuck 关键词 → `cc.stuck_signal`
- usage 字段累计 → `cc.token_usage`（每 session 末尾出一条）
- session end → `cc.session_ended` + 一条 LLM-summarized `cc.topic_extracted`（异步，单独 worker）

**容错**：当前 endpoint 数据是 smoke test（`{"after":"hardening"}` / `{"hello":"jushi"}`），不是真 CC 格式。Extractor 写成 defensive：未知 schema → 落到「raw_session_blob」event，不阻塞 sync。真格式上线后补 parser。

### 4.2 GitHub extractor (`src/extractors/github/`)

起点 repo：`RocketTeam`、`TeamBrain`（来自用户指示）。

Endpoint:
- 复用现有 `src/lib/github.ts` token vault
- REST API：`/repos/{owner}/{repo}/events`、`/repos/{owner}/{repo}/pulls`、`/repos/{owner}/{repo}/commits`

Sync 策略：每 10 min 拉一次。cursor 用 ETag + `since` 参数。

Events:
- `PullRequestEvent` open/close/merge → `gh.pr_*`
- `PullRequestReviewRequestedEvent` → `gh.review_requested`
- `PushEvent` → `gh.commit_pushed`
- CI（check_run failed）→ `gh.ci_failed`

Subject 解析：`actor.login` → identity.ts → agent name。未知 login 仍记 raw。

### 4.3 Slack extractor (`src/extractors/slack/`)

已接，但 events 化未做。当前 `src/lib/slack.ts` 只存 transcript blobs。

Sync 策略：复用现有 `auto_sync_interval_min`（默认 15 min），跑 `syncSlackToEvents()`。

Events:
- mention（消息含 `<@U...>`）→ `slack.mention`
- thread root 无 reply > 12h → `slack.question_unanswered`（运行时扫描）
- daily summary → `slack.channel_activity`

Subject 解析：slack user_id → identity.ts。

### 4.4 Meeting extractor (`src/extractors/meeting/`)

输入：`team/private/context/meeting/*.txt`（已有 10 份）。

Sync 策略：file watcher（fs.watch）+ 每 30 min 兜底全量扫描。已处理过的文件以 hash 记录在 `data/sync_state/meetings.json`。

Parse：调 LLM 一次，输出结构化 list：

```json
{
  "action_items": [{ "owner": "黄运樟", "task": "...", "quote": "..." }],
  "name_mentioned": [{ "name": "戴昊然", "context": "...", "quote": "..." }],
  "decisions": [{ "desc": "...", "quote": "..." }]
}
```

每项一条 event。LLM prompt 模板在 `src/extractors/meeting/prompts.ts`。

---

## 5. Anomaly Engine

### 5.1 9 条规则

每条规则是纯函数 `(events: Event[], state: AnomalyState) => Anomaly[]`。

| ID | Rule | Trigger | Source | Severity hint |
|---|---|---|---|---|
| `blocked.cc_attested` | Stuck in CC session ∧ no progress in 24h | CC + GitHub | act-now |
| `blocked.review_pending` | PR review-requested > 24h | GitHub | next-glance |
| `blocked.slack_silent` | Question in #project-X > 12h no reply | Slack | next-glance |
| `dispatch.uncertain` | sim confidence < 60% ∧ status = predicted | system | act-now |
| `override.spike` | 7d override rate > 40% per dept boundary | events | next-glance |
| `deadline.at_risk` | (deadline − now) < real_remaining_estimate | CC + sim | act-now |
| `conflict.same_file` | 2+ agents touched same file/path within 48h | CC + GitHub | next-glance |
| `profile.stale` | bootstrap > 30d ∧ ≥ 5 unfolded events | events | fyi |
| `quota.threat` | weekly token / monthly quota > 0.85 | CC | next-glance |
| `silence.named` | meeting mention ∧ CC session > 7d | meeting + CC | next-glance |

Severity hint 是规则默认值，最终档位由 `team:today` LLM 依「leader 当前焦点」重排。

### 5.2 Anomaly entity

```ts
type Anomaly = {
  id: string;                                  // `anom_${rule}_${subject.ref}_${first_ts}`
  rule: string;                                // 见 §5.1 ID
  subject: { kind, ref };
  status: 'open' | 'snoozed' | 'resolved' | 'dismissed';
  severity_hint: 'act-now' | 'next-glance' | 'fyi';
  triggered_at: string;                        // 首次触发
  last_seen_at: string;                        // 最近重新满足
  evidence_event_seqs: number[];               // 指向 events.seq
  suggested_actions: Array<{
    id: string;                                // e.g. 'reassign' | 'open' | 'snooze_24h'
    label: string;
    tool: string;                              // 对应 MCP tool 名
    args?: Record<string, unknown>;
  }>;
  resolution?: {
    action: string;
    by: 'leader' | 'system';
    at: string;
    outcome?: string;
  };
};
```

存储：`data/anomalies.jsonl`（append-only state log）+ `data/anomalies.current.json`（当前 open 快照，由 reduce 生成）。

### 5.3 Engine 调度

`src/anomaly/engine.ts`:
- 每 5 min 跑一次 `evaluateAll()`
- 增量：只读 events.seq > last_evaluated_seq
- 状态机：
  - 规则首次满足 → 写 `anomaly.opened` event + 创建 Anomaly
  - 仍满足 → 更新 last_seen_at（不重复写 opened）
  - 不再满足且 status=open → 自动 resolved（写 `anomaly.resolved` + outcome=`auto_cleared`）
  - leader 调 `team:resolve` → 写 `anomaly.resolved` + outcome=user action
  - leader 调 `team:snooze` → status=snoozed 至 until

### 5.4 De-dupe + 噪声控制

- 同 subject 同 rule 24h 内不重复开新 anomaly（合并）
- leader 连续 3 次对同 rule 调 `dismiss` → 自动 raise threshold（写入 `data/rule_overrides.json`）

---

## 6. MCP Server

### 6.1 Server 起步

- TS 实现，位于 `src/mcp/server.ts`
- stdio transport（leader laptop 直接 spawn 进程，不暴露端口）
- 复用 Next.js services（直接 import services 层，不走 HTTP）

### 6.2 Tools / Prompts / Resources

**Prompt: `team:today`**
- 无参数
- 服务端组装：当前 open anomalies + 近 48h leader.flag + 近 7d 关键 events 摘要
- LLM (Anthropic API) 出三档 markdown briefing
- 输出 schema：见 §7

**Tool: `team:flag(text: string, severity_hint?: 'act-now'|'next-glance'|'fyi')`**
- 写一条 `leader.flag` event
- 下次 `team:today` 顶置
- 不创建 Anomaly entity（leader 自己的话不算结构化异常）

**Tool: `team:dispatch(brief: string)`**
- 复用 `/api/tasks/parse` + `/api/sim/start`
- 缺字段 → MCP 反问 leader（CC 自然对话）
- 返回 `{ sim_id, task_id, url }`

**Tool: `team:ask(agent: string, question: string)`**
- 复用 personal agent MCP query
- 返回 agent state 投射 + LLM 回答

**Tool: `team:resolve(anomaly_id: string, action_id: string, args?)`**
- 执行 anomaly 的 suggested_action
- 写 `anomaly.resolved` event
- 副作用按 action 类型走（reassign → `tasks/[id]/override`；snooze → status flip）

**Resources**:
- `anomaly://current` → 当前 open list
- `agent://{name}/state` → profile JSON
- `task://{id}/sim` → sim run state
- `events://recent?source=&since=` → events feed

---

## 7. `team:today` 输出契约

```markdown
# 你的 5/11

> 上次跑：2026-05-11 09:14（4 小时前 · 期间 +2 override / +1 阻塞 flag / +5 新任务）

## 现在该看 (act-now)

### 🟥 张三 / auth middleware · 阻塞 (blocked.cc_attested)
- 引「这个权限到现在还没给我，我先把别的做了」（duck@libz.ai 5/9 22:30 session）
- 24h 无新 commit（GitHub RocketTeam）
- PR #432 review-requested (孙润峰，> 28h)

建议：
- `team:resolve anom_blocked_xxx reassign --to 田皓轩`
- `team:ask 张三 "auth middleware 的权限问题现在卡在谁那里？"`

### 🟥 sim_8a3 (5/20 PPT) · 等你拍板 (dispatch.uncertain)
- 置信 52%（黄/田 各占一半）
- 缺紧急度信号

建议：
- `team:resolve anom_dispatch_8a3 accept_top1`
- `team:resolve anom_dispatch_8a3 open_sim`

## 顺手看 (next-glance)

### 🟧 override.spike · 7d 45%（集中「研发→运营」边界）
- sim_8a3 / sim_9b1 / sim_a0f
- 原因 sample：「ops 没人有 Python」

建议：
- `team:resolve anom_override_spike open_trend`

### 🟧 silence.named · 戴昊然
- 5/8 会议「H5 着色器」点名分派，CC session > 8 天无活动
- 最近一次 commit: 5/3

建议：
- `team:ask 戴昊然 "你 H5 着色器那边现在怎么样？"`
- `team:flag "戴昊然进度盯一下"`

## 顺便知道 (fyi)

- profile.stale: 孙润峰 (35d)
- 昨日 派 3 接 1 拒 0 阻 1
- @leader 你 5/10 flag「520 这周必须有 demo」未变状态
```

### 7.1 排档逻辑

LLM 拿 anomalies + severity_hint，再依：
1. leader 历史对同 rule 类型的 dismiss 比例（越多 → 越下沉）
2. 触发时间新鲜度
3. 当前是否在 leader-flagged 主题上下文

输出三档。LLM 不被允许编造 anomaly（必须每条引用 anomaly_id），不被允许引用未在输入里的 evidence。

---

## 8. 自动 evolve 闭环

### 8.1 Event → profile 路由

`src/evolve/router.ts`:

| Event type | → profile 字段 |
|---|---|
| `cc.tool_called`（重复模式）| `capabilities[].tools` |
| `cc.topic_extracted` | `current_focus`、`recent_topics` |
| `gh.pr_merged` | `past_tasks`（含 quote）|
| `slack.mention`（高频）| `frequent_collaborators` |
| `meeting.action_item`（owner=self）| `workload.active`（标 `source: meeting:{id}`）|
| `task.overridden`（target=self）| PMA prompt 加一条 fewshot |

### 8.2 Evolve 触发

- 每小时跑一次 `runEvolveCycle()`
- 对每个 agent：聚合本小时入站 events
- 若达阈值（≥ 3 新 event 或 ≥ 1 高重要度 event）→ 调 LLM evolve
- 写新 profile + `agent.evolved` event + bump `_meta.evolution_count`

### 8.3 Override 反向

`task.overridden` 直接走快路径：
- target agent 加 `past_tasks.{...自动总结}`
- PMA prompt 表里加 `assignment_lessons.jsonl` 一条

---

## 9. 沟通模型（push vs pull）

**Pull-only by default**：
- Leader 用 CC `/loop /today 30m` 自定节奏
- 无服务器 push、无桌面通知、无邮件、无 IM
- Vacation 回归 = 跑一次 `team:today`，顶部带「期间累计」digest

**Push 通道暂不建**。理由：
- 单人产品不需要 SLA-style on-call
- 建 push 需要桌面通知 / IM webhook / 邮件之一，全是基建
- 等 leader 用一段时间后主动说「我希望被打断」再补

**例外**：若 leader 主动 `team:subscribe`（未实现，留 hook），可推到他指定 channel（Slack DM / ntfy）。

---

## 10. 沿用 / 降级 / 砍

### 10.1 沿用

- `src/lib/slack.ts` / `src/lib/github.ts` / `src/lib/meetings.ts` token + config
- `src/lib/agents.ts` profile 读写
- `src/lib/tasks.ts` task 读写
- `/api/tasks/parse` + `/api/sim/start` 任务流水（dispatch tool 复用）
- `/api/tasks/[id]/override` + `/api/tasks/[id]/accept`（resolve action 复用）
- PMA / Bootstrap / Evolution LLM prompts（不动）

### 10.2 降级

- `/agents` `/tasks` `/sim` `/timeline` `/meetings` `/sources` 全部从一级 sidebar 移到「深入」folder，给 leader 当 debug pane（**保留功能，不删数据**）
- `/sim` 用途从「预测分配主路径」改为「决策审计 + 候选展示」（leader 仍可 drill-down 看为什么 PMA 这么分）
- web root `/` → 暂保持 redirect 到 `/agents`（不改），等 web glance pane 建好再改

### 10.3 砍

- 「LLM-only `/today`」v3 妥协方案（4 源进来后不需要）
- P0-P3 severity（改 act-now/next-glance/fyi）
- 全局 push 通道（暂不建）
- velocity 预测模型（deferred，需 ≥ 3 个月积累）
- bandit-ranked inbox / multi-leader / quiet hours（全 deferred）

---

## 11. 隐私 / 同意

CC SESSIONS 是 24 人的真实 CC 对话记录。隐私敏感度最高。本 spec 假设：

1. **同意机制已由 collector server (192.168.22.88:8080) 一侧解决**。每人是否上传由该服务自身管理。本系统是消费者，不负责 opt-in UI。
2. **本系统对 session 数据的使用范围**：
   - 抽 events（不存原文 jsonl 长期，只存 evidence quote 片段）
   - 喂 LLM evolve（送给 Anthropic API）
   - 喂 LLM `team:today` summary
3. **后续要建的（不在本 spec 范围）**：
   - 用户「我的数据」入口（查 events、删 events）
   - sensitive_flag 客户端机制（让某 session 不传）
   - 数据保留期策略（默认 90d）
4. **审计**：所有对 cc_session 数据的内部使用走 `data/audit.jsonl`。

如同意机制尚未在 collector 一侧落地，**先只对自愿名单的 N 个 user 接入**，名单写在 `data/cc_session_allowlist.json`。

---

## 12. Build Order

| 阶段 | 内容 | 工期 | 依赖 |
|---|---|---|---|
| **P1** | `src/lib/events.ts` 统一 event 读写 + `src/lib/identity.ts` 映射表 | 1d | 无 |
| **P2** | CC SESSIONS extractor（含 defensive parser）| 2d | P1 |
| **P3** | GitHub extractor（RocketTeam + TeamBrain）| 1.5d | P1 |
| **P4** | Slack extractor (events 化)| 1d | P1 |
| **P5** | Meeting extractor | 1d | P1 |
| **P6** | Anomaly Engine + 9 规则 | 3d | P1-P5 至少 3 个 |
| **P7** | `team:today` prompt + 输出契约 | 1.5d | P6 |
| **P8** | MCP server: today + flag + dispatch + ask + resolve | 2d | P7 |
| **P9** | 自动 evolve scheduler | 2d | P1, P6 |
| **P10** | leader 笔试用 + `/loop` 配置文档 | 0.5d | P8 |
| **P11** | Dogfood + 调阈值（连续 2-4 周）| 4w | P10 |
| **P12 (按需)** | Web glance pane v0（read-only `/today` 渲染）| 2d | leader 主动要 |
| **P13 (按需)** | 结构化某条规则 / 加 push 通道 | 视情况 | dogfood 反馈 |

P1-P10 ≈ 15.5 工作日。无并行约束（一人开发），可并行约 4-6 天减到 11-12 天。

---

## 13. 风险与缓解

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| CC SESSIONS 真实 schema 与 smoke 数据不同 | High | Med | Defensive parser，未知 schema 落 raw blob event，不阻塞 |
| Identity 映射缺失导致 events subject unresolved | Med | Low | unresolved 仍记 raw + UI 列「未识别身份」maintenance 入口 |
| Anomaly 规则在新源刚接入时大量误报 | High | Med | 每条规则带 `enabled` flag + `confidence_threshold` 配置；初期只开 2-3 条最稳的（override.spike / dispatch.uncertain / profile.stale）|
| LLM evolve 把画像写坏 | Med | High | 复用现有 evolution diff + 回滚机制（`src/evolve/diff.ts`）+ leader 可手动 revert |
| events.jsonl 长跑膨胀 | Low | Low | 90d rotate；anomaly state 用 reduce 快照而非全量回放 |
| collector server 离线 | Med | Low | extractor 跳过该 source，其他源照跑；状态条显示 source 健康度 |
| Slack/GitHub token 过期 | Med | Med | 现有 vault 失败提示，加 `events.system.source_error` 进 `team:today` fyi 档 |
| Leader 一周不开 CC | Med | Low | `team:today` 顶部「期间累计」digest |

---

## 14. Open Questions（待 leader 拍板）

1. **CC SESSIONS allowlist 谁定？** 默认是 4 重点 demo agent（安子岩 / 孙润峰 / 田皓轩 / 黄运樟）扩展到全 24？
2. **Identity 映射表谁维护？** Bootstrap 时让 LLM 从会议 + org chart 推断，leader 一次性 review？
3. **`team:today` 默认调用模型？** Anthropic Claude 4.7 Sonnet 还是 Opus？三档 briefing 不重，Sonnet 够用。
4. **`team:flag` 文本需不需要 LLM 二次结构化？** v1 纯文本存，下次 today briefing 让 LLM 自己解读。
5. **GitHub 起步只 RocketTeam + TeamBrain 是否够覆盖？** 还是 leader 想看更多 repo？
6. **会议 txt 文件命名 / 时间戳协议？** 现有命名是否含日期，否则 file mtime 兜底？
7. **是否同时建一个最简 web `/today` 渲染？** 当 leader 不在 CC（手机访问、给同事看）时有个 fallback URL。还是严格 CC-only？

---

## 15. 与 BACKEND-REDESIGN.md 的关系

本 spec 不与 BACKEND-REDESIGN.md 冲突：

- BACKEND-REDESIGN 的 SQLite + Drizzle + 5 层架构 → 本 spec 在 `events.jsonl` + 文件锁 上跑；迁 SQLite 后 events 是一张表，extractors/anomaly/evolve/today 不需要重写
- BACKEND-REDESIGN 的 LLMRouter / pino logging / trace_id → 本 spec 自动获益
- BACKEND-REDESIGN 的 PromptRegistry → `team:today` prompt 注册进去
- BACKEND-REDESIGN M0-M4 12 周路线图 → 本 spec P1-P11 可在 M0 之后任何里程碑落地，不卡时序

如需先做 BACKEND-REDESIGN P0（M0+M1+M1.5），本 spec 起步可延后 4 周；不延后则 events.jsonl 先用，后随主架构迁。

---

## 16. 与 UX-CC-FIRST.md 的关系

**Supersedes**：UX-CC-FIRST.md 的 P1-P3 落地计划。

UX-CC-FIRST.md §3-4 的「列表页双模式卡 + 详情页折叠区」方案是 demo 期补丁，受众是 leader + 23 成员。Demo 后受众缩为 leader 一人 + CC 主接口，UX-CC-FIRST.md 提出的页面级 UX 优化不再是 ROI 高项。`/agents` 页降为 debug pane。

**保留**：UX-CC-FIRST.md §0 数据真伪审计是项目最有价值的一份文档。本 spec 严格遵守 §0.2：narrative 字段（current_tasks 描述、started_at）不被升级为 anomaly trigger；只用 §0.1 标「真」的字段 + 4 个新源的真信号。

---

## 17. 验收

P10 完成后，leader 应能：

1. 在他笔记本 CC 跑 `/loop /today 30m`，每 30 min 自动拿一份三档 briefing
2. 看到的每条 act-now/next-glance 异常都引用真 events，能点开 raw_ref 验证
3. 用 `team:dispatch "..."` 在 CC 对话上下文里派任务，不切 web
4. 用 `team:flag "..."` 把弱信号写进系统，下次 briefing 出现
5. 用 `team:resolve <id> <action>` 一条命令处理异常

Dogfood 4 周后看：

- Briefing 命中率（leader 觉得「act-now 一档真值得停下处理」的比例）≥ 70%
- 误报率（被 dismiss 的同 rule 类型 / 该 rule 7d 触发数）< 30%
- Leader 主动跑 `team:today` 的频率：稳定每天 ≥ 3 次
- `team:dispatch` 使用率：替代 web NewTaskModal ≥ 80%

未达指标 → 进入 P13 调规则 / 加 push / 改文案。
