package app.eryon.identity.forge.mixins;

import app.eryon.identity.forge.LabelContext;
import net.minecraft.client.renderer.entity.RendererLivingEntity;
import net.minecraft.entity.EntityLivingBase;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

// En 1.8.9 la etiqueta de un ser vivo se dibuja desde
// RendererLivingEntity#renderName(T,DDD) (que tiene una
// sobrecarga con Entity y por eso se necesita el descriptor
// completo para desambiguar). Recuerda la entidad mientras
// Render#renderLivingLabel dibuja el texto y la limpia al
// terminar. El mixin que modifica el texto en si vive en
// RenderMixin, garantizando el orden de ejecucion.
@Mixin(RendererLivingEntity.class)
public abstract class RendererLivingEntityMixin {
    @Inject(
        method = "renderName(Lnet/minecraft/entity/EntityLivingBase;DDD)V",
        at = @At("HEAD")
    )
    private void eryon$rememberLabelEntity(
        EntityLivingBase entity,
        double x,
        double y,
        double z,
        CallbackInfo ci
    ) {
        LabelContext.set(entity);
    }

    @Inject(
        method = "renderName(Lnet/minecraft/entity/EntityLivingBase;DDD)V",
        at = @At("RETURN")
    )
    private void eryon$clearLabelEntity(
        EntityLivingBase entity,
        double x,
        double y,
        double z,
        CallbackInfo ci
    ) {
        LabelContext.clear();
    }
}
