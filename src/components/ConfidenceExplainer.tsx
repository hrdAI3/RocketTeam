'use client';

import { useState } from 'react';
import { Info, X } from 'lucide-react';

interface ConfidenceExplainerProps {
  confidence: number;
  evidenceCount: number;
  trackAgree: boolean;
  converged: boolean;
}

// Click the confidence number to see how it was scored.
export function ConfidenceExplainer({
  confidence,
  evidenceCount,
  trackAgree,
  converged
}: ConfidenceExplainerProps) {
  const [open, setOpen] = useState(false);
  const pct = Math.round(confidence * 100);
  const color = pct >= 80 ? 'text-forest' : pct >= 65 ? 'text-coral' : 'text-amber';

  return (
    <div className="relative inline-block">
      <button
        onClick={() => setOpen((v) => !v)}
        className={`text-right group ${color}`}
        aria-label="How confidence is calculated"
      >
        <div className="font-serif text-[40px] leading-none flex items-baseline justify-end gap-1">
          {pct}
          <span className="text-[20px] text-ink-quiet">%</span>
          <Info
            size={11}
            className="ml-1 text-ink-quiet opacity-50 group-hover:opacity-100 transition-opacity"
          />
        </div>
        <div className="eyebrow mt-1">Confidence</div>
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-2 w-[360px] card-warm shadow-modal p-4 z-30 animate-fade-in text-left"
          onClick={(e) => e.stopPropagation()}
        >
          <header className="flex items-baseline justify-between mb-3">
            <h3 className="font-serif text-[15px] text-ink">How confidence is computed</h3>
            <button
              onClick={() => setOpen(false)}
              className="text-ink-quiet hover:text-ink"
              aria-label="Close"
            >
              <X size={14} />
            </button>
          </header>
          <p className="text-[12.5px] text-ink-muted leading-relaxed mb-3">
            Two simulation paths run independently. Four signals stack:
          </p>
          <ul className="space-y-2 mb-3">
            <Factor
              ok={trackAgree}
              label="Both paths point to the same top-1 candidate"
              detail={trackAgree ? 'Both paths agree' : 'Paths disagree → penalty'}
            />
            <Factor
              ok={converged}
              label="Round 3: everyone COMMITs or DEFERs, no OBJECT"
              detail={converged ? 'Converged' : 'Unresolved objection → penalty'}
            />
            <Factor
              ok={evidenceCount >= 5}
              label={`Evidence cited ≥ 5 (actual ${evidenceCount})`}
              detail={
                evidenceCount >= 5
                  ? 'Sufficient evidence'
                  : evidenceCount >= 3
                    ? 'Light evidence'
                    : 'Insufficient evidence → penalty'
              }
            />
            <Factor
              ok={pct >= 80}
              label="All signals satisfied at once"
              detail={pct >= 80 ? 'High confidence — safe to accept' : 'Medium confidence — confirm manually'}
            />
          </ul>
          <div className="pt-3 border-t border-rule-soft">
            <div className="flex items-baseline justify-between">
              <span className="text-caption text-ink-muted">Composite</span>
              <span className={`font-serif text-[24px] leading-none ${color}`}>{pct}%</span>
            </div>
          </div>
          <p className="text-[11px] text-ink-quiet mt-2 leading-relaxed">
            Note: scoring is rule-based, not free-form LLM scoring. Rule definitions in
            <span className="font-mono text-ink"> src/report/agent.ts:computeConfidence</span>.
          </p>
        </div>
      )}
    </div>
  );
}

function Factor({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <li className="flex items-start gap-2 text-[12.5px]">
      <span
        className={`w-3 h-3 rounded-full shrink-0 mt-1 ${
          ok ? 'bg-forest' : 'bg-amber'
        } flex items-center justify-center`}
      >
        <span
          className={`w-1 h-1 rounded-full ${ok ? 'bg-paper' : 'bg-ink/60'}`}
          aria-hidden
        />
      </span>
      <div>
        <div className="text-ink leading-snug">{label}</div>
        <div className="text-ink-quiet text-[11.5px] leading-snug">{detail}</div>
      </div>
    </li>
  );
}
