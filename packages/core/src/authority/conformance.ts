/**
 * @file Publishes the versioned behavior suite every Authority ledger must pass.
 *
 * The suite opens fresh ledgers through public contracts and controls their
 * trusted clocks. It proves current verification and grant-state semantics,
 * not one storage engine or policy language.
 */

import * as z from 'zod';

import { fromZod } from '../codec.js';
import {
  ConformanceExecutionSchema,
  conformanceDigestsMatch,
  conformanceExecution,
  conformanceTimestamp,
  digestConformanceValue,
  normalizeConformanceEnvironment,
  type ConformanceEnvironment,
  type ConformanceEvidence,
} from '../conformance.js';
import { ArcherError } from '../errors.js';
import { PublicErrorSchema, toPublicError, type PublicError } from '../protocol.js';
import { IdempotencyKeySchema } from '../protocol.js';
import { Result, type Result as ResultValue } from '../result.js';
import { JsonObjectSchema, Sha256DigestSchema, TimestampSchema, type JsonObject } from '../values.js';
import {
  AUTHORITY_GRANT_ACTION,
  AUTHORITY_REVOKE_ACTION,
  AuthorityLedgerIdSchema,
  AuthorizationGrantIdSchema,
  GrantRevocationIdSchema,
  PrincipalIdSchema,
  createBootstrapAuthorizationGrant,
  createMemoryAuthorityLedger,
  defineAuthorityAction,
  type AuthorityActionDefinition,
  type AuthorityGrantAction,
  type AuthorityLedger,
  type AuthorityLedgerOptions,
  type AuthorityRevokeAction,
  type AuthorizationGrant,
  type ProtectedAction,
} from './index.js';

/** Current immutable Authority behavior catalogue. */
export const AUTHORITY_CONFORMANCE_VERSION = 1 as const;

/** Stable identity and claim for one required Authority behavior. */
export type AuthorityConformanceCase = Readonly<{
  /** Stable machine identity retained in reports and failure evidence. */
  id: AuthorityConformanceCaseId;

  /** Human-readable protocol claim maintained beside its executable case. */
  claim: string;
}>;

/** Stable identities for every required v1 Authority behavior. */
export type AuthorityConformanceCaseId =
  | 'reference.lookup-is-not-authority'
  | 'verification.subject-action-scope'
  | 'verification.trusted-clock-expiry'
  | 'attenuation.no-amplification'
  | 'revocation.ancestor-invalidates-child'
  | 'administration.current-grant-required'
  | 'commands.idempotency-preserves-state'
  | 'lifecycle.close-is-not-revocation';

/** Ordered public catalogue that prevents partial execution from posing as proof. */
export const AUTHORITY_CONFORMANCE_CASES: readonly AuthorityConformanceCase[] = Object.freeze([
  Object.freeze({
    id: 'reference.lookup-is-not-authority',
    claim: 'A structurally valid or forged GrantRef cannot authorize a missing ledger fact.',
  }),
  Object.freeze({
    id: 'verification.subject-action-scope',
    claim: 'Verification binds the exact subject, action discriminator, and action-owned target scope.',
  }),
  Object.freeze({
    id: 'verification.trusted-clock-expiry',
    claim: 'The broker trusted clock activates and expires grants without caller-selected time.',
  }),
  Object.freeze({
    id: 'attenuation.no-amplification',
    claim: 'Attenuation may narrow subject, scope, lifetime, and depth but cannot amplify its parent.',
  }),
  Object.freeze({
    id: 'revocation.ancestor-invalidates-child',
    claim: 'Current parent revocation immediately refuses every attenuated descendant.',
  }),
  Object.freeze({
    id: 'administration.current-grant-required',
    claim: 'Grant issuance and revocation each require their own current ledger-administration grant.',
  }),
  Object.freeze({
    id: 'commands.idempotency-preserves-state',
    claim: 'Exact command replay is stable and conflicting key reuse publishes no new fact.',
  }),
  Object.freeze({
    id: 'lifecycle.close-is-not-revocation',
    claim: 'Close is idempotent, stops checks, and returns evidence distinct from grant revocation.',
  }),
]);

/** Generic construction port implemented by one Authority ledger under test. */
export type AuthorityConformanceTarget = Readonly<{
  /**
   * Opens one fresh retained ledger over suite-owned action definitions and clocks.
   * @param options - Exact protocol construction selected by the executable case.
   * @returns Candidate ledger attachment owned and closed by the suite.
   */
  open<Actions extends ProtectedAction>(options: AuthorityLedgerOptions<Actions>): AuthorityLedger<Actions>;
}>;

/** First-party process-local implementation exercised by Archer's own proof. */
export const CORE_AUTHORITY_CONFORMANCE_TARGET: AuthorityConformanceTarget = Object.freeze({
  /** Opens the reference ledger without weakening generic action inference. */
  open: createMemoryAuthorityLedger,
});

/** Binds one report to an exact implementation and immutable configuration. */
export type AuthorityConformanceImplementation = Readonly<{
  /** Stable implementation or package name. */
  name: string;

  /** Exact implementation version or source revision. */
  version: string;

  /** Immutable configuration whose guarantees the report covers. */
  configuration: JsonObject;
}>;

