import assert from 'node:assert/strict';
import { test } from 'node:test';

import { PGlite } from '@electric-sql/pglite';

import {
  attestBrokerDatabaseSession,
  brokerDatabaseRoleGrantSql,
  BROKER_DATABASE_ROLE_CONTRACT_SHA256,
  attestUsageEvidenceDatabaseSession,
  usageEvidenceDatabaseRoleGrantSql,
  usageAuthorityRoutineOwnerGrantSql,
} from './authority-role-contract';
import { OPERATION_AUTHORITY_MIGRATION_SQL } from './postgres-operation-authority';

async function restrictedDatabase(extra = '') {
  const db = new PGlite();
  await db.exec(OPERATION_AUTHORITY_MIGRATION_SQL);
  await db.exec(`CREATE ROLE starlight_authority_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    ${usageAuthorityRoutineOwnerGrantSql('starlight_authority_owner')}
    CREATE ROLE starlight_broker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    ${brokerDatabaseRoleGrantSql('starlight_broker')}
    ${extra}
    SET SESSION AUTHORIZATION starlight_broker;`);
  return db;
}

async function restrictedUsageDatabase(extra = '') {
  const db = new PGlite();
  await db.exec(OPERATION_AUTHORITY_MIGRATION_SQL);
  await db.exec(`CREATE ROLE starlight_authority_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    ${usageAuthorityRoutineOwnerGrantSql('starlight_authority_owner')}
    CREATE ROLE starlight_usage_verifier LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    REVOKE TEMPORARY ON DATABASE postgres FROM PUBLIC;
    ${usageEvidenceDatabaseRoleGrantSql('starlight_usage_verifier')}
    ${extra}
    SET SESSION AUTHORIZATION starlight_usage_verifier;`);
  return db;
}

