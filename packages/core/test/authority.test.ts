/**
 * @file Proves Authority grants begin as validated immutable facts rather than
 * self-authenticating bearer objects.
 */

import * as z from 'zod';
import { describe, expect, it } from 'vitest';

import { fromZod } from '../src/codec.js';
import {
  AUTHORITY_GRANT_ACTION,
  AUTHORITY_REVOKE_ACTION,
  AuthorityError,
  AuthorityLedgerIdSchema,
  AuthorizationGrantIdSchema,
  GrantRevocationIdSchema,
  PrincipalIdSchema,
  PrincipalSchema,
  createBootstrapAuthorizationGrant,
  createMemoryAuthorityLedger,
  defineAuthorityAction,
  type ProtectedAction,
  type AuthorityCheck,
  type AuthorityGrantAction,
  type AuthorityRevokeAction,
} from '../src/authority/index.js';
import { createDiagnostics, type DiagnosticRecord } from '../src/diagnostics/index.js';
import { IdempotencyKeySchema } from '../src/protocol.js';
import { TimestampSchema } from '../src/values.js';

/** Representative downstream scope with an exact tenant-owned target. */
type DocumentReadScope = Readonly<{
  /** Keeps this test scope distinguishable from future Authority-owned scopes. */
  kind: 'document-read';

  /** Names the application document being protected. */
  documentId: string;
}>;

/** Couples the representative action literal to its owned scope. */
type DocumentReadAction = ProtectedAction<'document-read', DocumentReadScope>;

/** Representative hierarchical scope whose containment gives attenuation real work. */
type DocumentTreeScope = Readonly<{
  /** Keeps hierarchical document access separate from exact reads. */
  kind: 'document-tree';

  /** Names a normalized fixture prefix ending in a slash. */
  pathPrefix: string;
}>;

/** Couples hierarchical read authority to its narrowing scope. */
type DocumentTreeAction = ProtectedAction<'document-tree-read', DocumentTreeScope>;

/** Representative scope whose owner deliberately violates its policy contract. */
type BrokenPolicyScope = Readonly<{
  /** Distinguishes the broken-policy fixture from valid application scopes. */
  kind: 'broken-policy';
}>;

/** Couples one protected action to the deliberately broken policy fixture. */
type BrokenPolicyAction = ProtectedAction<'broken-policy', BrokenPolicyScope>;

/** Runtime admission that copies and freezes the downstream scope fixture. */
const DocumentReadScopeSchema = z
  .strictObject({ kind: z.literal('document-read'), documentId: z.string().min(1) })
  .transform((value) => Object.freeze(value) as DocumentReadScope)
  .readonly();

/** Runtime admission rejects prefixes that cannot express a directory boundary. */
const DocumentTreeScopeSchema = z
  .strictObject({ kind: z.literal('document-tree'), pathPrefix: z.string().min(1).endsWith('/') })
  .transform((value) => Object.freeze(value) as DocumentTreeScope)
  .readonly();

/** Runtime admission remains valid so only policy evaluation fails under test. */
const BrokenPolicyScopeSchema = z
  .strictObject({ kind: z.literal('broken-policy') })
  .transform((value) => Object.freeze(value) as BrokenPolicyScope)
  .readonly();

/** Downstream definition registers exact scope semantics without global mutation. */
const DOCUMENT_READ_ACTION = defineAuthorityAction<DocumentReadAction>({
  action: 'document-read',
  scope: fromZod(DocumentReadScopeSchema),
  /**
   * Requires the grant and request to name the same document.
   * @param granted - Exact document scope retained by the grant.
   * @param requested - Exact document target under test.
   * @returns Whether both scopes name the same document.
   */
  allows: (granted, requested) => granted.documentId === requested.documentId,
});

/** Hierarchical definition permits only equal or nested requested prefixes. */
const DOCUMENT_TREE_ACTION = defineAuthorityAction<DocumentTreeAction>({
  action: 'document-tree-read',
  scope: fromZod(DocumentTreeScopeSchema),
  /**
   * Slash-terminated prefixes make ordinary prefix comparison segment-safe here.
   * @param granted - Stored document-tree prefix.
   * @param requested - Current document-tree target.
   * @returns Whether the stored prefix contains the requested target.
   */
  allows: (granted, requested) => requested.pathPrefix.startsWith(granted.pathPrefix),
});

/** Deliberately broken definition proves policy exceptions are not disguised as denials. */
const BROKEN_POLICY_ACTION = defineAuthorityAction<BrokenPolicyAction>({
  action: 'broken-policy',
  scope: fromZod(BrokenPolicyScopeSchema),
  /** Throws the implementation defect that the broker must preserve as rejection. */
  allows: () => {
    throw new Error('private policy failure detail');
  },
});

/** Stable ledger identity used by the production bootstrap path. */
const ledgerId = AuthorityLedgerIdSchema.parse('00000000-0000-4000-8000-000000000001');

/** Stable grant identity used by the production bootstrap path. */
const grantId = AuthorizationGrantIdSchema.parse('00000000-0000-4000-8000-000000000002');

/** Stable Principal identity used by the production bootstrap path. */
const principalId = PrincipalIdSchema.parse('00000000-0000-4000-8000-000000000003');

