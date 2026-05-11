'use client';

interface ConfidenceRingProps {
  // 0-1 range
  value: number;
  size?: number;
}

export function ConfidenceRing({ value, size = 56 }: ConfidenceRingProps) {
  const v = Math.max(0, Math.min(1, value));
  const pct = Math.round(v * 100);
  return (
    <div className="relative shrink-0" style={{ width: size, height: size }}>
      <svg viewBox="0 0 36 36" className="w-full h-full">
        <circle cx="18" cy="18" r="15.9" fill="none" stroke="#E5E7EB" strokeWidth="2.4" />
        <circle
          cx="18"
          cy="18"
          r="15.9"
          fill="none"
          stroke="#6366F1"
          strokeWidth="2.4"
          strokeDasharray={`${pct}, 100`}
          strokeLinecap="round"
          transform="rotate(-90 18 18)"
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-body font-semibold text-text-primary">
        {pct}%
      </span>
    </div>
  );
}
