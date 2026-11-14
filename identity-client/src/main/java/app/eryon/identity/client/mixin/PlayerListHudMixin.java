package app.eryon.identity.client.mixin;

import app.eryon.identity.client.BadgeText;
import app.eryon.identity.client.IdentityState;
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
    private void eryon$addIdentityBadge(
        PlayerListEntry entry,
        CallbackInfoReturnable<Text> cir
    ) {
        if (!IdentityState.shouldShowTab(
            entry.getProfile().getId(),
            entry.getProfile().getName()
        )) return;
        Text displayName = cir.getReturnValue();
        if (displayName != null) cir.setReturnValue(BadgeText.prepend(displayName));
    }
}
