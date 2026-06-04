# GitHub 账号合规引擎 — 交接文档

> 目标：**每个 tracked GitHub 仓库都由「公司邮箱 + renlab 品牌」的账号管理**。另一个 CC 直接读本文接手。

最后更新：2026-05-25（北京时间）

---

## 0. 三条 Slack 提醒规则总览

| 规则 | 触发 | 收件人 | 升级 | 频率 |
|---|---|---|---|---|
| **GH 合规** | login / 公司邮箱 / renlab 昵称 缺 | 本人 | 1-3 本人 → 4 抄 leader | 每工作日一次 |
| **归档提醒** | CC 工作没归到任何 tracked GitHub 仓库 | **操作人**（要他建仓库）| 1-3 操作人 → 4 操作人+leader | 每工作日一次 |
| **外部仓库转交** | tracked 仓库 owner 在个人账号 | 仓库所属人 | 4 级 → leader | 每工作日一次 |

`fyi` anomaly 永不 DM。所有节奏按工作日（周末/节假日跳过，见 `private/holidays.json`）。

---

## 1. 合规定义（Policy A — 按仓库）

核心：要求只落在**持有 tracked 仓库**的人身上。

| 项 | 谁需要 | 验证 |
|---|---|---|
| **login** | **所有人**（用于把仓库映射到人） | 员工 Slack 回复用户名 → 自动入库 |
| **公司邮箱** | **仅持仓库者** | GH API `/users/{login}.email` 后缀 `@renlab.ai` / `@nb-ai.com` |
| **renlab 昵称** | **仅持仓库者** | GH `name`（空时回退 login）含 `renlab`，不分大小写 |

`githubCompliant(g, ownsTrackedRepo)`：
```
if (!login) return false
if (ownsTrackedRepo) { 需 公司邮箱 && renlab昵称 }
return true
```

**非仓库持有者**（从没建过 tracked 仓库，或已全部移交 anzy-renlab-ai）：只要有 login 就合规，私人邮箱 + 非 renlab 昵称都 OK。

**持仓库者无公司邮箱**的出路：① 账号设公司 Public email；② 或把仓库 ownership 移交 `anzy-renlab-ai`（移交后 owns_tracked_repo=false → 自动合规）。

`owns_tracked_repo` = login 命中 `github.config.json::selected_repos[].owner`，每日重算 → 谁新拿/移交仓库会自动切换要求。

---

## 2. 闭环：CC 工作 → 归档 → 重新纳管

```
某人 CC 干活，工作不属于任何 tracked GitHub 仓库（workboard unclustered）
  → 归档提醒发【操作人】：建个仓库归档（用公司邮箱账号 / 或建好移交 anzy-renlab-ai）
  → 他建仓库 + leader 加进 selected_repos
  → 工作被归档（退出 unclustered，aging 清零）
  → 每日合规检查重算 owns_tracked_repo=true
  → 若他过去是「无仓库免邮箱」的人，现在持仓库 → 自动触发公司邮箱/移交要求
```

「过去用私人邮箱、现在有了私人仓库」→ 系统自动把他拉回邮箱要求。

---

## 3. 升级节奏（所有规则，按工作日）

| 阶段 | 触发 | 收件人 |
|---|---|---|
| stage 1 | 首次 | 本人 / 操作人 / 仓库所属人 |
| stage 2 | +1 工作日未改 | 同上 |
| stage 3 | +1 工作日 | 同上（文案带警告）|
| stage 4 | +1 工作日 | + leader（戴昊然）抄送 |
| >4 | — | 停止 |

---

## 4. 代码地图

| 文件 | 职责 |
|---|---|
| `src/services/gh_compliance.ts` | 合规引擎 `runComplianceTick(opts)` — 算缺项、工作日节奏、4 级升级、leader 汇总。`last_run_date`(北京) gate 保证每天一次 |
| `src/services/refresh_roster.ts` | 每 30min 拉 Slack/CC/GH health，算 owns_tracked_repo + ok，写 roster + 派生 identity.json。开头 `clearRosterCache()` 防竞争 |
| `src/services/slack_socket.ts` | Socket Mode 入站 WS（员工 DM 回复进这里）。需 `SLACK_APP_TOKEN`(xapp-) |
| `src/services/slack_collection.ts` | `handleInboundDM` 收用户名 → 即时审核(拉 GH profile 核邮箱/昵称) → 写 roster + 回执（合规「搞定」/ 有问题列缺项）；`startCollection` 发问；无 pending 的回复按当前缺项软回应 |
| `src/services/leader_push.ts` | `notifyAgedUnattributed`(归档提醒，操作人 1-3 + leader 4)、`notifyExternalOwnerRepoIfNew`、anomaly/blocked 推送 |
| `src/services/repo_ownership.ts` | `findExternallyOwnedRepos`、`trackedRepoOwners()`(持仓库 owner 集) |
| `src/lib/team_roster.ts` | roster 读写 + `lookupBy*` + `emailSuffixOk`/`displayNameOk`/`githubCompliant` |
| `src/lib/workdays.ts` | `workingDaysBetween`/`isWorkingDay`（CST + holidays.json）|
| `src/services/monitor_loop.ts` | rosterTick 调 refreshRoster + runComplianceTick；启动 slack socket |

