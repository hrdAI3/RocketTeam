'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Plus,
  Mail,
  Key,
  FileBadge,
  Globe,
  CreditCard,
  Cloud,
  ShieldCheck,
  HelpCircle,
  Eye,
  EyeOff,
  X,
  Trash2,
  Pencil,
  Loader2,
  ArrowLeft,
  type LucideIcon
} from 'lucide-react';
// Loader2 used in modal too
import { useToast } from '../../components/Toast';
import { Avatar, MemberInline } from '../../components/Avatar';
import type { TeamResource, ResourceType, Department } from '@/types';

const TYPE_LABEL: Record<ResourceType, string> = {
  account: 'Shared account',
  api_key: 'API key',
  license: 'License',
  domain: 'Domain',
  subscription: 'Subscription',
  cloud: 'Cloud',
  cert: 'Certificate',
  other: 'Other'
};

const TYPE_ICON: Record<ResourceType, LucideIcon> = {
  account: Mail,
  api_key: Key,
  license: FileBadge,
  domain: Globe,
  subscription: CreditCard,
  cloud: Cloud,
  cert: ShieldCheck,
  other: HelpCircle
};

export default function ResourcesPage() {
  const toast = useToast();
  const [resources, setResources] = useState<TeamResource[] | null>(null);
  const [members, setMembers] = useState<Array<{ name: string; dept?: Department }>>([]);
  const [editing, setEditing] = useState<TeamResource | null>(null);
  const [creating, setCreating] = useState(false);
  const [filter, setFilter] = useState<'all' | ResourceType>('all');

  const refresh = useCallback(async () => {
    const [rRes, aRes] = await Promise.all([
      fetch('/api/resources', { cache: 'no-store' }),
      fetch('/api/agents', { cache: 'no-store' })
    ]);
    if (rRes.ok) {
      const data = (await rRes.json()) as { resources: TeamResource[] };
      setResources(data.resources);
    }
    if (aRes.ok) {
      const data = (await aRes.json()) as { agents: Array<{ name: string; dept?: Department; _error?: string }> };
      setMembers(data.agents.filter((a) => !a._error).map((a) => ({ name: a.name, dept: a.dept })));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const deptMap = useMemo(() => {
    const m: Record<string, Department> = {};
    for (const x of members) if (x.dept) m[x.name] = x.dept;
    return m;
  }, [members]);

  const filtered = useMemo(() => {
    if (!resources) return null;
    if (filter === 'all') return resources;
    return resources.filter((r) => r.type === filter);
  }, [resources, filter]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: resources?.length ?? 0 };
    for (const r of resources ?? []) c[r.type] = (c[r.type] ?? 0) + 1;
    return c;
  }, [resources]);

  const monthlyCost = useMemo(() => {
    return (resources ?? []).reduce((acc, r) => acc + (r.monthly_cost_cny ?? 0), 0);
  }, [resources]);

  const expiringSoon = useMemo(() => {
    const today = new Date();
    const in30 = new Date(today);
    in30.setDate(in30.getDate() + 30);
    return (resources ?? []).filter(
      (r) => r.expires_at && new Date(r.expires_at) <= in30 && new Date(r.expires_at) >= today
    );
  }, [resources]);

  return (
    <div className="px-12 py-10 max-w-[1100px] mx-auto">
      <Link
        href="/sources"
        className="text-caption text-ink-muted hover:text-ink inline-flex items-center gap-1 mb-3"
      >
        <ArrowLeft size={12} /> Sources
      </Link>
      <header className="flex items-end justify-between mb-8">
        <div className="max-w-2xl">
          <div className="eyebrow mb-2">Rocket Team / Resources</div>
          <h1 className="display-title">Resources</h1>
          <p className="prose-warm text-body text-ink-muted mt-3">
            Shared accounts, API keys, subscriptions, domains, certificates — who owns them, who can use them, when they renew, where they live.
            During simulation, PMA reads from here: whose Gmail sends the email? Which API key runs the experiment?
          </p>
        </div>
        <button onClick={() => setCreating(true)} className="btn-coral inline-flex items-center gap-1.5">
          <Plus size={13} /> Add resource
        </button>
      </header>

      {/* Stats */}
      {resources && resources.length > 0 && (
        <section className="mb-6 grid grid-cols-3 gap-px bg-rule rounded-xl overflow-hidden border border-rule">
          <Stat label="Resources" value={resources.length} />
          <Stat
            label="Monthly cost"
            value={monthlyCost > 0 ? `¥${monthlyCost.toLocaleString()}` : '—'}
            accent
          />
          <Stat
            label="Expiring in 30 days"
            value={expiringSoon.length}
            caption={expiringSoon.length > 0 ? 'renew soon' : 'none'}
          />
        </section>
      )}

      {/* Filter tabs */}
      {resources && resources.length > 0 && (
        <div className="border-b border-rule mb-4">
          <nav className="flex items-end gap-1 flex-wrap">
            {(['all', ...Object.keys(TYPE_LABEL)] as Array<'all' | ResourceType>).map((f) => {
              const active = filter === f;
              const n = counts[f] ?? 0;
              if (f !== 'all' && n === 0) return null;
              return (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`px-3 py-2 text-[13px] transition-colors border-b-2 -mb-px ${
                    active
                      ? 'border-coral text-coral-deep font-medium'
                      : 'border-transparent text-ink-muted hover:text-ink'
                  }`}
                >
                  {f === 'all' ? 'All' : TYPE_LABEL[f as ResourceType]}
                  <span
                    className={`ml-1 font-mono text-[10.5px] ${
                      active ? 'text-coral' : 'text-ink-quiet'
                    }`}
                  >
                    {n}
                  </span>
                </button>
              );
            })}
          </nav>
        </div>
      )}

      {!resources && (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="card-surface p-4 animate-pulse h-20" />
          ))}
        </div>
      )}

      {resources && resources.length === 0 && (
        <div className="rounded-2xl border border-dashed border-rule p-12 text-center bg-paper-card">
          <div className="font-serif text-title text-ink mb-2">No resources yet</div>
          <p className="text-body text-ink-muted mb-6 max-w-md mx-auto">
            Click &ldquo;Add resource&rdquo; in the top right and paste in an account, API key, screenshot, or doc.
            The system parses the fields automatically.
          </p>
        </div>
      )}

      {filtered && filtered.length > 0 && (
        <ul className="space-y-2.5">
          {filtered.map((r) => (
            <ResourceRow
              key={r.id}
              resource={r}
              deptMap={deptMap}
              onEdit={() => setEditing(r)}
            />
          ))}
        </ul>
      )}

      {(creating || editing) && (
        <ResourceModal
          resource={editing}
          members={members}
          deptMap={deptMap}
          onClose={() => {
            setCreating(false);
            setEditing(null);
          }}
          onSaved={() => {
            setCreating(false);
            setEditing(null);
            toast.push('Saved', 'success');
            void refresh();
          }}
          onDelete={() => {
            setEditing(null);
            toast.push('Deleted', 'success');
            void refresh();
          }}
        />
      )}
    </div>
  );
}

