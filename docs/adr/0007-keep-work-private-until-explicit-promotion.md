# Keep work private until explicit promotion

Every managed task will work in a private Workspace and may return snapshots
and an immutable `ChangeSet`. A Workspace handle cannot promote its own work,
and a successful `runTask` result does not advance a canonical reference.
Promotion belongs to a separate service that revalidates the exact change,
expected canonical head, policy, reviews, checks, and current authority before
an expected-head compare-and-swap.

This keeps task execution and canonical publication under different ownership
and prevents sandbox or Workspace possession from becoming write authority.
