/**
 * identities.ts — visual and cultural identity layer for Starlight agents.
 *
 * Runtime seats stay in streams.ts / domain-queens.json (English functional
 * names). This module adds Japanese craft identities, global excellence
 * lineages, managed channels, and portrait paths for the /identities atlas.
 *
 * No action fires from here. Portraits and channel lists are operator
 * contracts for clarity — not live publishing credentials.
 */

export type IdentityTier = 'sovereign' | 'queen' | 'worker';

export type IdentityDomain =
  | 'empire'
  | 'affiliate'
  | 'products'
  | 'content'
  | 'payments'
  | 'arcanea'
  | 'sis'
  | 'control'
  | 'frankx'
  | 'gencreator'
  | 'wealth';

export interface ManagedChannel {
  /** Surface the agent drafts for or oversees (queen-gated publish). */
  label: string;
  kind: 'website' | 'social' | 'product' | 'ledger' | 'internal' | 'creative';
  /** What leaves this seat when gated. */
  outputs: string[];
  href?: string;
}

export interface AgentIdentity {
  id: string;
  /** Japanese display name (kanji / kana). */
  jpName: string;
  /** Romanized Japanese name. */
  romaji: string;
  /** English / runtime seat name. */
  enName: string;
  tier: IdentityTier;
  domain: IdentityDomain;
  /** One-line role under Starlight Queen. */
  role: string;
  /** Japanese craft quality this seat embodies. */
  japaneseQuality: string;
  /** Global excellence lineages this seat synthesizes. */
  globalLineages: string[];
  /** How this seat connects to Starlight Queen / Hermes. */
  queenLink: string;
  /** Portrait under /public/identities/. */
  portrait: string;
  /** Accent token for UI chrome (CSS color). */
  accent: string;
  channels: ManagedChannel[];
  /** Optional map to L6 stream queen or worker seat. */
  streamSeat?: string;
  /** Optional map to God Mode domain queen id. */
  domainQueenId?: string;
}

/**
 * First-wave identity atlas — Japanese craft × US / EU / CN / global genius,
 * mapped onto seats that already exist in the swarm runtime and org chart.
 */
