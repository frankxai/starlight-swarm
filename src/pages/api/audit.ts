import type { NextApiRequest, NextApiResponse } from 'next';
import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';

type RepoAudit = {
  Repository: string;
  Role: string;
  Tier: string;
  LocalStatus: string;
  ActiveBranch: string;
  Uncommitted: string;
  Scope: string;
};

const DEFAULT_REPO_ROOTS = [
  'C:\\Users\\frank\\starlight\\repos',
  'C:\\Users\\frank',
];

function resolveRegistryPath() {
  const explicit = process.env.STARLIGHT_MCP_REGISTRY;
  if (explicit) {
    return explicit;
  }

  const sisRoot = process.env.STARLIGHT_INTELLIGENCE_SYSTEM_ROOT;
  if (sisRoot) {
    return path.join(sisRoot, 'tools', 'mcp-registry.csv');
  }

  for (const root of DEFAULT_REPO_ROOTS) {
    const candidate = path.join(root, 'Starlight-Intelligence-System', 'tools', 'mcp-registry.csv');
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  return path.join(DEFAULT_REPO_ROOTS[0], 'Starlight-Intelligence-System', 'tools', 'mcp-registry.csv');
}

function parseCsvLine(line: string) {
  const values: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    const next = line[i + 1];

    if (char === '"' && next === '"') {
      current += '"';
      i++;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      values.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }

  values.push(current.trim());
  return values;
}

export default function handler(req: NextApiRequest, res: NextApiResponse<RepoAudit[] | { error: string }>) {
  const csvPath = resolveRegistryPath();
  
  if (!fs.existsSync(csvPath)) {
    return res.status(404).json({ error: `Registry CSV not found at ${csvPath}. Set STARLIGHT_MCP_REGISTRY or STARLIGHT_INTELLIGENCE_SYSTEM_ROOT.` });
  }

  try {
    const rawCsv = fs.readFileSync(csvPath, 'utf-8');
    const lines = rawCsv.split(/\r?\n/).filter(line => line.trim() !== '');
    const headers = parseCsvLine(lines[0]);
    
    const records = lines.slice(1).map(line => {
      const values = parseCsvLine(line);
      const record: Record<string, string> = {};
      headers.forEach((header, index) => {
        record[header.trim()] = values[index] ? values[index].trim() : '';
      });
      return record;
    });

    const auditResults: RepoAudit[] = [];
    const searchDirs = process.env.STARLIGHT_REPO_ROOTS
      ? process.env.STARLIGHT_REPO_ROOTS.split(';').map((entry) => entry.trim()).filter(Boolean)
      : DEFAULT_REPO_ROOTS;

    for (const record of records) {
      if (!record.RepositoryName) continue;
      
      const repoName = record.RepositoryName;
      let targetPath: string | null = null;
      let status = 'Missing';
      let branch = 'N/A';
      let uncommitted = 'N/A';

      for (const dir of searchDirs) {
        const testPath = path.join(dir, repoName);
        if (fs.existsSync(path.join(testPath, '.git'))) {
          targetPath = testPath;
          status = 'Located';
          break;
        }
      }

      if (targetPath) {
        try {
          const branchName = execFileSync('git', ['branch', '--show-current'], { cwd: targetPath, encoding: 'utf-8' }).trim();
          if (branchName) {
            branch = branchName;
          }
          const changes = execFileSync('git', ['status', '--short'], { cwd: targetPath, encoding: 'utf-8' }).trim();
          const uncommittedCount = changes ? changes.split('\n').length : 0;
          uncommitted = `${uncommittedCount} files`;
        } catch (e) {
          status = 'Located/Corrupt';
        }
      }

      auditResults.push({
        Repository: repoName,
        Role: record.Role || 'N/A',
        Tier: record.Tier || 'N/A',
        LocalStatus: status,
        ActiveBranch: branch,
        Uncommitted: uncommitted,
        Scope: record.ExecutionScope || 'N/A'
      });
    }

    res.status(200).json(auditResults);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
}
