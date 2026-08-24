/**
 * @file Defines Archer's generic authority values and action-to-scope contract.
 *
 * Capability packages own their action names and scope codecs. Authority owns
 * references, grant lineage, current decisions, and lifecycle so it never needs
 * to import Workspace, sandbox, model, or application domain types.
 */

import * as z from 'zod';

import { fromZod, type Codec } from '../codec.js';
import { ArcherError } from '../errors.js';
import { archerObjectSchema, type ArcherObject } from '../object.js';
import type { OwnedHandle } from '../ownership.js';
import type { DiagnosticHub } from '../diagnostics/contracts.js';
import type { IdempotencyKey } from '../protocol.js';
import {
  JsonObjectSchema,
  TimestampSchema,
  UuidV4Schema,
  type JsonObject,
  type Timestamp,
  type UuidV4,
} from '../values.js';

/** Prevents an ordinary UUIDv4 from being used as a Principal identity. */
declare const principalIdBrand: unique symbol;

/** Identifies an actor for attribution without implying permission. */
export type PrincipalId = UuidV4 & {
  /** Carries compile-time evidence of Principal identity admission. */
  readonly [principalIdBrand]: true;
};

/** Prevents an ordinary UUIDv4 from naming an authorization grant. */
declare const authorizationGrantIdBrand: unique symbol;

/** Identifies one immutable authorization grant record. */
export type AuthorizationGrantId = UuidV4 & {
  /** Carries compile-time evidence of authorization-grant identity admission. */
  readonly [authorizationGrantIdBrand]: true;
};

/** Prevents an ordinary UUIDv4 from selecting an Authority ledger. */
declare const authorityLedgerIdBrand: unique symbol;

/** Identifies the ledger whose current facts a broker evaluates. */
export type AuthorityLedgerId = UuidV4 & {
  /** Carries compile-time evidence of Authority-ledger identity admission. */
  readonly [authorityLedgerIdBrand]: true;
};

/** Prevents an ordinary UUIDv4 from naming a revocation fact. */
declare const grantRevocationIdBrand: unique symbol;

/** Identifies one immutable grant-revocation fact. */
export type GrantRevocationId = UuidV4 & {
  /** Carries compile-time evidence of grant-revocation identity admission. */
  readonly [grantRevocationIdBrand]: true;
};

/** Canonical runtime admission for Principal UUIDv4 identities. */
export const PrincipalIdSchema = UuidV4Schema.transform((value) => value as PrincipalId);

/** Canonical runtime admission for authorization-grant UUIDv4 identities. */
export const AuthorizationGrantIdSchema = UuidV4Schema.transform((value) => value as AuthorizationGrantId);

/** Canonical runtime admission for Authority-ledger UUIDv4 identities. */
export const AuthorityLedgerIdSchema = UuidV4Schema.transform((value) => value as AuthorityLedgerId);

/** Canonical runtime admission for grant-revocation UUIDv4 identities. */
export const GrantRevocationIdSchema = UuidV4Schema.transform((value) => value as GrantRevocationId);

/** Canonical admission for optional operator-authored revocation context. */
export const GrantRevocationReasonSchema = z.string().min(1).max(1024);

/** An attributable Archer actor with no permission encoded in its shape. */
export type Principal = ArcherObject<'principal', PrincipalId>;

/** Canonical runtime admission for immutable Principal attribution values. */
export const PrincipalSchema = archerObjectSchema('principal', PrincipalIdSchema);

/**
 * Couples one protected action discriminator to the complete JSON scope its
 * owning package requires at that action boundary.
 */
export type ProtectedAction<Action extends string = string, Scope extends JsonObject = JsonObject> = Readonly<{
  /** Stable discriminator owned by the package that performs the action. */
  action: Action;

  /** Complete current target and constraints checked before the action occurs. */
  scope: Scope;
}>;

/** Extracts the stable discriminator from a protected action contract. */
export type ProtectedActionName<Action extends ProtectedAction> =
  Action extends ProtectedAction<infer Name, JsonObject> ? Name : never;

