# UX 优化方案：从「人」优先到「Agent 工作台」优先 — v2

> 受众：Rocket Team leader · 输出物：列表页 + 详情页重构方案
> v1 写于 2026-05-09 17:55；v2 改于 2026-05-09 19:00（合并 code-reviewer 评审反馈）

---

## 0. 数据真实性审计（v2 新增 · 必须先过）

> 评审一针见血：v1 把 narrative 字段当 telemetry 用了。重构前必须把"哪些字段真、哪些字段是 LLM 编的"列清楚。

### 0.1 字段来源分级

| 字段 | 类型来源 | 真实度 | 说明 |
|------|---------|--------|------|
| `agents.claude_code.current_tasks[i].description` | bootstrap LLM 从会议记录推断 | **narrative**（编的）| 没有 CC 进程 telemetry 接入；是模型基于"这人最近在聊什么"猜的 |
| `agents.claude_code.current_tasks[i].started_at` | bootstrap LLM 编 | **narrative** | "已运行 47 分钟"会是谎言 |
| `agents.claude_code.quota_used_cny / quota_limit_cny` | bootstrap 时人填或 LLM 给默认 | **stub**（占位）| 没接 Anthropic billing API |
| `agents.claude_code.last_active_at` | 写画像时间，不是 CC 活动时间 | **stub** | |
| `agents.claude_code.strengths_observed / weaknesses_observed` | LLM 从会议+chat 总结 | **narrative** | 有证据但未必新鲜 |
| `workload.active / blocked_on` | LLM 从会议提取 | **narrative** | 比 current_tasks 更可靠（有 evidence quote）|
| `_meta.bootstrapped_at / evolution_count` | 系统真实写入 | **真** | |
| `dept / role / mbti / capabilities` | 人设，相对稳定 | **真**（半静态）| |

### 0.2 含义

- **不能宣称"在跑 8/24"**——这是 narrative 累加，不反映 CC 真实运行状态。
- **不能显式"已运行 47 分钟"**——`started_at` 不是 telemetry 时间戳。
- **配额条仍可保留但要标记**「示例额度，未接 billing」或先不显示百分比。
- **真正可信的"在做什么"信号** = `workload.active`（有 meeting evidence quote）+ owner 手填的 `current_tasks.description`，但要去掉时间维度。

### 0.3 P0 前置任务

接入真 telemetry 之前，方案目标改为：**让 narrative 信号更显眼，同时诚实标注其新鲜度**。等 P4 接 Anthropic SDK / OTLP 后再加"实时运行"。

---

## 1. 现状诊断

### 1.1 当前页面信息密度（按视觉权重计）

**列表页 `/agents`（`src/app/agents/page.tsx` + `PersonAgentCard`）**

| 区块 | 内容 | 视觉占比 |
|------|------|---------|
| 顶部 Header | 标题「成员」、文案「每位同事都有自己的 Claude Code agent」 | 约 15% |
| Stats strip | 团队总人数、正在工作的 Agent、进行中任务、能量条 | 约 10% |
| 部门 tabs | 全部/老板/研发/产品/职能/运营 | 约 5% |
| 卡片身份行 | 头像（md）+ 姓名（serif 15px）+ 部门·角色 + energy badge | 卡片内 35% |
| 卡片 Agent 行 | Cpu 图标 + "Claude Code" 字样 + 配额条 + 当前任务一行 | 卡片内 40% |
| 卡片 Workload 行 | 任务数 chip + 阻塞 chip + 学习焦点 | 卡片内 25% |

**关键问题**：卡片标题区是人，CC 块只算第二行；leader 扫一遍只看到 24 张「人脸+部门」。

**详情页 `/agents/[name]`** — 人设占约 85%，CC 占约 15%。

### 1.2 用户假设错位

代码故事：「每个人都有 CC agent，PMA 决定派给人或派给 agent」。
Leader 心智：**人 = 配置者，CC = 执行者**。

> 现状把 CC 做成「人的属性」之一；leader 想把人做成「CC 的 owner 元数据」之一。

