# UX 重构方案：从「人 = 单位」到「项目 = 单位」的 WIP 展示 — v10

> 受众：Rocket Team leader + 团队成员 + Matrix-Riven (:8933) collector 维护者(注:也是本文档的 leader)
> 日期：2026-05-15（v10：吸收 Matrix-Riven 现状——明确架构分层(§0.7)：collector = 纯数据源,所有 smartness 在 team app；§9 raw_prompt 状态更新（已在 `CcStatusSnapshot.raw_prompt`,只需 env）；B-1 改为兼容性请求而非负担；`docs/collector-data-asks.md` 同步重写）
> （v9：删全部日历推理,§7 重写为 S1→S9 线性 build pipeline）
> （v8：新增 S8「项目画像」层）
> （v7：parseSummary 强制点、审计分期、projects.json 并发写、EvidenceRef union、提取 pass 测试）
> （v6 架构分叉：用 **LLM 归属** 取代 v4-v5 的确定性加权 matcher；项目登记表改为 **AI 自动提取 + 身份解析器**，去掉 leader 确认 gate）
> 关联：`UX-CC-FIRST.md`（继承 §0 数据真实性契约）、`docs/leader-view-data-asks.md`、`docs/collector-data-asks.md`、`BACKEND-REDESIGN.md`
>
> **v6 相对 v5 的根本变化**（v1-v5 的演进史见文末附录）：
> - 杀掉确定性加权 matcher（v5 §3.2 的 git_remote 1.0 / path_prefix 0.85 / keyword 0.55 …「取 max 卡 0.7」那套）。原因：① 它是整个 LLM-driven 代码库里唯一的异类；② cwd 是"在哪"不是"在干嘛"——CC 开在 matrix 文件夹却在聊别的事，加权 matcher 会取 0.85 cwd 误判；③ 无 cwd 项目结构性过不了 0.7 门槛。
> - 项目归属改为 **LLM 判断**，且**折叠进 `work_summary.ts` 已有的带缓存 LLM 调用**——零新增 LLM 调用。
> - 项目登记表改为 **AI 自动提取**（从 events.jsonl 的 4 个统一源：CC / 会议 / Slack / GitHub），**无 leader 确认 gate**。漂移由**身份解析器**（identity resolver）解决，不是靠人。
> - 登记表 schema 瘦身：删掉手维护的 `matchers` 字段块。
> - `src/services/work_summary.ts` **从"不动"清单移除**——它现在要改（吃登记表、吐 projectId）。`WorkItem` 类型加 `projectId`。

---

## 0. 概念地基

### 0.1 现状与监控感诊断

`/status` 是「24 行人 × 状态」的 roster（`src/app/status/page.tsx`）。视觉首要轴 = 人。

监控感**不**来自「leader 能看到 CC 在做什么」——那是合理管理需求。监控感来自三件事：

| 监控感来源 | 不是监控感来源 |
|---|---|
| 主轴是「人」，首屏 24 行人脸 | 把"在做什么"列出来 |
| 按异常/活跃排序、休眠垫底 | leader 能钻取看具体某条工作 |
| 活跃灯当评判标签、「最久没动的人」stat | 项目卡里显示有 CC 在推进 |

⇒ **去监控 = 翻轴（人→项目）+ 砍记分牌编码（排序/灯/排名）+ CC 首屏匿名化**。三个一起。

### 0.2 锁定的概念全景

1. **主轴 = 项目**。首屏 N 张项目卡，不是 24 行人。
2. **单位 = 工作线（`WorkItem`）**。`work_summary.ts` 已经把每人 CC 活动整理成 `WorkItem[]`。
3. **CC = 匿名工作单元**。首屏工作线只显「状态 · 标题」；卡底显「N 个 CC 在跑」。**人名只在钻取详情页出现**。
4. **去监控 = 翻轴 + 砍记分牌 + CC 匿名化**（§0.1）。
5. **项目身份 = AI 提取 + 身份解析器维护的稳定登记表**（§3）。无 leader 确认 gate；漂移与聚合由解析器处理；leader 有 override 面但不是 gate。
6. **工作 → 项目的归属 = LLM 判断**，折叠进 `work_summary.ts` 现有的带缓存 LLM 调用（§3.3）。不是确定性加权 matcher。
7. **软聚类**：LLM 给出 confident `projectId` 的工作线 → 进对应项目卡；LLM 判 `unclear` 的 → 作为独立工作线卡平铺（**不叫 orphaned，不进折叠抽屉**，视觉权重等同）。登记表为空 / LLM 不可用时系统仍能跑（§6 降级表）。

### 0.3 什么算「一个项目」

**项目不是从 cwd 反推的东西**（v1-v3 曾把「项目 = `repoFromCwd(cwd)`」当定义，是地基洞——`D:\hrdai` 单 git 仓库装 `team/` `MiroFish/` `socialmind/` 多个项目，`repoFromCwd` 取末段会把 `D:\hrdai\team\src` 和 `D:\hrdai\MiroFish\src` 都猜成 `"src"`）。

**v6 定义**：一个项目是**一个有稳定 id 的登记表实体**。登记表由 **AI 从 events.jsonl（CC 会话 / 会议 / Slack / GitHub 四源统一）自动提取**（§3.2），由**身份解析器**分配稳定 id 并去重（§3.4）。一个项目实体：

```jsonc
{
  "id": "matrix",                  // 稳定 slug，解析器分配，永不变
  "name": "Matrix",                // display name，首次提取设定，之后 sticky
  "status": "active",              // active | archived
  "aliases": ["matrix", "matrix-recording", "teambrain"],  // 解析器累积的表面名
  "description": "...",            // LLM 提取的项目描述——归属判断时 LLM 读它
  "evidence_refs": [ /* EvidenceRef[]：会议/Slack/CC 引用，提取依据 */ ],
  "observed_cwds": ["D:/hrdai/team", "D:/work/TeamBrain"],  // 归属决策累积的 cwd→项目 学习索引（§3.5）
  "first_seen_at": "ISO", "last_attributed_at": "ISO"
}
```

注意：**没有手维护的 `matchers` 字段块**（v5 有，v6 删）。LLM 归属靠 `name + aliases + description + evidence_refs` 判断；`observed_cwds` 是归属决策的副产物，供异常归属做廉价查表（§3.5）。

上面是核心字段。**§3.4 还会再加两个字段**：`resolution_log`（解析器每次合并/mint 的留痕）和 `overrides`（leader 事后纠正记录）。**§3.6 S8 阶段再加一个 `profile` 子对象**（4 个深度理解字段 + staleness 信号；详见 §3.6）。完整 schema = 上面这些 + §3.4 两个 + §3.6 一个。S2 上线时 `profile` 是空的；S8 上线后逐步充满。

登记表可以为空——那系统退化成平铺工作线列表模式（§6），仍可用，仍去监控。

### 0.4 什么算「同一个项目」

v1-v3 的答案 = 同一个 slug 字符串（语法）。v6 的答案 = **身份解析器把多个表面名 resolve 到同一个 canonical 项目 id**（§3.4）。

两类「同一个」：
- **漂移**：一个项目被 LLM 在不同次提取里叫成不同名（"季度文章" / "Q2内容"）。解析器把后来的 proposal resolve 回老 id。
- **聚合**：多个不同的表面名/仓库本就属于一个伞项目（`matrix` + `matrix-recording` + `teambrain` → `Matrix`）。解析器折叠：
  - `matrix` + `matrix-recording` —— 共同前缀，**确定性快路径**自动折叠，零风险。
  - `teambrain` → `matrix` —— 字符串零重叠，需**LLM 语义合并**判断（依赖提取时 LLM 读到过链接证据，如会议里"teambrain 是 matrix 的录制模块"）。

### 0.5 数据真实度（继承 UX-CC-FIRST §0）

| 字段 | 来源 | 真实度 |
|------|------|--------|
| `WorkItem.title / status / detail` | LLM 从 7 天事件 + live 快照抽（`work_summary.ts`） | narrative，有 evidence 支撑 |
| `WorkItem.projectId`（v6 新增） | 同一个 LLM 调用判断（§3.3），**必带 `attribution_evidence` 引用** | narrative-judgment，但有 evidence + 约束到登记表 id |
| 项目 `description / aliases / evidence_refs` | AI 提取（§3.2），**必带 evidence** | narrative-judgment，有 evidence |
| `observed_cwds` | 归属决策的副产物（纯记录，不推断） | **真** |
| session `cwd / gitBranch` | CC jsonl 行内 `row.cwd / row.gitBranch`（`cc_session.ts:187-190`，首行带值者胜） | **真** |
| 项目「进度%」「deadline」「燃尽」 | 没有 | **禁止显示** |

**v6 的诚实纪律（核心，否则 LLM 判断就成了"编的当真的"）**——三条，§3.3 / §3.4 强制：
1. **约束输出**：LLM 归属只能输出 {登记表已有 id} ∪ `"new:<提议名>"` ∪ `"unclear"`，不许自由发挩编项目。
2. **evidence 必带**：每条归属、每条提取都必须带一句 evidence 引用（≤200 字符，来自真实事件）。这比"匹配了 path_prefix 0.85"是**更好**的审计线索——是人话理由。
3. **稳定 id 解析器**：LLM 归属/提取都非确定性，重跑会漂。解析器（§3.4）把 proposal resolve 回老 id 来吸收漂移，是地基不是可选项。

### 0.6 两道审计门槛（分期，因为度量依赖不同阶段的产出）

v6 冷读发现一个分期矛盾：`attributed_rate` 这类度量需要 §3.3 归属（S2 才有），不可能在 S1 测。⇒ 拆成**两道门**：

#### 门 A — S1 收尾（解析器-only，提取 + 解析器跑完即可测）

