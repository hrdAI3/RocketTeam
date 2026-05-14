# UX 重构方案：从「人 = 单位」到「项目 = 单位」的 WIP 展示 — v5

> 受众：Rocket Team leader + 团队成员 + 8080 collector 维护者
> 日期：2026-05-14（v5：吸收第四轮冷读 7 点反馈——§9 事实校正 + 6 处内部一致性修复）
> 关联文档：`UX-CC-FIRST.md`（继承其 §0 数据真实性契约）、`docs/leader-view-data-asks.md`、`BACKEND-REDESIGN.md`
> v4 相对 v3 的根本变化：
> - 重建 §0 概念地基——明确「什么算一个项目」「怎么算同一个项目」，这是 v1-v3 一直回避的洞
> - 新增 §3「项目身份与匹配机制」——登记表 + 多信号匹配器 + 软聚类
> - `repoFromCwd` 从「项目主键」降级为「匹配信号之一」
> - CC 在首屏**匿名化**：工作线只显「状态 · 标题」，卡底显「N 个 CC 在跑」，**不具名**；人名只在钻取详情页出现
> - 新增 §9「CC 数据增强请求」——列出能让方案更准的 CC 侧数据 + 它在 CC 里的确切位置

---

## 0. 概念地基

### 0.1 现状与监控感诊断

`/status` 是「24 行人 × 状态」的 roster（`src/app/status/page.tsx`）。每行：人名 · 活跃灯 · 最近 session · current repo · workItems[] · 异常 chip。视觉首要轴 = 人。

监控感**不**来自「leader 能看到 CC 在做什么」——那是合理的管理需求。监控感来自三件事：

| 监控感来源 | 不是监控感来源 |
|---|---|
| 主轴是「人」，首屏 24 行人脸 | 把"在做什么"列出来 |
| 按异常/活跃排序、休眠垫底 | leader 能钻取看具体某条工作 |
| 活跃灯当评判标签、「最久没动的人」stat | 项目卡里显示有 CC 在推进 |

⇒ **去监控 = 翻轴（人→项目）+ 砍记分牌编码（排序/灯/排名）+ CC 首屏匿名化**。三个一起，缺一不可。不是靠"藏数据"。

### 0.2 锁定的概念全景

1. **主轴 = 项目**。leader 打开 `/status`，首屏是 N 张项目卡，不是 24 行人。
2. **单位 = 工作线（`WorkItem`）**。`src/services/work_summary.ts` 已经把每人 CC 活动整理成 `WorkItem[]`（title / status / repo / detail）。重构动的是**下游怎么分组**，不动 work_summary 本身。
3. **CC = 匿名工作单元**。首屏工作线只显「状态 · 标题」；卡底显「N 个 CC 在跑」（容量信号，不具名）。**「谁的 CC」只在钻取详情页出现**——找人谈是专门动作，不是默认暴露。
4. **去监控 = 翻轴 + 砍记分牌 + CC 匿名化**（§0.1）。
5. **项目身份 = 登记表 + 多信号匹配**（§3）。`repoFromCwd` 是匹配信号之一，不是主键。
6. **软聚类**：工作线能 confidently 匹配到登记项目 → 进项目卡；匹配不到 → 作为独立工作线卡平铺展示（**不叫 orphaned，不进耻辱抽屉**，视觉权重等同）。系统在登记表为空时也能跑——退化成"一片平静的工作线列表"，这已经比现状的人轴 roster 好。

### 0.3 什么算「一个项目」

**项目不是从 cwd 反推出来的东西。** v1-v3 把「项目 = `repoFromCwd(cwd)`」当定义，这是地基洞。`repoFromCwd` 实际只是「取 cwd 最后一段路径」（`cc_status.ts:324`），炸法：

- `D:\hrdai` 是**一个 git 仓库**，`team/` `MiroFish/` `socialmind/` `remotion-skills/` 全是它的子目录。明显不同项目，同一个 repo。
- `D:\hrdai\team\src` → `"src"`；`D:\hrdai\MiroFish\src` → 也 `"src"`。**两个项目撞成一个。**
- `D:\hrdai\team` → `"team"`；`D:\hrdai\team\src` → `"src"`。**一个项目裂成两个。**
- 产品/运营/销售项目没 cwd → v1-v3 里永远 orphaned。

**v4 定义**：一个项目是**团队声明的一个意图单位**，身份独立于任何 cwd 存在，登记在 `private/projects.json` 里（§3.1）。它有一个稳定 id、一个 display name、一组 `aliases`（吸收 LLM 短名漂移）、一组 `matchers`（§3.2）。

登记表可以为空——那系统就退化成软聚类的"平铺工作线列表"模式（§0.2 第 6 点），仍可用，仍去监控。登记表越全，聚类越准。

### 0.4 什么算「同一个项目」

v1-v3 的答案 = 同一个 slug 字符串（语法匹配）。v4 的答案 = **匹配到同一个已登记项目实体**（语义匹配）。

「匹配」是一个带置信度的多信号打分问题（§3.2）：给一条工作线 + 它的来源 session 上下文（cwd、branch、git remote、首条 prompt、关键词…），对每个登记项目算一个 best signal score。

- best ≥ 0.7 且无第二个项目 ≥ 0.7 → **confident match**，进该项目卡
- best ≥ 0.7 但有 ≥2 个项目都 ≥ 0.7 → **ambiguous**，作为独立工作线卡 + 「待确认归属」标
- best < 0.7 → **unclustered**，作为独立工作线卡

置信阈值 0.7 是初始值，§0.6 审计后按真实命中分布微调。

### 0.5 数据真实度（继承 UX-CC-FIRST §0）

| 字段 | 来源 | 真实度 |
|------|------|--------|
| `WorkItem.title / status / detail` | LLM 从 7 天事件 + live 快照抽（`work_summary.ts`） | narrative，但有 evidence 支撑 |
| `WorkItem.repo` | 同上，LLM 抽的短名 | narrative，会漂移——所以**只当匹配信号之一**，不当主键 |
| `repoFromCwd(cwd)` | 纯路径字符串处理 | **真**，但语义弱（见 §0.3 炸法） |
| session `cwd / gitBranch` | CC jsonl 行内 `row.cwd / row.gitBranch`，extractor 取首个出现值（`cc_session.ts:187-190`，首行带值者胜） | **真** |
| git remote URL / repo root | CC 当前**不记**（§9 数据请求 B-1） | 暂无 |
| 项目「进度%」「deadline」「燃尽」 | 没有 | **禁止显示** |

⇒ 不引入任何编造的项目维度。项目卡只显示真实可投影的东西：有哪些工作线、各自状态、几个 CC 在推、最近活动时间。

### 0.6 P0 前置审计

P1 落地**之前**跑一次覆盖率审计，数字写回 §8.1 才能开 PR：

```bash
bun run tools/audit-project-coverage.ts
```