/** Stable administrative issuer identity distinct from the protected subject. */
const administratorId = PrincipalIdSchema.parse('00000000-0000-4000-8000-000000000004');

/** Stable root identity for administrative grant issuance. */
const grantAuthorityId = AuthorizationGrantIdSchema.parse('00000000-0000-4000-8000-000000000005');

/** Stable root identity for administrative revocation. */
const revokeAuthorityId = AuthorizationGrantIdSchema.parse('00000000-0000-4000-8000-000000000006');

/** Stable command identity proving exact grant issuance replay. */
const grantCommandKey = IdempotencyKeySchema.parse('00000000-0000-4000-8000-000000000007');

/** Stable identity for a grant issued through the retained ledger port. */
const issuedGrantId = AuthorizationGrantIdSchema.parse('00000000-0000-4000-8000-000000000008');

/** Stable Principal receiving a properly attenuated descendant grant. */
const delegatedPrincipalId = PrincipalIdSchema.parse('00000000-0000-4000-8000-000000000009');

/** Stable child identity produced by an attenuation command. */
const attenuatedGrantId = AuthorizationGrantIdSchema.parse('00000000-0000-4000-8000-00000000000a');

/** Stable command identity proving attenuation replay and conflict handling. */
const attenuationCommandKey = IdempotencyKeySchema.parse('00000000-0000-4000-8000-00000000000b');

/** Stable revocation fact identity supplied before durable settlement. */
const revocationId = GrantRevocationIdSchema.parse('00000000-0000-4000-8000-00000000000c');

/** Stable command identity proving exact revocation replay. */
const revocationCommandKey = IdempotencyKeySchema.parse('00000000-0000-4000-8000-00000000000d');

/** Stable issuance instant admitted through Archer's production timestamp codec. */
const createdAt = TimestampSchema.parse('2026-08-23T18:00:00.000Z');

/**
 * Supplies the stable successful Authority boundary instant used by most cases.
 * @returns Fresh Date so no implementation can mutate shared fixture state.
 */
function fixedAuthorityClock(): Date {
  return new Date('2026-08-23T18:30:00.000Z');
}

/**
 * Supplies a deterministic monotonic boundary for zero-duration fixture spans.
 * @returns Stable process-local monotonic reading.
 */
function fixedMonotonicClock(): number {
  return 20;
}

/**
 * Creates deterministic distinct span identities for a sequential operation case.
 * @returns Closure producing the next valid UUIDv4 fixture.
 */
function sequentialSpanIdFactory(): () => string {
  /** Numeric suffix advances only process-local observation identity. */
  let suffix = 20;
  /**
   * Produces the next deterministic UUIDv4 text fixture.
   * @returns Valid UUIDv4 string with a monotonically increasing suffix.
   */
  return function nextSpanId(): string {
    return `00000000-0000-4000-8000-${String(suffix++).padStart(12, '0')}`;
  };
}

/**
 * Projects one diagnostic record into its stable operation name.
 * @param record - Terminal Authority diagnostic record.
 * @returns Stable record name in source order.
 */
function diagnosticName(record: DiagnosticRecord): string {
  return record.name;
}

/**
 * Projects a terminal span settlement into its bounded outcome.
 * @param record - Authority diagnostic record emitted by the real hub.
 * @returns Completed or failed outcome, or absence for a non-terminal shape.
 */
function diagnosticOutcome(record: DiagnosticRecord): string | undefined {
  return record.kind === 'span' && record.settlement.kind !== 'abandoned' ? record.settlement.outcome : undefined;
}

describe('Authority grant construction', () => {
  it('admits Principal attribution through the shared Archer object envelope', () => {
    /** Principal values carry identity and creation evidence without permission fields. */
    const principal = PrincipalSchema.parse({
      id: principalId,
      object: 'principal',
      createdAt,
    });

    expect(principal).toEqual({ id: principalId, object: 'principal', createdAt });
    expect(Object.isFrozen(principal)).toBe(true);
    expect(() => PrincipalSchema.parse({ ...principal, role: 'administrator' })).toThrow();
  });

  it('creates an immutable action-bound bootstrap grant through its scope codec', () => {
    /** Caller-owned input is mutated after construction to expose scope aliasing. */
    const scope = { kind: 'document-read' as const, documentId: 'document-1' };
    /** Trusted construction still routes the root through public UUID and scope admission. */
    const grant = createBootstrapAuthorizationGrant<DocumentReadAction>(DOCUMENT_READ_ACTION, {
      id: grantId,
      ledgerId,
      subject: principalId,
      scope,
      issuedBy: principalId,
      createdAt,
      delegationDepth: 2,
    });

    scope.documentId = 'mutated-after-construction';

    expect(grant).toEqual({
      id: grantId,
      object: 'authorization-grant',
      createdAt: '2026-08-23T18:00:00.000Z',
      ledgerId,
      action: 'document-read',
      subject: principalId,
      scope: { kind: 'document-read', documentId: 'document-1' },
      issuedBy: principalId,
      validFrom: '2026-08-23T18:00:00.000Z',
      delegationDepth: 2,
      origin: { kind: 'bootstrap' },
    });
    expect(Object.isFrozen(grant)).toBe(true);
    expect(Object.isFrozen(grant.scope)).toBe(true);
  });
});