### 1.3 受众真实构成（v2 新增 · 评审 #8）

`/agents` 页的真实读者：
- **1 个 leader** — 想要 CC 状态总览
- **23 个团队成员** — 找彼此（pairs_well_with）、看部门归属、查 MBTI/能力做协作判断、找会议来源

**结论**：不能为 1 人服务而把 23 人需要的人设彻底降维。设计目标 = leader 看到 CC 信号的成本下降，但成员找人的成本不上升。

---

## 2. 设计原则（v2 修订）

1. **CC 信号上浮，人设保留可达**：不藏 tab，藏在折叠区或同页下方。
2. **诚实标注**：narrative 字段标注「画像推断」徽标，不伪装成实时。
3. **空态优雅降级**：CC 没数据时回落到身份卡，不是 24 行"空闲"。
4. **可扫描 > 可阅读**：列表页主线视觉密度提升。
5. **不删数据**：MBTI、能力评分、合作偏好、画像来源全部保留入口。

---

## 3. 列表页 `/agents` 重构方案

### 3.1 双模式卡片（v2 修订 · 评审 #2）

**模式 A · 有 narrative 任务信号**（`workload.active.length > 0` 或 `current_tasks.length > 0`）：

```
┌───────────────────────────────────────────────────────┐
│ ⚡ 重构 auth middleware                  [画像推断]    │  ← 主信息
│   阻塞：等运维开权限                                    │  ← 阻塞（如有）
├───────────────────────────────────────────────────────┤
│ [小头像] 张三 · 研发                       配额 47%*  │  ← Owner 元行 12px
└───────────────────────────────────────────────────────┘
* 配额示例值，未接 billing
```

**模式 B · 空态 fallback**（无任何任务信号）：

回落到现状身份卡布局（头像 md + 姓名 serif + 部门·角色 + energy badge），底部加一行 `Claude Code 待派任务`。

理由：模式 B 让空态卡仍由人物身份承载视觉，避免 24 行"空闲·等待任务"的劣化。

### 3.2 新 stats strip（v2 修订）

| 列 | 字段 | 数据真实度 |
|---|------|-----------|
| 1 | 团队 24 人 / 已配 CC X 个 | 真 |
| 2 | 有 active 任务的人数 | 真（workload.active 计数）|
| 3 | 阻塞任务数（有 → amber） | 真（blocked_on 计数）|
| 4 | 画像新鲜度（最久未 evolve 的人 = N 天前） | 真（_meta.bootstrapped_at）|

**移除**：「正在工作的 Agent」（基于 narrative current_tasks，不可信）、能量条（人设维度，且非 leader 关注面）。

### 3.3 筛选维度

- 主 tab：**有任务 / 阻塞 / 空闲 / 全部**（基于 workload，不基于 current_tasks）
- 副下拉：部门筛选（保留但下沉，不占主导航）

### 3.4 排序

默认：阻塞 → 有 active 任务 → 空闲。
副选项：按部门、按画像新鲜度。

### 3.5 改名 — 推迟（v2 修订 · 评审 #4 #5）

不改 sidebar「成员」label。理由：
- 全项目 20+ 文件引用 `成员` / `团队成员` 字串（搜索模态、面包屑、layout、bootstrap、scripts）。改名风险面大。
- bootstrap 模态本质是从会议提取**人**再配 CC。页标题改「Claude Code 工作台」与"立即生成"按钮语义打架。

折中：H1 改副标题强化定位：
- H1: `团队成员`（保留）
- 副: `24 人 · 24 台 Claude Code · leader 看 agent 在做什么，成员看彼此`

---

## 4. 详情页 `/agents/[name]` 重构方案（v2 大改 · 评审 #3）

### 4.1 不做双 tab，做"上下分区 + 折叠"

理由：
- tab 切换 = 2 次点击才能看 collab/MBTI，对 23 个成员是反模式
- tab 引入 URL state、按钮条件渲染、tab nav 等复杂度，不值
- 折叠区同样实现视觉降权，且支持"扫一眼能展开"

