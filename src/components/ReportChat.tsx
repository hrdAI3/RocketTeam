'use client';

import { useEffect, useRef, useState } from 'react';
import { Send, MessageSquare, X } from 'lucide-react';
import { cn } from './utils';
import { SUGGESTED_QUESTIONS } from '@private/source-data/suggested-questions';

interface Turn {
  role: 'user' | 'report_agent';
  content: string;
  ts: string;
}

interface ReportChatProps {
  sim_id: string;
  task_id?: string;
}

export function ReportChat({ sim_id, task_id }: ReportChatProps) {
  const [open, setOpen] = useState(false);
  const [history, setHistory] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
  const [streamBuffer, setStreamBuffer] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [history, streamBuffer]);

  const send = async (q: string) => {
    const question = q.trim();
    if (!question || streaming) return;
    setInput('');
    const userTurn: Turn = { role: 'user', content: question, ts: new Date().toISOString() };
    setHistory((h) => [...h, userTurn]);
    setStreaming(true);
    setStreamBuffer('');

    try {
      const res = await fetch('/api/report/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sim_id,
          task_id,
          question,
          history: [...history, userTurn].map((h) => ({ role: h.role, content: h.content }))
        })
      });
      if (!res.ok || !res.body) throw new Error(`request failed: ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let accumulated = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          let event = 'message';
          let data = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('event: ')) event = line.slice(7).trim();
            else if (line.startsWith('data: ')) data += line.slice(6);
          }
          if (!data) continue;
          try {
            const parsed = JSON.parse(data) as Record<string, unknown>;
            if (event === 'token') {
              accumulated += (parsed.token as string) ?? '';
              setStreamBuffer(accumulated);
            } else if (event === 'done') {
              const finalContent = (parsed.content as string) ?? accumulated;
              setHistory((h) => [
                ...h,
                { role: 'report_agent', content: finalContent, ts: new Date().toISOString() }
              ]);
              setStreamBuffer('');
            } else if (event === 'error') {
              throw new Error((parsed.error as string) ?? 'chat error');
            }
          } catch (parseErr) {
            console.error('[chat sse]', parseErr);
          }
        }
      }
    } catch (err) {
      setHistory((h) => [
        ...h,
        {
          role: 'report_agent',
          content: `[error] ${(err as Error).message}`,
          ts: new Date().toISOString()
        }
      ]);
    } finally {
      setStreaming(false);
    }
  };

  return (
    <>
      <button
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'fixed bottom-6 right-6 z-40 rounded-full shadow-modal transition-all flex items-center gap-2 px-4 py-3',
          open ? 'bg-ink text-paper' : 'bg-coral text-white hover:bg-coral-deep'
        )}
        aria-label={open ? 'Close chat' : 'Ask Report Agent'}
      >
        {open ? (
          <>
            <X size={16} />
            <span className="text-[12px]">Close</span>
          </>
        ) : (
          <>
            <MessageSquare size={16} />
            <span className="font-medium text-[13px]">Ask Report Agent</span>
          </>
        )}
      </button>

      {open && (
        <div className="fixed bottom-24 right-6 z-40 w-[420px] h-[560px] card-warm shadow-modal flex flex-col overflow-hidden animate-fade-in">
          <header className="px-4 py-3 border-b border-rule flex items-center justify-between">
            <div>
              <div className="font-serif text-[15px] text-ink">Report Agent</div>
              <div className="text-[10px] font-mono text-ink-quiet">Simulation · {sim_id.slice(-8)}</div>
            </div>
          </header>

          <div ref={containerRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
            {history.length === 0 && (
              <div className="space-y-3 animate-fade-in">
                <p className="font-serif text-ink-soft text-[14px] leading-relaxed quote-soft">
                  I&apos;ve read the full discussion from this simulation. Ask me anything about it.
                </p>
                <div className="space-y-1.5">
                  <div className="eyebrow">Suggested questions</div>
                  {SUGGESTED_QUESTIONS.map((q) => (
                    <button
                      key={q}
                      onClick={() => send(q)}
                      disabled={streaming}
                      className="w-full text-left text-[13px] text-ink-soft hover:text-coral hover:bg-paper-subtle rounded-md px-3 py-2 transition-colors"
                    >
                      {q}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {history.map((turn, i) => (
              <ChatBubble key={i} turn={turn} />
            ))}
            {streamBuffer && (
              <ChatBubble turn={{ role: 'report_agent', content: streamBuffer, ts: '' }} streaming />
            )}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              void send(input);
            }}
            className="px-3 py-3 border-t border-rule bg-paper-subtle flex items-end gap-2"
          >
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
              }}
              rows={1}
              placeholder="Ask anything…"
              disabled={streaming}
              className="flex-1 bg-paper-card border border-rule rounded-md px-3 py-2 text-[13.5px] text-ink outline-none resize-none placeholder:text-ink-quiet font-serif"
            />
            <button
              type="submit"
              disabled={!input.trim() || streaming}
              className="btn-coral text-[13px] flex items-center gap-1"
            >
              <Send size={12} /> Send
            </button>
          </form>
        </div>
      )}
    </>
  );
}

function ChatBubble({ turn, streaming }: { turn: Turn; streaming?: boolean }) {
  const isUser = turn.role === 'user';
  return (
    <div className={cn('flex', isUser ? 'justify-end' : 'justify-start')}>
      <div
        className={cn(
          'max-w-[85%] rounded-2xl px-3.5 py-2.5 text-[13.5px] leading-relaxed',
          isUser ? 'bg-coral text-white rounded-br-sm' : 'bg-paper-subtle text-ink-soft rounded-bl-sm'
        )}
      >
        {!isUser && <div className="eyebrow text-[9px] mb-1">Report</div>}
        <div className={isUser ? 'font-sans' : 'font-serif'}>
          {turn.content}
          {streaming && <span className="inline-block w-1 h-3.5 bg-coral animate-pulse ml-0.5" />}
        </div>
      </div>
    </div>
  );
}
