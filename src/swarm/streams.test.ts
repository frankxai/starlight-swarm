import { describe, it } from 'node:test';
import * as assert from 'node:assert/strict';
import { swarmTree, FOUNDER, STREAMS } from './streams';

describe('streams', () => {
  it('swarmTree returns the correct founder structure', () => {
    const tree = swarmTree();
    assert.deepEqual(tree.founder, FOUNDER);
  });

  it('swarmTree returns mapped streams correctly', () => {
    const tree = swarmTree();
    assert.equal(tree.streams.length, STREAMS.length);
    assert.equal(tree.streams[0].id, STREAMS[0].id);
    assert.equal(tree.streams[0].queen, STREAMS[0].queen.name);
    assert.deepEqual(tree.streams[0].loop, STREAMS[0].queen.selfImprovingLoop);
    assert.equal(tree.streams[0].workers[0].name, STREAMS[0].workers[0].name);
  });
});
