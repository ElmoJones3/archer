# Activate exact resource revisions between turns

Archer will compile a named profile into one immutable `ResourceSet` containing
exact admitted model, prompt, skill, and tool revisions. The profile is the
managed task's only source of model and resource selection. Resource changes
may activate between Turns, but an acknowledged model request and every tool
call it caused remain pinned to the `ResourceSet` that produced them.

This permits spontaneous resource production without making replay depend on
mutable names or mid-step catalogue changes.

Resource control exposes replayable admission, profile, activation, and
revocation facts. The active `ResourceSet` remains an immutable value compiled
for an exact frontier. A subscriber cannot replace the current admission and
revocation checks performed when a Turn or invocation begins.
