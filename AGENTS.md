# Archer contributor instructions

## Examples are product work

Before creating, changing, or reviewing anything under `examples/`, read
`docs/contributing/examples.md` and apply the repository's
`principle-example-adoption` skill.

An example exists to help an application developer recognize a job, run it,
and copy the useful integration into their own project. Package tests and
conformance suites prove Archer's internal contracts. Do not turn an example
into another correctness fixture or lead its story with Archer terminology.

If a real application needs a large block of repetitive Archer setup, treat
that friction as a public API finding. Add the smallest honest factory or
bound application object that removes the repetition, while keeping the raw
contract available for advanced use.
