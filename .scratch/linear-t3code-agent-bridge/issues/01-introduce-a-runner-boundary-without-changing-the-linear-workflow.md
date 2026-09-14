# 1: Introduce a runner boundary without changing the Linear workflow

## Parent

[NOR-173](https://linear.app/northstar-tech-advisory/issue/NOR-173/fork-linear-pi-agent-to-build-a-linear-t3code-agent-bridge)

## What to build

Existing Linear delegation, follow-ups, progress and cancellation continue through a provider-neutral runner boundary, making T3Code integration independently testable.

## Acceptance criteria

- [ ] Move Pi-specific invocation behind the smallest runner boundary needed by the existing end-to-end workflow; keep current Pi behavior working during this prefactor.
- [ ] Exercise signed webhook intake through externally observable runner requests and Linear activities with controlled external dependencies, using existing Node test conventions.
- [ ] Preserve OAuth, signature validation, progress formatting and secret redaction; do not require a broad rewrite or a second permanent runtime.

## Blocked by

None (can start immediately).