/** One required Authority case that satisfied its complete assertion set. */
export type PassedAuthorityConformanceCase = Readonly<{
  /** Identifies the required case that ran. */
  id: AuthorityConformanceCaseId;

  /** Confirms every assertion in the case passed. */
  status: 'passed';
}>;

/** One required Authority case that produced bounded failure evidence. */
export type FailedAuthorityConformanceCase = Readonly<{
  /** Identifies the required case that ran. */
  id: AuthorityConformanceCaseId;

  /** Confirms at least one required assertion failed. */
  status: 'failed';

  /** Carries public failure data without leaking native adapter detail. */
  failure: PublicError;
}>;

/** One required Authority case outcome with no skipped success branch. */
export type AuthorityConformanceCaseResult = PassedAuthorityConformanceCase | FailedAuthorityConformanceCase;

/** Complete report returned for both successful and failed Authority runs. */
export type AuthorityConformanceReport = Readonly<{
  /** Selects this report codec. */
  schema: 1;

  /** Names the exact product-neutral protocol under test. */
  protocol: '@archer/core/authority';

  /** Selects the immutable required-case catalogue. */
  suiteVersion: typeof AUTHORITY_CONFORMANCE_VERSION;

  /** Binds results to one implementation and exact configuration. */
  implementation: AuthorityConformanceImplementation;

  /** Lists the required catalogue independently of individual outcomes. */
  requiredCases: readonly AuthorityConformanceCaseId[];

  /** Passes only when every required case executed successfully. */
  status: 'passed' | 'failed';

  /** Contains every executed result in catalogue order. */
  cases: readonly AuthorityConformanceCaseResult[];
}> &
  ConformanceEvidence;

/** Status refinement required before a report can serve as passing evidence. */
type PassingAuthorityStatus = Readonly<{
  /** Confirms every published Authority case passed. */
  status: 'passed';
}>;

/** Authority report narrowed to reusable passing evidence. */
export type PassingAuthorityConformance = AuthorityConformanceReport & PassingAuthorityStatus;

/** Runtime admission for stable Authority case identities. */
const AuthorityConformanceCaseIdSchema = z.enum([
  'reference.lookup-is-not-authority',
  'verification.subject-action-scope',
  'verification.trusted-clock-expiry',
  'attenuation.no-amplification',
  'revocation.ancestor-invalidates-child',
  'administration.current-grant-required',
  'commands.idempotency-preserves-state',
  'lifecycle.close-is-not-revocation',
]);

/** Runtime admission for report implementation identity and configuration. */
const AuthorityConformanceImplementationSchema = z
  .strictObject({
    name: z.string().min(1),
    version: z.string().min(1),
    configuration: JsonObjectSchema,
  })
  .readonly();

/** Runtime admission for one executed case without a skipped branch. */
const AuthorityConformanceCaseResultSchema = z
  .discriminatedUnion('status', [
    z.strictObject({ id: AuthorityConformanceCaseIdSchema, status: z.literal('passed') }),
    z.strictObject({ id: AuthorityConformanceCaseIdSchema, status: z.literal('failed'), failure: PublicErrorSchema }),
  ])
  .readonly();

/** Admits serialized Authority conformance reports before digest verification. */
export const AuthorityConformanceReportSchema = z
  .strictObject({
    schema: z.literal(1),
    protocol: z.literal('@archer/core/authority'),
    suiteVersion: z.literal(AUTHORITY_CONFORMANCE_VERSION),
    implementation: AuthorityConformanceImplementationSchema,
    configurationDigest: Sha256DigestSchema,
    at: TimestampSchema,
    environment: JsonObjectSchema,
    execution: ConformanceExecutionSchema,
    evidenceDigest: Sha256DigestSchema,
    requiredCases: z.array(AuthorityConformanceCaseIdSchema).readonly(),
    status: z.enum(['passed', 'failed']),
    cases: z.array(AuthorityConformanceCaseResultSchema).readonly(),
  })
  .transform((value) => value as AuthorityConformanceReport)
  .readonly();

/** Explains why Authority results cannot be promoted to passing evidence. */
export class AuthorityConformanceError extends ArcherError {
  /**
   * Constructs bounded failure naming every failed required case.
   * @param failedCases - Stable failed identities in catalogue order.
   */
  constructor(failedCases: readonly AuthorityConformanceCaseId[]) {
    super('Authority conformance failed', {
      code: 'authority_conformance_failed',
      details: { failedCases },
    });
  }
}

/** Input required to run one complete Authority conformance pass. */
export type RunAuthorityConformanceOptions = Readonly<{
  /** Candidate construction target exercised by every case. */
  target: AuthorityConformanceTarget;

  /** Identity and exact configuration bound into the report. */
  implementation: AuthorityConformanceImplementation;

  /** Runtime and dependency facts needed to interpret passing evidence. */
  environment: ConformanceEnvironment;

  /** Supplies the evidence timestamp after every case executes. */
  now?: () => Date;
}>;

/** Hierarchical fixture scope gives the suite a real containment rule to prove. */
type FixtureScope = Readonly<{
  /** Keeps suite-owned scope data distinct from Authority administration. */
  kind: 'authority-conformance';

  /** Slash-terminated prefix supports equal or nested target requests. */
  pathPrefix: string;
}>;

/** Primary protected action exercised by every ledger implementation. */
type FixtureAction = ProtectedAction<'authority-conformance-access', FixtureScope>;

