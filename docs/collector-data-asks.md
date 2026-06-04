# Matrix-Riven (:8933) 数据增强 todo

> 你就是维护者,本文档直接是你的 todo list,不是给第三方的 issue。
> 来源:`team/UX-PROJECT-FIRST.md` v10 §9。
> 架构边界(v10 §0.7):Matrix-Riven 保持纯数据源,所有 LLM/多源融合/项目语义在 team app。本文档的请求**不破坏**这条边界——只是 hook 多抓两条信息附进现有 `CcStatusSnapshot`,Matrix-Riven 自身不解读这些新字段,只透传。
> **重要**:没有一条是 team 端 S2 阻塞——零增强下方案走软聚类模式仍可发。

---

## 立即可做的(零成本 / 一行 env)

### ✅ #1 — 开 `RIVEN_REALTIME_RAW_PROMPT=1`

**现状**:`CcStatusSnapshot.raw_prompt` 字段已在,`bin-user-prompt-submit.cjs` hook 已抓首条 user prompt,但默认 `undefined`,需 env 开。

**为什么开**:team app 的 LLM 归属吃这条 prompt 当 session 意图 context。**对无 cwd 的产品 / 运营项目尤其关键**——LLM 看到"帮我组织一篇关于 X 的文章",才能把这条工作线归到正确项目。

**成本**:production 环境改一个 env。

**注意隐私**:开 env = raw prompt 文本会发到 collector。已有 PII redactor(L1)过一遍,但 team app 也会看到。如组织里有"prompt 内容不离机"政策,这条**不要开**——团队要先讨论。

---

## 需你回答两个问题(看下源码就行,不改代码)

### Q-1 — `stop_hook_summary` 帧 payload 长啥样?

CC jsonl 里有 `type: 'system'`、`subtype: 'stop_hook_summary'` 的帧。问题:**帧 payload 里有没有模型自写的"这轮做了什么 / 下一步"总结文本?** 还是仅 turn 计数 / 耗时等元数据?

- 有总结文本 → team app 零成本拿来当工作进展信号(`cc.recap` 事件)
- 只有元数据 → team app 不浪费力气解析

请贴一两个真实样本帧 / 直接说"只元数据,没文本"。

### Q-2 — collector hook 配置启用了 PostToolUse 吗?

CC jsonl 有 `type:'attachment'` 帧带 `hookName`/`hookEvent`。问:**Matrix-Riven 部署用户机器的 Claude Code settings 里,PostToolUse hook 启用了吗?**

- 启用了 → team app 能拿每次工具调用退出码,做"重复失败 = 卡住"检测
- 没启用 → 知道走不通就不依赖

---

## 真要你写代码的(就这一条)

### ⭐ #B-1 — SessionStart hook 加 git remote + repo root,透传进 `CcStatusSnapshot`

**改两处**:
1. `bin-session-start.cjs` SessionStart hook 脚本里,在现有抓 cwd / branch 之后加两条命令:
   ```bash
   git -C "$cwd" remote get-url origin       # → 例如 git@github.com:libz-renlab-ai/Matrix-Riven.git
   git -C "$cwd" rev-parse --show-toplevel   # → 例如 D:/hrdai/Matrix-Riven
   ```
   非 git 目录两条命令会失败,hook 吞错输出空字符串即可(team app 端能降级)。
2. `@matrix-riven/shared/cc-status/types.ts` 的 `CcStatusSnapshot` 加两个可选字段:
   ```ts
   /** `git remote get-url origin` 的输出,SessionStart hook 抓。非 git 目录则 undefined。 */
   git_remote_url?: string;
   /** `git rev-parse --show-toplevel` 的输出,SessionStart hook 抓。同上,非 git 则 undefined。 */
   repo_root?: string;
   ```
   bump `CC_STATUS_SCHEMA_VERSION` 还是不 bump:这俩是 additive optional 字段,**不 bump**(schema 版本管的是非可加变更)。

**Matrix-Riven 自身不解读这俩字段,只透传**——符合 §0.7 数据源职责。

**解锁什么**:
- team app LLM 归属获得稳定项目身份 context(不是决定信号、是辅证):`github.com/libz-renlab-ai/Matrix-Riven` 是唯一标识,胜过 cwd 末段瞎猜
- `repo_root` 让 monorepo 子目录定位准确(`D:\hrdai\team` vs `D:\hrdai\MiroFish` 不再都成 `src`)

**顺手的好处**(不强求做,做了就 free):Matrix-Riven 自己的 Overview tab Projects panel 现在用 `basename(cwd)` 会撞车——升到 `repo_root + basename(cwd)` 组合就修了。看你 collector 维护者的心情。

---

## 优先级 / 工作量

| # | 事 | 你做 | team app 端 | 出口 |
|---|---|---|---|---|
| **#1** | 开 raw_prompt env | 一行 env | 改 extractor 读这字段 | LLM 归属 context 升级,**S2 门 B `attributed_rate` 提升** |
| **Q-1** | 看 stop_hook_summary payload | 贴样本/答 | 决定要不要做 `cc.recap` extractor | 若有文本,多一路工作进展信号 |
| **Q-2** | 看 PostToolUse 配置 | 答 | 决定要不要做退出码 extractor | 若启用,"卡住"检测精度 |
| **B-1** | SessionStart hook + schema 字段 | hook 两行 + types 两字段 | matcher 把这俩进 MatchContext | 项目身份精度从"猜"升"准" |

**没有 S2 阻塞**——只要你愿意花 5 分钟开 #1 的 env,我们已经比"零数据增强"基准好一档。B-1 是想真正做对项目身份才做。

---

## 不在本文档要的(明确切割,符合 §0.7)

- ❌ 把项目登记表 / LLM 提取塞进 Matrix-Riven —— 不要
- ❌ Matrix-Riven 学会"什么是项目" —— 不要,语义在 team app
- ❌ Matrix-Riven 的 Overview tab 改成消费 team app 的 `/api/workboard` —— 两边独立工具,互不依赖