/** Extracts the complete scope type from a protected action contract. */
export type ScopeFor<Action extends ProtectedAction> =
  Action extends ProtectedAction<string, infer Scope> ? Scope : never;

/**
 * Supplies runtime admission and containment for one protected action.
 *
 * `allows` must be reflexive and may admit a narrower requested scope. Exact
 * actions use equality. Prefix, quota, or resource families may implement real
 * attenuation without teaching Authority their domain vocabulary.
 */
export type AuthorityActionDefinition<Action extends ProtectedAction> = Action extends ProtectedAction
  ? Readonly<{
      /** Matches grant records and lookup references to this exact action family. */
      action: ProtectedActionName<Action>;

      /** Validates, copies, and freezes action-owned scope values. */
      scope: Codec<ScopeFor<Action>>;

      /** Decides whether a granted scope contains the exact requested scope. */
      allows(granted: ScopeFor<Action>, requested: ScopeFor<Action>): boolean;
    }>
  : never;

/**
 * Copies one action definition so later caller mutation cannot rewrite ledger
 * policy after construction.
 * @param definition - Action discriminator, scope codec, and containment rule.
 * @returns A shallowly frozen definition suitable for explicit registration.
 */
export function defineAuthorityAction<Action extends ProtectedAction>(
  definition: AuthorityActionDefinition<Action>,
): AuthorityActionDefinition<Action> {
  /** Copies and freezes the codec facade so later property replacement cannot rewrite policy admission. */
  const scope = Object.freeze({ ...definition.scope });
  return Object.freeze({ ...definition, scope }) as AuthorityActionDefinition<Action>;
}

/** Stable Authority-owned Error categories for invalid configuration and adapter failure. */
export type AuthorityErrorCode =
  | 'authority_action_not_registered'
  | 'authority_duplicate_action'
  | 'authority_invalid_grant'
  | 'authority_policy_failed';

/** Optional bounded context retained by one Authority implementation Error. */
type AuthorityErrorOptions = ErrorOptions & {
  /** Carries admitted machine-readable details without protected scope data. */
  readonly details?: JsonObject;
};

/** Reports a broken Authority construction or implementation boundary. */
export class AuthorityError extends ArcherError {
  /** Narrows the inherited machine code to Authority's stable failure set. */
  declare readonly code: AuthorityErrorCode;

  /**
   * Constructs one redaction-safe Authority failure.
   * @param code - Stable category suitable for adapter handling.
   * @param message - Bounded explanation without raw policy or scope data.
   * @param options - Optional admitted details and process-local cause.
   */
  constructor(code: AuthorityErrorCode, message: string, options: AuthorityErrorOptions = {}) {
    super(message, {
      code,
      ...(options.details === undefined ? {} : { details: options.details }),
      ...(options.cause === undefined ? {} : { cause: options.cause }),
    });
  }
}

/**
 * A forgeable lookup key for one action-specific grant record.
 *
 * The action discriminator prevents obvious category substitution in
 * TypeScript. Only `AuthorityBroker.verify` can turn the reference into a
 * current decision.
 */
export type GrantRef<Action extends ProtectedAction> = Action extends ProtectedAction
  ? Readonly<{
      /** Locates the immutable grant record in one configured ledger. */
      grantId: AuthorizationGrantId;

      /** Keeps references for different protected actions structurally distinct. */
      action: ProtectedActionName<Action>;
    }>
  : never;

/** Describes how one immutable grant entered its ledger. */
export type AuthorizationGrantOrigin<Action extends ProtectedAction> =
  | Readonly<{
      /** Marks a trust root admitted only while constructing the ledger. */
      kind: 'bootstrap';
    }>
  | Readonly<{
      /** Records the administrative grant used at the issuance boundary. */
      kind: 'authority-grant';

      /** Preserves issuance attribution without making later validity depend on it. */
      authority: GrantRef<AuthorityGrantAction>;
    }>
  | Readonly<{
      /** Makes parent revocation and expiry constrain the child dynamically. */
      kind: 'attenuation';

      /** Names the same-action parent whose authority the child narrows. */
      parent: GrantRef<Action>;
    }>;