**度量口径**（分母锚定到稳定子集，避免随 CC 采用率波动）：
- `clusterable_rate`：分母 = `activityFlag ∈ {active, idle}` 成员产生的全部 `WorkItem`；分子 = 其中能 confident match 到**某个**登记项目的条数。**先用 seed 后的 `projects.json` 跑**（§3.4）。
- `unclustered_rate`：上述分母下 unclustered + ambiguous 占比
- `repo_signal_variants`：同一登记项目被 `WorkItem.repo` 写成几种不同短名 → 回填登记表 `aliases`
- `no_cc_data`：`activityFlag === 'never'` 的成员数（旁证，不入门槛）

**门槛**：
- `clusterable_rate ≥ 70%` → 按 §1-§8 实施
- `clusterable_rate ∈ [50%, 70%)` → 先补 `projects.json` matchers + `aliases`，复测；仍不达标走下一档
- `clusterable_rate < 50%` → 先做 §9 数据请求里的 **A 类（零成本，纯 extractor 改动）**，把 git remote / 首条 prompt / TodoWrite 接进匹配信号，复测达标再发 P1

注意：即使 `clusterable_rate` 低，**软聚类模式仍可发**（§0.2 第 6 点）——平铺工作线列表本身已去监控。门槛把关的是"项目卡"这个增强层，不是整个方案。

---

## 1. 设计目标

1. **主视觉单位 = 项目卡**。首屏 N 张项目卡。
2. **工作线为聚类单位**，CC 首屏匿名。
3. **不删任何现有功能**：异常列表、person detail、aggregate 全保留，入口变成"从项目卡钻进去"。
4. **不编造项目维度**：进度/deadline/燃尽一律不上。
5. **零数据依赖也能跑**：登记表为空 → 软聚类退化成平铺工作线列表。§9 数据请求是"锦上添花"，不是"前置阻塞"。
6. **三渠道同逻辑**：Web / CLI / Slack push 共用同一个 `attributeAnomalyToProject` 函数（同一套归属逻辑；不强求共用同一份缓存 map——见 §2.4.3）。
7. **优雅退化**：每一种**运行时**失败模式（collector 挂、LLM 挂、登记表空）都有定义好的降级形态，不白屏不报错。覆盖率低不是运行时失败，是 §0.6 的 **发布前门槛**，单独处理。

---

## 2. 信息架构

### 2.1 三层结构

```
Level 1 — /status（内部叫 "Workboard"；URL 保留 /status，避免大面积 ref 改）
   ┌─ 顶层异常区 — §2.4 白名单留顶层的（quota / context / danger / override）
   ┌─ 项目卡列表  ←——— 主视觉
   └─ 未归类工作线区 — 软聚类没聚拢的，平铺，视觉权重等同项目卡

Level 2 — /status/project/[id]
   ┌─ 项目 hero（项目名 + 状态分布 + N 个 CC + 最近活动）
   ┌─ 工作线（卡住 → 进行中 → 调研中 → 已完成），每条右下小字才显「某成员 · ago」
   ┌─ 参与成员（≥2 人才显，字母序，无计数、无排名）
   └─ 关联 PMA 派单（仅当非空才渲染）

Level 3 — /status/[name]
   不变。从项目详情页的成员名 / 搜索进入。保留协作判断 + 一对一辅导用途。
```

### 2.2 列表页（`/status`）布局

```
┌─ Header ─────────────────────────────────────────────────┐
│ Rocket Team / Workboard                          [Refresh]│
│ 项目维度看在做的事 · {N} 个项目在跑 · {K} 个卡住          │
│   （{N}{K} 运行时数，§0.6 审计前不在 mock 里 hardcode）   │
└──────────────────────────────────────────────────────────┘

┌─ 顶层异常（不可归项目的）───────────────────────────────┐
│  例如 quota.pace_7d (戴昊然) — 留这里（§2.4 白名单）     │
└──────────────────────────────────────────────────────────┘

┌─ 项目卡 ── 卡住（红框）─────────────────────────────────┐
│  TeamBrain                                  ⚠ 卡住      │
│  • ⚠  consent gate 设计                                 │
│  • ⏳ correction-detector 接入                          │
│  • 🔍 PII redactor 性能                                 │
│                              3 个 CC · 最近 12m         │
└──────────────────────────────────────────────────────────┘

┌─ 项目卡 ── 活跃（默认描边）─────────────────────────────┐
│  socialmind                                  活跃       │
│  • ⏳ 推荐流冷启动调参                                   │
│                              1 个 CC · 最近 3h          │
└──────────────────────────────────────────────────────────┘

┌─ 未归类工作线 ──────────────────────────────────────────┐
│  这些工作线没能 confidently 归到登记项目。              │
│  • ⏳ 季度汇报数据整理            [建议建为项目]         │
│  • 🔍 竞品调研                    [建议建为项目]         │
└──────────────────────────────────────────────────────────┘
```

**工作线行 = `状态 dot · 标题`，完。不挂 CC 名、不挂人名。**

**卡底 = `N 个 CC 在跑 · 最近活动 age`**。`N` 是匿名计数（容量信号）；点击进卡片 → 详情页才落到「某成员 · ago」。

**未归类工作线区**：视觉权重等同项目卡，不是折叠抽屉、不带"orphaned"羞耻字样。每条带「建议建为项目」affordance——当某个未归类工作线反复出现同一个 repo 信号时，一键往 `projects.json` 写一条 stub 登记，leader 之后细化（§3.4）。

### 2.3 项目卡状态推导（纯规则，无 LLM，带防抖）

```ts
function projectStatus(
  items: WorkItem[],
  attributedAnomalies: Anomaly[]
): '卡住' | '活跃' | '收尾' | '休眠' {
  // 防抖：单条 LLM 误判不应翻红一个项目。翻 '卡住' 须满足之一：
  //   (a) 有 anomaly 归到本项目（§2.4 白名单范围内）
  //   (b) ≥ 2 条 WorkItem.status === '卡住'（单条 LLM 短期幻觉只产 1 条）
  const stuckCount = items.filter(i => i.status === '卡住').length;
  if (attributedAnomalies.length >= 1 || stuckCount >= 2) return '卡住';

  const ongoing = items.filter(i => i.status === '进行中' || i.status === '调研中');
  const done = items.filter(i => i.status === '已完成');
  if (ongoing.length === 0 && done.length > 0) return '收尾';
  if (ongoing.length === 0) return '休眠';
  return '活跃';
}
```

单条 `卡住` workItem 仍展示在卡里，只是不让整卡翻红。**为什么**：项目卡的 ⚠ 触发红框 + Slack DM 重写主语；单条 LLM 幻觉就能翻红 = 把人级误报搬到项目级。

最近活动 = `max(lastActivityAt)`，≤24h 显小时，否则按天。

### 2.4 异常 → 项目归属

#### 2.4.1 白名单：哪些 rule 可归项目

| Rule（rule id 见 `status/page.tsx:106` 的 `RULE_LABEL`；CLI 侧另有 `cc_status.ts:664` 的 `RULE_LABEL_CLI`）| 去向 |
|---|---|
| `silence.dormant` | **项目**（沉默的人对应他沉默前在推的项目沉默了） |
| `blocked.review_pending` | **项目**（PR 卡审 → PR 所在 repo） |
| `blocked.cc_attested` | **项目**（自报卡住，归 cwd 项目） |
| `dispatch.uncertain` | **项目**（归 task 关联项目；推不出归顶层） |
| `override.spike` | **顶层**（关于派单流程本身） |
| `danger.command.*` | **顶层**（安全事件，主语是命令，不能被项目化淡化） |
| `quota.*`（pace/near, 5h/7d） | **顶层**（配额是个人维度，归项目反而怪） |
| `context.near_full` | **顶层** |
| 未列出的新 rule | **默认顶层**，引入时显式加映射 |

