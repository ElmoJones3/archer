/** @file Proves the public immutable-tree example delivers every documented claim. */

import { describe, expect, it } from 'vitest';

import { immutableTreeDemo } from '../src/demo.js';

describe('immutable tree example', () => {
  it('proves convergence, structural sharing, rejection, and cleanup', async () => {
    expect(await immutableTreeDemo()).toEqual({
      orderIndependent: true,
      docsShared: true,
      invalidPathCode: 'files_invalid_input',
      closed: true,
    });
  });
});
