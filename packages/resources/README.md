# `@archer/resources`

Turn reusable model configuration, prompts, Agent Skills, and limits into one
exact model request. The ordinary path is local and application-owned; review,
transport, and hydration stay available on explicit subpaths for infrastructure
code.

## Prepare a request

```ts
import { memoryFileStore } from '@archer/files';
import { createLocalResources } from '@archer/resources';

const files = memoryFileStore();
const resources = createLocalResources({ files });

const playbook = await resources.skills.importDirectory('./skills/order-support');
if (!playbook.ok) throw playbook.error;

const prompt = await resources.prompts.importFile('./prompts/support.md', {
  placement: 'system',
  variables: ['company'],
});
if (!prompt.ok) throw prompt.error;

const budget = resources.budgets.define({ outputTokens: 800, wallTimeMs: 20_000 });
const profile = resources.profiles.create({
  model,
  prompts: [prompt.value],
  skills: [{ skill: playbook.value, activation: 'active' }],
  budget,
});
const session = resources.bind(profile);

const prepared = session.prepareStep({
  promptInputs: { company: 'Northstar Outfitters' },
  history: [],
  userMessage: 'Where is order A-42?',
});
if (!prepared.ok) throw prepared.error;

const started = await router.startStep(prepared.value.request);
if (!started.ok) throw started.error;
```

The Resource graph and bound session are reusable across calls. Each
`prepareStep` renders the selected Prompts, includes active Skill instructions,
advertises discoverable Skill summaries, intersects Budget limits, and creates
a fresh request pinned to an immutable ResourceSet. It performs no model call,
persistence, logging, or hidden profile update.

`createLocalResources` borrows the FileStore and owns no background work, so it
has no `close()` method. The application closes its FileStore, ModelRouter, and
each returned model operation.

Invalid standalone definitions throw `ResourcesError` before behavior exists.
File imports, pure transitions, `prepareStep`, and reviewed-control decisions
return `Result`, so expected refusals keep their stable code without throwing.
Transport decoding returns detached data; hydration is the explicit boundary
that can restore behavior after its required facts are checked.

## Concepts that behave

- A Prompt validates its own template contract and renders source-identified
  contributions without file I/O.
- A Skill is an imported Agent Skills directory rooted at `SKILL.md`; it owns
  summary, instruction, and contained support-file disclosure. The local
  facade's `skills.loadSupport(skill, path)` reads explicitly selected support
  bytes from the same immutable file plane.
- A BudgetPolicy can be narrowed and can allocate an effective output ceiling
  and optional deadline for one step.
- An AgentProfile owns exact selections, rename, replacement, and
  discoverable-to-active Skill changes.
- A ResourceSet is closed evidence of one local or independently reviewed
  selection; callers cannot manufacture it from a DTO.

## Advanced boundaries

- `/prompts`, `/skills`, `/budgets`, and `/profiles` expose the standalone
  behavior modules.
- `/control` exposes pure proposal, independent review, admission, revocation,
  restored-chain verification, and reviewed compilation.
- `/transport` exposes strict JSON-safe DTO codecs. Decoding produces data.
- `/hydration` restores behavior only with exact parents, content, bindings,
  and admission capabilities.

Wave 6 intentionally contains no Store, registry, hosted control service, Tool
Resource, live budget accounting, or workspace/sandbox compatibility claim.
Those concerns need owners that can actually provide their guarantees.
