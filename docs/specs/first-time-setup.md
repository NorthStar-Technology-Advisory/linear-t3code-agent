# First-time setup for existing Linear and T3Code users

Issue: [NOR-199](<https://linear.app/northstar-tech-advisory/issue/NOR-199>)
Status: Agreed specification.

## Problem Statement

Users with an existing Linear workspace and T3Code installation must discover identifiers, assemble configuration, configure OAuth and public HTTPS, obtain credentials, and diagnose multiple services manually. Installation documentation mixes onboarding with maintainer acceptance testing. Users need a short, repeatable path to a configured bridge and clear instructions when a connection fails.

## Solution

Provide a guided setup command, a pre-filled Linear application creation link, and a read-only diagnostic command. Preserve existing configuration so setup can be rerun after interruption. Finish when configuration and available connection checks pass, clearly distinguishing this from verified webhook delivery or end-to-end execution, and point to normal delegation instructions.

Lead with the bridge running on the same host as T3Code. Document HTTPS and service operation without automating infrastructure provisioning. Keep the implementation small and reuse existing configuration, authentication, and project-resolution behavior.

## User Stories

 1. As a new user, I want one primary quickstart, so that I can connect my existing installations without reading maintainer acceptance procedures.
 2. As a user, I want guided setup to ask for missing information, so that I do not hand-assemble environment configuration.
 3. As a user, I want setup to detect a local T3Code instance where straightforward, so that I avoid unnecessary URL discovery.
 4. As a user, I want to supply an instance address when detection fails, so that discovery does not block setup.
 5. As a user, I want a supported credential acquisition procedure, so that I can authenticate to T3Code without inspecting API responses.
 6. As a user, I want callback and webhook URLs derived from one public HTTPS address, so that I do not repeatedly enter related URLs.
 7. As a user, I want a pre-filled Linear application form, so that required application settings are easy to configure correctly.
 8. As a user, I want developer-specific details called out explicitly, so that I know which form fields still need my input.
 9. As a user, I want credentials saved privately and omitted from diagnostic output, so that setup does not expose secrets.
10. As a user, I want an installation secret generated for me, so that I do not invent one manually.
11. As a returning user, I want setup to preserve valid configuration and credentials, so that rerunning it does not undo working setup.
12. As an interrupted user, I want setup to continue from existing configuration, so that I do not repeat completed steps or create another Linear application.
13. As a user, I want to complete the existing app-actor OAuth installation, so that the bridge acts as the intended Linear agent.
14. As a user, I want first-project instructions using the T3Code project label group, so that I do not discover UUIDs or write routing JSON.
15. As a user, I want invalid or ambiguous project associations explained, so that I can correct them before delegation.
16. As a user, I want diagnostics to work with incomplete configuration, so that I can discover the next missing step.
17. As a user, I want each check to identify its component and a concrete repair step, so that I can recover without reading internals.
18. As a user, I want diagnostics to inspect without starting coding work or posting messages, so that checking setup has predictable effects.
19. As a user, I want authentication failure distinguished from connection failure, so that I know whether to renew a credential or fix the service.
20. As a returning user, I want credential replacement to preserve sessions, so that reconnecting does not reset ongoing work.
21. As a user, I want unverified delivery and permissions identified honestly, so that setup completion does not promise an untested workflow.
22. As a user, I want setup to finish without creating a branch or PR, so that I can choose when to delegate real work.
23. As an operator, I want one persistent HTTPS tunnel example and a reverse-proxy alternative, so that I can expose the bridge using a documented approach.
24. As an operator, I want macOS and Linux instructions for keeping the bridge running, so that it remains available after setup.
25. As a maintainer, I want a fresh-checkout walkthrough recorded, so that the shipped instructions are checked against the real user journey.

## Implementation Decisions

* Provide `npm run setup` and `npm run doctor` as the simple command interface. Keep advanced tuning out of the initial flow.
* Setup reads and updates the existing private environment configuration. Preserve unrelated settings and working values. Replace credentials only through an explicit reconnect or correction step, without clearing OAuth installation or session state.
* Resume by inspecting existing configuration and available connection checks. Do not introduce a wizard-state database, workflow engine, or separate onboarding state model.
* Allow setup and diagnostics to start without complete runtime credentials. Retain strict validation for normal bridge startup.
* Use straightforward local-instance detection where available, with a manual URL fallback. Do not build a general discovery service.
* Generate the installation secret when absent and derive callback/webhook addresses from the public base address. Do not silently regenerate existing secrets on rerun.
* Produce a supported Linear application manifest/setup link containing the application name, description, redirect URL, webhook URL, and AgentSessionEvent subscription. Validate the supported manifest fields during implementation; do not claim pre-filling fields the API does not support.
* The user reviews the application form, supplies developer-specific details and generated credentials, and completes the existing app-actor OAuth installation. Reuse existing application configuration on reruns.
* Setup explains the difference between app credentials and workspace authorization. Once local/public bridge health passes, request the app-actor authorization link through the authenticated install endpoint and open the default browser automatically. Keep the installation secret out of URLs and output. Validate the returned Linear origin, app client ID and callback against setup's settings before launching.
* Wait for the OAuth callback's saved installation, then run diagnostics. Missing/stale services prompt for repair and Enter-to-retry; interrupted input exits incomplete without discarding saved state. Browser failure or `--no-browser` displays the direct Linear authorization link. Enter during authorization retries expired/failed links. Existing valid-looking installations skip browser authorization; `--reconnect-linear` explicitly requests replacement without deleting existing tokens. Doctor remains read-only and never opens a browser.
* Use <issue id="5640c5a6-321e-4b1f-a7a2-8cf35837e4a0" href="https://linear.app/northstar-tech-advisory/issue/NOR-198/route-linear-projects-by-t3code-project-title-and-inherit-t3code">NOR-198</issue>'s exact title-based association, active-project selection, ambiguity checks, and inherited execution settings. Provide first-project instructions and reuse existing resolution behavior for diagnostics; do not introduce another routing model or automatic label provisioning.
* Keep doctor read-only at the product level: it must not change user configuration, provision resources, start agent turns, create worktrees or branches, push, or post Linear messages. Repairs happen through setup or documented commands.
* Report checks individually as passed, failed, or unverified, with component-specific next steps. Missing prerequisites must not prevent unrelated checks from running.
* Check required executables/runtime, T3Code reachability/authentication/API compatibility, Linear installation/app identity, selected project matching/effective settings, repository/worktree access, Git identity/GitHub authentication, and public HTTPS reachability where these can be inspected without work-producing actions.
* Distinguish process liveness, signed intake, public reachability, actual Linear webhook receipt, and end-to-end delivery. A successful health request or synthetic intake does not prove actual Linear receipt or execution. Leave unavailable evidence and write permissions unverified; do not add an observability subsystem just to establish them.
* Verify the supported T3Code credential acquisition and lifetime during implementation. Document replacement/reconnect steps and detect authentication failures. Manual renewal is sufficient; use automatic renewal only if T3Code already exposes a straightforward supported mechanism.
* Completion means configuration and available connection checks have passed. Show remaining unverified delivery/execution checks separately and point to normal delegation instructions. Do not require a coding task to complete onboarding.
* Document same-host operation and the shared filesystem requirement, one persistent HTTPS tunnel example, a reverse-proxy alternative, and macOS/Linux service operation without hard-coded Node installation paths.
* Separate quickstart, operations/troubleshooting, and maintainer verification. Keep the required build in the quickstart; keep contributor typechecking and detailed internals outside it.

## Testing Decisions

Exercise the setup and doctor command boundary with temporary configuration and fake Linear/T3Code services. Prefer the existing subprocess configuration-test pattern and fake-service/temporary-repository patterns from the bridge integration suite. Add only the minimal command harness needed; avoid a parallel framework or tests of private helper structure.

Good tests assert observable behavior: prompts and next steps, resulting configuration, diagnostics and exit outcomes, preservation of credentials/state, and absence of work-producing effects.

Cover:

* Fresh setup, incomplete configuration, interruption and rerun, and rerunning a completed setup without duplicating application configuration.
* Preservation of existing and unrelated values; generation only of missing secrets; redaction of credentials in output.
* Base-address URL derivation and manifest contents using the supported Linear contract.
* Diagnostics for missing tools, connection failures, authentication rejection, incompatible APIs, absent Linear installation, invalid/ambiguous project association, and inaccessible repositories.
* Independent checks continuing when another prerequisite is missing; concrete repair instructions and honest unverified outcomes.
* Credential correction followed by successful rechecking without deleting or resetting existing session/installation state.
* No agent turns, messages, branches, worktrees, pushes, or PRs caused by doctor or onboarding completion.
* Completion wording that does not imply real webhook receipt or end-to-end delivery.

Manually walk the documented onboarding path from a fresh checkout against real existing installations, recording steps and friction. Verify the application form and supported credential procedure. Stop at setup completion; no delegation or draft-PR exercise is required. Retain the existing comprehensive maintainer acceptance procedures separately.

## Out of Scope

* A dedicated Linear-to-T3Code connection-test mode.
* Draft-PR exercises or coding tasks in onboarding.
* Redesigning the OAuth installation callback.
* Installing tunnels, provisioning accounts, or generating/installing background-service wrappers.
* A wizard-state store, workflow engine, generalized discovery service, or new diagnostics platform.
* Automatic repairs by doctor or speculative credential-refresh infrastructure.
* Changes to <issue id="5640c5a6-321e-4b1f-a7a2-8cf35837e4a0" href="https://linear.app/northstar-tech-advisory/issue/NOR-198/route-linear-projects-by-t3code-project-title-and-inherit-t3code">NOR-198</issue> routing and execution-setting semantics.
* Running the full restart, cancellation, approval, and delivery acceptance suite as a new-user requirement.

## Further Notes

This agreed scope supersedes <issue id="cee64cd6-b079-4ce4-870b-88098d32f21b" href="https://linear.app/northstar-tech-advisory/issue/NOR-199/simplify-first-time-setup-for-existing-linear-and-t3code-users">NOR-199</issue>'s original requirements for a dedicated connection-test response, optional draft-PR validation in onboarding, and richer installation callback.

<issue id="5640c5a6-321e-4b1f-a7a2-8cf35837e4a0" href="https://linear.app/northstar-tech-advisory/issue/NOR-198/route-linear-projects-by-t3code-project-title-and-inherit-t3code">NOR-198</issue> remains the owner of title-based project routing and inherited T3Code execution settings. This feature exposes that behavior through instructions and diagnostics.

The scope retains the original bridge specification's boundary against new provisioning deliverables and launchd wrappers. Service-management documentation is included.

Linear manifest reference for implementation verification: [https://linear.app/developers/oauth-app-manifests](<https://linear.app/developers/oauth-app-manifests>)

This specification does not claim that the manifest fields or credential lifecycle have already been validated against current external services. That verification belongs to implementation and the fresh-checkout walkthrough.

Local specification: `docs/specs/first-time-setup.md`.