```bash
bun run tools/audit-resolver.ts
```
- `id_stability`：连续两次跑提取+解析，已有项目 id 是否 100% 不变（**必须 100%**，否则解析器有 bug）。
- `new_proposal_churn`：连续两次跑，`"new"` 提议里被解析器**误判成新项目**（实则应 resolve 到已有）的比例。
- `extraction_evidence_coverage`：提取 pass 产出的项目里 `evidence_refs` 非空的比例（**必须 100%**，§0.5 纪律 2）。

**门 A 门槛**：`id_stability == 100%` ∧ `extraction_evidence_coverage == 100%` → 放行 S2。任一不达标 → **阻塞**，必修。

#### 门 B — S2 收尾（归属-依赖，§3.3 归属上线后才能测）

```bash
bun run tools/audit-attribution.ts
```
- `attributed_rate`：分母 = `activityFlag ∈ {active, idle}` 成员的全部 `WorkItem`；分子 = LLM 给出非 `unclear` `projectId` 的条数。
- `unclear_rate`：判 `unclear` 的占比。
- `attribution_evidence_coverage`：有非 `unclear` `projectId` 的 WorkItem 里带 `attribution_evidence` 的比例（**必须 100%**）。注意：因 `parseSummary` 缺 evidence 即把该条降级为 `unclear`（§3.3），此覆盖率**按构造恒为 100%**——门 B 此项**不是独立质量度量，而是对 §3.3 强制逻辑的回归探测**：若它 < 100%，说明 `parseSummary` 的强制点有 bug，必修。

**门 B 门槛**：
- `attributed_rate ≥ 70%` ∧ `attribution_evidence_coverage == 100%` → S3 UI 放行。
- `attributed_rate ∈ [50%, 70%)` → 先补登记表 `description`（提取 pass 跑得不够 / 描述太薄，LLM 归属没料判断），复测。
- `attributed_rate < 50%` → 提取 pass 质量不行，先调 §3.2 提取 prompt + 接 §9 数据增强，复测达标再发。
- `attribution_evidence_coverage < 100%` → **阻塞**，`parseSummary` 强制点有 bug，必修。

注意：`attributed_rate` 低**不阻塞软聚类模式发布**（§6）——平铺工作线列表本身已去监控。门 B 把关的是"项目卡"增强层。

### 0.7 架构分层(v10 明确)：Matrix-Riven = 数据源,team app = 所有 smartness

Matrix-Riven (`:8933`,见 `docs/collector-data-asks.md`)是上游 collector。它的职责**仅限**:
- 接 CC transcripts(`POST /v1/cc-sessions`)+ cc-status 快照(`POST /v1/cc-status`)
- 按 `<user>/<date>/` 落盘
- 提供 `/api/file?...` 等查询端点
- 自带一个 collector 维护者用的 dashboard(Browse + Overview tab,`/api/overview?date=`,naive `basename(cwd)` 聚合)

**Matrix-Riven 不知道**:有"项目"这个概念、有 LLM、有多源融合、有项目登记表。它只看 user / session / cwd / 时刻 / 花费 / 工具调用。

**所有 smartness 全在 team app**:
- 4 源融合(CC 来自 Matrix-Riven + meeting/slack/github 来自 team 自己的 extractors)→ `events.jsonl`
- LLM 归属(`work_summary.ts` 折叠)
- 项目登记表 + 提取 pass + 身份解析器
- 项目画像(S8)
- `/api/workboard` + `/status` UI

⇒ Matrix-Riven 的 `/api/overview` Overview tab 和 team app 的 `/status` 工作板是**不同受众的两个工具**:
- Matrix-Riven Overview = collector 维护者兜底看原始聚合
- team app 工作板 = leader 项目维度管理(本方案产物)

**不互依也不互调**。Matrix-Riven 的 Projects panel 因为 `basename(cwd)` 会撞车(`D:\hrdai\team\src` 和 `D:\hrdai\MiroFish\src` 都成 `src`),那是它自己的展示口径选择,跟我们工作板无关——我们走 LLM 归属,语义正确。

**§9 数据请求的定位**:不是"求 Matrix-Riven 替我们做事",是"麻烦它 hook 多抓两条信息附进现有 cc-status snapshot"。Matrix-Riven 仍然不知道项目是什么,只是把更全的环境快照传给下游。

---

## 1. 设计目标

1. **主视觉单位 = 项目卡**。
2. **工作线为聚类单位**，CC 首屏匿名。
3. **不删任何现有功能**：异常列表、person detail、aggregate 全保留。
4. **不编造项目维度**：进度/deadline/燃尽一律不上。
5. **零数据依赖也能跑**：登记表为空 → 平铺工作线列表。§9 数据请求是增强，非阻塞。
6. **三渠道同逻辑**：Web / CLI / Slack push 共用同一套归属逻辑。
7. **优雅退化**：每种**运行时**失败（LLM 不可用、collector 挂、登记表空）都有定义好的降级形态。覆盖率低不是运行时失败，是 §0.6 发布前门槛。
8. **架构与代码库一致**：归属用 LLM（同 `work_summary` / `bootstrap` / PMA），不引入异类的确定性加权 matcher。

---

## 2. 信息架构

### 2.1 三层结构

```
Level 1 — /status（内部叫 "Workboard"；URL 保留 /status）
   ┌─ 顶层异常区 — §2.4 白名单留顶层的（quota / context / danger / override）
   ┌─ 项目卡列表  ←——— 主视觉
   └─ 未归类工作线区 — LLM 判 unclear 的，平铺，视觉权重等同项目卡

Level 2 — /status/project/[id]
   ┌─ 项目 hero（项目名 + 状态分布 + N 个 CC + 最近活动）
   ┌─ 工作线（卡住→进行中→调研中→已完成），每条右下小字才显「某成员 · ago」+ LLM 归属理由
   ┌─ 参与成员（≥2 人才显，字母序，无计数无排名）
   └─ 关联 PMA 派单（仅非空才渲染）

Level 3 — /status/[name]
   不变。从项目详情页成员名 / 搜索进入。
```

### 2.2 列表页（`/status`）布局

```
┌─ Header ─────────────────────────────────────────────────┐
│ Rocket Team / Workboard                          [Refresh]│
│ 项目维度看在做的事 · {N} 个项目在跑 · {K} 个卡住          │
│   （{N}{K} 运行时数，不在 mock 里 hardcode）             │
└──────────────────────────────────────────────────────────┘

┌─ 顶层异常（不可归项目的）───────────────────────────────┐
│  例如 quota.pace_7d (戴昊然) — 留这里（§2.4 白名单）     │
└──────────────────────────────────────────────────────────┘

┌─ 项目卡 ── 卡住（红框）─────────────────────────────────┐
│  Matrix                                      ⚠ 卡住     │
│  • ⚠  consent gate 设计                                 │
│  • ⏳ matrix-recording 接入                             │
│  • 🔍 PII redactor 性能                                 │
│                              3 个 CC · 最近 12m         │
└──────────────────────────────────────────────────────────┘

┌─ 未归类工作线 ──────────────────────────────────────────┐
│  这些工作线 LLM 还没能 confidently 归到项目。           │
│  • ⏳ 季度汇报数据整理                                   │
│  • 🔍 竞品调研                                           │
└──────────────────────────────────────────────────────────┘
```

- **工作线行 = `状态 dot · 标题`，完。不挂 CC 名、不挂人名。**
- **卡底 = `N 个 CC 在跑 · 最近活动 age`**。`N` 是匿名计数；点进详情页才落到「某成员 · ago」。
- **未归类工作线区**：视觉权重等同项目卡，不是折叠抽屉、不带 "orphaned" 字样。

### 2.3 项目卡状态推导（纯规则，无 LLM，带防抖）

```ts
function projectStatus(
  items: WorkItem[],
  attributedAnomalies: Anomaly[]
): '卡住' | '活跃' | '收尾' | '休眠' {
  // 防抖：单条 LLM 误判不应翻红一个项目。翻 '卡住' 须满足之一：
  //   (a) 有 anomaly 归到本项目（§2.4 白名单范围内）
  //   (b) ≥ 2 条 WorkItem.status === '卡住'
  const stuckCount = items.filter(i => i.status === '卡住').length;
  if (attributedAnomalies.length >= 1 || stuckCount >= 2) return '卡住';
  const ongoing = items.filter(i => i.status === '进行中' || i.status === '调研中');
  const done = items.filter(i => i.status === '已完成');
  if (ongoing.length === 0 && done.length > 0) return '收尾';
  if (ongoing.length === 0) return '休眠';
  return '活跃';
}
```

单条 `卡住` workItem 仍展示在卡里，只是不让整卡翻红。最近活动 = `max(lastActivityAt)`。

### 2.4 异常 → 项目归属

#### 2.4.1 白名单：哪些 rule 可归项目

| Rule（rule id 见 `status/page.tsx:106` 的 `RULE_LABEL`；CLI 侧另有 `cc_status.ts:664` 的 `RULE_LABEL_CLI`）| 去向 |
|---|---|
| `silence.dormant` | **项目** |
| `blocked.review_pending` | **项目** |
| `blocked.cc_attested` | **项目** |
| `dispatch.uncertain` | **项目**（推不出归顶层）|
| `override.spike` | **顶层**（关于派单流程本身）|
| `danger.command.*` | **顶层**（安全事件，不能被项目化淡化）|
| `quota.*`（pace/near, 5h/7d）| **顶层**（配额是个人维度）|
| `context.near_full` | **顶层** |
| 未列出的新 rule | **默认顶层**，引入时显式加映射 |

**公开 trade-off**：当前只有 `quota.pace_7d` 一条 live-derived rule 真在跑（`cc_status.ts:liveConcerns`），engine anomalies 尚未 production-active。⇒ 落地初期项目卡的 ⚠ **大概率来自 `WorkItem.status === '卡住'`，不来自 anomaly**。anomaly 路径是给未来 rule 留接口。

