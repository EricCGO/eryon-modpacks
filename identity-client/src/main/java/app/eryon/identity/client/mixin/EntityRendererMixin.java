package app.eryon.identity.client.mixin;

import app.eryon.identity.client.BadgeText;
import app.eryon.identity.client.IdentityState;
import net.minecraft.client.render.VertexConsumerProvider;
import net.minecraft.client.render.entity.EntityRenderer;
import net.minecraft.client.util.math.MatrixStack;
import net.minecraft.entity.Entity;
import net.minecraft.entity.player.PlayerEntity;
import net.minecraft.text.Text;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.ModifyVariable;

@Mixin(EntityRenderer.class)
public abstract class EntityRendererMixin {
    @ModifyVariable(
        method = "renderLabelIfPresent",
        at = @At("HEAD"),
        argsOnly = true,
        ordinal = 0
    )
    private Text eryon$addIdentityBadge(
        Text text,
        Entity entity,
        Text originalText,
        MatrixStack matrices,
        VertexConsumerProvider vertexConsumers,
        int light,
        float tickDelta
    ) {
        if (text == null || !(entity instanceof PlayerEntity player)) return text;
        if (!IdentityState.shouldShowNametag(
            player.getUuid(),
            player.getName().getString()
        )) return text;
        return BadgeText.prepend(text);
    }
}
