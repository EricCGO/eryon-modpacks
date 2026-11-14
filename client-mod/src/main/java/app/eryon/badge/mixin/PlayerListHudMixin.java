package app.eryon.badge.mixin;

import app.eryon.badge.BadgeText;
import net.minecraft.client.gui.hud.PlayerListHud;
import net.minecraft.client.network.PlayerListEntry;
import net.minecraft.text.Text;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(PlayerListHud.class)
public abstract class PlayerListHudMixin {
    @Inject(method = "getPlayerName", at = @At("RETURN"), cancellable = true)
    private void eryon$addBadgeToTab(
        PlayerListEntry entry,
        CallbackInfoReturnable<Text> cir
    ) {
        Text displayName = cir.getReturnValue();
        if (displayName == null) return;
        cir.setReturnValue(
            BadgeText.prependIfEryon(entry.getProfile().getName(), displayName)
        );
    }
}
