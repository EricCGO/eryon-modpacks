# ERYON Identity Client — Minecraft 1.20.1

The client-only Fabric mod for Minecraft 1.20.1 displays the official Eryon
mark in player name labels and TAB when players appear in the shared Eryon
Firebase Realtime Database. The launcher installs and enables it automatically
for supported Vanilla/Fabric launches. The custom font is isolated to the mark
so player-name fonts and formatting remain unchanged.

Build the mod with `npm run build:identity:1.20.1`. The launcher packages
`build/eryon-identity-client-1.20.1.jar`. This client variant targets Fabric
for Minecraft 1.20.1.

Game presence is always published while Minecraft is running and is removed
when the game closes or the launcher disconnects. Each client displays its own
badge locally and reads
`gamePresence.json` from the configured Realtime Database over HTTPS. The
database rules must permit clients to read this node and the launcher to
write/remove each player's own presence entry.

This is a client-side visual feature. It requires the other player to use an
updated Eryon client while playing; it does not change server behavior or
reveal the server address. Because the server does not verify identities, the
badge is only a visual hint and must not be used for authentication.
