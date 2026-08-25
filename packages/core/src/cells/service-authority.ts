/**
 * @file Creates explicit process-local Authority for one trusted Cell service.
 *
 * This factory removes repetitive bootstrap code from single-service programs.
 * Applications with tenant policy, external grants, or durable revocation can
 * provide any `AuthorityBroker<CellAction>` to a CellHost instead.
 */

import type { DiagnosticHub } from '../diagnostics/contracts.js';
import {
  AuthorityLedgerIdSchema,
  AuthorizationGrantIdSchema,
  PrincipalIdSchema,
  authorityTimestamp,
  createBootstrapAuthorizationGrant,
  createMemoryAuthorityLedger,
  type AuthorityClock,
  type AuthorityLedger,
  type GrantRef,
  type PrincipalId,
} from '../authority/index.js';
import {
  CELL_ATTACH_ACTION,
  CELL_CREATE_ACTION,
  CELL_DISCOVER_ACTION,
  CELL_DISPATCH_ACTION,
  CELL_READ_ACTION,
  type CellAction,
  type CellAttachAction,
  type CellCreateAction,
  type CellDiscoverAction,
  type CellDispatchAction,
  type CellHostId,
  type CellReadAction,
} from './contracts.js';

/** Action-specific references retained by a trusted Cell service. */
export type CellServiceGrants = Readonly<{
  /** Authorizes Cell creation anywhere under the selected host. */
  create: GrantRef<CellCreateAction>;

  /** Authorizes restoration and activation anywhere under the selected host. */
  attach: GrantRef<CellAttachAction>;

  /** Authorizes finite canonical-state reads anywhere under the selected host. */
  read: GrantRef<CellReadAction>;

  /** Authorizes event dispatch anywhere under the selected host. */
  dispatch: GrantRef<CellDispatchAction>;

  /** Authorizes bounded recovery discovery anywhere under the selected host. */
  discover: GrantRef<CellDiscoverAction>;
}>;

/** Owned in-memory policy and references for one trusted service process. */
export type CellServiceAuthority = Readonly<{
  /** Real current-verification ledger borrowed by the CellHost and closed by the application. */
  ledger: AuthorityLedger<CellAction>;

  /** Principal attributed at every protected Cell operation. */
  subject: PrincipalId;

  /** Exact host-wide grant references passed to protected operations. */
  grants: CellServiceGrants;
}>;

/** Construction for the opinionated trusted-service Authority path. */
export type CellServiceAuthorityOptions = Readonly<{
  /** Limits every generated grant to one configured CellHost. */
  hostId: CellHostId;

  /** Supplies the current verification clock and defaults to wall time. */
  now?: AuthorityClock;

  /** Supplies UUIDv4 identities and defaults to platform randomness. */
  createId?: () => string;

  /** Receives non-authoritative Authority spans without owning the hub. */
  diagnostics?: Pick<DiagnosticHub, 'beginSpan'>;
}>;

/**
 * Reads current wall time for ordinary process-local verification.
 * @returns The current platform instant.
 */
function systemAuthorityClock(): Date {
  return new Date();
}

/**
 * Generates one UUIDv4 for each policy object created by the factory.
 * @returns A fresh platform UUIDv4 string.
 */
function systemAuthorityId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Creates one real in-memory ledger with host-wide grants for every Cell action.
 *
 * This is an explicit trusted-service policy, not an authorization bypass. The
 * ledger still verifies subject, action, host scope, time, and closure on every
 * operation. Applications needing narrower or durable policy should construct
 * their own AuthorityBroker and grant set.
 * @param options - Host scope plus optional deterministic or diagnostic capabilities.
 * @returns Owned ledger, attributed Principal, and action-specific references.
 */
export function createCellServiceAuthority(options: CellServiceAuthorityOptions): CellServiceAuthority {
  /** One broker-owned clock keeps root creation and later verification consistent. */
  const now = options.now ?? systemAuthorityClock;
  /** One UUIDv4 source gives deterministic tests the same path as production randomness. */
  const createId = options.createId ?? systemAuthorityId;
  /** The ledger and Principal identities are separate from every forgeable grant lookup. */
  const ledgerId = AuthorityLedgerIdSchema.parse(createId());
  /** One service Principal makes operation attribution explicit without tenant policy boilerplate. */
  const subject = PrincipalIdSchema.parse(createId());
  /** Host-wide scope preserves isolation between separately configured durability services. */
  const scope = Object.freeze({ kind: 'cell' as const, hostId: options.hostId });
  /** Each action receives an independent reference so a caller cannot present the wrong capability by accident. */
  const grantIds = [
    AuthorizationGrantIdSchema.parse(createId()),
    AuthorizationGrantIdSchema.parse(createId()),
    AuthorizationGrantIdSchema.parse(createId()),
    AuthorizationGrantIdSchema.parse(createId()),
    AuthorizationGrantIdSchema.parse(createId()),
  ] as const;
  /** All roots share one trusted creation instant from the broker's own clock. */
  const createdAt = authorityTimestamp(now);
  /** Explicit roots keep the convenience factory compatible with normal Authority verification. */
  const bootstrap = [
    createBootstrapAuthorizationGrant<CellCreateAction>(CELL_CREATE_ACTION, {
      id: grantIds[0],
      ledgerId,
      subject,
      scope,
      issuedBy: subject,
      createdAt,
    }),
    createBootstrapAuthorizationGrant<CellAttachAction>(CELL_ATTACH_ACTION, {
      id: grantIds[1],
      ledgerId,
      subject,
      scope,
      issuedBy: subject,
      createdAt,
    }),
    createBootstrapAuthorizationGrant<CellReadAction>(CELL_READ_ACTION, {
      id: grantIds[2],
      ledgerId,
      subject,
      scope,
      issuedBy: subject,
      createdAt,
    }),
    createBootstrapAuthorizationGrant<CellDispatchAction>(CELL_DISPATCH_ACTION, {
      id: grantIds[3],
      ledgerId,
      subject,
      scope,
      issuedBy: subject,
      createdAt,
    }),
    createBootstrapAuthorizationGrant<CellDiscoverAction>(CELL_DISCOVER_ACTION, {
      id: grantIds[4],
      ledgerId,
      subject,
      scope,
      issuedBy: subject,
      createdAt,
    }),
  ] as const;
  /** The returned ledger remains an ordinary replaceable Authority implementation. */
  const ledger = createMemoryAuthorityLedger<CellAction>({
    ledgerId,
    actions: [CELL_CREATE_ACTION, CELL_ATTACH_ACTION, CELL_READ_ACTION, CELL_DISPATCH_ACTION, CELL_DISCOVER_ACTION],
    bootstrap,
    now,
    ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
  });

  return Object.freeze({
    ledger,
    subject,
    grants: Object.freeze({
      create: Object.freeze({ grantId: grantIds[0], action: 'cell-create' }),
      attach: Object.freeze({ grantId: grantIds[1], action: 'cell-attach' }),
      read: Object.freeze({ grantId: grantIds[2], action: 'cell-read' }),
      dispatch: Object.freeze({ grantId: grantIds[3], action: 'cell-dispatch' }),
      discover: Object.freeze({ grantId: grantIds[4], action: 'cell-discover' }),
    }),
  });
}