function Stat({
  label,
  value,
  caption,
  accent
}: {
  label: string;
  value: number | string;
  caption?: string;
  accent?: boolean;
}) {
  return (
    <div className="bg-paper-card px-5 py-4">
      <div className={`font-serif text-[28px] leading-none ${accent ? 'text-coral' : 'text-ink'}`}>
        {value}
      </div>
      <div className="eyebrow mt-2">{label}</div>
      {caption && <div className="text-[11px] text-ink-quiet mt-1.5">{caption}</div>}
    </div>
  );
}

function ResourceRow({
  resource,
  deptMap,
  onEdit
}: {
  resource: TeamResource;
  deptMap: Record<string, Department>;
  onEdit: () => void;
}) {
  const Icon = TYPE_ICON[resource.type];
  const expiringSoon = resource.expires_at && (() => {
    const exp = new Date(resource.expires_at);
    const now = new Date();
    const diff = (exp.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    return diff >= 0 && diff <= 30;
  })();

  return (
    <li>
      <button
        onClick={onEdit}
        className="w-full text-left card-surface p-4 hover:shadow-soft hover:border-rule-strong transition-all flex items-start gap-3"
      >
        <div className="w-10 h-10 rounded-md bg-paper-subtle border border-rule-soft flex items-center justify-center shrink-0">
          <Icon size={16} className="text-coral" strokeWidth={2} />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2 flex-wrap">
            <h3 className="font-serif text-[16px] text-ink leading-tight">{resource.name}</h3>
            <span className="text-[10.5px] uppercase font-mono text-ink-quiet tracking-wide">
              {TYPE_LABEL[resource.type]}
            </span>
            <span className="text-[11px] text-ink-quiet">· {resource.vendor}</span>
            {resource.identifier && (
              <span className="font-mono text-[11px] text-ink-quiet">
                · {resource.identifier}
              </span>
            )}
            {resource.credential_encrypted !== undefined && (
              <span className="text-[10px] text-coral inline-flex items-center gap-0.5">
                <Key size={9} /> credential stored
              </span>
            )}
          </div>
          {resource.notes && (
            <p className="text-[12.5px] text-ink-muted leading-snug mt-1">{resource.notes}</p>
          )}
          <div className="flex items-center gap-3 mt-2 flex-wrap text-[11px] text-ink-quiet">
            {resource.owners.length > 0 && (
              <div className="inline-flex items-center gap-1">
                <span>Owners</span>
                <div className="flex gap-1">
                  {resource.owners.slice(0, 3).map((n) => (
                    <MemberInline key={n} name={n} dept={deptMap[n]} size="xs" emphasis />
                  ))}
                </div>
              </div>
            )}
            {resource.users_with_access.length > 0 && (
              <div className="inline-flex items-center gap-1">
                <span>Access</span>
                <div className="flex -space-x-1">
                  {resource.users_with_access.slice(0, 5).map((n) => (
                    <Avatar key={n} name={n} dept={deptMap[n]} size="xs" />
                  ))}
                  {resource.users_with_access.length > 5 && (
                    <span className="ml-2 text-ink-quiet">+{resource.users_with_access.length - 5}</span>
                  )}
                </div>
              </div>
            )}
            {resource.monthly_cost_cny !== undefined && resource.monthly_cost_cny > 0 && (
              <span className="font-mono">¥{resource.monthly_cost_cny}/mo</span>
            )}
            {resource.expires_at && (
              <span className={expiringSoon ? 'text-amber font-medium' : ''}>
                {expiringSoon ? 'expiring ' : 'expires '}
                {resource.expires_at}
              </span>
            )}
          </div>
        </div>
      </button>
    </li>
  );
}

function ResourceModal({
  resource,
  members,
  deptMap,
  onClose,
  onSaved,
  onDelete
}: {
  resource: TeamResource | null;
  members: Array<{ name: string; dept?: Department }>;
  deptMap: Record<string, Department>;
  onClose: () => void;
  onSaved: () => void;
  onDelete: () => void;
}) {
  const isEdit = Boolean(resource);
  const [name, setName] = useState(resource?.name ?? '');
  const [type, setType] = useState<ResourceType>(resource?.type ?? 'account');
  const [vendor, setVendor] = useState(resource?.vendor ?? '');
  const [identifier, setIdentifier] = useState(resource?.identifier ?? '');
  const [credential, setCredential] = useState('');
  const [revealCred, setRevealCred] = useState<string | null>(null);
  const [revealing, setRevealing] = useState(false);
  const [showCredInput, setShowCredInput] = useState(!isEdit);
  const [owners, setOwners] = useState<string[]>(resource?.owners ?? []);
  const [users, setUsers] = useState<string[]>(resource?.users_with_access ?? []);
  const [cost, setCost] = useState<string>(
    resource?.monthly_cost_cny !== undefined ? String(resource.monthly_cost_cny) : ''
  );
  const [expiresAt, setExpiresAt] = useState(resource?.expires_at ?? '');
  const [notes, setNotes] = useState(resource?.notes ?? '');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // AI parse state
  const [parseRaw, setParseRaw] = useState('');
  const [parsing, setParsing] = useState(false);

  const parseWithAI = async () => {
    if (!parseRaw.trim()) return;
    setParsing(true);
    setError(null);
    try {
      const res = await fetch('/api/resources/parse', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: parseRaw })
      });
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(e.error ?? `Parse failed ${res.status}`);
      }
      const data = (await res.json()) as {
        parsed: Partial<TeamResource>;
        credential_plaintext?: string;
      };
      const p = data.parsed;
      if (p.name) setName(p.name);
      if (p.type) setType(p.type);
      if (p.vendor) setVendor(p.vendor);
      if (p.identifier !== undefined) setIdentifier(p.identifier);
      if (p.monthly_cost_cny !== undefined) setCost(String(p.monthly_cost_cny));
      if (p.expires_at) setExpiresAt(p.expires_at);
      if (p.notes) setNotes(p.notes);
      if (data.credential_plaintext) {
        setCredential(data.credential_plaintext);
        setShowCredInput(true);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setParsing(false);
    }
  };

  const reveal = async () => {
    if (!resource) return;
    setRevealing(true);
    try {
      const res = await fetch(`/api/resources/${resource.id}/reveal`, { method: 'POST' });
      if (!res.ok) throw new Error('No credential, or read failed');
      const data = (await res.json()) as { credential: string };
      setRevealCred(data.credential);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRevealing(false);
    }
  };

  const save = async () => {
    if (!name.trim() || !vendor.trim()) {
      setError('Name and vendor are required');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body = {
        name: name.trim(),
        type,
        vendor: vendor.trim(),
        identifier: identifier.trim() || undefined,
        credential_plaintext: showCredInput && credential.trim() ? credential.trim() : undefined,
        owners,
        users_with_access: users,
        monthly_cost_cny: cost ? Number(cost) : undefined,
        expires_at: expiresAt || undefined,
        notes: notes.trim() || undefined
      };
      const res = await fetch(isEdit ? `/api/resources/${resource!.id}` : '/api/resources', {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const e = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(e.error ?? `Save failed ${res.status}`);
      }
      onSaved();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (!resource) return;
    if (!confirm(`Delete "${resource.name}"?`)) return;
    await fetch(`/api/resources/${resource.id}`, { method: 'DELETE' });
    onDelete();
  };

  const toggleMember = (name: string, list: string[], setList: (v: string[]) => void) => {
    setList(list.includes(name) ? list.filter((n) => n !== name) : [...list, name]);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/30 backdrop-blur-sm animate-fade-in"
      onClick={onClose}
    >
      <div
        className="card-warm shadow-modal w-[640px] max-h-[90vh] overflow-y-auto animate-slide-up"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="px-5 py-4 border-b border-rule sticky top-0 bg-paper-card z-10 flex items-center justify-between">
          <h2 className="font-serif text-[18px] text-ink">{isEdit ? 'Edit resource' : 'Add resource'}</h2>
          <button onClick={onClose} className="text-ink-quiet hover:text-ink">
            <X size={16} />
          </button>
        </header>

        <div className="p-5 space-y-4">
          {!isEdit && (
            <div className="rounded-lg border border-coral-mute bg-coral-subtle/30 p-3.5">
              <div className="eyebrow text-coral mb-1.5">Let AI auto-fill</div>
              <p className="text-[12.5px] text-ink-soft leading-snug mb-2">
                Paste OCR from an account screenshot, a password manager export, an email, chat, or invoice — the system parses the fields.
              </p>
              <textarea
                value={parseRaw}
                onChange={(e) => setParseRaw(e.target.value)}
                rows={3}
                placeholder="Paste raw text…"
                className="w-full bg-paper-card border border-rule rounded-md px-3 py-2 text-[13px] outline-none resize-y placeholder:text-ink-quiet focus:border-coral-mute"
              />
              <div className="flex justify-end mt-2">
                <button
                  onClick={() => void parseWithAI()}
                  disabled={parsing || !parseRaw.trim()}
                  className="btn-coral text-caption inline-flex items-center gap-1.5"
                >
                  {parsing ? (
                    <>
                      <Loader2 size={11} className="animate-spin" /> Parsing…
                    </>
                  ) : (
                    'Parse with AI → fill form'
                  )}
                </button>
              </div>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <Field label="Name *">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Company Gmail / OpenAI prod key"
                className="w-full bg-paper-card border border-rule rounded-md px-3 py-2 text-[14px] outline-none focus:border-coral-mute"
              />
            </Field>
            <Field label="Type *">
              <select
                value={type}
                onChange={(e) => setType(e.target.value as ResourceType)}
                className="w-full bg-paper-card border border-rule rounded-md px-3 py-2 text-[14px] outline-none focus:border-coral-mute"
              >
                {Object.entries(TYPE_LABEL).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v}
                  </option>
                ))}
              </select>
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Vendor *">
              <input
                value={vendor}
                onChange={(e) => setVendor(e.target.value)}
                placeholder="e.g. Google / OpenAI / Apple / Cloudflare"
                className="w-full bg-paper-card border border-rule rounded-md px-3 py-2 text-[14px] outline-none focus:border-coral-mute"
              />
            </Field>
            <Field label="Identifier (visible, non-secret)">
              <input
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder="Account / key prefix / domain / cert ID"
                className="w-full bg-paper-card border border-rule rounded-md px-3 py-2 text-[14px] font-mono outline-none focus:border-coral-mute"
              />
            </Field>
          </div>

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="eyebrow">Credential / secret</span>
              {isEdit && resource?.credential_encrypted && !revealCred && !showCredInput && (
                <button
                  onClick={() => void reveal()}
                  disabled={revealing}
                  className="btn-ghost text-caption inline-flex items-center gap-1"
                >
                  {revealing ? (
                    <>
                      <Loader2 size={11} className="animate-spin" /> Decrypting…
                    </>
                  ) : (
                    <>
                      <Eye size={11} /> Reveal stored credential
                    </>
                  )}
                </button>
              )}
            </div>
            {revealCred && (
              <div className="rounded-md bg-paper-subtle border border-rule p-2.5 mb-2 flex items-center justify-between">
                <code className="font-mono text-[12px] text-ink select-all break-all">
                  {revealCred}
                </code>
                <button
                  onClick={() => setRevealCred(null)}
                  className="ml-2 shrink-0 text-ink-quiet hover:text-ink"
                  aria-label="Hide"
                >
                  <EyeOff size={12} />
                </button>
              </div>
            )}
            {showCredInput ? (
              <input
                type="password"
                value={credential}
                onChange={(e) => setCredential(e.target.value)}
                placeholder={isEdit ? 'Fill to update; leave blank to keep current value' : 'Password / API key / cert content'}
                className="w-full bg-paper-card border border-rule rounded-md px-3 py-2 text-[13.5px] font-mono outline-none focus:border-coral-mute"
              />
            ) : (
              <button
                onClick={() => setShowCredInput(true)}
                className="text-caption link-coral"
              >
                {isEdit ? 'Update credential' : 'Add a credential (optional)'}
              </button>
            )}
            <p className="text-[11px] text-ink-quiet mt-1.5">
              Credentials are encrypted with AES-256-GCM and stored under <span className="font-mono">team/resources/</span>.
              They never appear in the list API response.
            </p>
          </div>

          <Field label="Owners (manage + renew)">
            <MemberPicker
              all={members}
              deptMap={deptMap}
              selected={owners}
              onChange={setOwners}
            />
          </Field>

          <Field label="Members with access">
            <MemberPicker
              all={members}
              deptMap={deptMap}
              selected={users}
              onChange={setUsers}
            />
          </Field>

          <div className="grid grid-cols-2 gap-3">
            <Field label="Monthly cost (CNY, optional)">
              <input
                type="number"
                value={cost}
                onChange={(e) => setCost(e.target.value)}
                placeholder="e.g. 200"
                className="w-full bg-paper-card border border-rule rounded-md px-3 py-2 text-[14px] outline-none focus:border-coral-mute"
              />
            </Field>
            <Field label="Expires (optional)">
              <input
                type="date"
                value={expiresAt}
                onChange={(e) => setExpiresAt(e.target.value)}
                className="w-full bg-paper-card border border-rule rounded-md px-3 py-2 text-[14px] outline-none focus:border-coral-mute"
              />
            </Field>
          </div>

          <Field label="Notes">
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Extra context: login method, where 2FA lives, emergency contact, etc."
              className="w-full bg-paper-card border border-rule rounded-md px-3 py-2 text-[13.5px] outline-none focus:border-coral-mute resize-y"
            />
          </Field>

          {error && (
            <div className="text-caption text-rust px-3 py-2 bg-rust/5 border border-rust/30 rounded-md">
              {error}
            </div>
          )}
        </div>

        <footer className="px-5 py-3 border-t border-rule-soft sticky bottom-0 bg-paper-card flex items-center justify-between">
          {isEdit ? (
            <button onClick={remove} className="text-caption text-rust hover:underline inline-flex items-center gap-1">
              <Trash2 size={11} /> Delete
            </button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <button onClick={onClose} className="btn-ghost text-caption">
              Cancel
            </button>
            <button
              onClick={() => void save()}
              disabled={saving}
              className="btn-coral text-caption inline-flex items-center gap-1"
            >
              {saving ? 'Saving…' : isEdit ? 'Save' : 'Add'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div className="eyebrow mb-1.5">{label}</div>
      {children}
    </div>
  );
}

function MemberPicker({
  all,
  deptMap,
  selected,
  onChange
}: {
  all: Array<{ name: string; dept?: Department }>;
  deptMap: Record<string, Department>;
  selected: string[];
  onChange: (v: string[]) => void;
}) {
  const [search, setSearch] = useState('');
  const filtered = useMemo(() => {
    if (!search.trim()) return all;
    const q = search.trim().toLowerCase();
    return all.filter((a) => a.name.toLowerCase().includes(q));
  }, [all, search]);

  return (
    <div className="border border-rule rounded-md bg-paper-card">
      {selected.length > 0 && (
        <div className="flex flex-wrap gap-1.5 p-2 border-b border-rule-soft">
          {selected.map((n) => (
            <span
              key={n}
              className="inline-flex items-center gap-1 bg-coral-subtle text-coral-deep rounded-full pl-1 pr-1.5 py-0.5 text-[12px]"
            >
              <Avatar name={n} dept={deptMap[n]} size="xs" />
              {n}
              <button
                onClick={() => onChange(selected.filter((x) => x !== n))}
                className="text-coral-deep hover:text-coral"
                aria-label="Remove"
              >
                <X size={9} strokeWidth={3} />
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        placeholder="Search members…"
        className="w-full px-3 py-2 text-[13px] bg-transparent outline-none"
      />
      {search.trim() && (
        <div className="max-h-[140px] overflow-y-auto border-t border-rule-soft">
          {filtered.slice(0, 20).map((m) => {
            const checked = selected.includes(m.name);
            return (
              <button
                key={m.name}
                onClick={() => {
                  if (checked) onChange(selected.filter((n) => n !== m.name));
                  else onChange([...selected, m.name]);
                  setSearch('');
                }}
                className={`w-full text-left flex items-center gap-2 px-3 py-1.5 hover:bg-paper-subtle transition-colors ${
                  checked ? 'bg-coral-subtle/40' : ''
                }`}
              >
                <Avatar name={m.name} dept={m.dept} size="xs" />
                <span className="text-[13px] text-ink">{m.name}</span>
                {checked && <span className="ml-auto text-[10px] text-coral">selected</span>}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
