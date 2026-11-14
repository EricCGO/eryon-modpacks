package app.eryon.identity.forge.mixins;

import app.eryon.identity.forge.BadgeText;
import app.eryon.identity.forge.BadgeRenderer;
import net.minecraft.client.gui.GuiPlayerTabOverlay;
import net.minecraft.client.gui.FontRenderer;
import net.minecraft.client.network.NetworkPlayerInfo;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.Redirect;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(GuiPlayerTabOverlay.class)
public abstract class GuiPlayerTabOverlayMixin {
    @Inject(
        method = "getPlayerName",
        at = @At("RETURN"),
        cancellable = true
    )
    private void eryon$addBadgeToTab(
        NetworkPlayerInfo entry,
        CallbackInfoReturnable<String> cir
    ) {
        String displayName = cir.getReturnValue();
        if (displayName == null) return;
        String profileName = entry.getGameProfile().getName();
        if (BadgeText.isEryonPlayer(profileName)) {
            cir.setReturnValue(
                BadgeText.BADGE_PREFIX + displayName
            );
        }
    }

    @Redirect(
        method = "renderPlayerlist",
        at = @At(
            value = "INVOKE",
            target = "Lnet/minecraft/client/gui/FontRenderer;drawStringWithShadow(Ljava/lang/String;FFI)I"
        )
    )
    private int eryon$drawBadgeInTab(
        FontRenderer font,
        String text,
        float x,
        float y,
        int color
    ) {
        if (text != null && text.contains(BadgeText.BADGE_PREFIX)) {
            BadgeRenderer.draw(Math.round(x), Math.round(y), 8);
        }
        return font.drawStringWithShadow(text, x, y, color);
    }
}
