# Xiaoji public-core repository guidance

- Preserve the public/private extension boundary in `docs/EXTENSION_CONTRACT.md`.
- Public core must start and load commands when no private extension is configured.
- Keep admission control separate from Discord server-management side effects: approved guilds may use public features, while optional side effects remain extension-owned.
- Never commit `.env`, runtime JSON, SQLite databases, cookies, deployment evidence, internal reports, or generated exports.
- Do not add private command names, private guild IDs, private module paths, or internal operations to public help, docs, status catalogs, release notes, tests, or export output.
- Public export uses an allowlist and must not copy Git history.
