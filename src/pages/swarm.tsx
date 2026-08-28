/**
 * /swarm — Kernel Observatory.
 *
 * Read-only projection of observatorySnapshot(). Cannot admit, activate,
 * spend, or send. Unknown health stays unknown.
 */
import React from 'react';
import Head from 'next/head';
import type { GetStaticProps } from 'next';
import { observatorySnapshot } from '@/swarm/observatory';
import type { ObservatorySnapshot } from '@/swarm/observatory';

const LADDER: Array<{ tier: string; who: string; gate: string; tone: 'ok' | 'info' | 'hold' | 'stop' }> = [
  { tier: 'autonomous', who: 'Worker → Queen', gate: 'Queen review. Reversible. No money.', tone: 'ok' },
  { tier: 'queen-gate', who: 'Queen', gate: 'Brand/claims. AP2 mandate + spend-cap, verify-only.', tone: 'info' },
  { tier: 'founder-board', who: 'Founder', gate: '/starlight-board plus human approval.', tone: 'hold' },
  { tier: 'human-gate', who: 'Human', gate: 'Irreversible or money. Always.', tone: 'stop' },
];

export const getStaticProps: GetStaticProps<{ snap: ObservatorySnapshot }> = async () => {
  return { props: { snap: observatorySnapshot() } };
};

function Mark({ kind }: { kind: 'hold' | 'kernel' | 'stream' | 'ok' | 'open' }) {
  const fill =
    kind === 'hold' ? 'var(--accent-warning)' :
    kind === 'ok' ? 'var(--accent-success)' :
    kind === 'open' ? 'var(--accent-danger)' :
    kind === 'stream' ? 'var(--accent-secondary)' :
    'var(--accent-primary)';
  return (
    <svg className="mark" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="none" stroke={fill} strokeWidth="1.5" />
      <circle cx="8" cy="8" r="2.4" fill={fill} />
    </svg>
  );
}