#### 2.4.2 算法：异常的 cwd → 项目（廉价查表，不调 LLM）

异常不走 LLM 归属（它们是 rule 触发的，没有 `work_summary` 的 LLM 摘要伴随）。异常归属用 §3.5 的 `observed_cwds` **学习索引**做廉价查表：

```ts
async function attributeAnomalyToProject(
  a: Anomaly,
  roster: RosterRow[]
): Promise<{ projectId: string | null; reason: AttrReason }> {
  if (TOP_LEVEL_RULES.has(a.rule)) return { projectId: null, reason: 'top-level' };

  // Step 1: 触发该异常的事件 cwd。Anomaly.evidence_event_seqs 是 number[]（事件序号，
  //   src/types/events.ts:120），要 join events.jsonl 取事件。evidence_event_seqs 为空
  //   ⇒ 跳 Step 2（live-derived anomalies 常态：liveConcerns() cc_status.ts:379 的
  //   anomaly-builder 永远返回 evidence_event_seqs: []。公开声明：live 路径全部走 Step 2）。
  const lastSeq = a.evidence_event_seqs.at(-1);
  if (typeof lastSeq === 'number') {
    const ev = await getEventBySeq(lastSeq);                 // §4.3 新增 seq 索引
    const cwd = typeof ev?.evidence.fields?.cwd === 'string' ? ev.evidence.fields.cwd : undefined;
    if (cwd) {
      const pid = lookupProjectByCwd(cwd);                   // §3.5：查 observed_cwds 学习索引
      if (pid) return { projectId: pid, reason: 'cwd-from-event' };
    }
  }
  // Step 2: 退回该人 currentRepo 的 cwd（getOneStatus 的 substantive session cwd）
  if (a.subject.kind === 'agent') {
    const row = roster.find(r => r.name === a.subject.ref);
    if (row?.currentRepo) {
      const pid = lookupProjectByCwd(row.currentRepo);
      if (pid) return { projectId: pid, reason: 'cwd-from-current-session' };
    }
  }
  // Step 3: observed_cwds 里查不到这个 cwd → 顶层，UI 标「归属未知」
  return { projectId: null, reason: 'unknown' };
}
```

`lookupProjectByCwd` 是纯查表：cwd（或其最长匹配前缀）命中某项目的 `observed_cwds` → 返回该 projectId；查不到 → `null`。**`observed_cwds` 由 LLM 归属决策累积**（§3.5）——即异常归属"搭"了 LLM 归属的便车：LLM 判定过的 cwd→项目关系，异常归属直接查表复用，自己不调 LLM。

**已知局限（公开声明）**：从没被 LLM 归属过的 cwd（如某成员刚开始在一个新目录干活、还没产生 `WorkItem`）→ 异常落 Step 3 进顶层。这是安全的失败方向（宁可不归，不可错归）。

#### 2.4.3 三渠道同逻辑

`attributeAnomalyToProject` 是异常归属的唯一真源函数；`getWorkboardView()`（§4.1）、`leader_push.ts`（§4.4）、CLI `team:workboard`（§4.7）都调它。它纯逻辑（输入 anomaly + roster + `observed_cwds` 索引），三处结果必然一致。

### 2.5 项目详情页（`/status/project/[id]`）

`id` = 登记表稳定 id。

**布局原则（v8 leader cold-read 修订）**：详情页分两大块——**"About"**（项目画像，§3.6，**默认折叠**）和 **"This week"**（当前工作，**默认展开**）。leader 80% 的访问只看 This week；About 是 onboarding / 高层问 / 查术语的低频用途。UI label 用英文（"About" / "This week"），避免"画像/当前工作"翻译腔。

```
┌─ Project hero ──────────────────────────────────────────┐
│  Matrix                                                │
│  3 进行中 · 1 卡住 · 2 本周完成 · 3 个 CC              │
│                              最近活动 12m ago           │
└─────────────────────────────────────────────────────────┘

┌─ ▸ About（默认折叠 · §3.6 项目画像）──────────────────┐
│  展开后:                                                 │
│   Goals · Key people · Vocabulary · Open questions      │
│   每条带 evidence 引用 + last-evidence-date              │
│   >14 天无新 evidence → 视觉淡化 + 标"last evidence …d ago"│
│   >60 天 → 该值自动 archive,不再渲染                     │
└─────────────────────────────────────────────────────────┘

┌─ This week ─ 工作线（卡住优先）────────────────────────┐
│  ⚠ 卡住 · consent gate 设计    （右下）张三 · 2d        │
│  "需要 legal 拍板范围"  ·  归属理由：CC 对话多次提到… │
│  ⏳ 进行中 · matrix-recording 接入  （右下）李四·12m   │
└─────────────────────────────────────────────────────────┘

┌─ 参与成员（仅当 ≥ 2 人）──────────────────────────────┐
│  • 李四   • 王五   • 张三   （字母序，无计数无排名）    │
│  仅 1 人时整块隐藏——单名列表 = 伪装的 person row。     │
└─────────────────────────────────────────────────────────┘

┌─ 关联 PMA 派单（仅非空才渲染）────────────────────────┐
│  task-xxx · "重构 PII redactor 配置加载" → 李四 ✓采纳  │
└─────────────────────────────────────────────────────────┘
```

详情页是**人名唯一出现的地方**（工作线右下小字 + 参与成员）。原则：**首屏 glance 匿名，钻取才落到人**。每条工作线展示 LLM 的 `attribution_evidence`（归属理由）——这正是 §0.5 纪律 2 evidence 的可见化兑现。

**故意不放**：进度条、燃尽、预计完工、任何"谁干得多/少"对比柱或排序、"最快/最慢的人"。

### 2.6 个人详情页（`/status/[name]`）— 改动极小

- 顶部 hero 加 chip：`本周参与项目：Matrix / socialmind`，点击 → 项目详情。
- 工作线区沿用现有 group-by-repo。
- 不再是 leader 主入口，但保留可达。

---

## 3. 项目身份：提取 · 归属 · 解析

三个组件，一条数据流：

```
events.jsonl（CC/会议/Slack/GitHub 四源统一）
        │
        ├──▶ [§3.2 提取 pass]  周期性 LLM 扫全流 → 提议项目实体（name/description/evidence）
        │            │
        │            ▼
        │      [§3.4 身份解析器]  proposal → 稳定 id（确定性快路径 + LLM 语义合并）
        │            │                              ▲
        │            ▼                              │
        │      private/projects.json  ◀─────────────┤  归属里的 "new:" 提议也喂进解析器
        │            │
        ▼            ▼
[§3.3 LLM 归属]  折叠进 work_summary.ts 的现有缓存调用：
   每条 WorkItem 输出 projectId（约束到登记表 id / "new:" / "unclear"）+ attribution_evidence
        │
        ├──▶ projectId confident → 进项目卡（§2.2）
        ├──▶ "unclear" → 未归类工作线区
        └──▶ 副产物：把 (cwd → projectId) 记进项目的 observed_cwds（§3.5 学习索引）
```

### 3.1 登记表 `private/projects.json`

schema 见 §0.3（核心字段）+ §3.4（`resolution_log` / `overrides`）。`.gitignore` 屏蔽；`private.example/projects.example.json` 提供占位骨架。**不是人工维护的**——提取 pass + 解析器自动写。leader 可手动编辑做 override（§3.4），但日常不需要。

**并发写纪律（必做 · v6 冷读反馈）**：`projects.json` 有**四个写入方** —— ① §3.4 解析器（提取 pass 尾部触发）；② §3.5 `work_summary.ts` 的 `observed_cwds` 追加（per-person、per-page-load 路径，可能并发）；③ §3.4 leader override 写入（web 请求触发）；④ §3.1 archival sweep。多进程 read-modify-write 同一 JSON 文件会丢更新。代码库已有现成模式：`events.ts` 的 `withMutex` + `writeSyncState` 的 tmp+rename 原子写。⇒ **新建的 `src/lib/projects.ts` 所有写操作必须走 `withMutex(PROJECTS_MUTEX_KEY)` + tmp 文件 + rename**，与 `events.ts` / `writeSyncState` 同一套。读操作不需要锁。`append-mostly + id 永不改写`（§3.4）保证语义安全，但**不**保证物理并发安全——后者靠 mutex+原子写。

`archived` 项目不进 `/status` 列表，直链 `/status/project/[id]` 仍可访问、标「已归档」。提取 pass 把连续 N 天（默认 30）无任何新归属的项目自动转 `archived`。

### 3.2 提取 pass — AI 从四源自动提取项目

`src/services/project_extraction.ts`。周期性跑（`bun run sync` 尾部触发，或独立 cron）。

- **输入**：events.jsonl 近窗口（默认 30 天）的全部事件——`cc_session` / `meeting` / `slack` / `github` 四源已统一在一个流里（`src/extractors/*` 都写 events.jsonl）。
- **LLM 任务**：识别"团队在推进的项目"。一个项目 = 一组围绕同一目标的活动，可能横跨 CC 会话、会议讨论、Slack 协调、GitHub PR——**不要求有仓库**（运营组织一篇文章也是项目）。
- **约束输出**（§0.5 纪律 1）：每个提议项目 = `{ proposed_name, description, evidence_refs: EvidenceRef[], observed_surface_names: string[] }`。`evidence_refs` 必带（纪律 2）——空 `evidence_refs` 的 proposal **直接丢弃**，`src/services/project_extraction.test.ts` 有测试守护。`observed_surface_names` = 该项目在事件里出现过的表面名/仓库名（喂给解析器做折叠）。
- **EvidenceRef 类型扩展（必做）**：`EvidenceRef.source`（`src/types/index.ts:18`）当前 union 是 `'meeting' | 'task_outcome' | 'self_report' | 'override' | 'org_chart'`——**没有 `'cc_session'` / `'slack'` / `'github'`**。提取 pass 引用 CC/Slack/GitHub 事件时无合法 `source` 值。⇒ 必须把这三个加进 union（§4.1 列为类型改动）。
- **输出**：proposal 列表 → 交给 §3.4 解析器。提取 pass **不直接写 `projects.json`**——所有写操作经解析器，走 §3.1 的并发写纪律，保证稳定 id。
- **成本**：一次 LLM 调用 per 跑（不是 per 项目）。30 天事件窗口，按 §9 的事件压缩喂 context。

