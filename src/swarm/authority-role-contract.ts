import { sha256Digest } from './runtime-digest';

interface QueryResult { rows: Record<string, unknown>[] }
export interface RoleContractSqlClient {
  query(sql: string, values?: unknown[]): Promise<QueryResult>;
}

export const BROKER_DATABASE_ROLE_CONTRACT = Object.freeze({
  schema_version: 'starlight.broker_database_role.v1' as const,
  schema: 'public',
  database_grants: ['CONNECT', 'TEMPORARY'],
  table_grants: [
    'swarm_authority_broker_principals:SELECT',
    'swarm_authority_budget_holds:SELECT',
    'swarm_authority_budget_windows:SELECT',
    'swarm_authority_budgets:SELECT',
    'swarm_authority_hosts:SELECT',
    'swarm_authority_prepared_operations:SELECT',
    'swarm_authority_reservations:SELECT',
    'swarm_authority_revocations:SELECT',
    'swarm_authority_audit:INSERT',
  ].sort(),
  column_updates: [
    'swarm_authority_budget_windows:committed_usd',
    'swarm_authority_budget_windows:reserved_usd',
    'swarm_authority_budgets:committed_usd',
    'swarm_authority_budgets:reserved_usd',
    'swarm_authority_hosts:authorized_slots',
    'swarm_authority_hosts:reserved_slots',
    'swarm_authority_reservations:committed_cost_usd',
    'swarm_authority_reservations:broker_database_name',
    'swarm_authority_reservations:broker_database_role',
    'swarm_authority_reservations:broker_role_contract_sha256',
    'swarm_authority_reservations:heartbeat_token_sha256',
    'swarm_authority_reservations:redemption_id',
    'swarm_authority_reservations:redemption_request_id',
    'swarm_authority_reservations:runner_channel_binding_sha256',
    'swarm_authority_reservations:runner_claim_accepted_at',
    'swarm_authority_reservations:runner_claim_expires_at',
    'swarm_authority_reservations:runner_claim_id',
    'swarm_authority_reservations:runner_claim_request_id',
    'swarm_authority_reservations:runner_access_review_expires_at',
    'swarm_authority_reservations:runner_evidence_observed_at',
    'swarm_authority_reservations:runner_host_id',
    'swarm_authority_reservations:runner_id',
    'swarm_authority_reservations:runner_identity_evidence_ref',
    'swarm_authority_reservations:runner_instance_id',
    'swarm_authority_reservations:runner_revocation_refs',
    'swarm_authority_reservations:runner_runtime_id',
    'swarm_authority_reservations:start_authorized_at',
    'swarm_authority_reservations:state',
  ].sort(),
  sequence_grants: ['swarm_authority_audit_seq_seq:USAGE'],
  routine_grants: ['starlight_authority_lock():EXECUTE'],
  forbidden_role_flags: ['rolsuper', 'rolcreaterole', 'rolcreatedb', 'rolreplication', 'rolbypassrls', 'rolinherit'],
  direct_login_required: true,
  memberships_allowed: 0,
});

export const BROKER_DATABASE_ROLE_CONTRACT_SHA256 = sha256Digest(BROKER_DATABASE_ROLE_CONTRACT);

export interface AttestedBrokerDatabaseSession {
  database_role: string;
  database_name: string;
  contract_digest_sha256: string;
}

export type BrokerDatabaseSessionAttestation =
  | { valid: true; session: AttestedBrokerDatabaseSession; blockers: [] }
  | { valid: false; session: null; blockers: string[] };

export type BrokerDatabaseSessionAttestor = (
  client: RoleContractSqlClient,
) => Promise<BrokerDatabaseSessionAttestation>;