describe('Authority diagnostics', () => {
  it('emits one terminal wide verification span without making diagnostics authoritative', async () => {
    /** Supplies exact diagnostic wall instants independently of the Authority clock. */
    const diagnosticInstants = [new Date('2026-08-23T18:29:59.900Z'), new Date('2026-08-23T18:30:00.000Z')];
    /**
     * Returns controlled diagnostic wall time without consulting the host clock.
     * @returns Next deterministic start or settlement instant.
     */
    const diagnosticNow = () => diagnosticInstants.shift() ?? new Date('2026-08-23T18:30:00.000Z');
    /** Supplies exact monotonic span boundaries for deterministic duration evidence. */
    const monotonicInstants = [10, 14];
    /**
     * Returns controlled monotonic time without introducing scheduler delays.
     * @returns Next deterministic elapsed-time reading.
     */
    const monotonicNow = () => monotonicInstants.shift() ?? 14;
    /** Real diagnostics integration proves Authority uses the canonical span contract. */
    const diagnostics = createDiagnostics({
      now: diagnosticNow,
      monotonicNow,
      /**
       * Returns one stable process-local span identity for this single-operation fixture.
       * @returns Valid UUIDv4 span identity.
       */
      createSpanId: () => '00000000-0000-4000-8000-000000000014',
    });
    /** Attaches before work so the terminal span cannot race past the assertion queue. */
    const observations = diagnostics.events.subscribe({ capacityItems: 2 });
    /** Exact root gives verification a successful current decision to observe. */
    const root = createBootstrapAuthorizationGrant<DocumentReadAction>(DOCUMENT_READ_ACTION, {
      id: grantId,
      ledgerId,
      subject: principalId,
      scope: { kind: 'document-read', documentId: 'document-1' },
      issuedBy: administratorId,
      createdAt,
    });
    /** Authority owns only the narrow span-production capability, not diagnostics lifecycle. */
    const ledger = createMemoryAuthorityLedger<DocumentReadAction>({
      ledgerId,
      actions: [DOCUMENT_READ_ACTION],
      bootstrap: [root],
      now: fixedAuthorityClock,
      diagnostics,
    });

    expect(
      await ledger.verify({
        grant: { grantId, action: 'document-read' },
        subject: principalId,
        scope: { kind: 'document-read', documentId: 'document-1' },
      }),
    ).toMatchObject({ allowed: true });

    /** Reads the one buffered terminal record through the public transient stream. */
    const observation = await observations[Symbol.asyncIterator]().next();
    expect(observation).toMatchObject({
      done: false,
      value: {
        kind: 'event',
        value: {
          kind: 'span',
          name: 'authority.verify',
          component: 'core.authority',
          durationMs: 4,
          settlement: { kind: 'completed', outcome: 'allowed' },
          correlation: { authorityLedgerId: ledgerId, authorizationGrantId: grantId },
          attributes: {
            authority: { action: 'document-read' },
            'authority.result': { allowed: true, chainDepth: 1 },
          },
        },
      },
    });

    /** Closing diagnostics first must not revoke or otherwise control domain authority. */
    await observations.close();
    await diagnostics.close();
    expect(
      await ledger.verify({
        grant: { grantId, action: 'document-read' },
        subject: principalId,
        scope: { kind: 'document-read', documentId: 'document-1' },
      }),
    ).toMatchObject({ allowed: true });
    await ledger.close();
  });

  it('settles grant-state commands and ledger closure as wide operation spans', async () => {
    /** Constant clocks make diagnostics deterministic without depending on elapsed host time. */
    const diagnostics = createDiagnostics({
      now: fixedAuthorityClock,
      monotonicNow: fixedMonotonicClock,
      createSpanId: sequentialSpanIdFactory(),
    });
    /** Buffers terminal records until the deterministic operation sequence completes. */
    const observations = diagnostics.events.subscribe({ capacityItems: 8 });
    /** Delegable root exercises same-action attenuation in the command sequence. */
    const parent = createBootstrapAuthorizationGrant<DocumentTreeAction>(DOCUMENT_TREE_ACTION, {
      id: grantId,
      ledgerId,
      subject: principalId,
      scope: { kind: 'document-tree', pathPrefix: 'docs/' },
      issuedBy: administratorId,
      createdAt,
      delegationDepth: 1,
    });
    /** Grant administration remains a separate explicit root. */
    const grantAuthority = createBootstrapAuthorizationGrant<AuthorityGrantAction>(AUTHORITY_GRANT_ACTION, {
      id: grantAuthorityId,
      ledgerId,
      subject: administratorId,
      scope: { kind: 'authority-administration', ledgerId },
      issuedBy: administratorId,
      createdAt,
    });
    /** Revocation administration remains a separate explicit root. */
    const revokeAuthority = createBootstrapAuthorizationGrant<AuthorityRevokeAction>(AUTHORITY_REVOKE_ACTION, {
      id: revokeAuthorityId,
      ledgerId,
      subject: administratorId,
      scope: { kind: 'authority-administration', ledgerId },
      issuedBy: administratorId,
      createdAt,
    });
    /** One ledger composes downstream actions with the borrowed diagnostics capability. */
    const ledger = createMemoryAuthorityLedger<DocumentReadAction | DocumentTreeAction>({
      ledgerId,
      actions: [DOCUMENT_READ_ACTION, DOCUMENT_TREE_ACTION],
      bootstrap: [parent, grantAuthority, revokeAuthority],
      now: fixedAuthorityClock,
      diagnostics,
    });

    await ledger.grant(
      {
        grantId: issuedGrantId,
        subject: principalId,
        action: 'document-read',
        scope: { kind: 'document-read', documentId: 'document-secret' },
        issuedBy: administratorId,
        idempotencyKey: grantCommandKey,
      },
      { grantId: grantAuthorityId, action: 'authority-grant' },
    );
    await ledger.attenuate(
      {
        grantId: attenuatedGrantId,
        subject: delegatedPrincipalId,
        issuedBy: principalId,
        scope: { kind: 'document-tree', pathPrefix: 'docs/private/' },
        idempotencyKey: attenuationCommandKey,
      },
      { grantId, action: 'document-tree-read' },
    );
    await ledger.revoke(
      {
        revocationId,
        grant: { grantId: issuedGrantId, action: 'document-read' },
        revokedBy: administratorId,
        idempotencyKey: revocationCommandKey,
      },
      { grantId: revokeAuthorityId, action: 'authority-revoke' },
    );
    await ledger.close();
    await diagnostics.close();

    /** Drains already-accepted records after source completion without scheduler timing. */
    const records: DiagnosticRecord[] = [];
    /** Reads each accepted terminal record until deterministic source completion. */
    for await (const delivery of observations) {
      if (delivery.kind === 'event') records.push(delivery.value);
    }
    expect(records.map(diagnosticName)).toEqual([
      'authority.grant',
      'authority.attenuate',
      'authority.revoke',
      'authority.close',
    ]);
    expect(records.map(diagnosticOutcome)).toEqual(['granted', 'granted', 'revoked', 'closed']);
    /** Protected scope values do not enter generic operational observations. */
    expect(JSON.stringify(records)).not.toContain('document-secret');
    expect(JSON.stringify(records)).not.toContain('docs/private/');
  });
});

