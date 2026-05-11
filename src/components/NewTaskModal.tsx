'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react';
import { useRouter } from 'next/navigation';
import { ArrowUp, X, Sparkles, Check, Loader2 } from 'lucide-react';
import type { TaskBrief, QualityBar } from '@/types';

interface Ctx {
  open: () => void;
  close: () => void;
  isOpen: boolean;
}
const NewTaskCtx = createContext<Ctx | null>(null);

export function useNewTask() {
  const v = useContext(NewTaskCtx);
  if (!v) throw new Error('useNewTask must be inside NewTaskProvider');
  return v;
}

const SUGGESTIONS = [
  '5/20 之前要交付招聘官网首屏改版，对外用，估计 2 人天，谁来牵头？',
  '下周三北京客户来访，谁去对接？需要准备产品 demo + 方案 PPT',
  'iOS 包被苹果拒审，谁排查 + 重新提交？预计 1 天搞定',
  '5/20 是各产品小组的迭代死线，谁负责协调日程 + 节奏？'
];

export function NewTaskProvider({ children }: { children: React.ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'n') {
        e.preventDefault();
        setIsOpen(true);
      }
      if (e.key === 'Escape') setIsOpen(false);
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  const ctx = useMemo<Ctx>(() => ({ open, close, isOpen }), [open, close, isOpen]);

  return (
    <NewTaskCtx.Provider value={ctx}>
      {children}
      {isOpen && <NewTaskFloating onClose={close} />}
    </NewTaskCtx.Provider>
  );
}

type ChatTurn =
  | { role: 'user'; content: string }
  | { role: 'system'; content: string }
  | { role: 'recognition'; brief: Partial<TaskBrief> }
  | { role: 'question'; prompt: string };

interface NextQuestion {
  field: keyof TaskBrief;
  prompt: string;
  field_type: 'date' | 'number' | 'select' | 'boolean';
  options?: string[];
}

interface ParseResult {
  extracted: Partial<TaskBrief>;
  missing_required: Array<keyof TaskBrief>;
  next_question?: NextQuestion;
  ready_to_submit: boolean;
}

const FIELD_LABEL: Record<keyof TaskBrief, string> = {
  description: '任务描述',
  deadline: '截止日期',
  start_at: '起始日期',
  estimated_effort_days: '预估工作量',
  quality_bar: '质量等级',
  importance: '重要程度',
  urgency: '紧急程度',
  dependencies: '依赖',
  inputs_ready: '物料是否就绪',
  failure_cost: '错过死线的代价',
  stakeholders: '相关干系人',
  task_kind: '任务性质',
  ai_eligibility: 'AI 适合度',
  collab_topology: '协作形态',
  required_skills: '所需技能'
};

const QUALITY_LABEL: Record<QualityBar, string> = {
  demo: 'Demo · 内部演示',
  internal: '内部交付 · 团队使用',
  external: '对外交付 · 客户 / 公开'
};

const IMPORTANCE_LABEL: Record<'high' | 'low', string> = {
  high: '重要 · 影响业务 / 战略级',
  low: '不重要 · 常规优化 / nice-to-have'
};

const URGENCY_LABEL: Record<'high' | 'low', string> = {
  high: '紧急 · 3 天内或 hard 死线',
  low: '不紧急 · 1+ 周或排期内'
};