export const IDENTITIES: AgentIdentity[] = [
  {
    id: 'hoshi-joo',
    jpName: '星の女王',
    romaji: 'Hoshi no Joō',
    enName: 'Starlight Queen / Hermes',
    tier: 'sovereign',
    domain: 'empire',
    role: 'Admission, leases, schedules, human gates — the 24/7 planner between SO and AO.',
    japaneseQuality: 'Omotenashi of governance + kaizen of policy — host every mission with care, improve the loop without spectacle.',
    globalLineages: [
      'US frontier models & agent runtimes',
      'EU safety / fail-closed governance',
      'JP craft precision & continuous improvement',
      'CN systems scale & synthesis speed',
    ],
    queenLink: 'Is Starlight Queen. Owns Hands; never wires live funds.',
    portrait: '/identities/hoshi-joo-starlight-queen.png',
    accent: '#C23B22',
    domainQueenId: 'EMPIRE-CHIEF-QUEEN',
    channels: [
      {
        label: 'Queen admission & lease desk',
        kind: 'internal',
        outputs: ['leases', 'gate verdicts', 'escalation packets'],
      },
      {
        label: 'Starlight Board pressure-test',
        kind: 'internal',
        outputs: ['founder briefs', 'irreversible gate queues'],
      },
    ],
  },
  {
    id: 'kizuna',
    jpName: '絆',
    romaji: 'Kizuna',
    enName: 'Affiliate Queen',
    tier: 'queen',
    domain: 'affiliate',
    role: 'Leads the affiliate income stream — honest programs, bound links, measured rank.',
    japaneseQuality: 'Kizuna — lasting bonds. Prefer durable partner trust over clickbait yield.',
    globalLineages: [
      'US performance marketing rigor',
      'EU disclosure / consumer protection norms',
      'JP long-term partner omotenashi',
    ],
    queenLink: 'Reports to Starlight Queen via founder conflict desk; no cross-stream command.',
    portrait: '/identities/kizuna-affiliate-queen.png',
    accent: '#C4A574',
    streamSeat: 'Affiliate Queen',
    channels: [
      {
        label: 'agenticincome hub',
        kind: 'website',
        outputs: ['program audits', 'ranked catalogs'],
      },
      {
        label: 'agenticpassiveincome spoke',
        kind: 'website',
        outputs: ['bound links (queen-gated)', 'FTC disclosure checks'],
      },
    ],
  },
  {
    id: 'takumi',
    jpName: '匠',
    romaji: 'Takumi',
    enName: 'Products Queen',
    tier: 'queen',
    domain: 'products',
    role: 'Digital products, templates, courses — gap-scan → build → price → launch → retro.',
    japaneseQuality: 'Takumi — master craft. Ship the smallest complete artifact, then refine.',
    globalLineages: [
      'US product-led growth & packaging',
      'EU design systems / accessibility',
      'JP shokunin product finish',
      'Global pricing experiments (model-only)',
    ],
    queenLink: 'Stream queen under Starlight Queen; publish remains queen-gated.',
    portrait: '/identities/takumi-products-queen.png',
    accent: '#8B7355',
    streamSeat: 'Products Queen',
    channels: [
      {
        label: 'Product studio surface',
        kind: 'product',
        outputs: ['specs', 'packages', 'launch sequences (gated)'],
      },
      {
        label: 'Pricing models (no money movement)',
        kind: 'ledger',
        outputs: ['price hypotheses', 'retro notes'],
      },
    ],
  },
  {
    id: 'kotodama',
    jpName: '言霊',
    romaji: 'Kotodama',
    enName: 'Content Queen',
    tier: 'queen',
    domain: 'content',
    role: 'Traffic → trust → routing. Words carry spirit; publish only after gate.',
    japaneseQuality: 'Kotodama — spirit of language. Every draft must earn silence before it earns an audience.',
    globalLineages: [
      'US narrative & hook engineering',
      'EU clarity & multilingual standards',
      'JP ma (間) — space that makes meaning land',
      'Global SEO / distribution craft',
    ],
    queenLink: 'Stream queen; distributor proposals rise here, then to Starlight Queen on conflict.',
    portrait: '/identities/kotodama-content-queen.png',
    accent: '#A63D2F',
    streamSeat: 'Content Queen',
    channels: [
      {
        label: 'Long-form trust surfaces',
        kind: 'website',
        outputs: ['articles (gated)', 'tri-modal hooks'],
      },
      {
        label: 'Social variant desk',
        kind: 'social',
        outputs: ['platform drafts', 'repurpose packs'],
      },
    ],
  },
  {
    id: 'shinrai',
    jpName: '信頼',
    romaji: 'Shinrai',
    enName: 'Payments Queen',
    tier: 'queen',
    domain: 'payments',
    role: 'Authorization + settlement governance — verify-only money surface.',
    japaneseQuality: 'Shinrai — earned trust. Fail closed; never move capital autonomously.',
    globalLineages: [
      'US AP2 / mandate patterns',
      'EU PSD-class caution & auditability',
      'JP seal / ledger integrity culture',
      'Global fraud intelligence',
    ],
    queenLink: 'Only stream with Payments MCP (verify-only). Escalates spend to human via Queen.',
    portrait: '/identities/shinrai-payments-queen.png',
    accent: '#B8956A',
    streamSeat: 'Payments Queen',
    channels: [
      {
        label: 'Mandate & spend-cap desk',
        kind: 'ledger',
        outputs: ['mandate verifications', 'cap checks', 'audit entries'],
      },
      {
        label: 'Fraud sentinel feed',
        kind: 'internal',
        outputs: ['anomaly flags', 'replay alerts'],
      },
    ],
  },
  {
    id: 'yugen',
    jpName: '幽玄',
    romaji: 'Yūgen',
    enName: 'Arcanea Queen',
    tier: 'queen',
    domain: 'arcanea',
    role: 'Creative & world-engine sovereign — lore, character forge, visual intelligence.',
    japaneseQuality: 'Yūgen — profound grace suggested, never overstated.',
    globalLineages: [
      'JP atmospheric worldcraft',
      'EU art-direction restraint',
      'US interactive narrative systems',
      'Global generative media pipelines',
    ],
    queenLink: 'Domain queen under Empire Chief / Starlight Queen allocation.',
    portrait: '/identities/yugen-arcanea-queen.png',
    accent: '#6E7F8D',
    domainQueenId: 'ARCANEA-QUEEN',
    channels: [
      {
        label: 'Lore & character forge',
        kind: 'creative',
        outputs: ['lore packs', 'character sheets', 'visual briefs'],
      },
      {
        label: 'World engine / media',
        kind: 'creative',
        outputs: ['world bibles', 'media sequences'],
      },
    ],
  },
  {
    id: 'chie',
    jpName: '智',
    romaji: 'Chie',
    enName: 'SIS / Intelligence Queen',
    tier: 'queen',
    domain: 'sis',
    role: 'Research synthesis + knowledge governance — evidence before claims.',
    japaneseQuality: 'Chie — lived wisdom. Prefer a verified shard over a loud pile.',
    globalLineages: [
      'US retrieval & eval culture',
      'EU evidence / governance standards',
      'CN synthesis at scale',
      'JP second-brain discipline',
    ],
    queenLink: 'Domain queen; feeds theses upward to Starlight Queen / founder.',
    portrait: '/identities/chie-sis-queen.png',
    accent: '#7A8B99',
    domainQueenId: 'SIS-QUEEN',
    channels: [
      {
        label: 'Research synthesis pipelines',
        kind: 'internal',
        outputs: ['briefs', 'citations', 'vertical intel'],
      },
      {
        label: 'Evidence & governance ledger',
        kind: 'ledger',
        outputs: ['claim receipts', 'promotion decisions'],
      },
    ],
  },
  {
    id: 'haifu',
    jpName: '配布',
    romaji: 'Haifu',
    enName: 'distributor',
    tier: 'worker',
    domain: 'content',
    role: 'Drafts platform variants — never publishes without Content Queen gate.',
    japaneseQuality: 'Haifu — right signal to the right place, without noise.',
    globalLineages: [
      'US social systems design',
      'EU platform compliance norms',
      'JP channel courtesy (no spam aesthetic)',
      'Global short-form craft',
    ],
    queenLink: 'Worker under Kotodama (Content Queen); proposals only.',
    portrait: '/identities/haifu-distributor.png',
    accent: '#C23B22',
    streamSeat: 'distributor',
    channels: [
      {
        label: 'X / LinkedIn / short-form variants',
        kind: 'social',
        outputs: ['platform drafts', 'hook packs (queen-gated)'],
      },
      {
        label: 'Repurpose queue',
        kind: 'social',
        outputs: ['cross-format drafts'],
      },
    ],
  },
];

