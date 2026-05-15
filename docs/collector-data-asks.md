# 给 Collector (Matrix-Riven, :8933) 维护者的需求 / Issue List

> 来源：`team/UX-PROJECT-FIRST.md` §9（项目维度 WIP 重构方案）
> 日期：2026-05-14
> 背景：team 前端要从「人为单位」改成「项目为单位」展示在做的工作。准确把工作线归到项目，需要一些 CC 侧数据。
> **重要**：以下没有任何一条是 team 端 P1 的阻塞项——方案在零数据增强下也能跑（软聚类退化成平铺工作线列表）。这些是「让匹配更准」的增强，按优先级排。

---

## 分类说明

- **A 类**：数据已经在 collector 收到的 jsonl 里，team 端只需改自己的 extractor。**列在这里只是知会，不需要 collector 改代码**——除了 A-3 / A-6 需要你确认两个事实。
- **B 类**：CC jsonl 里没有，需要 collector 侧改动（hook 脚本）。**这才是真正要你做的。**
- **Q 类**：需要你回答的问题，不涉及改代码。

---

## B-1 ⭐ 核心请求 — SessionStart hook 增加 git remote + repo root

**优先级**：P0（唯一高价值、需 collector 改动的项）

**现状**：CC 上传的 jsonl 每行带 `cwd` 和 `gitBranch`，但**不带 git remote URL，也不带 git 仓库根路径**。

**问题**：team 端只能用 `cwd` 最后一段路径猜项目。这在 monorepo 下会炸——例如 `D:\hrdai` 是一个 git 仓库，里面 `team/` `MiroFish/` `socialmind/` 是不同项目；`D:\hrdai\team\src` 和 `D:\hrdai\MiroFish\src` 都被猜成 `"src"`，撞车。

**请求**：在 collector 的 SessionStart hook 脚本里加两条命令，结果附进上传的 session 元数据：

```bash
git -C "$cwd" remote get-url origin      # → 例如 https://github.com/hrdai/team
git -C "$cwd" rev-parse --show-toplevel  # → 例如 D:/hrdai
```

**解锁**：`github.com/hrdai/team` 是稳定唯一的项目标识。team 端匹配置信度从「启发式猜测 ~0.85」升到「精确标识 1.0」。monorepo 子目录用 repo_root + 路径前缀组合精确定位。

**成本**：SessionStart hook 加两行；非 git 目录两条命令会失败，hook 需吞掉错误（输出空值即可，team 端能降级）。

---

## B-2 — machine_id ↔ 项目的稳定关联（可选）

**优先级**：P3（nice-to-have，不做也行）

**现状**：collector 已有 `machine_id`（见 `/api/cc-status` snapshot）。

**请求**：若 hook 能附带「本机常驻项目清单」更好；但 B-1 落地后其实已够用，B-2 可不做。

---

## Q-1 — `stop_hook_summary` 帧的 payload 结构是什么？

**类型**：Q（只需回答，不改代码）

CC jsonl 里有 `type: 'system'`、`subtype: 'stop_hook_summary'` 的帧。team 端想知道：**这个帧的 payload 里有没有模型自己写的「这轮做了什么 / 下一步」式的总结文本？** 还是只是 turn 计数 / 耗时之类的元数据？

- 如果有总结文本 → team 端可以零成本拿来当工作进展信号。
- 如果只有元数据 → team 端不浪费精力解析。

请贴一两个真实样本帧。

---

## Q-2 — collector 的 hook 配置里启用了 PostToolUse 吗？

**类型**：Q（只需回答）

CC jsonl 里有 `type: 'attachment'` 帧，带 `hookName` / `hookEvent`。team 端想知道：**collector 部署的 hook 配置里，PostToolUse 这个 hook 事件被启用了吗？**

- 启用了 → team 端能拿到每次工具调用的退出码，做「重复失败 = 卡住」检测。
- 没启用 → team 端知道这条路现在走不通，不去依赖它。

---

## Q-3 — `/api/cc-status/all`（富快照端点）什么时候 wire？

**类型**：Q（只需回答）

team 端代码（`live_cc.ts`）注释说 `/api/cc-status/all` 是 #350、「还没在 collector 侧 wire」。目前 team 端降级用 `/api/quota` per-user 兜底。

问题：`/api/cc-status/all` 有排期吗？它 wire 之后 team 端的实时层（context %、工具数、quota 窗口）会完整很多。不急，只是想知道是否在计划内。

---

## A 类 — 知会（collector 不需改代码，team 端改自己的 extractor）

以下数据**已经在你收到的 jsonl 里**，team 端会自己扩 `cc_session.ts` extractor 解析。列出来只是让你知道 team 端会开始读这些字段，万一未来 jsonl 格式变动请知会一声：

| # | 数据 | jsonl 位置 |
|---|------|-----------|
| A-1 | TodoWrite / Task 工具调用的 `input` | `assistant` 消息的 `tool_use` block |
| A-2 | 每个 session 的首条 user prompt | 第一条 `type:'user'` 非 tool_result 消息 |
| A-4 | worktree-state / permission-mode | 同名控制帧 |
| A-5 | Edit/Write 的 `file_path` | `tool_use` block 的 `input.file_path` |

（A-3 = Q-1，A-6 = Q-2，已上提到 Q 类。）

---

## 优先级总结

| 项 | 类型 | 要你做什么 | 优先级 |
|---|------|-----------|--------|
| **B-1** | 改 hook | SessionStart 加 2 条 git 命令 | **P0** |
| Q-1 | 回答 | 贴 stop_hook_summary 样本 | P1 |
| Q-2 | 回答 | 确认 PostToolUse 是否启用 | P1 |
| Q-3 | 回答 | `/api/cc-status/all` 排期 | P2 |
| B-2 | 改 hook | machine_id↔项目（可不做） | P3 |
| A-* | 知会 | 无需动作，格式变动时知会 | — |

**最小可行**：只做 B-1 + 回答 Q-1/Q-2，team 端的项目匹配就能从「猜」升级到「准」。
