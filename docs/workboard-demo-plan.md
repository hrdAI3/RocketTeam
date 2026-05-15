# 开发方案：Workboard 演示版（项目级聚合 · 当前数据）

> 交付目标：把 `/status` 从「人为单位的 24 行 roster」改成「项目为单位的项目卡列表」，**只用当前已有数据**，能跑起来、能录演示视频。
> 这是远期方案（`team/UX-PROJECT-FIRST.md`）的一个**快速子集**——故意砍掉登记表 / 多信号匹配器 / 详情页 / Slack / 测试，只为快速出一版可视化。
> 实现 agent 注意：你没看过相关对话，本文自包含。先读「数据源事实」一节再动手。

---

## 0. 范围围栏（务必遵守）

**做**：
- 新建 `src/services/workboard.ts` —— 按 `WorkItem.repo` 字段把工作线聚合成项目
- 新建 `src/app/api/workboard/route.ts`
- 重写 `src/app/status/page.tsx` —— 渲染项目卡 + 未归类工作线 + 顶部异常区

**不做**（远期方案的内容，本次明确跳过）：
- ❌ 不做 `private/projects.json` 登记表 / 多信号匹配器（演示版直接按 `WorkItem.repo` 字符串分组）
- ❌ 不做 `/status/project/[id]` 详情页
- ❌ 不做 Slack push 改动
- ❌ 不做 sidebar 改名
- ❌ 不做单元测试
- ❌ 不做 `getEventBySeq` / 异常→项目归属算法（异常就按现状原样在顶部展示）
- ❌ 不动 `/api/cc-status`、`src/services/cc_status.ts`、`work_summary.ts`、`/status/[name]` 详情页

---

## 1. 数据源事实（先读懂这个）

数据来自 `src/services/cc_status.ts` 的 `getRosterView()`：

```ts
getRosterView(): Promise<{ roster: RosterRow[]; aggregate: TeamAggregate; anomalies: Anomaly[] }>
```

`RosterRow` 关键字段（定义在 `cc_status.ts:261`）：
```ts
{
  name: string;                  // 成员名
  resolved: boolean;
  anomalies: Array<{ id: string; rule: string; severity: 'act-now'|'next-glance'|'fyi' }>;
  lastSessionAt: string | null;  // ISO
  activityFlag: 'active'|'idle'|'dormant'|'never';
  currentRepo: string | null;
  workHint?: string;
  workItems?: Array<{
    title: string;
    status: '进行中' | '卡住' | '调研中' | '已完成';
    repo: string;                // ← 聚合主键。LLM 抽的短项目名，可能为 ''
  }>;
  live?: CcLiveSnapshot;
}
```

**关键事实**：
- `workItems` **只在 active/idle 的成员上才有**（`cc_status.ts:463-475` 决定），dormant/never 成员没有。
- `workItems` 的真实来源是 `private/cc_summary_cache.json`（`work_summary.ts` 的 LLM 摘要缓存）。
- **动手前先确认 `D:/hrdai/team/private/cc_summary_cache.json` 存在且非空**。若为空 → 演示页会是空的，立即停下来报告（解决办法是 `bun run sync` 拉数据，但需要 collector 8080 可达；或用 `private.example/` 占位数据——先确认哪种可行）。

参考：`src/app/api/cc-status/route.ts` 是 API route 的写法范例；`src/app/status/page.tsx`（即将被你重写的文件）是现有页面，里面有可复用的 Tailwind class 和 `WORK_DOT` 颜色映射。

---

## 2. `src/services/workboard.ts` —— 聚合逻辑

```ts
import { getRosterView } from './cc_status';

export interface DemoWorkItem {
  title: string;
  status: '进行中' | '卡住' | '调研中' | '已完成';
}
export interface ProjectCard {
  key: string;          // 归一化分组键（小写）
  name: string;         // 展示名
  workItems: DemoWorkItem[];   // 注意：不带 owner / 人名
  ccCount: number;             // 去重的成员数 = "N 个 CC"（匿名计数）
  lastActivityAt: string | null;
  status: '卡住' | '活跃' | '收尾' | '休眠';
}
export interface UnclusteredItem {
  title: string;
  status: '进行中' | '卡住' | '调研中' | '已完成';
}
export interface WorkboardView {
  projects: ProjectCard[];
  unclustered: UnclusteredItem[];
  anomalies: Awaited<ReturnType<typeof getRosterView>>['anomalies'];  // 原样透传
  aggregate: { totalProjects: number; stuck: number };
}

export async function getWorkboardView(): Promise<WorkboardView>;
```

**算法**：
1. `const { roster, anomalies } = await getRosterView();`
2. 遍历每个 `RosterRow`，对它每条 `workItems[i]`：收集成一条 `{ title, status, repo, ownerName: row.name, lastActivityAt: row.lastSessionAt }`。`workItems` 为空的行跳过。
3. 按 `repo` 分组：
   - 归一化键 = `repo.trim().toLowerCase()`
   - `repo.trim() === ''` 的条目 → 全部进 `unclustered`
4. 每个项目组：
   - `name` = 该组里出现频次最高的非空原始 `repo` 字符串（平票取最长）
   - `workItems` = 该组所有条目的 `{title, status}` —— **丢弃 ownerName**，不进 payload
   - `ccCount` = 该组里去重的 `ownerName` 数量
   - `lastActivityAt` = 该组所有条目 `lastActivityAt` 的最大值
   - `status` 见下
