# `private.example/` — 私有数据骨架模板

本仓库**所有真实数据**集中放在 `team/private/` 下并被 `.gitignore` 完全屏蔽。`private.example/` 是它的「公开骨架镜像」：相同目录结构 + 占位内容，用来：

1. **新人 clone 后零步骤即可启动** — `tsconfig.paths` 与 `lib/paths.ts` 都做了「`private/` 缺失则回落 `private.example/`」的双 fallback，直接 `bun dev` 就能跑（数据为空但服务正常）。
2. **文档化数据约定** — 每个目录是干什么用的、文件应该长什么样，看 example 就懂。
3. **保护隐私** — 真实会议记录、组织架构、人员画像、API token 一行不进 git。

---

## 目录约定

| 路径 | 内容 | private/ 真实形态 | example 占位 |
|------|------|------------------|--------------|
| `source-data/targets.ts` | bootstrap 默认 4 个 demo 成员 | 真名 | 张三/李四/王五/赵六 |
| `source-data/suggested-questions.ts` | ReportChat 4 条建议问题 | 真名引用 | 占位名 |
| `source-data/prompt-examples.ts` | LLM prompt 中的人名示例片段 | 真名 | 占位名 |
| `seed/seed.ts` | `bun run seed` 写入的 demo persona | 真实 persona | 1 个 stub |
| `configs/slack.config.json` | Slack OAuth token (加密) | 真实 | 不存在 |
| `configs/github.config.json` | GitHub PAT (加密) | 真实 | 不存在 |
| `context/meeting/*.txt` | 真实会议记录 | 真实 | 空 |
| `context/org/组织架构.txt` | 组织架构 | 真实 | 空 |
| `context/slack/` `context/github/` | 拉取的 chat / PR 数据 | 真实 | 空 |
| `agents/*.json` | bootstrap 生成的 personal agent profile | 真实 | 空 |
| `tasks/*.json` | PMA 决策任务 | 真实 | 空 |
| `sim-replays/*.json` | 推演完整 state | 真实 | 空 |
| `resources/*.json` | 团队资源 (含加密 credential) | 真实 | 空 |
| `timeline.jsonl` | 全局事件审计流 | 真实 | 空 |

`team/.env` 是唯一**不**在 `private/` 下的私有文件（受 Next.js 约定限制只能放项目根），同样 gitignored。

---

## 在 fork / clone 上启用真实数据

```bash
cd team
cp -r private.example private    # 把骨架复制成可写真实仓
# 然后逐项填充：
#   1. private/.env  （或 team/.env） — LLM API key、SLACK_VAULT_KEY 等
#   2. private/configs/  — 跑 OAuth 流程后自动写入
#   3. private/source-data/  — 编辑成你的真实成员名字 / 问题
#   4. private/seed/seed.ts  — 写你的 demo persona
#   5. private/context/meeting/  — 放你的真实会议 .txt
#   6. private/context/org/组织架构.txt  — 写你的组织架构
# 然后:
bun run bootstrap   # 从 context/ 抽出 personal agent → agents/*.json
bun run dev         # 起服务
```

---

## 我不想用真名怎么办

完全可以一直用 `private.example/` 跑 demo——所有路径默认回落到这里。代码里出现的"张三/李四"占位会在 PMA / sim 输出里被照搬，不影响逻辑。
