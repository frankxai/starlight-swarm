import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PGlite } from '@electric-sql/pglite';

import {
  attestBrokerDatabaseSession,
  brokerDatabaseRoleGrantSql,
  BROKER_DATABASE_ROLE_CONTRACT_SHA256,
} from './authority-role-contract';
import { OPERATION_AUTHORITY_MIGRATION_SQL } from './postgres-operation-authority';

async function restrictedDatabase(extra = '') {
  const db = new PGlite();
  await db.exec(OPERATION_AUTHORITY_MIGRATION_SQL);
  await db.exec(`CREATE ROLE starlight_broker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    ${brokerDatabaseRoleGrantSql('starlight_broker')}
    ${extra}
    SET SESSION AUTHORIZATION starlight_broker;`);
  return db;
}

test('attests one direct-login broker role with only the exact redemption grants', async () => {
  const db = await restrictedDatabase();
  try {
    const result = await attestBrokerDatabaseSession(db);
    assert.equal(result.valid, true);
    if (!result.valid) return;
    assert.equal(result.session.database_role, 'starlight_broker');
    assert.equal(result.session.contract_digest_sha256, BROKER_DATABASE_ROLE_CONTRACT_SHA256);
  } finally { await db.close(); }
});

test('rejects a broker role with any extra table or column mutation authority', async (t) => {
  await t.test('table mutation', async () => {
    const db = await restrictedDatabase('GRANT DELETE ON swarm_authority_reservations TO starlight_broker;');
    try {
      const result = await attestBrokerDatabaseSession(db);
      assert.equal(result.valid, false);
      assert.match(result.blockers.join(' '), /table grants/i);
    } finally { await db.close(); }
  });
  await t.test('column mutation', async () => {
    const db = await restrictedDatabase('GRANT UPDATE (binding) ON swarm_authority_reservations TO starlight_broker;');
    try {
      const result = await attestBrokerDatabaseSession(db);
      assert.equal(result.valid, false);
      assert.match(result.blockers.join(' '), /column updates/i);
    } finally { await db.close(); }
  });
  await t.test('PUBLIC table mutation', async () => {
    const db = await restrictedDatabase('GRANT DELETE ON swarm_authority_reservations TO PUBLIC;');
    try {
      const result = await attestBrokerDatabaseSession(db);
      assert.equal(result.valid, false);
      assert.match(result.blockers.join(' '), /table grants/i);
    } finally { await db.close(); }
  });
  await t.test('PUBLIC sequence mutation', async () => {
    const db = await restrictedDatabase('GRANT UPDATE ON SEQUENCE swarm_authority_audit_seq_seq TO PUBLIC;');
    try {
      const result = await attestBrokerDatabaseSession(db);
      assert.equal(result.valid, false);
      assert.match(result.blockers.join(' '), /sequence grants/i);
    } finally { await db.close(); }
  });
  await t.test('PUBLIC routine execution', async () => {
    const db = await restrictedDatabase('CREATE FUNCTION public.unreviewed() RETURNS BOOLEAN LANGUAGE sql AS \'SELECT TRUE\';');
    try {
      const result = await attestBrokerDatabaseSession(db);
      assert.equal(result.valid, false);
      assert.match(result.blockers.join(' '), /routine grants/i);
    } finally { await db.close(); }
  });
  await t.test('database schema creation', async () => {
    const db = await restrictedDatabase('GRANT CREATE ON DATABASE postgres TO starlight_broker;');
    try {
      const result = await attestBrokerDatabaseSession(db);
      assert.equal(result.valid, false);
      assert.match(result.blockers.join(' '), /database grants/i);
    } finally { await db.close(); }
  });
});

test('rejects superuser posture and role-name injection in grant generation', async () => {
  const db = new PGlite();
  try {
    await db.exec(OPERATION_AUTHORITY_MIGRATION_SQL);
    const result = await attestBrokerDatabaseSession(db);
    assert.equal(result.valid, false);
    assert.match(result.blockers.join(' '), /forbidden rolsuper/i);
    assert.throws(() => brokerDatabaseRoleGrantSql('broker; DROP TABLE x'), /invalid/i);
  } finally { await db.close(); }
});

test('the restricted role can execute the redemption SQL surface but not control-plane or unrelated access', async () => {
  const db = new PGlite();
  await db.exec(`${OPERATION_AUTHORITY_MIGRATION_SQL}
    CREATE TABLE unrelated_private_sentinel (value TEXT);
    CREATE ROLE starlight_broker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    ${brokerDatabaseRoleGrantSql('starlight_broker')}
    SET SESSION AUTHORIZATION starlight_broker;`);
  try {
    await db.exec(`BEGIN;
      SELECT starlight_authority_lock();
      SELECT * FROM swarm_authority_broker_principals;
      SELECT * FROM swarm_authority_reservations FOR UPDATE;
      SELECT * FROM swarm_authority_hosts FOR UPDATE;
      SELECT * FROM swarm_authority_budgets FOR UPDATE;
      SELECT * FROM swarm_authority_budget_windows FOR UPDATE;
      SELECT * FROM swarm_authority_prepared_operations;
      SELECT * FROM swarm_authority_revocations;
      SELECT * FROM swarm_authority_budget_holds;
      UPDATE swarm_authority_reservations SET state=state WHERE FALSE;
      UPDATE swarm_authority_reservations SET
        runner_claim_id=runner_claim_id,runner_claim_request_id=runner_claim_request_id,
        runner_claim_accepted_at=runner_claim_accepted_at,runner_claim_expires_at=runner_claim_expires_at,
        runner_evidence_observed_at=runner_evidence_observed_at,
        runner_access_review_expires_at=runner_access_review_expires_at,
        runner_id=runner_id,runner_identity_evidence_ref=runner_identity_evidence_ref,
        runner_instance_id=runner_instance_id,runner_runtime_id=runner_runtime_id,
        runner_host_id=runner_host_id,runner_channel_binding_sha256=runner_channel_binding_sha256,
        heartbeat_token_sha256=heartbeat_token_sha256,runner_revocation_refs=runner_revocation_refs
      WHERE FALSE;
      UPDATE swarm_authority_hosts SET reserved_slots=reserved_slots WHERE FALSE;
      UPDATE swarm_authority_budgets SET reserved_usd=reserved_usd WHERE FALSE;
      UPDATE swarm_authority_budget_windows SET reserved_usd=reserved_usd WHERE FALSE;
      INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
        VALUES ('denied','role-contract-test',repeat('0',64),clock_timestamp(),'{}'::jsonb);
      ROLLBACK;`);
    await assert.rejects(
      db.query("UPDATE swarm_authority_prepared_operations SET state='cancelled'"),
      /permission denied/i,
    );
    await assert.rejects(db.query('SELECT * FROM unrelated_private_sentinel'), /permission denied/i);
  } finally { await db.close(); }
});
