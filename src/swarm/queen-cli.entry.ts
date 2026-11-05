/** Process entry for `starlight-queen`. Started by bin/starlight-queen.mjs under tsx. */
import { main } from './queen-cli';

main(process.argv.slice(2)).then(
  (code) => { process.exitCode = code; },
  (err) => { console.error(err instanceof Error ? err.message : String(err)); process.exitCode = 1; },
);
