package app.eryon.menuhelper.mixin;

import java.util.ArrayList;
import java.util.List;

import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.client.gui.screen.multiplayer.MultiplayerScreen;
import net.minecraft.client.gui.screen.world.SelectWorldScreen;
import net.minecraft.client.gui.widget.ButtonWidget;
import net.minecraft.text.Text;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Pseudo;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Agrega "Un jugador" y "Multijugador" al menu principal de Sobrevive a Reviil
 * (net.sobrevivereviil.a.iilll) sin tocar el jar del mod.
 * Su render no llama a super.render, asi que ademas pintamos los botones
 * al final de su render para que se vean.
 */
@Pseudo
@Mixin(targets = "net.sobrevivereviil.a.iilll")
public abstract class SobreviveMainMenuMixin extends Screen {

    protected SobreviveMainMenuMixin() {
        super(Text.literal("SobreviveMenu"));
    }

    @Unique
    private final List<ButtonWidget> eryon$botones = new ArrayList<>();

    @Inject(method = "method_25426", at = @At("RETURN"), remap = false)
    private void eryon$agregarBotones(CallbackInfo ci) {
        this.eryon$botones.clear();
        int x = (this.width - 200) / 2;
        ButtonWidget uno = ButtonWidget.builder(Text.translatable("menu.singleplayer"),
                        b -> this.client.setScreen(new SelectWorldScreen(this)))
                .dimensions(x, this.height - 48, 200, 20).build();
        ButtonWidget multi = ButtonWidget.builder(Text.translatable("menu.multiplayer"),
                        b -> this.client.setScreen(new MultiplayerScreen(this)))
                .dimensions(x, this.height - 25, 200, 20).build();
        this.addDrawableChild(uno);
        this.addDrawableChild(multi);
        this.eryon$botones.add(uno);
        this.eryon$botones.add(multi);
    }

    @Inject(method = "method_25394", at = @At("RETURN"), remap = false)
    private void eryon$dibujarBotones(DrawContext context, int mouseX, int mouseY, float delta, CallbackInfo ci) {
        for (ButtonWidget b : this.eryon$botones) {
            b.render(context, mouseX, mouseY, delta);
        }
    }
}