**公开 trade-off**：当前只有 `quota.pace_7d` 一条 live-derived rule 真在跑（`cc_status.ts:liveConcerns`），engine anomalies 尚未 production-active。⇒ 落地初期项目卡的 ⚠ **大概率来自 `WorkItem.status === '卡住'`，不来自 anomaly**。anomaly 路径是给未来 rule 接入留接口。这是已知、可接受的，不是 hidden bug。

#### 2.4.2 算法：怎么找 cwd → 项目

**Schema 注意**：`Anomaly.evidence_event_seqs: number[]`（`src/types/events.ts:120`）是事件序号，不是事件本身。取 cwd 必须从 events.jsonl join。

```ts
async function attributeAnomalyToProject(
  a: Anomaly,
  roster: RosterRow[],
  matchProject: (ctx: MatchContext) => MatchResult  // §3.2 的匹配器
): Promise<{ projectId: string | null; reason: AttrReason }> {
  if (TOP_LEVEL_RULES.has(a.rule)) return { projectId: null, reason: 'top-level' };

  // Step 1: 触发该异常的事件 cwd。evidence_event_seqs 为空 ⇒ 跳 Step 2
  //   （这是 live-derived anomalies 的常态：liveConcerns() cc_status.ts:379
  //    的 anomaly-builder 永远返回 evidence_event_seqs: []。
  //    公开声明：live 路径全部走 Step 2）
  const lastSeq = a.evidence_event_seqs.at(-1);
  if (typeof lastSeq === 'number') {
    const ev = await getEventBySeq(lastSeq);              // §4.3 新增 seq 索引
    const cwd = typeof ev?.evidence.fields?.cwd === 'string'
      ? (ev.evidence.fields.cwd as string) : undefined;
    if (cwd) {
      const m = matchProject({ cwd, branch: ev?.evidence.fields?.gitBranch as string });
      if (m.projectId && m.confidence >= 0.7) return { projectId: m.projectId, reason: 'cwd-from-event' };
    }
  }
  // Step 2: 退回该人 currentRepo（getOneStatus 的 substantive session cwd）
  if (a.subject.kind === 'agent') {
    const row = roster.find(r => r.name === a.subject.ref);
    if (row?.currentRepo) {
      const m = matchProject({ cwd: row.currentRepo });
      if (m.projectId && m.confidence >= 0.7) return { projectId: m.projectId, reason: 'cwd-from-current-session' };
    }
  }
  // Step 3: 归不到 → 顶层，UI 标「归属未知」
  return { projectId: null, reason: 'unknown' };
}
```

**已知不对称（公开声明）**：异常归属路径只给 `matchProject` 喂 `{cwd, branch}` 两个信号，**不**喂 `gitRemote / firstPrompt / llmRepoTag / taskId / ownerName`。所以异常跑的是比工作线聚类**更弱的匹配器子集**。这是有意的——异常的来源事件只可靠地带 cwd/branch，硬塞其他信号会引入噪声。后果：异常更容易落到 Step 3「归属未知」进顶层，这是安全的失败方向（宁可不归，不可错归）。

#### 2.4.3 服务端集中

`attributeAnomalyToProject` 是**唯一的归属真源函数**，三渠道都调它：
- `getWorkboardView()`（§4.1）对每条异常调一次，把 `anomalyId → projectId` 结果写进返回的 `anomalyToProject` map——**前端不二次算**，直接用这份 map 渲染。
- `leader_push.ts`（§4.4）在 `notifyActNowIfNew` 里**对单条异常重新调用同一个函数**——它的调用栈里没有 `WorkboardView`，所以是"共用同一套归属逻辑"，**不是共用同一份缓存 map**。结果一致（同函数同输入），但是各算各的。
- CLI `team:workboard`（§4.7）同样直接调该函数。

⇒ 准确说法是「三渠道共用同一个归属函数」，不是「共用同一份 map」。函数纯逻辑（输入：anomaly + roster + matcher），无隐藏状态，所以三处结果必然一致。

### 2.5 项目详情页（`/status/project/[id]`）

`id` = 登记表里的项目 id（稳定，不是 cwd 派生 slug）。

```
┌─ Project hero ──────────────────────────────────────────┐
│  TeamBrain                                              │
│  3 进行中 · 1 卡住 · 2 本周完成 · 3 个 CC              │
│                              最近活动 12m ago           │
└─────────────────────────────────────────────────────────┘

┌─ 工作线（卡住优先）────────────────────────────────────┐
│  ⚠ 卡住 · consent gate 设计           （右下）张三 · 2d │
│  "需要 legal 拍板范围"                                   │
│  ⏳ 进行中 · correction-detector 接入  （右下）李四·12m │
└─────────────────────────────────────────────────────────┘

┌─ 参与成员（仅当 ≥ 2 人）──────────────────────────────┐
│  • 李四   • 王五   • 张三   （字母序，无计数无排名）    │
│  仅 1 人时整块隐藏——单名列表 = 伪装的 person row。     │
│  该成员名仍出现在工作线右下小字。                       │
└─────────────────────────────────────────────────────────┘

┌─ 关联 PMA 派单（仅非空才渲染，空则整块不画）──────────┐
│  task-xxx · "重构 PII redactor 配置加载" → 李四 ✓采纳  │
└─────────────────────────────────────────────────────────┘
```

详情页是**人名唯一出现的地方**（工作线右下小字 + 参与成员）。原则：**首屏 glance 匿名（项目健康度），钻取才落到人（找人谈）**。

工作线"贡献者最近 session 摘录" = 复用 `getOneStatus(name).recentSessions`，过滤 cwd 匹配本项目。

**故意不放**：进度条、燃尽、预计完工、任何"谁干得多/少"对比柱或排序数字列、"最快/最慢的人"。

### 2.6 个人详情页（`/status/[name]`）— 改动极小

- 顶部 hero 加一行 chip：`本周参与项目：TeamBrain / socialmind`，点击 → 项目详情。
- 工作线区沿用现有 group-by-repo（已是如此）。
- 不再是 leader 主入口，但保留可达。

---

## 3. 项目身份与匹配机制

### 3.1 登记表 `private/projects.json`

人工维护（首版 ~10-20 条），`.gitignore` 屏蔽（同 `private/` 其他内容）。`private.example/projects.example.json` 提供占位骨架。

```jsonc
{
  "version": 1,
  "projects": [
    {
      "id": "teambrain",                    // 稳定 slug，URL + 跨渠道用
      "name": "TeamBrain",                  // display
      "status": "active",                   // active | archived
      "aliases": ["teambrain", "tb", "team-brain"],  // 吸收 LLM 短名漂移
      "matchers": {
        "git_remotes": ["github.com/hrdai/teambrain"],   // §9 B-1 数据到位后最硬
        "repo_roots": ["D:/work/TeamBrain"],             // §9 B-1
        "path_prefixes": ["D:/work/TeamBrain", "D:/hrdai/team"],
        "branch_patterns": ["teambrain-*", "tb/*"],
        "keywords": ["consent gate", "correction-detector", "PII redactor"],
        "member_areas": [{ "member": "张三", "keyword_any": ["anomaly", "engine"] }]
      }
    }
  ]
}
```