/** Secondary action exists only to prove stored action mismatches at runtime. */
type FixtureOtherAction = ProtectedAction<'authority-conformance-other', FixtureScope>;

/** Complete fixture action family registered with candidate ledgers. */
type FixtureActions = FixtureAction | FixtureOtherAction;

/** Runtime scope admission remains package-owned and deeply immutable. */
const FixtureScopeSchema = z
  .strictObject({
    kind: z.literal('authority-conformance'),
    pathPrefix: z.string().min(1).endsWith('/'),
  })
  .transform((value) => Object.freeze(value) as FixtureScope)
  .readonly();

/** Primary fixture action permits only equal or nested path prefixes. */
const FIXTURE_ACTION = defineAuthorityAction<FixtureAction>({
  action: 'authority-conformance-access',
  scope: fromZod(FixtureScopeSchema),
  /**
   * Slash termination makes this fixture containment segment-safe.
   * @param granted - Stored hierarchical fixture scope.
   * @param requested - Current hierarchical target under test.
   * @returns Whether the stored prefix contains the requested prefix.
   */
  allows: (granted, requested) => requested.pathPrefix.startsWith(granted.pathPrefix),
});

/** Secondary fixture action uses the same scope while remaining a distinct permission. */
const FIXTURE_OTHER_ACTION = defineAuthorityAction<FixtureOtherAction>({
  action: 'authority-conformance-other',
  scope: fromZod(FixtureScopeSchema),
  /**
   * Equal containment semantics isolate the action discriminator under test.
   * @param granted - Stored secondary-action fixture scope.
   * @param requested - Current secondary-action target under test.
   * @returns Whether the stored prefix contains the requested prefix.
   */
  allows: (granted, requested) => requested.pathPrefix.startsWith(granted.pathPrefix),
});

/** Candidate action definitions registered without an import-time global registry. */
const FIXTURE_ACTIONS: readonly AuthorityActionDefinition<FixtureActions>[] = Object.freeze([
  FIXTURE_ACTION,
  FIXTURE_OTHER_ACTION,
]);

/** Fixed ledger identity shared only within independent fresh case attachments. */
const fixtureLedgerId = AuthorityLedgerIdSchema.parse('00000000-0000-4000-8000-000000000101');

/** Fixed root subject whose current authority is exercised directly and through attenuation. */
const fixturePrincipalId = PrincipalIdSchema.parse('00000000-0000-4000-8000-000000000102');

/** Fixed delegated subject proves child authority can move to a narrower Principal. */
const fixtureDelegatedId = PrincipalIdSchema.parse('00000000-0000-4000-8000-000000000103');

/** Fixed administrator subject remains attribution until a built-in grant verifies it. */
const fixtureAdministratorId = PrincipalIdSchema.parse('00000000-0000-4000-8000-000000000104');

/** Fixed primary root identity reused only across isolated case ledgers. */
const fixtureRootId = AuthorizationGrantIdSchema.parse('00000000-0000-4000-8000-000000000105');

/** Fixed administrative issuance-root identity. */
const fixtureGrantAuthorityId = AuthorizationGrantIdSchema.parse('00000000-0000-4000-8000-000000000106');

/** Fixed administrative revocation-root identity. */
const fixtureRevokeAuthorityId = AuthorizationGrantIdSchema.parse('00000000-0000-4000-8000-000000000107');

/** Fixed child identity produced by valid attenuation. */
const fixtureChildId = AuthorizationGrantIdSchema.parse('00000000-0000-4000-8000-000000000108');

/** Fixed independent grant identity produced by administrative issuance. */
const fixtureIssuedId = AuthorizationGrantIdSchema.parse('00000000-0000-4000-8000-000000000109');

/** Fixed identity used to prove refused commands publish no hidden fact. */
const fixtureRefusedId = AuthorizationGrantIdSchema.parse('00000000-0000-4000-8000-00000000010a');

/** Fixed missing identity proves structural lookup references are not permission. */
const fixtureMissingId = AuthorizationGrantIdSchema.parse('00000000-0000-4000-8000-00000000010b');

/** Fixed successful issuance command identity. */
const fixtureGrantKey = IdempotencyKeySchema.parse('00000000-0000-4000-8000-00000000010c');

/** Fixed attenuation command identity. */
const fixtureAttenuationKey = IdempotencyKeySchema.parse('00000000-0000-4000-8000-00000000010d');

/** Fixed refused attenuation command identity. */
const fixtureRefusedAttenuationKey = IdempotencyKeySchema.parse('00000000-0000-4000-8000-00000000010e');

/** Fixed revocation fact identity. */
const fixtureRevocationId = GrantRevocationIdSchema.parse('00000000-0000-4000-8000-00000000010f');

/** Fixed revocation command identity. */
const fixtureRevocationKey = IdempotencyKeySchema.parse('00000000-0000-4000-8000-000000000110');

/** Fixed initial instant precedes every case-owned current clock. */
const fixtureCreatedAt = TimestampSchema.parse('2026-08-23T18:00:00.000Z');

/** Mutable controlled clock owned by one conformance case. */
interface FixtureClock {
  /** Current trusted instant copied on every adapter read. */
  current: Date;
}

