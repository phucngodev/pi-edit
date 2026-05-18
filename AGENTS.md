# Instructions

Keep context small and follow existing project patterns.

## Non-negotiable

- This is a TypeScript-only project. Create only `.ts` files, including tests.
- All local imports must use `.ts` extensions. Never import `.js`.
- Before adding imports, read an existing file such as `cli.ts` to match the project pattern.

## Required workflow

- Start with a short plan.
- Run `pnpm test` before making code changes.
- For business logic, use TDD: write or update tests first, then implement.
- After every edited file, run:
  ```
  pnpm typecheck 2>&1 | grep "^EDITED_FILENAME"
  ```
  Fix errors in touched files before continuing.
- Run Prettier after each file write or small edit batch.
- Run `pnpm lint:fix` at logical checkpoints and run the full test suite after changes.

## Coding rules

- Keep changes minimal and directly related to the task.
- Prefer simple, readable code over cleverness.
- Prefer early returns and avoid deep nesting.
- Use TypeScript types instead of explanatory comments where possible.
- Preserve existing formatting and comments unless they are wrong.
- Do not modify unrelated areas or fix unrelated issues.

## Collaboration

- Ask for confirmation when the change is risky, ambiguous, or spans core architecture.
- State uncertainties explicitly; ask instead of guessing.
- Keep responses concise and actionable.

## Success criteria

- No new type errors in edited files.
- All tests pass.
- New or changed business logic has corresponding tests.