### 3.3 LLM 归属 — 折叠进 `work_summary.ts`

**不新增 LLM 调用。** `work_summary.ts` 现状：每人、每数据变更一次带缓存的 LLM 调用，把 7 天事件 → `WorkItem[]`。v6 改动：

- 该调用的 prompt **额外喂入当前 `projects.json` 登记表**（每个项目的 `id / name / aliases / description`）。
- 每条输出 `WorkItem` **额外带两个字段**：
  - `projectId`：**约束输出**（§0.5 纪律 1）——只能是 {登记表已有 id} ∪ `"new:<提议名>"` ∪ `"unclear"`。
  - `attribution_evidence`：一句 ≤200 字符的引用理由（§0.5 纪律 2），说明为什么归这个项目。
- LLM 同时看到 cwd（`buildContext` 已把 live 快照 cwd + session 事件 cwd 喂进去了）**和**对话内容。**这天然解决 cwd-内容冲突**（CC 开在 matrix 文件夹但聊别的事 → LLM 读对话判断，不被 cwd 带偏）。这是本方案放弃确定性加权 matcher 的核心理由。
- `"new:<名>"` 的提议 → 经 §3.4 解析器，可能 resolve 到已有项目（漂移）或 mint 新项目。
- 缓存：沿用 `work_summary.ts` 现有的 data-marker 缓存（`work_summary.ts:250` 的 `marker`，现为 `newest-event-ts | live-session-id`）。登记表变更也要进 marker（否则登记表更新后旧缓存不失效）——marker 末尾追加 `|${projectsJsonHash}`。

**实际强制点是 `parseSummary`，不是 prompt**（v6 冷读反馈——这是 v6 漏写的关键）。`work_summary.ts` 的真实契约不是"prompt 进 / JSON 出"，而是 `parseSummary`（`work_summary.ts:146-177`）这个防御性逐字段构建管线（当前在 `:168` 逐字段 `items.push({ title, repo, status, detail })`）。§0.5 三纪律的代码落点全在这里：
  - `:168` 的对象构建**加两个字段** `projectId` / `attribution_evidence`。
  - **约束输出强制**（纪律 1）：新增校验——`projectId` 不在 `{登记表已有 id} ∪ "new:*"` 集合里 → 强制规整成 `"unclear"`（不许 LLM 自由发挥编 id）。
  - **evidence 强制**（纪律 2）：`attribution_evidence` 为空/缺失 → 该条 `projectId` 强制降级为 `"unclear"`（无理由的归属不算数）。
  - 新增 helper `clampAttributionEvidence`（≤200 字符，截断逻辑仿照现有的 `clampTitle` / `cleanDetail`）。
  - §4.8 的「约束输出」「evidence 必带」测试，断言的就是 `parseSummary` 这一层的规整行为。

**`WorkItem` 类型变更**（`src/services/work_summary.ts`）：
```ts
export interface WorkItem {
  title: string; repo: string; status: WorkItemStatus; detail: string;
  projectId: string;            // v6 新增：登记表 id，或 "new:<名>"，或 "unclear"
  attribution_evidence: string; // v6 新增：归属理由引用（≤200 字符，可空但空则 projectId 降级 unclear）
}
```
⇒ `work_summary.ts` **从 §7.1「不动」清单移除**。这是 v6 有意的、必要的改动。

**LLM 挂时的 stale 缓存 + 登记表已变**：`fallback()`（`work_summary.ts:257`）服务上次缓存的 `WorkItem`，其 `projectId` 可能指向解析器已改名/合并/归档的 id。处理：`getWorkboardView`（§4.2 step 3）分桶时，**`projectId` 不在当前登记表里 → 当 `"unclear"` 处理**（进未归类区），不报错。`degraded='llm-stale'` 同时提示。

### 3.4 身份解析器 `src/services/project_resolver.ts`

**职责**：把 proposal（来自 §3.2 提取 pass，或 §3.3 归属的 `"new:"` 输出）resolve 成稳定 id。**无 leader 确认 gate。**

```
对每个 proposal（带 proposed_name + 可能的 observed_surface_names + evidence）：
  ── 确定性快路径（无 LLM，零风险）──
  1. proposed_name 或任一 surface_name 精确等于某项目的 id / name / alias
       → resolve 到该 id；把没见过的 surface_name 加进该项目 aliases
  2. surface_name 与某项目已有 alias 构成明确前缀关系
       （"matrix-recording" 之于 "matrix"，规则：A 是 B 加连字符/斜杠后缀）
       → resolve 到该 id；加 alias
  ── LLM 语义合并（仅当快路径未命中）──
  3. 把 proposal（name + description + evidence）和现有项目清单（id + name + description）
     一起给 LLM，问："这个 proposal 是不是某个现有项目？是哪个？还是真新项目？"
     约束输出：{已有 id} ∪ "genuinely-new"。必带一句理由。
       → 返回已有 id：resolve（"teambrain" → "matrix" 这类靠这步）
       → "genuinely-new"：mint 新稳定 id（slug 化 proposed_name + 去重后缀）
  ── 写入（append-mostly）──
  - resolve 到已有：只 enrich（加 alias / 加 evidence_ref / 合并 observed_cwds），
    **id 和 name 永不被改写**（name 首次 mint 时设定，之后 sticky）
  - genuinely-new：append 新项目
```

**为什么混合（确定性快路径 + LLM 语义合并）**：
- `matrix` + `matrix-recording` 这种纯前缀，确定性就够，省 LLM 调用、零误判风险。
- `teambrain` → `matrix` 这种语义关联，字符串无能为力，必须 LLM——而语义相似判断正是 LLM 强项。
- 与 §0.2 第 6 点「信 LLM」一致：能确定性解决的不浪费 LLM，需要语义的才上 LLM。

**残留风险（公开声明）**：LLM 语义合并可能误并（把两个独立项目并成一个）或漏并。无 gate ⇒ 错误静默留存。软化：
- 解析器每次合并/mint **连 evidence + 理由记进 `projects.json` 的一个 `resolution_log`**。
- **leader override 面**（非 gate）：`/status/project/[id]` 详情页给「这不是一个项目 / 拆分」「合并到另一个项目」按钮 → 写一条 override 进 `projects.json` 的 `overrides` 段；解析器后续跑**永远尊重 override，不再自动改动被 override 的项目**。
- override 是"事后纠正"，不是"事前关卡"——系统自动跑，leader 想纠才纠（与 §0.2 第 5 点一致）。

**稳定性保证**：`id_stability` 是 §0.6 的硬门槛——连续两次跑，已有项目 id 必须 100% 不变。解析器的"append-mostly + id 永不改写"设计就是为这个。

### 3.5 `observed_cwds` 学习索引

每次 §3.3 LLM 归属给出一个 confident `projectId`，且该 WorkItem 的来源 session 有 cwd → 把 `(cwd → projectId)` 记进该项目的 `observed_cwds`（去重）。

- 这是**归属决策的纯记录副产物**，不做任何推断（§0.5 里它是"真"）。
- 用途：§2.4.2 异常归属的 `lookupProjectByCwd` 廉价查表——异常不调 LLM，搭 LLM 归属的便车。
- `lookupProjectByCwd(cwd)`：cwd 精确命中某项目 `observed_cwds` → 该 id；否则取 cwd 的最长前缀匹配；都不中 → `null`。
- 一个 cwd 同时出现在多个项目的 `observed_cwds`（cwd-内容冲突的历史残留）→ 取最近 `last_attributed_at` 的项目；仍歧义 → `null`（异常进顶层，安全）。

### 3.6 项目画像（S8）— `profile` 子对象

> S2 不做。这是后续 enrich 层，让系统**真正理解每个项目**——goals、关键人、术语、未答问题——而不仅仅是分类燃料。沿用代码库现成的 personal agent 模式（bootstrap 提取 + evolve diff）应用到项目。

**为什么需要**：v7 仅有 `description`（一段话）。leader cold-read 反馈：项目画像让 onboarding 新人、回答高层问、查项目特有术语都有 ground truth；同时把更厚的 context 喂给 §3.3 LLM 归属,分类更准（无 cwd 的运营项目尤其受益）。

**与「当前工作」的区别（明确,避免重复存储）**：

| | 画像 (`profile`) | 当前工作（`WorkItem[]`，§3.3）|
|---|---|---|
| 时间轴 | 累积、周/月级 | 7 天滚动 |
| 回答 | "这是什么项目" | "现在在干什么" |
| 来源 | bootstrap 风格全时段 LLM 提取 + evolve | `work_summary.ts` 现有缓存调用 |
| 存哪 | `projects.json` 的 `profile` 子对象 | `cc_summary_cache.json` |
| UI | "About"（默认折叠） | "This week"（默认展开） |

#### 3.6.1 字段（leader cold-read 砍到 4 个）