/** Optional primary-root constraints selected by one executable case. */
interface FixtureRootOptions {
  /** Exact outer expiry used by temporal and attenuation proofs. */
  expiresAt?: string;

  /** Remaining descendant generations admitted by the root. */
  delegationDepth?: number;
}

/**
 * Creates one production-admitted primary root for a fresh case ledger.
 * @param input - Optional lifetime and delegation choices relevant to the case.
 * @returns Immutable hierarchical-access root.
 */
function fixtureRoot(input: Readonly<FixtureRootOptions> = {}): AuthorizationGrant<FixtureAction> {
  return createBootstrapAuthorizationGrant<FixtureAction>(FIXTURE_ACTION, {
    id: fixtureRootId,
    ledgerId: fixtureLedgerId,
    subject: fixturePrincipalId,
    scope: { kind: 'authority-conformance', pathPrefix: 'workspace/' },
    issuedBy: fixtureAdministratorId,
    createdAt: fixtureCreatedAt,
    ...(input.expiresAt === undefined ? {} : { expiresAt: TimestampSchema.parse(input.expiresAt) }),
    delegationDepth: input.delegationDepth ?? 0,
  });
}

/**
 * Creates the built-in grant-administration root for one fresh case ledger.
 * @returns Immutable trust root scoped only to the fixture ledger.
 */
function fixtureGrantAuthority(): AuthorizationGrant<AuthorityGrantAction> {
  return createBootstrapAuthorizationGrant<AuthorityGrantAction>(AUTHORITY_GRANT_ACTION, {
    id: fixtureGrantAuthorityId,
    ledgerId: fixtureLedgerId,
    subject: fixtureAdministratorId,
    scope: { kind: 'authority-administration', ledgerId: fixtureLedgerId },
    issuedBy: fixtureAdministratorId,
    createdAt: fixtureCreatedAt,
  });
}

/**
 * Creates the built-in revocation-administration root for one fresh case ledger.
 * @returns Immutable trust root scoped only to the fixture ledger.
 */
function fixtureRevokeAuthority(): AuthorizationGrant<AuthorityRevokeAction> {
  return createBootstrapAuthorizationGrant<AuthorityRevokeAction>(AUTHORITY_REVOKE_ACTION, {
    id: fixtureRevokeAuthorityId,
    ledgerId: fixtureLedgerId,
    subject: fixtureAdministratorId,
    scope: { kind: 'authority-administration', ledgerId: fixtureLedgerId },
    issuedBy: fixtureAdministratorId,
    createdAt: fixtureCreatedAt,
  });
}

/**
 * Opens one fresh candidate ledger with explicit roots and a controlled clock.
 * @param target - Candidate construction port under test.
 * @param clock - Case-owned trusted time source.
 * @param bootstrap - Exact immutable roots installed before visibility.
 * @returns Retained candidate ledger owned by the current executable case.
 */
function openFixture(
  target: AuthorityConformanceTarget,
  clock: FixtureClock,
  bootstrap: AuthorityLedgerOptions<FixtureActions>['bootstrap'],
): AuthorityLedger<FixtureActions> {
  return target.open<FixtureActions>({
    ledgerId: fixtureLedgerId,
    actions: FIXTURE_ACTIONS,
    bootstrap,
    /**
     * Copies controlled time so candidate code cannot mutate suite clock state.
     * @returns Fresh trusted instant for the candidate ledger.
     */
    now: () => new Date(clock.current),
  });
}

/**
 * Fails one executable case when its exact protocol claim is false.
 * @param condition - Candidate observation that must hold.
 * @param message - Stable local explanation normalized by report generation.
 */
function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/**
 * Proves a forgeable lookup reference cannot authorize an absent grant record.
 * @param target - Candidate implementation under test.
 */
async function lookupCase(target: AuthorityConformanceTarget): Promise<void> {
  /** Fixed current time keeps the installed root valid while missing lookup is tested. */
  const clock: FixtureClock = { current: new Date('2026-08-23T18:30:00.000Z') };
  /** Candidate contains one real root and no record for the presented missing UUID. */
  const ledger = openFixture(target, clock, [fixtureRoot()]);
  try {
    /** Missing lookup must reach current ledger state rather than structural admission alone. */
    const decision = await ledger.verify({
      grant: { grantId: fixtureMissingId, action: 'authority-conformance-access' },
      subject: fixturePrincipalId,
      scope: { kind: 'authority-conformance', pathPrefix: 'workspace/' },
    });
    invariant(!decision.allowed && decision.refusal.reason === 'grant-not-found', 'Missing GrantRef was authoritative');
  } finally {
    await ledger.close();
  }
}

/**
 * Proves subject, action, and target mismatches remain separate current refusals.
 * @param target - Candidate implementation under test.
 */