`archived` 项目不出现在 `/status` 列表，但 `/status/project/[id]` 直链仍可访问，标「已归档」。

### 3.2 多信号匹配器

`matchProject(ctx: MatchContext): MatchResult`。`MatchContext` = 一条工作线能拿到的所有来源信号：`{ cwd?, branch?, gitRemote?, repoRoot?, firstPrompt?, llmRepoTag?, taskId?, ownerName?, titleAndDetail? }`。

对每个 active 项目算分，**取该项目所有命中信号里的最高分**（不累加——累加会让"关键词碰巧多中几个"压过"路径精确匹配"）：

| 信号 | 命中条件 | 置信 | 能否独立 confident match（≥0.7）|
|---|---|---|---|
| `git_remote` | `ctx.gitRemote` 精确等于登记值（normalize 掉协议/`.git`后缀） | **1.0** | ✅ |
| `repo_root` | `ctx.repoRoot` 精确等于登记值 | 0.9 | ✅ |
| `path_prefix` | `ctx.cwd` 以登记前缀开头（取最长匹配前缀） | 0.85 | ✅ |
| `branch_pattern` | `ctx.branch` glob-匹配登记 pattern | 0.7 | ✅（刚好达阈值）|
| `task_link` | `ctx.taskId` 对应一条 PMA Task，其 `description` 命中本项目 `name` 或 `aliases`（与 §4.1 `relatedTaskIds` 同一套匹配规则——**不依赖任何 contributor 名单**）| 0.7 | ✅（刚好达阈值）|
| `keyword` | `ctx.titleAndDetail` 或 `ctx.firstPrompt` 含登记关键词 | 0.55 | ❌ 仅破平/加权 |
| `member_area` | `ctx.ownerName` 命中 `member_areas[].member` 且关键词任一命中 | 0.5 | ❌ 仅破平/加权 |
| `llm_repo_tag` | `repoFromCwd(ctx.llmRepoTag)` 归一化后 ∈ 项目 `aliases` | 0.45 | ❌ 仅破平/加权 |

`MatchResult = { projectId, confidence, signal, runnerUp? }`。决策见 §0.4。

**关键设计点**：
- **「取 max 不求和」**：对一个项目，置信 = 它所有命中信号里的**最高分**，绝不累加。累加会让"关键词碰巧多中几个"压过精确路径匹配。
- `path_prefix` 取**最长匹配**——`D:/hrdai/team` 比 `D:/hrdai` 更具体，monorepo 子目录靠这个区分（解决 §0.3 的 `D:\hrdai` 单 repo 装多项目问题）。
- **硬信号**（`git_remote` / `repo_root` / `path_prefix` / `branch_pattern` / `task_link`，置信 ≥ 0.7）才能独立 confident match。**软信号**（`keyword` 0.55 / `member_area` 0.5 / `llm_repo_tag` 0.45）单独命中、甚至三个全中，max 仍 < 0.7，**永远无法独立 confident match**——它们只用于：已有硬信号时**确认**，或两个项目都有硬信号时**破平**。这把 v1-v3 "LLM repo 当主键"的脆弱性彻底降权。
- **无 cwd 的产品/运营项目，只能靠 `task_link`（0.7）聚类**——即该工作必须经 PMA 派单、且该 Task 的 `description` 命中项目 `name`/`aliases`（`task_link` 的匹配条件**不涉及 contributor 名单**，纯文本匹配，所以 §3.1 的 matcher schema 也不需要 `contributors` 字段——见上表 `task_link` 行）。不走 PMA 派单的产品/运营工作，会**结构性地停留在未归类区**，靠 §3.4 的"建议建为项目"+ leader 手工细化登记表来接管。这是已知、诚实的局限，不是 bug；§6 与此一致。§9 A-2（首条 prompt）接入后，`keyword` 信号的来源更丰富，但置信仍是 0.55——它让破平更准，**不**让无 cwd 项目变得可独立聚类。
- `path_prefix` 对 worktree cwd 仍生效——CC 的 worktree cwd 形如 `<repo>/.claude/worktrees/<wt>`，仍以登记的 `<repo>` 前缀开头，所以照常 prefix-match 到正确项目。
- 所有置信数字是初始值，§0.6 审计后按真实命中分布校准；写进 `src/lib/project_match_weights.ts` 单文件，便于调。

### 3.3 软聚类

```
对每条 WorkItem：
  ctx = 收集来源信号（cwd/branch/remote/firstPrompt/llmRepoTag/taskId/owner/title）
  m = matchProject(ctx)
  if m.confidence >= 0.7 and not ambiguous(m)  → 挂到 m.projectId 的项目卡
  else                                         → 独立工作线卡（未归类区）
项目卡 = 至少 1 条 confident WorkItem 命中的登记项目
未归类区 = 所有没聚拢的 WorkItem，平铺
```

- 登记表空 → 所有 WorkItem 进未归类区 → 系统退化成"平铺工作线列表"。**仍然去监控**（无人轴、无记分牌），仍可发。
- 这是 §1 目标 5「零数据依赖也能跑」的实现：项目卡是增强层，软聚类列表是保底层。

### 3.4 登记表怎么 seed

三种，按成本排序：

1. **人工**（最诚实，首选）：leader 一次性列 10-20 个项目。`tools/projects-seed.ts --interactive` 提供脚手架。
2. **半自动提候选**：`tools/projects-seed.ts --propose` 跑 cwd 聚类 + 会议记录里的项目名提及 → 输出候选 `projects.json` draft，leader 改名/合并/确认。
3. **运行时增量**：未归类工作线反复出现同一 repo 信号 → UI「建议建为项目」一键写 stub 登记（id + name + 一条 path_prefix matcher），leader 之后在 `projects.json` 细化 `aliases` / `keywords`。

§0.6 审计**用 seed 后的登记表跑**——先 seed，再测 `clusterable_rate`。

---

## 4. 数据 / 后端改动

### 4.1 新文件：`src/services/workboard.ts`

纯函数聚合，无新存储（除 `private/projects.json` 这个人工配置）。

**匿名性靠类型分层强制**（不靠"组件记得别 bind contributors"这种渲染期纪律）。列表页用的 `ProjectCardSummary` **类型里就没有人名字段**；只有详情页路由返回的 `ProjectCardDetail` 才带 `contributors` / `workItems[].ownerName`。

