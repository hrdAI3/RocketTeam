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
        aria-label="置信度计算说明"
      >
        <div className="font-serif text-[40px] leading-none flex items-baseline justify-end gap-1">
          {pct}
          <span className="text-[20px] text-ink-quiet">%</span>
          <Info
            size={11}
            className="ml-1 text-ink-quiet opacity-50 group-hover:opacity-100 transition-opacity"
          />
        </div>
        <div className="eyebrow mt-1">置信度</div>
      </button>

      {open && (
        <div
          className="absolute right-0 top-full mt-2 w-[360px] card-warm shadow-modal p-4 z-30 animate-fade-in text-left"
          onClick={(e) => e.stopPropagation()}
        >
          <header className="flex items-baseline justify-between mb-3">
            <h3 className="font-serif text-[15px] text-ink">置信度怎么算的</h3>
            <button
              onClick={() => setOpen(false)}
              className="text-ink-quiet hover:text-ink"
              aria-label="关闭"
            >
              <X size={14} />
            </button>
          </header>
          <p className="text-[12.5px] text-ink-muted leading-relaxed mb-3">
            两条推演路径独立跑完，按下面四个信号叠加：
          </p>
          <ul className="space-y-2 mb-3">
            <Factor
              ok={trackAgree}
              label="推演结果指向同一 top1 候选人"
              detail={trackAgree ? '两路径选了同一人' : '两路径分歧 → 扣分'}
            />
            <Factor
              ok={converged}
              label="第 3 轮所有人 COMMIT 或 DEFER，无 OBJECT"
              detail={converged ? '已收敛' : '有反对未消解 → 扣分'}
            />
            <Factor
              ok={evidenceCount >= 5}
              label={`引用证据 ≥ 5 条（实际 ${evidenceCount}）`}
              detail={
                evidenceCount >= 5
                  ? '证据充分'
                  : evidenceCount >= 3
                    ? '证据偏少'
                    : '证据严重不足 → 扣分'
              }
            />
            <Factor
              ok={pct >= 80}
              label="所有信号同时满足"
              detail={pct >= 80 ? '可信度高，建议直接采纳' : '可信度中等，建议人工确认'}
            />
          </ul>
          <div className="pt-3 border-t border-rule-soft">
            <div className="flex items-baseline justify-between">
              <span className="text-caption text-ink-muted">本次综合</span>
              <span className={`font-serif text-[24px] leading-none ${color}`}>{pct}%</span>
            </div>
          </div>
          <p className="text-[11px] text-ink-quiet mt-2 leading-relaxed">
            注：当前打分是规则化的，不是 LLM 自由打分。规则定义见
            <span className="font-mono text-ink"> src/report/agent.ts:computeConfidence</span>。
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
