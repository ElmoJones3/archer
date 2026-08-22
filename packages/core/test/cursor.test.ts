/**
 * @file Proves third-party stream implementations can construct and verify
 * exact durable cursor identity without private casts.
 */

import { describe, expect, it } from 'vitest';

import { createStreamCursorCodec, type StreamCursor } from '../src/stream/index.js';

describe('StreamCursorCodec', () => {
  it('round-trips source, scope, stream, epoch, revision, and arbitrary position', () => {
    /** Owns the exact logical identity used by the representative stream. */
    const codec = createStreamCursorCodec({
      revision: 'task-observation/1',
      source: 'task',
      scope: 'tenant-1',
      streamId: 'task-1',
      epoch: 'epoch-1',
    });

    /** Uses only the public factory to obtain a correctly branded cursor. */
    const cursor: StreamCursor<'task'> = codec.encode(90071992547409931234567890n);

    expect(codec.decode(cursor)).toEqual({
      ok: true,
      value: {
        revision: 'task-observation/1',
        source: 'task',
        scope: 'tenant-1',
        streamId: 'task-1',
        epoch: 'epoch-1',
        offset: '90071992547409931234567890',
      },
    });
  });

  it('rejects a cursor from another scope with one focused Archer Error', () => {
    /** Creates otherwise matching identity for a different tenant scope. */
    const foreign = createStreamCursorCodec({
      revision: 'task-observation/1',
      source: 'task',
      scope: 'tenant-2',
      streamId: 'task-1',
      epoch: 'epoch-1',
    });

    /** Owns the local scope whose decoder must reject foreign authority context. */
    const local = createStreamCursorCodec({
      revision: 'task-observation/1',
      source: 'task',
      scope: 'tenant-1',
      streamId: 'task-1',
      epoch: 'epoch-1',
    });

    expect(local.decode(foreign.encode(0n))).toMatchObject({
      ok: false,
      error: { code: 'cursor_scope_mismatch' },
    });
  });
});
