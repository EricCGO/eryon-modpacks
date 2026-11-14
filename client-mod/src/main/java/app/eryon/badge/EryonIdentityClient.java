package app.eryon.badge;

import net.fabricmc.api.ClientModInitializer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public final class EryonIdentityClient implements ClientModInitializer {
    public static final Logger LOGGER = LoggerFactory.getLogger("ERYON Identity");

    @Override
    public void onInitializeClient() {
        PresenceCache.start();
    }
}