async function exactBoundaryCase(target: AuthorityConformanceTarget): Promise<void> {
  /** Fixed time lets every request reach identity and containment checks. */
  const clock: FixtureClock = { current: new Date('2026-08-23T18:30:00.000Z') };
  /** Root is exact except for the one condition changed by each request. */
  const ledger = openFixture(target, clock, [fixtureRoot()]);
  try {
    /** Changes only Principal identity from the valid request. */
    const subject = await ledger.verify({
      grant: { grantId: fixtureRootId, action: 'authority-conformance-access' },
      subject: fixtureDelegatedId,
      scope: { kind: 'authority-conformance', pathPrefix: 'workspace/' },
    });
    invariant(!subject.allowed && subject.refusal.reason === 'subject-mismatch', 'Wrong subject did not fail exactly');

    /** Changes only target containment from the valid request. */
    const scope = await ledger.verify({
      grant: { grantId: fixtureRootId, action: 'authority-conformance-access' },
      subject: fixturePrincipalId,
      scope: { kind: 'authority-conformance', pathPrefix: 'private/' },
    });
    invariant(!scope.allowed && scope.refusal.reason === 'scope-mismatch', 'Cross-target scope did not fail exactly');

    /** Cast models hostile wire input because ordinary TypeScript rejects the action substitution. */
    const action = await ledger.verify({
      grant: { grantId: fixtureRootId, action: 'authority-conformance-other' },
      subject: fixturePrincipalId,
      scope: { kind: 'authority-conformance', pathPrefix: 'workspace/' },
    });
    invariant(!action.allowed && action.refusal.reason === 'action-mismatch', 'Wrong action did not fail exactly');

    /** Rechecks the untouched valid root after every preceding refusal. */
    const exact = await ledger.verify({
      grant: { grantId: fixtureRootId, action: 'authority-conformance-access' },
      subject: fixturePrincipalId,
      scope: { kind: 'authority-conformance', pathPrefix: 'workspace/docs/' },
    });
    invariant(exact.allowed, 'Exact current root was damaged by prior refusals');
  } finally {
    await ledger.close();
  }
}

/**
 * Proves expiry follows only the broker-owned clock and uses an exclusive end.
 * @param target - Candidate implementation under test.
 */
async function trustedClockCase(target: AuthorityConformanceTarget): Promise<void> {
  /** Clock begins one millisecond before the exact expiry boundary. */
  const clock: FixtureClock = { current: new Date('2026-08-23T19:00:00.000Z') };
  /** Root expiry is one second later so the first verification remains current. */
  const ledger = openFixture(target, clock, [fixtureRoot({ expiresAt: '2026-08-23T19:00:01.000Z' })]);
  /** Request deliberately has no caller-selected time field. */
  const request = {
    grant: { grantId: fixtureRootId, action: 'authority-conformance-access' as const },
    subject: fixturePrincipalId,
    scope: { kind: 'authority-conformance' as const, pathPrefix: 'workspace/' },
  };
  try {
    invariant((await ledger.verify(request)).allowed, 'Grant expired before its trusted boundary');
    clock.current = new Date('2026-08-23T19:00:01.000Z');
    /** Exact boundary reading must make expiry current. */
    const expired = await ledger.verify(request);
    invariant(!expired.allowed && expired.refusal.reason === 'grant-expired', 'Expiry ignored trusted clock boundary');
  } finally {
    await ledger.close();
  }
}

/**
 * Proves valid attenuation and rejected amplification with no partial child fact.
 * @param target - Candidate implementation under test.
 */
async function attenuationCase(target: AuthorityConformanceTarget): Promise<void> {
  /** Parent remains current for all child issuance and verification steps. */
  const clock: FixtureClock = { current: new Date('2026-08-23T18:30:00.000Z') };
  /** Parent permits one narrower descendant until a fixed outer expiry. */
  const ledger = openFixture(target, clock, [
    fixtureRoot({ expiresAt: '2026-08-24T18:30:00.000Z', delegationDepth: 1 }),
  ]);
  try {
    /** Valid child narrows every parent constraint represented by the fixture. */
    const child = await ledger.attenuate(
      {
        grantId: fixtureChildId,
        subject: fixtureDelegatedId,
        issuedBy: fixturePrincipalId,
        scope: { kind: 'authority-conformance', pathPrefix: 'workspace/docs/' },
        expiresAt: TimestampSchema.parse('2026-08-24T12:00:00.000Z'),
        idempotencyKey: fixtureAttenuationKey,
      },
      { grantId: fixtureRootId, action: 'authority-conformance-access' },
    );
    invariant(child.kind === 'granted', 'Valid attenuation was refused');
    /** Nested child target proves the newly issued scope remains useful. */
    const allowed = await ledger.verify({
      grant: { grantId: fixtureChildId, action: 'authority-conformance-access' },
      subject: fixtureDelegatedId,
      scope: { kind: 'authority-conformance', pathPrefix: 'workspace/docs/api/' },
    });
    invariant(allowed.allowed, 'Valid attenuated child could not authorize its nested target');

    /** Cross-prefix child deliberately attempts scope amplification. */
    const amplified = await ledger.attenuate(
      {
        grantId: fixtureRefusedId,
        subject: fixtureDelegatedId,
        issuedBy: fixturePrincipalId,
        scope: { kind: 'authority-conformance', pathPrefix: 'private/' },
        idempotencyKey: fixtureRefusedAttenuationKey,
      },
      { grantId: fixtureRootId, action: 'authority-conformance-access' },
    );
    invariant(
      amplified.kind === 'refused' &&
        amplified.refusal.reason === 'attenuation-scope-amplified' &&
        amplified.refusal.authorityReason === 'scope-mismatch',
      'Scope amplification did not return its exact refusal',
    );
    /** Requested identity must remain absent after refused transition. */
    const absent = await ledger.verify({
      grant: { grantId: fixtureRefusedId, action: 'authority-conformance-access' },
      subject: fixtureDelegatedId,
      scope: { kind: 'authority-conformance', pathPrefix: 'private/' },
    });
    invariant(!absent.allowed && absent.refusal.reason === 'grant-not-found', 'Refused attenuation published a child');
  } finally {
    await ledger.close();
  }
}