export default function SwarmObservatory({ snap }: { snap: ObservatorySnapshot }) {
  return (
    <div className="shell">
      <Head>
        <title>Starlight Swarm — Kernel Observatory</title>
        <meta name="description" content="Read-only overview of the Starlight Swarm kernel, streams, absorbed research, and admission hold. Dry-run only. No live funds." />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#0d0e16" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Outfit:wght@500;600;700;800&display=swap" rel="stylesheet" />
      </Head>

      <a className="skip" href="#main">Skip to observatory</a>

      <header className="top">
        <div className="brand">
          <span className="logo" aria-hidden="true">✦</span>
          <div>
            <p className="kicker">L6 · {snap.version}</p>
            <h1>Kernel Observatory</h1>
            <p className="lede">{snap.headline}</p>
          </div>
        </div>
        <p className="hold-badge" role="status">
          <span className="pulse" aria-hidden="true" />
          Not admitted · dry-run · no live funds
        </p>
      </header>

      <nav className="toc" aria-label="Observatory sections">
        <a href="#admission">Admission</a>
        <a href="#kernel">Kernel</a>
        <a href="#streams">Streams</a>
        <a href="#gates">Gates</a>
        <a href="#absorbed">Absorbed</a>
        <a href="#criteria">Criteria</a>
      </nav>

      <section className="metrics" aria-label="Kernel snapshot">
        <article className="metric">
          <p className="metric-label">Admission</p>
          <p className="metric-value stop">held</p>
        </article>
        <article className="metric">
          <p className="metric-label">Success criteria</p>
          <p className="metric-value">{snap.criteria.met} met · {snap.criteria.open} open</p>
        </article>
        <article className="metric">
          <p className="metric-label">Kernel ring</p>
          <p className="metric-value">{snap.kernel.kernel.length} pins</p>
        </article>
        <article className="metric">
          <p className="metric-label">Income streams</p>
          <p className="metric-value">{snap.streams.length} queens</p>
        </article>
      </section>

      <main id="main" className="main">
        <section id="admission" className="panel">
          <h2><Mark kind="hold" /> Admission Hold</h2>
          <p className="panel-lede">
            The report-only assessor cannot admit a plan. Unknown health stays unknown.
            These blockers are the checked-in snapshot, not a live probe.
          </p>
          <ol className="blockers">
            {snap.admission.blockers.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ol>
        </section>

        <section id="kernel" className="panel">
          <h2><Mark kind="kernel" /> Kernel Ring</h2>
          <p className="panel-lede">
            Adjacent products stay in their own repos. This runtime pins them.
            Monorepo merge is rejected. Policy: {snap.kernel.policy.monorepo} merge,
            live funds {snap.kernel.policy.live_funds}, activation {snap.kernel.policy.activation}.
          </p>
          <ul className="pin-grid">
            {snap.kernel.kernel.map((m) => (
              <li key={m.id} className="pin">
                <p className="pin-meta">
                  <span className="layer">{m.layer}</span>
                  <span className="posture">{m.posture}</span>
                  <span className="evidence">{m.evidence}</span>
                </p>
                <a className="pin-repo" href={m.url} rel="noreferrer" translate="no">{m.repo}</a>
                <p className="pin-role">{m.role}</p>
                <p className="pin-next">Next: {m.next}</p>
              </li>
            ))}
          </ul>
          <h3 className="subhead">Satellites</h3>
          <ul className="sat-list">
            {snap.kernel.satellites.map((m) => (
              <li key={m.id}>
                <a href={m.url} rel="noreferrer" translate="no">{m.repo}</a>
                <span> — {m.role}</span>
              </li>
            ))}
          </ul>
        </section>

        <section id="streams" className="panel">
          <h2><Mark kind="stream" /> Stream Queens</h2>
          <p className="panel-lede">
            Founder <span translate="no">{snap.founder.name}</span> holds <span translate="no">{snap.founder.gate}</span>. Queens never command across streams.
          </p>
          <ul className="stream-grid">
            {snap.streams.map((s) => (
              <li key={s.id} className="stream">
                <p className="stream-head">
                  <span className="queen">{s.queen}</span>
                  <span className="tag">{s.label}</span>
                </p>
                <p className="purpose">{s.purpose}</p>
                <p className="loop">loop: {s.loop.join(' → ')}</p>
                <ul className="workers">
                  {s.workers.map((w) => (
                    <li key={w.name}>
                      <span className="w-name">{w.name}</span>
                      <span className="w-skill">{w.skill}</span>
                      <span className="w-does">{w.does}</span>
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        </section>

        <div className="split">
          <section id="gates" className="panel">
            <h2><Mark kind="ok" /> Escalation</h2>
            <ol className="ladder">
              {LADDER.map((l) => (
                <li key={l.tier} className={`rung ${l.tone}`}>
                  <span className="tier">{l.tier}</span>
                  <span className="who">{l.who}</span>
                  <span className="gate">{l.gate}</span>
                </li>
              ))}
            </ol>
          </section>

          <section className="panel" aria-labelledby="charter-h">
            <h2 id="charter-h"><Mark kind="open" /> Charter</h2>
            <p className="panel-lede">{snap.charter.protocol} · {snap.charter.version}. Raise-only.</p>
            <ol className="clauses">
              {snap.charter.clauses.map((c, i) => (
                <li key={c.id}><span className="clause-id">{i + 1}. {c.id}</span> {c.text}</li>
              ))}
            </ol>
          </section>
        </div>

        <section id="absorbed" className="panel">
          <h2><Mark kind="kernel" /> Absorbed Research</h2>
          <p className="panel-lede">
            Patterns taken, attributed, and refused where they would create a second Queen.
            {` ${snap.absorbed.count} entries.`}
          </p>
          <ul className="absorbed">
            {snap.absorbed.items.map((p) => (
              <li key={p.id}>
                <p className="abs-head">
                  <a href={p.url} rel="noreferrer" translate="no">{p.source}</a>
                  <span className="tag">{p.disposition}</span>
                  <span className="tag quiet">{p.mapsTo}</span>
                </p>
                <p className="abs-name">{p.name}</p>
                <p className="abs-pattern">{p.pattern}</p>
                <p className="abs-refuse">Refuse: {p.refuse}</p>
              </li>
            ))}
          </ul>
        </section>

        <section id="criteria" className="panel">
          <h2><Mark kind="ok" /> Success Criteria</h2>
          <p className="panel-lede">{snap.criteria.headline}</p>
          <ul className="criteria">
            {snap.criteria.items.map((c) => (
              <li key={c.id} className={c.status}>
                <span className="cid">{c.id}</span>
                <span className="cstat">{c.status}</span>
                <span className="cdemand">{c.demand}</span>
              </li>
            ))}
          </ul>
        </section>
      </main>

      <style jsx global>{`
        :root {
          --bg-base: hsl(240, 20%, 6%);
          --bg-surface: hsla(240, 16%, 12%, 0.76);
          --border-color: hsla(240, 12%, 28%, 0.55);
          --accent-primary: hsl(270, 75%, 72%);
          --accent-secondary: hsl(190, 80%, 58%);
          --accent-success: hsl(145, 70%, 48%);
          --accent-warning: hsl(40, 90%, 58%);
          --accent-danger: hsl(355, 80%, 62%);
          --text-main: hsl(0, 0%, 95%);
          --text-muted: hsl(240, 10%, 72%);
          --font-outfit: 'Outfit', sans-serif;
          --font-inter: 'Inter', sans-serif;
          --focus: 0 0 0 3px hsl(190, 80%, 58%);
        }
        html { scroll-behavior: smooth; color-scheme: dark; touch-action: manipulation; }
        @media (prefers-reduced-motion: reduce) {
          html { scroll-behavior: auto; }
        }
        body {
          background-color: var(--bg-base);
          background-image:
            radial-gradient(at 8% 0%, hsla(270, 50%, 18%, 0.35) 0, transparent 46%),
            radial-gradient(at 92% 100%, hsla(190, 50%, 16%, 0.28) 0, transparent 42%);
          color: var(--text-main);
          font-family: var(--font-inter);
          margin: 0;
          min-height: 100vh;
        }
        * { box-sizing: border-box; }
        a:focus-visible, button:focus-visible {
          outline: 3px solid hsl(190, 80%, 58%);
          outline-offset: 3px;
        }
      `}</style>

      <style jsx>{`
        .shell {
          max-width: 1180px; margin: 0 auto;
          padding: max(20px, env(safe-area-inset-top)) max(16px, env(safe-area-inset-right)) max(64px, env(safe-area-inset-bottom)) max(16px, env(safe-area-inset-left));
        }
        .skip {
          position: absolute; left: 12px; top: -48px;
          background: var(--accent-secondary); color: #041018;
          padding: 8px 12px; border-radius: 8px; font-weight: 700; z-index: 10;
        }
        .skip:focus-visible { top: 12px; }
        .top {
          display: flex; justify-content: space-between; align-items: flex-start; gap: 16px;
          background: var(--bg-surface); border: 1px solid var(--border-color);
          border-radius: 16px; padding: 18px 20px; flex-wrap: wrap;
        }
        .brand { display: flex; gap: 14px; min-width: 0; }
        .brand > div { min-width: 0; }
        .logo { font-family: var(--font-outfit); font-size: 28px; color: var(--accent-primary); line-height: 1; }
        :global(.mark) { flex-shrink: 0; display: block; }
        .kicker {
          margin: 0; font-family: var(--font-outfit); font-size: 11px; letter-spacing: 0.14em;
          text-transform: uppercase; color: var(--accent-secondary); font-weight: 700;
        }
        h1 { margin: 2px 0 6px; font-family: var(--font-outfit); font-size: clamp(22px, 4vw, 30px); font-weight: 800; }
        .lede { margin: 0; color: var(--text-muted); font-size: 14px; line-height: 1.5; max-width: 52ch; }
        .hold-badge {
          margin: 0; display: inline-flex; align-items: center; gap: 8px;
          font-family: var(--font-outfit); font-size: 12px; font-weight: 700;
          color: var(--accent-warning); border: 1px solid hsla(40, 90%, 58%, 0.35);
          background: hsla(40, 90%, 58%, 0.08); border-radius: 999px; padding: 8px 12px;
        }
        .pulse {
          width: 8px; height: 8px; border-radius: 50%; background: var(--accent-warning);
          transform-origin: center;
          animation: pulse 1.8s ease-out infinite;
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.45; transform: scale(0.85); }
        }
        @media (prefers-reduced-motion: reduce) {
          .pulse { animation: none; opacity: 1; transform: none; }
        }
        .toc {
          display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0;
        }
        .toc a {
          color: var(--text-main); text-decoration: none;
          border: 1px solid var(--border-color); border-radius: 999px;
          padding: 8px 12px; font-size: 13px; font-weight: 600; min-height: 44px;
          display: inline-flex; align-items: center;
          transition: color 160ms ease, border-color 160ms ease;
        }
        .toc a:hover { border-color: var(--accent-secondary); color: var(--accent-secondary); }
        .metrics {
          display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; margin-bottom: 16px;
        }
        @media (min-width: 768px) {
          .metrics { grid-template-columns: repeat(4, minmax(0, 1fr)); }
        }
        .metric {
          background: var(--bg-surface); border: 1px solid var(--border-color);
          border-radius: 12px; padding: 12px 14px; min-width: 0;
        }
        .metric-label { margin: 0; color: var(--text-muted); font-size: 11px; text-transform: uppercase; letter-spacing: 0.08em; font-weight: 700; }
        .metric-value { margin: 6px 0 0; font-family: var(--font-outfit); font-size: 18px; font-weight: 700; overflow-wrap: anywhere; font-variant-numeric: tabular-nums; }
        .metric-value.stop { color: var(--accent-warning); }
        .main { scroll-margin-top: 16px; }
        .panel {
          background: var(--bg-surface); border: 1px solid var(--border-color);
          border-radius: 16px; padding: 18px 18px 20px; margin-bottom: 14px; min-width: 0;
          scroll-margin-top: 16px;
        }
        h1, h2 { text-wrap: pretty; }
        h2 {
          margin: 0 0 8px; font-family: var(--font-outfit); font-size: 16px; font-weight: 700;
          display: flex; align-items: center; gap: 8px;
        }
        .panel-lede { margin: 0 0 14px; color: var(--text-muted); font-size: 13px; line-height: 1.55; }
        .blockers { margin: 0; padding-left: 18px; display: flex; flex-direction: column; gap: 8px; }
        .blockers li { color: var(--text-main); font-size: 14px; line-height: 1.5; overflow-wrap: anywhere; }
        .pin-grid, .stream-grid {
          list-style: none; margin: 0; padding: 0;
          display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px;
        }
        @media (min-width: 768px) {
          .pin-grid, .stream-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); }
        }
        .pin, .stream {
          background: hsla(240, 20%, 8%, 0.55); border: 1px solid hsla(240, 12%, 26%, 0.45);
          border-radius: 12px; padding: 12px 14px; min-width: 0;
        }
        .pin-meta, .stream-head { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 0 0 6px; }
        .layer, .posture, .evidence, .tag {
          font-family: var(--font-outfit); font-size: 10px; font-weight: 700; letter-spacing: 0.06em;
          text-transform: uppercase; border-radius: 4px; padding: 2px 6px;
          border: 1px solid hsla(270, 75%, 72%, 0.28); color: var(--accent-primary);
        }
        .posture { color: var(--accent-secondary); border-color: hsla(190, 80%, 58%, 0.3); }
        .evidence { color: var(--text-muted); border-color: var(--border-color); }
        .tag.quiet { color: var(--text-muted); border-color: var(--border-color); }
        .pin-repo, .sat-list a, .abs-head a {
          color: var(--text-main); font-weight: 700; font-size: 14px;
          overflow-wrap: anywhere; text-underline-offset: 3px;
        }
        .pin-repo:hover, .sat-list a:hover, .abs-head a:hover { color: var(--accent-secondary); }
        .pin-repo, .sat-list a, .abs-head a { transition: color 160ms ease; }
        .pin-role, .pin-next, .purpose, .w-does, .abs-pattern, .abs-refuse { margin: 6px 0 0; font-size: 12px; line-height: 1.5; color: var(--text-muted); overflow-wrap: anywhere; }
        .pin-next, .abs-refuse { color: var(--accent-warning); }
        .subhead { font-family: var(--font-outfit); font-size: 13px; margin: 16px 0 8px; }
        .sat-list { margin: 0; padding-left: 18px; color: var(--text-muted); font-size: 13px; }
        .sat-list li { margin-bottom: 6px; overflow-wrap: anywhere; }
        .queen { font-family: var(--font-outfit); font-weight: 700; }
        .loop { font-family: ui-monospace, monospace; font-size: 11px; color: var(--accent-secondary); overflow-wrap: anywhere; }
        .workers { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
        .workers li { background: hsla(240, 20%, 5%, 0.55); border-radius: 8px; padding: 8px 10px; }
        .w-name { font-weight: 600; font-size: 13px; margin-right: 8px; }
        .w-skill { font-family: ui-monospace, monospace; font-size: 11px; color: var(--accent-secondary); }
        .w-does { display: block; margin-top: 2px; }
        .split { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; }
        @media (min-width: 900px) { .split { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
        .ladder, .clauses, .absorbed, .criteria { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
        .rung, .clauses li, .absorbed li, .criteria li {
          background: hsla(240, 20%, 8%, 0.55); border-radius: 10px; padding: 10px 12px;
          border-left: 3px solid var(--accent-secondary);
        }
        .rung.ok { border-left-color: var(--accent-success); }
        .rung.info { border-left-color: var(--accent-secondary); }
        .rung.hold { border-left-color: var(--accent-warning); }
        .rung.stop { border-left-color: var(--accent-danger); }
        .tier { display: block; font-family: var(--font-outfit); font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: 0.06em; }
        .who { display: block; font-size: 13px; font-weight: 600; margin: 2px 0; }
        .gate, .clauses li { font-size: 12px; color: var(--text-muted); line-height: 1.45; }
        .clause-id { display: block; color: var(--accent-primary); font-family: var(--font-outfit); font-size: 11px; font-weight: 700; margin-bottom: 2px; }
        .abs-head { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 0 0 4px; }
        .abs-name { margin: 0; font-weight: 600; font-size: 13px; }
        .criteria li { display: grid; grid-template-columns: auto auto 1fr; gap: 8px; align-items: baseline; }
        .cid { font-family: var(--font-outfit); font-weight: 800; font-size: 12px; }
        .cstat { font-size: 11px; font-weight: 700; text-transform: uppercase; color: var(--accent-success); }
        .criteria li.open .cstat { color: var(--accent-warning); }
        .cdemand { font-size: 13px; overflow-wrap: anywhere; }
        @media (max-width: 520px) {
          .criteria li { grid-template-columns: auto 1fr; }
          .cdemand { grid-column: 1 / -1; }
        }
      `}</style>
    </div>
  );
}
