package app.eryon.badge;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

public final class PresenceCache {
    private static final Set<String> ONLINE_PLAYERS = ConcurrentHashMap.newKeySet();
    private static final String LOCAL_PLAYER = System.getProperty("eryon.playerName", "")
        .trim()
        .toLowerCase(Locale.ROOT);
    private static final HttpClient HTTP = HttpClient.newBuilder()
        .connectTimeout(Duration.ofSeconds(5))
        .build();
    private static volatile boolean warned;

    private PresenceCache() {}

    public static void start() {
        if (!LOCAL_PLAYER.isEmpty()) ONLINE_PLAYERS.add(LOCAL_PLAYER);

        String configuredUrl = System.getProperty("eryon.presenceUrl", "").trim();
        if (configuredUrl.isEmpty()) {
            EryonIdentityClient.LOGGER.info(
                "La presencia de otros jugadores no está configurada; se mostrará tu distintivo local."
            );
            return;
        }

        URI endpoint;
        try {
            endpoint = URI.create(configuredUrl);
            if (!"https".equalsIgnoreCase(endpoint.getScheme())
                || endpoint.getHost() == null
                || endpoint.getUserInfo() != null) {
                throw new IllegalArgumentException("La URL de presencia no es HTTPS válida.");
            }
        } catch (IllegalArgumentException error) {
            EryonIdentityClient.LOGGER.error("No se pudo iniciar la presencia de Eryon.", error);
            return;
        }

        ScheduledExecutorService executor = Executors.newSingleThreadScheduledExecutor(task -> {
            Thread thread = new Thread(task, "Eryon-Presence");
            thread.setDaemon(true);
            return thread;
        });
        executor.scheduleWithFixedDelay(
            () -> refresh(endpoint),
            0,
            15,
            TimeUnit.SECONDS
        );
    }

    public static boolean isEryonPlayer(String playerName) {
        return playerName != null
            && ONLINE_PLAYERS.contains(playerName.toLowerCase(Locale.ROOT));
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
            Set<String> refreshed = ConcurrentHashMap.newKeySet();
            if (root.isJsonObject()) {
                for (JsonElement value : root.getAsJsonObject().asMap().values()) {
                    if (!value.isJsonObject()) continue;
                    JsonObject player = value.getAsJsonObject();
                    if (!player.has("playing") || !player.get("playing").getAsBoolean()) {
                        continue;
                    }
                    if (!player.has("name") || !player.get("name").isJsonPrimitive()) {
                        continue;
                    }
                    String name = player.get("name").getAsString().trim();
                    if (!name.isEmpty()) refreshed.add(name.toLowerCase(Locale.ROOT));
                }
            }
            if (!LOCAL_PLAYER.isEmpty()) refreshed.add(LOCAL_PLAYER);
            ONLINE_PLAYERS.clear();
            ONLINE_PLAYERS.addAll(refreshed);
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
}