/** One immutable principal-bound authorization fact. */
export type AuthorizationGrant<Action extends ProtectedAction = ProtectedAction> = Action extends ProtectedAction
  ? ArcherObject<'authorization-grant', AuthorizationGrantId> &
      Readonly<{
        /** Names the ledger responsible for current verification. */
        ledgerId: AuthorityLedgerId;

        /** Selects the scope codec and containment rule. */
        action: ProtectedActionName<Action>;

        /** Identifies the only Principal allowed to use this grant. */
        subject: PrincipalId;

        /** Bounds the action to domain-owned target and constraint data. */
        scope: ScopeFor<Action>;

        /** Attributes issuance without granting the issuer continuing control. */
        issuedBy: PrincipalId;

        /** Delays use when a grant should become valid after its issuance fact. */
        validFrom: Timestamp;

        /** Ends use at this instant; omission means no time-based expiry. */
        expiresAt?: Timestamp;

        /** Limits how many further attenuation edges may descend from this grant. */
        delegationDepth: number;

        /** Preserves bootstrap, administrative issuance, or attenuation lineage. */
        origin: AuthorizationGrantOrigin<Action>;
      }>
  : never;

/** One immutable fact that stops a grant and all attenuated descendants. */
export type GrantRevocation<Action extends ProtectedAction = ProtectedAction> = Action extends ProtectedAction
  ? ArcherObject<'grant-revocation', GrantRevocationId> &
      Readonly<{
        /** Names the ledger responsible for applying this fact. */
        ledgerId: AuthorityLedgerId;

        /** Identifies the exact grant made unusable by this fact. */
        grant: GrantRef<Action>;

        /** Attributes the administrative action without making identity permission. */
        revokedBy: PrincipalId;

        /** Optional operator-authored explanation retained as bounded public text. */
        reason?: string;
      }>
  : never;

/** Scope used by Authority's own grant and revocation administration actions. */
export type AuthorityAdministrationScope = Readonly<{
  /** Keeps administrative scopes distinct from downstream domain scopes. */
  kind: 'authority-administration';

  /** Prevents one ledger's administrator grant from crossing into another. */
  ledgerId: AuthorityLedgerId;
}>;

/** Authority-owned permission to issue a new non-bootstrap grant. */
export type AuthorityGrantAction = ProtectedAction<'authority-grant', AuthorityAdministrationScope>;

/** Authority-owned permission to append one grant-revocation fact. */
export type AuthorityRevokeAction = ProtectedAction<'authority-revoke', AuthorityAdministrationScope>;

/** Runtime scope admission for Authority's own ledger administration. */
const AuthorityAdministrationScopeSchema = z
  .strictObject({
    kind: z.literal('authority-administration'),
    ledgerId: AuthorityLedgerIdSchema,
  })
  .transform((value) => Object.freeze(value) as AuthorityAdministrationScope)
  .readonly();

/** Product-neutral codec facade for Authority administration scope values. */
const authorityAdministrationScopeCodec: Codec<AuthorityAdministrationScope> = fromZod(
  AuthorityAdministrationScopeSchema,
);

/** Built-in action definition used to authorize administrative grant issuance. */
export const AUTHORITY_GRANT_ACTION: AuthorityActionDefinition<AuthorityGrantAction> =
  defineAuthorityAction<AuthorityGrantAction>({
    action: 'authority-grant',
    scope: authorityAdministrationScopeCodec,
    /**
     * Allows administration only when both scopes name the same ledger.
     * @param granted - Ledger administration scope stored in the grant.
     * @param requested - Ledger administration scope requested by the command.
     * @returns Whether the current grant contains the command's ledger target.
     */
    allows: (granted, requested) => granted.ledgerId === requested.ledgerId,
  });

