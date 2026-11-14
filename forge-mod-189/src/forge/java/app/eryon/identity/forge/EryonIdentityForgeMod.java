package app.eryon.identity.forge;

import net.minecraftforge.fml.common.Mod;
import net.minecraft.client.Minecraft;
import net.minecraftforge.fml.common.event.FMLPreInitializationEvent;
import net.minecraftforge.fml.common.event.FMLInitializationEvent;
import org.apache.logging.log4j.LogManager;
import org.apache.logging.log4j.Logger;

@Mod(
    modid = "eryon_identity",
    name = "ERYON Identity",
    version = "1.0.0",
    clientSideOnly = true,
    acceptedMinecraftVersions = "[1.8.9]"
)
public final class EryonIdentityForgeMod {
    public static final Logger LOGGER =
        LogManager.getLogger("ERYON Identity");

    @Mod.EventHandler
    public void preInit(FMLPreInitializationEvent event) {
        PresenceCache.start();
    }

    @Mod.EventHandler
    public void init(FMLInitializationEvent event) {
        // La sugerencia vanilla "Press 'E' to open your inventory" se
        // controla con esta opcion en GameSettings. Desactivarla no cambia
        // la tecla ni el funcionamiento del inventario.
        Minecraft.getMinecraft().gameSettings.showInventoryAchievementHint = false;
    }
}