/**
 * Proves parent revocation dynamically invalidates a previously usable child.
 * @param target - Candidate implementation under test.
 */
async function ancestorRevocationCase(target: AuthorityConformanceTarget): Promise<void> {
  /** Fixed time makes attenuation and revocation current in deterministic order. */
  const clock: FixtureClock = { current: new Date('2026-08-23T18:30:00.000Z') };
  /** Revocation administration is separate from the delegable protected root. */
  const ledger = openFixture(target, clock, [fixtureRoot({ delegationDepth: 1 }), fixtureRevokeAuthority()]);
  try {
    /** Valid child exists before its parent is revoked. */
    const child = await ledger.attenuate(
      {
        grantId: fixtureChildId,
        subject: fixtureDelegatedId,
        issuedBy: fixturePrincipalId,
        scope: { kind: 'authority-conformance', pathPrefix: 'workspace/docs/' },
        idempotencyKey: fixtureAttenuationKey,
      },
      { grantId: fixtureRootId, action: 'authority-conformance-access' },
    );
    invariant(child.kind === 'granted', 'Revocation case could not create its valid child');
    /** Current revocation administration appends the parent fact. */
    const revocation = await ledger.revoke(
      {
        revocationId: fixtureRevocationId,
        grant: { grantId: fixtureRootId, action: 'authority-conformance-access' },
        revokedBy: fixtureAdministratorId,
        idempotencyKey: fixtureRevocationKey,
      },
      { grantId: fixtureRevokeAuthorityId, action: 'authority-revoke' },
    );
    invariant(revocation.kind === 'revoked', 'Current revocation administration was refused');
    /** Child lookup now traverses to the current revoked ancestor. */
    const denied = await ledger.verify({
      grant: { grantId: fixtureChildId, action: 'authority-conformance-access' },
      subject: fixtureDelegatedId,
      scope: { kind: 'authority-conformance', pathPrefix: 'workspace/docs/' },
    });
    invariant(
      !denied.allowed && denied.refusal.reason === 'ancestor-revoked',
      'Revoked parent remained authoritative for its child',
    );
  } finally {
    await ledger.close();
  }
}

/**
 * Proves issuance and revocation require separate current administration grants.
 * @param target - Candidate implementation under test.
 */
async function administrationCase(target: AuthorityConformanceTarget): Promise<void> {
  /** Fixed clock keeps both installed administrative roots current. */
  const clock: FixtureClock = { current: new Date('2026-08-23T18:30:00.000Z') };
  /** Candidate exposes both actions without collapsing them into ambient administrator identity. */
  const ledger = openFixture(target, clock, [fixtureGrantAuthority(), fixtureRevokeAuthority()]);
  try {
    /** Wrong issuing Principal proves administrator identity is not ambient permission. */
    const refused = await ledger.grant(
      {
        grantId: fixtureRefusedId,
        subject: fixturePrincipalId,
        action: 'authority-conformance-access',
        scope: { kind: 'authority-conformance', pathPrefix: 'workspace/' },
        issuedBy: fixtureDelegatedId,
        idempotencyKey: fixtureGrantKey,
      },
      { grantId: fixtureGrantAuthorityId, action: 'authority-grant' },
    );
    invariant(
      refused.kind === 'refused' &&
        refused.refusal.reason === 'authority-refused' &&
        refused.refusal.authorityReason === 'subject-mismatch',
      'Administrator identity was treated as permission',
    );

    /** New key lets corrected subject reach current administrative verification. */
    const correctedKey = IdempotencyKeySchema.parse('00000000-0000-4000-8000-000000000111');
    /** Corrected subject with a new key reaches the current grant root. */
    const issued = await ledger.grant(
      {
        grantId: fixtureIssuedId,
        subject: fixturePrincipalId,
        action: 'authority-conformance-access',
        scope: { kind: 'authority-conformance', pathPrefix: 'workspace/' },
        issuedBy: fixtureAdministratorId,
        idempotencyKey: correctedKey,
      },
      { grantId: fixtureGrantAuthorityId, action: 'authority-grant' },
    );
    invariant(issued.kind === 'granted', 'Current grant-administration root could not issue a grant');

    /** Untrusted cast presents the wrong administrative action at a runtime boundary. */
    const wrongAuthority = { grantId: fixtureGrantAuthorityId, action: 'authority-revoke' as const };
    /** Wrong administrative action cannot satisfy the distinct revocation boundary. */
    const revokeRefused = await ledger.revoke(
      {
        revocationId: fixtureRevocationId,
        grant: { grantId: fixtureIssuedId, action: 'authority-conformance-access' },
        revokedBy: fixtureAdministratorId,
        idempotencyKey: fixtureRevocationKey,
      },
      wrongAuthority,
    );
    invariant(
      revokeRefused.kind === 'refused' && revokeRefused.refusal.reason === 'authority-refused',
      'Grant-administration root also acquired revocation authority',
    );
  } finally {
    await ledger.close();
  }
}

