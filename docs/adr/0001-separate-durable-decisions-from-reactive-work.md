# Separate durable decisions from reactive work

Archer will use pure `Program` reducers and durable Cells for canonical state,
event order, effect identity, attempts, fencing, and recovery. RxJS will own
live temporal work only after acknowledgement, including cancellation,
observation, bounded concurrency, and fan-out. This keeps replayable meaning
independent of process-local subscriptions while using RxJS where teardown and
composition are part of the contract.

The Thread, Turn, and Item coding loop follows the same rule. One model step
settles, Archer records its ordered parts, and every proposed tool call receives
a terminal result before the next model request.