function sameSet(actual: string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

/**
 * Read-only attestation of the current PostgreSQL session. This function never
 * creates a role or changes a grant. Provisioning remains a human/infrastructure gate.
 */
export const attestBrokerDatabaseSession: BrokerDatabaseSessionAttestor = async (client) => {
  const blockers: string[] = [];
  const identity = await client.query(`
    SELECT current_user AS database_role,session_user AS session_role,current_database() AS database_name,
           rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls,rolinherit,rolcanlogin
    FROM pg_roles WHERE rolname=current_user
  `);
  if (identity.rows.length !== 1) {
    return { valid: false, session: null, blockers: ['Database session role is missing or ambiguous.'] };
  }
  const row = identity.rows[0];
  const databaseRole = String(row.database_role);
  const sessionRole = String(row.session_role);
  const databaseName = String(row.database_name);
  if (databaseRole !== sessionRole) blockers.push('Broker database role must be the directly authenticated session role.');
  if (row.rolcanlogin !== true) blockers.push('Broker database role must be login-capable.');
  for (const flag of BROKER_DATABASE_ROLE_CONTRACT.forbidden_role_flags) {
    if (row[flag] !== false) blockers.push(`Broker database role has forbidden ${flag} authority.`);
  }

  const memberships = await client.query(`
    SELECT COUNT(*)::INTEGER AS count FROM pg_auth_members
    WHERE member=(SELECT oid FROM pg_roles WHERE rolname=current_user)
  `);
  if (Number(memberships.rows[0]?.count) !== 0) blockers.push('Broker database role must not inherit authority through role membership.');

  const schema = await client.query(`
    SELECT has_schema_privilege(current_user,'public','USAGE') AS can_use,
           has_schema_privilege(current_user,'public','CREATE') AS can_create
  `);
  if (schema.rows[0]?.can_use !== true || schema.rows[0]?.can_create !== false) {
    blockers.push('Broker database role must have public USAGE without CREATE.');
  }

  const databaseGrants = await client.query(`
    SELECT p.privilege_type
    FROM (VALUES ('CONNECT'),('CREATE'),('TEMPORARY')) p(privilege_type)
    WHERE has_database_privilege(current_user,current_database(),p.privilege_type)
    ORDER BY p.privilege_type
  `);
  const actualDatabaseGrants = databaseGrants.rows.map((grant) => String(grant.privilege_type)).sort();
  if (!sameSet(actualDatabaseGrants, BROKER_DATABASE_ROLE_CONTRACT.database_grants)) {
    blockers.push('Broker database role database grants do not exactly match the redemption contract.');
  }

  const ownedObjects = await client.query(`
    SELECT object_kind,object_name FROM (
      SELECT 'database' AS object_kind,datname AS object_name FROM pg_database
        WHERE datname=current_database() AND datdba=(SELECT oid FROM pg_roles WHERE rolname=current_user)
      UNION ALL SELECT 'schema',nspname FROM pg_namespace
        WHERE nspname='public' AND nspowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
      UNION ALL SELECT 'relation',n.nspname||'.'||c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
      UNION ALL SELECT 'routine',n.nspname||'.'||p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname='public' AND p.proowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
    ) owned ORDER BY object_kind,object_name
  `);
  if (ownedObjects.rows.length) blockers.push('Broker database role must not own database objects.');

  const tableGrants = await client.query(`
    SELECT c.relname AS table_name,p.privilege_type
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER')) p(privilege_type)
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')
      AND has_table_privilege(current_user,c.oid,p.privilege_type)
    ORDER BY c.relname,p.privilege_type
  `);
  const actualTableGrants = tableGrants.rows.map((grant) => `${String(grant.table_name)}:${String(grant.privilege_type)}`).sort();
  if (!sameSet(actualTableGrants, BROKER_DATABASE_ROLE_CONTRACT.table_grants)) {
    blockers.push('Broker database role table grants do not exactly match the redemption contract.');
  }

  const effectiveColumns = await client.query(`
    SELECT c.relname AS table_name,a.attname AS column_name,p.privilege_type
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) p(privilege_type)
    WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')
      AND has_column_privilege(current_user,c.oid,a.attnum,p.privilege_type)
    ORDER BY c.relname,a.attname,p.privilege_type
  `);
  const allowedSelectTables = new Set(BROKER_DATABASE_ROLE_CONTRACT.table_grants
    .filter((grant) => grant.endsWith(':SELECT')).map((grant) => grant.split(':')[0]));
  const expectedUpdates = new Set(BROKER_DATABASE_ROLE_CONTRACT.column_updates);
  const actualColumnUpdates: string[] = [];
  const unexpectedColumnAuthority: string[] = [];
  for (const grant of effectiveColumns.rows) {
    const table = String(grant.table_name);
    const column = String(grant.column_name);
    const privilege = String(grant.privilege_type);
    const key = `${table}:${column}`;
    if (privilege === 'UPDATE') actualColumnUpdates.push(key);
    const allowed = (privilege === 'SELECT' && allowedSelectTables.has(table))
      || (privilege === 'INSERT' && table === 'swarm_authority_audit')
      || (privilege === 'UPDATE' && expectedUpdates.has(key));
    if (!allowed) unexpectedColumnAuthority.push(`${key}:${privilege}`);
  }
  actualColumnUpdates.sort();
  if (!sameSet(actualColumnUpdates, BROKER_DATABASE_ROLE_CONTRACT.column_updates)) {
    blockers.push('Broker database role column updates do not exactly match the redemption contract.');
  }
  if (unexpectedColumnAuthority.length) {
    blockers.push('Broker database role has effective column authority outside the redemption contract.');
  }

  const sequences = await client.query(`
    SELECT c.relname AS sequence_name,p.privilege_type
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    CROSS JOIN (VALUES ('SELECT'),('USAGE'),('UPDATE')) p(privilege_type)
    WHERE n.nspname='public' AND c.relkind='S'
      AND has_sequence_privilege(current_user,c.oid,p.privilege_type)
    ORDER BY c.relname,p.privilege_type
  `);
  const actualSequenceGrants = sequences.rows
    .map((grant) => `${String(grant.sequence_name)}:${String(grant.privilege_type)}`).sort();
  if (!sameSet(actualSequenceGrants, BROKER_DATABASE_ROLE_CONTRACT.sequence_grants)) {
    blockers.push('Broker database role sequence grants do not exactly match the redemption contract.');
  }

  const routineGrants = await client.query(`
    SELECT p.proname||'('||pg_get_function_identity_arguments(p.oid)||')' AS routine_name,'EXECUTE' AS privilege_type
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND has_function_privilege(current_user,p.oid,'EXECUTE')
    ORDER BY routine_name
  `);
  const actualRoutineGrants = routineGrants.rows
    .map((grant) => `${String(grant.routine_name)}:${String(grant.privilege_type)}`).sort();
  if (!sameSet(actualRoutineGrants, BROKER_DATABASE_ROLE_CONTRACT.routine_grants)) {
    blockers.push('Broker database role routine grants do not exactly match the redemption contract.');
  }

  if (blockers.length) return { valid: false, session: null, blockers };
  return {
    valid: true,
    session: {
      database_role: databaseRole,
      database_name: databaseName,
      contract_digest_sha256: BROKER_DATABASE_ROLE_CONTRACT_SHA256,
    },
    blockers: [],
  };
};

function roleIdentifier(role: string): string {
  if (!/^[a-z][a-z0-9_]{2,62}$/.test(role)) throw new Error('Broker role name is invalid.');
  return role;
}

/** Deterministic review artifact only. Callers decide whether and where to apply it. */
export function brokerDatabaseRoleGrantSql(untrustedRole: string): string {
  const role = roleIdentifier(untrustedRole);
  const selects = BROKER_DATABASE_ROLE_CONTRACT.table_grants
    .filter((grant) => grant.endsWith(':SELECT'))
    .map((grant) => grant.split(':')[0]);
  const updates = new Map<string, string[]>();
  for (const grant of BROKER_DATABASE_ROLE_CONTRACT.column_updates) {
    const [table, column] = grant.split(':');
    updates.set(table, [...(updates.get(table) ?? []), column]);
  }
  return [
    '-- External prerequisite: effective current-database grants must be CONNECT,TEMPORARY only (no CREATE).',
    `ALTER ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT;`,
    `REVOKE ALL ON SCHEMA public FROM ${role};`,
    `GRANT USAGE ON SCHEMA public TO ${role};`,
    `REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${role};`,
    `REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM ${role};`,
    `REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM ${role};`,
    `GRANT SELECT ON ${selects.join(',')} TO ${role};`,
    'GRANT INSERT ON swarm_authority_audit TO '+role+';',
    ...Array.from(updates.entries()).sort(([a], [b]) => a.localeCompare(b))
      .map(([table, columns]) => `GRANT UPDATE (${columns.sort().join(',')}) ON ${table} TO ${role};`),
    `GRANT USAGE ON SEQUENCE swarm_authority_audit_seq_seq TO ${role};`,
    `GRANT EXECUTE ON FUNCTION starlight_authority_lock() TO ${role};`,
  ].join('\n');
}
