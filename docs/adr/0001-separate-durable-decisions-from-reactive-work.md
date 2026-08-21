# Separate durable decisions from reactive work

Archer will use pure `Program` reducers and durable Cells for canonical state,
event order, effect identity, attempts, fencing, and recovery. RxJS will own
live temporal work only after acknowledgement, including cancellation,
observation, bounded concurrency, and fan-out. This keeps replayable meaning
independent of process-local subscriptions while using RxJS where teardown and
composition are part of the contract.

Each live source has one shared graph. Direct handles, managed TaskRuns,
diagnostics, framework bindings, and remote transports project that graph. They
may not reconstruct durable meaning by polling, folding transient output, or
maintaining another domain reducer.

A replaceable `CellHost` creates and restores Cells only when the exact Program,
state projection, codecs, and durability revisions match. It returns the hot
Cell attachment without making the handle or a subscriber the durable owner.

The Thread, Turn, and Item coding loop follows the same rule. One model step
settles, Archer records its ordered parts, and every proposed tool call receives
a terminal result before the next model request.
