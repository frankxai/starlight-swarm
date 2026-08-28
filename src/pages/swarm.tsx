/**
 * /swarm — static cockpit view of the L6 Swarm Runtime + memory import panel.
 *
 * Renders the founder → queen → worker tree and the escalation legend from the
 * typed config in src/swarm/streams.ts. Memory import mirrors Cursor's
 * "Import from Claude Code" surface: scan candidates, human-gate Sync.
 * Read-only tree. Promote posts to dry-run vault only — no live SIS write.
 */
import React, { useCallback, useEffect, useId, useState } from 'react';
import Head from 'next/head';
import type { GetStaticProps } from 'next';
import { swarmTree } from '@/swarm/streams';

type Tree = ReturnType<typeof swarmTree>;

type DialogBucket = {
  id: string;
  label: string;
  count: number;
  selected_by_default: boolean;
  promotable: boolean;
};

type ImportPayload = {
  sync: { overall: string; checks: Array<{ id: string; status: string; detail: string }> };
  dialog: { title: string; subtitle: string; buckets: DialogBucket[] };
  manifest: { counts: { ready: number; refused: number; skills: number; plugins: number } };
  promote?: { ok: boolean; promoted: unknown[]; refused: Array<{ reason: string }> };
};

const LADDER: Array<{ tier: string; who: string; gate: string; color: string }> = [
  { tier: 'autonomous', who: 'Worker → Queen', gate: 'queen review (reversible, no money)', color: 'var(--accent-success)' },
  { tier: 'queen-gate', who: 'Queen', gate: 'brand/claims gate · AP2 mandate + spend-cap (verify-only)', color: 'var(--accent-secondary)' },
  { tier: 'founder-board', who: 'Founder', gate: '/starlight-board pressure-test + human approval', color: 'var(--accent-warning)' },
  { tier: 'human-gate', who: 'Human', gate: 'irreversible + money = human approval, ALWAYS', color: 'var(--accent-danger)' },
];

export const getStaticProps: GetStaticProps<{ tree: Tree }> = async () => {
  return { props: { tree: swarmTree() } };
};

function MemoryImportDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const titleId = useId();
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [payload, setPayload] = useState<ImportPayload | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [status, setStatus] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setStatus(null);
    try {
      const res = await fetch('/api/memory-import');
      const data = (await res.json()) as ImportPayload & { error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Scan failed');
      setPayload(data);
      const next: Record<string, boolean> = {};
      for (const bucket of data.dialog.buckets) {
        next[bucket.id] = bucket.selected_by_default && bucket.promotable;
      }
      setSelected(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Scan failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;

  const toggle = (id: string, promotable: boolean) => {
    if (!promotable) return;
    setSelected((prev) => ({ ...prev, [id]: !prev[id] }));
  };

  const onSync = async () => {
    setSyncing(true);
    setError(null);
    setStatus(null);
    try {
      const res = await fetch('/api/memory-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          humanApproved: true,
          note: 'swarm cockpit Sync',
        }),
      });
      const data = (await res.json()) as ImportPayload & { error?: string };
      if (!res.ok) throw new Error(data.error ?? 'Sync refused');
      setPayload(data);
      const promoted = data.promote?.promoted.length ?? 0;
      const refused = data.promote?.refused.length ?? 0;
      setStatus(
        data.promote?.ok
          ? `Synced ${promoted} candidates into dry-run vault.`
          : `Partial/refused: promoted ${promoted}, refused ${refused}.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setSyncing(false);
    }
  };

  return (
    <div className="import-backdrop" role="presentation" onClick={onClose}>
      <div
        className="import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onClick={(e) => e.stopPropagation()}
      >
        <button type="button" className="import-close" aria-label="Close import dialog" onClick={onClose}>
          ×
        </button>
        <div className="import-hero" aria-hidden="true">
          <span className="import-glyph claude">✶</span>
          <span className="import-dots">···</span>
          <span className="import-glyph starlight">✦</span>
        </div>
        <h2 id={titleId}>{payload?.dialog.title ?? 'Import into Starlight Swarm'}</h2>
        <p className="import-sub">
          {payload?.dialog.subtitle ??
            'Bring over skills, plugins, and rules as candidates. Sync promotes only after a human gate.'}
        </p>

        {loading && <p className="muted">Scanning Claude Code + Cursor surfaces…</p>}
        <div aria-live="polite">
          {error && (
            <p className="import-error" role="alert">
              {error}
            </p>
          )}
          {status && (
            <p className="import-status" role="status">
              {status}
            </p>
          )}
        </div>

        {!loading && payload && (
          <>
            <ul className="import-buckets">
              {payload.dialog.buckets.map((bucket) => (
                <li key={bucket.id}>
                  <label className={!bucket.promotable ? 'disabled' : undefined}>
                    <input
                      type="checkbox"
                      checked={Boolean(selected[bucket.id])}
                      disabled={!bucket.promotable}
                      onChange={() => toggle(bucket.id, bucket.promotable)}
                    />
                    <span>
                      {bucket.label} ({bucket.count})
                      {!bucket.promotable && bucket.id === 'chats' && (
                        <em className="muted"> — refused for durable memory</em>
                      )}
                      {!bucket.promotable && bucket.id !== 'chats' && bucket.count === 0 && (
                        <em className="muted"> — none found</em>
                      )}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <p className="muted import-meta">
              Sync inventory: <span className="code">{payload.sync.overall}</span>
              {' · '}
              ready {payload.manifest.counts.ready}
              {' · '}
              refused {payload.manifest.counts.refused}
            </p>
          </>
        )}

        <button
          type="button"
          className="import-sync"
          disabled={loading || syncing || !payload}
          onClick={() => void onSync()}
        >
          {syncing ? 'Syncing…' : 'Sync'}
        </button>
      </div>
    </div>
  );
}

export default function SwarmCockpit({ tree }: { tree: Tree }) {
  const [importOpen, setImportOpen] = useState(false);

  return (
    <div className="cockpit-container">
      <Head>
        <title>Starlight Swarm — L6 Runtime</title>
        <meta name="theme-color" content="#0c1016" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans:wght@400;500;600&family=Outfit:wght@500;700;800&display=swap"
          rel="stylesheet"
        />
      </Head>

      <a className="skip-link" href="#swarm-main">
        Skip to content
      </a>

      <header>
        <div className="brand">
          <div className="brand-logo" aria-hidden="true">
            ✦
          </div>
          <div>
            <h1>STARLIGHT SWARM — L6 RUNTIME</h1>
            <p className="subtitle">Hybrid queens-per-stream · memory import · dry-run only — no action fires</p>
          </div>
        </div>
        <div className="header-actions">
          <button type="button" className="import-open" onClick={() => setImportOpen(true)}>
            Import memories
          </button>
          <div className="header-status">
            <span className="pulse-dot" />
            <span>SCAFFOLD (DRY-RUN)</span>
          </div>
        </div>
      </header>

      <main id="swarm-main" className="dashboard-grid">
        <section className="card founder-card">
          <h2>Founder</h2>
          <div className="founder-name">{tree.founder.name}</div>
          <div className="muted">
            gate: <span className="code">{tree.founder.gate}</span>
          </div>
          <div className="muted" style={{ marginTop: 8 }}>
            thesis ← {tree.founder.thesisSource}
          </div>
          <ul className="owns">
            {tree.founder.owns.map((o, i) => (
              <li key={i}>{o}</li>
            ))}
          </ul>
        </section>

        <section className="card legend-card">
          <h2>Escalation Ladder</h2>
          <div className="ladder">
            {LADDER.map((l) => (
              <div className="ladder-row" key={l.tier} style={{ borderLeftColor: l.color }}>
                <span className="ladder-tier" style={{ color: l.color }}>
                  {l.tier}
                </span>
                <span className="ladder-who">{l.who}</span>
                <span className="ladder-gate muted">{l.gate}</span>
              </div>
            ))}
          </div>
          <p className="muted footnote">worker → queen → founder → human. No autonomous money movement, ever.</p>
        </section>

        <section className="card streams-card">
          <h2>Stream Queens &amp; Worker Mesh</h2>
          <div className="streams-grid">
            {tree.streams.map((s) => (
              <div className="stream" key={s.id}>
                <div className="stream-head">
                  <span className="queen-name">{s.queen}</span>
                  <span className="role-tag">{s.label}</span>
                </div>
                <div className="muted purpose">{s.purpose}</div>
                <div className="loop">loop: {s.loop.join(' → ')}</div>
                <ul className="workers">
                  {s.workers.map((w) => (
                    <li key={w.name}>
                      <span className="worker-name">{w.name}</span>
                      <span className="worker-skill code">{w.skill}</span>
                      <div className="muted worker-does">{w.does}</div>
                    </li>
                  ))}
                </ul>
                <div className="mcp muted">mcp: {s.mcp.join(' · ')}</div>
              </div>
            ))}
          </div>
        </section>
      </main>

      <MemoryImportDialog open={importOpen} onClose={() => setImportOpen(false)} />

      <style jsx global>{`
        :root {
          color-scheme: dark;
          --bg-base: hsl(220, 24%, 7%);
          --bg-surface: hsla(220, 20%, 12%, 0.82);
          --border-color: hsla(200, 12%, 28%, 0.45);
          --accent-primary: hsl(168, 55%, 48%);
          --accent-secondary: hsl(200, 70%, 58%);
          --accent-success: hsl(145, 65%, 42%);
          --accent-warning: hsl(38, 90%, 55%);
          --accent-danger: hsl(355, 75%, 55%);
          --text-main: hsl(200, 15%, 94%);
          --text-muted: hsl(210, 10%, 62%);
          --font-display: 'Outfit', sans-serif;
          --font-body: 'IBM Plex Sans', sans-serif;
          --focus-ring: 0 0 0 2px hsl(220, 24%, 7%), 0 0 0 4px hsl(168, 55%, 48%);
        }
        .skip-link {
          position: absolute;
          left: 12px;
          top: 12px;
          z-index: 50;
          padding: 8px 12px;
          border-radius: 8px;
          background: var(--accent-primary);
          color: hsl(220, 30%, 6%);
          font-weight: 600;
          text-decoration: none;
          transform: translateY(-200%);
        }
        .skip-link:focus-visible {
          transform: translateY(0);
          box-shadow: var(--focus-ring);
          outline: none;
        }
        @media (prefers-reduced-motion: reduce) {
          *, *::before, *::after {
            animation-duration: 0.01ms !important;
            animation-iteration-count: 1 !important;
            transition-duration: 0.01ms !important;
            scroll-behavior: auto !important;
          }
        }
        body {
          background-color: var(--bg-base);
          background-image:
            radial-gradient(at 12% 8%, hsla(168, 40%, 18%, 0.35) 0px, transparent 45%),
            radial-gradient(at 88% 92%, hsla(200, 45%, 16%, 0.3) 0px, transparent 50%),
            linear-gradient(180deg, hsl(220, 24%, 7%), hsl(220, 28%, 5%));
          color: var(--text-main);
          font-family: var(--font-body);
          min-height: 100vh;
          margin: 0;
          padding: 24px;
        }
        .cockpit-container { max-width: 1400px; margin: 0 auto; }
        header {
          display: flex; justify-content: space-between; align-items: center; gap: 16px;
          background: var(--bg-surface); backdrop-filter: blur(16px);
          border: 1px solid var(--border-color); border-radius: 16px;
          padding: 16px 28px; margin-bottom: 24px;
        }
        .brand { display: flex; align-items: center; gap: 16px; }
        .brand-logo { font-size: 32px; font-family: var(--font-display); color: var(--accent-primary); }
        h1 { font-family: var(--font-display); font-size: 20px; font-weight: 800; letter-spacing: 0.5px; margin: 0; text-wrap: balance; }
        .subtitle { font-size: 12px; color: var(--text-muted); margin: 4px 0 0; }
        .header-actions { display: flex; align-items: center; gap: 14px; flex-wrap: wrap; }
        .header-status { display: flex; align-items: center; gap: 10px; font-family: var(--font-display); font-size: 13px; font-weight: 600; }
        .pulse-dot { width: 8px; height: 8px; background: var(--accent-warning); border-radius: 50%; }
        .import-open, .import-sync, .import-close {
          font-family: var(--font-display);
          cursor: pointer;
        }
        .import-open:focus-visible, .import-sync:focus-visible, .import-close:focus-visible, .import-buckets input:focus-visible {
          outline: none;
          box-shadow: var(--focus-ring);
        }
        .import-open {
          background: hsl(168, 55%, 42%);
          color: hsl(220, 30%, 6%);
          border: none;
          border-radius: 8px;
          padding: 10px 16px;
          font-weight: 700;
          font-size: 13px;
          touch-action: manipulation;
          -webkit-tap-highlight-color: transparent;
        }
        .import-open:hover { background: hsl(168, 55%, 48%); }
        .dashboard-grid { display: grid; grid-template-columns: 1fr 2fr; gap: 24px; }
        .card { background: var(--bg-surface); backdrop-filter: blur(16px); border: 1px solid var(--border-color); border-radius: 16px; padding: 24px; }
        h2 { font-family: var(--font-display); font-size: 16px; font-weight: 700; margin: 0 0 16px; letter-spacing: 0.5px; }
        .muted { color: var(--text-muted); }
        .code { font-family: ui-monospace, monospace; color: var(--accent-secondary); }
        .founder-name { font-family: var(--font-display); font-size: 18px; font-weight: 700; color: var(--accent-primary); margin-bottom: 6px; }
        .owns { margin: 14px 0 0; padding-left: 18px; font-size: 13px; line-height: 1.6; }
        .ladder { display: flex; flex-direction: column; gap: 10px; }
        .ladder-row { display: grid; grid-template-columns: 120px 130px 1fr; gap: 10px; align-items: baseline; background: hsla(220, 16%, 14%, 0.55); border-left: 3px solid; padding: 10px 14px; border-radius: 10px; font-size: 12px; }
        .ladder-tier { font-family: var(--font-display); font-weight: 700; text-transform: uppercase; font-size: 11px; }
        .footnote { font-size: 12px; margin-top: 14px; }
        .streams-card { grid-column: span 2; }
        .streams-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; }
        .stream { background: hsla(220, 16%, 14%, 0.55); border: 1px solid hsla(200, 12%, 28%, 0.3); border-radius: 12px; padding: 18px; }
        .stream-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
        .queen-name { font-family: var(--font-display); font-weight: 700; font-size: 15px; }
        .role-tag { font-family: var(--font-display); font-size: 11px; font-weight: 600; background: hsla(168, 55%, 48%, 0.12); color: var(--accent-primary); border: 1px solid hsla(168, 55%, 48%, 0.28); padding: 2px 8px; border-radius: 4px; }
        .purpose { font-size: 12px; }
        .loop { font-size: 12px; color: var(--accent-secondary); margin: 8px 0 12px; font-family: ui-monospace, monospace; }
        .workers { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
        .workers li { background: hsla(220, 24%, 6%, 0.65); border-radius: 8px; padding: 8px 12px; }
        .worker-name { font-weight: 600; font-size: 13px; margin-right: 8px; }
        .worker-skill { font-size: 11px; }
        .worker-does { font-size: 11px; margin-top: 2px; }
        .mcp { font-size: 11px; margin-top: 12px; line-height: 1.5; }

        .import-backdrop {
          position: fixed; inset: 0; z-index: 40;
          background: hsla(220, 30%, 4%, 0.72);
          display: grid; place-items: center; padding: 24px;
          overscroll-behavior: contain;
        }
        .import-dialog {
          width: min(420px, 100%);
          max-height: min(90vh, 720px);
          overflow: auto;
          overscroll-behavior: contain;
          background: hsl(220, 22%, 10%);
          border: 1px solid hsla(200, 12%, 32%, 0.5);
          border-radius: 16px;
          padding: 28px 24px 24px;
          position: relative;
          box-shadow: 0 24px 64px hsla(0, 0%, 0%, 0.45);
        }
        .import-close {
          position: absolute; top: 12px; right: 12px;
          width: 32px; height: 32px; border-radius: 8px;
          border: 1px solid transparent; background: transparent;
          color: var(--text-muted); font-size: 22px; line-height: 1;
        }
        .import-close:hover { color: var(--text-main); background: hsla(200, 12%, 28%, 0.25); }
        .import-hero {
          display: flex; align-items: center; justify-content: center; gap: 12px;
          margin-bottom: 18px;
        }
        .import-glyph {
          width: 40px; height: 40px; border-radius: 10px;
          display: grid; place-items: center; font-size: 20px;
        }
        .import-glyph.claude { background: hsl(18, 80%, 48%); color: white; }
        .import-glyph.starlight { background: hsl(220, 18%, 16%); border: 1px solid var(--border-color); color: var(--accent-primary); }
        .import-dots { color: var(--text-muted); letter-spacing: 2px; }
        .import-dialog h2 {
          text-align: center; margin: 0 0 8px; font-size: 20px; text-wrap: balance;
        }
        .import-sub {
          text-align: center; color: var(--text-muted); font-size: 13px; line-height: 1.45;
          margin: 0 0 18px;
        }
        .import-buckets {
          list-style: none; margin: 0 0 14px; padding: 0;
          background: hsl(220, 20%, 8%);
          border: 1px solid hsla(200, 12%, 28%, 0.4);
          border-radius: 12px;
          overflow: hidden;
        }
        .import-buckets li + li { border-top: 1px solid hsla(200, 12%, 28%, 0.35); }
        .import-buckets label {
          display: flex; align-items: flex-start; gap: 10px;
          padding: 14px 16px; font-size: 14px; cursor: pointer;
        }
        .import-buckets label.disabled { cursor: not-allowed; opacity: 0.75; }
        .import-buckets input { margin-top: 3px; accent-color: hsl(210, 90%, 56%); }
        .import-meta { font-size: 12px; margin: 0 0 16px; }
        .import-error { color: var(--accent-danger); font-size: 13px; }
        .import-status { color: var(--accent-success); font-size: 13px; }
        .import-sync {
          width: 100%;
          border: none;
          border-radius: 10px;
          padding: 14px 16px;
          font-size: 15px;
          font-weight: 700;
          background: hsl(0, 0%, 96%);
          color: hsl(220, 24%, 8%);
          touch-action: manipulation;
          -webkit-tap-highlight-color: transparent;
        }
        .import-sync:hover:not(:disabled) { background: white; }
        .import-sync:disabled { opacity: 0.55; cursor: not-allowed; }

        @media (max-width: 900px) {
          .dashboard-grid, .streams-grid { grid-template-columns: 1fr; }
          .streams-card { grid-column: span 1; }
          .ladder-row { grid-template-columns: 1fr; gap: 4px; }
          header { flex-direction: column; align-items: flex-start; }
        }
      `}</style>
    </div>
  );
}
