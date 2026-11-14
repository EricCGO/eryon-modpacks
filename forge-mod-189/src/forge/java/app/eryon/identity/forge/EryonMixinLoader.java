package app.eryon.identity.forge;

import net.minecraftforge.fml.relauncher.IFMLLoadingPlugin;
import org.spongepowered.asm.launch.MixinBootstrap;
import org.spongepowered.asm.mixin.MixinEnvironment;
import org.spongepowered.asm.mixin.Mixins;

import java.util.Map;

// Coremod: FML lo detecta por el atributo de manifiesto
// FMLCorePlugin del jar y le da control en el arranque para
// instalar el runtime de Mixin en una version legacy (1.8.9),
// donde Forge no lleva Mixin integrado. Patron de facto de los
// mods 1.8.9 con mixin.
@IFMLLoadingPlugin.Name("ERYONIdentity")
@IFMLLoadingPlugin.MCVersion("1.8.9")
public final class EryonMixinLoader implements IFMLLoadingPlugin {
    public EryonMixinLoader() {
        MixinBootstrap.init();
        Mixins.addConfiguration("eryon-identity-forge.mixins.json");
        MixinEnvironment.getDefaultEnvironment()
            .setSide(MixinEnvironment.Side.CLIENT);
    }

    @Override
    public String[] getASMTransformerClass() {
        return new String[0];
    }

    @Override
    public String getModContainerClass() {
        return null;
    }

    @Override
    public String getSetupClass() {
        return null;
    }

    @Override
    public void injectData(Map<String, Object> data) {
        // sin datos extra
    }

    @Override
    public String getAccessTransformerClass() {
        return null;
    }
}
