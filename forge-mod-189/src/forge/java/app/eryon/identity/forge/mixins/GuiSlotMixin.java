package app.eryon.identity.forge.mixins;

import app.eryon.identity.forge.SplashBackground;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiMultiplayer;
import net.minecraft.client.gui.GuiSlot;
import net.minecraft.client.renderer.texture.TextureManager;
import net.minecraft.util.ResourceLocation;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * La pantalla multijugador dibuja todo su fondo dentro de GuiSlot.drawScreen:
 * primero el dirt vanilla (que en la entrada 1 re-dirigimos a un panel oscuro
 * con GuiSlotMixin#panelSinDirt), luego la lista. Con @At("HEAD") pintamos el
 * fondo Eryon ANTES de todo, de modo que el orden final queda:
 * fondo Eryon -> panel oscuro de la lista -> entradas y scrollbar encima.
 * Solo aplica cuando la pantalla activa es el multijugador.
 */
@Mixin(GuiSlot.class)
public abstract class GuiSlotMixin {

    @Inject(method = "drawScreen", at = @At("HEAD"))
    private void eryon$fondoMenuEryon(CallbackInfo ci) {
        Minecraft minecraft = Minecraft.getMinecraft();
        if (!(minecraft.currentScreen instanceof GuiMultiplayer)) return;
        SplashBackground.drawMenuBackground(minecraft, minecraft.getTextureManager());
    }

    @org.spongepowered.asm.mixin.injection.Redirect(
        method = "drawScreen",
        at = @At(
            value = "INVOKE",
            target = "Lnet/minecraft/client/renderer/texture/TextureManager;bindTexture(Lnet/minecraft/util/ResourceLocation;)V",
            ordinal = 0
        )
    )
    private void eryon$panelSinDirt(TextureManager textureManager, ResourceLocation original) {
        Minecraft minecraft = Minecraft.getMinecraft();
        if (minecraft.currentScreen instanceof GuiMultiplayer) {
            SplashBackground.bindWhiteTexture(textureManager);
        } else {
            textureManager.bindTexture(original);
        }
    }
}
