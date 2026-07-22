# Contributing to PlanWeave

Thank you for contributing to PlanWeave. Keep changes focused, reviewable, and supported by relevant verification.

## Getting Started

See [DEVELOPMENT.md](DEVELOPMENT.md) for repository setup, workspace commands, testing, Desktop development, and local packaging.

## Making Changes

- Keep changes focused and avoid unrelated refactoring.
- Follow the existing code style and architecture.
- Update relevant tests and documentation when behavior changes.
- Keep the primary `README.md` in English. When stable user-facing behavior changes, update the localized `readme/README.zh-CN.md` where relevant.
- Do not commit planning notes, review reports, integration scratchpads, generated QA notes, temporary worktree artifacts, or other task-specific process records.
- Architecture documentation should describe durable system boundaries and decisions, not the implementation or review process that produced them.
- Do not commit credentials, local configuration, or generated build artifacts.

## Verification

Run the checks relevant to the affected package. A focused test can be run with:

```bash
pnpm exec vitest run path/to/test-file.ts
```

Before submitting a broad change, run:

```bash
pnpm lint
pnpm test
pnpm -r build
```

Platform-dependent checks are documented in [DEVELOPMENT.md](DEVELOPMENT.md).

## Commits

Use Conventional Commits:

```text
<type>(<scope>): <description>
```

Examples:

```text
fix(runtime): preserve interaction cleanup errors
feat(cli): add task status filtering
docs: clarify desktop installation
```

Keep commits focused.

Maintainers normally squash pull requests when merging. Use a Conventional Commit title for the pull request so the resulting `main` commit remains clear and searchable.

## Pull Requests

Explain what changed, why it changed, how it was verified, and any remaining risks or documentation impact. Keep the pull request focused and resolve conflicts with the current `main` branch before requesting final review. Screenshots are helpful for visible Desktop changes.

## Sensitive Information

Do not include credentials, tokens, private keys, private paths, environment values, or unredacted runtime data in issues, pull requests, logs, fixtures, or commits.
