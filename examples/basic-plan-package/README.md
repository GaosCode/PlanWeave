# Basic PlanWeave Example

This example demonstrates a small PlanWeave workflow with six task nodes, parallel branches, a dependency join, and a review step.

```text
T-001
├── T-002 ──┐
└── T-003 ──┴── T-004
                  ├── T-005
                  └── T-006
```

- `T-001` creates and reviews the initial implementation report.
- `T-002` and `T-003` can run in parallel after `T-001`.
- `T-004` waits for both parallel tasks.
- `T-005` and `T-006` can then run in parallel.
- The package allows up to two tasks to run concurrently.

On the first launch of an installed PlanWeave Desktop application, this package is added as the managed project **PlanWeave Example** when no projects already exist. It behaves like a normal project after loading: changes are retained, and PlanWeave does not overwrite or automatically remove it on later launches.

The source package is in [`package`](package).
