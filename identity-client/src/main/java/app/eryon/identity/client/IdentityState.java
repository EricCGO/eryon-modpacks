package app.eryon.identity.client;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

public final class IdentityState {
    private static final int MAX_STATE_LENGTH = 16_384;
    private static final Set<UUID> ERYON_PLAYERS = ConcurrentHashMap.newKeySet();
    private static volatile boolean enabled;
    private static volatile boolean showTab = true;
    private static volatile boolean showNametag = true;
    private static volatile boolean serverStateReceived;
    private static volatile String logoSize = "medium";

    private IdentityState() {}

    public static void apply(String json) {
        if (json == null || json.length() > MAX_STATE_LENGTH) {
            clear();
            return;
        }

        try {
            JsonObject state = JsonParser.parseString(json).getAsJsonObject();
            if (!state.has("protocol")
                || state.get("protocol").getAsInt()
                    != app.eryon.identity.protocol.IdentityPayloads.PROTOCOL_VERSION) {
                clear();
                return;
            }
            Set<UUID> refreshed = ConcurrentHashMap.newKeySet();
            JsonArray players = state.getAsJsonArray("players");
            if (players == null || players.size() > 256) {
                clear();
                return;
            }

            for (JsonElement value : players) {
                if (!value.isJsonPrimitive() || !value.getAsJsonPrimitive().isString()) {
                    continue;
                }
                try {
                    refreshed.add(UUID.fromString(value.getAsString()));
                } catch (IllegalArgumentException ignored) {
                    // Ignore malformed server entries without dropping valid players.
                }
            }

            ERYON_PLAYERS.clear();
            ERYON_PLAYERS.addAll(refreshed);
            serverStateReceived = true;
            enabled = state.has("enabled") && state.get("enabled").getAsBoolean();
            showTab = state.has("showTab") && state.get("showTab").getAsBoolean();
            showNametag = state.has("showNametag") && state.get("showNametag").getAsBoolean();
            String size = state.has("logoSize") ? state.get("logoSize").getAsString() : "medium";
            logoSize = switch (size) {
                case "small", "large" -> size;
                default -> "medium";
            };
        } catch (RuntimeException error) {
            EryonIdentityClient.LOGGER.warn("El servidor envió un estado Eryon Identity inválido.", error);
            clear();
        }
    }

    public static boolean shouldShowTab(UUID playerId, String playerName) {
        if (serverStateReceived) {
            return enabled && showTab && ERYON_PLAYERS.contains(playerId);
        }
        return PresenceCache.isEryonPlayer(playerId, playerName);
    }

    public static boolean shouldShowNametag(UUID playerId, String playerName) {
        if (serverStateReceived) {
            return enabled && showNametag && ERYON_PLAYERS.contains(playerId);
        }
        return PresenceCache.isEryonPlayer(playerId, playerName);
    }

    public static String logoSize() {
        return logoSize;
    }

    public static void clear() {
        ERYON_PLAYERS.clear();
        enabled = false;
        showTab = true;
        showNametag = true;
        serverStateReceived = false;
        logoSize = "medium";
    }
}
