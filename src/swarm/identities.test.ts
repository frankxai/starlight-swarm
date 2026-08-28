import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  IDENTITIES,
  getIdentity,
  identitiesTree,
  identityQueens,
  identityWorkers,
} from './identities';

test('identity atlas includes Starlight Queen sovereign', () => {
  const queen = getIdentity('hoshi-joo');
  assert.ok(queen);
  assert.equal(queen.tier, 'sovereign');
  assert.equal(queen.jpName, '星の女王');
  assert.match(queen.enName, /Starlight Queen/);
  assert.ok(queen.portrait.startsWith('/identities/'));
});

test('four L6 stream queens are identity-mapped', () => {
  const seats = identityQueens()
    .map((a) => a.streamSeat)
    .filter(Boolean);
  for (const seat of ['Affiliate Queen', 'Products Queen', 'Content Queen', 'Payments Queen']) {
    assert.ok(seats.includes(seat), `missing seat ${seat}`);
  }
});

test('workers expose managed channels', () => {
  const workers = identityWorkers();
  assert.ok(workers.length >= 1);
  for (const w of workers) {
    assert.ok(w.channels.length >= 1);
    assert.ok(w.channels.every((c) => c.outputs.length >= 1));
  }
});

test('identitiesTree is JSON-serializable snapshot', () => {
  const tree = identitiesTree();
  assert.equal(tree.count, IDENTITIES.length);
  assert.equal(tree.agents.length, IDENTITIES.length);
  JSON.stringify(tree);
});

test('every identity has JP name, lineages, and queen link', () => {
  for (const a of IDENTITIES) {
    assert.ok(a.jpName.length > 0);
    assert.ok(a.romaji.length > 0);
    assert.ok(a.globalLineages.length >= 2);
    assert.ok(a.queenLink.length > 0);
    assert.ok(a.japaneseQuality.length > 0);
  }
});
