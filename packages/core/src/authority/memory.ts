/**
 * @file Provides the process-local reference implementation of Archer Authority.
 *
 * This adapter exists to make the protocol directly usable and to anchor
 * conformance. It makes no durability claim and does not turn verification
 * results into cached permission.
 */

import type {
  AttenuateGrantCommand,
  AuthorityBrokerCloseEvidence,
  AuthorityCheck,
  AuthorityDecision,
  AuthorityGrantAction,
  AuthorityLedger,
  AuthorityLedgerOptions,
  AuthorityRevokeAction,
  GrantCommand,
  GrantOutcome,
  GrantRef,
  ProtectedAction,
  RevokeGrantCommand,
  RevokeGrantOutcome,
  ScopeFor,
} from './contracts.js';
import {
  AUTHORITY_GRANT_ACTION,
  AUTHORITY_REVOKE_ACTION,
  AuthorityError,
  AuthorityLedgerIdSchema,
  GrantRevocationReasonSchema,
  authorityTimestamp,
  createBootstrapAuthorizationGrant,
  type AuthorityActionDefinition,
  type AuthorizationGrant,
  type GrantRevocation,
} from './contracts.js';
import { createGrantRevocation, createIssuedAuthorizationGrant, evaluateAuthority } from './model.js';
import { toPublicError, type IdempotencyKey } from '../protocol.js';
import type { DiagnosticHub, DiagnosticSpan } from '../diagnostics/contracts.js';
import type { JsonObject, JsonValue, Timestamp } from '../values.js';

/** One retained command settlement paired with its canonical input identity. */
type CommandReplay = Readonly<{
  /** Detects an idempotency key reused for a different command. */
  fingerprint: string;

  /** Retains the original immutable outcome without interpreting its generic type. */
  outcome: unknown;
}>;

/** Expected command outcome shared by issuance, attenuation, and revocation refusal paths. */
type AuthorityCommandRefusedOutcome = Readonly<{
  /** Confirms no new grant or revocation fact became visible. */
  kind: 'refused';

  /** Names the exact rule and optional current-authority cause. */
  refusal: import('./contracts.js').AuthorityCommandRefusal;
}>;

/**
 * Serializes admitted JSON with stable object-key order for command comparison.
 * @param value - Immutable JSON-compatible command identity.
 * @returns Deterministic text independent of object insertion order.
 */