5. `projectStatus(items)` 规则（纯函数）：
   ```
   if (items 里有 ≥1 条 status === '卡住')           → '卡住'
       // 注：远期方案要求 ≥2 条防抖；演示版用 ≥1 让红卡片在视频里能出现，加注释说明
   const ongoing = items 里 status ∈ {进行中, 调研中}
   const done    = items 里 status === '已完成'
   if (ongoing.length === 0 && done.length > 0)        → '收尾'
   if (ongoing.length === 0)                           → '休眠'
   else                                                → '活跃'
   ```
6. `projects` 排序：卡住 → 活跃 → 收尾 → 休眠；同档内按 `lastActivityAt` 倒序。
7. `aggregate` = `{ totalProjects: projects.length, stuck: projects.filter(p => p.status === '卡住').length }`

**匿名性硬要求**：`ProjectCard` / `UnclusteredItem` 类型上**不能有任何成员姓名字段**。`ccCount` 在 service 内部算的时候用到 `ownerName`，但只输出 count。

---

## 3. `src/app/api/workboard/route.ts`

```ts
import { getWorkboardView } from '@/services/workboard';
export const dynamic = 'force-dynamic';
export async function GET(): Promise<Response> {
  return Response.json(await getWorkboardView());
}
```

---

## 4. `src/app/status/page.tsx` —— 重写

`'use client'`，结构自上而下：

### 4.1 Header
```
eyebrow: "Rocket Team / Workboard"
display-title: "Workboard"
副标: "项目维度看在做的事 · {N} 个项目在跑 · {K} 个卡住"   ← N/K 取自 aggregate
右侧: Refresh 按钮（复用现有 RefreshCw 图标 + 旋转 loading 态）
```

### 4.2 顶部异常区
原样渲染 `anomalies`（演示版**只读**——保留异常卡片样式，可以**去掉 Acknowledge/Dismiss 操作按钮**，少写代码。卡片配色沿用现有页面：act-now→rust 边框，next-glance→amber 边框）。无异常时显示现有的「Nothing needs your attention today」绿条。

### 4.3 项目卡列表（主视觉）
每张卡：
```
┌──────────────────────────────────────────┐
│ {name}                      {状态 badge} │   ← name 用 font-serif 大字
│ • {dot} {workItem.title}                 │   ← 每条工作线一行
│ • {dot} {workItem.title}                 │
│ • {dot} {workItem.title}                 │
│              {ccCount} 个 CC · 最近 {age}│   ← 卡底，匿名计数 + 相对时间
└──────────────────────────────────────────┘
```
- **工作线行只有 `dot + title`，绝对不出现任何人名。**
- 工作线 `dot` 颜色 = 复用现有 `WORK_DOT` 映射：`卡住→bg-amber`、`进行中→bg-coral`、`调研中→bg-ink-quiet`、`已完成→bg-forest`。
- 卡片超过 4 条工作线时，显示前 4 条 + 「+N 更多」。
- 项目状态 badge：`卡住`→红（`border-rust` + `text-rust` 或 rust 底白字）、`活跃`→coral、`收尾`→ink-quiet、`休眠`→ink-quiet。
- `卡住` 状态的卡片整体加红边框（`border-rust`），让它在视频里跳出来。
- 卡片容器复用现有 class：`rounded-xl border border-rule bg-paper-card`。
- `age` 格式复用现有页面的 `ageStr()` 函数（just now / Nm ago / Nh ago / Nd ago）。

### 4.4 未归类工作线区
标题 `eyebrow`: "未归类工作线"，副: "这些工作线还没归到具体项目"。
下面平铺每条 `{dot} {title}`，视觉权重和项目卡相当——**不要做成折叠抽屉、不要写 "orphaned" 字样**。

### 4.5 加载 / 错误 / 空态
- loading：骨架屏（复用现有页面 animate-pulse 写法）
- error：红框 + Retry（复用现有写法）
- 空（projects 和 unclustered 都空）：友好空态，提示「还没有工作线数据，跑 `bun run sync` 拉取」

### 4.6 数据获取
`fetch('/api/workboard', { cache: 'no-store' })`，60s 轮询刷新（复用现有页面的 setInterval 模式）。`document.title = 'Workboard · Rocket Team'`。

---

## 5. 验证（必做，这是要录视频的）

1. `cd D:/hrdai/team && bun run typecheck` —— 必须零错误
2. `bun run dev`，开 `http://localhost:3000/status`
3. 确认：
   - 项目卡渲染出来了，按状态排序
   - **卡片上任何位置都没有成员姓名**（只有 `N 个 CC`）
   - 卡住的项目有红边框
   - 未归类区平铺渲染
   - 顶部异常区正常
   - 浏览器 console 无报错
4. 若 `private/cc_summary_cache.json` 为空导致页面空白 —— **停下来报告**，附上你检查的结果和建议（跑 sync / 用 example 数据 / 造演示 fixture）。

---

## 6. 交付报告

完成后报告：
- 改了哪些文件
- `/status` 页面现在长什么样（截图或文字描述）
- 数据情况：有几个项目、几条工作线、几条未归类、数据是否够录一个像样的视频
- 任何为了「快速出片」做的妥协
- typecheck / dev server 状态
