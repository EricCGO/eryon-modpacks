# ERYON Identity Client — Minecraft 1.21.1

Client-only Fabric renderer and presence client for Minecraft Java 1.21.1.
The bundled Eryon logo is rendered as a bitmap-font glyph before compatible
players' existing name components in TAB and above player models. Existing
rank/name formatting remains a sibling text component.

The client sends one versioned handshake per server connection. This is a
compatibility signal, not authentication or a security credential. It does not
grant permissions or gameplay advantages.

For servers without the Eryon server mod, the launcher-connected client also
reads the existing `gamePresence` list from its configured Firebase Realtime
Database and matches player UUIDs against the connected server's player list.
This does not send the Minecraft server address and requires no server mod.
Players must share the same Firebase project, have active launcher game
presence, and be visible in each other's player list. Presence is a visual
hint only; servers running offline-mode identities may be matched by name,
which can produce false positives. Without server verification presence can
also be spoofed. The database rules must allow reading `gamePresence`.

The launcher builds and installs this jar for supported Vanilla/Fabric 1.21.1
launches. Fabric API is nested in the jar. Vanilla Minecraft clients and other
clients without Eryon Identity cannot render this custom glyph; displaying it
to them requires a server-synchronized resource pack and a compatible
client-side font.
