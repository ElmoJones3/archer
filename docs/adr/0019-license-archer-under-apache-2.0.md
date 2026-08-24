# License Archer under Apache-2.0

Archer will publish its source and future package artifacts under the Apache
License, Version 2.0. Repository and package manifests carry the
`Apache-2.0` SPDX expression. The full license text lives at the repository root
and in every independently packable public package.

## Considered options

MIT is short, familiar, and maximally permissive, but it leaves patent rights
implicit and says little about intentionally submitted contributions.
Apache-2.0 remains permissive while supplying an explicit contributor patent
grant, patent-litigation termination, contribution terms, and preservation
requirements for license and attribution notices. Those terms fit a modular
framework intended for competing commercial and open-source adapters without
requiring downstream code to use the same license.

Copyleft licenses were not selected because Archer's composition model should
allow applications and independently distributed adapters to choose their own
licensing terms. The project can still accept dependencies under compatible
licenses after ordinary dependency review.

## Consequences

Package `private` flags remain in place until the initial release; a public
license does not imply that unfinished artifacts are ready for registry
publication. Every future public package must declare `Apache-2.0` and include
the canonical license in its packed artifact. The repository license check
compares package-local bytes with the root text, packs each package, and inspects
both `package/LICENSE` and packed metadata so source layout cannot silently
break distribution compliance.

Archer does not currently publish a `NOTICE` file because the project has not
established separate attribution notices that require one. If a future
contribution or bundled work adds such notices, repository and artifact checks
must preserve the resulting `NOTICE` alongside the license.
