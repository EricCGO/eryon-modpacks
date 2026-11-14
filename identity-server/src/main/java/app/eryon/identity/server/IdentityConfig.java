package app.eryon.identity.server;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

final class IdentityConfig {
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();

    boolean enabled = true;
    boolean showTab = true;
    boolean showNametag = true;
    boolean identifyAllPlayers = false;
    String logoSize = "medium";

    static IdentityConfig load(Path file) throws IOException {
        if (Files.notExists(file)) {
            IdentityConfig config = new IdentityConfig();
            config.save(file);
            return config;
        }

        JsonObject json = JsonParser.parseString(Files.readString(file)).getAsJsonObject();
        IdentityConfig config = new IdentityConfig();
        config.enabled = readBoolean(json, "enabled", true);
        config.showTab = readBoolean(json, "showTab", true);
        config.showNametag = readBoolean(json, "showNametag", true);
        config.identifyAllPlayers = readBoolean(json, "identifyAllPlayers", false);
        String size = json.has("logoSize") && json.get("logoSize").isJsonPrimitive()
            ? json.get("logoSize").getAsString()
            : "medium";
        config.logoSize = switch (size) {
            case "small", "large" -> size;
            default -> "medium";
        };
        return config;
    }

    void save(Path file) throws IOException {
        Files.createDirectories(file.getParent());
        Files.writeString(file, GSON.toJson(this));
    }

    private static boolean readBoolean(JsonObject json, String key, boolean fallback) {
        return json.has(key) && json.get(key).isJsonPrimitive()
            ? json.get(key).getAsBoolean()
            : fallback;
    }
}