/** Sovereign + queens for the atlas hero strip. */
export function identityQueens(): AgentIdentity[] {
  return IDENTITIES.filter((a) => a.tier === 'sovereign' || a.tier === 'queen');
}

/** Workers with their own channel desks. */
export function identityWorkers(): AgentIdentity[] {
  return IDENTITIES.filter((a) => a.tier === 'worker');
}

/** Lookup by id. */
export function getIdentity(id: string): AgentIdentity | undefined {
  return IDENTITIES.find((a) => a.id === id);
}

/**
 * Plain snapshot for getStaticProps / dry-run — no functions.
 */
export function identitiesTree() {
  return {
    wave: 'jp-global-excellence-v1',
    note: 'Identity layer only. Runtime seats remain English functional names in streams.ts.',
    count: IDENTITIES.length,
    agents: IDENTITIES.map((a) => ({
      id: a.id,
      jpName: a.jpName,
      romaji: a.romaji,
      enName: a.enName,
      tier: a.tier,
      domain: a.domain,
      role: a.role,
      japaneseQuality: a.japaneseQuality,
      globalLineages: a.globalLineages,
      queenLink: a.queenLink,
      portrait: a.portrait,
      accent: a.accent,
      streamSeat: a.streamSeat ?? null,
      domainQueenId: a.domainQueenId ?? null,
      channels: a.channels,
    })),
  };
}
