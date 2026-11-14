package app.eryon.identity.forge.mixins;

import app.eryon.identity.forge.BadgeText;
import app.eryon.identity.forge.BadgeRenderer;
import app.eryon.identity.forge.LabelContext;
import net.minecraft.client.renderer.entity.Render;
import net.minecraft.client.gui.FontRenderer;
import net.minecraft.entity.player.EntityPlayer;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.ModifyVariable;

// El texto del nombre flotante llega como argumento String de
// Render#renderLivingLabel (metodo final de la cadena: su
// firma erasada es (Entity, String, DDD, int)). La entidad
// capturada por RendererLivingEntityMixin sigue siendo valida
// aqui porque renderLivingLabel solo se llama dentro de
// renderName.
@Mixin(Render.class)
public abstract class RenderMixin {
    @ModifyVariable(
        method = "renderLivingLabel",
        at = @At("HEAD"),
        argsOnly = true,
        ordinal = 0
    )
    private String eryon$addBadgeToNametag(String text) {
        try {
            Object entity = LabelContext.current();
            if (entity instanceof EntityPlayer
                && BadgeText.isEryonPlayer(
                    ((EntityPlayer) entity).getName()
                )) {
                return BadgeText.BADGE_PREFIX + text;
            }
        } catch (Throwable error) {
            // El distintivo jamas rompe el renderizado.
        }
        return text;
    }

    @Inject(
        method = "renderLivingLabel",
        at = @At(
            value = "INVOKE",
            target = "Lnet/minecraft/client/gui/FontRenderer;drawString(Ljava/lang/String;III)I"
        )
    )
    private void eryon$drawBadgeOnNametag(
        net.minecraft.entity.Entity entity,
        String text,
        double x,
        double y,
        double z,
        int maxDistance,
        CallbackInfo ci
    ) {
        try {
            Object labelEntity = LabelContext.current();
            if (labelEntity instanceof EntityPlayer
                && BadgeText.isEryonPlayer(
                    ((EntityPlayer) labelEntity).getName()
                )) {
                FontRenderer font =
                    net.minecraft.client.Minecraft.getMinecraft().fontRendererObj;
                int left = -font.getStringWidth(text) / 2;
                BadgeRenderer.draw(left, 0, 8);
            }
        } catch (Throwable error) {
            // El distintivo nunca debe romper el renderizado del nombre.
        }
    }
}