function canonicalJson(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    /** Sorts keys with host-independent code-unit comparison. */
    const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Constructs one frozen expected command refusal with no tentative state.
 * @param reason - Stable grant-state rule that rejected the command.
 * @param authorityReason - Optional current-verification reason behind the refusal.
 * @returns Immutable tagged refusal suitable for every grant command.
 */
function commandRefusal(
  reason: import('./contracts.js').AuthorityCommandRefusalReason,
  authorityReason?: import('./contracts.js').AuthorityRefusalReason,
): AuthorityCommandRefusedOutcome {
  return Object.freeze({
    kind: 'refused',
    refusal: Object.freeze({ reason, ...(authorityReason === undefined ? {} : { authorityReason }) }),
  });
}

/**
 * Reads production wall time only when construction does not inject a clock.
 * @returns Fresh host Date used as the broker-owned trusted instant.
 */
function systemAuthorityClock(): Date {
  return new Date();
}

/** Narrow product-neutral diagnostics capability borrowed by the Authority ledger. */
type AuthorityDiagnostics = Pick<DiagnosticHub, 'beginSpan'>;

/** Input required to begin one best-effort Authority operation span. */
type AuthoritySpanInput = Readonly<{
  /** Stable operation name owned by the Authority package. */
  name: 'authority.verify' | 'authority.grant' | 'authority.attenuate' | 'authority.revoke' | 'authority.close';

  /** Ledger correlated with every Authority operation. */
  ledgerId: import('./contracts.js').AuthorityLedgerId;

  /** Grant or requested-grant identity correlated when the operation has one. */
  grantId?: import('./contracts.js').AuthorizationGrantId;

  /** Revocation fact identity correlated only during revocation. */
  revocationId?: import('./contracts.js').GrantRevocationId;

  /** Protected action discriminator retained without its potentially sensitive scope. */
  action?: string;
}>;

/**
 * Begins one Authority span while keeping diagnostics strictly non-authoritative.
 * @param diagnostics - Optional borrowed span producer.
 * @param input - Low-cardinality operation identity and correlation.
 * @returns Open span, or absence when observation is unavailable or rejected.
 */
function beginAuthoritySpan(
  diagnostics: AuthorityDiagnostics | undefined,
  input: AuthoritySpanInput,
): DiagnosticSpan | undefined {
  if (diagnostics === undefined) return undefined;
  try {
    return diagnostics.beginSpan({
      name: input.name,
      component: 'core.authority',
      correlation: {
        authorityLedgerId: input.ledgerId,
        ...(input.grantId === undefined ? {} : { authorizationGrantId: input.grantId }),
        ...(input.revocationId === undefined ? {} : { grantRevocationId: input.revocationId }),
      },
      attributes: {
        authority: {
          ...(input.action === undefined ? {} : { action: input.action }),
        },
      },
    });
  } catch {
    /** Observation failure must never become permission or denial. */
    return undefined;
  }
}

/**
 * Settles one Authority span with accumulated result context on a best-effort basis.
 * @param span - Optional span returned by the non-authoritative admission helper.
 * @param outcome - Stable operation outcome used by projections and transports.
 * @param result - Bounded terminal context excluding protected scope values.
 */
function completeAuthoritySpan(span: DiagnosticSpan | undefined, outcome: string, result: JsonObject): void {
  if (span === undefined) return;
  try {
    span.enrich('authority.result', result);
    span.complete({ outcome });
  } catch {
    // Diagnostics are deliberately best effort after Authority has decided the domain outcome.
  }
}

/**
 * Settles one Authority observation as failed without replacing the domain Error.
 * @param span - Optional span returned by best-effort diagnostic admission.
 * @param error - Exact implementation Error that will reject the Authority operation.
 */
function failAuthoritySpan(span: DiagnosticSpan | undefined, error: unknown): void {
  if (span === undefined) return;
  try {
    span.fail({
      outcome: 'failed',
      error: toPublicError(error, {
        code: 'authority_operation_failed',
        message: 'Authority operation failed',
      }),
    });
  } catch {
    // Diagnostics remain best effort while the exact domain Error continues to the caller.
  }
}

/**
 * Settles observation for a grant or attenuation command and preserves its exact outcome.
 * @param span - Optional non-authoritative operation span.
 * @param outcome - Immutable grant-state command result.
 * @returns Already-settled Promise carrying the unchanged domain result.
 */
function observedGrantOutcome<Action extends ProtectedAction>(
  span: DiagnosticSpan | undefined,
  outcome: GrantOutcome<Action>,
): Promise<GrantOutcome<Action>> {
  completeAuthoritySpan(
    span,
    outcome.kind === 'granted' ? (outcome.replayed ? 'replayed' : 'granted') : outcome.refusal.reason,
    outcome.kind === 'granted'
      ? { kind: outcome.kind, replayed: outcome.replayed }
      : {
          kind: outcome.kind,
          reason: outcome.refusal.reason,
          ...(outcome.refusal.authorityReason === undefined
            ? {}
            : { authorityReason: outcome.refusal.authorityReason }),
        },
  );
  return Promise.resolve(outcome);
}

/**
 * Settles observation for a revocation command and preserves its exact outcome.
 * @param span - Optional non-authoritative operation span.
 * @param outcome - Immutable revocation command result.
 * @returns Already-settled Promise carrying the unchanged domain result.
 */
function observedRevokeOutcome<Action extends ProtectedAction>(
  span: DiagnosticSpan | undefined,
  outcome: RevokeGrantOutcome<Action>,
): Promise<RevokeGrantOutcome<Action>> {
  completeAuthoritySpan(
    span,
    outcome.kind === 'revoked' ? (outcome.replayed ? 'replayed' : 'revoked') : outcome.refusal.reason,
    outcome.kind === 'revoked'
      ? { kind: outcome.kind, replayed: outcome.replayed }
      : {
          kind: outcome.kind,
          reason: outcome.refusal.reason,
          ...(outcome.refusal.authorityReason === undefined
            ? {}
            : { authorityReason: outcome.refusal.authorityReason }),
        },
  );
  return Promise.resolve(outcome);
}

/** Process-local retained ledger that serializes every transition in one JavaScript turn. */
class MemoryAuthorityLedger<Actions extends ProtectedAction> implements AuthorityLedger<Actions> {
  /** Names the exact in-memory ledger selected at construction. */
  readonly ledgerId;

  /** Shared terminal settlement returned by every closure path. */
  readonly closed: Promise<AuthorityBrokerCloseEvidence>;

  /** Resolves the one retained close settlement. */
  readonly #settleClosed: (evidence: AuthorityBrokerCloseEvidence) => void;

  /** Trusted clock retained so callers cannot choose verification time. */
  readonly #now;

  /** Optional borrowed span producer that cannot control Authority behavior. */
  readonly #diagnostics: AuthorityDiagnostics | undefined;

  /** Explicit registered definitions copied at construction, including administration actions. */
  readonly #actions: readonly AuthorityActionDefinition<Actions | AuthorityGrantAction | AuthorityRevokeAction>[];

  /** Current immutable grant facts keyed only for process-local lookup efficiency. */
  readonly #grants = new Map<string, AuthorizationGrant<Actions | AuthorityGrantAction | AuthorityRevokeAction>>();

  /** Current immutable revocation facts in settlement order. */
  readonly #revocations: GrantRevocation<Actions | AuthorityGrantAction | AuthorityRevokeAction>[] = [];

  /** Stores exact finite command settlements for idempotent replay and conflict detection. */
  readonly #commands = new Map<IdempotencyKey, CommandReplay>();

  /** Stops new checks and commands without manufacturing grant revocations. */
  #isClosed = false;

  /**
   * Captures trusted construction inputs before exposing the retained handle.
   * @param options - Explicit ledger identity, actions, roots, and trusted clock.
   */
  constructor(options: AuthorityLedgerOptions<Actions>) {
    this.ledgerId = AuthorityLedgerIdSchema.parse(options.ledgerId);
    this.#now = options.now ?? systemAuthorityClock;
    this.#diagnostics = options.diagnostics;
    /** Built-in administration remains explicit but cannot be replaced by downstream definitions. */
    const actions = [
      ...options.actions,
      AUTHORITY_GRANT_ACTION,
      AUTHORITY_REVOKE_ACTION,
    ] as unknown as readonly AuthorityActionDefinition<Actions | AuthorityGrantAction | AuthorityRevokeAction>[];
    /** Rejects ambiguous runtime policy before the broker becomes visible. */
    const actionNames = new Set<string>();
    /** Examines every explicit and built-in discriminator exactly once. */
    for (const action of actions) {
      if (actionNames.has(action.action)) {
        throw new AuthorityError('authority_duplicate_action', `Duplicate Authority action: ${action.action}`);
      }
      actionNames.add(action.action);
    }
    this.#actions = Object.freeze(
      actions.map(
        /**
         * Copies one registered definition so caller property reassignment cannot alter policy.
         * @param action - Explicit downstream or built-in definition.
         * @returns Shallowly frozen definition whose codec facade was already frozen at creation.
         */
        (action) => Object.freeze({ ...action }),
      ),
    ) as unknown as readonly AuthorityActionDefinition<Actions | AuthorityGrantAction | AuthorityRevokeAction>[];

    /** Re-admits every root so forged objects cannot bypass identity, time, or scope validation. */
    for (const root of options.bootstrap) {
      if (root.object !== 'authorization-grant' || root.origin.kind !== 'bootstrap') {
        throw new AuthorityError('authority_invalid_grant', 'Authority bootstrap accepts only root grant records');
      }
      if (root.ledgerId !== this.ledgerId) {
        throw new AuthorityError('authority_invalid_grant', 'A bootstrap grant belongs to another Authority ledger');
      }
      /** Matching definition is the sole owner allowed to re-admit this root scope. */
      const definition = this.#actions.find(
        /**
         * Selects the only definition permitted to re-admit this root's scope.
         * @param action - Registered downstream or built-in action definition.
         * @returns Whether this definition owns the root action discriminator.
         */
        (action) => action.action === root.action,
      );
      if (definition === undefined) {
        throw new AuthorityError('authority_action_not_registered', `Unregistered Authority action: ${root.action}`);
      }
      if (this.#grants.has(root.id)) {
        throw new AuthorityError('authority_invalid_grant', 'Authority bootstrap grant identities must be unique');
      }
      /** Production factory reconstructs the root and owns all nested immutable values. */
      const admitted = createBootstrapAuthorizationGrant(
        definition as AuthorityActionDefinition<Actions | AuthorityGrantAction | AuthorityRevokeAction>,
        {
          id: root.id,
          ledgerId: root.ledgerId,
          subject: root.subject,
          scope: root.scope as ScopeFor<Actions | AuthorityGrantAction | AuthorityRevokeAction>,
          issuedBy: root.issuedBy,
          createdAt: root.createdAt,
          validFrom: root.validFrom,
          ...(root.expiresAt === undefined ? {} : { expiresAt: root.expiresAt }),
          delegationDepth: root.delegationDepth,
        },
      );
      this.#grants.set(
        admitted.id,
        admitted as AuthorizationGrant<Actions | AuthorityGrantAction | AuthorityRevokeAction>,
      );
    }
    /** Captures the resolver once so `closed` never changes identity. */
    let settleClosed!: (evidence: AuthorityBrokerCloseEvidence) => void;
    this.closed = new Promise((resolve) => {
      settleClosed = resolve;
    });
    this.#settleClosed = settleClosed;
  }

  /**
   * Evaluates current immutable facts using one broker-owned trusted time read.
   * @param request - Exact action-bound current check.
   * @returns A finite allowed verification or exact current refusal.
   */
  verify<Action extends Actions | AuthorityGrantAction | AuthorityRevokeAction>(
    request: AuthorityCheck<Action>,
  ): Promise<AuthorityDecision<Action>> {
    /** Begins observation with identities but never retains protected scope values. */
    const span = beginAuthoritySpan(this.#diagnostics, {
      name: 'authority.verify',
      ledgerId: this.ledgerId,
      grantId: request.grant.grantId,
      action: request.grant.action,
    });
    /** One clock read covers closure and every temporal check in this decision. */
    const checkedAt = authorityTimestamp(this.#now);
    if (this.#isClosed) {
      /** Closed refusal is settled before returning the same finite domain value. */
      const decision: AuthorityDecision<Action> = Object.freeze({
        allowed: false,
        refusal: Object.freeze({
          reason: 'ledger-closed',
          grant: Object.freeze({ ...request.grant }) as GrantRef<Action>,
          subject: request.subject,
          checkedAt,
        }),
      });
      completeAuthoritySpan(span, 'ledger-closed', { allowed: false, reason: 'ledger-closed' });
      return Promise.resolve(decision);
    }
    /** Captures current facts without exposing mutable process-local collections. */
    let decision: AuthorityDecision<Action>;
    try {
      decision = this.#evaluate(request, checkedAt);
    } catch (error) {
      failAuthoritySpan(span, error);
      return Promise.reject(error);
    }
    /** Terminal context keeps denial reason or successful chain depth queryable. */
    completeAuthoritySpan(
      span,
      decision.allowed ? 'allowed' : decision.refusal.reason,
      decision.allowed
        ? { allowed: true, chainDepth: decision.verification.chain.length }
        : { allowed: false, reason: decision.refusal.reason },
    );
    return Promise.resolve(decision);
  }

  /**
   * Issues one independent grant after an atomic current administrative check.
   * @param command - Complete new grant data and idempotency identity.
   * @param authority - Forgeable lookup for current grant-administration permission.
   * @returns Immutable created, replayed, or refused outcome.
   */
  grant<Action extends Actions>(
    command: GrantCommand<Action>,
    authority: GrantRef<AuthorityGrantAction>,
  ): Promise<GrantOutcome<Action>> {
    /** Correlates the requested grant identity without retaining its protected scope. */
    const span = beginAuthoritySpan(this.#diagnostics, {
      name: 'authority.grant',
      ledgerId: this.ledgerId,
      grantId: command.grantId,
      action: command.action,
    });
    if (this.#isClosed) return observedGrantOutcome(span, commandRefusal('ledger-closed'));

    /** Runtime action lookup chooses the only codec allowed to admit command scope. */
    const definition = this.#actions.find((candidate) => candidate.action === command.action) as
      AuthorityActionDefinition<Action> | undefined;
    if (definition === undefined) return observedGrantOutcome(span, commandRefusal('action-not-registered'));
    /** Invalid JavaScript scope input is an expected refusal, not a partial grant. */
    const scope = definition.scope.safeParse(command.scope);
    if (!scope.ok) return observedGrantOutcome(span, commandRefusal('scope-invalid'));

    /** Fingerprint excludes no decision-bearing field, including requested identity and validity. */
    const fingerprint = canonicalJson({
      kind: 'grant',
      grantId: command.grantId,
      subject: command.subject,
      action: command.action,
      scope: scope.value,
      issuedBy: command.issuedBy,
      ...(command.validFrom === undefined ? {} : { validFrom: command.validFrom }),
      ...(command.expiresAt === undefined ? {} : { expiresAt: command.expiresAt }),
      delegationDepth: command.delegationDepth ?? 0,
    });
    /** Idempotency is checked before authority so an admitted command has one stable settlement. */
    const replay = this.#commands.get(command.idempotencyKey);
    if (replay !== undefined) {
      if (replay.fingerprint !== fingerprint) {
        return observedGrantOutcome(span, commandRefusal('idempotency-conflict'));
      }
      /** The stored generic outcome belongs to this exact fingerprint and command key. */
      const outcome = replay.outcome as GrantOutcome<Action>;
      return observedGrantOutcome(
        span,
        outcome.kind === 'granted' ? Object.freeze({ ...outcome, replayed: true }) : outcome,
      );
    }

    /** One trusted instant becomes both the authorization boundary and issuance time. */
    const checkedAt = authorityTimestamp(this.#now);
    /** Administrative scope prevents a grant root from crossing ledgers. */
    const administration = this.#evaluate(
      {
        grant: authority,
        subject: command.issuedBy,
        scope: { kind: 'authority-administration', ledgerId: this.ledgerId },
      },
      checkedAt,
    );
    if (!administration.allowed) {
      /** Retains current administrative refusal for exact idempotent replay. */
      const outcome = commandRefusal('authority-refused', administration.refusal.reason);
      this.#commands.set(command.idempotencyKey, Object.freeze({ fingerprint, outcome }));
      return observedGrantOutcome(span, outcome);
    }

    /** Settles exactly one issuance branch before command receipt persistence. */
    let outcome: GrantOutcome<Action>;
    if (this.#grants.has(command.grantId)) {
      outcome = commandRefusal('grant-already-exists');
    } else {
      /** Defaults immediate validity and non-delegability at the trusted action time. */
      const validFrom = command.validFrom ?? checkedAt;
      /** Depth remains an integer value because negative and fractional delegation is meaningless. */
      const delegationDepth = command.delegationDepth ?? 0;
      if (
        Date.parse(validFrom) < Date.parse(checkedAt) ||
        (command.expiresAt !== undefined && Date.parse(command.expiresAt) <= Date.parse(validFrom))
      ) {
        outcome = commandRefusal('invalid-validity-window');
      } else if (!Number.isSafeInteger(delegationDepth) || delegationDepth < 0) {
        outcome = commandRefusal('invalid-delegation-depth');
      } else {
        try {
          /** Whole-object construction runs after every expected refusal and before state mutation. */
          const grant = createIssuedAuthorizationGrant(definition, {
            root: {
              id: command.grantId,
              ledgerId: this.ledgerId,
              subject: command.subject,
              scope: scope.value as ScopeFor<Action>,
              issuedBy: command.issuedBy,
              createdAt: checkedAt,
              validFrom,
              ...(command.expiresAt === undefined ? {} : { expiresAt: command.expiresAt }),
              delegationDepth,
            },
            origin: Object.freeze({
              kind: 'authority-grant',
              authority: Object.freeze({ ...authority }),
            }),
          });
          this.#grants.set(
            grant.id,
            grant as AuthorizationGrant<Actions | AuthorityGrantAction | AuthorityRevokeAction>,
          );
          outcome = Object.freeze({ kind: 'granted', grant, replayed: false });
        } catch {
          outcome = commandRefusal('scope-invalid');
        }
      }
    }

    this.#commands.set(command.idempotencyKey, Object.freeze({ fingerprint, outcome }));
    return observedGrantOutcome(span, outcome);
  }

  /**
   * Derives one same-action child whose subject, scope, lifetime, and remaining
   * delegation can only narrow the current parent.
   * @param command - Complete child grant data and idempotency identity.
   * @param parent - Current parent lookup presented by its exact subject.
   * @returns Immutable created, replayed, or refused outcome.
   */
  attenuate<Action extends Actions>(
    command: AttenuateGrantCommand<Action>,
    parent: GrantRef<Action>,
  ): Promise<GrantOutcome<Action>> {
    /** Correlates the requested child while recording only its action discriminator. */
    const span = beginAuthoritySpan(this.#diagnostics, {
      name: 'authority.attenuate',
      ledgerId: this.ledgerId,
      grantId: command.grantId,
      action: parent.action,
    });
    if (this.#isClosed) return observedGrantOutcome(span, commandRefusal('ledger-closed'));

    /** Parent action selects the only scope codec and containment policy for this child. */
    const definition = this.#actions.find((candidate) => candidate.action === parent.action) as
      AuthorityActionDefinition<Action> | undefined;
    if (definition === undefined) return observedGrantOutcome(span, commandRefusal('action-not-registered'));
    /** Scope admission occurs before idempotency storage so invalid inputs create no receipt. */
    const scope = definition.scope.safeParse(command.scope);
    if (!scope.ok) return observedGrantOutcome(span, commandRefusal('scope-invalid'));

    /** Fingerprint binds every caller-controlled attenuation choice. */
    const fingerprint = canonicalJson({
      kind: 'attenuate',
      parent,
      grantId: command.grantId,
      subject: command.subject,
      issuedBy: command.issuedBy,
      scope: scope.value,
      ...(command.validFrom === undefined ? {} : { validFrom: command.validFrom }),
      ...(command.expiresAt === undefined ? {} : { expiresAt: command.expiresAt }),
      delegationDepth: command.delegationDepth ?? 0,
    });
    /** Exact replay returns the retained result while key reuse for another child is refused. */
    const replay = this.#commands.get(command.idempotencyKey);
    if (replay !== undefined) {
      if (replay.fingerprint !== fingerprint) {
        return observedGrantOutcome(span, commandRefusal('idempotency-conflict'));
      }
      /** Stored outcome type follows from this exact parent action and command fingerprint. */
      const outcome = replay.outcome as GrantOutcome<Action>;
      return observedGrantOutcome(
        span,
        outcome.kind === 'granted' ? Object.freeze({ ...outcome, replayed: true }) : outcome,
      );
    }

    /** One clock read governs parent authority, child issuance, and all time comparisons. */
    const checkedAt = authorityTimestamp(this.#now);
    /** Verification against child scope proves current scope containment and parent lineage. */
    let parentDecision: AuthorityDecision<Action>;
    try {
      parentDecision = this.#evaluate(
        {
          grant: parent,
          subject: command.issuedBy,
          scope: scope.value as ScopeFor<Action>,
        },
        checkedAt,
      );
    } catch (error) {
      failAuthoritySpan(span, error);
      return Promise.reject(error);
    }
    if (!parentDecision.allowed) {
      /** Promotes common attenuation boundary failures into their most exact command category. */
      const reason =
        parentDecision.refusal.reason === 'scope-mismatch'
          ? 'attenuation-scope-amplified'
          : parentDecision.refusal.reason === 'subject-mismatch'
            ? 'attenuation-subject-mismatch'
            : 'delegation-not-permitted';
      /** Retains exact non-amplification refusal for idempotent replay. */
      const outcome = commandRefusal(reason, parentDecision.refusal.reason);
      this.#commands.set(command.idempotencyKey, Object.freeze({ fingerprint, outcome }));
      return observedGrantOutcome(span, outcome);
    }

    /** Current verification guarantees the parent exists with this exact action. */
    const parentGrant = this.#grants.get(parent.grantId) as AuthorizationGrant<Action> | undefined;
    /** Settles exactly one attenuation branch before command receipt persistence. */
    let outcome: GrantOutcome<Action>;
    if (parentGrant === undefined) {
      outcome = commandRefusal('grant-not-found');
    } else if (parentGrant.subject !== command.issuedBy) {
      outcome = commandRefusal('attenuation-subject-mismatch');
    } else if (this.#grants.has(command.grantId)) {
      outcome = commandRefusal('grant-already-exists');
    } else if (parentGrant.delegationDepth === 0) {
      outcome = commandRefusal('delegation-not-permitted');
    } else {
      /** Non-delegable children are the safe default even when their parent permits more. */
      const delegationDepth = command.delegationDepth ?? 0;
      /** Omitted child expiry inherits its parent instead of accidentally outliving it. */
      const expiresAt = command.expiresAt ?? parentGrant.expiresAt;
      /** Child begins immediately unless the caller deliberately delays it. */
      const validFrom = command.validFrom ?? checkedAt;

      if (!Number.isSafeInteger(delegationDepth) || delegationDepth < 0) {
        outcome = commandRefusal('invalid-delegation-depth');
      } else if (delegationDepth >= parentGrant.delegationDepth) {
        outcome = commandRefusal('delegation-not-permitted');
      } else if (
        Date.parse(validFrom) < Date.parse(checkedAt) ||
        (expiresAt !== undefined && Date.parse(expiresAt) <= Date.parse(validFrom))
      ) {
        outcome = commandRefusal('invalid-validity-window');
      } else if (
        parentGrant.expiresAt !== undefined &&
        (expiresAt === undefined || Date.parse(expiresAt) > Date.parse(parentGrant.expiresAt))
      ) {
        outcome = commandRefusal('attenuation-expiry-amplified');
      } else {
        try {
          /** Whole-object construction remains pure until every attenuation rule succeeds. */
          const grant = createIssuedAuthorizationGrant(definition, {
            root: {
              id: command.grantId,
              ledgerId: this.ledgerId,
              subject: command.subject,
              scope: scope.value as ScopeFor<Action>,
              issuedBy: command.issuedBy,
              createdAt: checkedAt,
              validFrom,
              ...(expiresAt === undefined ? {} : { expiresAt }),
              delegationDepth,
            },
            origin: Object.freeze({
              kind: 'attenuation',
              parent: Object.freeze({ ...parent }) as GrantRef<Action>,
            }),
          });
          this.#grants.set(
            grant.id,
            grant as AuthorizationGrant<Actions | AuthorityGrantAction | AuthorityRevokeAction>,
          );
          outcome = Object.freeze({ kind: 'granted', grant, replayed: false });
        } catch {
          outcome = commandRefusal('scope-invalid');
        }
      }
    }

    this.#commands.set(command.idempotencyKey, Object.freeze({ fingerprint, outcome }));
    return observedGrantOutcome(span, outcome);
  }

  /**
   * Appends one immutable revocation after an atomic current administrative check.
   * @param command - Exact target, fact identity, attribution, and idempotency key.
   * @param authority - Forgeable lookup for current revocation permission.
   * @returns Immutable created, replayed, or refused outcome.
   */
  revoke<Action extends Actions | AuthorityGrantAction | AuthorityRevokeAction>(
    command: RevokeGrantCommand<Action>,
    authority: GrantRef<AuthorityRevokeAction>,
  ): Promise<RevokeGrantOutcome<Action>> {
    /** Correlates both the target grant and requested immutable revocation fact. */
    const span = beginAuthoritySpan(this.#diagnostics, {
      name: 'authority.revoke',
      ledgerId: this.ledgerId,
      grantId: command.grant.grantId,
      revocationId: command.revocationId,
      action: command.grant.action,
    });
    if (this.#isClosed) return observedRevokeOutcome(span, commandRefusal('ledger-closed'));

    /** Admits optional operator prose before authority checks or idempotency retention. */
    const reason = command.reason === undefined ? undefined : GrantRevocationReasonSchema.safeParse(command.reason);
    if (reason !== undefined && !reason.success) {
      return observedRevokeOutcome(span, commandRefusal('revocation-reason-invalid'));
    }
    /** Normalized reason is identical text or omission after canonical admission. */
    const admittedReason = reason?.data;

    /** Fingerprint binds the target and operator-authored reason without relying on object order. */
    const fingerprint = canonicalJson({
      kind: 'revoke',
      revocationId: command.revocationId,
      grant: command.grant,
      revokedBy: command.revokedBy,
      ...(admittedReason === undefined ? {} : { reason: admittedReason }),
    });
    /** Exact replay returns the retained fact; conflicting reuse cannot target another grant. */
    const replay = this.#commands.get(command.idempotencyKey);
    if (replay !== undefined) {
      if (replay.fingerprint !== fingerprint) {
        return observedRevokeOutcome(span, commandRefusal('idempotency-conflict'));
      }
      /** Stored outcome type follows from this exact target action and command fingerprint. */
      const outcome = replay.outcome as RevokeGrantOutcome<Action>;
      return observedRevokeOutcome(
        span,
        outcome.kind === 'revoked' ? Object.freeze({ ...outcome, replayed: true }) : outcome,
      );
    }

    /** One clock read governs administrative authority and revocation visibility. */
    const checkedAt = authorityTimestamp(this.#now);
    /** Built-in scope prevents a revocation administrator from crossing ledger identity. */
    const administration = this.#evaluate(
      {
        grant: authority,
        subject: command.revokedBy,
        scope: { kind: 'authority-administration', ledgerId: this.ledgerId },
      },
      checkedAt,
    );
    if (!administration.allowed) {
      /** Retains current revocation-administration refusal for idempotent replay. */
      const outcome = commandRefusal('authority-refused', administration.refusal.reason);
      this.#commands.set(command.idempotencyKey, Object.freeze({ fingerprint, outcome }));
      return observedRevokeOutcome(span, outcome);
    }

    /** Target lookup compares stored action after UUID resolution because references are forgeable. */
    const target = this.#grants.get(command.grant.grantId);
    /** Settles exactly one revocation branch before command receipt persistence. */
    let outcome: RevokeGrantOutcome<Action>;
    if (target === undefined || target.action !== command.grant.action) {
      outcome = commandRefusal('grant-not-found');
    } else if (this.#revocations.some((revocation) => revocation.id === command.revocationId)) {
      outcome = commandRefusal('revocation-already-exists');
    } else if (this.#revocations.some((revocation) => revocation.grant.grantId === command.grant.grantId)) {
      outcome = commandRefusal('grant-already-revoked');
    } else {
      try {
        /** Pure construction completes before the new fact becomes visible to verification. */
        const revocation = createGrantRevocation({
          id: command.revocationId,
          ledgerId: this.ledgerId,
          grant: command.grant,
          revokedBy: command.revokedBy,
          createdAt: checkedAt,
          ...(admittedReason === undefined ? {} : { reason: admittedReason }),
        });
        this.#revocations.push(revocation as GrantRevocation<Actions | AuthorityGrantAction | AuthorityRevokeAction>);
        outcome = Object.freeze({ kind: 'revoked', revocation, replayed: false });
      } catch {
        outcome = commandRefusal('scope-invalid');
      }
    }

    this.#commands.set(command.idempotencyKey, Object.freeze({ fingerprint, outcome }));
    return observedRevokeOutcome(span, outcome);
  }

  /**
   * Closes only this process-local broker attachment and never claims revocation.
   * @returns Shared immutable closure evidence.
   */
  close(): Promise<AuthorityBrokerCloseEvidence> {
    if (this.#isClosed) return this.closed;
    /** Only the first close invocation earns one operation span. */
    const span = beginAuthoritySpan(this.#diagnostics, {
      name: 'authority.close',
      ledgerId: this.ledgerId,
    });
    this.#isClosed = true;
    /** Reads closure time exactly once for every concurrent caller. */
    const evidence = Object.freeze({
      kind: 'authority-broker-closed' as const,
      ledgerId: this.ledgerId,
      closedAt: authorityTimestamp(this.#now),
    });
    this.#settleClosed(evidence);
    completeAuthoritySpan(span, 'closed', { kind: evidence.kind });
    return this.closed;
  }

  /** Delegates language-level disposal to the same idempotent close path. */
  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  /**
   * Applies the pure evaluator to an immutable snapshot of current process-local facts.
   * @param request - Exact current action check.
   * @param checkedAt - Single trusted instant already read by the caller.
   * @returns Allowed verification or exact refusal without state mutation.
   */
  #evaluate<Action extends Actions | AuthorityGrantAction | AuthorityRevokeAction>(
    request: AuthorityCheck<Action>,
    checkedAt: Timestamp,
  ): AuthorityDecision<Action> {
    return evaluateAuthority(
      {
        ledgerId: this.ledgerId,
        actions: this.#actions,
        grants: [...this.#grants.values()],
        revocations: [...this.#revocations],
      },
      request,
      checkedAt,
    );
  }
}

/**
 * Opens an ephemeral Authority ledger over explicit action definitions and
 * bootstrap roots.
 * @param options - Trusted construction data retained independently of callers.
 * @returns One retained process-local ledger.
 */
export function createMemoryAuthorityLedger<Actions extends ProtectedAction>(
  options: AuthorityLedgerOptions<Actions>,
): AuthorityLedger<Actions> {
  return new MemoryAuthorityLedger(options);
}