```ts
// 列表页 payload —— 类型上不存在任何人名字段
export interface ProjectCardSummary {
  id: string;                    // 登记表 id
  name: string;                  // 登记表 name
  workItems: WorkItem[];         // 注意：纯 WorkItem，无 ownerName
  ccCount: number;               // 去重 owner 数 = "N 个 CC"（匿名计数；
                                 //   计算时在 service 内部用到 owner，但只输出 count）
  lastActivityAt: string | null;
  status: '卡住' | '活跃' | '收尾' | '休眠';
  attributedAnomalies: Anomaly[];
  hasRelatedTasks: boolean;      // 列表页只需知道"有没有"，详情页才给 id 列表
}
// 详情页 payload —— 这里才出现人名
export interface ProjectCardDetail extends Omit<ProjectCardSummary, 'workItems' | 'hasRelatedTasks'> {
  workItems: Array<WorkItem & { ownerName: string }>;
  contributors: string[];        // 字母序
  relatedTaskIds: string[];      // 可空——前端非空才渲染
}
export interface UnclusteredThread {
  // 未归类工作线也是平铺在列表页的 → 同样不能带 ownerName
  workItem: WorkItem;            // 纯 WorkItem，无 ownerName
  reason: 'no-match' | 'ambiguous';
  suggestedProjectStub?: { name: string; pathPrefix: string };  // "建议建为项目"
}
export interface WorkboardView {                 // 列表页 GET /api/workboard 的返回
  projects: ProjectCardSummary[];
  unclustered: UnclusteredThread[];
  topAnomalies: Anomaly[];                  // §2.4 留顶层的 + 归属未知的
  anomalyToProject: Record<string, string>; // anomalyId → projectId
  aggregate: { totalProjects: number; stuck: number; active: number };
  degraded?: { reason: 'empty-registry' | 'collector-down' | 'llm-stale' };
}
export async function getWorkboardView(): Promise<WorkboardView>;
export async function getProjectDetail(id: string): Promise<ProjectCardDetail | null>;
```

**不变量**：`GET /api/workboard`（列表）的返回里**不存在任何成员姓名字段**——`ProjectCardSummary` / `UnclusteredThread` 类型上就没有 `ownerName` / `contributors`。人名只能从 `GET /api/workboard/project/[id]`（`ProjectCardDetail`）拿到。§4.8 有一条测试断言列表 payload 序列化后不含任何 roster 成员名。`degraded.reason` 只列**运行时**失败模式（empty-registry / collector-down / llm-stale）；覆盖率低是 §0.6 发布前门槛，不是运行时状态，不入此 union（与 §1 目标 7 一致）。

逻辑（`getWorkboardView` — 列表）：
1. 调 `getRosterView()`（`cc_status.ts`）取 roster + anomalies + 每人 workItems。
2. 加载 `private/projects.json`（缺失/损坏 → 空登记表，`degraded.reason = 'empty-registry'`，照常跑软聚类）。
3. 对每条 WorkItem 收集 `MatchContext` 信号，跑 §3.2 matcher → §3.3 软聚类。聚类时 service 内部知道每条 WorkItem 的 owner（算 `ccCount` 要去重 owner），但**只把去重后的 count 写进 `ProjectCardSummary.ccCount`，丢弃 owner 名**——人名不进列表 payload。
4. 对每条 anomaly 调 `attributeAnomalyToProject`（§2.4.2）→ 填 `anomalyToProject` + 每个项目的 `attributedAnomalies` + `topAnomalies`。
5. 每个项目卡算 `status`（§2.3）、`ccCount`、`lastActivityAt`。
6. `hasRelatedTasks`：扫 `private/tasks/*.json`，严苛匹配是否存在关联 Task（匹配规则见下）；列表页只输出 bool。

`getProjectDetail(id)` — 详情：重跑该项目的 WorkItem 聚类但**保留 `ownerName`**，算 `contributors`（字母序去重），`relatedTaskIds`（严苛匹配：`top1/decomposition.assignee ∈ contributors` ∧ description 命中 name/aliases；宁缺勿滥；空数组前端 hide section）。

### 4.2 新 API

```ts
// src/app/api/workboard/route.ts —— 列表，返回 WorkboardView（无任何人名字段）
export async function GET() { return Response.json(await getWorkboardView()); }
// src/app/api/workboard/project/[id]/route.ts —— 详情，返回 ProjectCardDetail
//   （含 contributors / workItems[].ownerName + 每条工作线展开的 owner 最近 session 摘录）
export async function GET(_: Request, { params }: { params: { id: string } }) {
  const detail = await getProjectDetail(params.id);
  return detail ? Response.json(detail) : new Response('not found', { status: 404 });
}
```

`/api/cc-status` **不删**：CLI `team:status`、person detail、旧 Slack 路径还用。

### 4.3 `getEventBySeq` — `src/lib/events.ts` 加 seq 索引

`events.ts` 当前只有全量扫描读取（代码注释自己标了 "should add an indexed reader" TODO）。新增：进程内 `Map<seq, byteOffset>`，**懒构建**——首次 `getEventBySeq` 调用时扫一遍 events.jsonl 建索引。

**失效机制（明确，不靠"append-only 所以自动对"的含糊话）**：
- 索引建好后，若查询的 seq **不在 map 里**（cache-miss），说明索引可能落后于新 append → **重建一次索引**再查；重建后仍找不到 → 返回 `null`（该 seq 真不存在）。
- 不做"append 时增量更新索引"——`appendEvents`（`events.ts`）与 `getEventBySeq` 之间没有事件总线连接，强行 wire 反而引入耦合。cache-miss 触发重建已足够：异常归属查的都是**已落盘的旧事件**（`evidence_event_seqs` 指向触发时已存在的事件），正常路径几乎不会 miss；偶尔 miss 重建一次，成本可接受（24 人团队 events.jsonl 规模）。
- P1 交付物明确：首次调用 + 每次 cache-miss 各承担一次全扫；命中则 O(1) seek。

### 4.4 Slack push 项目化 — `src/services/leader_push.ts`

`formatMessage` **保持同步纯函数**；异步归属判定上提到 `notifyActNowIfNew`（它本就在做 I/O）：

`notifyActNowIfNew`（`leader_push.ts:63`，已 async，已做 I/O）里**重新调用** `attributeAnomalyToProject` —— 它的调用栈没有 `WorkboardView`，所以是复用同一个**函数**（同逻辑），不是复用 `getWorkboardView` 的 map（见 §2.4.3）。它需要的 `roster` 自己拉一次（`getRosterView()` 或更轻的 roster-only helper）；`matchProject` 由加载 `projects.json` 得到。

```ts
// notifyActNowIfNew（已 async）：
const roster = await loadRosterForAttribution();   // 复用 getRosterView 或轻量变体
const matchProject = await loadProjectMatcher();   // 加载 projects.json
const { projectId } = await attributeAnomalyToProject(anomaly, roster, matchProject);
const projectName = projectId ? projectNameOf(projectId) : null;  // projectNameOf 读 projects.json
const body = formatMessage(anomaly, { projectName });

// formatMessage（保持 sync 纯函数 —— 归属判定已在调用方做完）：
function formatMessage(a: Anomaly, ctx: { projectName: string | null }): string {
  // ...
  if (ctx.projectName) {
    lines.push(`⚠️ *${ctx.projectName}* 项目 · ${a.rule}`);
    lines.push(`触发于 ${subject} 的最近一次 session`);
  } else {
    lines.push(`⚠️ *${a.rule}* — ${subject}`);  // 顶层/未知 → 旧格式
  }
}
```

