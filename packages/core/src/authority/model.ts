/**
 * @file Evaluates current Authority facts as a pure action-bound decision.
 *
 * Storage adapters load immutable grants and revocations, read their trusted
 * clock, and call this evaluator. The function performs no I/O, retains no
 * permission cache, and returns fresh evidence for one immediate action.
 */

import type {
  AuthorityActionDefinition,
  AuthorityCheck,
  AuthorityDecision,
  AuthorityLedgerId,
  AuthorityRefusalReason,
  AuthorizationGrant,
  AuthorizationGrantOrigin,
  AuthorizationGrantId,
  GrantRef,
  GrantRevocation,
  GrantRevocationId,
  PrincipalId,
  ProtectedAction,
  ScopeFor,
} from './contracts.js';
import {
  AuthorityError,
  AuthorizationGrantIdSchema,
  AuthorityLedgerIdSchema,
  GrantRevocationIdSchema,
  GrantRevocationReasonSchema,
  PrincipalIdSchema,
  createBootstrapAuthorizationGrant,
} from './contracts.js';
import { TimestampSchema, type Timestamp } from '../values.js';

/** Complete immutable fact slice needed for one Authority decision. */
export type AuthorityEvaluationFacts<Actions extends ProtectedAction> = Readonly<{
  /** Prevents records from another ledger from satisfying this decision. */
  ledgerId: AuthorityLedgerId;

  /** Supplies action-owned scope admission and containment without a global registry. */
  actions: readonly AuthorityActionDefinition<Actions>[];

  /** Contains every grant record visible at the decision boundary. */
  grants: readonly AuthorizationGrant<Actions>[];

  /** Contains every revocation fact visible at the decision boundary. */
  revocations: readonly GrantRevocation<Actions>[];
}>;

/**
 * Creates one immutable refusal with the common checked identity.
 * @param request - Exact attempted action, Principal, and grant lookup.
 * @param checkedAt - Trusted instant shared by every branch.
 * @param reason - Stable rule that refused current use.
 * @returns A finite denied decision with no tentative verification.
 */
function refuse<Action extends ProtectedAction>(
  request: AuthorityCheck<Action>,
  checkedAt: Timestamp,
  reason: AuthorityRefusalReason,
): AuthorityDecision<Action> {
  return Object.freeze({
    allowed: false,
    refusal: Object.freeze({
      reason,
      grant: Object.freeze({ ...request.grant }) as GrantRef<Action>,
      subject: request.subject,
      checkedAt,
    }),
  });
}

/**
 * Finds one exact action definition without importing its owning package.
 * @param definitions - Explicit definitions registered by ledger construction.
 * @param action - Stable action discriminator carried by the GrantRef.
 * @returns The matching definition or undefined when this broker cannot evaluate it.
 */
function findDefinition<Actions extends ProtectedAction, Action extends Actions>(
  definitions: readonly AuthorityActionDefinition<Actions>[],
  action: Action['action'],
): AuthorityActionDefinition<Action> | undefined {
  return definitions.find((definition) => definition.action === action) as
    AuthorityActionDefinition<Action> | undefined;
}

/**
 * Finds one immutable grant by UUID without treating the caller's action field
 * as proof that the stored record has the same category.
 * @param grants - Current ledger grant facts.
 * @param grantId - Lookup identity from the presented reference.
 * @returns The stored grant or undefined when the identity is absent.
 */
function findGrant<Actions extends ProtectedAction>(
  grants: readonly AuthorizationGrant<Actions>[],
  grantId: AuthorizationGrantId,
): AuthorizationGrant<Actions> | undefined {
  return grants.find((grant) => grant.id === grantId);
}

/**
 * Reports whether a revocation fact was current at the same trusted check time.
 * @param revocations - Current immutable revocation facts.
 * @param grantId - Grant whose current usability is under evaluation.
 * @param checkedAt - Trusted decision instant.
 * @returns Whether a revocation at or before the check exists.
 */
function isRevoked<Actions extends ProtectedAction>(
  revocations: readonly GrantRevocation<Actions>[],
  grantId: AuthorizationGrantId,
  checkedAt: Timestamp,
): boolean {
  return revocations.some(
    (revocation) => revocation.grant.grantId === grantId && Date.parse(revocation.createdAt) <= Date.parse(checkedAt),
  );
}

