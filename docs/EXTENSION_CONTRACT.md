# Optional extension contract

The public core may load one local CommonJS extension only when `XIAOJI_PRIVATE_EXTENSION_PATH` is set to an absolute file or directory path. Absence of this variable is a supported public-core mode.

An extension exports `apiVersion: 1`, a stable `id`, optional command directories, deployment targets, interaction guards, and hooks. The host currently supports:

- `guards.interaction`
- `hooks.interactionCreate` and `hooks.messageCreate` (reserved for board and other isolated routers)
- `hooks.guildMemberAdd`, `hooks.ready`, and `hooks.shutdown`
- `hooks.channelDelete` and `hooks.voiceStateUpdate`
- `hooks.publicCommandCompleted`
- `hooks.workRole.syncJobRoleForMember`
- `hooks.workRole.removeJobRoleForMember`
- `hooks.workRole.removeJobRolesForMember`
- `hooks.workRole.syncAllJobRoles`

Each private command-directory descriptor may declare its own `guildIds`. Descriptors without `guildIds` retain the extension-level deployment scope for compatibility. Commands from multiple groups are unioned only within guilds shared by those groups. Cleanup may target only guilds no longer owned by any command group and must read back this application's existing guild commands before clearing them.

Private commands must be registered only to their declared guilds. Runtime guards and each background or role side effect must independently enforce the same scope. Owner identity never bypasses the extension scope. Public commands remain global and keep their own existing permission checks.
