/**
 * kernel.ts — the adjacent-product ring this runtime absorbs by contract,
 * not by monorepo merge.
 *
 * Each member is a pin: repo, layer, wiring posture, and the next honest
 * move. Nothing here activates a worker or claims a live runtime.
 */

export type LayerId = 'L0' | 'L1' | 'L2' | 'L3' | 'L4' | 'L5' | 'L6' | 'L7';

export type WiringPosture =
  | 'canonical'
  | 'pinned-git'
  | 'mcp-stdio'
  | 'stub'
  | 'cited'
  | 'projection'
  | 'satellite'
  | 'deprecated';

export type EvidenceLabel = 'tested' | 'documented' | 'proposed';

export interface KernelMember {
  id: string;
  repo: string;
  url: string;
  layer: LayerId;
  role: string;
  posture: WiringPosture;
  wiring: string;
  next: string;
  inKernel: boolean;
  evidence: EvidenceLabel;
}

export interface KernelPin {
  schema_version: 'starlight.kernel_pin.v1';
  version: string;
  generated_at: string;
  policy: {
    monorepo: 'rejected';
    live_funds: 'never';
    activation: 'report-only';
  };
  members: readonly KernelMember[];
}

export const KERNEL_VERSION = '0.4.0';

export const KERNEL_PIN: KernelPin = {
  schema_version: 'starlight.kernel_pin.v1',
  version: KERNEL_VERSION,
  generated_at: '2026-08-28T00:00:00.000Z',
  policy: {
    monorepo: 'rejected',
    live_funds: 'never',
    activation: 'report-only',
  },
  members: [
    {
      id: 'sis',
      repo: 'frankxai/Starlight-Intelligence-System',
      url: 'https://github.com/frankxai/Starlight-Intelligence-System',
      layer: 'L0',
      role: 'Memory, provenance, Reality Architecture, SIS Gateway',
      posture: 'stub',
      wiring: 'SisVaultMcp dry-run stubs (sis_append_entry / sis_vault_search / sis_confirm). Cockpit may resolve mcp-registry.csv via STARLIGHT_INTELLIGENCE_SYSTEM_ROOT.',
      next: 'Typed SIS Gateway client with worker append-only and queen domain bounds (swarm #10, SIS #49 / #84).',
      inKernel: true,
      evidence: 'documented',
    },
    {
      id: 'agent-skills',
      repo: 'frankxai/starlight-agent-skills',
      url: 'https://github.com/frankxai/starlight-agent-skills',
      layer: 'L1',
      role: 'Portable substrate skills',
      posture: 'satellite',
      wiring: 'Installable capability. Not imported by the runtime.',
      next: 'Keep as a skill pack. Do not vendor into this repo.',
      inKernel: false,
      evidence: 'documented',
    },
    {
      id: 'ops-hub',
      repo: 'frankxai/agentic-ops-hub',
      url: 'https://github.com/frankxai/agentic-ops-hub',
      layer: 'L2',
      role: 'Doctrine, AGENTS.md fan-out, fleet ops',
      posture: 'cited',
      wiring: 'escalation.ts and streams.ts cite AGENT-STACK.md. ECOSYSTEM.md last audited 2026-06-14.',
      next: 'Refresh the hub map to name the team factory, Hands, and kernel pin. Hub stays docs+fleet, not a second runtime.',
      inKernel: true,
      evidence: 'documented',
    },
    {
      id: 'agent-config',
      repo: 'frankxai/starlight-agent-config',
      url: 'https://github.com/frankxai/starlight-agent-config',
      layer: 'L2',
      role: 'Canonical team profiles and role catalog',
      posture: 'pinned-git',
      wiring: 'runtime:plan binds repository + path + 40-char commit + semantic JSON digest. Working-tree drift fails closed.',
      next: 'Keep profiles out of this repo. Pin remains the contract.',
      inKernel: true,
      evidence: 'tested',
    },
    {
      id: 'income-skills',
      repo: 'frankxai/agentic-income-skills',
      url: 'https://github.com/frankxai/agentic-income-skills',
      layer: 'L4',
      role: 'Income-stream skill brain',
      posture: 'satellite',
      wiring: 'Affiliate/Products/Content queens name these skills. Runtime does not execute them.',
      next: 'Queens remain the gate. Skills stay installable.',
      inKernel: false,
      evidence: 'documented',
    },
    {
      id: 'payments',
      repo: 'frankxai/payment-intelligence-system',
      url: 'https://github.com/frankxai/payment-intelligence-system',
      layer: 'L5',
      role: 'Verify-only payments MCP',
      posture: 'mcp-stdio',
      wiring: 'connectRealPayments() spawns ../payment-intelligence-system/mcp/dist/index.js or PAYMENTS_MCP_PATH. Degrades fail-closed. No transfer tool.',
      next: 'Publish and pin @frankx-ai/payments-mcp. CI should prove the adapter against a built server or an explicit skip.',
      inKernel: true,
      evidence: 'tested',
    },
    {
      id: 'swarm',
      repo: 'frankxai/starlight-swarm',
      url: 'https://github.com/frankxai/starlight-swarm',
      layer: 'L6',
      role: 'Queen runtime, Hands, team factory, kernel pin',
      posture: 'canonical',
      wiring: 'This repository. Sole L6 authority. Report-only admission.',
      next: 'Stay the runtime. Export contracts. Do not merge the estate.',
      inKernel: true,
      evidence: 'tested',
    },
    {
      id: 'evals',
      repo: 'frankxai/starlight-evals',
      url: 'https://github.com/frankxai/starlight-evals',
      layer: 'L7',
      role: 'Whole-system assurance, income/payments safety lane',
      posture: 'satellite',
      wiring: 'Named in the layer model. Not invoked from this repo CI.',
      next: 'Add one income/payments safety lane as a CI consumer of the dry-run receipt.',
      inKernel: true,
      evidence: 'documented',
    },
    {
      id: 'command-center',
      repo: 'frankxai/starlight-command-center',
      url: 'https://github.com/frankxai/starlight-command-center',
      layer: 'L7',
      role: 'Observatory UI — read-only projection',
      posture: 'projection',
      wiring: 'Must consume prepared bundles and assessments. Must not recompile or admit.',
      next: 'Command-center #4: typed read-only projection of this factory.',
      inKernel: true,
      evidence: 'documented',
    },
    {
      id: 'hermes-cockpit',
      repo: 'frankxai/hermes-cockpit',
      url: 'https://github.com/frankxai/hermes-cockpit',
      layer: 'L6',
      role: 'Hermes profile registry',
      posture: 'satellite',
      wiring: 'Hermes remains the local operator/scheduler. This repo compiles Hand jobs; it does not own Hermes.',
      next: 'Keep Hermes-only. Do not grow a second Queen.',
      inKernel: false,
      evidence: 'documented',
    },
    {
      id: 'token-tracker',
      repo: 'frankxai/starlight-token-tracker',
      url: 'https://github.com/frankxai/starlight-token-tracker',
      layer: 'L2',
      role: 'Token usage + swarm-bus home',
      posture: 'satellite',
      wiring: 'starlight-swarm-bus is deprecated in favor of this repo.',
      next: 'Cite as the bus home. Do not revive the mistaken bus repo.',
      inKernel: false,
      evidence: 'documented',
    },
    {
      id: 'swarm-bus-deprecated',
      repo: 'frankxai/starlight-swarm-bus',
      url: 'https://github.com/frankxai/starlight-swarm-bus',
      layer: 'L2',
      role: 'DEPRECATED — created by mistake 2026-07-15',
      posture: 'deprecated',
      wiring: 'Do not import. Use starlight-token-tracker/swarm-bus.',
      next: 'Leave archived. Name collision is a lesson, not a merge target.',
      inKernel: false,
      evidence: 'documented',
    },
    {
      id: 'bless',
      repo: 'frankxai/bless',
      url: 'https://github.com/frankxai/bless',
      layer: 'L0',
      role: 'Blessing Protocol §13 — normative charter',
      posture: 'canonical',
      wiring: 'charter.ts is the executable form. AGENTS.md is the prose form. Tests win on disagreement.',
      next: 'Keep dual-sourced. Never relax a clause here that bless still holds.',
      inKernel: true,
      evidence: 'tested',
    },
  ],
};

