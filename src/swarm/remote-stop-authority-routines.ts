import { sha256Digest } from './runtime-digest';

export const REMOTE_STOP_DATABASE_ROLE_CONTRACT = Object.freeze({
  schema_version: 'starlight.remote_stop_database_role.v1' as const,
  schema: 'public',
  database_grants: ['CONNECT'],
  routine_grants: ['starlight_append_remote_stop_acknowledgement(jsonb):EXECUTE'],
  forbidden_role_flags: ['rolsuper', 'rolcreaterole', 'rolcreatedb', 'rolreplication', 'rolbypassrls', 'rolinherit'],
  direct_login_required: true,
  memberships_allowed: 0,
});

export const REMOTE_STOP_DATABASE_ROLE_CONTRACT_SHA256 = sha256Digest(
  REMOTE_STOP_DATABASE_ROLE_CONTRACT,
);

export const REMOTE_STOP_APPEND_ROUTINE = 'starlight_append_remote_stop_acknowledgement(jsonb)';
export const REMOTE_STOP_REFUSAL_ROUTINE = 'starlight_record_remote_stop_refusal(jsonb, text)';

export const REMOTE_STOP_REFUSAL_BODY = String.raw`
DECLARE
  p ALIAS FOR $1;
  blocker ALIAS FOR $2;
  request_payload pg_catalog.jsonb := CASE WHEN pg_catalog.jsonb_typeof(p)='object'
    AND pg_catalog.jsonb_typeof(p->'request')='object' THEN p->'request' ELSE '{}'::pg_catalog.jsonb END;
  audit_operation_id TEXT := 'invalid-operation';
  audit_binding_digest CHAR(64) := pg_catalog.repeat('0',64);
  audit_reservation_id TEXT := NULL;
BEGIN
  IF request_payload->>'reservation_id' ~
      '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    audit_reservation_id := request_payload->>'reservation_id';
    SELECT operation_id,binding_digest_sha256 INTO audit_operation_id,audit_binding_digest
      FROM public.swarm_authority_reservations
     WHERE reservation_id=audit_reservation_id::pg_catalog.uuid;
    IF NOT FOUND THEN
      audit_operation_id := 'invalid-operation';
      audit_binding_digest := pg_catalog.repeat('0',64);
    END IF;
  END IF;
  INSERT INTO public.swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
  VALUES ('runner-remote-stop-acknowledgement-denied',audit_operation_id,audit_binding_digest,
    pg_catalog.clock_timestamp(),pg_catalog.jsonb_build_object(
      'reservation_id',audit_reservation_id,
      'stop_request_id',request_payload->>'stop_request_id',
      'blockers',pg_catalog.jsonb_build_array(blocker),
      'direct_function_refusal',TRUE,
      'authenticated_database_role',session_user,
      'authenticated_database_name',pg_catalog.current_database(),
      'released_host_slots',0,'released_cost_usd','0.000000'));
  RETURN pg_catalog.jsonb_build_object('ok',FALSE,'blocker',blocker,'audited',TRUE);
END`;

