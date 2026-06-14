/**
 * /swarm — static cockpit view of the L6 Swarm Runtime.
 *
 * Renders the founder → queen → worker tree and the escalation legend from the
 * typed config in src/swarm/streams.ts. Read-only. No action fires from this page.
 * The shape comes through getStaticProps so we never bundle node-only modules
 * into the client.
 */
import React from 'react';
import Head from 'next/head';
import type { GetStaticProps } from 'next';
import { swarmTree } from '@/swarm/streams';

type Tree = ReturnType<typeof swarmTree>;

const LADDER: Array<{ tier: string; who: string; gate: string; color: string }> = [
  { tier: 'autonomous', who: 'Worker → Queen', gate: 'queen review (reversible, no money)', color: 'var(--accent-success)' },
  { tier: 'queen-gate', who: 'Queen', gate: 'brand/claims gate · AP2 mandate + spend-cap (verify-only)', color: 'var(--accent-secondary)' },
  { tier: 'founder-board', who: 'Founder', gate: '/starlight-board pressure-test + human approval', color: 'var(--accent-warning)' },
  { tier: 'human-gate', who: 'Human', gate: 'irreversible + money = human approval, ALWAYS', color: 'var(--accent-danger)' },
];

export const getStaticProps: GetStaticProps<{ tree: Tree }> = async () => {
  return { props: { tree: swarmTree() } };
};