由 feature flag `WORKBOARD_PUSH_PROJECTS=1` 控开关（见 §7 P1.5）——关闭时 `notifyActNowIfNew` 跳过归属判定、直接旧格式；service 若有 attribution bug，flag 瞬时回滚，不撤代码。

### 4.5 Sidebar 命名

`Sidebar.tsx:50` 当前把 `/tasks` 标 "Projects"，与新 workboard 撞名。**决策**：`/tasks` label 改 **"Dispatch"**，icon `FolderKanban → Send`。`/tasks` 一直是 PMA 派单记录，"Dispatch" 更贴。`/status` 路径不动，H1 改 "Workboard"。

**过渡**（renaming 是肌肉记忆变化）：P2 落地时 sidebar 显 `Dispatch (formerly Projects)` 一周 + `/tasks` 顶部一次性 dismissible toast；一周后 cleanup PR 移除副标。

回退方案（leader 反对改 `/tasks`）：保留 "Projects" 指 `/tasks`，workboard H1 用 "工作板（按项目）"——绝不并存两个 "Projects"。

### 4.6 Search modal 加 project 索引

`Sidebar.tsx` cmd-K 索引当前读 `/api/agents + /api/tasks + /api/meetings`。加 `/api/workboard` 取 projects，新增 `SearchHit type: 'project'`，href → `/status/project/[id]`。P3 同 PR 落（否则项目卡跳搜索断链）。

### 4.7 CLI `team:workboard`

新增子命令，markdown 版项目卡列表。**不删 `team:status`**。异常归属与 web 共用 `attributeAnomalyToProject`。

### 4.8 测试 — `src/services/workboard.test.ts` + `src/lib/project_match.test.ts`

- **matcher 信号优先级**：构造 ctx 同时命中 path_prefix(0.85) + keyword(0.55)，断言取 0.85。
- **path_prefix 最长匹配**：`D:/hrdai/team` vs `D:/hrdai` 双登记，cwd=`D:/hrdai/team/src` → 断言归 team。
- **llm_repo_tag 不足以独立 match**：仅 llm_repo_tag(0.45) 命中 → 断言进未归类区。
- **ambiguous**：两项目都 ≥ 0.7 → 断言进未归类 + reason='ambiguous'。
- **空登记表**：`projects.json` 缺失 → 断言所有 WorkItem 进 unclustered，`degraded.reason='empty-registry'`，不抛错。
- **列表 payload 匿名性（强不变量）**：用一组含已知 roster 成员名的 fixture 跑 `getWorkboardView()`，把返回**整体序列化成字符串**，断言不含任何 roster 成员名子串（覆盖 `ProjectCardSummary` 和 `UnclusteredThread` 两条路径）。这把匿名性从"组件渲染纪律"升级成"service 输出契约"。
- **alias 漂移 fixture**：用 `private/cc_summary_cache.json` 真实快照里观测到的 repo 变体，断言 collapse 到同一项目。
- **anomaly 归属白名单**：每条 RULE_LABEL 断言归项目 or 顶层。
- **anomaly 归属退路**：(a) seqs 非空 + event.cwd 有值 → cwd-from-event；(b) seqs 空 → cwd-from-current-session；(c) 都无 → unknown 进顶层。
- **projectStatus 防抖**：单条卡住不翻红；两条翻红；一条 + 一 anomaly 翻红。
- **单贡献者隐藏**：`contributors.length === 1` → 详情页参与成员 section 不渲染。
- **空 relatedTaskIds**：→ 不渲染空 section。

---

## 5. 隐私 / 反监控设计（核心）

| 反监控原则 | 落地 |
|----------|------|
| 主轴翻成项目 | §2.2 首屏项目卡，无 24 行人 |
| CC 首屏匿名 | 工作线只 `状态 · 标题`；卡底 `N 个 CC`；人名只在详情页 |
| 砍记分牌排序 | 项目卡排序按"卡住→活跃→收尾→休眠 + lastActivityAt"，**不按人活跃度** |
| 砍活跃灯审判 | 不显个人 active/idle/dormant 灯于列表 |
| 砍"谁干得多/少" | 详情页参与成员字母序、无计数；仅 1 人时整块隐藏 |
| 砍"最久没动的人" | 移除该 stat；项目层只有"最久没动的项目" |
| 异常主语挪到项目 | §2.4 白名单 + Slack push 同源（§4.4） |
| 不引入"该谁接手"判断 | workboard 只读；派单留给 PMA 流程 |
| 未归类不羞辱 | "未归类工作线"区视觉权重等同项目卡，不是折叠抽屉 |
| 配额不进项目主语 | `quota.*` 永远顶层异常，不归项目卡 |

**仍剩的监控向量 + 触发回退**：项目详情页 + 个人详情页仍能看到"谁做了什么"——这是 leader 找人谈的必要能力，是钻取动作不是默认暴露。若 P2 落地后 2 周内 leader 主动反馈 OR 任一成员 retro 提出 OR 详情页"按成员过滤"使用率审计 > 30%（明显被当查人工具用），一周内出更克制变体（详情页工作线默认收起 owner，hover 才出）。

---

## 6. 边界情况

| 情况 | 处理 |
|-----|------|
| `D:\hrdai` 单 repo 装多项目 | §3.2 `path_prefix` 最长匹配区分 `D:/hrdai/team` vs `D:/hrdai/MiroFish` |
| 一个 CC 跨多个项目并行 | 该 owner 的多条 WorkItem 分别匹配，散到多张项目卡 + ccCount 各自计入。卡间无主次 |
| 工作线匹配不到任何项目 | 进未归类区，平铺，带"建议建为项目"affordance |
| 工作线 ambiguous（多项目都 ≥0.7） | 进未归类区，标"待确认归属" |
| 登记表为空 | 全部进未归类区，`degraded='empty-registry'`，软聚类列表模式 |
| 产品/运营项目无 cwd | **只能靠 `task_link`（0.7）聚类**——须经 PMA 派单且 Task 关联到该项目。`keyword`/`member_area` 软信号 max 仅 0.55，**不足以独立聚类**（§3.2）。不走 PMA 派单的此类工作 → 结构性停留未归类区，靠"建议建为项目"+ 手工登记接管。已知局限 |
| collector（8080）挂 | `getRosterView` 已优雅降级（live 层返回空 map）；workboard 用 events-derived 视图，`degraded='collector-down'` |
| LLM 挂（work_summary） | `readCachedSummaries` 服务上次缓存（标 stale）；workboard 照常聚类，degraded 提示 |
| 项目 14 天无活动 | 不在列表显示；`projects.json` 标 `archived` 或直链可访问标"冷冻" |
| 仓库改名 / fork | 在 `projects.json` 的对应 matcher 加新 path/remote；id 不变，历史连续 |
| anomaly subject 是 task/commit | §2.4 白名单，多数归顶层 |
| anomaly 无 evidence_event_seqs | §2.4.2 Step 2/3 退路（currentRepo → 顶层） |
| 一个项目只有一个 CC | 仍是项目卡，不退化成 person 卡。哪怕一个人，主语还是项目 |
| LLM 把整条 cwd 路径塞进 `WorkItem.repo` | matcher 里 `llm_repo_tag` 信号先过 `repoFromCwd()` 再比 aliases；且置信 0.45 不足以独立 match |