describe('memory Authority verification', () => {
  it('admits an exact subject, action, and scope from a registered bootstrap grant', async () => {
    /** Trusted clock is fixed so verification evidence does not depend on wall time. */
    const now = new Date('2026-08-23T18:30:00.000Z');
    /** Root enters through the same validated construction path used above. */
    const root = createBootstrapAuthorizationGrant<DocumentReadAction>(DOCUMENT_READ_ACTION, {
      id: grantId,
      ledgerId,
      subject: principalId,
      scope: { kind: 'document-read', documentId: 'document-1' },
      issuedBy: principalId,
      createdAt,
      delegationDepth: 2,
    });
    /** Reference implementation receives explicit action ownership and trust roots. */
    const ledger = createMemoryAuthorityLedger<DocumentReadAction>({
      ledgerId,
      actions: [DOCUMENT_READ_ACTION],
      bootstrap: [root],
      /**
       * Copies mutable fixture time so the broker owns each received Date.
       * @returns Current deterministic verification instant.
       */
      now: () => new Date(now),
    });

    /** Exact current check produces the complete expected verification evidence. */
    const decision = await ledger.verify({
      grant: { grantId, action: 'document-read' },
      subject: principalId,
      scope: { kind: 'document-read', documentId: 'document-1' },
    });

    expect(decision).toEqual({
      allowed: true,
      verification: {
        grant: { grantId, action: 'document-read' },
        subject: principalId,
        scope: { kind: 'document-read', documentId: 'document-1' },
        checkedAt: '2026-08-23T18:30:00.000Z',
        chain: [grantId],
      },
    });
    await ledger.close();
  });

  it('attenuates subject, scope, expiry, and remaining delegation without amplifying its parent', async () => {
    /** Parent is current, delegable twice, and bounded to the complete docs tree. */
    const parent = createBootstrapAuthorizationGrant<DocumentTreeAction>(DOCUMENT_TREE_ACTION, {
      id: grantId,
      ledgerId,
      subject: principalId,
      scope: { kind: 'document-tree', pathPrefix: 'docs/' },
      issuedBy: administratorId,
      createdAt,
      expiresAt: TimestampSchema.parse('2026-08-24T18:00:00.000Z'),
      delegationDepth: 2,
    });
    /** Trusted current time falls inside both parent and requested child windows. */
    const ledger = createMemoryAuthorityLedger<DocumentTreeAction>({
      ledgerId,
      actions: [DOCUMENT_TREE_ACTION],
      bootstrap: [parent],
      now: fixedAuthorityClock,
    });

    /** Valid attenuation should publish one narrowed child fact. */
    const outcome = await ledger.attenuate(
      {
        grantId: attenuatedGrantId,
        subject: delegatedPrincipalId,
        issuedBy: principalId,
        scope: { kind: 'document-tree', pathPrefix: 'docs/api/' },
        expiresAt: TimestampSchema.parse('2026-08-24T12:00:00.000Z'),
        delegationDepth: 1,
        idempotencyKey: attenuationCommandKey,
      },
      { grantId, action: 'document-tree-read' },
    );

    expect(outcome).toEqual({
      kind: 'granted',
      grant: {
        id: attenuatedGrantId,
        object: 'authorization-grant',
        createdAt: '2026-08-23T18:30:00.000Z',
        ledgerId,
        action: 'document-tree-read',
        subject: delegatedPrincipalId,
        scope: { kind: 'document-tree', pathPrefix: 'docs/api/' },
        issuedBy: principalId,
        validFrom: '2026-08-23T18:30:00.000Z',
        expiresAt: '2026-08-24T12:00:00.000Z',
        delegationDepth: 1,
        origin: {
          kind: 'attenuation',
          parent: { grantId, action: 'document-tree-read' },
        },
      },
      replayed: false,
    });

    expect(
      await ledger.verify({
        grant: { grantId: attenuatedGrantId, action: 'document-tree-read' },
        subject: delegatedPrincipalId,
        scope: { kind: 'document-tree', pathPrefix: 'docs/api/reference/' },
      }),
    ).toMatchObject({ allowed: true });
    await ledger.close();
  });

  it('issues a grant only after current ledger-administration verification', async () => {
    /** Administrative roots are explicit construction inputs, never ambient superuser state. */
    const grantAuthority = createBootstrapAuthorizationGrant<AuthorityGrantAction>(AUTHORITY_GRANT_ACTION, {
      id: grantAuthorityId,
      ledgerId,
      subject: administratorId,
      scope: { kind: 'authority-administration', ledgerId },
      issuedBy: administratorId,
      createdAt,
    });
    /** Revocation root is installed separately because grant and revoke are distinct actions. */
    const revokeAuthority = createBootstrapAuthorizationGrant<AuthorityRevokeAction>(AUTHORITY_REVOKE_ACTION, {
      id: revokeAuthorityId,
      ledgerId,
      subject: administratorId,
      scope: { kind: 'authority-administration', ledgerId },
      issuedBy: administratorId,
      createdAt,
    });
    /** Trusted issuance time fixes the record independently of caller input. */
    const ledger = createMemoryAuthorityLedger<DocumentReadAction>({
      ledgerId,
      actions: [DOCUMENT_READ_ACTION],
      bootstrap: [grantAuthority, revokeAuthority],
      now: fixedAuthorityClock,
    });

    /** Current grant administration should publish one independent grant fact. */
    const outcome = await ledger.grant(
      {
        grantId: issuedGrantId,
        subject: principalId,
        action: 'document-read',
        scope: { kind: 'document-read', documentId: 'document-2' },
        issuedBy: administratorId,
        delegationDepth: 1,
        idempotencyKey: grantCommandKey,
      },
      { grantId: grantAuthorityId, action: 'authority-grant' },
    );

    expect(outcome).toEqual({
      kind: 'granted',
      grant: {
        id: issuedGrantId,
        object: 'authorization-grant',
        createdAt: '2026-08-23T18:30:00.000Z',
        ledgerId,
        action: 'document-read',
        subject: principalId,
        scope: { kind: 'document-read', documentId: 'document-2' },
        issuedBy: administratorId,
        validFrom: '2026-08-23T18:30:00.000Z',
        delegationDepth: 1,
        origin: {
          kind: 'authority-grant',
          authority: { grantId: grantAuthorityId, action: 'authority-grant' },
        },
      },
      replayed: false,
    });

    expect(
      await ledger.verify({
        grant: { grantId: issuedGrantId, action: 'document-read' },
        subject: principalId,
        scope: { kind: 'document-read', documentId: 'document-2' },
      }),
    ).toMatchObject({ allowed: true });
    await ledger.close();
  });

  it('revokes an attenuated parent and immediately refuses its child lineage', async () => {
    /** Parent root permits one child and remains the child's current authority. */
    const parent = createBootstrapAuthorizationGrant<DocumentTreeAction>(DOCUMENT_TREE_ACTION, {
      id: grantId,
      ledgerId,
      subject: principalId,
      scope: { kind: 'document-tree', pathPrefix: 'docs/' },
      issuedBy: administratorId,
      createdAt,
      delegationDepth: 1,
    });
    /** Separate administrative root authorizes only revocation on this ledger. */
    const revokeAuthority = createBootstrapAuthorizationGrant<AuthorityRevokeAction>(AUTHORITY_REVOKE_ACTION, {
      id: revokeAuthorityId,
      ledgerId,
      subject: administratorId,
      scope: { kind: 'authority-administration', ledgerId },
      issuedBy: administratorId,
      createdAt,
    });
    /** Fixed clock makes child issuance, revocation, and later refusal exact. */
    const ledger = createMemoryAuthorityLedger<DocumentTreeAction>({
      ledgerId,
      actions: [DOCUMENT_TREE_ACTION],
      bootstrap: [parent, revokeAuthority],
      now: fixedAuthorityClock,
    });
    /** Child is earned through the public transition rather than hydrated by the fixture. */
    const child = await ledger.attenuate(
      {
        grantId: attenuatedGrantId,
        subject: delegatedPrincipalId,
        issuedBy: principalId,
        scope: { kind: 'document-tree', pathPrefix: 'docs/api/' },
        idempotencyKey: attenuationCommandKey,
      },
      { grantId, action: 'document-tree-read' },
    );
    expect(child).toMatchObject({ kind: 'granted' });

    /** Independent fact identity lets invalid prose fail before the valid revocation. */
    const invalidReasonRevocationId = GrantRevocationIdSchema.parse('00000000-0000-4000-8000-000000000015');
    /** Independent command identity prevents invalid prose from claiming the later valid receipt. */
    const invalidReasonKey = IdempotencyKeySchema.parse('00000000-0000-4000-8000-000000000016');
    expect(
      await ledger.revoke(
        {
          revocationId: invalidReasonRevocationId,
          grant: { grantId, action: 'document-tree-read' },
          revokedBy: administratorId,
          reason: '',
          idempotencyKey: invalidReasonKey,
        },
        { grantId: revokeAuthorityId, action: 'authority-revoke' },
      ),
    ).toEqual({ kind: 'refused', refusal: { reason: 'revocation-reason-invalid' } });
    /** Refused prose validation must preserve the child's current authority. */
    expect(
      await ledger.verify({
        grant: { grantId: attenuatedGrantId, action: 'document-tree-read' },
        subject: delegatedPrincipalId,
        scope: { kind: 'document-tree', pathPrefix: 'docs/api/' },
      }),
    ).toMatchObject({ allowed: true });

    /** Current revocation administration should append one immutable fact. */
    const outcome = await ledger.revoke(
      {
        revocationId,
        grant: { grantId, action: 'document-tree-read' },
        revokedBy: administratorId,
        reason: 'parent access retired',
        idempotencyKey: revocationCommandKey,
      },
      { grantId: revokeAuthorityId, action: 'authority-revoke' },
    );

    expect(outcome).toEqual({
      kind: 'revoked',
      revocation: {
        id: revocationId,
        object: 'grant-revocation',
        createdAt: '2026-08-23T18:30:00.000Z',
        ledgerId,
        grant: { grantId, action: 'document-tree-read' },
        revokedBy: administratorId,
        reason: 'parent access retired',
      },
      replayed: false,
    });

    expect(
      await ledger.verify({
        grant: { grantId: attenuatedGrantId, action: 'document-tree-read' },
        subject: delegatedPrincipalId,
        scope: { kind: 'document-tree', pathPrefix: 'docs/api/' },
      }),
    ).toMatchObject({ allowed: false, refusal: { reason: 'ancestor-revoked' } });
    await ledger.close();
  });

  it('refuses missing, wrong-subject, wrong-action, and cross-target references exactly', async () => {
    /** Exact root is the only production-reachable grant in this ledger. */
    const root = createBootstrapAuthorizationGrant<DocumentReadAction>(DOCUMENT_READ_ACTION, {
      id: grantId,
      ledgerId,
      subject: principalId,
      scope: { kind: 'document-read', documentId: 'document-1' },
      issuedBy: administratorId,
      createdAt,
    });
    /** Both definitions are registered so a forged action reaches stored-action comparison. */
    const ledger = createMemoryAuthorityLedger<DocumentReadAction | DocumentTreeAction>({
      ledgerId,
      actions: [DOCUMENT_READ_ACTION, DOCUMENT_TREE_ACTION],
      bootstrap: [root],
      now: fixedAuthorityClock,
    });
    /** Unknown UUID differs from the real root in exactly one relevant condition. */
    const missingGrantId = AuthorizationGrantIdSchema.parse('00000000-0000-4000-8000-00000000000e');

    expect(
      await ledger.verify({
        grant: { grantId: missingGrantId, action: 'document-read' },
        subject: principalId,
        scope: { kind: 'document-read', documentId: 'document-1' },
      }),
    ).toMatchObject({ allowed: false, refusal: { reason: 'grant-not-found' } });
    expect(
      await ledger.verify({
        grant: { grantId, action: 'document-read' },
        subject: delegatedPrincipalId,
        scope: { kind: 'document-read', documentId: 'document-1' },
      }),
    ).toMatchObject({ allowed: false, refusal: { reason: 'subject-mismatch' } });
    expect(
      await ledger.verify({
        grant: { grantId, action: 'document-read' },
        subject: principalId,
        scope: { kind: 'document-read', documentId: 'document-2' },
      }),
    ).toMatchObject({ allowed: false, refusal: { reason: 'scope-mismatch' } });

    /** Cast models hostile deserialization because ordinary TypeScript rejects this mismatched scope category. */
    const forged = {
      grant: { grantId, action: 'document-tree-read' },
      subject: principalId,
      scope: { kind: 'document-tree', pathPrefix: 'docs/' },
    } as unknown as AuthorityCheck<DocumentReadAction | DocumentTreeAction>;
    expect(await ledger.verify(forged)).toMatchObject({ allowed: false, refusal: { reason: 'action-mismatch' } });

    /** Every refusal leaves the original root current for its exact request. */
    expect(
      await ledger.verify({
        grant: { grantId, action: 'document-read' },
        subject: principalId,
        scope: { kind: 'document-read', documentId: 'document-1' },
      }),
    ).toMatchObject({ allowed: true });
    await ledger.close();
  });

  it('uses the broker clock for expiry instead of accepting caller-selected time', async () => {
    /** Expiring root is earned through trusted bootstrap construction. */
    const root = createBootstrapAuthorizationGrant<DocumentReadAction>(DOCUMENT_READ_ACTION, {
      id: grantId,
      ledgerId,
      subject: principalId,
      scope: { kind: 'document-read', documentId: 'document-1' },
      issuedBy: administratorId,
      createdAt,
      expiresAt: TimestampSchema.parse('2026-08-23T19:00:00.000Z'),
    });
    /** Mutable clock state is controlled by the test and never exposed in `verify`. */
    let now = new Date('2026-08-23T18:59:59.999Z');
    /** Reference broker reads a fresh copy so test mutation cannot alter a prior receipt. */
    const ledger = createMemoryAuthorityLedger<DocumentReadAction>({
      ledgerId,
      actions: [DOCUMENT_READ_ACTION],
      bootstrap: [root],
      /**
       * Copies the mutable trusted-clock fixture at each verification boundary.
       * @returns Fresh current Date selected by the test.
       */
      now: () => new Date(now),
    });
    /** Exact request has no time field a caller could backdate. */
    const request = {
      grant: { grantId, action: 'document-read' as const },
      subject: principalId,
      scope: { kind: 'document-read' as const, documentId: 'document-1' },
    };

    expect(await ledger.verify(request)).toMatchObject({ allowed: true });
    now = new Date('2026-08-23T19:00:00.000Z');
    expect(await ledger.verify(request)).toMatchObject({ allowed: false, refusal: { reason: 'grant-expired' } });
    await ledger.close();
  });

  it('rejects a broken containment policy instead of reporting an ordinary scope denial', async () => {
    /** Valid root ensures the package-owned containment callback is the reached boundary. */
    const root = createBootstrapAuthorizationGrant<BrokenPolicyAction>(BROKEN_POLICY_ACTION, {
      id: grantId,
      ledgerId,
      subject: principalId,
      scope: { kind: 'broken-policy' },
      issuedBy: administratorId,
      createdAt,
    });
    /** Fixed broker time removes every unrelated temporal failure. */
    const ledger = createMemoryAuthorityLedger<BrokenPolicyAction>({
      ledgerId,
      actions: [BROKEN_POLICY_ACTION],
      bootstrap: [root],
      now: fixedAuthorityClock,
    });

    await expect(
      ledger.verify({
        grant: { grantId, action: 'broken-policy' },
        subject: principalId,
        scope: { kind: 'broken-policy' },
      }),
    ).rejects.toEqual(
      expect.objectContaining<Partial<AuthorityError>>({
        name: 'AuthorityError',
        code: 'authority_policy_failed',
        message: 'Authority action policy evaluation failed',
      }),
    );

    /** The implementation defect changes no grant or lifecycle state. */
    expect(ledger.closed).toBeInstanceOf(Promise);
    await ledger.close();
  });

  it('refuses scope and lifetime amplification without publishing the requested child', async () => {
    /** Parent grants one delegable level within docs and one bounded day. */
    const parent = createBootstrapAuthorizationGrant<DocumentTreeAction>(DOCUMENT_TREE_ACTION, {
      id: grantId,
      ledgerId,
      subject: principalId,
      scope: { kind: 'document-tree', pathPrefix: 'docs/' },
      issuedBy: administratorId,
      createdAt,
      expiresAt: TimestampSchema.parse('2026-08-24T18:00:00.000Z'),
      delegationDepth: 1,
    });
    /** Fixed time keeps every earlier parent validity guard satisfied. */
    const ledger = createMemoryAuthorityLedger<DocumentTreeAction>({
      ledgerId,
      actions: [DOCUMENT_TREE_ACTION],
      bootstrap: [parent],
      now: fixedAuthorityClock,
    });
    /** Independent IDs ensure each attempt reaches its named attenuation rule. */
    const scopeChildId = AuthorizationGrantIdSchema.parse('00000000-0000-4000-8000-00000000000f');
    /** Independent key prevents the second refusal from becoming an idempotency conflict. */
    const scopeKey = IdempotencyKeySchema.parse('00000000-0000-4000-8000-000000000010');
    /** Lifetime attempt uses its own identity so no earlier state can mask the rule. */
    const expiryChildId = AuthorizationGrantIdSchema.parse('00000000-0000-4000-8000-000000000011');
    /** Independent key binds only the lifetime-amplification attempt. */
    const expiryKey = IdempotencyKeySchema.parse('00000000-0000-4000-8000-000000000012');

    expect(
      await ledger.attenuate(
        {
          grantId: scopeChildId,
          subject: delegatedPrincipalId,
          issuedBy: principalId,
          scope: { kind: 'document-tree', pathPrefix: 'private/' },
          idempotencyKey: scopeKey,
        },
        { grantId, action: 'document-tree-read' },
      ),
    ).toEqual({
      kind: 'refused',
      refusal: { reason: 'attenuation-scope-amplified', authorityReason: 'scope-mismatch' },
    });
    expect(
      await ledger.attenuate(
        {
          grantId: expiryChildId,
          subject: delegatedPrincipalId,
          issuedBy: principalId,
          scope: { kind: 'document-tree', pathPrefix: 'docs/api/' },
          expiresAt: TimestampSchema.parse('2026-08-25T18:00:00.000Z'),
          idempotencyKey: expiryKey,
        },
        { grantId, action: 'document-tree-read' },
      ),
    ).toEqual({ kind: 'refused', refusal: { reason: 'attenuation-expiry-amplified' } });

    /** Neither refused child identity became a hidden partial fact. */
    expect(
      await ledger.verify({
        grant: { grantId: scopeChildId, action: 'document-tree-read' },
        subject: delegatedPrincipalId,
        scope: { kind: 'document-tree', pathPrefix: 'private/' },
      }),
    ).toMatchObject({ allowed: false, refusal: { reason: 'grant-not-found' } });
    expect(
      await ledger.verify({
        grant: { grantId: expiryChildId, action: 'document-tree-read' },
        subject: delegatedPrincipalId,
        scope: { kind: 'document-tree', pathPrefix: 'docs/api/' },
      }),
    ).toMatchObject({ allowed: false, refusal: { reason: 'grant-not-found' } });
    await ledger.close();
  });

  it('replays an exact command and refuses conflicting reuse without adding another grant', async () => {
    /** Administrative root makes both attempts reach idempotency handling. */
    const grantAuthority = createBootstrapAuthorizationGrant<AuthorityGrantAction>(AUTHORITY_GRANT_ACTION, {
      id: grantAuthorityId,
      ledgerId,
      subject: administratorId,
      scope: { kind: 'authority-administration', ledgerId },
      issuedBy: administratorId,
      createdAt,
    });
    /** Fixed time makes the resulting record identical across exact replay. */
    const ledger = createMemoryAuthorityLedger<DocumentReadAction>({
      ledgerId,
      actions: [DOCUMENT_READ_ACTION],
      bootstrap: [grantAuthority],
      now: fixedAuthorityClock,
    });
    /** Exact command object uses a production-admitted idempotency key. */
    const command = {
      grantId: issuedGrantId,
      subject: principalId,
      action: 'document-read' as const,
      scope: { kind: 'document-read' as const, documentId: 'document-2' },
      issuedBy: administratorId,
      idempotencyKey: grantCommandKey,
    };

    /** First execution publishes the command's immutable grant. */
    const first = await ledger.grant(command, { grantId: grantAuthorityId, action: 'authority-grant' });
    /** Exact replay returns the retained grant with replay evidence. */
    const replay = await ledger.grant(command, { grantId: grantAuthorityId, action: 'authority-grant' });
    expect(first).toMatchObject({ kind: 'granted', replayed: false });
    expect(replay).toEqual(first.kind === 'granted' ? { ...first, replayed: true } : first);

    /** Same key changes only the target identity so conflict is the reached rule. */
    const conflictingGrantId = AuthorizationGrantIdSchema.parse('00000000-0000-4000-8000-000000000013');
    expect(
      await ledger.grant(
        { ...command, grantId: conflictingGrantId },
        { grantId: grantAuthorityId, action: 'authority-grant' },
      ),
    ).toEqual({ kind: 'refused', refusal: { reason: 'idempotency-conflict' } });
    expect(
      await ledger.verify({
        grant: { grantId: conflictingGrantId, action: 'document-read' },
        subject: principalId,
        scope: { kind: 'document-read', documentId: 'document-2' },
      }),
    ).toMatchObject({ allowed: false, refusal: { reason: 'grant-not-found' } });
    await ledger.close();
  });

  it('shares one close settlement and refuses later checks without revocation evidence', async () => {
    /** Root proves closure behavior over a previously valid grant. */
    const root = createBootstrapAuthorizationGrant<DocumentReadAction>(DOCUMENT_READ_ACTION, {
      id: grantId,
      ledgerId,
      subject: principalId,
      scope: { kind: 'document-read', documentId: 'document-1' },
      issuedBy: administratorId,
      createdAt,
    });
    /** Fixed clock also pins exact close and post-close refusal evidence. */
    const ledger = createMemoryAuthorityLedger<DocumentReadAction>({
      ledgerId,
      actions: [DOCUMENT_READ_ACTION],
      bootstrap: [root],
      now: fixedAuthorityClock,
    });

    /** First close call initiates the ledger attachment settlement. */
    const first = ledger.close();
    /** Repeated close call must return the same retained Promise. */
    const repeated = ledger.close();

    expect(first).toBe(ledger.closed);
    expect(repeated).toBe(ledger.closed);
    await expect(first).resolves.toEqual({
      kind: 'authority-broker-closed',
      ledgerId,
      closedAt: '2026-08-23T18:30:00.000Z',
    });
    expect(
      await ledger.verify({
        grant: { grantId, action: 'document-read' },
        subject: principalId,
        scope: { kind: 'document-read', documentId: 'document-1' },
      }),
    ).toMatchObject({ allowed: false, refusal: { reason: 'ledger-closed' } });
  });
});
