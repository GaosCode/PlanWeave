# Contributing to PlanWeave

Thank you for contributing to PlanWeave. Keep changes focused, reviewable, and supported by relevant verification.

## Getting Started

See [DEVELOPMENT.md](DEVELOPMENT.md) for repository setup, workspace commands, testing, Desktop development, and local packaging.

## Making Changes

- Keep changes focused and avoid unrelated refactoring.
- Follow the existing code style and architecture.
- Update relevant tests and documentation when behavior changes.
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

## Pull Requests

Explain what changed and why, and keep the pull request focused. Screenshots are helpful for visible Desktop changes.

## Sensitive Information

Do not include credentials, tokens, private keys, private paths, environment values, or unredacted runtime data in issues, pull requests, logs, fixtures, or commits.