---

## 7. 落地分阶段

| 阶段 | 文件 | 行数 | 何时 |
|-----|------|------|------|
| **P0 · 覆盖率审计** | `tools/audit-project-coverage.ts`、`tools/projects-seed.ts` | ~180 | P1 前 |
| **P0.5 · seed 登记表** | `private/projects.json`（人工/半自动）、`private.example/projects.example.json` | 配置 | P1 前 |
| **P1 · 后端聚合** | `src/services/workboard.ts` (~280)、`src/lib/project_match.ts` (~150)、`src/lib/project_match_weights.ts` (~20)、`src/lib/events.ts` 加 `getEventBySeq` (~60)、`/api/workboard` + `/api/workboard/project/[id]` (~90)、`workboard.test.ts` + `project_match.test.ts` (~320) | ~920 | 单 PR |
| **P2 · 列表页 + 详情 stub + Sidebar** | `src/app/status/page.tsx` rewrite (~270 delta)、`src/components/ProjectCard.tsx` (~150)、`src/components/ThreadCard.tsx` (~70)、`src/app/status/project/[id]/page.tsx` stub (~110)、`Sidebar.tsx` label/icon/toast (~35) | ~635 | P1 后 1-2 日 |
| **P1.5 · Slack push 项目主语** | `leader_push.ts` (~80)、`notifyActNowIfNew` 拼接 (~30)、flag `WORKBOARD_PUSH_PROJECTS` | ~110 | P2 后第 3 日（先 UI 验完再切 Slack） |
| **P3 · 详情页完整版 + search** | `status/project/[id]/page.tsx` 完整 (~280)、search modal 加 project kind (~40) | ~320 | P2 后 1 周 |
| **P4 · person detail 项目 chips** | `status/[name]/page.tsx` 顶部 chip 行 (~30) | ~30 | P3 同 PR |
| **P5 · CLI workboard** | `src/scripts/team.ts` 加 `workboard` 子命令 (~80) | ~80 | P3 后或并发 |
| **P6（条件性）· §9 数据请求** | extractor 改动（A 类）或 collector 协调（B 类） | 见 §9 | 视 §0.6 审计 + leader 决定 |

**拆分理由**：
- P1 后端纯 service + 测试，独立可 review，零 UI 风险。
- P2 紧跟，leader 在 web 看到效果。
- P1.5 滞后 + flag——Slack 主语和 UI 不在同一刻切换；attribution bug 时 flag 回滚。
- P2 内嵌"最小可点 stub 详情页"避免点项目卡 404；stub 仅展示工作线 grouped list，完整版 P3。

### 7.1 不动的东西

`/api/cc-status`、`getRosterView` / `getOneStatus`、`work_summary.ts`、`WorkItem` / `Anomaly` schema、PMA / bootstrap / evolve / sim、person detail 主体（只加 chips）、`/status` 路径、sidebar 路由（只改 `/tasks` label）。

---

## 8. 风险

1. **覆盖率风险** — §0.6 审计前置 + 软聚类保底（即使 `clusterable_rate` 低，平铺工作线列表仍可发，仍去监控）。
2. **产品/运营项目无 cwd** — `keywords` / `member_areas` matcher 兜底 + "建议建为项目"运行时补登记；§9 A-2（首条 prompt）接入后这类项目的关键词信号更强。
3. **登记表维护成本** — 首版 10-20 条，运行时增量补。若 leader 不愿维护 → 退化软聚类列表模式，方案不崩，只是没项目卡。
4. **配额异常的"项目化尴尬"** — §2.4 白名单严格隔离 `quota.* / context.* / danger.* / override.spike` 永远顶层。
5. **"换皮监控"批评** — §5 三管齐下（翻轴 + 匿名 + 砍记分牌）+ 未归类不羞辱 + §5 回退触发条件。
6. **LLM `WorkItem.repo` 漂移/污染** — matcher 里 `llm_repo_tag` 置信仅 0.45，**不足以独立 confident match**，必排路径/remote/branch 佐证；§4.8 alias fixture 守护。
7. **anomaly 路径当前几乎无 production rule** — §2.4.1 公开声明项目卡 ⚠ 初期主要来自 `WorkItem.status`，非 hidden bug。
8. **leader 真正诉求是 PMO 工具** — 本方案诚实克制（无 deadline/进度）。发布附话术："没有 deadline/进度 telemetry；要么用这版只读视图，要么单独立 PMO spec"。§9 B-3（plan 文本）接入后可补"工作定义"，但仍非进度。
9. **置信阈值/权重拍脑袋** — 全部初始值，集中在 `project_match_weights.ts`，§0.6 审计后按真实命中分布校准。
10. **`getEventBySeq` 首次全扫成本** — §4.3 已声明懒构建 + 首调一次性成本；24 人团队的 events.jsonl 规模可接受。

### 8.1 审计结果填写区

> P0 跑完 `audit-project-coverage.ts` 后把数字填这里，才能开 P1 PR：
> `clusterable_rate = ___%` · `unclustered_rate = ___%` · `repo_signal_variants = [...]` · `no_cc_data = ___ 人`
> 决策：达标 / 补 matchers 复测 / 先做 §9 A 类

---

## 9. CC 数据增强请求（给 8080 collector 维护者）

> 方案**不依赖**这些数据也能跑（§1 目标 5）。但接入后匹配精度显著提升、LLM 推断可被 ground truth 替代。
> **关键发现**：CC 上传的 jsonl **已经带**大量有用字段，collector 已收到，只是 team 的 `cc_session.ts` extractor 当前没解析。这类是"零成本 A 类"——只改 extractor，不动 collector。真正需要 collector/hook 改动的只有 B 类（git remote）。

### 9.1 A 类 — 已在上传的 jsonl 里，只需扩 extractor（零 collector 成本）

`cc_session.ts` 注释自己列了 jsonl 真实行型：`last-prompt` / `permission-mode` / `worktree-state` / `attachment`（hooks）/ `system`(subtype `stop_hook_summary`)。当前 extractor 把这些**全部 ignore**（`cc_session.ts:265-271`）。