export function kernelMembers(): readonly KernelMember[] {
  return KERNEL_PIN.members;
}

export function kernelRing(): readonly KernelMember[] {
  return KERNEL_PIN.members.filter((m) => m.inKernel);
}

export function satellites(): readonly KernelMember[] {
  return KERNEL_PIN.members.filter((m) => !m.inKernel && m.posture !== 'deprecated');
}

export function deprecatedMembers(): readonly KernelMember[] {
  return KERNEL_PIN.members.filter((m) => m.posture === 'deprecated');
}

export function memberById(id: string): KernelMember | undefined {
  return KERNEL_PIN.members.find((m) => m.id === id);
}

export function canonicalL6(): KernelMember {
  const found = KERNEL_PIN.members.filter((m) => m.layer === 'L6' && m.posture === 'canonical');
  if (found.length !== 1) {
    throw new Error(`kernel integrity: expected exactly one canonical L6, found ${found.length}`);
  }
  return found[0];
}

export function kernelOverview() {
  return {
    version: KERNEL_PIN.version,
    schema_version: KERNEL_PIN.schema_version,
    policy: KERNEL_PIN.policy,
    generated_at: KERNEL_PIN.generated_at,
    kernel: kernelRing().map(publicMember),
    satellites: satellites().map(publicMember),
    deprecated: deprecatedMembers().map(publicMember),
  };
}

function publicMember(m: KernelMember) {
  return {
    id: m.id,
    repo: m.repo,
    url: m.url,
    layer: m.layer,
    role: m.role,
    posture: m.posture,
    wiring: m.wiring,
    next: m.next,
    evidence: m.evidence,
  };
}