function NewTaskFloating({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const [phase, setPhase] = useState<'init' | 'qa' | 'submitting'>('init');
  const [initialText, setInitialText] = useState('');
  const [brief, setBrief] = useState<Partial<TaskBrief>>({});
  const [chat, setChat] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState('');
  const [pendingQ, setPendingQ] = useState<NextQuestion | null>(null);
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState<Array<keyof TaskBrief>>([]);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [phase, pendingQ]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [chat, parsing]);

  const callParse = useCallback(
    async (description: string, prior: Partial<TaskBrief>, userAnswer?: string, awaitingField?: keyof TaskBrief) => {
      setParsing(true);
      setError(null);
      try {
        const res = await fetch('/api/tasks/parse', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            description,
            prior,
            user_answer: userAnswer,
            awaiting_field: awaitingField
          })
        });
        if (!res.ok) {
          const e = (await res.json().catch(() => ({}))) as { error?: string };
          throw new Error(e.error ?? `parse failed ${res.status}`);
        }
        return (await res.json()) as ParseResult;
      } finally {
        setParsing(false);
      }
    },
    []
  );

  const startConversation = async () => {
    const desc = initialText.trim();
    if (!desc) return;
    setPhase('qa');
    setChat([{ role: 'user', content: desc }]);

    try {
      const r = await callParse(desc, {});
      setBrief(r.extracted);
      setMissing(r.missing_required);

      // Compose system summary turn: what was extracted + ask next
      // Render parse result and question as SEPARATE bubbles for legibility.
      const turns: ChatTurn[] = [];
      const hasRecognition = Object.keys(r.extracted).filter((k) => k !== 'description').length > 0;
      if (hasRecognition) {
        turns.push({ role: 'recognition', brief: r.extracted });
      } else {
        turns.push({ role: 'system', content: '收到任务描述。' });
      }
      if (r.ready_to_submit) {
        turns.push({ role: 'system', content: '所有必要信息已经齐全。可以启动推演，也可以继续补充任何细节。' });
      } else if (r.next_question?.prompt) {
        turns.push({ role: 'question', prompt: r.next_question.prompt });
      }
      setChat((c) => [...c, ...turns]);
      setPendingQ(r.ready_to_submit ? null : r.next_question ?? null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const handleAnswer = async (rawAnswer: string) => {
    const ans = rawAnswer.trim();
    if (!ans) return;
    setChat((c) => [...c, { role: 'user', content: ans }]);
    setInput('');
    try {
      const awaitingField = pendingQ?.field;
      const r = await callParse(initialText, brief, ans, awaitingField);
      setBrief(r.extracted);
      setMissing(r.missing_required);

      const turns: ChatTurn[] = [];
      const hasNew = Object.keys(r.extracted).some(
        (k) =>
          k !== 'description' &&
          (r.extracted as Record<string, unknown>)[k] !==
            (brief as Record<string, unknown>)[k]
      );
      if (hasNew) {
        turns.push({ role: 'recognition', brief: r.extracted });
      }
      if (r.ready_to_submit) {
        turns.push({
          role: 'system',
          content: '所有必要信息已经齐全。可以启动推演，也可以继续补充任何细节。'
        });
      } else if (r.next_question?.prompt) {
        turns.push({ role: 'question', prompt: r.next_question.prompt });
      }
      setChat((c) => [...c, ...turns]);
      setPendingQ(r.ready_to_submit ? null : r.next_question ?? null);
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const submit = async () => {
    if (missing.length > 0 || !brief.description) return;
    setPhase('submitting');
    setError(null);
    try {
      const res = await fetch('/api/sim/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(brief)
      });
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(e.error ?? `请求失败 ${res.status}`);
      }
      const data = (await res.json()) as { sim_id: string; task_id: string };
      onClose();
      router.push(`/live/${data.sim_id}`);
    } catch (err) {
      setError((err as Error).message);
      setPhase('qa');
    }
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end md:items-center justify-center bg-ink/30 backdrop-blur-sm animate-fade-in"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="w-full md:max-w-2xl mx-auto card-warm shadow-modal md:rounded-2xl rounded-t-2xl border border-rule animate-slide-up flex flex-col max-h-[90vh]"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-rule-soft shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-7 h-7 rounded-lg bg-coral text-white flex items-center justify-center">
              <Sparkles size={14} strokeWidth={2.4} />
            </div>
            <div>
              <div className="font-serif text-[16px] text-ink leading-tight">新建任务</div>
              <div className="text-[11px] text-ink-quiet leading-tight">
                {phase === 'init'
                  ? '描述清楚，PMA 会推演谁最合适'
                  : '系统会确认信息齐全后启动推演'}
              </div>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-ink-quiet hover:text-ink p-1"
            aria-label="关闭"
          >
            <X size={16} />
          </button>
        </header>

        {phase === 'init' && (
          <div className="px-5 py-4 overflow-y-auto">
            <div className="bg-paper-card border border-rule rounded-xl px-4 py-3 mb-3 focus-within:border-coral-mute focus-within:ring-1 focus-within:ring-coral-mute/40 transition-all">
              <textarea
                ref={inputRef}
                rows={3}
                value={initialText}
                onChange={(e) => setInitialText(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                    e.preventDefault();
                    void startConversation();
                  }
                }}
                placeholder="描述一个任务，例如：5/20 评审会需要 PPT + demo 视频，对外交付，预计 2 人天，谁来负责？"
                className="w-full bg-transparent font-serif text-[16px] leading-relaxed text-ink outline-none resize-none placeholder:text-ink-quiet"
              />
              <div className="flex items-center justify-between pt-2 mt-2 border-t border-rule-soft">
                <span className="text-[11px] text-ink-quiet">
                  <kbd className="font-mono text-[10px] px-1 py-0.5 bg-paper-deep border border-rule rounded">
                    ⌘ Enter
                  </kbd>{' '}
                  开始
                </span>
                <button
                  onClick={() => void startConversation()}
                  disabled={!initialText.trim()}
                  className="w-9 h-9 rounded-full bg-coral text-white flex items-center justify-center disabled:bg-paper-deep disabled:text-ink-quiet hover:bg-coral-deep transition-colors"
                  aria-label="开始"
                >
                  <ArrowUp size={16} strokeWidth={2.6} />
                </button>
              </div>
            </div>
            <div className="space-y-1.5 mt-3">
              <div className="eyebrow">近期典型任务</div>
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => setInitialText(s)}
                  className="w-full text-left text-[13.5px] text-ink-soft hover:text-ink hover:bg-paper-subtle rounded-md px-3 py-2 transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        {phase !== 'init' && (
          <>
            {/* Brief summary chip strip */}
            <BriefStrip brief={brief} missing={missing} />

            <div ref={scrollRef} className="flex-1 overflow-y-auto px-5 py-3 space-y-3">
              {chat.map((t, i) => (
                <ChatBubble key={i} turn={t} />
              ))}
              {error && (
                <div className="text-caption text-rust px-3 py-2 bg-rust/5 border border-rust/30 rounded-md">
                  {error}
                </div>
              )}
            </div>

            <div className="px-5 py-3 border-t border-rule-soft shrink-0">
              {parsing ? (
                <div className="flex items-center justify-between gap-3">
                  <span className="text-[13px] text-ink-quiet inline-flex items-center gap-1.5">
                    <Loader2 size={13} className="animate-spin" /> 解析中…
                  </span>
                  <button disabled className="btn-coral inline-flex items-center gap-1.5 opacity-60">
                    启动推演 →
                  </button>
                </div>
              ) : missing.length === 0 ? (
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[13px] text-forest inline-flex items-center gap-1.5">
                      <Check size={13} /> 必要信息已齐全 · 也可继续补充
                    </span>
                    <button
                      onClick={() => void submit()}
                      disabled={phase === 'submitting'}
                      className="btn-coral inline-flex items-center gap-1.5"
                    >
                      {phase === 'submitting' ? '启动中…' : '启动推演 →'}
                    </button>
                  </div>
                  <AnswerField
                    placeholder="补充其他细节、修改之前的信息…（可选，回车发送）"
                    value={input}
                    onChange={setInput}
                    onSubmit={() => void handleAnswer(input)}
                    inputRef={inputRef}
                    disabled={parsing}
                  />
                </div>
              ) : pendingQ ? (
                <AnswerField
                  placeholder={pendingQ.prompt}
                  value={input}
                  onChange={setInput}
                  onSubmit={() => void handleAnswer(input)}
                  inputRef={inputRef}
                  disabled={parsing}
                />
              ) : (
                <div className="text-caption text-ink-quiet">等待…</div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function ChatBubble({ turn }: { turn: ChatTurn }) {
  if (turn.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap bg-coral text-white rounded-br-sm font-sans">
          {turn.content}
        </div>
      </div>
    );
  }
  if (turn.role === 'recognition') {
    return (
      <div className="flex justify-start">
        <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-paper-subtle border border-rule p-3.5">
          <div className="eyebrow mb-2 text-coral">已识别</div>
          <RecognitionList brief={turn.brief} />
        </div>
      </div>
    );
  }
  if (turn.role === 'question') {
    return (
      <div className="flex justify-start">
        <div className="max-w-[85%] rounded-2xl rounded-bl-sm bg-coral-subtle/60 border border-coral-mute px-3.5 py-2.5 text-[14px] leading-relaxed font-serif text-ink">
          {turn.prompt}
        </div>
      </div>
    );
  }
  // system fallback
  return (
    <div className="flex justify-start">
      <div className="max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[14px] leading-relaxed whitespace-pre-wrap bg-paper-subtle text-ink-soft rounded-bl-sm font-serif">
        {turn.content}
      </div>
    </div>
  );
}

function RecognitionList({ brief }: { brief: Partial<TaskBrief> }) {
  const items: Array<{ label: string; value: string }> = [];
  if (brief.deadline) items.push({ label: '截止', value: brief.deadline });
  if (brief.start_at) items.push({ label: '起始', value: brief.start_at });
  if (typeof brief.estimated_effort_days === 'number')
    items.push({ label: '工作量', value: `${brief.estimated_effort_days} 人天` });
  if (brief.quality_bar)
    items.push({ label: '质量', value: QUALITY_LABEL[brief.quality_bar] });
  if (brief.importance)
    items.push({ label: '重要性', value: brief.importance === 'high' ? '重要' : '不重要' });
  if (brief.urgency)
    items.push({ label: '紧急度', value: brief.urgency === 'high' ? '紧急' : '不紧急' });
  if (brief.failure_cost)
    items.push({ label: '死线性质', value: brief.failure_cost === 'hard' ? '硬死线' : '软死线' });
  if (brief.inputs_ready === true) items.push({ label: '物料', value: '已就绪' });
  if (brief.inputs_ready === false) items.push({ label: '物料', value: '需先调研' });
  if (brief.stakeholders?.length)
    items.push({ label: '干系人', value: brief.stakeholders.join('、') });
  return (
    <ul className="space-y-1.5">
      {items.map((it, i) => (
        <li key={i} className="flex items-baseline gap-2 text-[13.5px]">
          <span className="text-ink-quiet shrink-0 min-w-[60px]">{it.label}</span>
          <span className="font-serif text-ink leading-snug">{it.value}</span>
        </li>
      ))}
    </ul>
  );
}

function BriefStrip({
  brief,
  missing
}: {
  brief: Partial<TaskBrief>;
  missing: Array<keyof TaskBrief>;
}) {
  const REQUIRED: Array<keyof TaskBrief> = [
    'deadline',
    'estimated_effort_days',
    'quality_bar',
    'importance',
    'urgency'
  ];
  return (
    <div className="px-5 py-2.5 border-b border-rule-soft bg-paper-subtle/40 flex flex-wrap gap-1.5">
      {REQUIRED.map((f) => {
        // Filled = the brief actually has a value for this field. Avoids the
        // initial "all green" flash when missing[] starts empty before parser ran.
        const v = (brief as Record<string, unknown>)[f];
        const filled = v !== undefined && v !== null && v !== '' && !missing.includes(f);
        return (
          <span
            key={f}
            className={`inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full ${
              filled
                ? 'bg-forest/10 text-forest border border-forest/30'
                : 'bg-paper-card text-ink-quiet border border-rule border-dashed'
            }`}
          >
            {filled ? <Check size={9} strokeWidth={3} /> : <span className="w-1 h-1 rounded-full bg-ink-quiet" />}
            {FIELD_LABEL[f]}
            {filled && v !== undefined && <span className="text-ink ml-0.5">: {formatVal(f, v)}</span>}
          </span>
        );
      })}
    </div>
  );
}

function AnswerField({
  placeholder,
  value,
  onChange,
  onSubmit,
  inputRef,
  disabled
}: {
  placeholder: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  inputRef: React.RefObject<HTMLTextAreaElement>;
  disabled: boolean;
}) {
  return (
    <div className="flex items-end gap-2">
      <textarea
        ref={inputRef}
        rows={1}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
            e.preventDefault();
            onSubmit();
          }
        }}
        placeholder={placeholder}
        disabled={disabled}
        className="flex-1 bg-paper-card border border-rule rounded-md px-3 py-2 text-[13.5px] text-ink outline-none resize-none focus:border-coral-mute"
      />
      <button
        onClick={onSubmit}
        disabled={!value.trim() || disabled}
        className="w-8 h-8 rounded-full bg-coral text-white flex items-center justify-center disabled:bg-paper-deep disabled:text-ink-quiet"
      >
        <ArrowUp size={14} strokeWidth={2.6} />
      </button>
    </div>
  );
}

function describeExtracted(b: Partial<TaskBrief>): string {
  const parts: string[] = [];
  if (b.deadline) parts.push(`· 截止 ${b.deadline}`);
  if (b.start_at) parts.push(`· 起始 ${b.start_at}`);
  if (typeof b.estimated_effort_days === 'number') parts.push(`· 约 ${b.estimated_effort_days} 人天`);
  if (b.quality_bar) parts.push(`· ${QUALITY_LABEL[b.quality_bar]}`);
  if (b.importance) parts.push(`· ${b.importance === 'high' ? '重要' : '不重要'}`);
  if (b.urgency) parts.push(`· ${b.urgency === 'high' ? '紧急' : '不紧急'}`);
  if (b.failure_cost) parts.push(`· ${b.failure_cost === 'hard' ? '硬死线' : '软死线'}`);
  if (b.inputs_ready === true) parts.push('· 物料已就绪');
  if (b.inputs_ready === false) parts.push('· 需先调研');
  if (b.stakeholders?.length) parts.push(`· 干系人: ${b.stakeholders.join('、')}`);
  return parts.join('\n');
}

function formatVal(field: keyof TaskBrief, v: unknown): string {
  if (field === 'quality_bar' && typeof v === 'string') {
    return QUALITY_LABEL[v as QualityBar] ?? v;
  }
  if (field === 'importance' && (v === 'high' || v === 'low')) {
    return v === 'high' ? '重要' : '不重要';
  }
  if (field === 'urgency' && (v === 'high' || v === 'low')) {
    return v === 'high' ? '紧急' : '不紧急';
  }
  if (field === 'estimated_effort_days' && typeof v === 'number') return `${v} 人天`;
  if (Array.isArray(v)) return v.join('、');
  if (typeof v === 'boolean') return v ? '是' : '否';
  return String(v);
}