```ts
interface ProfileFact {
  value: string;
  evidence: EvidenceRef[];           // 必带（§0.5 纪律 2）
  last_evidence_ts: string;          // ISO；UI > 14d 淡化；> 60d 自动 archive
  archived?: boolean;                // > 60d staleness 触发后置 true（§3.6.2）
  superseded_by?: string;            // 新 evidence 显式否定旧值时，指向新 ProfileFact 的 value（goals）/ term（vocabulary）/ name（key_people）（§3.6.3）
}
interface ProjectProfile {
  vocabulary: Array<ProfileFact & { term: string; definition: string }>;
  goals: ProfileFact[];
  key_people: Array<ProfileFact & { name: string; role?: string }>;
  open_questions: ProfileFact[];
}
```

leader cold-read 明确**砍**的字段：
- ❌ `recent_decisions` —— "我们再想想"会被 LLM 标成已决，leader 会基于这字段做决策然后翻车。**S8 v1 不含**。等有"暂定 vs 终局"标记机制再加。
- ❌ `cadence_notes` —— 装饰物，没用。
- ❌ `active_threads` —— 跟"当前工作"重复，纯冗余。

四个保留字段的信任度（leader 视角）：
- `vocabulary` —— **最信**（术语跨渠道重复，客观，易抽）
- `key_people` —— 对 IC 可信，对 leader 自己经常误标"key"（出现在每个 thread ≠ key role）
- `goals` —— **最危险**，一句随口"我觉得目标是 X"会被 LLM 永久固化；强制每条 goal 必带 ≥2 个独立 evidence 源才能 mint
- `open_questions` —— 低风险，可错可改

#### 3.6.2 Staleness 信号（非可选 · leader cold-read 硬要求）

leader 原话："wikis die。每个团队的项目文档都烂掉。" ⇒ 必须有视觉信号让 leader 一眼看出"这条数据多久没刷过了"，否则信任崩塌、画像变成废纸。

每个 `ProfileFact.last_evidence_ts` 驱动三档 UI 状态:
- **fresh** (`now - last_evidence_ts ≤ 7d`)：正常显示
- **aging** (`7-14d`)：轻微 dim
- **stale** (`14-60d`)：明显 dim + 行尾标 "last evidence Nd ago"
- **archived** (`> 60d`)：从画像移除（仍存 `projects.json`，标 `archived: true`，列表/详情不渲染；leader 可在 override 面恢复）

staleness 不靠 cron job 跑 —— 渲染时实时算 `now - last_evidence_ts`，零后台开销。

#### 3.6.3 Pipeline — `src/services/project_profile.ts`

沿用代码库现成的 bootstrap + evolve 模式（`src/bootstrap/` 提取人物画像、`src/evolution/diff.ts` evolve 增量补丁）：

- **首跑（per-project bootstrap）**：项目首次被 §3.4 解析器 mint 后，触发一次 profile bootstrap pass —— LLM 扫该项目近 90 天的 events.jsonl，提取 4 个字段的初始值。
- **evolve（增量）**：跟提取 pass 同周期（§3.2 一次 LLM 调用 per 跑）—— LLM 看近窗口的新 evidence，输出 JSON Patch（add / replace / remove），不全量重写。
- **不删除 silence**：evolve 不主动删旧值；旧值靠 staleness 信号自然淡化、`> 60d` 后归档。LLM 看到的 evidence 显式否定某旧值（如 "项目目标改为 X"）→ 给旧值打 `superseded_by` 指针，旧值标 `archived`，新值入。
- **goals 双 evidence 门**：mint 一条 goal 时强制要求 ≥2 个 **独立** evidence。**「独立」精确定义**：两条 evidence 的 `EvidenceRef.source_id` 不同（不同文件/会议/PR），**或**同一 `source_id` 但 `extracted_at` 间隔 ≥ 7 天（同一文档跨周复述）。同一 `source_id` 同一抽取批次内的两条引用不算独立——防止单一会议被切两段冒充双源。单条 evidence 不足以入 goals 字段。
- **EvidenceRef 必带**（§0.5 纪律 2）：每条 ProfileFact 创建时必带 ≥1 个 EvidenceRef；缺失则 LLM 输出该 fact 时被 parseSummary 风格的强制点丢弃。

#### 3.6.4 与 §3.3 LLM 归属的双向喂

```
events.jsonl
    │
    ├──[§3.6 profile bootstrap + evolve · 低频 · 全时段]──▶ profile（耐久知识）
    │                                                          │
    │                                                          ▼ 喂归属 LLM 的 prompt
    └──[§3.3 work_summary · 高频 · 7 天]─────────────────▶ WorkItem[]（当前工作）
                                                               │
                                                               ▼ 工作中的事件
                                                                 沉淀回 events.jsonl
                                                                 → 下轮 evolve 的 evidence
```

§3.3 LLM 归属的 prompt 改进：每个登记项目除 `id/name/aliases/description` 外，额外喂 `profile` 的浓缩摘要（每字段最多 3 条 fresh 值）—— 这让 LLM 归属判断时看到的项目"侧写"更厚，归属精度提升。

#### 3.6.5 与 §5 反监控原则的一致性

`key_people` 字段在详情页"About"区会显示成员名 + role —— 这是 leader 找人谈/onboarding 需要的信息，**已经在详情页层级，不在首屏 glance**（§5 原则：首屏匿名，钻取落人）。`key_people` 与现有详情页的「参与成员」section 互补：参与成员 = 本周谁碰过（短期），key_people = 项目长期主推（长期）。仅 1 人时同样隐藏（沿用 §2.5 规则）。

---

## 4. 数据 / 后端改动

### 4.1 新文件 + 改动文件清单

| 文件 | 动作 | 说明 |
|---|---|---|
| `src/services/project_extraction.ts` | 新建 | §3.2 提取 pass |
| `src/services/project_resolver.ts` | 新建 | §3.4 身份解析器 |
| `src/services/workboard.ts` | 新建 | §4.2 聚合 |
| `src/services/work_summary.ts` | **改** | §3.3：prompt 吃登记表，输出加 `projectId` + `attribution_evidence`；缓存 marker 加 `projects.json` hash |
| `src/lib/events.ts` | 改 | §4.3：加 `getEventBySeq` seq 索引 |
| `src/lib/projects.ts` | 新建 | `projects.json` 读写 + `lookupProjectByCwd`（§3.5）。**写操作必须走 `withMutex` + tmp+rename 原子写**（§3.1 并发写纪律）|
| `src/types/index.ts` | 改 | `EvidenceRef.source` union 加 `'cc_session' \| 'slack' \| 'github'`（§3.2）|
| `src/services/project_profile.ts` | 新建（S8） | §3.6 项目画像 bootstrap + evolve；输出 JSON Patch 经 `src/lib/projects.ts` 的 `withMutex` + 原子写入 `projects.json`（§3.1 并发写纪律。**不**走 §3.4 解析器——解析器只管 proposal→id 解析，不处理 profile 补丁）|
| `src/app/api/workboard/route.ts` | 新建 | 列表 API |
| `src/app/api/workboard/project/[id]/route.ts` | 新建 | 详情 API |
| `src/app/status/page.tsx` | 改 | §2.2 项目卡渲染 |
| `src/components/ProjectCard.tsx` / `ThreadCard.tsx` | 新建 | |
| `src/app/status/project/[id]/page.tsx` | 新建 | §2.5 详情页 |
| `src/services/leader_push.ts` | 改 | §4.4 Slack 主语项目化 |
| `src/components/Sidebar.tsx` | 改 | §4.5 `/tasks` label → Dispatch |
| `src/scripts/sync.ts` | 改 | 尾部触发 §3.2 提取 pass |

### 4.2 `src/services/workboard.ts` — 聚合

```ts
export interface ProjectCardSummary {        // 列表 payload —— 类型上无任何人名字段
  id: string; name: string;
  workItems: WorkItem[];                     // 纯 WorkItem（含 projectId/evidence，无 ownerName）
  ccCount: number;                           // 去重 owner 数（service 内部用 owner 算，只输出 count）
  lastActivityAt: string | null;
  status: '卡住' | '活跃' | '收尾' | '休眠';
  attributedAnomalies: Anomaly[];
  hasRelatedTasks: boolean;
}
export interface ProjectCardDetail extends Omit<ProjectCardSummary, 'workItems' | 'hasRelatedTasks'> {
  workItems: Array<WorkItem & { ownerName: string }>;   // 详情页才带 ownerName
  contributors: string[];                               // 字母序
  relatedTaskIds: string[];
  profile?: ProjectProfile;                             // §3.6 S8。S2 时缺失/空对象；S8 上线后逐步充满。
                                                        //   仅 Detail 携带 —— Summary（列表）类型上没有 profile 字段，
                                                        //   即使 profile.key_people 含人名也不会泄漏到首屏 glance。
}
export interface UnclusteredThread {
  workItem: WorkItem;                        // 纯 WorkItem，无 ownerName
}
export interface WorkboardView {
  projects: ProjectCardSummary[];
  unclustered: UnclusteredThread[];
  topAnomalies: Anomaly[];
  anomalyToProject: Record<string, string>;
  aggregate: { totalProjects: number; stuck: number; active: number };
  degraded?: { reason: 'empty-registry' | 'collector-down' | 'llm-stale' };
}
export async function getWorkboardView(): Promise<WorkboardView>;
export async function getProjectDetail(id: string): Promise<ProjectCardDetail | null>;
```

**匿名性靠类型分层强制**（不靠组件渲染纪律）：`ProjectCardSummary` / `UnclusteredThread` 类型上就没有 `ownerName` / `contributors`。人名只能从 `getProjectDetail`（`ProjectCardDetail`）拿到。§4.8 有测试断言列表 payload 序列化后不含任何 roster 成员名。

