package app.eryon.identity.forge;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;

// Lee gamePresence.json del Realtime de Firebase por HTTPS
// (misma fuente que la version Fabric). Solo APIs de Java 8 y
// gson antiguo (2.2.4) portado a la 1.8.9.
public final class PresenceCache {
    private static final Set<String> ONLINE_PLAYERS =
        ConcurrentHashMap.newKeySet();
    private static final String LOCAL_PLAYER = System
        .getProperty("eryon.playerName", "")
        .trim()
        .toLowerCase(Locale.ROOT);
    private static final String SESSION_KEY =
        "forge189_" + UUID.randomUUID().toString().replace("-", "");
    private static final long STALE_SESSION_MILLIS = 90000L;
    private static volatile boolean warned;
    private static volatile boolean started;
    private static ScheduledExecutorService executor;

    private PresenceCache() {}

    public static synchronized void start() {
        if (started) return;
        started = true;

        if (!LOCAL_PLAYER.isEmpty()) {
            ONLINE_PLAYERS.add(LOCAL_PLAYER);
        }

        String configuredUrl = System
            .getProperty("eryon.presenceUrl", "")
            .trim();
        if (configuredUrl.isEmpty()) {
            EryonIdentityForgeMod.LOGGER.info(
                "La presencia de otros jugadores no esta configurada; "
                    + "se mostrara tu distintivo local."
            );
            return;
        }

        final URL endpoint;
        try {
            URL parsed = new URL(configuredUrl);
            if (!"https".equalsIgnoreCase(parsed.getProtocol())
                || parsed.getHost() == null
                || parsed.getUserInfo() != null) {
                throw new IllegalArgumentException(
                    "La URL de presencia no es HTTPS valida."
                );
            }
            endpoint = parsed;
        } catch (Exception error) {
            EryonIdentityForgeMod.LOGGER.error(
                "No se pudo iniciar la presencia de Eryon.",
                error
            );
            return;
        }

        executor = Executors.newScheduledThreadPool(2, task -> {
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
        executor.scheduleWithFixedDelay(
            () -> publishPresence(endpoint),
            0,
            30,
            TimeUnit.SECONDS
        );
        Runtime.getRuntime().addShutdownHook(
            new Thread(
                () -> removePresence(endpoint),
                "Eryon-Presence-Cleanup"
            )
        );
    }

    public static boolean isEryonPlayer(String playerName) {
        return playerName != null
            && ONLINE_PLAYERS.contains(
                playerName.toLowerCase(Locale.ROOT)
            );
    }

    private static void refresh(URL endpoint) {
        Exception lastError = null;
        for (int attempt = 0; attempt < 3; attempt++) {
            HttpURLConnection connection = null;
            try {
                connection = (HttpURLConnection) endpoint.openConnection();
                connection.setConnectTimeout(15000);
                connection.setReadTimeout(15000);
                connection.setUseCaches(false);
                connection.setInstanceFollowRedirects(true);
                connection.setRequestProperty("Accept", "application/json");
                connection.setRequestProperty("Cache-Control", "no-cache");
                connection.setRequestProperty(
                    "User-Agent",
                    "Eryon-Identity-Forge/1.0 (Minecraft 1.8.9)"
                );

                int status = connection.getResponseCode();
                if (status < 200 || status >= 300) {
                    if (status >= 500 && attempt < 2) {
                        pauseBeforeRetry(attempt);
                        continue;
                    }
                    warnOnce("Firebase respondio HTTP " + status + ".");
                    return;
                }

                StringBuilder body = new StringBuilder();
                try (InputStream stream = connection.getInputStream()) {
                    byte[] buffer = new byte[4096];
                    int read;
                    while ((read = stream.read(buffer)) != -1) {
                        body.append(
                            new String(buffer, 0, read, StandardCharsets.UTF_8)
                        );
                    }
                }

                updatePlayers(body.toString());
                warned = false;
                return;
            } catch (Exception error) {
                lastError = error;
                if (attempt < 2) {
                    pauseBeforeRetry(attempt);
                }
            } finally {
                if (connection != null) {
                    connection.disconnect();
                }
            }
        }

        warnOnce(
            "No se pudo actualizar la lista de jugadores Eryon: "
                + (lastError == null ? "fallo de red" : lastError.getMessage())
        );
    }

    private static void pauseBeforeRetry(int attempt) {
        try {
            Thread.sleep(500L * (attempt + 1));
        } catch (InterruptedException error) {
            Thread.currentThread().interrupt();
        }
    }

    private static void updatePlayers(String body) {
        JsonElement root = new JsonParser().parse(body);
        Set<String> refreshed = ConcurrentHashMap.newKeySet();
        if (root.isJsonObject()) {
            for (Map.Entry<String, JsonElement> entry : root
                .getAsJsonObject()
                .entrySet()) {
                JsonElement value = entry.getValue();
                if (!value.isJsonObject()) continue;
                JsonObject player = value.getAsJsonObject();
                if (!player.has("playing")
                    || !player.get("playing").getAsBoolean()) {
                    continue;
                }
                if (isExpiredForgeSession(player)) continue;
                if (!player.has("name")
                    || !player.get("name").isJsonPrimitive()) {
                    continue;
                }
                String name = player.get("name").getAsString().trim();
                if (!name.isEmpty()) {
                    refreshed.add(name.toLowerCase(Locale.ROOT));
                }
            }
        }
        if (!LOCAL_PLAYER.isEmpty()) {
            refreshed.add(LOCAL_PLAYER);
        }
        ONLINE_PLAYERS.clear();
        ONLINE_PLAYERS.addAll(refreshed);
    }

    private static boolean isExpiredForgeSession(JsonObject player) {
        if (!player.has("app")
            || !player.get("app").isJsonPrimitive()
            || !"eryon-forge-1.8.9".equals(
                player.get("app").getAsString()
            )
            || !player.has("updatedAt")) {
            return false;
        }
        try {
            return System.currentTimeMillis()
                - player.get("updatedAt").getAsLong()
                > STALE_SESSION_MILLIS;
        } catch (RuntimeException ignored) {
            return true;
        }
    }

    private static URL sessionEndpoint(URL endpoint) throws Exception {
        String value = endpoint.toExternalForm();
        int suffix = value.lastIndexOf(".json");
        if (suffix < 0) {
            throw new IllegalArgumentException(
                "La URL de presencia debe terminar en .json."
            );
        }
        return new URL(
            value.substring(0, suffix) + "/" + SESSION_KEY + ".json"
        );
    }

    private static void publishPresence(URL endpoint) {
        if (LOCAL_PLAYER.isEmpty()) return;
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) sessionEndpoint(endpoint)
                .openConnection();
            connection.setRequestMethod("PUT");
            connection.setConnectTimeout(12000);
            connection.setReadTimeout(12000);
            connection.setUseCaches(false);
            connection.setDoOutput(true);
            connection.setRequestProperty(
                "Content-Type",
                "application/json; charset=utf-8"
            );
            connection.setRequestProperty(
                "User-Agent",
                "Eryon-Identity-Forge/1.0 (Minecraft 1.8.9)"
            );

            String json = "{\"name\":\"" + LOCAL_PLAYER
                + "\",\"app\":\"eryon-forge-1.8.9\",\"playing\":true"
                + ",\"updatedAt\":" + System.currentTimeMillis() + "}";
            try (OutputStream stream = connection.getOutputStream()) {
                stream.write(json.getBytes(StandardCharsets.UTF_8));
            }
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) {
                warnOnce(
                    "Firebase no acepto la presencia del juego (HTTP "
                        + status + ")."
                );
            }
        } catch (Exception error) {
            warnOnce(
                "No se pudo publicar la presencia de Forge 1.8.9: "
                    + error.getMessage()
            );
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static void removePresence(URL endpoint) {
        HttpURLConnection connection = null;
        try {
            connection = (HttpURLConnection) sessionEndpoint(endpoint)
                .openConnection();
            connection.setRequestMethod("DELETE");
            connection.setConnectTimeout(3000);
            connection.setReadTimeout(3000);
            connection.getResponseCode();
        } catch (Exception ignored) {
            // The updatedAt timeout removes the record after an unclean exit.
        } finally {
            if (connection != null) connection.disconnect();
        }
    }

    private static void warnOnce(String message) {
        if (warned) return;
        warned = true;
        EryonIdentityForgeMod.LOGGER.warn(message);
    }
}
