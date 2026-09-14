# 6: Supply refreshed Linear context and attachments with external link handoff

## Parent

[NOR-173](https://linear.app/northstar-tech-advisory/issue/NOR-173/fork-linear-pi-agent-to-build-a-linear-t3code-agent-bridge)

## What to build

Each turn receives current Linear discussion and attachments, directly related issue context, and links for T3Code to fetch externally, with visible missing-material handling.

## Acceptance criteria

- [ ] Collect issue title/description, all existing text comments with author/chronology and Linear attachments; include directly related issues with their comments/attachments without recursive graph traversal.
- [ ] Refresh before each turn and identify changes; preserve further links and delegate all non-Linear-source fetching to T3Code.
- [ ] Provide a context inventory distinguishing supplied/read, summarized, unavailable and externally delegated content; never imply a passed URL was fetched.
- [ ] Continue with accessible material unless explicitly required material is missing, then pause and report the prerequisite; re-check it on explicit continuation.
- [ ] Treat retrieved material as untrusted context, not bridge configuration or executable routing instructions. Verify attachment access failures, pagination, refresh, visible omissions and that the bridge does not fetch external documents.

## Blocked by

- Draft 4: Queue follow-ups durably and pause them after failed turns
