import { AlertTriangle } from 'lucide-react';

export const metadata = { title: 'Settings · Rocket Team' };

export default function SettingsPage() {
  const minimaxKeySet = Boolean(process.env.MINIMAX_API_KEY);

  return (
    <div className="px-12 py-10 max-w-[900px] mx-auto">
      <div className="mb-8">
        <div className="eyebrow mb-2">Rocket Team / Settings</div>
        <h1 className="display-title">Settings</h1>
        <p className="prose-warm text-body text-ink-muted mt-3 max-w-2xl">Current state of model, sources, and permissions.</p>
      </div>

      {/* Reasoning model — flat, no card-in-card, no decorative icon */}
      <section className="mb-7">
        <div className="eyebrow mb-2">Reasoning model</div>
        <div className="rounded-xl border border-rule bg-paper-card p-5">
          <div className="flex items-baseline justify-between mb-1.5">
            <span className="font-serif text-[18px] text-ink">MiniMax-M2.7</span>
            <span
              className={`inline-flex items-center gap-1 text-[10.5px] px-1.5 py-0.5 rounded ${
                minimaxKeySet ? 'bg-forest/10 text-forest' : 'bg-rust/10 text-rust'
              }`}
            >
              <span className={`w-1.5 h-1.5 rounded-full ${minimaxKeySet ? 'bg-forest' : 'bg-rust'}`} />
              {minimaxKeySet ? 'Configured' : 'Not configured — system unavailable'}
            </span>
          </div>
          <p className="text-[12.5px] text-ink-muted leading-relaxed">
            PMA and every per-member profile agent call this model. OpenAI-compatible endpoint · default temperature 0.4 · output includes a{' '}
            <code className="font-mono text-ink">&lt;think&gt;</code> reflection block. Key is read from{' '}
            <code className="font-mono text-ink">MINIMAX_API_KEY</code> in <code className="font-mono text-ink">.env</code>.
          </p>
          {!minimaxKeySet && (
            <div className="mt-4 px-3 py-2.5 rounded-md bg-rust/10 border border-rust/30 text-[13px] text-ink-soft flex items-start gap-2">
              <AlertTriangle size={14} className="text-rust mt-0.5 shrink-0" />
              <div>
                No model key detected. Set <span className="font-mono">MINIMAX_API_KEY</span> in{' '}
                <span className="font-mono">.env</span> and restart.
              </div>
            </div>
          )}
        </div>
      </section>

      {/* Facts — plain label-value rows, no icon decoration, no cards */}
      <section>
        <div className="eyebrow mb-2">Current state</div>
        <dl className="rounded-xl border border-rule overflow-hidden divide-y divide-rule">
          <Row
            term="Sources"
            desc={
              <>
                Profiles are built from Meetings + the org chart under <code className="font-mono text-ink">team/context/</code>. After connecting Slack / GitHub in{' '}
                <a href="/sources" className="link-coral">Sources</a>, profiles evolve with real work signals.
              </>
            }
          />
          <Row term="Permissions" desc="Reassign rights, profile-update review thresholds, audit-log retention — opens once workspace roles ship in v1." />
          <Row
            term="Workspace"
            desc={
              <>
                Single workspace. Org chart is hard-coded in <code className="font-mono text-ink">team/context/org/组织架构.txt</code>. Multi-workspace and SSO ship in v1.
              </>
            }
          />
          <Row term="Known limits" desc="All data stored in local JSON files (no database). No auth. Minimum browser width 1024 px. Production hardening lands in v1." />
        </dl>
      </section>
    </div>
  );
}

function Row({ term, desc }: { term: string; desc: React.ReactNode }) {
  return (
    <div className="bg-paper-card px-5 py-3.5 flex flex-col md:flex-row md:items-baseline gap-1 md:gap-4">
      <dt className="text-[13px] font-serif text-ink shrink-0 md:w-24">{term}</dt>
      <dd className="text-[13px] text-ink-muted leading-relaxed">{desc}</dd>
    </div>
  );
}