/**
 * Verifies a grant and every attenuation ancestor against current ledger facts.
 * @param facts - Immutable current records and action definitions.
 * @param request - Exact action-bound check from a protected service.
 * @param checkedAt - One trusted clock reading shared by the full chain.
 * @returns A fresh allowed verification or exact denial with no state mutation.
 */
export function evaluateAuthority<Actions extends ProtectedAction, Action extends Actions>(
  facts: AuthorityEvaluationFacts<Actions>,
  request: AuthorityCheck<Action>,
  checkedAt: Timestamp,
): AuthorityDecision<Action> {
  /** Action registration selects the only codec and containment policy allowed to interpret scope. */
  const definition = findDefinition<Actions, Action>(facts.actions, request.grant.action);
  if (definition === undefined) return refuse(request, checkedAt, 'action-not-registered');

  /** Runtime callers must pass through the action-owned scope codec even when TypeScript compiled. */
  const requestedScope = definition.scope.safeParse(request.scope);
  if (!requestedScope.ok) return refuse(request, checkedAt, 'scope-invalid');

  /** Lookup by UUID precedes action comparison because references remain forgeable values. */
  const presented = findGrant(facts.grants, request.grant.grantId);
  if (presented === undefined || presented.ledgerId !== facts.ledgerId) {
    return refuse(request, checkedAt, 'grant-not-found');
  }
  if (presented.action !== request.grant.action) return refuse(request, checkedAt, 'action-mismatch');
  if (presented.subject !== request.subject) return refuse(request, checkedAt, 'subject-mismatch');

  /** Tracks exact lineage order and rejects cycles in restored or hostile adapter data. */
  const chain: AuthorizationGrantId[] = [];
  /** Makes cycle detection independent of the chain array's presentation role. */
  const visited = new Set<AuthorizationGrantId>();
  /** Walk begins at the presented grant and follows only same-action attenuation edges. */
  let current: AuthorizationGrant<Actions> | undefined = presented;
  /** Distinguishes temporal reasons on the presented grant from its ancestors. */
  let ancestor = false;

  while (current !== undefined) {
    if (visited.has(current.id)) return refuse(request, checkedAt, 'grant-chain-cycle');
    visited.add(current.id);
    chain.push(current.id);

    if (current.action !== request.grant.action) {
      return refuse(request, checkedAt, ancestor ? 'ancestor-action-mismatch' : 'action-mismatch');
    }
    if (Date.parse(current.validFrom) > Date.parse(checkedAt)) {
      return refuse(request, checkedAt, ancestor ? 'ancestor-not-active' : 'grant-not-active');
    }
    if (current.expiresAt !== undefined && Date.parse(current.expiresAt) <= Date.parse(checkedAt)) {
      return refuse(request, checkedAt, ancestor ? 'ancestor-expired' : 'grant-expired');
    }
    if (isRevoked(facts.revocations, current.id, checkedAt)) {
      return refuse(request, checkedAt, ancestor ? 'ancestor-revoked' : 'grant-revoked');
    }

    if (current.origin.kind !== 'attenuation') break;
    /** Parent action must match before its lookup can affect this action family. */
    const parent: GrantRef<Actions> = current.origin.parent as GrantRef<Actions>;
    if (parent.action !== request.grant.action) return refuse(request, checkedAt, 'ancestor-action-mismatch');
    current = findGrant(facts.grants, parent.grantId);
    if (current === undefined) return refuse(request, checkedAt, 'ancestor-not-found');
    ancestor = true;
  }

  /** Scope containment is evaluated after current lineage proves the grant still exists. */
  const grantedScope = definition.scope.safeParse(presented.scope as ScopeFor<Action>);
  if (!grantedScope.ok) return refuse(request, checkedAt, 'scope-invalid');

  /** Holds the package-owned containment result separately from implementation failure. */
  let allowed: boolean;
  try {
    allowed = definition.allows(grantedScope.value, requestedScope.value);
  } catch (error) {
    throw new AuthorityError('authority_policy_failed', 'Authority action policy evaluation failed', {
      cause: error,
    });
  }
  if (!allowed) return refuse(request, checkedAt, 'scope-mismatch');

  return Object.freeze({
    allowed: true,
    verification: Object.freeze({
      grant: Object.freeze({ ...request.grant }) as GrantRef<Action>,
      subject: request.subject,
      scope: requestedScope.value as ScopeFor<Action>,
      checkedAt,
      chain: Object.freeze(chain),
    }),
  });
}

