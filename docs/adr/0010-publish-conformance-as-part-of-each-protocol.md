# Publish conformance as part of each protocol

Archer will publish versioned conformance suites for its replaceable Cell,
object-store, model, transcript, resource, authority, sandbox, and Workspace
contracts. Passing evidence exists only when every required case passes for the
named implementation and configuration. Failed or skipped required cases
remain diagnostic results and cannot support a production guarantee.

This makes failure semantics and safety claims available to third-party
implementers instead of leaving them in Archer's private test suite.
