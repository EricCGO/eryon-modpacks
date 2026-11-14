package app.eryon.identity.forge.mixins;

import net.minecraftforge.fml.common.FMLCommonHandler;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

@Mixin(FMLCommonHandler.class)
public abstract class FMLBrandingMixin {
    @Inject(
        method = "getBrandings",
        at = @At("RETURN"),
        cancellable = true
    )
    private void eryon$keepMinecraftAndOptiFineBranding(
        boolean includeMinecraft,
        CallbackInfoReturnable<List<String>> cir
    ) {
        List<String> current = cir.getReturnValue();
        if (current == null) return;

        List<String> visible = new ArrayList<String>();
        for (String branding : current) {
            if (branding == null) continue;
            String normalized = branding.toLowerCase(Locale.ROOT);
            if (normalized.startsWith("minecraft ")
                || normalized.startsWith("optifine ")) {
                visible.add(branding);
            }
        }
        cir.setReturnValue(visible);
    }
}
