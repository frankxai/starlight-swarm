import { sha256Digest } from './runtime-digest';

export const USAGE_EVIDENCE_DATABASE_ROLE_CONTRACT = Object.freeze({
  schema_version: 'starlight.usage_evidence_database_role.v1' as const,
  schema: 'public',
  database_grants: ['CONNECT'],
  routine_grants: ['starlight_append_runner_usage_evidence(jsonb):EXECUTE'],
  forbidden_role_flags: ['rolsuper', 'rolcreaterole', 'rolcreatedb', 'rolreplication', 'rolbypassrls', 'rolinherit'],
  direct_login_required: true,
  memberships_allowed: 0,
});
export const USAGE_EVIDENCE_DATABASE_ROLE_CONTRACT_SHA256 = sha256Digest(
  USAGE_EVIDENCE_DATABASE_ROLE_CONTRACT,
);

export const USAGE_STREAM_INITIALIZE_ROUTINE = 'starlight_initialize_runner_usage_stream(jsonb)';
export const USAGE_EVIDENCE_APPEND_ROUTINE = 'starlight_append_runner_usage_evidence(jsonb)';
export const USAGE_REFUSAL_ROUTINE = 'starlight_record_usage_refusal(jsonb, text)';

export const USAGE_REFUSAL_BODY = String.raw`
DECLARE
  p ALIAS FOR $1;
  blocker ALIAS FOR $2;
  audit_operation_id TEXT := 'invalid-operation';
  audit_binding_digest CHAR(64) := pg_catalog.repeat('0',64);
  audit_reservation_id TEXT := NULL;
  audit_request_id TEXT := NULL;
BEGIN
  IF pg_catalog.jsonb_typeof(p)='object' THEN
    IF p->>'reservation_id' IS NOT NULL AND p->>'reservation_id' ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      audit_reservation_id := p->>'reservation_id';
      SELECT operation_id,binding_digest_sha256 INTO audit_operation_id,audit_binding_digest
        FROM public.swarm_authority_reservations
       WHERE reservation_id=audit_reservation_id::pg_catalog.uuid;
      IF NOT FOUND THEN
        audit_operation_id := 'invalid-operation';
        audit_binding_digest := pg_catalog.repeat('0',64);
      END IF;
    END IF;
    IF p->>'usage_request_id' IS NOT NULL AND p->>'usage_request_id' ~
        '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      audit_request_id := p->>'usage_request_id';
    END IF;
  END IF;
  INSERT INTO public.swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
  VALUES ('runner-usage-evidence-denied',audit_operation_id,audit_binding_digest,
    pg_catalog.clock_timestamp(),pg_catalog.jsonb_build_object(
      'reservation_id',audit_reservation_id,'usage_request_id',audit_request_id,
      'blockers',pg_catalog.jsonb_build_array(blocker),'direct_function_refusal',TRUE,
      'released_cost_usd','0.000000'));
  RETURN pg_catalog.jsonb_build_object('ok',FALSE,'blocker',blocker,'audited',TRUE);
END`;

