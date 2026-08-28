/**
 * /identities — Starlight agent identity atlas.
 *
 * Japanese craft names × global excellence lineages × managed channels,
 * mapped onto real L6 stream seats and God Mode domain queens.
 * Read-only. No action fires from this page.
 */
import React, { useEffect, useId, useState } from 'react';
import Head from 'next/head';
import Image from 'next/image';
import Link from 'next/link';
import { useRouter } from 'next/router';
import type { GetStaticProps } from 'next';
import { identitiesTree } from '@/swarm/identities';

type Tree = ReturnType<typeof identitiesTree>;

export const getStaticProps: GetStaticProps<{ tree: Tree }> = async () => {
  return { props: { tree: identitiesTree() } };
};

const KIND_LABEL: Record<string, string> = {
  website: 'Website',
  social: 'Social',
  product: 'Product',
  ledger: 'Ledger',
  internal: 'Internal',
  creative: 'Creative',
};

export default function IdentitiesAtlas({ tree }: { tree: Tree }) {
  const router = useRouter();
  const queens = tree.agents.filter((a) => a.tier === 'sovereign' || a.tier === 'queen');
  const workers = tree.agents.filter((a) => a.tier === 'worker');
  const fallbackId = queens[0]?.id ?? tree.agents[0]?.id ?? '';
  const queryId = typeof router.query.id === 'string' ? router.query.id : '';
  const resolvedId = tree.agents.some((a) => a.id === queryId) ? queryId : fallbackId;
  const [activeId, setActiveId] = useState(fallbackId);
  const active = tree.agents.find((a) => a.id === activeId) ?? tree.agents[0];
  const panelId = useId();

  useEffect(() => {
    if (!router.isReady) return;
    setActiveId(resolvedId);
  }, [router.isReady, resolvedId]);

  const selectAgent = (id: string) => {
    setActiveId(id);
    void router.replace({ pathname: '/identities', query: { id } }, undefined, { shallow: true });
  };

  return (
    <div className="atlas">
      <Head>
        <title>Starlight Identities — 星の女王 Atlas</title>
        <meta
          name="description"
          content="Japanese craft identities for Starlight swarm queens and key workers — roles, channels, and link to Starlight Queen."
        />
        <meta name="theme-color" content="#0a0c10" />
        <meta name="color-scheme" content="dark" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link
          href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@300;400;500;700&family=Noto+Serif+JP:wght@400;500;600;700&family=Syne:wght@500;600;700;800&display=swap"
          rel="stylesheet"
        />
      </Head>

      <a className="skip" href="#atlas-main">
        Skip to identity desk
      </a>

      <div className="atmosphere" aria-hidden="true" />

      <header className="top">
        <Link className="back" href="/swarm">
          ← L6 swarm
        </Link>
        <p className="wave">{tree.wave}</p>
      </header>

      <main id="atlas-main">
      <section className="hero">
        <p className="brand" translate="no">
          STARLIGHT
        </p>
        <h1>
          <span className="jp">星の女王</span>
          <span className="en">Identity Atlas</span>
        </h1>
        <p className="lede">
          Japanese craft thinking × English &amp; global output × US / EU / CN / JP excellence —
          keyed to Starlight Queen and the swarms that already run here.
        </p>
      </section>

      <section className="strip" aria-label="Queen identities">
        {queens.map((q) => (
          <button
            key={q.id}
            type="button"
            className={`strip-btn${activeId === q.id ? ' is-active' : ''}`}
            style={{ ['--accent' as string]: q.accent }}
            aria-pressed={activeId === q.id}
            aria-controls={panelId}
            aria-label={`${q.romaji}, ${q.enName}`}
            onClick={() => selectAgent(q.id)}
          >
            <span className="strip-portrait">
              <Image
                src={q.portrait}
                alt=""
                width={96}
                height={96}
                sizes="96px"
              />
            </span>
            <span className="strip-jp">{q.jpName}</span>
            <span className="strip-en">{q.romaji}</span>
          </button>
        ))}
      </section>

      {active && (
        <section
          id={panelId}
          className="focus"
          style={{ ['--accent' as string]: active.accent }}
          aria-live="polite"
        >
          <div className="focus-visual">
            <Image
              src={active.portrait}
              alt={`${active.romaji} — ${active.enName}`}
              width={720}
              height={720}
              sizes="(max-width: 900px) 100vw, 42vw"
              priority
            />
          </div>
          <div className="focus-copy">
            <p className="tier">{active.tier}</p>
            <h2>
              <span className="focus-jp">{active.jpName}</span>
              <span className="focus-romaji">{active.romaji}</span>
            </h2>
            <p className="focus-en">{active.enName}</p>
            <p className="focus-role">{active.role}</p>

            <div className="block">
              <h3>Japanese quality</h3>
              <p>{active.japaneseQuality}</p>
            </div>

            <div className="block">
              <h3>Starlight Queen link</h3>
              <p>{active.queenLink}</p>
            </div>

            <div className="block">
              <h3>Global lineages</h3>
              <ul className="lineages">
                {active.globalLineages.map((g) => (
                  <li key={g}>{g}</li>
                ))}
              </ul>
            </div>

            <div className="block">
              <h3>Channels &amp; outputs</h3>
              <ul className="channels">
                {active.channels.map((c) => (
                  <li key={c.label}>
                    <div className="ch-head">
                      <span className="ch-kind">{KIND_LABEL[c.kind] ?? c.kind}</span>
                      <span className="ch-label">{c.label}</span>
                    </div>
                    <p className="ch-out">{c.outputs.join(' · ')}</p>
                  </li>
                ))}
              </ul>
            </div>

            {(active.streamSeat || active.domainQueenId) && (
              <p className="seat-map">
                {active.streamSeat && (
                  <>
                    L6 seat: <code>{active.streamSeat}</code>
                  </>
                )}
                {active.streamSeat && active.domainQueenId && ' · '}
                {active.domainQueenId && (
                  <>
                    Domain id: <code>{active.domainQueenId}</code>
                  </>
                )}
              </p>
            )}
          </div>
        </section>
      )}

      <section className="workers">
        <h2>Key workers with desks</h2>
        <p className="workers-lede">
          Own interface for the links, sites, and social drafts they prepare — queen-gated publish.
        </p>
        <div className="worker-grid">
          {workers.map((w) => (
            <article key={w.id} className="worker" style={{ ['--accent' as string]: w.accent }}>
              <button
                type="button"
                className="worker-open"
                onClick={() => selectAgent(w.id)}
                aria-controls={panelId}
                aria-label={`Open ${w.romaji} desk`}
              >
                <Image src={w.portrait} alt="" width={120} height={120} sizes="120px" />
                <div>
                  <p className="worker-jp">{w.jpName}</p>
                  <p className="worker-en">{w.romaji} · {w.enName}</p>
                  <p className="worker-role">{w.role}</p>
                </div>
              </button>
              <ul className="worker-channels">
                {w.channels.map((c) => (
                  <li key={c.label}>
                    <strong>{KIND_LABEL[c.kind]}</strong> — {c.label}
                    <span>{c.outputs.join(', ')}</span>
                  </li>
                ))}
              </ul>
            </article>
          ))}
        </div>
      </section>

      <section className="evolve">
        <h2>What exists · what to evolve</h2>
        <div className="evolve-grid">
          <div>
            <h3>Have now</h3>
            <ul>
              <li>L6 streams: Affiliate · Products · Content · Payments under founder</li>
              <li>God Mode domain queens (FrankX, Arcanea, GenCreator, SIS, Control, Wealth)</li>
              <li>Starlight Queen / Hermes owns admission, leases, Hands</li>
              <li>This atlas — first JP identity wave + portraits</li>
              <li>Cockpit at <Link href="/">/</Link> and topology at <Link href="/swarm">/swarm</Link></li>
            </ul>
          </div>
          <div>
            <h3>Evolve next</h3>
            <ul>
              <li>Portrait every General + specialist swarm lead</li>
              <li>Per-agent operator UI: live links, calendars, draft queues</li>
              <li>Wire channel hrefs to real properties (still queen-gated)</li>
              <li>FrankX / Control / Wealth JP identities (same craft bar)</li>
              <li>Observatory projection of this atlas (canonical operator UI)</li>
              <li>Bilingual EN↔JP mission briefs in team packs</li>
            </ul>
          </div>
        </div>
        <p className="footnote">{tree.note}</p>
      </section>
      </main>

      <style jsx global>{`
        :root {
          --ink: #0a0c10;
          --ink-elev: #12151c;
          --paper: #e8e2d6;
          --muted: #9a9388;
          --vermillion: #c23b22;
          --brass: #c4a574;
          --line: rgba(232, 226, 214, 0.12);
          --font-display: 'Noto Serif JP', 'Syne', serif;
          --font-ui: 'Noto Sans JP', 'Syne', sans-serif;
          --font-mark: 'Syne', 'Noto Sans JP', sans-serif;
          color-scheme: dark;
        }
        * { box-sizing: border-box; }
        html { scroll-behavior: smooth; color-scheme: dark; }
        @media (prefers-reduced-motion: reduce) {
          html { scroll-behavior: auto; }
          *, *::before, *::after {
            animation-duration: 0.01ms !important;
            animation-iteration-count: 1 !important;
            transition-duration: 0.01ms !important;
          }
        }
        body {
          margin: 0;
          min-height: 100vh;
          background: var(--ink);
          color: var(--paper);
          font-family: var(--font-ui);
          font-size: 16px;
          line-height: 1.55;
          -webkit-tap-highlight-color: rgba(194, 59, 34, 0.25);
          overflow-x: hidden;
        }
        a { color: var(--brass); }
        a:focus-visible, button:focus-visible {
          outline: 2px solid var(--vermillion);
          outline-offset: 3px;
        }
        code {
          font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
          font-size: 0.85em;
          color: var(--brass);
        }
      `}</style>

      <style jsx>{`
        .skip {
          position: absolute;
          left: -9999px;
          top: 0;
          background: var(--vermillion);
          color: #fff;
          padding: 8px 12px;
          z-index: 100;
          text-decoration: none;
          font-weight: 600;
        }
        .skip:focus {
          left: 16px;
          top: 16px;
        }
        .atlas {
          position: relative;
          max-width: 1280px;
          margin: 0 auto;
          padding: 28px 24px 80px;
          padding-left: max(24px, env(safe-area-inset-left));
          padding-right: max(24px, env(safe-area-inset-right));
        }
        .atmosphere {
          position: fixed;
          inset: 0;
          z-index: -1;
          pointer-events: none;
          background:
            radial-gradient(ellipse 80% 50% at 10% -10%, rgba(194, 59, 34, 0.18), transparent 55%),
            radial-gradient(ellipse 60% 40% at 90% 0%, rgba(196, 165, 116, 0.1), transparent 50%),
            linear-gradient(180deg, #0a0c10 0%, #0e1118 50%, #0a0c10 100%);
        }
        .top {
          display: flex;
          justify-content: space-between;
          align-items: center;
          gap: 16px;
          margin-bottom: 48px;
        }
        .back {
          font-family: var(--font-mark);
          font-size: 13px;
          font-weight: 600;
          letter-spacing: 0.04em;
          text-decoration: none;
          color: var(--paper);
          opacity: 0.75;
          transition: opacity 180ms ease;
          cursor: pointer;
          touch-action: manipulation;
        }
        .back:hover { opacity: 1; }
        .wave {
          margin: 0;
          font-size: 11px;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: var(--muted);
        }
        .hero {
          max-width: 720px;
          margin-bottom: 48px;
          animation: rise 700ms ease both;
        }
        .brand {
          margin: 0 0 12px;
          font-family: var(--font-mark);
          font-size: clamp(28px, 6vw, 56px);
          font-weight: 800;
          letter-spacing: 0.18em;
          line-height: 1;
          color: var(--paper);
          text-wrap: balance;
        }
        h1 {
          margin: 0 0 18px;
          display: flex;
          flex-direction: column;
          gap: 6px;
          text-wrap: balance;
        }
        .jp {
          font-family: var(--font-display);
          font-size: clamp(40px, 8vw, 72px);
          font-weight: 600;
          line-height: 1.1;
          color: var(--vermillion);
        }
        .en {
          font-family: var(--font-mark);
          font-size: clamp(18px, 3vw, 28px);
          font-weight: 600;
          letter-spacing: 0.06em;
          color: var(--brass);
        }
        .lede {
          margin: 0;
          max-width: 38rem;
          color: var(--muted);
          font-weight: 300;
          font-size: 15px;
          text-wrap: pretty;
        }
        .strip {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
          gap: 12px;
          margin-bottom: 40px;
        }
        .strip-btn {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 8px;
          padding: 12px 8px;
          min-height: 44px;
          background: transparent;
          border: 1px solid var(--line);
          border-radius: 0;
          color: var(--paper);
          cursor: pointer;
          touch-action: manipulation;
          transition: border-color 180ms ease, background-color 180ms ease;
        }
        .strip-btn:hover {
          border-color: color-mix(in srgb, var(--accent) 55%, transparent);
          background: color-mix(in srgb, var(--accent) 8%, transparent);
        }
        .strip-btn.is-active {
          border-color: var(--accent);
          background: color-mix(in srgb, var(--accent) 12%, transparent);
        }
        .strip-portrait {
          display: block;
          width: 64px;
          height: 64px;
          overflow: hidden;
          border-radius: 50%;
          border: 1px solid var(--line);
        }
        .strip-portrait :global(img) {
          width: 100%;
          height: 100%;
          object-fit: cover;
        }
        .strip-jp {
          font-family: var(--font-display);
          font-size: 18px;
          line-height: 1.2;
        }
        .strip-en {
          font-size: 10px;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--muted);
        }
        .focus {
          display: grid;
          grid-template-columns: minmax(0, 0.95fr) minmax(0, 1.05fr);
          gap: 40px;
          align-items: start;
          margin-bottom: 72px;
          animation: rise 500ms ease both;
          scroll-margin-top: 24px;
        }
        .focus-visual {
          position: sticky;
          top: 24px;
          aspect-ratio: 1;
          overflow: hidden;
          border: 1px solid var(--line);
          background: var(--ink-elev);
        }
        .focus-visual :global(img) {
          width: 100%;
          height: 100%;
          object-fit: cover;
          display: block;
        }
        .tier {
          margin: 0 0 8px;
          font-family: var(--font-mark);
          font-size: 11px;
          letter-spacing: 0.16em;
          text-transform: uppercase;
          color: var(--accent);
        }
        .focus-copy h2 {
          margin: 0 0 6px;
          display: flex;
          flex-wrap: wrap;
          align-items: baseline;
          gap: 12px 16px;
          text-wrap: balance;
        }
        .focus-jp {
          font-family: var(--font-display);
          font-size: clamp(36px, 5vw, 52px);
          font-weight: 600;
          line-height: 1.15;
        }
        .focus-romaji {
          font-family: var(--font-mark);
          font-size: 16px;
          color: var(--brass);
        }
        .focus-en {
          margin: 0 0 16px;
          font-size: 14px;
          color: var(--muted);
        }
        .focus-role {
          margin: 0 0 28px;
          font-size: 16px;
          max-width: 36rem;
        }
        .block {
          margin-bottom: 22px;
          padding-top: 16px;
          border-top: 1px solid var(--line);
        }
        .block h3 {
          margin: 0 0 8px;
          font-family: var(--font-mark);
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.14em;
          text-transform: uppercase;
          color: var(--brass);
        }
        .block p {
          margin: 0;
          color: var(--paper);
          opacity: 0.92;
          overflow-wrap: break-word;
        }
        .lineages, .channels, .worker-channels, .evolve ul {
          margin: 0;
          padding: 0;
          list-style: none;
        }
        .lineages li {
          position: relative;
          padding: 6px 0 6px 14px;
          color: var(--muted);
          font-size: 14px;
        }
        .lineages li::before {
          content: '';
          position: absolute;
          left: 0;
          top: 0.85em;
          width: 6px;
          height: 1px;
          background: var(--accent);
        }
        .channels li {
          padding: 12px 0;
          border-bottom: 1px solid var(--line);
        }
        .ch-head {
          display: flex;
          flex-wrap: wrap;
          gap: 8px 12px;
          align-items: baseline;
          margin-bottom: 4px;
        }
        .ch-kind {
          font-size: 10px;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: var(--accent);
          font-weight: 700;
        }
        .ch-label { font-weight: 500; overflow-wrap: break-word; }
        .ch-out {
          margin: 0;
          font-size: 13px;
          color: var(--muted);
        }
        .seat-map {
          margin: 20px 0 0;
          font-size: 12px;
          color: var(--muted);
        }
        .workers {
          margin-bottom: 72px;
        }
        .workers h2, .evolve h2 {
          margin: 0 0 8px;
          font-family: var(--font-display);
          font-size: 28px;
          font-weight: 600;
          text-wrap: balance;
        }
        .workers-lede {
          margin: 0 0 24px;
          color: var(--muted);
          font-size: 14px;
        }
        .worker-grid {
          display: grid;
          grid-template-columns: 1fr;
          gap: 20px;
        }
        .worker {
          border-top: 1px solid var(--line);
          padding-top: 20px;
        }
        .worker-open {
          display: flex;
          gap: 16px;
          align-items: flex-start;
          width: 100%;
          padding: 0;
          min-height: 44px;
          background: none;
          border: none;
          color: inherit;
          text-align: left;
          cursor: pointer;
          touch-action: manipulation;
        }
        .worker-open :global(img) {
          border-radius: 50%;
          border: 1px solid var(--line);
          flex-shrink: 0;
        }
        .worker-jp {
          margin: 0;
          font-family: var(--font-display);
          font-size: 24px;
        }
        .worker-en {
          margin: 4px 0;
          font-size: 12px;
          letter-spacing: 0.06em;
          text-transform: uppercase;
          color: var(--brass);
        }
        .worker-role {
          margin: 0;
          font-size: 14px;
          color: var(--muted);
        }
        .worker-channels {
          margin-top: 14px;
          padding-left: 136px;
        }
        .worker-channels li {
          font-size: 13px;
          padding: 6px 0;
          color: var(--paper);
        }
        .worker-channels span {
          display: block;
          color: var(--muted);
          font-size: 12px;
          margin-top: 2px;
        }
        .evolve-grid {
          display: grid;
          grid-template-columns: 1fr 1fr;
          gap: 32px;
          margin-top: 20px;
        }
        .evolve h3 {
          margin: 0 0 12px;
          font-family: var(--font-mark);
          font-size: 12px;
          letter-spacing: 0.12em;
          text-transform: uppercase;
          color: var(--vermillion);
        }
        .evolve li {
          padding: 8px 0;
          border-bottom: 1px solid var(--line);
          font-size: 14px;
          color: var(--muted);
        }
        .footnote {
          margin: 28px 0 0;
          font-size: 12px;
          color: var(--muted);
        }
        @keyframes rise {
          from { opacity: 0; transform: translateY(12px); }
          to { opacity: 1; transform: translateY(0); }
        }
        @media (max-width: 900px) {
          .focus {
            grid-template-columns: 1fr;
            gap: 24px;
          }
          .focus-visual { position: static; }
          .evolve-grid { grid-template-columns: 1fr; }
          .worker-channels { padding-left: 0; margin-top: 12px; }
        }
        @media (max-width: 480px) {
          .atlas { padding: 20px 16px 64px; overflow-x: clip; }
          .brand { letter-spacing: 0.08em; font-size: clamp(22px, 9vw, 36px); }
          .strip { grid-template-columns: repeat(3, 1fr); gap: 8px; }
          .strip-btn { padding: 8px 4px; min-width: 0; }
          .strip-en { font-size: 9px; letter-spacing: 0.02em; max-width: 100%; overflow-wrap: anywhere; }
        }
      `}</style>
    </div>
  );
}
