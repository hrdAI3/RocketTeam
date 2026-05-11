// Prompts for the 2-phase bootstrap pipeline (eng review 5C).
//
// Phase 1 — for each meeting transcript, produce a structured per-member summary.
// Phase 2 — for each target member, combine all phase-1 summaries that mention
//           them into a final PersonalAgentProfile.
//
// Both phases ask for JSON output. We do not assume MiniMax / Anthropic
// tool-calling support — instead we ask for JSON in the user prompt and rely
// on llmJSON's parse + retry.

export const PHASE1_SYSTEM = `你是一个团队上下文分析助理。你的工作是从一份会议 transcript 中抽取与每个团队成员相关的事实信号。

只输出 JSON，不要解释，不要 markdown。`;

export function phase1UserPrompt(meetingFilename: string, meetingText: string, memberNames: string[]): string {
  // Truncate to keep token cost bounded. 12000 chars ≈ 4000–6000 token range
  // depending on Chinese density. Sufficient for a 1-hour standup transcript.
  const text = meetingText.slice(0, 12000);
  return `会议文件名：${meetingFilename}
团队成员列表（仅关注这些人）：
${memberNames.map((n) => `- ${n}`).join('\n')}

会议正文（截断到 12000 字符）：
"""
${text}
"""

任务：对每个团队成员，如果他/她在本次会议中被提及或发言，抽取以下信号。如果某成员在本会议中完全没有出现，则不要为他/她产生条目。

JSON 形如：
{
  "meeting": "${meetingFilename}",
  "per_member": {
    "<name>": {
      "spoke": true | false,
      "topics": ["..."],
      "responsibilities_mentioned": ["..."],
      "strengths_evidence": ["..."],
      "energy_or_state_signals": ["..."],
      "interaction_summary": "1-2 句中文描述这个人在本次会议里做了什么 / 体现了什么"
    }
  }
}

只输出 JSON 对象，不要解释。`;
}

export const PHASE2_SYSTEM = `你是一个团队成员 profile 抽取器。基于多份会议的 per-member 汇总，为指定成员产生一份结构化 PersonalAgentProfile。

只输出 JSON，不要解释，不要 markdown。`;

export function phase2UserPrompt(
  memberName: string,
  dept: string,
  role: string,
  joinDate: string | null,
  perMemberSummaries: Array<{ meeting: string; summary: unknown }>
): string {
  const summariesJSON = JSON.stringify(perMemberSummaries, null, 2);
  return `目标成员：${memberName}
部门：${dept}
职位：${role}
入职：${joinDate ?? '未知'}

跨多份会议的相关汇总（来自 phase 1 抽取）：
${summariesJSON}

任务：基于以上汇总，为 ${memberName} 生成一份完整的 personal agent profile。

要求：
- "name" 必须是 "${memberName}"
- "dept" 必须是 "${dept}"
- "role" 必须是 "${role}"
- "join_date" 是 "${joinDate ?? '未知'}" — 如未知保留 "未知" 字符串
- "current_load.active_tasks" 从 responsibilities_mentioned 推断（最多 3 个）
- "current_load.estimated_hours_left_this_week"：如果信号不够，必须输出 null（不要瞎猜）
- "current_load.blocked_on" 数组：如无明确阻塞写空数组
- "recent_topics" 数组：3-5 个 topics（不是会议名、是话题如 "中小商家 AI"、"产品方向"）
- "strengths_observed" 数组：2-4 项，每项格式 "from <会议简称>: <一句中文观察>"
- "energy_signal":
    "level" 必须是这 5 个值之一: "high" / "normal" / "low" / "burnt" / "unknown"
    "last_updated" 用当前 ISO 时间
    "evidence" 一句中文，引用具体会议
- "recent_interactions" 数组（最多 5 条）：每条 {ts, context, snippet}
- "_meta": {schema_version: 0, bootstrapped_at: <当前 ISO 时间>, evolution_count: 0, source_files: [<会议文件名>]}

JSON 形状（必须严格匹配）：
{
  "name": "${memberName}",
  "dept": "${dept}",
  "role": "${role}",
  "join_date": "${joinDate ?? '未知'}",
  "current_load": {
    "active_tasks": [],
    "estimated_hours_left_this_week": null,
    "blocked_on": []
  },
  "recent_topics": [],
  "strengths_observed": [],
  "energy_signal": {
    "level": "unknown",
    "last_updated": "",
    "evidence": ""
  },
  "recent_interactions": [],
  "_meta": {
    "schema_version": 0,
    "bootstrapped_at": "",
    "evolution_count": 0,
    "source_files": []
  }
}

只输出 JSON 对象，不要解释。`;
}