export const USAGE_STREAM_INITIALIZE_BODY = String.raw`
DECLARE
  p ALIAS FOR $1;
  r RECORD;
  principal RECORD;
  collision BOOLEAN;
  invoker_superuser BOOLEAN;
  accepted_at pg_catalog.timestamptz;
  token_digest TEXT;
BEGIN
  SELECT pg_catalog.clock_timestamp() INTO accepted_at;
  IF NOT (p ?& ARRAY['reservation_id','claim_id','claim_request_id','operation_id','binding_digest_sha256',
      'usage_reconciliation_token','provider_usage_correlation_id']::pg_catalog.text[])
     OR p - ARRAY['reservation_id','claim_id','claim_request_id','operation_id','binding_digest_sha256',
      'usage_reconciliation_token','provider_usage_correlation_id']::pg_catalog.text[] <> '{}'::pg_catalog.jsonb
     OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_each(p) field
       WHERE pg_catalog.jsonb_typeof(field.value)<>'string')
     OR p->>'reservation_id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR p->>'claim_id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR p->>'claim_request_id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR p->>'operation_id' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$'
     OR p->>'binding_digest_sha256' !~ '^[a-f0-9]{64}$'
     OR p->>'usage_reconciliation_token' !~ '^[A-Za-z0-9_-]{43}$'
     OR p->>'provider_usage_correlation_id' !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$' THEN
    RETURN public.starlight_record_usage_refusal(p,'Runner usage-stream initialization input is invalid.');
  END IF;
  token_digest := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p->>'usage_reconciliation_token','UTF8')),'hex');
  PERFORM 1 FROM public.swarm_authority_control WHERE singleton=TRUE FOR UPDATE;
  IF NOT FOUND THEN
    RETURN public.starlight_record_usage_refusal(p,'Authority serialization control row is missing or ambiguous.');
  END IF;
  SELECT * INTO r FROM public.swarm_authority_reservations
   WHERE reservation_id=(p->>'reservation_id')::pg_catalog.uuid FOR UPDATE;
  IF NOT FOUND OR r.state <> 'runner-claimed-not-started'
     OR r.runner_claim_id IS DISTINCT FROM (p->>'claim_id')::pg_catalog.uuid
     OR r.runner_claim_request_id IS DISTINCT FROM (p->>'claim_request_id')::pg_catalog.uuid
     OR r.operation_id IS DISTINCT FROM p->>'operation_id'
     OR r.binding_digest_sha256 IS DISTINCT FROM p->>'binding_digest_sha256'
     OR r.broker_role_contract_sha256 IS NULL THEN
    RETURN public.starlight_record_usage_refusal(p,'Runner claim is not eligible for usage-stream initialization.');
  END IF;
  IF r.binding_database_sha256 IS DISTINCT FROM
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(r.binding::pg_catalog.text,'UTF8')),'hex') THEN
    RETURN public.starlight_record_usage_refusal(p,'Stored operation binding is not database-canonical.');
  END IF;
  SELECT rolsuper INTO invoker_superuser FROM pg_catalog.pg_roles WHERE rolname=session_user;
  IF invoker_superuser IS NOT TRUE AND (session_user <> r.broker_database_role
      OR pg_catalog.current_database() <> r.broker_database_name) THEN
    RETURN public.starlight_record_usage_refusal(p,'Authenticated broker session does not own this runner claim.');
  END IF;
  SELECT * INTO principal FROM public.swarm_authority_broker_principals
   WHERE database_role=r.broker_database_role AND database_name=r.broker_database_name;
  IF NOT FOUND OR principal.state <> 'ready'
     OR principal.authn_kind <> 'postgres-session-role'
     OR principal.broker_execution_identity IS DISTINCT FROM r.broker_execution_identity
     OR principal.broker_identity_evidence_ref IS DISTINCT FROM r.broker_identity_evidence_ref
     OR principal.role_contract_digest_sha256 IS DISTINCT FROM r.broker_role_contract_sha256
     OR principal.evidence->>'database_role' IS DISTINCT FROM principal.database_role
     OR principal.evidence->>'database_name' IS DISTINCT FROM principal.database_name
     OR principal.evidence->>'broker_execution_identity' IS DISTINCT FROM principal.broker_execution_identity
     OR principal.evidence->>'broker_identity_evidence_ref' IS DISTINCT FROM principal.broker_identity_evidence_ref
     OR principal.evidence->>'authn_kind' IS DISTINCT FROM principal.authn_kind
     OR principal.evidence->>'role_contract_digest_sha256' IS DISTINCT FROM principal.role_contract_digest_sha256
     OR principal.evidence->>'state' IS DISTINCT FROM principal.state
     OR (principal.evidence->>'observed_at')::pg_catalog.timestamptz IS DISTINCT FROM principal.observed_at
     OR (principal.evidence->>'access_review_expires_at')::pg_catalog.timestamptz IS DISTINCT FROM principal.access_review_expires_at
     OR principal.observed_at > accepted_at
     OR accepted_at-principal.observed_at > pg_catalog.make_interval(secs => 300)
     OR principal.access_review_expires_at <= accepted_at THEN
    RETURN public.starlight_record_usage_refusal(p,'Broker principal is unavailable, expired, disabled, or drifted.');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.swarm_authority_prepared_operations o
      WHERE o.operation_id=r.operation_id AND o.binding_digest_sha256=r.binding_digest_sha256 AND o.state='ready')
     OR EXISTS (SELECT 1 FROM public.swarm_authority_revocations v
      WHERE v.ref IN ('operation:'||r.operation_id,'effect:'||r.effect_id,'runner:'||r.runner_id,
        'runtime:'||r.runner_runtime_id,'host:'||r.runner_host_id,
        'broker-principal:'||r.broker_database_name||':'||r.broker_database_role)) THEN
    RETURN public.starlight_record_usage_refusal(p,'Runner usage-stream authority is cancelled or revoked.');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.swarm_authority_budgets b WHERE b.receipt_id=r.budget_receipt_id
      AND b.committed_usd IS NOT DISTINCT FROM (SELECT COALESCE(pg_catalog.sum(q.reserved_cost_usd),0::pg_catalog.numeric)
        FROM public.swarm_authority_reservations q WHERE q.budget_receipt_id=r.budget_receipt_id
          AND q.state IN ('start-authorized-not-observed','runner-claimed-not-started','runner-start-observed',
                          'stop-requested','runner-never-started-observed','runner-terminal-observed'))) THEN
    RETURN public.starlight_record_usage_refusal(p,'Committed receipt budget authority is missing or inconsistent.');
  END IF;
  IF r.usage_reconciliation_token_sha256 IS NOT NULL OR r.provider_usage_correlation_id IS NOT NULL THEN
    IF r.usage_reconciliation_token_sha256 = token_digest
       AND r.provider_usage_correlation_id = p->>'provider_usage_correlation_id'
       AND EXISTS (SELECT 1 FROM public.swarm_authority_usage_tokens t
          WHERE t.token_sha256=token_digest AND t.reservation_id=r.reservation_id
            AND t.sequence=0 AND t.issued_by_request_id=r.runner_claim_request_id AND t.kind='claim') THEN
      RETURN pg_catalog.jsonb_build_object('ok',TRUE,'retry',TRUE);
    END IF;
    RETURN public.starlight_record_usage_refusal(p,'Runner usage-stream initialization drifted.');
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.swarm_authority_usage_tokens WHERE token_sha256=token_digest
    UNION ALL SELECT 1 FROM public.swarm_authority_heartbeat_tokens WHERE token_sha256=token_digest
    UNION ALL SELECT 1 FROM public.swarm_authority_reservations q
      WHERE q.consume_token_sha256=token_digest OR q.cancel_token_sha256=token_digest
        OR q.lease_claim_token_sha256=token_digest OR q.redemption_token_sha256=token_digest
        OR q.control_token_sha256=token_digest OR q.heartbeat_token_sha256=token_digest
        OR q.start_observation_token_sha256=token_digest OR q.outcome_token_sha256=token_digest
        OR q.usage_reconciliation_token_sha256=token_digest
        OR q.runner_heartbeat_presented_token_sha256=token_digest
        OR q.runner_start_presented_token_sha256=token_digest
        OR q.runner_outcome_presented_token_sha256=token_digest
  ) INTO collision;
  IF collision THEN
    RETURN public.starlight_record_usage_refusal(p,'Usage-reconciliation credential was already issued.');
  END IF;
  IF EXISTS (SELECT 1 FROM public.swarm_authority_reservations q
      WHERE q.provider_usage_correlation_id=p->>'provider_usage_correlation_id') THEN
    RETURN public.starlight_record_usage_refusal(p,'Provider usage correlation is already bound to another reservation.');
  END IF;
  UPDATE public.swarm_authority_reservations
     SET usage_reconciliation_token_sha256=token_digest,
         provider_usage_correlation_id=p->>'provider_usage_correlation_id'
   WHERE reservation_id=r.reservation_id
     AND usage_reconciliation_token_sha256 IS NULL AND provider_usage_correlation_id IS NULL;
  IF NOT FOUND THEN
    RETURN public.starlight_record_usage_refusal(p,'Runner usage-stream initialization lost its authority race.');
  END IF;
  INSERT INTO public.swarm_authority_usage_tokens
    (token_sha256,reservation_id,sequence,issued_by_request_id,issued_at,kind)
  VALUES (token_digest,r.reservation_id,0,r.runner_claim_request_id,accepted_at,'claim');
  RETURN pg_catalog.jsonb_build_object('ok',TRUE,'retry',FALSE);
END`;