test('attests one direct-login broker role with only the exact redemption grants', async () => {
  const db = await restrictedDatabase();
  try {
    const result = await attestBrokerDatabaseSession(db);
    assert.equal(result.valid, true, result.valid ? undefined : result.blockers.join(' '));
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

test('rejects usage routine body, ownership, and PUBLIC execution drift', async (t) => {
  await t.test('body replacement', async () => {
    const db = await restrictedDatabase(`CREATE OR REPLACE FUNCTION public.starlight_append_runner_usage_evidence(jsonb)
      RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, public
      AS 'BEGIN RETURN jsonb_build_object(''ok'',TRUE); END';`);
    try {
      const result = await attestBrokerDatabaseSession(db);
      assert.equal(result.valid, false);
      assert.match(result.blockers.join(' '), /missing, drifted/i);
    } finally { await db.close(); }
  });
  await t.test('broker ownership', async () => {
    const db = await restrictedDatabase(
      'ALTER FUNCTION public.starlight_append_runner_usage_evidence(jsonb) OWNER TO starlight_broker;',
    );
    try {
      const result = await attestBrokerDatabaseSession(db);
      assert.equal(result.valid, false);
      assert.match(result.blockers.join(' '), /unsafely owned/i);
    } finally { await db.close(); }
  });
  await t.test('PUBLIC execute', async () => {
    const db = await restrictedDatabase(
      'GRANT EXECUTE ON FUNCTION public.starlight_append_runner_usage_evidence(jsonb) TO PUBLIC;',
    );
    try {
      const result = await attestBrokerDatabaseSession(db);
      assert.equal(result.valid, false);
      assert.match(result.blockers.join(' '), /publicly executable/i);
    } finally { await db.close(); }
  });
  await t.test('inbound owner membership', async () => {
    const db = await restrictedDatabase(
      'CREATE ROLE attacker LOGIN; GRANT starlight_authority_owner TO attacker;',
    );
    try {
      const result = await attestBrokerDatabaseSession(db);
      assert.equal(result.valid, false);
      assert.match(result.blockers.join(' '), /unsafely owned/i);
    } finally { await db.close(); }
  });
  await t.test('owner-held overload', async () => {
    const db = await restrictedDatabase(`CREATE FUNCTION public.starlight_append_runner_usage_evidence(text)
      RETURNS jsonb LANGUAGE sql AS 'SELECT ''{}''::jsonb';
      ALTER FUNCTION public.starlight_append_runner_usage_evidence(text) OWNER TO starlight_authority_owner;
      REVOKE ALL ON FUNCTION public.starlight_append_runner_usage_evidence(text) FROM PUBLIC;`);
    try {
      const result = await attestBrokerDatabaseSession(db);
      assert.equal(result.valid, false);
      assert.match(result.blockers.join(' '), /unsafely owned/i);
    } finally { await db.close(); }
  });
});

test('the restricted role can execute the redemption SQL surface but not control-plane or unrelated access', async () => {
  const db = new PGlite();
  await db.exec(`${OPERATION_AUTHORITY_MIGRATION_SQL}
    CREATE TABLE unrelated_private_sentinel (value TEXT);
    CREATE ROLE starlight_authority_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    ${usageAuthorityRoutineOwnerGrantSql('starlight_authority_owner')}
    CREATE ROLE starlight_broker LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
    ${brokerDatabaseRoleGrantSql('starlight_broker')}
    SET SESSION AUTHORIZATION starlight_broker;`);
  try {
    await db.exec(`BEGIN;
      SELECT starlight_authority_lock();
      SELECT * FROM swarm_authority_broker_principals;
      SELECT * FROM swarm_authority_reservations FOR UPDATE;
      SELECT * FROM swarm_authority_hosts FOR UPDATE;
      SELECT * FROM swarm_authority_heartbeat_tokens;
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
        heartbeat_token_sha256=heartbeat_token_sha256,runner_revocation_refs=runner_revocation_refs,
        runner_heartbeat_id=runner_heartbeat_id,
        runner_heartbeat_request_id=runner_heartbeat_request_id,
        runner_heartbeat_sequence=runner_heartbeat_sequence,
        runner_heartbeat_accepted_at=runner_heartbeat_accepted_at,
        runner_heartbeat_presented_token_sha256=runner_heartbeat_presented_token_sha256
      WHERE FALSE;
      UPDATE swarm_authority_hosts SET reserved_slots=reserved_slots WHERE FALSE;
      UPDATE swarm_authority_budgets SET reserved_usd=reserved_usd WHERE FALSE;
      UPDATE swarm_authority_budget_windows SET reserved_usd=reserved_usd WHERE FALSE;
      INSERT INTO swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
        VALUES ('denied','role-contract-test',repeat('0',64),clock_timestamp(),'{}'::jsonb);
      INSERT INTO swarm_authority_heartbeat_tokens
        (token_sha256,reservation_id,sequence,issued_by_request_id,issued_at,kind)
        VALUES (repeat('f',64),'00000000-0000-4000-8000-000000000001',0,
          '00000000-0000-4000-8000-000000000002',clock_timestamp(),'claim');
      ROLLBACK;`);
    await assert.rejects(
      db.query(`INSERT INTO swarm_authority_usage_tokens
        (token_sha256,reservation_id,sequence,issued_by_request_id,issued_at,kind)
        VALUES (repeat('a',64),'00000000-0000-4000-8000-000000000001',0,
          '00000000-0000-4000-8000-000000000002',clock_timestamp(),'claim')`),
      /permission denied/i,
    );
    await assert.rejects(
      db.query(`UPDATE swarm_authority_reservations
        SET usage_reconciliation_token_sha256=repeat('b',64) WHERE FALSE`),
      /permission denied/i,
    );
    await assert.rejects(
      db.query(`SELECT public.starlight_append_runner_usage_evidence('{}'::jsonb)`),
      /permission denied/i,
    );
    await assert.rejects(
      db.query(`INSERT INTO swarm_authority_usage_evidence
        (usage_evidence_id,usage_request_id,usage_sequence,provider_event_id,reservation_id,claim_id,outcome_id,
         operation_id,effect_id,binding_digest_sha256,provider_id,provider_account_ref,
         provider_usage_correlation_id,meter_id,evidence_ref,evidence_sha256,usage_started_at,usage_ended_at,
         statement_status,statement_finalized_at,evidence_observed_at,accepted_at,currency,cumulative_cost_usd,
         authorized_cost_usd,budget_breach_observed,presented_token_sha256,next_token_sha256,issuer,key_id,authn_kind)
        VALUES ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002',1,
         '00000000-0000-4000-8000-000000000003','00000000-0000-4000-8000-000000000004',
         '00000000-0000-4000-8000-000000000005','00000000-0000-4000-8000-000000000006','op','effect',
         repeat('0',64),'provider','account','correlation','meter','ref',repeat('1',64),clock_timestamp(),
         clock_timestamp(),'final',clock_timestamp(),clock_timestamp(),clock_timestamp(),'USD',0,0,FALSE,
         repeat('2',64),repeat('3',64),'issuer','key','provider-signed-statement')`),
      /permission denied/i,
    );
    await assert.rejects(
      db.query("UPDATE swarm_authority_prepared_operations SET state='cancelled'"),
      /permission denied/i,
    );
    await assert.rejects(db.query('SELECT * FROM unrelated_private_sentinel'), /permission denied/i);
  } finally { await db.close(); }
});

test('attests a separate no-table-access provider verifier role', async () => {
  const db = await restrictedUsageDatabase();
  try {
    const result = await attestUsageEvidenceDatabaseSession(db);
    assert.equal(result.valid, true, result.valid ? undefined : result.blockers.join(' '));
    await assert.rejects(db.query('SELECT * FROM swarm_authority_reservations'), /permission denied/i);
    await assert.rejects(
      db.query(`SELECT public.starlight_record_usage_refusal('{}'::jsonb,'forged')`),
      /permission denied/i,
    );
    const invalid = await db.query<{ result: { ok: boolean; blocker: string; audited: boolean } }>(
      `SELECT public.starlight_append_runner_usage_evidence('{}'::jsonb) AS result`,
    );
    assert.equal(invalid.rows[0]?.result.ok, false);
    assert.equal(invalid.rows[0]?.result.audited, true);
    assert.match(invalid.rows[0]?.result.blocker ?? '', /input is invalid/i);
  } finally { await db.close(); }
});

test('provider verifier rejects executable authority in another user schema', async () => {
  const db = await restrictedUsageDatabase(`
    CREATE SCHEMA verifier_escape;
    CREATE FUNCTION verifier_escape.unreviewed() RETURNS BOOLEAN LANGUAGE sql SECURITY DEFINER
      AS 'SELECT TRUE';
    GRANT USAGE ON SCHEMA verifier_escape TO starlight_usage_verifier;
    GRANT EXECUTE ON FUNCTION verifier_escape.unreviewed() TO starlight_usage_verifier;
  `);
  try {
    const result = await attestUsageEvidenceDatabaseSession(db);
    assert.equal(result.valid, false);
    assert.match(result.blockers.join(' '), /schemas outside the public verifier boundary/i);
  } finally { await db.close(); }
});

test('provider verifier attestation rejects transitive refusal-helper drift', async (t) => {
  const probes = [
    ['body', `CREATE OR REPLACE FUNCTION public.starlight_record_usage_refusal(jsonb,text)
      RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, public
      AS 'BEGIN RETURN jsonb_build_object(''ok'',TRUE); END';`],
    ['owner', 'ALTER FUNCTION public.starlight_record_usage_refusal(jsonb,text) OWNER TO starlight_usage_verifier;'],
    ['PUBLIC execute', 'GRANT EXECUTE ON FUNCTION public.starlight_record_usage_refusal(jsonb,text) TO PUBLIC;'],
    ['extra append grantee', `CREATE ROLE starlight_rogue_verifier LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOBYPASSRLS NOINHERIT;
      GRANT EXECUTE ON FUNCTION public.starlight_append_runner_usage_evidence(jsonb)
        TO starlight_rogue_verifier;`],
    ['verifier grant option', `GRANT EXECUTE ON FUNCTION
      public.starlight_append_runner_usage_evidence(jsonb) TO starlight_usage_verifier WITH GRANT OPTION;`],
    ['owner-held overload', `CREATE FUNCTION public.starlight_record_usage_refusal(text,text)
      RETURNS jsonb LANGUAGE sql AS 'SELECT ''{}''::jsonb';
      ALTER FUNCTION public.starlight_record_usage_refusal(text,text) OWNER TO starlight_authority_owner;
      REVOKE ALL ON FUNCTION public.starlight_record_usage_refusal(text,text) FROM PUBLIC;`],
  ] as const;
  for (const [name, mutation] of probes) {
    await t.test(name, async () => {
      const db = await restrictedUsageDatabase(mutation);
      try {
        const result = await attestUsageEvidenceDatabaseSession(db);
        assert.equal(result.valid, false);
        assert.match(result.blockers.join(' '), /usage authority routine|routine grants/i);
      } finally { await db.close(); }
    });
  }
});

test('rejects every direct or PUBLIC column grant on the provider verifier', async (t) => {
  const probes = [
    ['column SELECT', 'GRANT SELECT (binding_digest_sha256) ON swarm_authority_reservations TO starlight_usage_verifier'],
    ['column INSERT', 'GRANT INSERT (usage_evidence_id) ON swarm_authority_usage_evidence TO starlight_usage_verifier'],
    ['column UPDATE', 'GRANT UPDATE (usage_reconciliation_token_sha256) ON swarm_authority_reservations TO starlight_usage_verifier'],
    ['PUBLIC column UPDATE', 'GRANT UPDATE (provider_usage_correlation_id) ON swarm_authority_reservations TO PUBLIC'],
  ] as const;
  for (const [name, grant] of probes) {
    await t.test(name, async () => {
      const db = new PGlite();
      await db.exec(`${OPERATION_AUTHORITY_MIGRATION_SQL}
        CREATE ROLE starlight_authority_owner NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
        ${usageAuthorityRoutineOwnerGrantSql('starlight_authority_owner')}
        CREATE ROLE starlight_usage_verifier LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;
        REVOKE TEMPORARY ON DATABASE postgres FROM PUBLIC;
        ${usageEvidenceDatabaseRoleGrantSql('starlight_usage_verifier')}
        ${grant};
        SET SESSION AUTHORIZATION starlight_usage_verifier;`);
      try {
        const result = await attestUsageEvidenceDatabaseSession(db);
        assert.equal(result.valid, false);
        assert.match(result.blockers.join(' '), /column privileges/i);
      } finally { await db.close(); }
    });
  }
});
