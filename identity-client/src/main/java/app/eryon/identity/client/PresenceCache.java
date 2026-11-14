package app.eryon.identity.client;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.minecraft.client.MinecraftClient;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

public final class PresenceCache {
    private static final Set<UUID> ERYON_PLAYERS = ConcurrentHashMap.newKeySet();
    private static final Set<String> ERYON_NAMES = ConcurrentHashMap.newKeySet();
    private static volatile String localPlayer = "";
    private static final HttpClient HTTP = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(5))
        .build();
    private static ScheduledExecutorService executor;
    private static volatile boolean warned;

    private PresenceCache() {}

    public static synchronized void start() {
        stop();
        String playerName = System.getProperty("eryon.playerName", "").trim();
        if (playerName.isEmpty()) {
            playerName = MinecraftClient.getInstance().getSession().getUsername();
        }
        localPlayer = playerName.toLowerCase(Locale.ROOT);
        addLocalPlayer();

        String configuredUrl = System.getProperty("eryon.presenceUrl", "").trim();
        if (configuredUrl.isEmpty()) {
            EryonIdentityClient.LOGGER.info(
                "La presencia de otros jugadores Eryon no está configurada."
            );
            return;
        }

        URI endpoint;
        try {
            endpoint = URI.create(configuredUrl);
            if (!"https".equalsIgnoreCase(endpoint.getScheme())
                || endpoint.getHost() == null
                || endpoint.getUserInfo() != null
                || endpoint.getQuery() != null
                || endpoint.getFragment() != null) {
                throw new IllegalArgumentException("La URL de presencia no es HTTPS válida.");
            }
        } catch (IllegalArgumentException error) {
            EryonIdentityClient.LOGGER.error("No se pudo iniciar la presencia de Eryon.", error);
            return;
        }

        executor = Executors.newSingleThreadScheduledExecutor(task -> {
            Thread thread = new Thread(task, "Eryon-Identity-Presence");
            thread.setDaemon(true);
            return thread;
        });
        executor.scheduleWithFixedDelay(
            () -> refresh(endpoint),
            0,
            10,
            TimeUnit.SECONDS
        );
    }

    public static boolean isEryonPlayer(UUID playerId, String playerName) {
        return (playerId != null && ERYON_PLAYERS.contains(playerId))
            || (playerName != null
                && ERYON_NAMES.contains(playerName.toLowerCase(Locale.ROOT)));
    }

    public static synchronized void stop() {
        if (executor != null) {
            executor.shutdownNow();
            executor = null;
        }
        ERYON_PLAYERS.clear();
        ERYON_NAMES.clear();
        addLocalPlayer();
        warned = false;
    }

    private static void refresh(URI endpoint) {
        try {
            HttpRequest request = HttpRequest.newBuilder(endpoint)
                .timeout(Duration.ofSeconds(8))
                .header("Accept", "application/json")
                .GET()
                .build();
            HttpResponse<String> response = HTTP.send(
                request,
                HttpResponse.BodyHandlers.ofString()
            );
            if (response.statusCode() < 200 || response.statusCode() >= 300) {
                warnOnce("Firebase respondió HTTP " + response.statusCode() + ".");
                return;
            }

            JsonElement root = JsonParser.parseString(response.body());
            Set<UUID> refreshed = ConcurrentHashMap.newKeySet();
            Set<String> refreshedNames = ConcurrentHashMap.newKeySet();
            if (root.isJsonObject()) {
                JsonObject players = root.getAsJsonObject();
                for (JsonElement value : players.asMap().values()) {
                    if (!value.isJsonObject()) continue;
                    JsonObject player = value.getAsJsonObject();
                    if (!player.has("playing")
                        || !player.get("playing").isJsonPrimitive()
                        || !player.get("playing").getAsBoolean()
                        || !player.has("uuid")
                        || !player.get("uuid").isJsonPrimitive()) {
                        continue;
                    }
                    try {
                        refreshed.add(UUID.fromString(player.get("uuid").getAsString()));
                    } catch (IllegalArgumentException ignored) {
                        // Ignore malformed entries while retaining valid player identities.
                    }
                    if (player.has("name") && player.get("name").isJsonPrimitive()) {
                        String name = player.get("name").getAsString().trim();
                        if (name.matches("[A-Za-z0-9_]{3,16}")) {
                            refreshedNames.add(name.toLowerCase(Locale.ROOT));
                        }
                    }
                }
            }

            ERYON_PLAYERS.clear();
            ERYON_PLAYERS.addAll(refreshed);
            ERYON_NAMES.clear();
            ERYON_NAMES.addAll(refreshedNames);
            addLocalPlayer();
            warned = false;
        } catch (Exception error) {
            warnOnce("No se pudo actualizar la lista de jugadores Eryon: " + error.getMessage());
        }
    }

    private static void warnOnce(String message) {
        if (warned) return;
        warned = true;
        EryonIdentityClient.LOGGER.warn(message);
    }

    private static void addLocalPlayer() {
        if (!localPlayer.isEmpty() && localPlayer.matches("[a-z0-9_]{3,16}")) {
            ERYON_NAMES.add(localPlayer);
        }
    }
}
