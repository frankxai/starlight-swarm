import type { NextApiRequest, NextApiResponse } from 'next';
import { resolve } from 'node:path';

import { makeDryRunVault } from '@/swarm/integrations';
import {
  importDialogSummary,
  promoteMemoryImport,
  scanMemoryImport,
  type MemoryImportCandidate,
} from '@/swarm/memory-import';
import { assessSwarmSync } from '@/swarm/swarm-sync';

type OkBody = {
  sync: ReturnType<typeof assessSwarmSync>;
  dialog: ReturnType<typeof importDialogSummary>;
  manifest: ReturnType<typeof scanMemoryImport>;
  promote?: Awaited<ReturnType<typeof promoteMemoryImport>>;
};

type ErrBody = { error: string };

/**
 * GET  — scan local Claude Code / Cursor memories + swarm sync inventory.
 * POST — human-gated promote of selected candidates into dry-run vault.
 *
 * Never writes live SIS. Never auto-approves.
 */
export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<OkBody | ErrBody>,
) {
  const repositoryRoot = resolve(process.env.STARLIGHT_REPO_ROOT ?? process.cwd());

  try {
    if (req.method === 'GET') {
      const includeChats = req.query.includeChats === '1' || req.query.includeChats === 'true';
      const sync = assessSwarmSync({ repositoryRoot });
      const manifest = scanMemoryImport({ repositoryRoot, includeChats });
      return res.status(200).json({
        sync,
        dialog: importDialogSummary(manifest),
        manifest,
      });
    }

    if (req.method === 'POST') {
      const body = req.body as {
        humanApproved?: boolean;
        candidateIds?: string[];
        includeChats?: boolean;
        note?: string;
      };

      if (!body?.humanApproved) {
        return res.status(403).json({
          error: 'Human approval required before memory promotion (charter: human-gate).',
        });
      }

      const sync = assessSwarmSync({ repositoryRoot });
      const manifest = scanMemoryImport({
        repositoryRoot,
        includeChats: Boolean(body.includeChats),
      });

      let selected: MemoryImportCandidate[];
      if (Array.isArray(body.candidateIds) && body.candidateIds.length > 0) {
        const wanted = new Set(body.candidateIds);
        selected = manifest.candidates.filter((c) => wanted.has(c.id));
      } else {
        selected = manifest.candidates.filter((c) => c.selected_by_default && c.promotable);
      }

      const logs: string[] = [];
      const vault = makeDryRunVault((m) => logs.push(m));
      const promote = await promoteMemoryImport(vault, {
        candidates: selected,
        humanApproved: true,
        note: body.note ?? 'cockpit memory import',
      });

      return res.status(200).json({
        sync,
        dialog: importDialogSummary(manifest),
        manifest,
        promote,
      });
    }

    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Memory import failed';
    return res.status(500).json({ error: message });
  }
}
