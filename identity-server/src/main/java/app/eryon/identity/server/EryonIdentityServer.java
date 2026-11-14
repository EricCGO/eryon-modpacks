package app.eryon.identity.server;

import app.eryon.identity.protocol.IdentityPayloads.Hello;
import app.eryon.identity.protocol.IdentityPayloads.State;
import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.io.IOException;
import java.nio.file.Path;
import java.util.HashSet;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import net.fabricmc.api.ModInitializer;
import net.fabricmc.fabric.api.command.v2.CommandRegistrationCallback;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.networking.v1.PayloadTypeRegistry;
import net.fabricmc.fabric.api.networking.v1.ServerPlayConnectionEvents;
import net.fabricmc.fabric.api.networking.v1.ServerPlayNetworking;
import net.fabricmc.loader.api.FabricLoader;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.network.ServerPlayerEntity;
import net.minecraft.text.Text;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import static net.minecraft.server.command.CommandManager.literal;

public final class EryonIdentityServer implements ModInitializer {
    private static final Logger LOGGER = LoggerFactory.getLogger("Eryon Identity");
    private static final int MAX_TRACKED_CLIENTS = 256;
    private static final Set<UUID> ERYON_PLAYERS = new HashSet<>();
    private static final Set<UUID> ACCEPTED_HELLOS = new HashSet<>();
    private static final Set<UUID> HELLO_ATTEMPTS = ConcurrentHashMap.newKeySet();
    private static final Path CONFIG_PATH =
        FabricLoader.getInstance().getConfigDir().resolve("eryon-identity.json");

    private static volatile IdentityConfig config = new IdentityConfig();

    @Override
    public void onInitialize() {
        PayloadTypeRegistry.playC2S().register(Hello.ID, Hello.CODEC);
        PayloadTypeRegistry.playS2C().register(State.ID, State.CODEC);

        ServerLifecycleEvents.SERVER_STARTING.register(startingServer -> {
            ERYON_PLAYERS.clear();
            ACCEPTED_HELLOS.clear();
            HELLO_ATTEMPTS.clear();
            loadConfig();
        });

        ServerPlayNetworking.registerGlobalReceiver(Hello.ID, (payload, context) -> {
            UUID playerId = context.player().getUuid();
            if (!HELLO_ATTEMPTS.add(playerId)) return;
            if (HELLO_ATTEMPTS.size() > MAX_TRACKED_CLIENTS) {
                HELLO_ATTEMPTS.remove(playerId);
                return;
            }
            context.server().execute(() ->
                acceptHello(context.player(), payload.protocolVersion())
            );
        });

        ServerPlayConnectionEvents.JOIN.register((handler, sender, minecraftServer) ->
            broadcastState(minecraftServer)
        );

        ServerPlayConnectionEvents.DISCONNECT.register((handler, minecraftServer) -> {
            UUID playerId = handler.getPlayer().getUuid();
            ERYON_PLAYERS.remove(playerId);
            ACCEPTED_HELLOS.remove(playerId);
            HELLO_ATTEMPTS.remove(playerId);
            broadcastState(minecraftServer);
        });

        CommandRegistrationCallback.EVENT.register((dispatcher, registryAccess, environment) ->
            dispatcher.register(literal("eryonidentity")
                .requires(source -> source.hasPermissionLevel(2))
                .then(literal("reload").executes(context -> {
                    if (loadConfig()) {
                        broadcastState(context.getSource().getServer());
                        context.getSource().sendFeedback(
                            () -> Text.literal("Eryon Identity: configuración recargada."),
                            true
                        );
                        return 1;
                    }
                    context.getSource().sendError(
                        Text.literal("Eryon Identity: no se pudo leer la configuración; revisa el log.")
                    );
                    return 0;
                }))
            )
        );

        LOGGER.info("Eryon Identity Server listo para Minecraft 1.21.1.");
    }

    private static void acceptHello(ServerPlayerEntity player, int protocolVersion) {
        if (protocolVersion != app.eryon.identity.protocol.IdentityPayloads.PROTOCOL_VERSION) {
            return;
        }
        if (!ACCEPTED_HELLOS.add(player.getUuid())) return;
        if (ACCEPTED_HELLOS.size() > MAX_TRACKED_CLIENTS) {
            ACCEPTED_HELLOS.remove(player.getUuid());
            return;
        }
        ERYON_PLAYERS.add(player.getUuid());
        broadcastState(player.getServer());
    }

    private static boolean loadConfig() {
        try {
            config = IdentityConfig.load(CONFIG_PATH);
            LOGGER.info("Configuración cargada desde {}.", CONFIG_PATH);
            return true;
        } catch (IOException | RuntimeException error) {
            LOGGER.error("No se pudo cargar {}. Se conserva la configuración anterior.", CONFIG_PATH, error);
            return false;
        }
    }

    private static void broadcastState(MinecraftServer minecraftServer) {
        if (minecraftServer == null) return;

        IdentityConfig current = config;
        JsonObject json = new JsonObject();
        json.addProperty(
            "protocol",
            app.eryon.identity.protocol.IdentityPayloads.PROTOCOL_VERSION
        );
        json.addProperty("enabled", current.enabled);
        json.addProperty("showTab", current.showTab);
        json.addProperty("showNametag", current.showNametag);
        json.addProperty("logoSize", current.logoSize);

        Set<UUID> onlinePlayers = new HashSet<>();
        for (ServerPlayerEntity player : minecraftServer.getPlayerManager().getPlayerList()) {
            onlinePlayers.add(player.getUuid());
        }

        Set<UUID> displayedPlayers = new HashSet<>();
        if (current.enabled) {
            if (current.identifyAllPlayers) {
                displayedPlayers.addAll(onlinePlayers);
            } else {
                for (UUID playerId : ERYON_PLAYERS) {
                    if (onlinePlayers.contains(playerId)) displayedPlayers.add(playerId);
                }
            }
        }

        JsonArray identities = new JsonArray();
        for (UUID playerId : displayedPlayers) identities.add(playerId.toString());
        json.add("players", identities);
        String stateJson = json.toString();
        if (stateJson.length() > 16_384) {
            LOGGER.error("Se canceló una actualización de identidad que superaba el límite de tamaño.");
            return;
        }

        State payload = new State(stateJson);
        for (ServerPlayerEntity player : minecraftServer.getPlayerManager().getPlayerList()) {
            if (ServerPlayNetworking.canSend(player, State.ID)) {
                ServerPlayNetworking.send(player, payload);
            }
        }
    }
}