export default function SwarmCockpit({ tree }: { tree: Tree }) {
  return (
    <div className="cockpit-container">
      <Head>
        <title>Starlight Swarm — L6 Runtime</title>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Outfit:wght@300;400;500;600;700;800&display=swap" rel="stylesheet" />
      </Head>

      <header>
        <div className="brand">
          <div className="brand-logo">✦</div>
          <div>
            <h1>STARLIGHT SWARM — L6 RUNTIME</h1>
            <p className="subtitle">Hybrid queens-per-stream · v0.1 scaffold · dry-run only — no action fires</p>
          </div>
        </div>
        <div className="header-status">
          <span className="pulse-dot" />
          <span>SCAFFOLD (DRY-RUN)</span>
        </div>
      </header>

      <main className="dashboard-grid">
        <section className="card founder-card">
          <h2>👑 Founder</h2>
          <div className="founder-name">{tree.founder.name}</div>
          <div className="muted">gate: <span className="code">{tree.founder.gate}</span></div>
          <div className="muted" style={{ marginTop: 8 }}>thesis ← {tree.founder.thesisSource}</div>
          <ul className="owns">
            {tree.founder.owns.map((o, i) => (
              <li key={i}>{o}</li>
            ))}
          </ul>
        </section>

        <section className="card legend-card">
          <h2>🪜 Escalation Ladder</h2>
          <div className="ladder">
            {LADDER.map((l) => (
              <div className="ladder-row" key={l.tier} style={{ borderLeftColor: l.color }}>
                <span className="ladder-tier" style={{ color: l.color }}>{l.tier}</span>
                <span className="ladder-who">{l.who}</span>
                <span className="ladder-gate muted">{l.gate}</span>
              </div>
            ))}
          </div>
          <p className="muted footnote">
            worker → queen → founder → human. No autonomous money movement, ever.
          </p>
        </section>

        <section className="card streams-card">
          <h2>🐝 Stream Queens &amp; Worker Mesh</h2>
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

      <style jsx global>{`
        :root {
          --bg-base: hsl(240, 20%, 6%);
          --bg-surface: hsla(240, 16%, 12%, 0.7);
          --border-color: hsla(240, 10%, 20%, 0.4);
          --accent-primary: hsl(270, 75%, 65%);
          --accent-secondary: hsl(190, 80%, 55%);
          --accent-success: hsl(145, 75%, 45%);
          --accent-warning: hsl(40, 85%, 55%);
          --accent-danger: hsl(355, 80%, 55%);
          --text-main: hsl(0, 0%, 93%);
          --text-muted: hsl(240, 8%, 65%);
          --font-outfit: 'Outfit', sans-serif;
          --font-inter: 'Inter', sans-serif;
        }
        body {
          background-color: var(--bg-base);
          background-image: radial-gradient(at 10% 10%, hsla(270, 50%, 15%, 0.2) 0px, transparent 50%),
            radial-gradient(at 90% 90%, hsla(190, 50%, 15%, 0.2) 0px, transparent 50%);
          color: var(--text-main);
          font-family: var(--font-inter);
          min-height: 100vh;
          margin: 0;
          padding: 24px;
        }
        .cockpit-container { max-width: 1400px; margin: 0 auto; }
        header {
          display: flex; justify-content: space-between; align-items: center;
          background: var(--bg-surface); backdrop-filter: blur(16px);
          border: 1px solid var(--border-color); border-radius: 16px;
          padding: 16px 28px; margin-bottom: 24px;
        }
        .brand { display: flex; align-items: center; gap: 16px; }
        .brand-logo { font-size: 32px; font-family: var(--font-outfit); color: var(--accent-primary); text-shadow: 0 0 10px hsla(270, 75%, 65%, 0.5); }
        h1 { font-family: var(--font-outfit); font-size: 20px; font-weight: 800; letter-spacing: 0.5px; margin: 0; }
        .subtitle { font-size: 12px; color: var(--text-muted); margin: 4px 0 0; }
        .header-status { display: flex; align-items: center; gap: 10px; font-family: var(--font-outfit); font-size: 13px; font-weight: 600; }
        .pulse-dot { width: 8px; height: 8px; background: var(--accent-warning); border-radius: 50%; box-shadow: 0 0 8px var(--accent-warning); }
        .dashboard-grid { display: grid; grid-template-columns: 1fr 2fr; gap: 24px; }
        .card { background: var(--bg-surface); backdrop-filter: blur(16px); border: 1px solid var(--border-color); border-radius: 16px; padding: 24px; }
        h2 { font-family: var(--font-outfit); font-size: 16px; font-weight: 700; margin: 0 0 16px; letter-spacing: 0.5px; }
        .muted { color: var(--text-muted); }
        .code { font-family: monospace; color: var(--accent-secondary); }
        .founder-name { font-family: var(--font-outfit); font-size: 18px; font-weight: 700; color: var(--accent-primary); margin-bottom: 6px; }
        .owns { margin: 14px 0 0; padding-left: 18px; font-size: 13px; line-height: 1.6; }
        .ladder { display: flex; flex-direction: column; gap: 10px; }
        .ladder-row { display: grid; grid-template-columns: 120px 130px 1fr; gap: 10px; align-items: baseline; background: hsla(240, 10%, 15%, 0.4); border-left: 3px solid; padding: 10px 14px; border-radius: 10px; font-size: 12px; }
        .ladder-tier { font-family: var(--font-outfit); font-weight: 700; text-transform: uppercase; font-size: 11px; }
        .footnote { font-size: 12px; margin-top: 14px; }
        .streams-card { grid-column: span 2; }
        .streams-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; }
        .stream { background: hsla(240, 10%, 15%, 0.4); border: 1px solid hsla(240, 10%, 20%, 0.25); border-radius: 12px; padding: 18px; }
        .stream-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; }
        .queen-name { font-family: var(--font-outfit); font-weight: 700; font-size: 15px; }
        .role-tag { font-family: var(--font-outfit); font-size: 11px; font-weight: 600; background: hsla(270, 75%, 65%, 0.1); color: var(--accent-primary); border: 1px solid hsla(270, 75%, 65%, 0.2); padding: 2px 8px; border-radius: 4px; }
        .purpose { font-size: 12px; }
        .loop { font-size: 12px; color: var(--accent-secondary); margin: 8px 0 12px; font-family: monospace; }
        .workers { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
        .workers li { background: hsla(240, 20%, 8%, 0.6); border-radius: 8px; padding: 8px 12px; }
        .worker-name { font-weight: 600; font-size: 13px; margin-right: 8px; }
        .worker-skill { font-size: 11px; }
        .worker-does { font-size: 11px; margin-top: 2px; }
        .mcp { font-size: 11px; margin-top: 12px; line-height: 1.5; }
        @media (max-width: 900px) { .dashboard-grid, .streams-grid { grid-template-columns: 1fr; } .streams-card { grid-column: span 1; } }
      `}</style>
    </div>
  );
}