### 4.2 新版面（自上而下）

```
┌─ 精简 Hero（≤ 60px）────────────────────────────────┐
│ [小头像] 张三 · 研发              [修正画像]         │
└─────────────────────────────────────────────────────┘

┌─ Claude Code 运行（不可折叠，主区）─────────────────┐
│ · 当前任务（current_tasks，标"画像推断"）            │
│ · 进行中（workload.active）                          │
│ · 阻塞（workload.blocked_on）                        │
│ · 配额（标"示例额度"）                               │
│ · 过往完成（past_tasks + completed tasks）           │
└─────────────────────────────────────────────────────┘

┌─ Owner 画像 ▾ 默认折叠 ─────────────────────────────┐
│ · 能力分布（领域 + 技能）                            │
│ · 主要合作人员                                       │
│ · 当前方向 + MBTI                                    │
│ · 硬约束                                             │
│ · 画像来源                                           │
└─────────────────────────────────────────────────────┘
```

折叠区用 `<details>` 或受控 `useState`，标题点击展开。无 URL state 切换。

### 4.3 「修正画像」按钮（v2 修订 · 评审 #6）

只保留**一个**入口，复用现有 evolve 流程。删掉 v1 第 4.4 节"修正 CC 行为"——后端 evolve 当前不支持仅改 CC 字段，写出来是 stub-promise。

如果未来要分流：另起 spec 写新 evolve endpoint。

---

## 5. 后端/数据 — v2 修订

| 字段 | v2 处理 |
|------|---------|
| `current_tasks.started_at` | 前端不渲染时长，只显示描述 + "画像推断"徽标 |
| `quota_used / limit` | 显示但加 `*未接 billing` 脚注 |
| `subtasks` | 不加。等 P4 接真 telemetry 时一起设计 |

无后端改动。

---

## 6. 落地分阶段（v2 修订 · 评审 #7）

| 阶段 | 工作量 | 文件 | 何时发 |
|------|-------|------|--------|
| **P1 · 列表页双模式卡 + stats 修正 + 筛选改 workload-based** | `PersonAgentCard.tsx` + `agents/page.tsx` | 2 文件 | **先单独发，观察 1 周** |
| **P2 · 详情页折叠版面**（仅在 leader 用 P1 后仍抱怨详情页时做） | `agents/[name]/page.tsx` 拆 OpsSection + ProfileCollapse | 1 文件 | P1 + 1 周后评估 |
| **P3 · 真 telemetry 接入** | bootstrap/agents.ts 加 telemetry ingest，前端去掉"画像推断"徽标 | 多文件 | 独立排期 |

**P1 单独发**的理由：
- 自包含，~150 行 diff
- 30 秒后 leader 能看到效果
- 详情页改动可能 leader 看完 P1 就不再有强诉求

不再把 P1+P2+P3 打包一次发。

---

## 7. 不在范围内

- 不删任何画像数据
- 不动 PMA、bootstrap、evolve 流程
- 不动 `/tasks` `/timeline` `/sim` 等其他页面
- 不改 sidebar / 全局命名（v2 调整）

---

## 8. 风险与待 leader 拍板

### 8.1 已识别风险

1. **narrative 字段被当 telemetry 误读**：通过"画像推断"徽标 + stats 字段替换缓解。
2. **23 个成员找人成本上升**：通过折叠区（非 tab）+ 列表页保留模式 B 缓解。
3. **leader 真正诉求可能不是 UI 而是 telemetry**：P1 发完观察，如果 leader 仍抱怨"看不到 CC 在做啥"，根因是数据不真实，要走 P3 不是再改 UI。

### 8.2 待拍板

1. P1 单独发，观察一周后再决定 P2/P3 — 是/否？
2. 「画像推断」徽标用文字还是图标？放卡片右上还是任务行尾？
3. P2 折叠区默认全部收起，还是「能力分布」默认展开（leader 协作判断高频）？
4. P3 telemetry 接入是接 Anthropic SDK billing/usage API，还是先做手动上报？
