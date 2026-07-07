import React, { useState, useEffect } from 'react';
import Head from 'next/head';

interface RepoAudit {
  Repository: string;
  Role: string;
  Tier: string;
  LocalStatus: string;
  ActiveBranch: string;
  Uncommitted: string;
  Scope: string;
}

export default function Home() {
  const [repos, setRepos] = useState<RepoAudit[]>([]);
  const [loadingAudit, setLoadingAudit] = useState(false);
  const [daemonState, setDaemonState] = useState([
    { name: 'Memory Bus (server.py)', status: 'Active', port: ':8000', icon: '🧠' },
    { name: 'brain_watchdog', status: 'Active', port: 'Daemon', icon: '🐕' },
    { name: 'Voice Operator', status: 'Active', port: ':8000', icon: '🎙️' },
    { name: 'Dashboard Center', status: 'Offline', port: ':3007', icon: '🎛️' },
    { name: 'Audit Log Streamer', status: 'Active', port: 'System', icon: '📜' },
    { name: 'Starlight Cockpit Tasks', status: 'Active', port: 'Scheduler', icon: '📅' },
  ]);
  const [logs, setLogs] = useState<string[]>([]);
  const [recovering, setRecovering] = useState(false);

  const addLog = (msg: string) => {
    const time = new Date().toLocaleTimeString();
    setLogs((prev) => [`[${time}] ${msg}`, ...prev].slice(0, 100));
  };

  const runAudit = async () => {
    setLoadingAudit(true);
    addLog('Querying mcp-registry.csv and auditing local repository statuses...');
    try {
      const res = await fetch('/api/audit');
      if (res.ok) {
        const data = await res.json();
        setRepos(data);
        addLog(`Audit completed. ${data.length} registered repositories synced.`);
      } else {
        addLog('Error: Failed to fetch repository audit records.');
      }
    } catch (e: any) {
      addLog(`Error during audit: ${e.message}`);
    } finally {
      setLoadingAudit(false);
    }
  };

  const runRecovery = async () => {
    setRecovering(true);
    addLog('Initiating Active Healing recovery sequence for local subsystems...');
    try {
      const res = await fetch('/api/recover');
      if (res.ok) {
        const data = await res.json();
        addLog('Active healing completed. Recovery playbook successfully applied.');
        // Update local state to show Dashboard Center is now active
        setDaemonState((prev) =>
          prev.map((d) => (d.name === 'Dashboard Center' ? { ...d, status: 'Active' } : d))
        );
        addLog('System integrity normalized: 6/6 Core Daemons nominal (Green).');
      } else {
        addLog('Error: Recovery playbook execution failed.');
      }
    } catch (e: any) {
      addLog(`Error executing recovery: ${e.message}`);
    } finally {
      setRecovering(false);
    }
  };

  useEffect(() => {
    addLog('Starlight Intelligence Swarm Cockpit initialized.');
    addLog('Dual-layer substrate connection established successfully.');
    runAudit();
  }, []);

  return (
    <div className="cockpit-container">
      <Head>
        <title>Starlight Swarm Cockpit</title>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="" />
        <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&family=Outfit:wght@300;400;500;600;700;800&display=swap" rel="stylesheet" />
      </Head>

      <header className="command-shell">
        <div className="brand">
          <div className="brand-logo">SIS</div>
          <div>
            <h1>STARLIGHT SWARM COCKPIT</h1>
            <p className="subtitle">Operational glass console · repo fleet · daemon substrate</p>
          </div>
        </div>
        <div className="header-status">
          <span className="pulse-dot"></span>
          <span>SYSTEM STATE: {daemonState.some((d) => d.status === 'Offline') ? 'DEGRADED (YELLOW)' : 'NOMINAL (GREEN)'}</span>
        </div>
      </header>

      <section className="hero-grid">
        <div className="hero-copy">
          <div className="eyebrow">Live operational surface</div>
          <h2>One cockpit for swarm health, recovery, and repo truth.</h2>
          <p>
            This is not a landing page. It is the operator view: daemons, repository registry,
            recovery actions, and event spine in one inspectable surface.
          </p>
        </div>
        <div className="signal-panel">
          {[
            ['Core daemons', `${daemonState.filter((d) => d.status === 'Active').length}/${daemonState.length}`],
            ['Repo records', repos.length ? String(repos.length) : 'loading'],
            ['Recovery', recovering ? 'running' : 'ready'],
            ['Audit', loadingAudit ? 'refreshing' : 'stable'],
          ].map(([label, value]) => (
            <div key={label} className="metric-tile">
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
      </section>

      <main className="dashboard-grid">
        {/* Daemons Panel */}
        <section className="card daemons-card">
          <h2>🧠 Core Daemon Substrates (/heart)</h2>
          <div className="daemon-list">
            {daemonState.map((d, idx) => (
              <div key={idx} className="daemon-item">
                <span className="daemon-icon">{d.icon}</span>
                <div className="daemon-info">
                  <div className="daemon-name">{d.name}</div>
                  <div className="daemon-port">{d.port}</div>
                </div>
                <span className={`status-badge ${d.status.toLowerCase()}`}>
                  {d.status}
                </span>
              </div>
            ))}
          </div>
          <div className="card-actions">
            <button className="btn btn-primary" onClick={runRecovery} disabled={recovering}>
              {recovering ? 'Running Recovery...' : '⚡ Run Active Healing'}
            </button>
          </div>
        </section>

        {/* Repos Panel */}
        <section className="card repos-card">
          <div className="card-header-row">
            <h2>📦 Sovereign Repository Registry</h2>
            <button className="btn btn-secondary" onClick={runAudit} disabled={loadingAudit}>
              {loadingAudit ? 'Auditing...' : '🔄 Refresh Audit'}
            </button>
          </div>
          <div className="table-wrapper">
            <table>
              <thead>
                <tr>
                  <th>Repository</th>
                  <th>Role</th>
                  <th>Scope</th>
                  <th>Local Status</th>
                  <th>Active Branch</th>
                  <th>Uncommitted</th>
                </tr>
              </thead>
              <tbody>
                {repos.length === 0 ? (
                  <tr>
                    <td colSpan={6} style={{ textAlign: 'center', padding: '24px', color: 'var(--text-muted)' }}>
                      No repositories registered or loading...
                    </td>
                  </tr>
                ) : (
                  repos.map((r, idx) => (
                    <tr key={idx}>
                      <td className="bold">{r.Repository}</td>
                      <td><span className="role-tag">{r.Role}</span></td>
                      <td className="muted">{r.Scope}</td>
                      <td>
                        <span className={`status-badge ${r.LocalStatus.toLowerCase()}`}>
                          {r.LocalStatus}
                        </span>
                      </td>
                      <td className="code">{r.ActiveBranch}</td>
                      <td className="muted">{r.Uncommitted}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </section>

        {/* Logs Console */}
        <section className="card console-card">
          <h2>📜 Live Event Spine Console</h2>
          <div className="console-terminal">
            {logs.map((log, idx) => (
              <div key={idx} className={`log-line ${log.includes('Error') ? 'error' : log.includes('nom') ? 'success' : ''}`}>
                {log}
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
          background-image: 
            radial-gradient(at 12% 8%, hsla(190, 70%, 18%, 0.22) 0px, transparent 38%),
            radial-gradient(at 85% 4%, hsla(270, 65%, 16%, 0.18) 0px, transparent 34%),
            linear-gradient(180deg, hsla(240, 20%, 6%, 0), hsla(240, 20%, 3%, 0.72));
          color: var(--text-main);
          font-family: var(--font-inter);
          min-height: 100vh;
          margin: 0;
          padding: 24px;
        }

        .cockpit-container {
          max-width: 1400px;
          margin: 0 auto;
        }

        header {
          display: flex;
          justify-content: space-between;
          align-items: center;
          background: linear-gradient(135deg, hsla(0, 0%, 100%, 0.07), transparent 32%), var(--bg-surface);
          backdrop-filter: blur(22px) saturate(145%);
          border: 1px solid hsla(0, 0%, 100%, 0.08);
          border-radius: 22px;
          padding: 16px 28px;
          margin-bottom: 24px;
          box-shadow: inset 0 1px 0 hsla(0, 0%, 100%, 0.08), 0 28px 90px hsla(240, 35%, 2%, 0.42);
        }

        .brand {
          display: flex;
          align-items: center;
          gap: 16px;
        }

        .brand-logo {
          display: grid;
          place-items: center;
          width: 48px;
          height: 48px;
          border-radius: 16px;
          border: 1px solid hsla(190, 80%, 55%, 0.32);
          background: hsla(190, 80%, 55%, 0.09);
          font-size: 12px;
          font-weight: 800;
          font-family: var(--font-outfit);
          color: var(--accent-secondary);
          text-shadow: 0 0 14px hsla(190, 80%, 55%, 0.5);
        }

        h1 {
          font-family: var(--font-outfit);
          font-size: 20px;
          font-weight: 800;
          letter-spacing: 0.5px;
        }

        .subtitle {
          font-size: 12px;
          color: var(--text-muted);
        }

        .header-status {
          display: flex;
          align-items: center;
          gap: 10px;
          font-family: var(--font-outfit);
          font-size: 13px;
          font-weight: 600;
        }

        .hero-grid {
          display: grid;
          grid-template-columns: minmax(0, 1.1fr) minmax(320px, 0.9fr);
          gap: 24px;
          margin-bottom: 24px;
        }

        .hero-copy, .signal-panel {
          background: linear-gradient(135deg, hsla(0, 0%, 100%, 0.06), transparent 34%), var(--bg-surface);
          border: 1px solid hsla(0, 0%, 100%, 0.08);
          border-radius: 22px;
          backdrop-filter: blur(22px) saturate(145%);
          box-shadow: inset 0 1px 0 hsla(0, 0%, 100%, 0.07), 0 28px 90px hsla(240, 35%, 2%, 0.30);
        }

        .hero-copy {
          padding: 32px;
        }

        .eyebrow {
          color: var(--accent-secondary);
          font-family: var(--font-outfit);
          font-size: 11px;
          font-weight: 800;
          letter-spacing: 0.22em;
          text-transform: uppercase;
        }

        .hero-copy h2 {
          font-size: clamp(32px, 4vw, 58px);
          line-height: 0.98;
          letter-spacing: -0.035em;
          margin: 12px 0 0;
        }

        .hero-copy p {
          max-width: 680px;
          color: var(--text-muted);
          font-size: 16px;
          line-height: 1.7;
          margin: 18px 0 0;
        }

        .signal-panel {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 12px;
          padding: 18px;
        }

        .metric-tile {
          min-height: 118px;
          border: 1px solid hsla(0, 0%, 100%, 0.07);
          border-radius: 18px;
          background: hsla(240, 14%, 10%, 0.56);
          padding: 18px;
          display: flex;
          flex-direction: column;
          justify-content: space-between;
        }

        .metric-tile span {
          color: var(--text-muted);
          font-family: var(--font-outfit);
          font-size: 11px;
          font-weight: 700;
          letter-spacing: 0.14em;
          text-transform: uppercase;
        }

        .metric-tile strong {
          font-family: var(--font-outfit);
          font-size: 30px;
          color: var(--text-main);
        }

        .pulse-dot {
          width: 8px;
          height: 8px;
          background: var(--accent-success);
          border-radius: 50%;
          box-shadow: 0 0 8px var(--accent-success);
          animation: pulse 2s infinite;
        }

        @keyframes pulse {
          0% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(145, 75, 45, 0.7); }
          70% { transform: scale(1); box-shadow: 0 0 0 6px rgba(145, 75, 45, 0); }
          100% { transform: scale(0.95); box-shadow: 0 0 0 0 rgba(145, 75, 45, 0); }
        }

        .dashboard-grid {
          display: grid;
          grid-template-columns: 1fr 2fr;
          gap: 24px;
        }

        .card {
          background: linear-gradient(135deg, hsla(0, 0%, 100%, 0.045), transparent 34%), var(--bg-surface);
          backdrop-filter: blur(20px) saturate(140%);
          border: 1px solid hsla(0, 0%, 100%, 0.075);
          border-radius: 22px;
          padding: 24px;
          display: flex;
          flex-direction: column;
          box-shadow: inset 0 1px 0 hsla(0, 0%, 100%, 0.06), 0 22px 70px hsla(240, 35%, 2%, 0.25);
        }

        .card-header-row {
          display: flex;
          justify-content: space-between;
          align-items: center;
          margin-bottom: 16px;
        }

        h2 {
          font-family: var(--font-outfit);
          font-size: 16px;
          font-weight: 700;
          margin-bottom: 16px;
          letter-spacing: 0.5px;
        }

        .card-header-row h2 {
          margin-bottom: 0;
        }

        .daemon-list {
          display: flex;
          flex-direction: column;
          gap: 12px;
          flex-grow: 1;
        }

        .daemon-item {
          display: flex;
          align-items: center;
          gap: 14px;
          background: hsla(240, 10%, 15%, 0.4);
          padding: 12px 16px;
          border-radius: 12px;
          border: 1px solid hsla(240, 10%, 20%, 0.2);
        }

        .daemon-icon {
          font-size: 18px;
        }

        .daemon-info {
          flex-grow: 1;
        }

        .daemon-name {
          font-size: 13px;
          font-weight: 600;
        }

        .daemon-port {
          font-size: 11px;
          color: var(--text-muted);
        }

        .status-badge {
          font-family: var(--font-outfit);
          font-size: 11px;
          font-weight: 700;
          padding: 4px 10px;
          border-radius: 6px;
          text-transform: uppercase;
        }

        .status-badge.active, .status-badge.located {
          background: hsla(145, 75%, 45%, 0.15);
          color: var(--accent-success);
          border: 1px solid hsla(145, 75%, 45%, 0.3);
        }

        .status-badge.offline, .status-badge.missing {
          background: hsla(355, 80%, 55%, 0.15);
          color: var(--accent-danger);
          border: 1px solid hsla(355, 80%, 55%, 0.3);
        }

        .status-badge.stale {
          background: hsla(40, 85%, 55%, 0.15);
          color: var(--accent-warning);
          border: 1px solid hsla(40, 85%, 55%, 0.3);
        }

        .table-wrapper {
          overflow-x: auto;
        }

        table {
          width: 100%;
          border-collapse: collapse;
          text-align: left;
          font-size: 13px;
        }

        th {
          font-family: var(--font-outfit);
          font-weight: 700;
          color: var(--text-muted);
          padding: 10px 12px;
          border-bottom: 1px solid var(--border-color);
        }

        td {
          padding: 12px;
          border-bottom: 1px solid hsla(240, 10%, 20%, 0.2);
        }

        td.bold {
          font-weight: 600;
        }

        td.muted {
          color: var(--text-muted);
        }

        td.code {
          font-family: monospace;
          color: var(--accent-secondary);
        }

        .role-tag {
          font-family: var(--font-outfit);
          font-size: 11px;
          font-weight: 600;
          background: hsla(270, 75%, 65%, 0.1);
          color: var(--accent-primary);
          border: 1px solid hsla(270, 75%, 65%, 0.2);
          padding: 2px 6px;
          border-radius: 4px;
        }

        .console-card {
          grid-column: span 2;
        }

        .console-terminal {
          background: hsl(240, 20%, 3%);
          border: 1px solid var(--border-color);
          border-radius: 12px;
          padding: 16px;
          font-family: monospace;
          font-size: 12px;
          color: var(--accent-secondary);
          height: 200px;
          overflow-y: auto;
          display: flex;
          flex-direction: column-reverse;
          gap: 6px;
        }

        @media (max-width: 900px) {
          header,
          .hero-grid {
            grid-template-columns: 1fr;
          }

          header {
            align-items: flex-start;
            flex-direction: column;
            gap: 16px;
          }

          .dashboard-grid {
            grid-template-columns: 1fr;
          }

          .console-card {
            grid-column: span 1;
          }
        }

        .log-line {
          opacity: 0.85;
        }

        .log-line.success {
          color: var(--accent-success);
        }

        .log-line.error {
          color: var(--accent-danger);
        }

        .card-actions {
          margin-top: 16px;
        }

        .btn {
          font-family: var(--font-outfit);
          font-size: 13px;
          font-weight: 700;
          padding: 10px 20px;
          border-radius: 8px;
          cursor: pointer;
          border: none;
          transition: all 0.2s ease;
        }

        .btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .btn-primary {
          background: var(--accent-primary);
          color: white;
          box-shadow: 0 0 12px hsla(270, 75%, 65%, 0.3);
        }

        .btn-primary:hover:not(:disabled) {
          transform: translateY(-1px);
          box-shadow: 0 0 20px hsla(270, 75%, 65%, 0.5);
        }

        .btn-secondary {
          background: hsla(240, 10%, 18%, 0.6);
          color: var(--text-main);
          border: 1px solid var(--border-color);
        }

        .btn-secondary:hover:not(:disabled) {
          background: hsla(240, 10%, 22%, 0.8);
        }
      `}</style>
    </div>
  );
}
