# Lavalink v4 private experiment reference

This document preserves the owner-only music experiment for possible future work. Music is not a supported public feature in Xiaoji 1.1.0, `/music` is limited to `BOT_OWNER_ID` in `DISCORD_GUILD_ID`, and every source or playback attempt may fail. Nothing in this document is a public availability, YouTube resolution, audible playback, production SLA, or release-acceptance claim. The current NyankoHost bot container is Node-only and must not be treated as a Java/Docker sidecar host.

This retained bundle pins Lavalink `4.2.2`, LavaSrc `4.8.3`, yt-dlp `2026.07.04`, and Deno `2.9.5`. Its internal configuration follows the linked upstream projects, but pinning does not prove that YouTube will accept or serve a requested item. Both Lavalink's built-in YouTube source and the separate youtube-source plugin are disabled.

The built-in SoundCloud source is enabled only for a final same-track fallback. The bot sends a finite set of explicit `scsearch:` queries, derived only from trusted title identity, after a YouTube URL resolved to trusted non-live metadata and both YouTube playback paths failed. Every result still passes exact normalized title/artist/version semantics and a two-second duration tolerance; ambiguous equal matches fail closed. Lavalink and SoundCloud remain credential-free, and SoundCloud is never described as direct YouTube audio.

The yt-dlp release asset and Deno archive are downloaded from immutable release URLs and verified with their official SHA-256 digests during the Docker build. Deno supplies the external JavaScript runtime now required for full YouTube challenge support. The separate bot-local yt-dlp fallback may receive `--cookies` only after an explicitly configured `YOUTUBE_COOKIES_PATH` passes exact `BOT_OWNER_ID` and `DISCORD_GUILD_ID` checks. The source must be an absolute, non-symlink Netscape cookie file no larger than 1 MiB with private permissions. Xiaoji validates and reads it through one open handle, rechecks the source identity before each spawn, and passes both metadata and audio subprocesses the same short-lived private snapshot instead of the original path. The snapshot is removed after success, failure, timeout, or process error; diagnostics expose only finite categories. Do not add browser Cookie database access, `--cookies-from-browser`, OAuth, proof tokens, visitor data, account passwords, remote components, proxies, IP rotation, or alternate client identities.

LavaSrc providers and all unrelated LavaSrc sources are disabled. Playlist and mix limits remain one in the retained experiment; this restriction is not a statement that any category of video is supported.

## Start on a separate Docker host

```bash
cd deploy/lavalink
cp lavalink.env.example lavalink.env
# Replace LAVALINK_SERVER_PASSWORD with a long random value.
mkdir -p plugins
sudo chown -R 322:322 plugins
docker compose --env-file lavalink.env config
docker compose --env-file lavalink.env up -d
docker compose --env-file lavalink.env ps
docker compose --env-file lavalink.env logs --tail=200 lavalink
```

The safe default binds port 2333 to `127.0.0.1`. For a bot on another host, expose Lavalink through a TLS reverse proxy and firewall it to the bot host, or set `LAVALINK_BIND_ADDRESS=0.0.0.0` only on a private network/firewalled interface. Never publish an unprotected node to the internet.

## Bot environment

```env
LAVALINK_HOST=lavalink.example.com
LAVALINK_PORT=443
LAVALINK_PASSWORD=the_same_long_random_password
LAVALINK_SECURE=true
LAVALINK_NODE_NAME=ProductionLavalink
LAVALINK_RECONNECT_TRIES=10
LAVALINK_RECONNECT_INTERVAL_MS=5000
LAVALINK_ALLOW_PUBLIC_FALLBACK=false
```

If the owner resumes this experiment in a later version, restart Xiaoji and use `/music status` only as internal diagnostics. A future support decision would require fresh evidence such as:

1. `configurationMode: self-hosted` and `publicFallbackEnabled: false`.
2. At least one runtime node is `connected`.
3. A normal YouTube `watch`, `shorts`, and `youtu.be` URL resolves and produces a Lavalink `TrackStartEvent`/player start plus advancing position.
4. Lavalink logs show LavaSrc `4.8.3` loaded, with yt-dlp `2026.07.04` and Deno `2.9.5` available without source exceptions.
5. When testing the optional same-track fallback, the Discord success reply says `SoundCloud 同曲備援` and `/music status` reports the actual current source as `soundcloud`; a no-match or ambiguous match must fail without reporting playback.

`/music test` only plays a local generated tone. It validates Discord voice/ffmpeg, not YouTube or Lavalink source loading.

Public fallback can be enabled temporarily with `LAVALINK_ALLOW_PUBLIC_FALLBACK=true` plus explicit `LAVALINK_PUBLIC_FALLBACK_HOST`, port, password, and secure-mode values from that provider. No public node password is embedded in the repository. Fallback is off by default, unsupported for production acceptance, and may disappear or reject traffic without notice.

## Deploy a hobby node on Render

The repository root includes a `render.yaml` Blueprint and a digest-pinned Dockerfile under `deploy/lavalink`. The Blueprint deploys a free Singapore web service, prompts for `LAVALINK_SERVER_PASSWORD`, uses Render's injected `PORT`, and limits the JVM heap to 384 MiB.

1. Open `https://dashboard.render.com/blueprints` and create a Blueprint from `https://github.com/xichengyu810067-lab/xiaoji`.
2. Keep the Blueprint path as `render.yaml` and provide a new long random `LAVALINK_SERVER_PASSWORD` when prompted.
3. Wait for `xiaoji-lavalink` to become live and confirm the logs show Lavalink 4.2.2 plus LavaSrc 4.8.3; the Docker build also validates the pinned yt-dlp and Deno versions.
4. Configure Xiaoji with the generated `*.onrender.com` hostname, port `443`, the same password, and `LAVALINK_SECURE=true`.

Render's free web service has no production SLA and may restart or spin down. If a future private experiment requires a different availability profile, reassess the host at that time; this retained deployment recipe does not establish playback support.
