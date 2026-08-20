# Keep RxJS behind the public stream boundary

Supersedes the public RxJS portion of ADR 0003.

RxJS remains Archer's internal implementation for activation lanes, finite
composition, cancellation, timers, concurrency, and fan-out. Archer's contract
packages will expose a dependency-free `EventStream` and `LiveOperation`
boundary instead of RxJS types.

An EventStream subscription owns only bounded delivery and detachment. A
LiveOperation owns one finite live attempt, its events, one result, active
abort, and close evidence. Durable cancellation remains a command on TaskRun or
ThreadHandle. Cursor resume, gaps, overflow, and teardown are explicit, and
public declaration checks reject accidental RxJS imports.

This preserves the temporal behavior proved in the spikes without requiring an
adopter or adapter author to learn Archer's reactive implementation.