/** Built-in action definition used to authorize grant revocation. */
export const AUTHORITY_REVOKE_ACTION: AuthorityActionDefinition<AuthorityRevokeAction> =
  defineAuthorityAction<AuthorityRevokeAction>({
    action: 'authority-revoke',
    scope: authorityAdministrationScopeCodec,
    /**
     * Allows administration only when both scopes name the same ledger.
     * @param granted - Ledger administration scope stored in the grant.
     * @param requested - Ledger administration scope requested by the command.
     * @returns Whether the current grant contains the command's ledger target.
     */
    allows: (granted, requested) => granted.ledgerId === requested.ledgerId,
  });

/** Input admitted only at the trusted construction boundary for a new ledger. */
export type BootstrapAuthorizationGrantInput<Action extends ProtectedAction> = Readonly<{
  /** Supplies stable UUIDv4 identity for configuration and deterministic tests. */
  id: AuthorizationGrantId;

  /** Binds the record to the ledger being constructed. */
  ledgerId: AuthorityLedgerId;

  /** Identifies the Principal who may later present a matching GrantRef. */
  subject: PrincipalId;

  /** Contains the complete action-owned target and constraints. */
  scope: ScopeFor<Action>;

  /** Attributes the trust-root installation decision. */
  issuedBy: PrincipalId;

  /** Records when ledger construction admitted this root. */
  createdAt: Timestamp;

  /** Delays use independently from record creation when required. */
  validFrom?: Timestamp;

  /** Ends this root and every attenuated descendant at one exact instant. */
  expiresAt?: Timestamp;

  /** Caps the number of future attenuation generations. */
  delegationDepth?: number;
}>;

/**
 * Constructs one immutable trust root for explicit ledger bootstrap.
 * @param definition - Runtime owner of the action and scope semantics.
 * @param input - Trusted root configuration validated like stored data.
 * @returns A frozen grant whose later use still requires broker verification.
 */
export function createBootstrapAuthorizationGrant<Action extends ProtectedAction>(
  definition: AuthorityActionDefinition<Action>,
  input: BootstrapAuthorizationGrantInput<Action>,
): AuthorizationGrant<Action> {
  try {
    /** Normalizes every identity even when a JavaScript caller bypasses TypeScript. */
    const id = AuthorizationGrantIdSchema.parse(input.id);
    /** Prevents a root for another ledger from entering this immutable fact. */
    const ledgerId = AuthorityLedgerIdSchema.parse(input.ledgerId);
    /** Admits attribution independently from any authorization decision. */
    const subject = PrincipalIdSchema.parse(input.subject);
    /** Admits issuer attribution independently from the resulting grant. */
    const issuedBy = PrincipalIdSchema.parse(input.issuedBy);
    /** Canonicalizes the issuance fact before comparing its validity window. */
    const createdAt = TimestampSchema.parse(input.createdAt);
    /** Defaults immediate validity to the exact trusted construction instant. */
    const validFrom = TimestampSchema.parse(input.validFrom ?? createdAt);
    /** Preserves omission as indefinite validity rather than an artificial maximum. */
    const expiresAt = input.expiresAt === undefined ? undefined : TimestampSchema.parse(input.expiresAt);
    /** Defaults roots to non-delegable so authority expansion requires an explicit choice. */
    const delegationDepth = input.delegationDepth ?? 0;

    if (definition.action.length === 0) {
      throw new AuthorityError('authority_invalid_grant', 'An Authority action must not be empty');
    }
    if (!Number.isSafeInteger(delegationDepth) || delegationDepth < 0) {
      throw new AuthorityError('authority_invalid_grant', 'Delegation depth must be a non-negative safe integer');
    }
    if (Date.parse(validFrom) < Date.parse(createdAt)) {
      throw new AuthorityError('authority_invalid_grant', 'A bootstrap grant cannot be valid before it exists');
    }
    if (expiresAt !== undefined && Date.parse(expiresAt) <= Date.parse(validFrom)) {
      throw new AuthorityError('authority_invalid_grant', 'A bootstrap grant must expire after it becomes valid');
    }

    /** Delegates target invariants and deep copying to the action-owning codec. */
    const scope = definition.scope.parse(input.scope);
    /** Origin is frozen independently so the complete record has no mutable child. */
    const origin: AuthorizationGrantOrigin<Action> = Object.freeze({ kind: 'bootstrap' });

    return Object.freeze({
      id,
      object: 'authorization-grant',
      createdAt,
      ledgerId,
      action: definition.action,
      subject,
      scope,
      issuedBy,
      validFrom,
      ...(expiresAt === undefined ? {} : { expiresAt }),
      delegationDepth,
      origin,
    }) as AuthorizationGrant<Action>;
  } catch (error) {
    if (error instanceof AuthorityError) throw error;
    throw new AuthorityError('authority_invalid_grant', 'The bootstrap authorization grant is invalid', {
      cause: error,
    });
  }
}