| # | 数据 | 在 CC jsonl 哪里（已逐条对 `cc_session.ts` 核实）| 解锁什么 | 优先级 |
|---|------|-----------------|---------|--------|
| A-1 | **TodoWrite / Task 工具的 input** | `assistant` msg 的 `tool_use` block，`name ∈ {TodoWrite,TaskCreate,TaskUpdate}` 时其 `input` 字段。extractor 的 tool_use 循环（`cc_session.ts:220-261`）**已遍历每个 tool_use block**，只是仅对 `Bash` 读 `input`（`:234-237`），其余 tool 的 `input` 被丢弃。⇒ 纯 extractor 改动，零 collector 成本 | CC 自己的 todo list 是**单 session 内的任务脚手架**——是**一个强的新匹配信号**喂进 `MatchContext`、并可作为 `work_summary.ts` LLM 推断结果的**交叉校验**。**不是** `WorkItem` 的 drop-in 替代（CC todo 不是团队级工作线分类，粒度/语义不同）| **P0** |
| A-2 | **每个 session 的首条 user prompt** | 第一条 `type:'user'` 且非 tool_result 的消息（`extractUserText` / `looksLikeToolResult` 已存在，`cc_session.ts:359-373/345-357`）。⚠ **不要**用 `last-prompt` 控制帧——名字语义是"最近一条"不是"首条"，且帧内容未经核实 | session 意图 → 工作线标题 + matcher 的 `firstPrompt` 关键词信号（让破平更准；**注意**：firstPrompt 只喂 `keyword`(0.55) 软信号，不能让无 cwd 项目独立聚类——见 §3.2）| **P1** |
| A-3 | **end-of-turn recap** | `system` 帧 `subtype:'stop_hook_summary'`（comment `cc_session.ts:16` 列了此 subtype，`:269` 当前 ignore）。⚠ **帧内是否真含模型自写的"what changed/next"文本，代码注释只给了 subtype 名、未给 payload 结构——需向 collector 维护者确认 payload 内容**再决定怎么用 | （确认 payload 后）便宜的进展 + 状态信号，喂软聚类 | **P1（待确认 payload）** |
| A-4 | **worktree / permission-mode 状态** | `worktree-state` / `permission-mode` 控制帧（`cc_session.ts:12` 列出，`:267-268` ignore）。✅ 已核实在 jsonl 里 | 区分主 checkout vs worktree（matcher 的 branch 信号更准）；permission-mode 旁证会话性质 | P2 |
| A-5 | **Edit/Write 的 file_path** | `tool_use` block `name ∈ {Edit,Write}` 的 `input.file_path`。✅ 同 A-1 机制——循环已遍历，只是没读 `input` | 实际改动的目录 → monorepo 子目录的 path 信号（补强 §3.2 path_prefix） | P2 |
| A-6 | **PostToolUse 退出码** | `attachment` 帧 `hookEvent:'PostToolUse'`（`cc_session.ts:13` 列了 `attachment` 帧带 `hookName/hookEvent`，`:265` ignore）。⚠ 前提：collector 的 hook 配置确实启用了 PostToolUse —— 代码无法证明，需确认 | 工具失败率 + 重复失败 → `卡住` 检测精度（`docs/leader-view-data-asks.md` 已列为想要） | P2 |

**A 类落地** = 扩 `src/extractors/cc_session.ts` 的 switch，新增事件类型 `cc.todo_snapshot` / `cc.session_intent` / `cc.recap` / `cc.file_touched` 等，喂进 `MatchContext`。无需联系 collector 维护者（A-3 / A-6 需先确认 payload / hook 配置，但确认本身不需 collector 改代码）。

### 9.2 B 类 — CC jsonl 不带，需 collector hook 改动

| # | 数据 | 怎么拿 | 解锁什么 | 优先级 |
|---|------|--------|---------|--------|
| B-1 | **git remote URL + repo root** | collector 的 SessionStart hook 脚本里加两条命令：`git -C "$cwd" remote get-url origin` 和 `git -C "$cwd" rev-parse --show-toplevel`，把结果写进上传的 session 元数据 | **canonical 项目身份**（置信 1.0 / 0.9）。直接终结 §0.3 的"cwd 末段瞎猜"——`github.com/hrdai/team` 是稳定唯一标识，monorepo 子目录用 repo_root + path_prefix 组合精确定位 | **P0** |
| B-2 | **machine_id ↔ 项目的稳定关联** | collector 已有 `machine_id`（`live_cc.ts:35`）；若 hook 能附本机常驻项目清单更好，否则 B-1 已够 | 跨 session 的项目连续性 | P3 |

**B-1 是给 8080 维护者的核心请求**：在 SessionStart hook 加 `git remote get-url origin` + `git rev-parse --show-toplevel`，附进 session 元数据。一行 hook 命令，换来项目身份从"启发式猜测"变"精确标识"。

### 9.3 优先级总结（给 leader + 8080 维护者）

1. **B-1（git remote / repo root）** — 唯一需要 collector 改的，价值最高，成本是"SessionStart hook 加两条命令"。
2. **A-1（TodoWrite/Task input）** — 零 collector 成本，给匹配器加一个强的 ground-truth 信号 + 交叉校验 LLM 推断（不是替代 `WorkItem`）。
3. **A-2（首条 prompt）** — 零 collector 成本，补强匹配的破平信号（注意：不让无 cwd 项目变得可独立聚类）。
4. A-3（待确认 payload）/ A-4 / A-5 / A-6（待确认 hook 配置）— 零 collector 成本，逐步接。

**没有任何一条是 P1 阻塞**——§0.6 审计若 `clusterable_rate < 50%`，优先做 A-1 + A-2（纯 extractor 改），再不够才等 B-1。

---

## 10. 验收

- leader 进 `/status`，扫一眼第一句是"哪个**项目**卡了"，不是"哪个**人**红灯"。
- 首屏工作线只显「状态 · 标题」；卡底「N 个 CC」匿名计数；**首屏任何位置无人名**。
- 人名只在 `/status/project/[id]` 详情页（工作线右下小字 + 参与成员）和 `/status/[name]` 出现。
- 单 CC 在某项目卡住 → 显示「TeamBrain · ⚠ consent gate 设计」，点进详情才见"张三 · 2d"。
- 项目详情页无排名 / 对比柱 / 进度条；参与成员字母序无计数；仅 1 人时整块隐藏。
- 匹配不到项目的工作线进"未归类工作线"区，平铺，不是折叠羞辱抽屉。
- 登记表为空时系统不崩，退化成平铺工作线列表，`degraded` 提示。
- Slack DM 在 `silence.dormant / blocked.* / dispatch.uncertain` 上主语是项目名，与 UI 一致。
- `/api/cc-status` 仍可用，CLI `team:status` 输出不变；新增 `team:workboard`。
- sidebar 无两个并列 "Projects"。
- §8.1 审计结果已填，`clusterable_rate` 达标或已走补救路径。
- `project_match.test.ts` + `workboard.test.ts` 全绿（信号优先级、最长前缀、llm_tag 不独立、ambiguous、空登记表、alias 漂移、anomaly 白名单、anomaly 退路、防抖、单贡献者、空 task）。
- 不依赖 §9 任何数据请求即可发 P1（数据请求是增强，非阻塞）。

---

## 11. 待 leader / 8080 维护者拍板

1. **`projects.json` 谁来维护、初始 seed 怎么来**？建议 leader 人工列 10-20 个（`tools/projects-seed.ts --interactive` 给脚手架），运行时靠"建议建为项目"增量补。
2. **`/tasks` sidebar label 改 "Dispatch"**？还是走回退（保留 "Projects"，workboard H1 用 "工作板"）。
3. **§9 B-1（SessionStart hook 加 git remote）** 8080 维护者能否配合？这是把项目身份从"猜"变"准"的唯一外部依赖。
4. **§9 A-1（TodoWrite/Task input 接入）** 是否纳入 P1 范围？纯 extractor 改动，但能把工作线从 LLM 推断升级成 ground truth——值得早做。
5. 未归类工作线区默认展开还是折叠？建议**展开**（折叠 = 变相羞辱抽屉，违背 §5）。
