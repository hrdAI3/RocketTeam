# Rocket Team — 产品分析 / 迭代原因 / 未来预期

> 本文档记录 Rocket Team 当前版本的产品定位、走到这里的迭代逻辑、以及下一步方向。写给 leader + 接手的 agent。
>
> 最后更新：2026-06-03（北京时间）

---

## 1. 产品是什么（当前版本）

**Rocket Team = 扎根 Claude Code 执行真相的「团队 AI leader」。**

一句话：别人观测聊天/工具产物，我们观测**真实执行**（CC session 级 hook 埋点）。在这个独有深度上，为 leader（安子岩，当前测试用戴昊然）自动监控 + 治理一个「人 + Agent」混合团队。

当前已上线的能力：

| 模块 | 做什么 |
|---|---|
| **Workboard /status** | leader 的注意力稀缺落地页：只显示需要介入的（异常、blocked 项目、未归档工作、外部仓库、离职疑似、未映射 CC actor）。默认空屏 = 一切正常 |
| **CC 观测** | Matrix-Riven collector（192.168.22.88:8933）hook 每个人的 CC session → events.jsonl（session_started/ended、tool_called、stuck_signal、token_usage）|
| **项目归因** | 把 CC 工作归到 tracked GitHub 仓库（= 项目）。多信号 attributor（见 §4）|
| **团队 roster** | `team_roster.json` 单一权威源：每人 Slack / CC / GitHub 三账号 + health |
| **GitHub 合规引擎** | 每工作日检查，缺 login/公司邮箱/renlab 昵称的自动 Slack 催，4 级升级到 leader。Policy A：要求只落在持仓库者 |
| **归档提醒** | CC 工作没归到任何 tracked 仓库 → 提醒操作人建仓库（4 级工作日升级）|
| **外部仓库转交** | tracked 仓库在个人账号 → 催所属人转交 anzy-renlab-ai |
| **Slack 双向** | 出站 DM（bot token）+ 入站 Socket Mode（员工回复自动入库）|
| **AgentRun 模型** | agent-native 主键：一个 CC session = 一个 AgentRun（见 §3）|

---

## 2. 迭代原因（怎么走到这里）

### 2.1 起点：person-axis 仪表盘
最初是「leader 监控 24 个工程师 CC 活动」的仪表盘。主键是**人**。做了 roster、合规、归档、异常推送 —— 全部围绕「张三在干嘛」。

### 2.2 转折：agent-native 重定位
盘到一个本质问题：**AI-native 团队里，产出单位是 agent run，不是人头。** 14 个人同时跑 40+ 个 CC session，吞吐量是 agent-bound。

对标当下「把组织搬到 AI 上」赛道（Helio / Bloome / Lucius / Sentra / Creao，a16z/经纬/红杉在投），我们的独有定位浮现：

> 别人的组织 Center 是**新 IM**（Helio/Bloome）或**聊天记忆层**（Lucius/Sentra）。我们是第 4 类 —— **Center 是 CC 执行层本身**（干的活，不是聊天）。观测深度无人能及（keystroke 级），这是护城河。

决策：主键从「人」翻转为「**AgentRun**」。人降级成 run 的一个属性。

### 2.3 attribution 五层洋葱（本次迭代主战场）
AgentRun 一建，冒烟测试立刻暴露：**归因 97% 失败**。一路挖下去，发现是数据/采集问题，不是算法 —— 每修一层露下一层：

| 层 | 问题 | 状态 |
|---|---|---|
| 1 | **cwd 96% 被 collector redaction 抹成 `[redacted]`** —— private-path 正则贪婪吃光整条路径（违背其「只抹用户名段」的设计注释，是 bug）| ✅ 解封（外科手术改正则，只抹用户名段 `/Users/_/repo`，新 session 生效）|
| 2 | **commit 事件 = 0** —— extractor 发 PR/review 但不发 commit | ✅ 开了（3387 commit 事件）|
| 3 | **observed_cwds 污染** —— 旧 LLM 错绑（家目录、会议纪要、E:\jingtong 全绑到 hireic），连「高置信」cwd 匹配都错 | ✅ 清洗（54→16，删 38）+ 加 deny 规则防再污染 |
| 4 | **操作人身份缺口** —— 头号 CC 操作人 `xuyh@renlab.ai`（5.9 万事件）= 徐云昊，没进 roster | ✅ 映射（徐云昊 + 两个 CC 邮箱）|
| 5 | **fuzzy quote tier 净负** —— 12/16 归因是错的 | ✅ 关掉（gate 默认 off）|

**核心教训：归因从来不是算法瓶颈，是上游身份 + 观测数据质量。** 两个 workflow（16 agent、1.1M token）的价值在于**证伪了「算法是问题」**，把我们指向真正的瓶颈。

---

## 3. AgentRun —— agent-native 主键