/**
 * Proves exact command replay and conflicting-key rollback through public state.
 * @param target - Candidate implementation under test.
 */
async function idempotencyCase(target: AuthorityConformanceTarget): Promise<void> {
  /** Fixed time prevents wall-clock changes from altering exact replay evidence. */
  const clock: FixtureClock = { current: new Date('2026-08-23T18:30:00.000Z') };
  /** One issuance root makes both commands reach idempotency handling. */
  const ledger = openFixture(target, clock, [fixtureGrantAuthority()]);
  /** Exact command object remains immutable at the call site. */
  const command = Object.freeze({
    grantId: fixtureIssuedId,
    subject: fixturePrincipalId,
    action: 'authority-conformance-access' as const,
    scope: Object.freeze({ kind: 'authority-conformance' as const, pathPrefix: 'workspace/' }),
    issuedBy: fixtureAdministratorId,
    idempotencyKey: fixtureGrantKey,
  });
  try {
    /** First execution publishes exactly one immutable grant fact. */
    const first = await ledger.grant(command, { grantId: fixtureGrantAuthorityId, action: 'authority-grant' });
    /** Exact replay must return the retained grant identity. */
    const replay = await ledger.grant(command, { grantId: fixtureGrantAuthorityId, action: 'authority-grant' });
    invariant(first.kind === 'granted' && !first.replayed, 'First idempotent command did not create one grant');
    invariant(replay.kind === 'granted' && replay.replayed, 'Exact idempotent replay did not return retained grant');
    invariant(
      first.kind === 'granted' && replay.kind === 'granted' && first.grant === replay.grant,
      'Exact replay changed immutable grant identity',
    );

    /** Conflicting replay changes the requested identity under the same key. */
    const conflict = await ledger.grant(
      { ...command, grantId: fixtureRefusedId },
      { grantId: fixtureGrantAuthorityId, action: 'authority-grant' },
    );
    invariant(
      conflict.kind === 'refused' && conflict.refusal.reason === 'idempotency-conflict',
      'Conflicting idempotency key reuse did not fail exactly',
    );
    /** Conflicting requested identity must not exist after refusal. */
    const absent = await ledger.verify({
      grant: { grantId: fixtureRefusedId, action: 'authority-conformance-access' },
      subject: fixturePrincipalId,
      scope: { kind: 'authority-conformance', pathPrefix: 'workspace/' },
    });
    invariant(!absent.allowed && absent.refusal.reason === 'grant-not-found', 'Idempotency conflict published a grant');
  } finally {
    await ledger.close();
  }
}

/**
 * Proves retained closure identity and post-close refusal without revocation claims.
 * @param target - Candidate implementation under test.
 */
async function lifecycleCase(target: AuthorityConformanceTarget): Promise<void> {
  /** Fixed clock pins both close evidence and the post-close refusal. */
  const clock: FixtureClock = { current: new Date('2026-08-23T18:30:00.000Z') };
  /** Previously valid root distinguishes closure from ordinary missing authority. */
  const ledger = openFixture(target, clock, [fixtureRoot()]);
  /** First call initiates the retained close settlement. */
  const first = ledger.close();
  /** Repeated call must select the exact same retained Promise. */
  const repeated = ledger.close();
  invariant(first === ledger.closed && repeated === ledger.closed, 'Close did not return one shared settlement');
  /** Fulfilled close evidence remains lifecycle data rather than authorization state. */
  const evidence = await first;
  invariant(evidence.kind === 'authority-broker-closed', 'Close evidence posed as a grant revocation');
  /** Post-close request proves the attachment stopped accepting checks. */
  const denied = await ledger.verify({
    grant: { grantId: fixtureRootId, action: 'authority-conformance-access' },
    subject: fixturePrincipalId,
    scope: { kind: 'authority-conformance', pathPrefix: 'workspace/' },
  });
  invariant(!denied.allowed && denied.refusal.reason === 'ledger-closed', 'Closed broker admitted a later check');
}

/** Executable case functions keyed by the immutable public catalogue. */
const executableCases: Readonly<
  Record<AuthorityConformanceCaseId, (target: AuthorityConformanceTarget) => Promise<void>>
> = Object.freeze({
  'reference.lookup-is-not-authority': lookupCase,
  'verification.subject-action-scope': exactBoundaryCase,
  'verification.trusted-clock-expiry': trustedClockCase,
  'attenuation.no-amplification': attenuationCase,
  'revocation.ancestor-invalidates-child': ancestorRevocationCase,
  'administration.current-grant-required': administrationCase,
  'commands.idempotency-preserves-state': idempotencyCase,
  'lifecycle.close-is-not-revocation': lifecycleCase,
});

/**
 * Selects only successful required case outcomes for complete-report status.
 * @param result - One executed required Authority case result.
 * @returns Whether that exact required case passed.
 */
function authorityCasePassed(result: AuthorityConformanceCaseResult): boolean {
  return result.status === 'passed';
}

/**
 * Supplies report time only when a conformance caller does not inject a clock.
 * @returns Fresh host Date captured after every required case executes.
 */
function systemConformanceClock(): Date {
  return new Date();
}

/**
 * Runs the published Authority catalogue and retains every result.
 * @param options - Candidate target plus implementation and evidence identity.
 * @returns Frozen report containing every required result in catalogue order.
 */