/** Current verification request made immediately before a protected action. */
export type AuthorityCheck<Action extends ProtectedAction> = Readonly<{
  /** Supplies forgeable lookup identity, never cached permission. */
  grant: GrantRef<Action>;

  /** Must equal the grant's exact Principal subject. */
  subject: PrincipalId;

  /** Names the exact current target and constraints of this attempted action. */
  scope: ScopeFor<Action>;
}>;

/** Stable reasons current Authority verification can refuse an action. */
export type AuthorityRefusalReason =
  | 'ledger-closed'
  | 'action-not-registered'
  | 'grant-not-found'
  | 'action-mismatch'
  | 'subject-mismatch'
  | 'scope-invalid'
  | 'scope-mismatch'
  | 'grant-not-active'
  | 'grant-expired'
  | 'grant-revoked'
  | 'ancestor-not-found'
  | 'ancestor-action-mismatch'
  | 'ancestor-not-active'
  | 'ancestor-expired'
  | 'ancestor-revoked'
  | 'grant-chain-cycle';

/** Evidence that one exact check passed against current ledger state. */
export type AuthorityVerification<Action extends ProtectedAction> = Readonly<{
  /** Retains the lookup reference evaluated at this boundary. */
  grant: GrantRef<Action>;

  /** Retains the exact Principal checked against the grant chain. */
  subject: PrincipalId;

  /** Retains the exact action-owned target admitted for this call only. */
  scope: ScopeFor<Action>;

  /** Records the broker's trusted clock read used for every temporal check. */
  checkedAt: Timestamp;

  /** Lists the evaluated grant chain from presented grant to attenuation root. */
  chain: readonly AuthorizationGrantId[];
}>;

/** Exact denial evidence that cannot be reused as a permission value. */
export type AuthorityRefusal<Action extends ProtectedAction> = Readonly<{
  /** Stable branch identity suitable for caller policy and conformance. */
  reason: AuthorityRefusalReason;

  /** Retains the lookup reference whose current use was refused. */
  grant: GrantRef<Action>;

  /** Retains the Principal claimed by the protected service. */
  subject: PrincipalId;

  /** Records the broker's trusted clock read used for the refusal. */
  checkedAt: Timestamp;
}>;

/** Current finite answer returned by an Authority broker. */
export type AuthorityDecision<Action extends ProtectedAction> =
  | Readonly<{
      /** Selects the only branch that permits the immediate protected action. */
      allowed: true;

      /** Proves this check without becoming a reusable capability. */
      verification: AuthorityVerification<Action>;
    }>
  | Readonly<{
      /** Selects a current refusal without throwing for ordinary denial. */
      allowed: false;

      /** Explains the exact refused check with no raw policy exception. */
      refusal: AuthorityRefusal<Action>;
    }>;

/** Immutable close evidence shared by Authority broker and ledger handles. */
export type AuthorityBrokerCloseEvidence = Readonly<{
  /** Distinguishes orderly retained-handle closure from grant revocation. */
  kind: 'authority-broker-closed';

  /** Names the broker attachment that stopped accepting checks. */
  ledgerId: AuthorityLedgerId;

  /** Records closure through the same injected trusted clock. */
  closedAt: Timestamp;
}>;

/** Finite current-verification port used by every protected Archer service. */
export interface AuthorityBroker<
  Actions extends ProtectedAction = ProtectedAction,
