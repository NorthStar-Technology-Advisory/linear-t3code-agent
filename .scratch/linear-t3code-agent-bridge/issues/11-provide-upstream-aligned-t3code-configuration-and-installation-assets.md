# 11: Provide upstream-aligned T3Code configuration and installation assets

## Parent

[NOR-173](https://linear.app/northstar-tech-advisory/issue/NOR-173/fork-linear-pi-agent-to-build-a-linear-t3code-agent-bridge)

## What to build

An adopter can build, configure and start the bridge using deliverables equivalent to the base linear-pi-agent project, with actionable setup failures.

## Acceptance criteria

- [ ] Adapt existing build/start commands, configuration examples, installation guidance and existing service assets for T3Code; retain useful OAuth setup and smoke checks.
- [ ] Document project mappings, one-installation scope, provider/model selection, private T3Code connectivity, narrow credentials and the dedicated-account/full-permission assumption.
- [ ] Do not add launchd, new deployment provisioning or additional Docker packaging; supervision is the end user's choice.
- [ ] Do not pin T3Code or introduce a compatibility matrix or session deadline; describe integration failure diagnosis and credential handling without exposing secrets.
- [ ] Verify clean build/start and invalid-configuration behavior. Each subsequent feature ticket must keep its own configuration and operator instructions current.

## Blocked by

- Draft 2: Delegate a mapped Linear issue to an isolated T3Code thread
