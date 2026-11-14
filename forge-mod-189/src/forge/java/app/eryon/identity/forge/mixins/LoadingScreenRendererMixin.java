package app.eryon.identity.forge.mixins;

import app.eryon.identity.forge.StartupSplashOverlay;
import net.minecraft.client.Minecraft;
import net.minecraft.client.LoadingScreenRenderer;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(LoadingScreenRenderer.class)
public abstract class LoadingScreenRendererMixin {
    @Inject(method = "displayLoadingString", at = @At("HEAD"))
    private void eryon$captureLoadingMessage(String text, CallbackInfo ci) {
        StartupSplashOverlay.setMessage(text);
    }

    @Inject(method = "setLoadingProgress", at = @At("RETURN"))
    private void eryon$drawLoadingProgress(int value, CallbackInfo ci) {
        StartupSplashOverlay.setProgress(value);
        Minecraft minecraft = Minecraft.getMinecraft();
        StartupSplashOverlay.drawWindowSplash(minecraft);
        minecraft.updateDisplay();
    }
}
