---
name: principle-example-adoption
description: Make runnable examples useful to application developers. Mandatory when creating, changing, reviewing, or diagnosing anything under examples/.
---

# Build examples people can use

Examples are Archer's storefront. They prove that a developer can use the
public API to finish a recognizable job. Tests and conformance suites prove the
library's correctness.

Read [`docs/contributing/examples.md`](../../../docs/contributing/examples.md)
before changing an example.

## Start with the developer's job

Name the application and README for work someone already needs to do. State
what to run, what input it accepts, what happens, and which code is worth
copying. Introduce Archer terms only where the integration needs them.

Run the real dependency and boundary named by the example. A webhook example
must exchange HTTP requests. A model example must call the selected model. Do
not replace the defining interaction with a direct function call for
convenience.

## Make the value visible

Show the useful outcome in the running application. If recovery, live updates,
or isolation is the reason to use Archer, give the reader a short way to see it
happen. Do not print internal evidence fields or manufacture a conformance
report as application output.

Keep comments in the language of the application. Explain choices that a
developer may copy, such as retry policy, credential ownership, cleanup, and
failure behavior. Do not lecture readers about internal algorithms or use
comments to translate obvious code.

## Treat friction as an API finding

Trace the setup a developer must copy. Repetitive grants, revisions, codecs,
ownership wiring, or lifecycle code may reveal a missing public factory or
bound application object. Fix that public path when the library can own a safe
default. Keep the lower contract importable for callers who need more control.

Before review, ask whether someone would copy the example to solve the named
job. If they would only read it to verify Archer works, rewrite it.