```ts
AgentRun {
  run_id          // = CC session_id
  operator        // 解析到的人名（次要属性，不再是主键）
  project_id      // 归因结果
  attribution_method / attribution_confidence / attribution_evidence  // 可审计
  cwd / branch / model
  started_at / ended_at / last_activity_at / status (live|done|stalled)
  tool_calls / tool_counts / files_touched / stuck_count
  outputs[]       // commits/PRs（v1，待接产出账本）
}
```
`src/lib/agent_run.ts::buildAgentRuns()` —— events.jsonl 按 session_id 重聚合（现成数据，无新采集）。

---

## 4. 归因 attributor（当前架构）

`src/services/attribute_run.ts`，多信号、确定性优先、**宁可 null 不瞎配**：

| rank | 信号 | 置信 | 说明 |
|---|---|---|---|
| 1 | commit → repo → project | high | commit 作者===操作人 且 commit 在 run 窗口内，repo 映射到项目，全部一致才命中 |
| 2 | PR/review → repo → project | high | 同上，PR 绑 repo |
| **2.5** | **cwd 叶子 === tracked repo 名** | **high** | **本次新增收尾** —— 目录名就是 repo 名（`D:\lll\d2p`→d2p）。复用 distinctive 唯一叶子索引，无碰撞。不依赖 observed_cwds，cwd 解封后立刻兑现 |
| 3 | cwd 精确匹配 observed_cwds | medium | 加 binding guard + home-root guard，污染匹配 abstain |
| 4 | cwd 最长前缀 | low | + 共享父目录 guard |
| 5 | quote 挖矿 | (关) | 净负，默认禁，`enableQuoteTier` 可开 |
| 6 | LLM over evidence | low | 成本受限（≥8 tool calls + budget 60/pass），`disableLLM` 可关 |

**当前覆盖率现实**：历史数据 ~0%（cwd 永久 redacted，救不回；commit/PR 时间窗对不齐）。**前向路全修好** —— 新 session 带真 cwd，cwd-leaf tier 高置信命中（已验证：李家乐→d2p、徐云昊→matrix-riven 全对）。覆盖率会随新数据累积爬升。

---

## 5. 未来预期

### 5.1 短期：让归因兑现（数据累积中）
- collector 解封只影响**新 session**，覆盖率未来一天随真-cwd 数据爬升
- collector 备份：`192.168.22.88:.../bin-prod-server.cjs.bak-20260603-cwdfix`（回滚一条 cp + 重启）
- 仍露的小缺口：大家在 selected_repos **之外**的仓库干活（commit 解析到人但 repo 没 tracked）→ 需自动发现 + 注册 repo

### 5.2 中期：从「检测」升「消化」（对标 Sentra）
五个可偷方向（来自 AI-native-org 赛道调研），按价值排：

1. **AgentRun 一等实体 + 身份**（Helio 验证）—— 已起步
2. **主动简报**（Sentra）—— 最小投入最大杠杆：每项目自动状态报告 + leader 会前 context pack。把观测变综合，产品从「检测+催」升「消化+预判」。这是 AI leader 真身的第一步
3. **知识图谱** who/what/when/why（Sentra）—— 扁平归因升成图
4. **程序记忆 + playbook 结晶**（Lucius/Creao）—— 成功 run → 可复用模板
5. **治理护栏三件套**（Helio）—— 但「强制护栏」需双向 collector（能回传暂停/批准指令），是另一个项目量级

### 5.3 长期：vision → strategy → fleet 闭环
```
vision.md（北极星，人拥有）
   ↓ AI leader 拆解
strategy（当下押注，AI leader 维护，人批准变更）
   ↓
AgentRun 舰队（派发/协调/监控，全自动）
   ↓ 产出账本
对齐度（产出有没有推近 vision？）
   ↓ 没有 → 重排 strategy → 浮给人
```
终局：**人管意图，AI 管维系。** 人只剩三个触点 —— 写/改 vision、批准 strategy 转向、验收/仲裁。

命门：**产出账本 + 对齐度测量** —— 没有它，AI leader 只是高效地把可能错的东西做完。

---

## 6. 配套文档
- `docs/GH_COMPLIANCE.md` —— GitHub 合规引擎（3 规则 + Policy A + 闭环）
- `docs/TEAM_ACCOUNTS.md` —— 人名↔Slack↔GitHub↔CC 四账号对应表
- `private/team_roster.json` —— roster SOT（别手改 identity.json，派生的）

## 7. 运维关键坑
- **改 refresh/compliance/roster/attribute/extractor 代码后必须重启 dev** —— 长驻 monitor 单例不热重载，否则旧逻辑覆盖新判定
- **Slack DM 一律按 user_id 发**，不按中文名（显示名常≠中文名）
- **collector 改动**走 SSH + base64 传输（避反斜杠 shell mangling）+ 改前备份 + node -c 语法检查 + systemd 重启
- 时间一律北京时间展示（存储 UTC）
