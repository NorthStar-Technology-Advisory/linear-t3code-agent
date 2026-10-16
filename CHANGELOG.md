# Changelog

## 1.0.0 — Filter/forwarder replacement

- Delete the former execution/orchestration engine, OAuth onboarding, Linear publication, PR handling, workspace cleanup and their obsolete tests/runbooks.
- Add signed, scoped webhook classification and raw-byte forwarding to native T3 webhook tasks.
- Add restart-safe receipt deduplication, bounded requests, fixed-destination delivery and safe audit logs.
- Retain the existing service name/port/route and preserve historical runtime data untouched.
- Clean dist before every build so deleted execution modules cannot survive an upgrade.

Earlier release history is preserved in Git.
