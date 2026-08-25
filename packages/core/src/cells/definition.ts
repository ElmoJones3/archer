/**
 * @file Defines the short path for JSON-backed Cell protocols.
 *
 * One application revision is enough when state, events, effects, and the
 * public state view move together. Callers with independent migration needs
 * can still construct the lower `CellProtocol` contract directly.
 */

import type { Codec } from '../codec.js';
import type { Program } from '../program.js';
import {
  CellProtocolRevisionSchema,
  ProgramRevisionSchema,
  StateProjectionRevisionSchema,
  type CellDurabilityRequirement,
  type CellProtocol,
  type CellWake,
} from './contracts.js';
import { jsonCellCodec } from './model.js';

/** Product-neutral validators used to construct one family's canonical JSON bytes. */
export type JsonCellProtocolCodecs<State, Event, Effect> = Readonly<{
  /** Admits and copies canonical Program state. */
  state: Codec<State>;

  /** Admits and copies ordered Program events. */
  event: Codec<Event>;

  /** Admits and copies acknowledged external work. */
  effect: Codec<Effect>;
}>;

/** Optional bounded public view when callers should not receive canonical state. */
export type JsonCellStateProjection<State, StateView> = Readonly<{
  /** Admits and copies every projected value before publication. */
  codec: Codec<StateView>;

  /** Derives the application-facing value without I/O or ambient state. */
  project(state: Readonly<State>): StateView;
}>;

/** Common JSON Cell definition whose persistence bindings move under one revision. */
export type JsonCellProtocolOptions<State, Event, Effect, StateView = State> = Readonly<{
  /** Bumps the Program, projection, and all canonical JSON codecs together. */
  revision: string;

  /** States the weakest host failure boundary this Program accepts. */
  durability: CellDurabilityRequirement['type'];

  /** Owns pure state changes and ordered external-work requests. */
  program: Program<State, Event, Effect>;

  /** Supplies validator-neutral admission for every durable value family. */
  codecs: JsonCellProtocolCodecs<State, Event, Effect>;

  /** Narrows public state when the default complete-state view is inappropriate. */
  projection?: JsonCellStateProjection<State, StateView>;

  /** Retains one future recoverable event derived from acknowledged state. */
  projectWake?: (state: Readonly<State>) => CellWake<Event> | undefined;
}>;

/**
 * Builds a canonical JSON protocol from one application revision.
 *
 * The derived revision names are deliberately inspectable. Use a raw
 * `CellProtocol` when one codec or projection needs an independent migration
 * schedule.
 * @param options - Program, validators, durability requirement, and optional public view.
 * @returns A complete frozen protocol suitable for any conforming CellHost.
 */
export function defineJsonCellProtocol<State, Event, Effect, StateView = State>(
  options: JsonCellProtocolOptions<State, Event, Effect, StateView>,
): CellProtocol<State, StateView, Event, Effect> {
  /** The base revision is also the complete protocol compatibility identity. */
  const protocolRevision = CellProtocolRevisionSchema.parse(options.revision);
  /** Independent raw contracts remain available when these derived bindings are too coarse. */
  const programRevision = ProgramRevisionSchema.parse(`${options.revision}/program`);
  /** Projection behavior moves with the common application revision on this short path. */
  const projectionRevision = StateProjectionRevisionSchema.parse(`${options.revision}/projection`);
  /** Canonical state bytes are shared with the default complete-state public view. */
  const stateCodec = jsonCellCodec({ revision: `${options.revision}/state`, value: options.codecs.state });
  /** Ordered event bytes remain visibly derived from the same application revision. */
  const eventCodec = jsonCellCodec({ revision: `${options.revision}/event`, value: options.codecs.event });
  /** Acknowledged work bytes remain visibly derived from the same application revision. */
  const effectCodec = jsonCellCodec({ revision: `${options.revision}/effect`, value: options.codecs.effect });
  /** A custom projection receives its own bytes; otherwise state admission safely copies the view. */
  const stateViewCodec =
    options.projection === undefined
      ? (stateCodec as unknown as import('./contracts.js').CellCodec<StateView>)
      : jsonCellCodec({ revision: `${options.revision}/state-view`, value: options.projection.codec });

  return Object.freeze({
    protocolRevision,
    programRevision,
    projectionRevision,
    durability: Object.freeze({ type: options.durability }),
    program: options.program,
    /**
     * Copies the default complete-state view or admits the caller's bounded projection.
     * @param state - Current acknowledged canonical state.
     * @returns Fresh validated state suitable for hot publication.
     */
    projectState(state: Readonly<State>): StateView {
      if (options.projection !== undefined) return options.projection.codec.parse(options.projection.project(state));
      return options.codecs.state.parse(state) as unknown as StateView;
    },
    ...(options.projectWake === undefined ? {} : { projectWake: options.projectWake }),
    codecs: Object.freeze({ state: stateCodec, stateView: stateViewCodec, event: eventCodec, effect: effectCodec }),
  });
}
