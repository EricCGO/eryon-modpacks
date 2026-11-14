package app.eryon.badge.mixin;

import app.eryon.badge.BadgeText;
import net.minecraft.client.render.entity.EntityRenderer;
import net.minecraft.entity.Entity;
import net.minecraft.entity.player.PlayerEntity;
import net.minecraft.client.render.VertexConsumerProvider;
import net.minecraft.client.util.math.MatrixStack;
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
    private Text eryon$addBadgeToPlayerLabel(
        Text text,
        Entity entity,
        Text originalText,
        MatrixStack matrices,
        VertexConsumerProvider vertexConsumers,
        int light
    ) {
        if (text == null || !(entity instanceof PlayerEntity player)) return text;
        return BadgeText.prependIfEryon(player.getGameProfile().getName(), text);
    }
}