逻辑（`getWorkboardView`）：
1. `getRosterView()`（`cc_status.ts`）取 roster + anomalies + 每人 `WorkItem[]`（现在每条带 `projectId`）。
2. 加载 `projects.json`（缺失/损坏 → `degraded='empty-registry'`，所有 WorkItem 当 `unclear` 处理）。
3. 按 `WorkItem.projectId` 分桶：confident id → 项目卡；`"unclear"` 或 `"new:*"`（还没被解析器落地的）→ unclustered。聚类时 service 内部知道每条 WorkItem 的 owner（算 `ccCount` 去重用），**只输出 count，丢弃 owner 名**。
4. 每条 anomaly 调 `attributeAnomalyToProject`（§2.4.2）→ 填 `anomalyToProject` + 每项目 `attributedAnomalies` + `topAnomalies`。
5. 每项目算 `status`（§2.3）、`ccCount`、`lastActivityAt`。
6. `hasRelatedTasks`：扫 `private/tasks/*.json`，严苛匹配（Task `description` 命中项目 `name`/`aliases`）；列表页只输出 bool。

`getProjectDetail(id)`：保留 `ownerName`，算 `contributors`（字母序去重）、`relatedTaskIds`（同上规则，空则前端 hide section）、每条工作线的 `attribution_evidence` 展示。

### 4.3 `getEventBySeq` — `src/lib/events.ts` 加 seq 索引

`events.ts` 当前只有全量扫描读取（代码注释自标 "should add an indexed reader" TODO）。新增进程内 `Map<seq, byteOffset>`，**懒构建**。**失效机制**：查询 seq 不在 map（cache-miss）→ 重建一次索引再查；重建后仍无 → 返回 `null`（该 seq 真不存在，不会无限重建）。不做 append 时增量更新（`appendEvents` 与 `getEventBySeq` 间无总线，强 wire 引入耦合）；cache-miss 重建足够——异常归属查的是已落盘旧事件，正常几乎不 miss。

### 4.4 Slack push 项目化 — `src/services/leader_push.ts`

`formatMessage` **保持同步纯函数**；异步归属判定上提到 `notifyActNowIfNew`（`leader_push.ts:63`，已 async 已做 I/O）：

```ts
// notifyActNowIfNew：
const roster = await loadRosterForAttribution();
const { projectId } = await attributeAnomalyToProject(anomaly, roster);  // §2.4.2，廉价查表
const projectName = projectId ? projectNameOf(projectId) : null;          // 读 projects.json
const body = formatMessage(anomaly, { projectName });

// formatMessage（保持 sync）：
function formatMessage(a: Anomaly, ctx: { projectName: string | null }): string {
  if (ctx.projectName) {
    lines.push(`⚠️ *${ctx.projectName}* 项目 · ${a.rule}`);
    lines.push(`触发于 ${subject} 的最近一次 session`);
  } else {
    lines.push(`⚠️ *${a.rule}* — ${subject}`);   // 顶层/未知 → 旧格式
  }
}
```

feature flag `WORKBOARD_PUSH_PROJECTS=1` 控开关——关闭时跳过归属、直接旧格式；attribution bug 时 flag 瞬时回滚。

### 4.5 Sidebar 命名

`Sidebar.tsx:50` 当前把 `/tasks` 标 "Projects"，与新 workboard 撞名。**决策**：`/tasks` label 改 **"Dispatch"**，icon `FolderKanban → Send`。`/status` 路径不动、H1 改 "Workboard"。**过渡**：S3 落地时 sidebar 显 `Dispatch (formerly Projects)` 一周 + `/tasks` 顶部一次性 dismissible toast；一周后 cleanup PR 移除。回退方案（leader 反对）：保留 "Projects" 指 `/tasks`，workboard H1 用 "工作板（按项目）"——绝不并存两个 "Projects"。

### 4.6 Search modal 加 project 索引

`Sidebar.tsx` cmd-K 索引当前读 `/api/agents + /api/tasks + /api/meetings`。加 `/api/workboard` 取 projects，新增 `SearchHit type: 'project'`，href → `/status/project/[id]`。S5 同 PR 落。

### 4.7 CLI `team:workboard`

新增子命令，markdown 版项目卡列表。**不删 `team:status`**。异常归属与 web 共用 `attributeAnomalyToProject`。

### 4.8 测试

`src/services/project_extraction.test.ts`：
- **evidence 必带（纪律 2）**：mock LLM 返回一个 `evidence_refs` 为空的 proposal → 断言被丢弃，不进解析器。
- **EvidenceRef source 合法性**：断言提取产出的 `evidence_refs[].source` ∈ 扩展后的 union（含 `cc_session/slack/github`）。

`src/services/project_resolver.test.ts`：
- **确定性快路径**：精确 name/alias 命中 → resolve 到老 id，不调 LLM。
- **前缀折叠**：`matrix-recording` proposal + 已有 `matrix` → resolve 到 matrix，加 alias。
- **LLM 语义合并（mock LLM）**：`teambrain` proposal + mock LLM 返回 "matrix" → resolve 到 matrix。
- **genuinely-new**：mock LLM 返回 "genuinely-new" → mint 新 id。
- **id 稳定性**：同一组 proposal 跑两次 → 已有项目 id 100% 不变。
- **override 尊重**：被 leader override 标记的项目 → 解析器后续跑不再自动改动它。
- **并发写**：两个并发写（mock 解析器写 + mock observed_cwds 追加）→ 断言无丢更新（mutex + 原子写生效）。

`src/services/work_summary.test.ts`（扩展）：
- **约束输出**：mock LLM 返回不在登记表里的 id → 断言被规整成 `"unclear"`（不许自由发挥）。
- **evidence 必带**：mock LLM 返回 `projectId` 但无 `attribution_evidence` → 断言该 WorkItem 降级为 `"unclear"`（纪律 2 强制）。
- **登记表变更使缓存失效**：`projects.json` hash 变 → 断言重新调 LLM。

`src/services/workboard.test.ts`：
- **列表 payload 匿名性（强不变量）**：含已知 roster 成员名的 fixture 跑 `getWorkboardView()`，整体序列化成字符串，断言不含任何 roster 成员名（覆盖 `ProjectCardSummary` + `UnclusteredThread`）。
- **S8 列表 payload 不带 profile**（S8 落地后启用）：fixture 里某项目 `profile.key_people` 含人名 → `getWorkboardView()` 列表返回里**不能出现** `profile` 字段任何子段或其中的人名；只有 `getProjectDetail(id)` 才暴露 profile。把类型分层匿名延伸到 profile 层。
- **空登记表**：`projects.json` 缺失 → 所有 WorkItem 进 unclustered，`degraded='empty-registry'`，不抛错。
- **projectStatus 防抖**：单条卡住不翻红；两条翻红；一条 + 一 anomaly 翻红。
- **单贡献者隐藏**：`contributors.length === 1` → 详情页参与成员 section 不渲染。
- **空 relatedTaskIds** → 不渲染空 section。

`src/services/anomaly_attribution.test.ts`：
- **白名单**：每条 RULE_LABEL 断言归项目 or 顶层。
- **退路链**：(a) seqs 非空 + event.cwd 命中 observed_cwds → cwd-from-event；(b) seqs 空 → cwd-from-current-session；(c) cwd 不在任何 observed_cwds → unknown 进顶层。
- **observed_cwds 歧义**：一个 cwd 在两个项目 observed_cwds 里 → 取最近 last_attributed_at；仍歧义 → null。

---

## 5. 隐私 / 反监控设计（核心）

| 反监控原则 | 落地 |
|----------|------|
| 主轴翻成项目 | §2.2 首屏项目卡，无 24 行人 |
| CC 首屏匿名 | 工作线只 `状态·标题`；卡底 `N 个 CC`；人名只在详情页 |
| 砍记分牌排序 | 项目卡按"卡住→活跃→收尾→休眠 + lastActivityAt"，**不按人活跃度** |
| 砍活跃灯审判 | 不显个人 active/idle/dormant 灯于列表 |
| 砍"谁干得多/少" | 详情页参与成员字母序、无计数；仅 1 人时整块隐藏 |
| 砍"最久没动的人" | 移除该 stat；项目层只有"最久没动的项目" |
| 异常主语挪到项目 | §2.4 白名单 + Slack push 同源（§4.4）|
| 不引入"该谁接手"判断 | workboard 只读；派单留给 PMA |
| 未归类不羞辱 | "未归类工作线"区视觉权重等同项目卡 |
| 配额不进项目主语 | `quota.*` 永远顶层异常 |

**仍剩的监控向量 + 回退触发**：详情页 + 个人详情页仍能看到"谁做了什么"——这是 leader 找人谈的必要能力，是钻取动作不是默认暴露。若 leader 主动反馈监控感 OR 任一成员 retro 提出 OR 详情页"按成员过滤"使用率审计 > 30%，跑一步更克制变体（详情页工作线默认收起 owner，hover 才出）。

---

## 6. 边界情况

