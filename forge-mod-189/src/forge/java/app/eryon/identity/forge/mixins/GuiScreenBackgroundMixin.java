package app.eryon.identity.forge.mixins;

import app.eryon.identity.forge.SplashBackground;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiMultiplayer;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

import java.io.File;
import java.io.FileWriter;
import java.io.IOException;
import java.util.Date;

/**
 * El fondo del multijugador (dirt vanilla) sale de GuiScreen.drawDefaultBackground.
 * Lo cancelamos y pintamos el fondo Eryon SOLO mientras la pantalla activa es
 * el multijugador; en el resto de pantallas el metodo vanilla sigue igual.
 */
@Mixin(net.minecraft.client.gui.GuiScreen.class)
public abstract class GuiScreenBackgroundMixin {

    @Unique
    private static boolean eryon$debugEscrito;

    @Inject(method = "drawDefaultBackground", at = @At("HEAD"), cancellable = true)
    private void eryon$fondoMultijugador(CallbackInfo ci) {
        if (!eryon$debugEscrito) {
            eryon$debugEscrito = true;
            eryon$escribirDebug("GuiScreenBackgroundMixin APLICADO (handler corriendo)");
        }
        Minecraft minecraft = Minecraft.getMinecraft();
        if (!(minecraft.currentScreen instanceof GuiMultiplayer)) return;
        SplashBackground.drawMenuBackground(minecraft, minecraft.getTextureManager());
        ci.cancel();
    }

    @Unique
    private static void eryon$escribirDebug(String mensaje) {
        try {
            File archivo = new File(Minecraft.getMinecraft().mcDataDir,
                "logs/eryon-mixin-debug.log");
            FileWriter escritor = new FileWriter(archivo, true);
            escritor.write(new Date() + " - " + mensaje + "\n");
            escritor.close();
        } catch (IOException ignored) {
        }
    }
}
