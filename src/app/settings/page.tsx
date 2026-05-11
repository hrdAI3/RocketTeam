import { Cog, Cpu, Database, Lock, AlertTriangle } from 'lucide-react';

export default function SettingsPage() {
  const minimaxKeySet = Boolean(process.env.MINIMAX_API_KEY);

  return (
    <div className="px-12 py-10 max-w-[1100px] mx-auto">
      <div className="mb-8">
        <div className="eyebrow mb-1">Rocket Team / 设置</div>
        <h1 className="display-title">设置</h1>
        <p className="prose-warm text-body text-ink-muted mt-3 max-w-2xl">
          模型、数据源、权限的当前状态。
        </p>
      </div>

      <section className="mb-6">
        <div className="card-surface p-5">
          <header className="flex items-start gap-3 mb-4">
            <div className="w-9 h-9 rounded-md bg-paper-subtle flex items-center justify-center text-ink-muted shrink-0">
              <Cpu size={18} />
            </div>
            <div>
              <h2 className="font-serif text-[18px] text-ink leading-tight">推理模型</h2>
              <p className="text-caption text-ink-quiet mt-0.5">
                PMA 与每位成员的画像 agent 都调用此模型
              </p>
            </div>
          </header>

          <div className="rounded-lg bg-paper-subtle/60 border border-rule-soft p-4">
            <div className="flex items-baseline justify-between mb-1">
              <span className="font-serif text-[18px] text-ink">MiniMax-M2.7</span>
              <span
                className={`inline-flex items-center gap-1 text-[10.5px] px-1.5 py-0.5 rounded ${
                  minimaxKeySet ? 'bg-forest/10 text-forest' : 'bg-rust/10 text-rust'
                }`}
              >
                <span className={`w-1.5 h-1.5 rounded-full ${minimaxKeySet ? 'bg-forest' : 'bg-rust'}`} />
                {minimaxKeySet ? '已配置' : '未配置 — 系统不可用'}
              </span>
            </div>
            <p className="text-[12.5px] text-ink-muted leading-relaxed">
              OpenAI 兼容端点 · 默认 temperature 0.4 · 推理模型，输出含 <code className="font-mono text-ink">&lt;think&gt;</code> 反思块。
              密钥从 <span className="font-mono text-ink">.env</span> 中的 <span className="font-mono text-ink">MINIMAX_API_KEY</span> 读取。
            </p>
          </div>

          {!minimaxKeySet && (
            <div className="mt-4 px-3 py-2.5 rounded-md bg-rust/10 border border-rust/30 text-[13px] text-ink-soft flex items-start gap-2">
              <AlertTriangle size={14} className="text-rust mt-0.5 shrink-0" />
              <div>
                未检测到模型密钥。请在 <span className="font-mono">.env</span> 中填
                <span className="font-mono"> MINIMAX_API_KEY</span> 后重启。
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="grid grid-cols-2 gap-4 mb-6">
        <Card
          icon={Database}
          title="数据源"
          body={
            <>
              当前画像来自 <span className="font-mono text-ink">team/context/</span> 中的 10 份会议纪要 + 组织架构。
              在 <a href="/sources" className="link-coral mx-1">数据接入</a>页连接 Slack / GitHub
              后，画像会随真实工作流持续演化。
            </>
          }
        />
        <Card
          icon={Lock}
          title="权限"
          body="改派权、画像更新审核阈值、审计日志保留期 —— v1 上线工作区角色后开放。"
        />
        <Card
          icon={Cog}
          title="工作区"
          body={
            <>
              单工作区。组织架构硬编码在
              <span className="font-mono text-ink"> team/context/org/组织架构.txt</span>
              。多工作区与 SSO 在 v1。
            </>
          }
        />
        <Card
          icon={AlertTriangle}
          title="已知限制"
          body="所有数据存在本地 JSON 文件中（无数据库）；无身份认证；浏览器最低宽度 1024px。生产化在 v1 完成。"
        />
      </section>

    </div>
  );
}

function Card({ icon: Icon, title, body }: { icon: typeof Cog; title: string; body: React.ReactNode }) {
  return (
    <div className="card-surface p-4">
      <header className="flex items-center gap-2 mb-2">
        <Icon size={14} className="text-coral" strokeWidth={2.4} />
        <h3 className="font-serif text-[16px] text-ink">{title}</h3>
      </header>
      <p className="text-caption text-ink-muted leading-relaxed">{body}</p>
    </div>
  );
}
