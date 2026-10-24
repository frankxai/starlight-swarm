import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { FOUNDER, STREAMS, swarmTree } from './streams';

describe('streams module', () => {
  it('exports FOUNDER spec', () => {
    assert.ok(FOUNDER);
    assert.equal(FOUNDER.name, 'starlight-orchestrator');
  });

  it('exports exactly four streams', () => {
    assert.equal(STREAMS.length, 4);
    const ids = STREAMS.map(s => s.id);
    assert.ok(ids.includes('affiliate'));
    assert.ok(ids.includes('products'));
    assert.ok(ids.includes('content'));
    assert.ok(ids.includes('payments'));
  });

  it('generates a valid swarm tree snapshot', () => {
    const tree = swarmTree();
    assert.ok(tree.founder);
    assert.equal(tree.founder.name, 'starlight-orchestrator');
    assert.ok(tree.streams);
    assert.equal(tree.streams.length, 4);
    assert.equal(tree.streams[0].id, 'affiliate');
    assert.ok(tree.streams[0].workers.length > 0);
  });
});
