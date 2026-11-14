package app.eryon.identity.forge.mixins;

import app.eryon.identity.forge.StartupSplashOverlay;
import net.minecraft.client.Minecraft;
import net.minecraft.client.renderer.texture.TextureManager;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(Minecraft.class)
public abstract class MinecraftSplashMixin {
    @Inject(
        method = "drawSplashScreen",
        at = @At(
            value = "INVOKE",
            target = "Lnet/minecraft/client/Minecraft;updateDisplay()V",
            shift = At.Shift.BEFORE
        )
    )
    private void eryon$drawCustomSplashBackground(
        TextureManager textureManager,
        CallbackInfo ci
    ) {
        StartupSplashOverlay.drawWindowSplash((Minecraft) (Object) this);
    }
}
