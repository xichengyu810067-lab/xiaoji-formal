# Optional extension contract

The public core may load one local CommonJS extension only when `XIAOJI_PRIVATE_EXTENSION_PATH` is set to an absolute file or directory path. Absence of this variable is a supported public-core mode.

An extension exports `apiVersion: 1`, a stable `id`, optional command directories, deployment targets, interaction guards, and hooks. The host currently supports:

- `guards.interaction`
- `hooks.interactionCreate` and `hooks.messageCreate` (reserved for board and other isolated routers)
- `hooks.guildMemberAdd`, `hooks.ready`, and `hooks.shutdown`
- `hooks.publicCommandCompleted`
- `hooks.workRole.syncJobRoleForMember`
- `hooks.workRole.removeJobRoleForMember`
- `hooks.workRole.removeJobRolesForMember`
- `hooks.workRole.syncAllJobRoles`

Private commands must be registered only to extension-declared guilds. Runtime guards and each background or role side effect must independently enforce the same scope. Owner identity never bypasses the extension scope. Public commands remain global and keep their own existing permission checks.
