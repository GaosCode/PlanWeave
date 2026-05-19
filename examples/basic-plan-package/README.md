# Basic Plan Package

This example is a minimal MVP-0 package for testing the PlanWeave loop:

```text
init -> validate -> refresh-prompts -> claim-next -> prompt -> submit-result -> submit-review -> status
```

From the repository root, run:

```bash
pnpm build

export PLANWEAVE_HOME="$(mktemp -d)"
planweave() {
  pnpm --filter @planweave/cli planweave "$@"
}

planweave init
cp -R examples/basic-plan-package/package/. "$PLANWEAVE_HOME"/projects/*/package/

planweave validate
planweave refresh-prompts
planweave claim-next
planweave prompt T-001

printf "First implementation.\n" > "$PLANWEAVE_HOME/implementation-1.md"
printf "Needs a test adjustment.\n" > "$PLANWEAVE_HOME/review-1.md"
planweave submit-result T-001 --report "$PLANWEAVE_HOME/implementation-1.md"
planweave submit-review T-001 --report "$PLANWEAVE_HOME/review-1.md" --status needs_changes

planweave prompt T-001
printf "Second implementation.\n" > "$PLANWEAVE_HOME/implementation-2.md"
printf "Passed.\n" > "$PLANWEAVE_HOME/review-2.md"
planweave submit-result T-001 --report "$PLANWEAVE_HOME/implementation-2.md"
planweave submit-review T-001 --report "$PLANWEAVE_HOME/review-2.md" --status passed

planweave status
```

The final status output should show one verified task.
