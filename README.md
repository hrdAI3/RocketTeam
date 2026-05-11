# Rocket Team

> Personal-agent mesh for hybrid (human + Claude Code) team coordination.
> Each teammate has a personal agent. PMA queries them in parallel, runs a
> dual-track simulation, then writes a structured assignment + rationale.

[![Next.js](https://img.shields.io/badge/Next.js-14-black)]()
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)]()
[![Runtime](https://img.shields.io/badge/runtime-Node%20%7C%20Bun-yellow)]()

## What it does

```
新任务 ──▶ PMA 并发问每位 personal agent
              │
              ▼
         双 track 4 轮模拟（BID / DEFER / SPLIT / OBJECT / COMMIT）
              │
              ▼
         Report Agent 综合 → PMADecisionV2（top1 / 拆分 / null）
              │
              ▼
         /tasks UI 接受 / override；timeline.jsonl 留全量审计
```

UI: 团队成员卡片(任务优先 / 身份回落 双模式)、任务面板、推演时间线、live 推演直播、bootstrap、评审/对话(Report Agent)。

## Quick start

```bash
# 1. Install deps
bun install      # or: npm install / pnpm install

# 2. Env
cp .env.example .env
# Edit .env：填 LLM_PROVIDER + 对应 API key + SLACK_VAULT_KEY

# 3. (可选) 启用真实数据
cp -r private.example private
# 编辑 private/source-data/* + private/seed/seed.ts + private/context/*

# 4. (可选) Bootstrap personal agents from context
bun run bootstrap

# 5. Start dev server
bun run dev
# http://localhost:3000
```

`private/` 不存在也能跑——`paths.ts` 与 tsconfig path alias 都会回落 `private.example/`，placeholder 数据下 UI 完整渲染。

## 数据隐私设计

所有真实数据集中在 `team/private/`，被 `.gitignore` 完全屏蔽：

| 路径 | 内容 |
|------|------|
| `private/configs/` | Slack / GitHub OAuth token (AES-256-GCM 加密) |
| `private/source-data/` | bootstrap targets / ReportChat 建议 / prompt 示例（含真名） |
| `private/seed/seed.ts` | demo persona 种子脚本 |
| `private/context/{meeting,org,slack,github}/` | 真实会议/组织架构/聊天/PR 数据 |
| `private/agents/` | bootstrap 生成的 personal agent profile |
| `private/tasks/`、`private/sim-replays/`、`private/timeline.jsonl` | 运行时状态 |
| `private/resources/` | 资源凭证（加密） |

`team/private.example/` 是公开骨架镜像，提供占位符 + .gitkeep + setup README。

## 架构概览

- `src/app/` — Next.js 14 app router；UI 页面 + REST API
- `src/lib/` — 域核心：agents / tasks / timeline / mutex / file-io / paths / safeJoin / sanitize / slack / github / resources / llm
- `src/pma/` — PMA coordinator + 决策规则 + system prompts
- `src/sim/` — 双 track 4 轮推演引擎 + event bus + action executor
- `src/bootstrap/` — 2-phase LLM 抽取：会议 → per-member 总结 → full profile
- `src/report/` — Report Agent: 推演 → PMADecisionV2
- `src/_lib/` — 共享原子写、prompt 注入防御、控制字符剥离
- `tests/` — Vitest（domain + lib 层）

详细后端设计见 `BACKEND-REDESIGN.md`，前端列表页方案见 `UX-CC-FIRST.md`。

## 关键脚本

```bash
bun run dev           # Next.js dev (port 3000)
bun run build         # 生产构建
bun run typecheck     # tsc --noEmit
bun run test          # Vitest
bun run bootstrap     # 跑 bootstrap pipeline (LLM)
bun run pma           # PMA CLI
bun run seed          # 写入 demo personas (private/ 优先，回落 example/)
```

## LLM 配置

支持 OpenAI-compatible (MiniMax / DeepSeek / Moonshot / Qwen / OpenAI) + Anthropic (回退)：

```env
LLM_PROVIDER=minimax           # 或 anthropic
MINIMAX_API_KEY=sk-...
MINIMAX_MODEL=MiniMax-M2.7
MINIMAX_BASE_URL=https://api.minimax.chat/v1

ANTHROPIC_API_KEY=...          # 回退用
ANTHROPIC_MODEL=claude-sonnet-4-6

OPENAI_API_KEY=...             # 同 OpenAI-compatible 提供商通用
OPENAI_BASE_URL=...
OPENAI_MODEL=...
```

## 安全

- **Vault key 强制**：缺 `SLACK_VAULT_KEY` (Slack/GitHub) 或 `RESOURCES_VAULT_KEY` 启动失败，禁止默认降级到 LLM key 或硬编码值
- **Prompt 注入防御**：用户文本统一走 `_lib/sanitize.ts` 三角括号 + guard 段，剥离 ASCII 控制字符 + Unicode bidi/format 字符
- **路径遍历防御**：`safeJoin(base, name)` 拒绝 `..` / 绝对路径 / 空字节 / 反斜杠
- **原子写**：所有 JSON 落盘走共享 `atomicWriteJSON`（crypto.randomBytes 命名 + tmp + rename + 失败清理）
- **timeline 并发安全**：append 走 mutex，反向 chunk 流式读最后 N 行（CJK 安全）
- **Mutex LRU**：长跑进程不泄漏，evict 时跳过 locked 实例

## License

MIT