export const REMOTE_STOP_APPEND_BODY = String.raw`
DECLARE
  p ALIAS FOR $1;
  req pg_catalog.jsonb;
  ack pg_catalog.jsonb;
  r RECORD;
  stop_audit RECORD;
  principal RECORD;
  existing RECORD;
  accepted_at pg_catalog.timestamptz;
  canonical_audit_sha256 TEXT;
  append_oid pg_catalog.oid;
  append_owner_oid pg_catalog.oid;
  invoker_oid pg_catalog.oid;
  invoker_superuser BOOLEAN;
  unexpected_execute_entries INTEGER;
  invoker_execute_entries INTEGER;
BEGIN
  SELECT pg_catalog.clock_timestamp() INTO accepted_at;
  IF pg_catalog.jsonb_typeof(p)<>'object'
     OR NOT (p ?& ARRAY['request','acknowledgement','acknowledgement_bundle_sha256',
       'verifier_role_contract_sha256']::pg_catalog.text[])
     OR p-ARRAY['request','acknowledgement','acknowledgement_bundle_sha256',
       'verifier_role_contract_sha256']::pg_catalog.text[] <> '{}'::pg_catalog.jsonb
     OR pg_catalog.jsonb_typeof(p->'request')<>'object'
     OR pg_catalog.jsonb_typeof(p->'acknowledgement')<>'object'
     OR p->>'acknowledgement_bundle_sha256' !~ '^[a-f0-9]{64}$'
     OR p->>'verifier_role_contract_sha256' <> '${REMOTE_STOP_DATABASE_ROLE_CONTRACT_SHA256}' THEN
    RETURN public.starlight_record_remote_stop_refusal(p,
      'Remote-stop acknowledgement append input is invalid.');
  END IF;
  req := p->'request';
  ack := p->'acknowledgement';
  IF NOT (req ?& ARRAY['schema_version','stop_request_id','stop_sequence','stop_request_audit_seq',
      'stop_request_audit_sha256','reservation_id','claim_id','operation_id','effect_id',
      'binding_digest_sha256','runner_id','runner_instance_id','runtime_id','host_id',
      'channel_binding_sha256','launch_attempt_id','process_instance_sha256','execution_generation',
      'stop_fence_generation','requested_at','acknowledgement_deadline','reason']::pg_catalog.text[])
     OR req-ARRAY['schema_version','stop_request_id','stop_sequence','stop_request_audit_seq',
      'stop_request_audit_sha256','reservation_id','claim_id','operation_id','effect_id',
      'binding_digest_sha256','runner_id','runner_instance_id','runtime_id','host_id',
      'channel_binding_sha256','launch_attempt_id','process_instance_sha256','execution_generation',
      'stop_fence_generation','requested_at','acknowledgement_deadline','reason']::pg_catalog.text[]
        <> '{}'::pg_catalog.jsonb
     OR NOT (ack ?& ARRAY['schema_version','acknowledgement_id','stop_request_id','stop_sequence',
      'stop_request_audit_seq','stop_request_audit_sha256','request_sha256','reservation_id','claim_id',
      'operation_id','effect_id','binding_digest_sha256','runner_id','runner_instance_id','runtime_id',
      'host_id','channel_binding_sha256','launch_attempt_id','process_instance_sha256','execution_generation',
      'observed_stop_fence_generation','supervisor_id','supervisor_instance_id','supervisor_epoch',
      'acknowledgement_state','acknowledged_at','observed_at','access_review_expires_at','evidence_ref',
      'evidence_sha256','replay_state','transport_authenticated']::pg_catalog.text[])
     OR ack-ARRAY['schema_version','acknowledgement_id','stop_request_id','stop_sequence',
      'stop_request_audit_seq','stop_request_audit_sha256','request_sha256','reservation_id','claim_id',
      'operation_id','effect_id','binding_digest_sha256','runner_id','runner_instance_id','runtime_id',
      'host_id','channel_binding_sha256','launch_attempt_id','process_instance_sha256','execution_generation',
      'observed_stop_fence_generation','supervisor_id','supervisor_instance_id','supervisor_epoch',
      'acknowledgement_state','acknowledged_at','observed_at','access_review_expires_at','evidence_ref',
      'evidence_sha256','replay_state','transport_authenticated']::pg_catalog.text[] <> '{}'::pg_catalog.jsonb
     OR req->>'schema_version'<>'starlight.remote_stop_request.v1'
     OR ack->>'schema_version'<>'starlight.remote_stop_acknowledgement.v1'
     OR ack->>'acknowledgement_state'<>'received'
     OR ack->>'replay_state' NOT IN ('fresh','exact-retry')
     OR ack->'transport_authenticated'<>'true'::pg_catalog.jsonb
     OR req->>'stop_request_id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR ack->>'acknowledgement_id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR req->>'reservation_id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR req->>'claim_id' !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     OR req->>'stop_request_audit_sha256' !~ '^[a-f0-9]{64}$'
     OR ack->>'request_sha256' !~ '^[a-f0-9]{64}$'
     OR ack->>'evidence_sha256' !~ '^[a-f0-9]{64}$'
     OR req->>'stop_sequence' !~ '^[1-9][0-9]{0,8}$'
     OR req->>'stop_request_audit_seq' !~ '^[1-9][0-9]{0,15}$'
     OR req->>'execution_generation' !~ '^[1-9][0-9]{0,8}$'
     OR req->>'stop_fence_generation' !~ '^[1-9][0-9]{0,8}$'
     OR ack->>'supervisor_epoch' !~ '^[1-9][0-9]{0,8}$'
     OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_each_text(req) field
       WHERE field.key IN ('operation_id','effect_id','runner_id','runner_instance_id','runtime_id','host_id',
         'launch_attempt_id') AND field.value !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$')
     OR EXISTS (SELECT 1 FROM pg_catalog.jsonb_each_text(ack) field
       WHERE field.key IN ('supervisor_id','supervisor_instance_id','evidence_ref')
         AND field.value !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{2,159}$') THEN
    RETURN public.starlight_record_remote_stop_refusal(p,
      'Remote-stop acknowledgement append input is malformed.');
  END IF;
  IF ack->>'stop_request_id' IS DISTINCT FROM req->>'stop_request_id'
     OR ack->>'stop_sequence' IS DISTINCT FROM req->>'stop_sequence'
     OR ack->>'stop_request_audit_seq' IS DISTINCT FROM req->>'stop_request_audit_seq'
     OR ack->>'stop_request_audit_sha256' IS DISTINCT FROM req->>'stop_request_audit_sha256'
     OR ack->>'reservation_id' IS DISTINCT FROM req->>'reservation_id'
     OR ack->>'claim_id' IS DISTINCT FROM req->>'claim_id'
     OR ack->>'operation_id' IS DISTINCT FROM req->>'operation_id'
     OR ack->>'effect_id' IS DISTINCT FROM req->>'effect_id'
     OR ack->>'binding_digest_sha256' IS DISTINCT FROM req->>'binding_digest_sha256'
     OR ack->>'runner_id' IS DISTINCT FROM req->>'runner_id'
     OR ack->>'runner_instance_id' IS DISTINCT FROM req->>'runner_instance_id'
     OR ack->>'runtime_id' IS DISTINCT FROM req->>'runtime_id'
     OR ack->>'host_id' IS DISTINCT FROM req->>'host_id'
     OR ack->>'channel_binding_sha256' IS DISTINCT FROM req->>'channel_binding_sha256'
     OR ack->>'launch_attempt_id' IS DISTINCT FROM req->>'launch_attempt_id'
     OR ack->'process_instance_sha256' IS DISTINCT FROM req->'process_instance_sha256'
     OR ack->>'execution_generation' IS DISTINCT FROM req->>'execution_generation'
     OR ack->>'observed_stop_fence_generation' IS DISTINCT FROM req->>'stop_fence_generation' THEN
    RETURN public.starlight_record_remote_stop_refusal(p,
      'Remote-stop acknowledgement is bound to another request or execution.');
  END IF;
  SELECT proc.oid,proc.proowner INTO append_oid,append_owner_oid
    FROM pg_catalog.pg_proc proc JOIN pg_catalog.pg_namespace ns ON ns.oid=proc.pronamespace
   WHERE ns.nspname='public' AND proc.proname='starlight_append_remote_stop_acknowledgement'
     AND pg_catalog.pg_get_function_identity_arguments(proc.oid)='jsonb';
  SELECT role.oid,role.rolsuper INTO invoker_oid,invoker_superuser
    FROM pg_catalog.pg_roles role WHERE role.rolname=session_user
      AND role.rolcanlogin=TRUE AND role.rolcreaterole=FALSE AND role.rolcreatedb=FALSE
      AND role.rolreplication=FALSE AND role.rolbypassrls=FALSE AND role.rolinherit=FALSE;
  IF append_oid IS NULL OR invoker_oid IS NULL OR invoker_superuser IS DISTINCT FROM FALSE
     OR current_user=session_user
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members WHERE member=invoker_oid OR roleid=invoker_oid)
     OR NOT pg_catalog.has_database_privilege(session_user,pg_catalog.current_database(),'CONNECT')
     OR pg_catalog.has_database_privilege(session_user,pg_catalog.current_database(),'CREATE')
     OR pg_catalog.has_database_privilege(session_user,pg_catalog.current_database(),'TEMPORARY')
     OR NOT pg_catalog.has_schema_privilege(session_user,'public','USAGE')
     OR pg_catalog.has_schema_privilege(session_user,'public','CREATE')
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
       CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('DELETE'),('TRUNCATE'),('REFERENCES'),('TRIGGER'),
         ('MAINTAIN')) privilege(privilege_type)
       WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')
         AND pg_catalog.has_table_privilege(session_user,c.oid,privilege.privilege_type))
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
       JOIN pg_catalog.pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
       CROSS JOIN (VALUES ('SELECT'),('INSERT'),('UPDATE'),('REFERENCES')) privilege(privilege_type)
       WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f')
         AND pg_catalog.has_column_privilege(session_user,c.oid,a.attnum,privilege.privilege_type))
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
       WHERE n.nspname='public' AND c.relkind='S'
         AND (pg_catalog.has_sequence_privilege(session_user,c.oid,'SELECT')
           OR pg_catalog.has_sequence_privilege(session_user,c.oid,'USAGE')
           OR pg_catalog.has_sequence_privilege(session_user,c.oid,'UPDATE')))
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_class c WHERE c.relowner=invoker_oid
       UNION ALL SELECT 1 FROM pg_catalog.pg_proc proc WHERE proc.proowner=invoker_oid
       UNION ALL SELECT 1 FROM pg_catalog.pg_namespace n WHERE n.nspowner=invoker_oid)
     OR EXISTS (SELECT 1 FROM pg_catalog.pg_proc proc JOIN pg_catalog.pg_namespace n ON n.oid=proc.pronamespace
       WHERE n.nspname='public' AND pg_catalog.has_function_privilege(session_user,proc.oid,'EXECUTE')
         AND proc.oid<>append_oid) THEN
    RETURN public.starlight_record_remote_stop_refusal(p,
      'Remote-stop verifier database role is not function-only or safely isolated.');
  END IF;
  SELECT
    pg_catalog.count(*) FILTER (WHERE acl.privilege_type='EXECUTE'
      AND (acl.grantee NOT IN (append_owner_oid,invoker_oid)
        OR (acl.grantee=invoker_oid AND acl.is_grantable)))::pg_catalog.int4,
    pg_catalog.count(*) FILTER (WHERE acl.privilege_type='EXECUTE'
      AND acl.grantee=invoker_oid AND acl.is_grantable=FALSE)::pg_catalog.int4
    INTO unexpected_execute_entries,invoker_execute_entries
    FROM pg_catalog.pg_proc proc CROSS JOIN LATERAL pg_catalog.aclexplode(
      COALESCE(proc.proacl,pg_catalog.acldefault('f',proc.proowner))) acl WHERE proc.oid=append_oid;
  IF unexpected_execute_entries<>0 OR invoker_execute_entries<>1 THEN
    RETURN public.starlight_record_remote_stop_refusal(p,
      'Remote-stop verifier routine execution grants are ambiguous or grantable.');
  END IF;
  PERFORM 1 FROM public.swarm_authority_control WHERE singleton=TRUE FOR UPDATE;
  IF NOT FOUND THEN
    RETURN public.starlight_record_remote_stop_refusal(p,
      'Authority serialization control row is missing or ambiguous.');
  END IF;
  SELECT * INTO principal FROM public.swarm_authority_remote_stop_principals
   WHERE database_role=session_user AND database_name=pg_catalog.current_database();
  IF NOT FOUND OR principal.state<>'ready'
     OR principal.role_contract_digest_sha256<>p->>'verifier_role_contract_sha256'
     OR principal.supervisor_id<>ack->>'supervisor_id'
     OR principal.supervisor_instance_id<>ack->>'supervisor_instance_id'
     OR principal.supervisor_epoch<>(ack->>'supervisor_epoch')::pg_catalog.int4
     OR principal.observed_at>accepted_at OR accepted_at-principal.observed_at>pg_catalog.make_interval(secs=>60)
     OR principal.access_review_expires_at<=accepted_at
     OR principal.evidence->>'state' IS DISTINCT FROM principal.state
     OR principal.evidence->>'database_role' IS DISTINCT FROM principal.database_role
     OR principal.evidence->>'database_name' IS DISTINCT FROM principal.database_name
     OR principal.evidence->>'supervisor_id' IS DISTINCT FROM principal.supervisor_id
     OR principal.evidence->>'supervisor_instance_id' IS DISTINCT FROM principal.supervisor_instance_id
     OR (principal.evidence->>'supervisor_epoch')::pg_catalog.int4 IS DISTINCT FROM principal.supervisor_epoch
     OR principal.evidence->>'role_contract_digest_sha256' IS DISTINCT FROM principal.role_contract_digest_sha256 THEN
    RETURN public.starlight_record_remote_stop_refusal(p,
      'Remote-stop verifier principal is unavailable, expired, disabled, or drifted.');
  END IF;
  SELECT * INTO r FROM public.swarm_authority_reservations
   WHERE reservation_id=(req->>'reservation_id')::pg_catalog.uuid;
  IF NOT FOUND OR r.runner_claim_id IS DISTINCT FROM (req->>'claim_id')::pg_catalog.uuid
     OR r.operation_id IS DISTINCT FROM req->>'operation_id'
     OR r.effect_id IS DISTINCT FROM req->>'effect_id'
     OR r.binding_digest_sha256 IS DISTINCT FROM req->>'binding_digest_sha256'
     OR r.runner_id IS DISTINCT FROM req->>'runner_id'
     OR r.runner_instance_id IS DISTINCT FROM req->>'runner_instance_id'
     OR r.runner_runtime_id IS DISTINCT FROM req->>'runtime_id'
     OR r.runner_host_id IS DISTINCT FROM req->>'host_id'
     OR r.runner_channel_binding_sha256 IS DISTINCT FROM req->>'channel_binding_sha256'
     OR r.runner_launch_attempt_id IS DISTINCT FROM req->>'launch_attempt_id'
     OR r.runner_process_instance_sha256 IS DISTINCT FROM req->>'process_instance_sha256'
     OR r.runner_fencing_generation IS DISTINCT FROM (req->>'execution_generation')::pg_catalog.int4
     OR (req->>'stop_fence_generation')::pg_catalog.int4<>(req->>'execution_generation')::pg_catalog.int4+1 THEN
    RETURN public.starlight_record_remote_stop_refusal(p,
      'Remote-stop request is not bound to the durable execution identity.');
  END IF;
  SELECT * INTO stop_audit FROM public.swarm_authority_audit
   WHERE seq=(req->>'stop_request_audit_seq')::pg_catalog.int8;
  IF NOT FOUND OR stop_audit.event<>'stop-requested'
     OR stop_audit.operation_id IS DISTINCT FROM r.operation_id
     OR stop_audit.binding_digest_sha256 IS DISTINCT FROM r.binding_digest_sha256
     OR stop_audit.detail->>'reservation_id' IS DISTINCT FROM r.reservation_id::pg_catalog.text
     OR (SELECT pg_catalog.count(*) FROM public.swarm_authority_audit prior_stop
           WHERE prior_stop.event='stop-requested'
             AND prior_stop.detail->>'reservation_id'=r.reservation_id::pg_catalog.text
             AND prior_stop.seq<=stop_audit.seq)<>(req->>'stop_sequence')::pg_catalog.int8 THEN
    RETURN public.starlight_record_remote_stop_refusal(p,
      'Remote-stop request does not identify the exact durable stop-request audit.');
  END IF;
  canonical_audit_sha256 := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(
    pg_catalog.jsonb_build_object('seq',stop_audit.seq,'event',stop_audit.event,
      'operation_id',stop_audit.operation_id,'binding_digest_sha256',stop_audit.binding_digest_sha256,
      'at_epoch_microseconds',pg_catalog.floor(extract(epoch FROM stop_audit.at)*1000000)::pg_catalog.int8,
      'detail',stop_audit.detail)::pg_catalog.text,'UTF8')),'hex');
  IF canonical_audit_sha256<>req->>'stop_request_audit_sha256' THEN
    RETURN public.starlight_record_remote_stop_refusal(p,
      'Remote-stop audit digest is invalid.');
  END IF;
  IF stop_audit.at>(req->>'requested_at')::pg_catalog.timestamptz THEN
    RETURN public.starlight_record_remote_stop_refusal(p,
      'Remote-stop request predates its durable stop audit.');
  END IF;
  IF (req->>'requested_at')::pg_catalog.timestamptz>(ack->>'acknowledged_at')::pg_catalog.timestamptz
     OR (ack->>'acknowledged_at')::pg_catalog.timestamptz>(req->>'acknowledgement_deadline')::pg_catalog.timestamptz
     OR (ack->>'acknowledged_at')::pg_catalog.timestamptz>(ack->>'observed_at')::pg_catalog.timestamptz
     OR (ack->>'observed_at')::pg_catalog.timestamptz>=accepted_at THEN
    RETURN public.starlight_record_remote_stop_refusal(p,
      'Remote-stop acknowledgement chronology is invalid.');
  END IF;
  IF (ack->>'access_review_expires_at')::pg_catalog.timestamptz<=accepted_at
     OR (ack->>'access_review_expires_at')::pg_catalog.timestamptz<>principal.access_review_expires_at THEN
    RETURN public.starlight_record_remote_stop_refusal(p,
      'Remote-stop access-review binding is invalid.');
  END IF;
  SELECT * INTO existing FROM public.swarm_authority_remote_stop_acknowledgements
   WHERE reservation_id=r.reservation_id OR acknowledgement_id=(ack->>'acknowledgement_id')::pg_catalog.uuid
      OR stop_request_id=(req->>'stop_request_id')::pg_catalog.uuid
      OR stop_request_audit_seq=(req->>'stop_request_audit_seq')::pg_catalog.int8
      OR request_sha256=ack->>'request_sha256' OR evidence_ref=ack->>'evidence_ref'
      OR evidence_sha256=ack->>'evidence_sha256';
  IF FOUND THEN
    IF existing.reservation_id=r.reservation_id
       AND existing.acknowledgement_id=(ack->>'acknowledgement_id')::pg_catalog.uuid
       AND existing.stop_request_id=(req->>'stop_request_id')::pg_catalog.uuid
       AND existing.request_payload=req AND existing.acknowledgement_payload=ack
       AND existing.acknowledgement_bundle_sha256=p->>'acknowledgement_bundle_sha256'
       AND existing.verifier_database_role=session_user
       AND existing.verifier_database_name=pg_catalog.current_database()
       AND existing.verifier_role_contract_sha256=p->>'verifier_role_contract_sha256' THEN
      RETURN pg_catalog.jsonb_build_object('ok',TRUE,'retry',TRUE,'accepted_at',existing.accepted_at);
    END IF;
    RETURN public.starlight_record_remote_stop_refusal(p,
      'Remote-stop acknowledgement identifiers or evidence were replayed with drift.');
  END IF;
  IF r.state<>'stop-requested' THEN
    RETURN public.starlight_record_remote_stop_refusal(p,
      'Remote-stop request is not bound to one active stop-requested execution.');
  END IF;
  INSERT INTO public.swarm_authority_remote_stop_acknowledgements
    (acknowledgement_id,stop_request_id,stop_request_audit_seq,reservation_id,claim_id,operation_id,
     binding_digest_sha256,request_sha256,evidence_ref,evidence_sha256,supervisor_id,
     supervisor_instance_id,supervisor_epoch,observed_stop_fence_generation,request_payload,
     acknowledgement_payload,acknowledgement_bundle_sha256,accepted_at,verifier_database_role,
     verifier_database_name,verifier_role_contract_sha256)
  VALUES ((ack->>'acknowledgement_id')::pg_catalog.uuid,(req->>'stop_request_id')::pg_catalog.uuid,
    (req->>'stop_request_audit_seq')::pg_catalog.int8,r.reservation_id,r.runner_claim_id,r.operation_id,
    r.binding_digest_sha256,ack->>'request_sha256',ack->>'evidence_ref',ack->>'evidence_sha256',
    ack->>'supervisor_id',ack->>'supervisor_instance_id',(ack->>'supervisor_epoch')::pg_catalog.int4,
    (ack->>'observed_stop_fence_generation')::pg_catalog.int4,req,ack,
    p->>'acknowledgement_bundle_sha256',accepted_at,session_user,pg_catalog.current_database(),
    p->>'verifier_role_contract_sha256');
  INSERT INTO public.swarm_authority_audit (event,operation_id,binding_digest_sha256,at,detail)
  VALUES ('runner-remote-stop-acknowledged',r.operation_id,r.binding_digest_sha256,accepted_at,
    pg_catalog.jsonb_build_object('reservation_id',r.reservation_id,'claim_id',r.runner_claim_id,
      'stop_request_id',req->>'stop_request_id','acknowledgement_id',ack->>'acknowledgement_id',
      'stop_request_audit_seq',(req->>'stop_request_audit_seq')::pg_catalog.int8,
      'acknowledgement_bundle_sha256',p->>'acknowledgement_bundle_sha256',
      'verifier_database_role',session_user,'remote_stop_confirmed',FALSE,
      'process_terminal_observed',FALSE,'host_capacity_released',FALSE,'released_host_slots',0,
      'budget_commitment_released',FALSE,'released_cost_usd','0.000000'));
  RETURN pg_catalog.jsonb_build_object('ok',TRUE,'retry',FALSE,'accepted_at',accepted_at);
EXCEPTION
  WHEN invalid_datetime_format OR datetime_field_overflow OR invalid_text_representation
       OR numeric_value_out_of_range OR unique_violation THEN
    RETURN public.starlight_record_remote_stop_refusal(p,
      'Remote-stop acknowledgement append contains invalid typed values or lost a replay race.');
END`;

export const REMOTE_STOP_AUTHORITY_ROUTINES = Object.freeze([
  { identity: REMOTE_STOP_REFUSAL_ROUTINE, body_sha256: sha256Digest(REMOTE_STOP_REFUSAL_BODY.trim()) },
  { identity: REMOTE_STOP_APPEND_ROUTINE, body_sha256: sha256Digest(REMOTE_STOP_APPEND_BODY.trim()) },
]);

export const REMOTE_STOP_AUTHORITY_ROUTINE_SQL = `
CREATE OR REPLACE FUNCTION starlight_record_remote_stop_refusal(JSONB,TEXT) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $remote_stop_refusal$
${REMOTE_STOP_REFUSAL_BODY}
$remote_stop_refusal$;
CREATE OR REPLACE FUNCTION starlight_append_remote_stop_acknowledgement(JSONB) RETURNS JSONB
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $remote_stop_append$
${REMOTE_STOP_APPEND_BODY}
$remote_stop_append$;
REVOKE ALL ON FUNCTION starlight_record_remote_stop_refusal(JSONB,TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION starlight_append_remote_stop_acknowledgement(JSONB) FROM PUBLIC;
`;
