// Parses Report Agent's 4-section rationale into structured fields.
// Format: 推荐: ...\n论据: ...\n分歧: ...\n风险: ...
// Tolerant to extra spacing, missing sections, or unstructured text.

import { Sparkles, Anchor, GitBranch, AlertTriangle } from 'lucide-react';

export interface ParsedRationale {
  pick?: string;
  evidence?: string;
  divergence?: string;
  risks?: string;
  raw?: string; // Falls back to raw text if no structure detected
}

const FIELD_PATTERNS: Array<[keyof ParsedRationale, RegExp]> = [
  ['pick', /^\s*(?:推荐|结论)[:：]\s*(.+)$/m],
  ['evidence', /^\s*(?:论据|证据|依据)[:：]\s*(.+)$/m],
  ['divergence', /^\s*(?:分歧|差异)[:：]\s*(.+)$/m],
  ['risks', /^\s*(?:风险|隐患)[:：]\s*(.+)$/m]
];

export function parseRationale(text: string): ParsedRationale {
  if (!text) return {};
  const out: ParsedRationale = {};
  let matched = false;
  for (const [key, pat] of FIELD_PATTERNS) {
    const m = text.match(pat);
    if (m && m[1]) {
      out[key] = m[1].trim();
      matched = true;
    }
  }
  if (!matched) out.raw = text.trim();
  return out;
}

export function RationaleBlock({ text, skipPick = false }: { text: string; skipPick?: boolean }) {
  const r = parseRationale(text);

  if (r.raw) {
    return (
      <p className="font-serif text-[14.5px] leading-relaxed text-ink whitespace-pre-wrap">
        {r.raw}
      </p>
    );
  }

  return (
    <div className="space-y-2.5">
      {!skipPick && r.pick && (
        <Section icon={<Sparkles size={12} />} label="Recommend" tone="coral" body={r.pick} />
      )}
      {r.evidence && <Section icon={<Anchor size={12} />} label="Key evidence" tone="ink" body={r.evidence} />}
      {r.divergence && <Section icon={<GitBranch size={12} />} label="Path divergence" tone="muted" body={r.divergence} />}
      {r.risks && <Section icon={<AlertTriangle size={12} />} label="Risks" tone="amber" body={r.risks} />}
    </div>
  );
}

function Section({
  icon,
  label,
  tone,
  body
}: {
  icon: React.ReactNode;
  label: string;
  tone: 'coral' | 'ink' | 'muted' | 'amber';
  body: string;
}) {
  const headColor =
    tone === 'coral'
      ? 'text-coral'
      : tone === 'amber'
        ? 'text-amber'
        : tone === 'muted'
          ? 'text-ink-muted'
          : 'text-ink';
  return (
    <div className="flex items-start gap-2.5">
      <div className={`mt-0.5 shrink-0 ${headColor}`} aria-hidden>
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <span className={`eyebrow ${headColor}`}>{label}</span>
        <p className="font-serif text-[14px] leading-relaxed text-ink mt-0.5">{body}</p>
      </div>
    </div>
  );
}