export const USAGE_EVIDENCE_APPEND_BODY = String.raw`
DECLARE
  p ALIAS FOR $1;
  r RECORD;
  prior RECORD;
  latest RECORD;
  inserted RECORD;
  principal RECORD;
  prior_sequence INTEGER;
  breach BOOLEAN;
  collision BOOLEAN;
  invoker_superuser BOOLEAN;
  accepted_at pg_catalog.timestamptz;
  presented_digest TEXT;
  next_digest TEXT;
BEGIN
  SELECT pg_catalog.clock_timestamp() INTO accepted_at;
  IF NOT (p ?& ARRAY['usage_evidence_id','usage_request_id','usage_sequence','provider_event_id','reservation_id',
      'claim_id','outcome_id','operation_id','effect_id','binding_digest_sha256','role_contract_digest_sha256',
      'verifier_database_role','verifier_database_name','verifier_role_contract_sha256',
      'runner_id','runner_identity_evidence_ref','runner_instance_id',
      'runtime_id','host_id','channel_binding_sha256','launch_attempt_id','fencing_generation','process_instance_sha256',
      'provider_id','provider_account_ref','provider_usage_correlation_id','meter_id','evidence_ref','evidence_sha256',
      'usage_started_at','usage_ended_at','statement_status','statement_finalized_at','evidence_observed_at',
      'access_review_expires_at','cumulative_cost_usd','usage_reconciliation_token',
      'next_usage_reconciliation_token','issuer','key_id','authn_kind']::pg_catalog.text[])
     OR p - ARRAY['usage_evidence_id','usage_request_id','usage_sequence','provider_event_id','reservation_id',
      'claim_id','outcome_id','operation_id','effect_id','binding_digest_sha256','role_contract_digest_sha256',
      'verifier_database_role','verifier_database_name','verifier_role_contract_sha256',
      'runner_id','runner_identity_evidence_ref','runner_instance_id',
      'runtime_id','host_id','channel_binding_sha256','launch_attempt_id','fencing_generation','process_instance_sha256',
      'provider_id','provider_account_ref','provider_usage_correlation_id','meter_id','evidence_ref','evidence_sha256',
      'usage_started_at','usage_ended_at','statement_status','statement_finalized_at','evidence_observed_at',
      'access_review_expires_at','cumulative_cost_usd','usage_reconciliation_token',
      'next_usage_reconciliation_token','issuer','key_id','authn_kind']::pg_catalog.text[] <> '{}'::pg_catalog.jsonb
     OR pg_catalog.jsonb_typeof(p->'usage_sequence')<>'number'
     OR pg_catalog.jsonb_typeof(p->'fencing_generation')<>'number'
     OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_each(p) field
       WHERE field.key NOT IN ('usage_sequence','fencing_generation','statement_finalized_at','process_instance_sha256')
         AND pg_catalog.jsonb_typeof(field.value)<>'string')
     OR (p->'statement_finalized_at'<>'null'::pg_catalog.jsonb
       AND pg_catalog.jsonb_typeof(p->'statement_finalized_at')<>'string')
     OR (p->'process_instance_sha256'<>'null'::pg_catalog.jsonb
       AND pg_catalog.jsonb_typeof(p->'process_instance_sha256')<>'string')
     OR p->>'usage_evidence_id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR p->>'usage_request_id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR p->>'provider_event_id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR p->>'reservation_id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR p->>'claim_id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR p->>'outcome_id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR p->>'binding_digest_sha256' !~ '^[a-f0-9]{64}$' OR p->>'role_contract_digest_sha256' !~ '^[a-f0-9]{64}$'
     OR p->>'verifier_role_contract_sha256' !~ '^[a-f0-9]{64}$'
     OR p->>'verifier_role_contract_sha256' <> '${USAGE_EVIDENCE_DATABASE_ROLE_CONTRACT_SHA256}'
     OR p->>'channel_binding_sha256' !~ '^[a-f0-9]{64}$' OR p->>'evidence_sha256' !~ '^[a-f0-9]{64}$'
     OR (p->>'process_instance_sha256' IS NOT NULL AND p->>'process_instance_sha256' !~ '^[a-f0-9]{64}$')
     OR p->>'usage_reconciliation_token' !~ '^[A-Za-z0-9_-]{43}$'
     OR p->>'next_usage_reconciliation_token' !~ '^[A-Za-z0-9_-]{43}$'
     OR p->>'usage_reconciliation_token'=p->>'next_usage_reconciliation_token'
     OR p->>'cumulative_cost_usd' !~ '^(0|[1-9][0-9]{0,7})\.[0-9]{6}$'
     OR p->>'usage_sequence' !~ '^[1-9][0-9]{0,8}$'
     OR p->>'fencing_generation' !~ '^[1-9][0-9]{0,8}$'
     OR p->>'usage_started_at' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
     OR p->>'usage_ended_at' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
     OR p->>'evidence_observed_at' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
     OR p->>'access_review_expires_at' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$'
     OR (p->>'statement_finalized_at' IS NOT NULL AND p->>'statement_finalized_at'
       !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,6})?(Z|[+-][0-9]{2}:[0-9]{2})$')
     OR p->>'statement_status' NOT IN ('provisional','final')
     OR p->>'authn_kind' <> 'provider-signed-statement'
     OR p->>'verifier_database_role' !~ '^[a-z][a-z0-9_]{2,62}$'
     OR pg_catalog.length(p->>'verifier_database_name') NOT BETWEEN 1 AND 63
     OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_each_text(p) field
        WHERE field.key IN ('operation_id','effect_id','runner_id','runner_identity_evidence_ref','runner_instance_id',
          'runtime_id','host_id','launch_attempt_id','provider_id','provider_account_ref',
          'provider_usage_correlation_id','meter_id','evidence_ref','issuer','key_id')
          AND field.value !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$') THEN
    RETURN public.starlight_record_usage_refusal(p,'Runner usage-evidence append input is invalid.');
  END IF;
  IF (p->>'usage_started_at')::pg_catalog.timestamptz > (p->>'usage_ended_at')::pg_catalog.timestamptz
     OR (p->>'usage_ended_at')::pg_catalog.timestamptz > (p->>'evidence_observed_at')::pg_catalog.timestamptz
     OR (p->>'evidence_observed_at')::pg_catalog.timestamptz >= (p->>'access_review_expires_at')::pg_catalog.timestamptz
     OR (p->>'statement_status'='final' AND ((p->>'statement_finalized_at') IS NULL
       OR (p->>'statement_finalized_at')::pg_catalog.timestamptz < (p->>'usage_ended_at')::pg_catalog.timestamptz
       OR (p->>'statement_finalized_at')::pg_catalog.timestamptz > (p->>'evidence_observed_at')::pg_catalog.timestamptz))
     OR (p->>'statement_status'='provisional' AND (p->>'statement_finalized_at') IS NOT NULL) THEN
    RETURN public.starlight_record_usage_refusal(p,'Runner usage-evidence chronology or finality is invalid.');
  END IF;
  SELECT rolsuper INTO invoker_superuser FROM pg_catalog.pg_roles WHERE rolname=session_user;
  IF invoker_superuser IS NOT TRUE AND (session_user <> p->>'verifier_database_role'
      OR pg_catalog.current_database() <> p->>'verifier_database_name') THEN
    RETURN public.starlight_record_usage_refusal(p,'Authenticated usage verifier session does not match the attested caller.');
  END IF;
  presented_digest := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p->>'usage_reconciliation_token','UTF8')),'hex');
  next_digest := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p->>'next_usage_reconciliation_token','UTF8')),'hex');
  PERFORM 1 FROM public.swarm_authority_control WHERE singleton=TRUE FOR UPDATE;
  IF NOT FOUND THEN
    RETURN public.starlight_record_usage_refusal(p,'Authority serialization control row is missing or ambiguous.');
  END IF;
  SELECT *, (reserved_cost_usd IS NOT DISTINCT FROM (binding->>'requested_cost_usd')::pg_catalog.numeric) AS cost_matches_binding
    INTO r FROM public.swarm_authority_reservations
   WHERE reservation_id=(p->>'reservation_id')::pg_catalog.uuid
     AND runner_claim_id=(p->>'claim_id')::pg_catalog.uuid
     AND runner_outcome_id=(p->>'outcome_id')::pg_catalog.uuid FOR UPDATE;
  IF NOT FOUND THEN
    RETURN public.starlight_record_usage_refusal(p,'Settled runner outcome does not exist.');
  END IF;
  IF r.operation_id IS DISTINCT FROM p->>'operation_id' OR r.effect_id IS DISTINCT FROM p->>'effect_id'
     OR r.binding_digest_sha256 IS DISTINCT FROM p->>'binding_digest_sha256'
     OR r.broker_role_contract_sha256 IS DISTINCT FROM p->>'role_contract_digest_sha256'
     OR r.state NOT IN ('runner-never-started-observed','runner-terminal-observed') THEN
    RETURN public.starlight_record_usage_refusal(p,'Runner usage request does not match a settled operation.');
  END IF;
  IF r.binding_database_sha256 IS DISTINCT FROM
      pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(r.binding::pg_catalog.text,'UTF8')),'hex') THEN
    RETURN public.starlight_record_usage_refusal(p,'Stored operation binding is not database-canonical.');
  END IF;
  IF r.cost_matches_binding IS NOT TRUE OR r.committed_cost_usd IS DISTINCT FROM r.reserved_cost_usd THEN
    RETURN public.starlight_record_usage_refusal(p,'Stored operation or committed cost is invalid or drifted.');
  END IF;
  IF r.provider_usage_correlation_id IS DISTINCT FROM p->>'provider_usage_correlation_id'
     OR r.runner_id IS DISTINCT FROM p->>'runner_id'
     OR r.runner_identity_evidence_ref IS DISTINCT FROM p->>'runner_identity_evidence_ref'
     OR r.runner_instance_id IS DISTINCT FROM p->>'runner_instance_id'
     OR r.runner_runtime_id IS DISTINCT FROM p->>'runtime_id'
     OR r.runner_host_id IS DISTINCT FROM p->>'host_id'
     OR r.runner_channel_binding_sha256 IS DISTINCT FROM p->>'channel_binding_sha256'
     OR r.runner_launch_attempt_id IS DISTINCT FROM p->>'launch_attempt_id'
     OR r.runner_fencing_generation IS DISTINCT FROM (p->>'fencing_generation')::pg_catalog.int4
     OR r.runner_process_instance_sha256 IS DISTINCT FROM p->>'process_instance_sha256' THEN
    RETURN public.starlight_record_usage_refusal(p,'Runner usage evidence is bound to another execution generation.');
  END IF;
  SELECT * INTO principal FROM public.swarm_authority_broker_principals
   WHERE database_role=r.broker_database_role AND database_name=r.broker_database_name;
  IF NOT FOUND OR principal.state <> 'ready'
     OR principal.authn_kind <> 'postgres-session-role'
     OR principal.broker_execution_identity IS DISTINCT FROM r.broker_execution_identity
     OR principal.broker_identity_evidence_ref IS DISTINCT FROM r.broker_identity_evidence_ref
     OR principal.role_contract_digest_sha256 IS DISTINCT FROM p->>'role_contract_digest_sha256'
     OR principal.evidence->>'database_role' IS DISTINCT FROM principal.database_role
     OR principal.evidence->>'database_name' IS DISTINCT FROM principal.database_name
     OR principal.evidence->>'broker_execution_identity' IS DISTINCT FROM principal.broker_execution_identity
     OR principal.evidence->>'broker_identity_evidence_ref' IS DISTINCT FROM principal.broker_identity_evidence_ref
     OR principal.evidence->>'authn_kind' IS DISTINCT FROM principal.authn_kind
     OR principal.evidence->>'role_contract_digest_sha256' IS DISTINCT FROM principal.role_contract_digest_sha256
     OR principal.evidence->>'state' IS DISTINCT FROM principal.state
     OR (principal.evidence->>'observed_at')::pg_catalog.timestamptz IS DISTINCT FROM principal.observed_at
     OR (principal.evidence->>'access_review_expires_at')::pg_catalog.timestamptz IS DISTINCT FROM principal.access_review_expires_at
     OR principal.observed_at > accepted_at
     OR accepted_at-principal.observed_at > pg_catalog.make_interval(secs => 300)
     OR principal.access_review_expires_at <= accepted_at THEN
    RETURN public.starlight_record_usage_refusal(p,'Broker principal is unavailable, expired, disabled, or drifted.');
  END IF;
  IF EXISTS (SELECT 1 FROM public.swarm_authority_revocations v
      WHERE v.ref IN ('operation:'||r.operation_id,'effect:'||r.effect_id,'runner:'||r.runner_id,
                      'runtime:'||r.runner_runtime_id,'host:'||r.runner_host_id,
                      'broker-principal:'||r.broker_database_name||':'||r.broker_database_role)) THEN
    RETURN public.starlight_record_usage_refusal(p,'Runner usage authority is revoked.');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.swarm_authority_prepared_operations o
      WHERE o.operation_id=r.operation_id AND o.binding_digest_sha256=r.binding_digest_sha256 AND o.state='ready') THEN
    RETURN public.starlight_record_usage_refusal(p,'Prepared operation is unavailable or cancelled.');
  END IF;
  IF (p->>'usage_started_at')::pg_catalog.timestamptz < r.runner_claim_accepted_at
     OR (p->>'usage_ended_at')::pg_catalog.timestamptz > r.runner_outcome_at THEN
    RETURN public.starlight_record_usage_refusal(p,'Runner usage interval falls outside the authenticated execution interval.');
  END IF;
  IF (p->>'evidence_observed_at')::pg_catalog.timestamptz > accepted_at
     OR accepted_at-(p->>'evidence_observed_at')::pg_catalog.timestamptz > pg_catalog.make_interval(secs => 60)
     OR (p->>'access_review_expires_at')::pg_catalog.timestamptz <= accepted_at THEN
    RETURN public.starlight_record_usage_refusal(p,'Runner usage evidence is stale or future-dated.');
  END IF;

  -- The authority control-row lock above serializes this routine globally. Do not
  -- require UPDATE privilege on immutable evidence merely to take a second lock.
  SELECT * INTO prior FROM public.swarm_authority_usage_evidence
   WHERE usage_request_id=(p->>'usage_request_id')::pg_catalog.uuid;
  IF FOUND THEN
    IF prior.reservation_id=(p->>'reservation_id')::pg_catalog.uuid
       AND prior.claim_id=(p->>'claim_id')::pg_catalog.uuid AND prior.outcome_id=(p->>'outcome_id')::pg_catalog.uuid
       AND prior.operation_id=p->>'operation_id' AND prior.effect_id=p->>'effect_id'
       AND prior.binding_digest_sha256=p->>'binding_digest_sha256'
       AND prior.verifier_database_role=p->>'verifier_database_role'
       AND prior.verifier_database_name=p->>'verifier_database_name'
       AND prior.verifier_role_contract_sha256=p->>'verifier_role_contract_sha256'
       AND prior.usage_sequence=(p->>'usage_sequence')::pg_catalog.int4
       AND prior.presented_token_sha256=presented_digest
       AND prior.next_token_sha256=next_digest
       AND prior.provider_event_id=(p->>'provider_event_id')::pg_catalog.uuid
       AND prior.provider_id=p->>'provider_id' AND prior.provider_account_ref=p->>'provider_account_ref'
       AND prior.provider_usage_correlation_id=p->>'provider_usage_correlation_id'
       AND prior.meter_id=p->>'meter_id' AND prior.evidence_ref=p->>'evidence_ref'
       AND prior.evidence_sha256=p->>'evidence_sha256'
       AND prior.usage_started_at=(p->>'usage_started_at')::pg_catalog.timestamptz
       AND prior.usage_ended_at=(p->>'usage_ended_at')::pg_catalog.timestamptz
       AND prior.statement_status=p->>'statement_status'
       AND prior.statement_finalized_at IS NOT DISTINCT FROM (p->>'statement_finalized_at')::pg_catalog.timestamptz
       AND prior.evidence_observed_at=(p->>'evidence_observed_at')::pg_catalog.timestamptz
       AND prior.currency='USD' AND prior.cumulative_cost_usd=(p->>'cumulative_cost_usd')::pg_catalog.numeric
       AND prior.issuer=p->>'issuer' AND prior.key_id=p->>'key_id' AND prior.authn_kind=p->>'authn_kind' THEN
      RETURN pg_catalog.jsonb_build_object('ok',TRUE,'retry',TRUE,'row',pg_catalog.to_jsonb(prior));
    END IF;
    RETURN public.starlight_record_usage_refusal(p,'Runner usage-evidence retry drifted.');
  END IF;

  SELECT * INTO latest FROM public.swarm_authority_usage_evidence
   WHERE reservation_id=r.reservation_id ORDER BY usage_sequence DESC LIMIT 1;
  prior_sequence := CASE WHEN FOUND THEN latest.usage_sequence ELSE 0 END;
  IF latest.statement_status='final' THEN
    RETURN public.starlight_record_usage_refusal(p,'A final provider usage statement is already recorded.');
  END IF;
  IF (p->>'usage_sequence')::pg_catalog.int4 <> prior_sequence + 1 THEN
    RETURN public.starlight_record_usage_refusal(p,'Runner usage-evidence sequence is stale, skipped, or already consumed.');
  END IF;
  IF r.usage_reconciliation_token_sha256 IS DISTINCT FROM presented_digest
     OR NOT EXISTS (SELECT 1 FROM public.swarm_authority_usage_tokens t
        WHERE t.token_sha256=presented_digest AND t.reservation_id=r.reservation_id
          AND t.sequence=prior_sequence) THEN
    RETURN public.starlight_record_usage_refusal(p,'Usage-reconciliation credential is invalid or already rotated.');
  END IF;
  IF prior_sequence > 0 AND (latest.provider_id IS DISTINCT FROM p->>'provider_id'
     OR latest.verifier_database_role IS DISTINCT FROM p->>'verifier_database_role'
     OR latest.verifier_database_name IS DISTINCT FROM p->>'verifier_database_name'
     OR latest.verifier_role_contract_sha256 IS DISTINCT FROM p->>'verifier_role_contract_sha256'
     OR latest.provider_account_ref IS DISTINCT FROM p->>'provider_account_ref'
     OR latest.provider_usage_correlation_id IS DISTINCT FROM p->>'provider_usage_correlation_id'
     OR latest.meter_id IS DISTINCT FROM p->>'meter_id' OR latest.currency <> 'USD'
     OR latest.authn_kind IS DISTINCT FROM p->>'authn_kind' OR latest.issuer IS DISTINCT FROM p->>'issuer'
     OR latest.key_id IS DISTINCT FROM p->>'key_id'
     OR latest.usage_started_at IS DISTINCT FROM (p->>'usage_started_at')::pg_catalog.timestamptz
     OR latest.usage_ended_at > (p->>'usage_ended_at')::pg_catalog.timestamptz
     OR latest.next_token_sha256 IS DISTINCT FROM presented_digest
     OR latest.cumulative_cost_usd > (p->>'cumulative_cost_usd')::pg_catalog.numeric) THEN
    RETURN public.starlight_record_usage_refusal(p,'Provider usage stream identity, key, interval, cost, or token chain drifted.');
  END IF;
  IF EXISTS (SELECT 1 FROM public.swarm_authority_usage_evidence e
      WHERE e.provider_event_id=(p->>'provider_event_id')::pg_catalog.uuid
         OR e.evidence_ref=p->>'evidence_ref' OR e.evidence_sha256=p->>'evidence_sha256') THEN
    RETURN public.starlight_record_usage_refusal(p,'Provider usage evidence is already bound to another request.');
  END IF;
  SELECT EXISTS (
    SELECT 1 FROM public.swarm_authority_usage_tokens WHERE token_sha256=next_digest
    UNION ALL SELECT 1 FROM public.swarm_authority_heartbeat_tokens WHERE token_sha256=next_digest
    UNION ALL SELECT 1 FROM public.swarm_authority_reservations q
      WHERE q.consume_token_sha256=next_digest OR q.cancel_token_sha256=next_digest
        OR q.lease_claim_token_sha256=next_digest OR q.redemption_token_sha256=next_digest
        OR q.control_token_sha256=next_digest OR q.heartbeat_token_sha256=next_digest
        OR q.start_observation_token_sha256=next_digest OR q.outcome_token_sha256=next_digest
        OR q.usage_reconciliation_token_sha256=next_digest
        OR q.runner_heartbeat_presented_token_sha256=next_digest
        OR q.runner_start_presented_token_sha256=next_digest
        OR q.runner_outcome_presented_token_sha256=next_digest
  ) INTO collision;
  IF collision THEN
    RETURN public.starlight_record_usage_refusal(p,'Next usage-reconciliation credential was already issued.');
  END IF;
  IF NOT (SELECT pg_catalog.count(*)=2 AND pg_catalog.count(DISTINCT w.kind)=2
      FROM public.swarm_authority_budget_holds h
      JOIN public.swarm_authority_budget_windows w ON w.window_id=h.window_id
      WHERE h.reservation_id=r.reservation_id AND h.reserved_cost_usd=r.reserved_cost_usd
        AND w.policy_id=r.binding->>'budget_policy_id' AND w.kind IN ('policy','daily'))
     OR EXISTS (SELECT 1 FROM public.swarm_authority_budget_holds h
       JOIN public.swarm_authority_budget_windows w ON w.window_id=h.window_id
       WHERE h.reservation_id=r.reservation_id
         AND w.committed_usd IS DISTINCT FROM (SELECT COALESCE(pg_catalog.sum(qh.reserved_cost_usd),0::pg_catalog.numeric)
           FROM public.swarm_authority_budget_holds qh
           JOIN public.swarm_authority_reservations q ON q.reservation_id=qh.reservation_id
           WHERE qh.window_id=w.window_id AND q.state IN
             ('start-authorized-not-observed','runner-claimed-not-started','runner-start-observed','stop-requested',
              'runner-never-started-observed','runner-terminal-observed'))) THEN
    RETURN public.starlight_record_usage_refusal(p,'Committed aggregate budget authority is missing or inconsistent.');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.swarm_authority_budgets b WHERE b.receipt_id=r.budget_receipt_id
      AND b.committed_usd IS NOT DISTINCT FROM (SELECT COALESCE(pg_catalog.sum(q.reserved_cost_usd),0::pg_catalog.numeric)
        FROM public.swarm_authority_reservations q WHERE q.budget_receipt_id=r.budget_receipt_id
          AND q.state IN ('start-authorized-not-observed','runner-claimed-not-started','runner-start-observed',
                          'stop-requested','runner-never-started-observed','runner-terminal-observed'))) THEN
    RETURN public.starlight_record_usage_refusal(p,'Committed receipt budget authority is missing or inconsistent.');
  END IF;
  breach := (p->>'cumulative_cost_usd')::pg_catalog.numeric > r.committed_cost_usd
         OR (r.runner_outcome_kind='never-started' AND (p->>'cumulative_cost_usd')::pg_catalog.numeric <> 0);
  INSERT INTO public.swarm_authority_usage_evidence
    (usage_evidence_id,usage_request_id,usage_sequence,provider_event_id,reservation_id,claim_id,outcome_id,
     operation_id,effect_id,binding_digest_sha256,verifier_database_role,verifier_database_name,
     verifier_role_contract_sha256,provider_id,provider_account_ref,provider_usage_correlation_id,
     meter_id,evidence_ref,evidence_sha256,usage_started_at,usage_ended_at,statement_status,statement_finalized_at,
     evidence_observed_at,accepted_at,currency,cumulative_cost_usd,authorized_cost_usd,budget_breach_observed,
     presented_token_sha256,next_token_sha256,issuer,key_id,authn_kind)
  VALUES ((p->>'usage_evidence_id')::pg_catalog.uuid,(p->>'usage_request_id')::pg_catalog.uuid,
     (p->>'usage_sequence')::pg_catalog.int4,(p->>'provider_event_id')::pg_catalog.uuid,r.reservation_id,r.runner_claim_id,
     r.runner_outcome_id,r.operation_id,r.effect_id,r.binding_digest_sha256,p->>'verifier_database_role',
     p->>'verifier_database_name',p->>'verifier_role_contract_sha256',p->>'provider_id',p->>'provider_account_ref',
     p->>'provider_usage_correlation_id',p->>'meter_id',p->>'evidence_ref',p->>'evidence_sha256',
     (p->>'usage_started_at')::pg_catalog.timestamptz,(p->>'usage_ended_at')::pg_catalog.timestamptz,p->>'statement_status',
     (p->>'statement_finalized_at')::pg_catalog.timestamptz,(p->>'evidence_observed_at')::pg_catalog.timestamptz,
     accepted_at,'USD',(p->>'cumulative_cost_usd')::pg_catalog.numeric,r.committed_cost_usd,breach,
     presented_digest,next_digest,p->>'issuer',p->>'key_id',p->>'authn_kind') RETURNING * INTO inserted;
  UPDATE public.swarm_authority_reservations SET usage_reconciliation_token_sha256=next_digest
   WHERE reservation_id=r.reservation_id AND usage_reconciliation_token_sha256=presented_digest;
  IF NOT FOUND THEN RAISE EXCEPTION 'Usage-reconciliation credential rotation lost its authority race.'; END IF;
  INSERT INTO public.swarm_authority_usage_tokens
    (token_sha256,reservation_id,sequence,issued_by_request_id,issued_at,kind)
  VALUES (next_digest,r.reservation_id,(p->>'usage_sequence')::pg_catalog.int4,
          (p->>'usage_request_id')::pg_catalog.uuid,accepted_at,'usage-evidence');
  INSERT INTO public.swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
  VALUES ('runner-usage-evidence-observed',r.operation_id,r.binding_digest_sha256,accepted_at,pg_catalog.to_jsonb(inserted));
  IF breach THEN
    INSERT INTO public.swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
    VALUES ('runner-usage-budget-breach',r.operation_id,r.binding_digest_sha256,accepted_at,
      pg_catalog.jsonb_build_object('reservation_id',r.reservation_id,'claim_id',r.runner_claim_id,
        'outcome_id',r.runner_outcome_id,'usage_evidence_id',inserted.usage_evidence_id,
        'cumulative_cost_usd',inserted.cumulative_cost_usd,'authorized_cost_usd',r.committed_cost_usd,
        'released_cost_usd','0.000000','actual_usage_reconciled',FALSE));
  END IF;
  RETURN pg_catalog.jsonb_build_object('ok',TRUE,'retry',FALSE,'row',pg_catalog.to_jsonb(inserted));
END`;