> extends OwnedHandle<AuthorityBrokerCloseEvidence> {
  /** Names the exact ledger this retained broker consults. */
  readonly ledgerId: AuthorityLedgerId;

  /**
   * Checks current subject, action, scope, time, expiry, and revocation state.
   * The returned verification is evidence for the immediate caller only.
   */
  verify<Action extends Actions>(request: AuthorityCheck<Action>): Promise<AuthorityDecision<Action>>;
}

/** Command that issues a new independently revocable grant under ledger administration. */
export type GrantCommand<Action extends ProtectedAction> = Readonly<{
  /** Supplies stable grant identity before persistence. */
  grantId: AuthorizationGrantId;

  /** Identifies the Principal receiving the grant. */
  subject: PrincipalId;

  /** Selects one registered action definition. */
  action: ProtectedActionName<Action>;

  /** Bounds the new grant through the selected action's codec and containment rule. */
  scope: ScopeFor<Action>;

  /** Must present the Authority administration grant as this Principal. */
  issuedBy: PrincipalId;

  /** Delays validity; omission uses the trusted issuance instant. */
  validFrom?: Timestamp;

  /** Ends validity; omission permits indefinite use unless revoked. */
  expiresAt?: Timestamp;

  /** Caps future attenuation depth and defaults to zero. */
  delegationDepth?: number;

  /** Deduplicates the exact issuance command at this ledger. */
  idempotencyKey: IdempotencyKey;
}>;

/** Command that derives a narrower same-action grant from a current parent. */
export type AttenuateGrantCommand<Action extends ProtectedAction> = Readonly<{
  /** Supplies stable child identity before persistence. */
  grantId: AuthorizationGrantId;

  /** Identifies the Principal receiving the attenuated grant. */
  subject: PrincipalId;

  /** Must equal the current parent subject at the attenuation boundary. */
  issuedBy: PrincipalId;

  /** Must be contained by the parent scope according to the action definition. */
  scope: ScopeFor<Action>;

  /** Delays validity no earlier than the child issuance instant. */
  validFrom?: Timestamp;

  /** Cannot outlive an expiring parent. */
  expiresAt?: Timestamp;

  /** Must leave fewer remaining generations than the parent permits. */
  delegationDepth?: number;

  /** Deduplicates the exact attenuation command at this ledger. */
  idempotencyKey: IdempotencyKey;
}>;

/** Command that appends an immutable revocation fact for one exact grant. */
export type RevokeGrantCommand<Action extends ProtectedAction> = Readonly<{
  /** Supplies stable revocation identity before persistence. */
  revocationId: GrantRevocationId;

  /** Names the exact grant that future verification must refuse. */
  grant: GrantRef<Action>;

  /** Must present the Authority revocation grant as this Principal. */
  revokedBy: PrincipalId;

  /** Optional bounded operator explanation retained with the fact. */
  reason?: string;

  /** Deduplicates the exact revocation command at this ledger. */
  idempotencyKey: IdempotencyKey;
}>;

/** Stable expected refusal categories for grant-state commands. */
export type AuthorityCommandRefusalReason =
  | 'ledger-closed'
  | 'authority-refused'
  | 'action-not-registered'
  | 'scope-invalid'
  | 'idempotency-conflict'
  | 'grant-already-exists'
  | 'grant-not-found'
  | 'grant-already-revoked'
  | 'revocation-already-exists'
  | 'revocation-reason-invalid'
  | 'invalid-validity-window'
  | 'invalid-delegation-depth'
  | 'delegation-not-permitted'
  | 'attenuation-subject-mismatch'
  | 'attenuation-scope-amplified'
  | 'attenuation-expiry-amplified';

/** Expected command refusal that promises no grant or revocation state changed. */
export type AuthorityCommandRefusal = Readonly<{
  /** Stable reason distinguishing the rule that rejected the command. */
  reason: AuthorityCommandRefusalReason;

  /** Preserves the exact current-verification category when authority itself failed. */
  authorityReason?: AuthorityRefusalReason;
}>;