export async function runAuthorityConformance(
  options: RunAuthorityConformanceOptions,
): Promise<AuthorityConformanceReport> {
  /** Copies implementation identity before any asynchronous evidence work. */
  const implementation = Object.freeze({
    name: options.implementation.name,
    version: options.implementation.version,
    configuration: JsonObjectSchema.parse(options.implementation.configuration),
  });
  /** Copies environment evidence independently from caller mutation. */
  const environment = normalizeConformanceEnvironment(options.environment);
  /** Binds the report to exact immutable implementation configuration. */
  const configurationDigest = await digestConformanceValue(implementation.configuration);
  /** Retains the required identities independently of executable results. */
  const requiredCases = Object.freeze(AUTHORITY_CONFORMANCE_CASES.map((testCase) => testCase.id));
  /** Retains every required outcome without short-circuiting later cases on failure. */
  const results: AuthorityConformanceCaseResult[] = [];
  /** Executes each immutable required case exactly once. */
  for (const testCase of AUTHORITY_CONFORMANCE_CASES) {
    try {
      await executableCases[testCase.id](options.target);
      results.push(Object.freeze({ id: testCase.id, status: 'passed' }));
    } catch (error) {
      results.push(
        Object.freeze({
          id: testCase.id,
          status: 'failed',
          failure: toPublicError(error, {
            code: 'authority_conformance_case_failed',
            message: `Required Authority conformance case failed: ${testCase.id}`,
          }),
        }),
      );
    }
  }
  /** Freezes complete case order before evidence hashing. */
  const cases: readonly AuthorityConformanceCaseResult[] = Object.freeze(results);
  /** Exact accounting prevents an unexecuted case from posing as passing evidence. */
  const execution = conformanceExecution(requiredCases.length, cases.length);
  /** Passing requires every required executable case to report success. */
  const status = execution.skipped === 0 && cases.every(authorityCasePassed) ? 'passed' : 'failed';
  /** Report time is read after the complete result set exists. */
  const at = conformanceTimestamp(options.now ?? systemConformanceClock);
  /** Complete digest body excludes only its self-referential evidence hash. */
  const evidenceBody = Object.freeze({
    schema: 1 as const,
    protocol: '@archer/core/authority' as const,
    suiteVersion: AUTHORITY_CONFORMANCE_VERSION,
    implementation,
    configurationDigest,
    at,
    environment,
    execution,
    requiredCases,
    status,
    cases,
  });
  /** Content digest makes later report mutation detectable. */
  const evidenceDigest = await digestConformanceValue(evidenceBody);
  return Object.freeze({ ...evidenceBody, evidenceDigest });
}

/**
 * Promotes only a complete passing Authority report into reusable evidence.
 * @param report - Report returned by the matching suite version.
 * @returns Passing evidence or focused Error naming failed or missing cases.
 */
export async function requirePassingAuthorityConformance(
  report: AuthorityConformanceReport,
): Promise<ResultValue<PassingAuthorityConformance, AuthorityConformanceError>> {
  /** Retains the exact catalogue independently of untrusted report fields. */
  const required = AUTHORITY_CONFORMANCE_CASES.map((testCase) => testCase.id);
  /** Shape admission precedes asynchronous digest comparison. */
  const admitted = AuthorityConformanceReportSchema.safeParse(report);
  if (!admitted.success) return Result.error(new AuthorityConformanceError(required));
  /** Candidate is deeply immutable after schema admission. */
  const candidate = admitted.data;
  /** Catalogue identity prevents a smaller suite from claiming this version. */
  const catalogueMatches =
    candidate.requiredCases.length === required.length &&
    candidate.requiredCases.every((id, index) => id === required[index]);
  /** Every required case must appear once in order and pass. */
  const resultsComplete =
    candidate.cases.length === required.length &&
    candidate.cases.every((testCase, index) => testCase.id === required[index] && testCase.status === 'passed');
  /** Execution counts and protocol identity must agree with the immutable catalogue. */
  const metadataValid =
    candidate.protocol === '@archer/core/authority' &&
    candidate.suiteVersion === AUTHORITY_CONFORMANCE_VERSION &&
    candidate.execution.required === required.length &&
    candidate.execution.executed === required.length &&
    candidate.execution.skipped === 0;
  /** Removes the self-referential digest before recomputing report integrity. */
  const { evidenceDigest: claimedEvidenceDigest, ...evidenceBody } = candidate;
  /** Configuration and full evidence digests must both match their admitted values. */
  const digestsValid =
    metadataValid &&
    (await conformanceDigestsMatch({
      configuration: candidate.implementation.configuration,
      configurationDigest: candidate.configurationDigest,
      evidence: evidenceBody,
      evidenceDigest: claimedEvidenceDigest,
    }));
  if (candidate.status === 'passed' && catalogueMatches && resultsComplete && metadataValid && digestsValid) {
    return Result.ok(candidate as PassingAuthorityConformance);
  }
  /** Invalid metadata or digest fails the complete catalogue instead of guessing partial trust. */
  const failed =
    catalogueMatches && metadataValid && digestsValid
      ? required.filter((id, index) => candidate.cases[index]?.id !== id || candidate.cases[index]?.status !== 'passed')
      : required;
  return Result.error(new AuthorityConformanceError(failed));
}