### 触发入口
```ts
runComplianceTick()                  // 自动（monitor 每 30min 调，每天真跑一次）
runComplianceTick({ seedOnly:true }) // 标记 stage 不发（手动 campaign 后防重复）
runComplianceTick({ force:true })    // 忽略每日/工作日 gate，立即发
```

---

## 5. 状态文件（`private/sync_state/`）

| 文件 | 内容 |
|---|---|
| `gh_compliance.json` | `{ entries:{[name]:{notify_count,last_notified_at}}, last_run_date }` |
| `slack_collection.json` | `{ pending:{[slackUserId]:{field,name,prompt,asked_at}} }` 待回 login |
| `unattributed_aging.json` | `{ entries:{[stableId]:{title,operator,first_seen,notify_count,last_notified_at}} }` 归档提醒 |
| `leader_push.json` | 已 DM 的 id+at，30d TTL |

---

## 6. roster schema（`private/team_roster.json`，SOT）

```jsonc
{
  "version": 2, "leader": "戴昊然",
  "members": [{
    "name", "status":"active|inactive|left", "joined_at", "left_at",
    "slack":  { "user_id","display_name","ok","checked_at" },
    "cc":     { "identifiers":[{kind:'email'|'machine',value}], "last_seen_at","ok" },
    "github": { "login","public_email","public_email_suffix_ok",
                "display_name","display_name_ok","owns_tracked_repo",
                "ok","issues":[...],"checked_at" }
  }]
}
```
`identity.json` 是派生产物（refreshRoster 覆写），别手改。账号对应表见 `docs/TEAM_ACCOUNTS.md`（自动生成）。

### 改 roster 正确姿势
```ts
import('./src/lib/team_roster').then(async m => {
  m.clearRosterCache();               // 必须，防竞争
  const r = await m.readRoster();
  r.members.find(p=>p.name==='X').github.login = 'xxx';
  await m.writeRoster(r);
});
// 然后 refreshRoster() 拉 GH profile + 重算 ok
```

---

## 7. 运维须知 / 已知坑

- **改了 refresh/compliance/roster/socket 相关代码必须重启 dev** — 长驻 monitor 单例持旧模块引用，Next dev 不热重载它，否则旧逻辑会覆盖新判定（典型症状：CLI 改完对，30min 后被 dev 写回错的）。
- **Slack DM 一律按 `slack.user_id` 发**，不按中文名（显示名常≠中文名：彭丞=Alex Peng、赵艺霖=艺霖、孙润峰 无显示名）。
- **Socket Mode 前置**：Slack app 后台需开 Socket Mode + Enable Events + 订阅 `message.im` + bot scope `im:history`，否则入站收不到（连上 socket 也没用）。App-Level Token(xapp-) 放 `.env::SLACK_APP_TOKEN`。
- **dev 启动**：中间件挡未登录，需一次 authed `/api/workboard` 命中才启 monitor_loop。账号 `admin / rocket-team`。
- **时间**：存储 UTC，展示一律北京时间。
- **离职**：`status='left'` → 全程排除合规/提醒。当前离职：尹海森、李博泽。

---

## 8. 当前状态（2026-05-25）

16 人（14 在职 + 2 离职）。全绿 **12/14**。

未绿 2（均持仓库缺公司邮箱，已 DM）：
- 李家乐 Upp-Ljl（Pace/d2p/Cairn）
- 刘师宇 LiuShiyuMath（front-simple-screen-monitor）

### 谜样仓库 owner（待认领，不在 16 人）
- `Veinsure-renlab-ai`（email liwx@nb-ai.com）
- `veiled-renlab-ai`（football_co_agent / video_making）