/** Bootstrap origin excluded from ordinary issuance construction. */
type BootstrapAuthorizationGrantOrigin = Readonly<{
  /** Marks the construction-only trust-root path. */
  kind: 'bootstrap';
}>;

/** Trusted pure input for constructing a non-bootstrap authorization grant. */
export type IssuedAuthorizationGrantInput<Action extends ProtectedAction> = Readonly<{
  /** Reuses the validated root factory for stable identity and time invariants. */
  root: Parameters<typeof createBootstrapAuthorizationGrant<Action>>[1];

  /** Replaces bootstrap origin with administrative issuance or attenuation lineage. */
  origin: Exclude<AuthorizationGrantOrigin<Action>, BootstrapAuthorizationGrantOrigin>;
}>;

/**
 * Constructs one non-bootstrap immutable grant after application policy has
 * already approved the transition.
 * @param definition - Exact action and scope owner.
 * @param input - Validated record fields and earned lineage origin.
 * @returns A fresh grant with the same whole-object invariants as a trust root.
 */
export function createIssuedAuthorizationGrant<Action extends ProtectedAction>(
  definition: AuthorityActionDefinition<Action>,
  input: IssuedAuthorizationGrantInput<Action>,
): AuthorizationGrant<Action> {
  /** Root construction centralizes identity, time-window, scope, and deep-copy checks. */
  const admitted = createBootstrapAuthorizationGrant(definition, input.root);
  /** Origin is copied separately so caller mutation cannot rewrite lineage. */
  const origin = Object.freeze({ ...input.origin }) as AuthorizationGrantOrigin<Action>;
  return Object.freeze({ ...admitted, origin }) as AuthorizationGrant<Action>;
}

/** Trusted pure input for one immutable revocation fact. */
export type CreateGrantRevocationInput<Action extends ProtectedAction> = Readonly<{
  /** Supplies UUIDv4 identity before adapter settlement. */
  id: GrantRevocationId;

  /** Binds the fact to one exact Authority ledger. */
  ledgerId: AuthorityLedgerId;

  /** Names the current or historical grant being retired. */
  grant: GrantRef<Action>;

  /** Attributes the administrative revocation action. */
  revokedBy: PrincipalId;

  /** Records the trusted instant when the fact became current. */
  createdAt: Timestamp;

  /** Retains optional bounded operator context without affecting verification. */
  reason?: string;
}>;

/**
 * Constructs one immutable revocation fact after administrative verification.
 * @param input - Trusted settlement data validated like restored adapter input.
 * @returns A frozen revocation whose target reference remains action-bound.
 */
export function createGrantRevocation<Action extends ProtectedAction>(
  input: CreateGrantRevocationInput<Action>,
): GrantRevocation<Action> {
  /** Optional prose stays bounded because it may enter durable audit records. */
  const reason = input.reason === undefined ? undefined : GrantRevocationReasonSchema.parse(input.reason);
  /** Re-admits every branded input so JavaScript callers cannot bypass UUID or time invariants. */
  const id = GrantRevocationIdSchema.parse(input.id);
  /** Ledger admission prevents cross-ledger facts at restoration boundaries. */
  const ledgerId = AuthorityLedgerIdSchema.parse(input.ledgerId);
  /** Grant lookup retains UUID normalization independently from its action discriminator. */
  const grantId = AuthorizationGrantIdSchema.parse(input.grant.grantId);
  /** Principal admission remains attribution rather than authorization. */
  const revokedBy = PrincipalIdSchema.parse(input.revokedBy);
  /** Timestamp normalization makes temporal comparison deterministic. */
  const createdAt = TimestampSchema.parse(input.createdAt);
  /** Reference is copied because caller-owned objects are not durable facts. */
  const grant = Object.freeze({ grantId, action: input.grant.action }) as GrantRef<Action>;

  return Object.freeze({
    id,
    object: 'grant-revocation',
    createdAt,
    ledgerId,
    grant,
    revokedBy,
    ...(reason === undefined ? {} : { reason }),
  }) as GrantRevocation<Action>;
}
