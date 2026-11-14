package app.eryon.identity.forge.mixins;

import net.minecraft.client.gui.GuiButton;
import net.minecraft.client.gui.GuiScreen;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

import java.util.List;

@Mixin(GuiScreen.class)
public interface GuiScreenAccessor {
    @Accessor("buttonList")
    List<GuiButton> eryon$getButtonList();

    @Accessor("width")
    int eryon$getWidth();

    @Accessor("height")
    int eryon$getHeight();
}
