import { NextRequest } from 'next/server';
import { llmJSON } from '@/lib/llm';
import type { TeamResource, ResourceType } from '@/types';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

interface ParseInput {
  raw: string; // pasted text or file content
}

interface ParseOutput {
  parsed: Partial<TeamResource>;
  confidence: number;
  notes?: string;
}

const VALID_TYPES: ResourceType[] = [
  'account', 'api_key', 'license', 'domain', 'subscription', 'cloud', 'cert', 'other'
];

export async function POST(req: NextRequest): Promise<Response> {
  let body: ParseInput = { raw: '' };
  try {
    body = (await req.json()) as ParseInput;
  } catch {
    return json({ error: 'invalid JSON' }, 400);
  }
  const raw = (body.raw ?? '').trim();
  if (!raw) return json({ error: 'raw text required' }, 400);

  let llmOut: Partial<TeamResource> & { credential_plaintext?: string } = {};
  try {
    llmOut = await llmJSON({
      system: `你是团队资源识别助手。从用户上传的文本（账号截图 OCR、密码本、邮件、聊天记录等）中识别一项团队资源（账号、API key、订阅、域名、证书）。

只输出 JSON。不确定不要乱填。

字段说明:
- type: account | api_key | license | domain | subscription | cloud | cert | other
- name: 简短中文名 (如 "公司 Gmail" / "OpenAI 生产 Key")
- vendor: 提供方 (Google / OpenAI / Apple / Cloudflare / Notion / 飞书 / ...)
- identifier: 可见标识 (账号名、key 前缀、域名、license seat ID 等，不含密码本身)
- credential_plaintext: 检测到的敏感凭证 (密码 / API key 完整字符串)。识别到才填，否则省略
- monthly_cost_cny: 月成本（人民币数字）
- expires_at: 到期日期 YYYY-MM-DD
- notes: 备注信息（登录方式、2FA、备注等）`,
      user: `请从以下原文中识别一项团队资源：

${raw.slice(0, 4000)}

输出 JSON。`,
      maxTokens: 800,
      temperature: 0.2,
      maxRetries: 1
    });
  } catch (err) {
    return json({ error: `解析失败: ${(err as Error).message}` }, 500);
  }

  // Sanitize.
  const out: ParseOutput['parsed'] = {};
  const credential = (llmOut as { credential_plaintext?: string }).credential_plaintext;
  if (typeof llmOut.type === 'string' && VALID_TYPES.includes(llmOut.type as ResourceType)) {
    out.type = llmOut.type as ResourceType;
  }
  if (typeof llmOut.name === 'string' && llmOut.name.trim()) out.name = llmOut.name.trim();
  if (typeof llmOut.vendor === 'string' && llmOut.vendor.trim()) out.vendor = llmOut.vendor.trim();
  if (typeof llmOut.identifier === 'string' && llmOut.identifier.trim()) out.identifier = llmOut.identifier.trim();
  if (typeof llmOut.monthly_cost_cny === 'number' && llmOut.monthly_cost_cny >= 0)
    out.monthly_cost_cny = llmOut.monthly_cost_cny;
  if (typeof llmOut.expires_at === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(llmOut.expires_at))
    out.expires_at = llmOut.expires_at;
  if (typeof llmOut.notes === 'string' && llmOut.notes.trim()) out.notes = llmOut.notes.trim();

  // confidence rough estimate based on field coverage.
  let filled = 0;
  if (out.type) filled++;
  if (out.name) filled++;
  if (out.vendor) filled++;
  if (out.identifier) filled++;
  const confidence = Math.min(1, filled / 3);

  return json({
    parsed: out,
    credential_plaintext: typeof credential === 'string' ? credential : undefined,
    confidence
  });
}

function json(data: unknown, status: number = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}
