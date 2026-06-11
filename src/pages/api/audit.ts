import type { NextApiRequest, NextApiResponse } from 'next';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';

type RepoAudit = {
  Repository: string;
  Role: string;
  Tier: string;
  LocalStatus: string;
  ActiveBranch: string;
  Uncommitted: string;
  Scope: string;
};

export default function handler(req: NextApiRequest, res: NextApiResponse<RepoAudit[] | { error: string }>) {
  const csvPath = 'C:\\Users\\frank\\Starlight-Intelligence-System\\tools\\mcp-registry.csv';
  
  if (!fs.existsSync(csvPath)) {
    return res.status(404).json({ error: 'Registry CSV not found.' });
  }

  try {
    const rawCsv = fs.readFileSync(csvPath, 'utf-8');
    const lines = rawCsv.split(/\r?\n/).filter(line => line.trim() !== '');
    const headers = lines[0].split(',');
    
    const records = lines.slice(1).map(line => {
      const values = line.split(',');
      const record: any = {};
      headers.forEach((header, index) => {
        record[header.trim()] = values[index] ? values[index].trim() : '';
      });
      return record;
    });

    const auditResults: RepoAudit[] = [];
    const searchDirs = ['C:\\Users\\frank\\starlight\\repos', 'C:\\Users\\frank'];

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
          const branchName = execSync('git branch --show-current', { cwd: targetPath, encoding: 'utf-8' }).trim();
          if (branchName) {
            branch = branchName;
          }
          const changes = execSync('git status --short', { cwd: targetPath, encoding: 'utf-8' }).trim();
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