/** Result of administrative issuance or same-action attenuation. */
export type GrantOutcome<Action extends ProtectedAction> =
  | Readonly<{
      /** Confirms one immutable grant exists after this command. */
      kind: 'granted';

      /** Carries the exact created or previously idempotent grant. */
      grant: AuthorizationGrant<Action>;

      /** Distinguishes original settlement from exact command replay. */
      replayed: boolean;
    }>
  | Readonly<{
      /** Confirms the ledger preserved all prior facts. */
      kind: 'refused';

      /** Names the exact rule that prevented issuance. */
      refusal: AuthorityCommandRefusal;
    }>;

/** Result of appending one exact grant-revocation fact. */
export type RevokeGrantOutcome<Action extends ProtectedAction> =
  | Readonly<{
      /** Confirms the revocation fact exists after this command. */
      kind: 'revoked';

      /** Carries the exact created or previously idempotent fact. */
      revocation: GrantRevocation<Action>;

      /** Distinguishes original settlement from exact command replay. */
      replayed: boolean;
    }>
  | Readonly<{
      /** Confirms the ledger preserved all prior facts. */
      kind: 'refused';

      /** Names the exact rule that prevented revocation. */
      refusal: AuthorityCommandRefusal;
    }>;

/** Mutable Authority port whose facts remain finite values rather than a live permission cache. */
export interface AuthorityLedger<Actions extends ProtectedAction = ProtectedAction> extends AuthorityBroker<
  Actions | AuthorityGrantAction | AuthorityRevokeAction
> {
  /** Issues a new grant after current ledger-administration verification. */
  grant<Action extends Actions>(
    command: GrantCommand<Action>,
    authority: GrantRef<AuthorityGrantAction>,
  ): Promise<GrantOutcome<Action>>;

  /** Derives one narrower grant whose parent remains dynamically authoritative. */
  attenuate<Action extends Actions>(
    command: AttenuateGrantCommand<Action>,
    parent: GrantRef<Action>,
  ): Promise<GrantOutcome<Action>>;

  /** Appends a revocation fact after current ledger-administration verification. */
  revoke<Action extends Actions | AuthorityGrantAction | AuthorityRevokeAction>(
    command: RevokeGrantCommand<Action>,
    authority: GrantRef<AuthorityRevokeAction>,
  ): Promise<RevokeGrantOutcome<Action>>;
}

/** Clock read by a broker rather than supplied by an untrusted verification caller. */
export type AuthorityClock = () => Date;

/** Trusted construction input shared by reference and independent ledgers. */
export type AuthorityLedgerOptions<Actions extends ProtectedAction> = Readonly<{
  /** Fixes the ledger target for built-in administration scopes. */
  ledgerId: AuthorityLedgerId;

  /** Registers every downstream action without an import-time global registry. */
  actions: readonly AuthorityActionDefinition<Actions>[];

  /** Installs explicit trust roots before the retained broker becomes visible. */
  bootstrap: readonly AuthorizationGrant<Actions | AuthorityGrantAction | AuthorityRevokeAction>[];

  /** Supplies the only time source used for checks and new facts. */
  now?: AuthorityClock;

  /** Produces best-effort wide spans without granting diagnostics lifecycle ownership. */
  diagnostics?: Pick<DiagnosticHub, 'beginSpan'>;
}>;

/**
 * Validates and normalizes one trusted clock reading.
 * @param now - Broker-owned clock read exactly at the decision boundary.
 * @returns Canonical UTC timestamp admitted for Authority evidence.
 */
export function authorityTimestamp(now: AuthorityClock): Timestamp {
  return TimestampSchema.parse(now().toISOString());
}

/**
 * Deeply admits a generic scope when an action definition delegates to JSON identity.
 * @param input - Untrusted candidate expected to contain immutable JSON.
 * @returns Deeply copied and frozen generic scope data.
 */
export function authorityJsonScope(input: unknown): JsonObject {
  return JsonObjectSchema.parse(input);
}