export const USAGE_AUTHORITY_ROUTINES = Object.freeze([
  { identity: USAGE_REFUSAL_ROUTINE, body_sha256: sha256Digest(USAGE_REFUSAL_BODY.trim()) },
  { identity: USAGE_STREAM_INITIALIZE_ROUTINE, body_sha256: sha256Digest(USAGE_STREAM_INITIALIZE_BODY.trim()) },
  { identity: USAGE_EVIDENCE_APPEND_ROUTINE, body_sha256: sha256Digest(USAGE_EVIDENCE_APPEND_BODY.trim()) },
]);

export const USAGE_AUTHORITY_ROUTINE_SQL = `
CREATE OR REPLACE FUNCTION public.starlight_record_usage_refusal(pg_catalog.jsonb,pg_catalog.text)
RETURNS pg_catalog.jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, public
AS $usage_refusal$${USAGE_REFUSAL_BODY}$usage_refusal$;
REVOKE ALL ON FUNCTION public.starlight_record_usage_refusal(pg_catalog.jsonb,pg_catalog.text) FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.starlight_initialize_runner_usage_stream(pg_catalog.jsonb)
RETURNS pg_catalog.jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, public
AS $usage_stream_initialize$${USAGE_STREAM_INITIALIZE_BODY}$usage_stream_initialize$;
REVOKE ALL ON FUNCTION public.starlight_initialize_runner_usage_stream(pg_catalog.jsonb) FROM PUBLIC;
CREATE OR REPLACE FUNCTION public.starlight_append_runner_usage_evidence(pg_catalog.jsonb)
RETURNS pg_catalog.jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog, public
AS $usage_evidence_append$${USAGE_EVIDENCE_APPEND_BODY}$usage_evidence_append$;
REVOKE ALL ON FUNCTION public.starlight_append_runner_usage_evidence(pg_catalog.jsonb) FROM PUBLIC;
`;