| 情况 | 处理 |
|-----|------|
| `D:\hrdai` 单 repo 装多项目 | LLM 归属读对话内容判断，不靠 cwd 末段；提取 pass 从会议/Slack/CC 语义识别 |
| CC 开在 matrix 文件夹但聊别的项目 | **LLM 归属同时看 cwd + 对话内容，按内容判**（§3.3）。这是放弃确定性 matcher 的核心理由 |
| `matrix` / `matrix-recording` / `teambrain` 是一个项目 | §3.4 解析器：前两个走确定性前缀折叠；`teambrain` 走 LLM 语义合并 |
| 一个 CC 跨多个项目并行 | 该人多条 WorkItem 各自被 LLM 归属，散到多张项目卡 |
| LLM 判 `unclear` | 进未归类区，平铺 |
| LLM 提议 `"new:X"` 但解析器还没跑 | 该 WorkItem 暂进未归类区；下次提取/解析 pass 后落地成项目卡 |
| 登记表为空 | 全部进未归类区，`degraded='empty-registry'`，软聚类列表模式 |
| 产品/运营项目无 cwd | **不再是问题**——LLM 归属不依赖 cwd，读会议/Slack/CC 对话内容即可归（运营组织文章 → 提取 pass 从会议/Slack 识别成项目，归属 pass 把相关 WorkItem 归过去）|
| LLM 误并两个独立项目 | §3.4 残留风险；leader override 面事后纠正（拆分按钮）|
| LLM 归属漂移（重跑结果变） | 缓存（work_summary data-marker）+ §3.4 解析器把 `"new:"` 漂移 resolve 回老 id |
| collector（Matrix-Riven :8933）挂 | `getRosterView` 优雅降级；workboard 用 events-derived 视图，`degraded='collector-down'` |
| LLM 挂（work_summary / 提取 pass） | `work_summary` 现有逻辑：服务上次缓存（标 stale）。归属字段也来自缓存。提取 pass 失败 → 登记表不更新，用上次的。`degraded='llm-stale'` |
| 异常的 cwd 从没被 LLM 归属过 | §2.4.2 Step 3 → 顶层「归属未知」（安全失败方向）|
| 项目 30 天无新归属 | §3.1 提取 pass 自动转 `archived` |
| anomaly subject 是 task/commit | §2.4 白名单，多数归顶层 |
| 一个项目只有一个 CC | 仍是项目卡，不退化成 person 卡 |

---

## 7. 一条线路 build pipeline

> **开发模式**：直接用 Claude Code 一气呵成。**没有日历**——下面 S1→S9 是**逻辑顺序**(`S_i` 依赖 `S_{i-1}` 的产出)，不是周排期。中间的"门"是**正确性 gate**(测试不绿/审计不达标就停下修),不是"等几天 leader 反馈"。一个实现 agent 从 S1 一路推到 S9 即可。

| # | 步骤 | 文件 | 行数估 | 依赖 + 出口 gate |
|---|------|------|------|---------|
| **S1** | 提取 + 解析器 + 门 A 审计 | `project_extraction.ts` (~180)、`project_extraction.test.ts` (~90)、`project_resolver.ts` (~220)、`lib/projects.ts` (~140 含 mutex+原子写)、`project_resolver.test.ts` (~280)、`src/types/index.ts` EvidenceRef union 改 (~5)、`tools/audit-resolver.ts` (~90) | ~1005 | **依赖**：无 / **出口**：`id_stability == 100%` ∧ `extraction_evidence_coverage == 100%`(§0.6 门 A) |
| **S2** | LLM 归属 + 聚合 + 门 B 审计 | `work_summary.ts` 改 (~140 delta,`parseSummary` 强制点 + `clampAttributionEvidence`)、`work_summary.test.ts` 扩 (~150)、`workboard.ts` (~260)、`workboard.test.ts` (~220)、`anomaly_attribution.ts` + test (~180)、`lib/events.ts` getEventBySeq (~80)、`/api/workboard` + `/api/workboard/project/[id]` (~90)、`tools/audit-attribution.ts` (~90) | ~1310 | **依赖**：S1 登记表 / **出口**：`attributed_rate ≥ 70%` ∧ `attribution_evidence_coverage == 100%`(§0.6 门 B) |
| **S3** | 列表页 + 详情 stub + Sidebar | `status/page.tsx` rewrite (~270 delta)、`ProjectCard.tsx` (~150)、`ThreadCard.tsx` (~70)、`status/project/[id]/page.tsx` stub (~110)、`Sidebar.tsx` (~35) | ~635 | **依赖**：S2 `/api/workboard` / **出口**：localhost:3000/status 渲染、无 console error、§4.8 列表 payload 匿名性测试绿 |
| **S4** | Slack push 项目主语 + flag | `leader_push.ts` (~80)、`notifyActNowIfNew` (~30)、env `WORKBOARD_PUSH_PROJECTS=1` | ~110 | **依赖**：S2 `attributeAnomalyToProject` / **出口**：flag 关闭走旧格式、打开走项目主语,两套都跑测试 |
| **S5** | 详情页完整版 + search + override 面 | `status/project/[id]/page.tsx` 完整 (~300)、search modal project kind (~40)、§3.4 leader override 按钮 + `projects.json` overrides 段 (~90) | ~430 | **依赖**：S3 详情页 stub / **出口**：拆分/合并 override 按钮写 `projects.json`,解析器后续跑尊重 override |
| **S6** | person detail 项目 chips | `status/[name]/page.tsx` (~30) | ~30 | **依赖**：S2 `/api/workboard` / **出口**：person detail 顶部显本周参与项目 |
| **S7** | CLI workboard | `src/scripts/team.ts` (~80) | ~80 | **依赖**：S2 / **出口**：`team:workboard` 输出 markdown 项目卡 + 与 web 异常归属一致 |
| **S8** | 项目画像 | `project_profile.ts` (~280 bootstrap + evolve)、`project_profile.test.ts` (~180)、`projects.json` schema 加 `profile` 子对象、详情页 "About" 区 (~150) | ~610 | **依赖**：S5 详情页完整版 / **出口**：About 区渲染 4 字段、staleness 视觉淡化生效、§4.8 列表 payload 不带 profile 测试绿 |
| **S9** | (条件性) §9 数据增强 | extractor 改动(A 类) / collector 协调(B 类) | 见 §9 | **依赖**：触发条件——门 A 或门 B 不达标,或 leader 想要 |

**说明**：
- **正确性 gate,不是日历 gate**。门 A/B 不达标 → 在当步停下修,不进下一步。CC dev 模式天然适合"测试不绿就回去改",不需要 wall-clock 等待。
- **S4(Slack)单独一步 + flag**:不是为了延后,是为了 attribution bug 时能瞬时回滚 Slack 主语而不撤代码。S3 落了立刻接 S4 也可以,flag 控开关即可。
- **S5 override 面与 S1-S4 解耦**:S1-S4 期间解析器全自动跑,无 override 面也能用(§0.2 第 5 点"override 非 gate")。S5 是事后纠错入口的可视化。
- **S8(项目画像)的依赖**:bootstrap pass 跑全时段 events,首跑成本高;evolve 走增量。理论上 S2 完成后就能接,但放在 S5 之后是因为 About 区需要详情页完整版承载。**不是日历等待**。
- **`/api/cc-status`、CLI `team:status`、person detail 主体全程保留**,任何步骤不破坏旧消费方。
- **每一步收尾 = 该步出口 gate 全绿**,然后进下一步。无 "ship 一波等反馈" 节奏。

### 7.1 不动的东西

`/api/cc-status`、`getRosterView` / `getOneStatus`、`Anomaly` schema、PMA / bootstrap / evolve / sim、person detail 主体（只加 chips）、`/status` 路径、sidebar 路由（只改 `/tasks` label）。

**注意**：`work_summary.ts` 和 `WorkItem` 类型**不在此清单**——v6 有意改它们（§3.3）。`src/extractors/*` 也可能改（§9 A 类，条件性）。

---

## 8. 风险

1. **LLM 归属非确定性** — 重跑结果可能变。缓解：① work_summary 现有 data-marker 缓存（同输入不重跑）；② §3.4 解析器把 `"new:"` 漂移 resolve 回老 id；③ §0.6 `id_stability` 硬门槛。
2. **LLM 归属/提取的 cost** — **≈ 0**：归属折叠进 `work_summary.ts` 现有缓存调用，不新增；提取 pass 是一次调用 per 跑（非 per 项目），跟 `bun run sync` 走。
3. **LLM 幻觉（编项目 / 错归）** — §0.5 三纪律：约束输出（只能选登记表 id / new / unclear）+ evidence 必带 + 解析器兜底。§4.8 有「约束输出」「evidence 必带」测试。
4. **解析器误并/漏并** — §3.4 残留风险，公开声明。软化：resolution_log 留痕 + leader override 面（事后纠正，非 gate）。`id_stability` / `new_proposal_churn` 进 §0.6 审计。
5. **无 leader gate 的信任问题** — 若 leader 不放心"系统自动建项目"，override 面让他随时能纠；且 `degraded` / `attributed_rate` 透明可查。这是 leader 明确要的方向（去 gate）。
6. **anomaly 当前几乎无 production rule** — §2.4.1 公开声明项目卡 ⚠ 初期主要来自 `WorkItem.status`。
7. **`observed_cwds` 冷启动** — 新 cwd 没被 LLM 归属过 → 异常归属查不到 → 进顶层（§2.4.2 Step 3，安全方向）。随 LLM 归属积累，覆盖率自然上升。
8. **`work_summary.ts` 改动的回归风险** — 它现在是 leader 工作状态的核心，且 v6 让它新增了一条写路径（§3.5 写 `observed_cwds` 进 `projects.json`）——从纯 read+cache 服务变成登记表的写入方之一。缓解：① 归属改动是"加字段"非"改逻辑"，强制点集中在 `parseSummary`（§3.3），旧 `WorkItem` 消费方（`/status` 旧 roster、CLI）不读新字段照常工作；② `observed_cwds` 写走 §3.1 的 `withMutex` + 原子写；③ §4.8 扩测试守护。
9. **`projects.json` 四写入方并发** — 解析器 / `work_summary` 的 observed_cwds 追加 / leader override / archival sweep 四路并发 read-modify-write。缓解：§3.1 强制 `src/lib/projects.ts` 所有写走 `withMutex` + tmp+rename（复用 `events.ts` 现成模式）；§4.8 有并发写测试。`append-mostly` 只保证语义安全，物理并发安全靠 mutex。
10. **leader 真正诉求是 PMO 工具** — 本方案诚实克制（无 deadline/进度）。发布附话术。
11. **`getEventBySeq` 首次/miss 全扫成本** — §4.3 懒构建 + rebuild-on-miss，24 人团队 events.jsonl 规模可接受。
12. **登记表变更不使 work_summary 缓存失效** — §3.3 已把 `projects.json` hash 加进缓存 marker；§4.8 有测试守护。
13. **画像 `goals` 字段被随口一句固化（S8）** — leader cold-read 明确担心。缓解：§3.6.3 强制双 evidence 门（≥2 独立源才 mint）+ §3.6.2 staleness 信号让旧 goal 视觉淡化。仍是公开风险——首 1-2 个月观察实际错率，错率高就把 goals 单独砍掉只保留 vocabulary/key_people/open_questions。
14. **画像 wiki-rot 死循环（S8）** — leader cold-read 最大担心："每个团队的项目文档都烂掉"。缓解：§3.6.2 staleness 信号是**非可选硬要求**——每个字段值显示 `last-evidence-date`，> 14d 视觉淡化、> 60d 自动 archive。leader 一眼看出"哪条信息多久没刷过了"，避免被陈年错误数据骗。
15. **画像 S8 bootstrap 首跑成本** — 项目首次 mint 后跑一次全时段（90d）events.jsonl 提取，token 成本是 evolve 的 N 倍。缓解：bootstrap 只对**新 mint** 项目跑一次；存量项目用 evolve 增量；总 cost 一次性，可控。

