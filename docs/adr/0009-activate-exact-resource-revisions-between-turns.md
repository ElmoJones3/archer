# Activate exact resource revisions between turns

Archer will compile a named profile into one immutable `ResourceSet` containing
exact admitted model, prompt, skill, and tool revisions. The profile is the
managed task's only source of model and resource selection. Resource changes
may activate between Turns, but an acknowledged model request and every tool
call it caused remain pinned to the `ResourceSet` that produced them.

This permits spontaneous resource production without making replay depend on
mutable names or mid-step catalogue changes.
