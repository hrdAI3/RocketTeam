# Rocket Team · 新同学接入指南

> 欢迎加入 🚀
> 这份指南只讲三件事：**怎么连上系统、怎么管理你的 GitHub 仓库、怎么处理机器人的 Slack 提醒**。
> 照着做完就接入了，大概 5 分钟。

---

## 1. 怎么连上我们的系统

你**不需要**登录任何网页后台。系统是自动从你的真实工作里读取信息的——你正常干活就行。

接入只有一个动作：**正常使用 Claude Code**。

你的 Claude Code 会话日志会自动同步到团队采集服务，系统据此理解你在做什么、在推进哪个项目。
接入后，几小时内你就会出现在团队视图里。

> 如果用了一阵子还没被系统识别，把你的**邮箱**和**电脑用户名**发给 leader，让他把你映射到花名。

---

## 2. 怎么管理你的 GitHub 仓库

### 第一步：登记 GitHub 账号

机器人（Slack 上的 **rocket-team**）会私信你，让你登记 GitHub 用户名。
**直接回复** `github.com/` 后面那串，或贴你的主页链接，例如：

```
github.com/yourname
```

机器人自动核对并回复确认 ✓。

### 第二步：如果你名下有团队仓库，二选一

只有**名下挂着团队跟踪仓库**的人需要这一步。机器人会告诉你具体是哪些仓库。二选一：

**方案 A（推荐，最省事）— 把仓库转交给 `anzy-renlab-ai`**
GitHub → 进入该仓库 → Settings → 拉到底 Transfer ownership → 转给 `anzy-renlab-ai`。
转交后，**邮箱和昵称都不用改**，一步到位。

**方案 B — 仓库留在你自己账号下**，那需要配两项：
- **公司邮箱**：GitHub → Settings → Public profile → Public email，选你的 `@renlab.ai` 或 `@nb-ai.com` 邮箱
- **昵称**：GitHub → Settings → Public profile → Name，改成**包含 `renlab`**

配好后系统会自动确认 ✓，不用回复机器人。

> 为什么要这样：团队仓库要保证公司账号能长期访问，不能只挂在个人号上——万一个人号停用，代码就找不回了。

---

## 3. 怎么处理机器人的 Slack 提醒

机器人是**只发通知、不闲聊**的。它只在这几种情况私信你：

### 3.1 让你登记 GitHub
> "Hi! Rocket Team is registering everyone's GitHub. We still need: …"

→ 回复你的 GitHub 用户名即可（见第 2 节）。

### 3.2 提醒你归档工作（Archive reminder）
> "⚠️ Reminder · 你有 N 项 Claude Code 工作已 Nd 没归到任何团队 GitHub 仓库…"

意思是：你有一摊工作一直没归到任何团队 GitHub 仓库。处理方式：
- **新建一个 GitHub 仓库**归档它（建好告诉 leader 加入跟踪），或
- 把它**挪到已有的团队仓库**里。

消息末尾会问你"**这个归纳准吗？**"
如果系统把你的工作理解错了（比如归错了项目名），**直接回复这条消息**告诉它，系统会据此修正。
认真回这一句，能帮系统越来越准。

### 3.3 提醒你转交仓库
> "⚠️ Repo xxx/yyy is still under a personal account…"

→ 按第 2 节方案 A 把仓库转交给 `anzy-renlab-ai`，或方案 B 配公司邮箱。

---

## 一句话总结

| 你要做的 | 怎么做 |
|---|---|
| **连上系统** | 正常用 Claude Code，自动接入。没识别就把邮箱+电脑用户名发给 leader。 |
| **登记 GitHub** | 机器人私信你时，回复 `github.com/你的用户名`。 |
| **管理仓库** | 名下有团队仓库 → 转交 `anzy-renlab-ai`（省事），或配公司邮箱 + `renlab` 昵称。 |
| **回机器人提醒** | 登记类→回用户名；归档类→建 repo 或挪仓，并回复"准不准"；转交类→转给 `anzy-renlab-ai`。 |

有问题找 leader。欢迎上车 🚀