---

## 9. CC 数据增强请求（给 Matrix-Riven :8933 collector 维护者）

> 方案**不依赖**这些也能跑(零数据增强下走软聚类模式)。接入后 LLM 归属 / 提取的 context 更丰富、判断更准。详见 `docs/collector-data-asks.md`。
> v6 起这些数据的角色:不是"加权 matcher 的信号",是"喂给 LLM 归属 / 提取调用的 context"。
> **架构边界**(§0.7):Matrix-Riven 不需要知道"项目",只要把更全的环境快照传过来。语义全在 team app。

**已落地(v10 新增确认)**:
- ✅ **首条 user prompt**(`raw_prompt`): 已在 `CcStatusSnapshot.raw_prompt`(`@matrix-riven/shared/cc-status/types.ts`)由 `bin-user-prompt-submit.cjs` hook 抓取,默认 `undefined`、隐私门 `RIVEN_REALTIME_RAW_PROMPT=1` 才发。⇒ **只需开 env**,team app 立刻可读。

**A 类**(数据已在上传的 jsonl 里,只需扩 team 的 `cc_session.ts` extractor,**Matrix-Riven 零改动**):
- A-1 TodoWrite/Task 工具 input — CC 自己的任务脚手架,强归属 context + work_summary 交叉校验
- ✅ **A-2 已落地**(首条 user prompt → 见上方"已落地"块,只需开 env)
- A-3 end-of-turn recap (`system` 帧 `subtype:'stop_hook_summary'`,**payload 结构待维护者确认**(Q-1))
- A-4 worktree-state / permission-mode 控制帧
- A-5 Edit/Write 的 `file_path`
- A-6 PostToolUse 退出码(**前提:collector hook 配置启用了 PostToolUse,待确认**(Q-2))

**B 类**(CC jsonl 不带,需 Matrix-Riven hook + schema 微改):
- B-1 ⭐ SessionStart hook 加 `git remote get-url origin` + `git rev-parse --show-toplevel`,把结果加进 `CcStatusSnapshot` 两个可选字段 `git_remote_url?` / `repo_root?`(命名建议)。Matrix-Riven 自身不需要解读这两个字段,只是透传——**纯数据源职责内,与 §0.7 一致**。team app 拿来当 LLM 归属的强 context(辅证,非决定信号)。**附加价值**:Matrix-Riven 自己的 Overview Projects panel 也可以从 `basename(cwd)` 升级到 `repo_root` + `basename(cwd)` 组合,顺手修自己的撞车 bug(不强求)。
- B-2 machine_id ↔ 项目稳定关联(可选,**不做也行**)。

**没有任何一条是 S2 阻塞**。§0.6 门 B 若 `attributed_rate < 50%`,优先做 A-1 + A-3 + B-1(team app 端 + Matrix-Riven 端各自能干)。

---

## 10. 验收

- leader 进 `/status`，扫一眼第一句是"哪个**项目**卡了"，不是"哪个**人**红灯"。
- 首屏工作线只显「状态 · 标题」；卡底「N 个 CC」匿名计数；**首屏任何位置无人名**（§4.8 序列化测试守护）。
- 人名只在 `/status/project/[id]` 和 `/status/[name]` 出现。
- CC 开在 matrix 文件夹但对话是别的项目 → 该工作线归到**对话内容指向的项目**，不被 cwd 带偏。
- `matrix` / `matrix-recording` / `teambrain` → 同一张 Matrix 项目卡。
- 无 cwd 的产品/运营工作（如运营组织文章）→ 能被提取 pass 识别成项目、被归属 pass 归过去。
- 每条工作线的归属在详情页能看到 `attribution_evidence`（人话理由）。
- 登记表全自动维护，无 leader 确认 gate；leader 能在详情页拆分/合并做 override。
- 连续两次跑，已有项目 id 100% 不变（`id_stability`）。
- 项目详情页无排名 / 对比柱 / 进度条；参与成员字母序无计数；仅 1 人时整块隐藏。
- Slack DM 在 `silence.dormant / blocked.* / dispatch.uncertain` 上主语是项目名。
- `/api/cc-status` 仍可用，CLI `team:status` 输出不变；新增 `team:workboard`。
- `work_summary.ts` 改动后，旧 `WorkItem` 消费方（`/status` 旧 roster、CLI）不读新字段，照常工作。
- §0.6 门 A（S1 收尾）已过：`id_stability == 100%` ∧ `extraction_evidence_coverage == 100%`；门 B（S2 收尾）已过：`attributed_rate` 达标 ∧ `attribution_evidence_coverage == 100%`。
- 全套测试绿（resolver / work_summary 约束输出 + evidence + 缓存失效 / workboard 匿名性 + 防抖 + 单贡献者 / anomaly 退路链）。
- 不依赖 §9 任何数据请求即可发 S1/S2。
- **S8 验收（项目画像落地后）**：
  - 详情页"About"区默认折叠，"This week"默认展开（leader cold-read 要求）。
  - About 区只渲染 4 字段（vocabulary / goals / key_people / open_questions）——无 `recent_decisions`、`cadence_notes`、`active_threads`。
  - 每条 ProfileFact 显 `last-evidence-date`；> 14 天视觉淡化、> 60 天自动 archive 不渲染。
  - `goals` 字段每条命中双 evidence 门（≥2 独立源），单 evidence 不入。
  - About 区每个 ProfileFact 必带至少 1 条 evidence 引用。

---

## 11. 待 leader / Matrix-Riven :8933 维护者拍板

1. **§9 B-1（SessionStart hook 加 git remote）** 维护者能否配合？v6 下它是 LLM 归属的辅证 context，非决定性，但仍提升准确度。
2. **§9 A-1（TodoWrite/Task input 接入）** 是否纳入 S1/S2？纯 extractor 改动，给 LLM 归属强 context。
3. **`/tasks` sidebar label 改 "Dispatch"**？还是走回退（保留 "Projects"，workboard H1 用 "工作板"）。
4. 未归类工作线区默认展开还是折叠？建议**展开**（折叠 = 变相羞辱抽屉）。
5. 提取 pass 的跑动频率——跟 `bun run sync` 还是独立 cron？画像 evolve 同周期还是更慢（如每日 03:00）？
6. ~~S8 排期~~ —— **作废**。CC dev 模式一条线 S1→S9 推到底,不分日历期。

---

## 附录：版本演进史

| 版本 | 分 | 关键变化 |
|---|---|---|
| v1 | 72 | 初稿，「项目 = `repoFromCwd`」 |
| v2 | 91 | 修 12 处，新增 schema bug |
| v3 | 97 | evidence_event_seqs 校正、防抖、拆 PR |
| v4 | 96 | 重建概念地基（登记表 + 多信号加权 matcher）+ §9 数据请求 |
| v5 | 99 | §9 事实校正、类型分层强制匿名、task_link 诚实降级 |
| v6 | 92 | **架构分叉**：杀确定性加权 matcher → LLM 归属（折叠进 work_summary）；登记表改 AI 提取 + 身份解析器，去 leader gate；schema 瘦身；`work_summary.ts` 从冻结清单移除 |
| v7 | 99 | 修 v6 冷读 5 点：`parseSummary` 标为真实强制点；审计拆门 A（S1）/门 B（S2）解决分期矛盾；`projects.json` 四写入方并发 → mutex+原子写纪律；`EvidenceRef.source` union 补 cc_session/slack/github；提取 pass 加 evidence 测试 |
| v8 | 99 | leader cold-read 反馈：新增 S8「项目画像」层（4 字段：vocabulary/goals/key_people/open_questions；砍 recent_decisions/cadence_notes/active_threads）；非可选 **staleness 信号**（每字段 last-evidence-date,>14d 淡化,>60d 自动 archive）；详情页 UI **"About" 默认折叠 / "This week" 默认展开**；goals 双 evidence 门 |
| v9 | 99 | **CC dev 模式适配**：删全部日历推理（"1-2 日 / 1 周 / 2 周再启"），§7 改写为 S1→S9 线性 build pipeline；每步**出口 gate = 测试/审计正确性**（不绿就停下修，不是日历等待）；P 标签全替换 S 标签 |
| **v10** | — | **Matrix-Riven 关系明确**：§0.7 架构分层(collector = 纯数据源,team app = 所有 smartness);§9 raw_prompt 已就绪(只需开 env);B-1 重新表述为兼容性请求(Matrix-Riven 透传不解读,符合 §0.7);取消 Option C(协作推登记表),采纳 Option A(自走);`docs/collector-data-asks.md` 同步重写为维护者(用户本人)的直接 todo |
