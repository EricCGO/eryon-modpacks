package app.eryon.identity.client;

import app.eryon.identity.protocol.IdentityPayloads.Hello;
import app.eryon.identity.protocol.IdentityPayloads.State;
import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayNetworking;
import net.fabricmc.fabric.api.networking.v1.PayloadTypeRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public final class EryonIdentityClient implements ClientModInitializer {
    public static final Logger LOGGER = LoggerFactory.getLogger("Eryon Identity");

    @Override
    public void onInitializeClient() {
        PayloadTypeRegistry.playC2S().register(Hello.ID, Hello.CODEC);
        PayloadTypeRegistry.playS2C().register(State.ID, State.CODEC);

        ClientPlayNetworking.registerGlobalReceiver(State.ID, (payload, context) ->
            context.client().execute(() -> IdentityState.apply(payload.json()))
        );

        ClientPlayConnectionEvents.JOIN.register((handler, sender, client) -> {
            IdentityState.clear();
            PresenceCache.start();
            if (ClientPlayNetworking.canSend(Hello.ID)) {
                ClientPlayNetworking.send(new Hello(
                    app.eryon.identity.protocol.IdentityPayloads.PROTOCOL_VERSION
                ));
            }
        });

        ClientPlayConnectionEvents.DISCONNECT.register((handler, client) -> {
            IdentityState.clear();
            PresenceCache.stop();
        });
    }
}
