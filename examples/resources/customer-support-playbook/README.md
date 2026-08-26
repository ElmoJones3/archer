# Answer a support ticket with a checked playbook

This example answers one order-status question with OpenAI. Before the model
call, Archer checks and combines four reusable pieces of application policy:

- a company-specific support Prompt;
- an `order-support` Skill stored as a normal Agent Skills directory;
- the selected OpenAI model; and
- an output and time budget for one reply.

The result is still an ordinary AI SDK model call. Archer makes the input and
limits explicit; it does not replace your provider client or hide the live
reply.

## Run it

Set an OpenAI API key, then run this command from the repository root:

```sh
export OPENAI_API_KEY="your_api_key_here"
pnpm example:resources:support -- "Where is order A-42? The latest carrier scan says it shipped yesterday."
```

The example streams the reply as OpenAI produces it. When the call finishes,
it prints the names of the model, Prompt, Skill, profile, and budget that shaped
the request, plus the effective output limit and deadline.

If the terminal falls behind the live stream, it says so and prints the complete
terminal reply when the call settles. Provider failures remain structured on
`SupportReplyError.result`, so an application can use Archer's public error code
and retry advice instead of parsing an error message.

It uses `gpt-5.6-luna` by default. Set `OPENAI_MODEL` to use another OpenAI
model ID.

## What OpenAI receives

The provider request contains:

- the rendered text from [`prompts/support.md`](prompts/support.md), with the
  company name filled in;
- the instruction body from
  [`skills/order-support/SKILL.md`](skills/order-support/SKILL.md); and
- the order-status rules explicitly loaded from
  [`skills/order-support/references/order-status.md`](skills/order-support/references/order-status.md);
  and
- the ticket text passed on the command line.

This example starts with no conversation history. Archer never sends Skill
support files automatically: `createSupportPlaybook` explicitly loads the
order-status guide from the immutable Skill snapshot and turns it into checked
system instructions. Another application could expose support files through a
tool or leave them undisclosed.

Credentials stay in the OpenAI client. They are never stored in the Archer
Model or ResourceSet.

## Code worth copying

[`src/application.ts`](src/application.ts) exports `createSupportPlaybook`. It
imports the reusable Prompt and Skill once, then returns an `answer` function
that prepares a fresh bounded request for each ticket. It accepts your
FileStore, configured Model, ModelRouter, Prompt path, and Skill path;
[`src/main.ts`](src/main.ts) only reads environment variables and prints the
result.

The application uses the short local workflow:

1. import the Prompt and Skill;
2. define a BudgetPolicy;
3. group them with a Model in an AgentProfile;
4. bind that profile once;
5. prepare one fresh request per ticket; and
6. start each prepared request through the AI SDK router.

The FileStore and router belong to the caller and are closed by the CLI. No
Resource Store, review workflow, database, or hosted service is required.

## Test without an API key

```sh
pnpm --filter @archer/example-resources-customer-support-playbook test
```

The test uses Vercel's maintained AI SDK test model. It runs the same exported
application, checks the actual provider request, and proves that the reply went
through Resource preparation and the AI SDK adapter.
