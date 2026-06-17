# Basic Plan Package

This example is a minimal MVP-0 package for testing the PlanWeave loop:

```text
init -> validate -> run --once -> claim-next -> prompt -> submit-result -> submit-review -> submit-feedback -> claim-next -> status
```

From the repository root, run:

```bash
pnpm build

export PLANWEAVE_HOME="$(mktemp -d)"
planweave() {
  pnpm --silent --filter @planweave-ai/cli planweave "$@"
}

INIT_JSON="$(planweave init --json)"
PACKAGE_DIR="$(printf '%s' "$INIT_JSON" | node -e 'let data=""; process.stdin.on("data", c => data += c); process.stdin.on("end", () => console.log(JSON.parse(data).workspace.packageDir));')"
cp -R examples/basic-plan-package/package/. "$PACKAGE_DIR"/

planweave validate --json
planweave executors list
planweave executors test manual
planweave run --once --executor manual
planweave claim-next
planweave prompt T-001#B-001

printf "First implementation.\n" > "$PLANWEAVE_HOME/implementation-1.md"
planweave submit-result T-001#B-001 --report "$PLANWEAVE_HOME/implementation-1.md"

planweave claim-next
planweave prompt T-001#R-001
printf '{"reviewBlockRef":"T-001#R-001","taskId":"T-001","verdict":"needs_changes","content":"Needs a test adjustment."}\n' > "$PLANWEAVE_HOME/review-1.json"
planweave submit-review T-001#R-001 --result "$PLANWEAVE_HOME/review-1.json"

planweave claim-next
printf "Handled requested test adjustment.\n" > "$PLANWEAVE_HOME/feedback-1.md"
planweave submit-feedback --report "$PLANWEAVE_HOME/feedback-1.md"

planweave claim-next
planweave prompt T-001#R-001
printf '{"reviewBlockRef":"T-001#R-001","taskId":"T-001","verdict":"passed","content":"Passed."}\n' > "$PLANWEAVE_HOME/review-2.json"
planweave submit-review T-001#R-001 --result "$PLANWEAVE_HOME/review-2.json"

planweave status
planweave run-status
```

The commands above use the current directory as the target project root. If you run them from another directory, put the global root option before the subcommand, for example:

```bash
planweave --project-root /path/to/PlanWeave init --json
planweave --project-root /path/to/PlanWeave validate --json
planweave --project-root /path/to/PlanWeave status --canvas desktop
```

The final status output should show one implemented task and completed implementation/review blocks.
The `run --once --executor manual` command writes the next rendered prompt under the PlanWeave results directory and stops for manual submission; it does not replace the skill/CLI submit flow.

To let PlanWeave call Codex directly instead of writing a manual prompt artifact, use the Codex executor profile:

```bash
planweave executors test codex-auto
planweave run --executor codex-auto
planweave run-status
```
