package app.eryon.identity.client.mixin;

import java.util.List;

import app.eryon.identity.client.EryonTitleStyle;
import app.eryon.identity.client.widget.EryonStyledButton;
import net.fabricmc.fabric.api.client.screen.v1.Screens;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.client.gui.screen.TitleScreen;
import net.minecraft.client.gui.screen.multiplayer.MultiplayerScreen;
import net.minecraft.client.gui.screen.option.OptionsScreen;
import net.minecraft.client.gui.screen.world.SelectWorldScreen;
import net.minecraft.client.gui.widget.ClickableWidget;
import net.minecraft.client.resource.language.I18n;
import net.minecraft.text.Text;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Port del menu principal Eryon del mod Forge 1.8.9 al TitleScreen de
 * Minecraft 1.21.1: botones verdes, encabezado y pie iguales.
 * TitleScreen en 1.21.1 no declara init ni render propios (los hereda
 * de Screen), por eso el mixin vive en Screen y se filtra por tipo.
 */
@Mixin(Screen.class)
public abstract class EryonScreenStyleMixin {

    @Unique
    private int eryon$ancho;

    @Unique
    private int eryon$alto;

    @Inject(method = "init", at = @At("TAIL"))
    private void eryon$reemplazarBotones(MinecraftClient client, int width, int height, CallbackInfo ci) {
        if (!(((Object) this) instanceof TitleScreen)) return;
        this.eryon$ancho = width;
        this.eryon$alto = height;
        Screen self = (Screen) (Object) this;

        // Quita los botones vanilla y coloca los del estilo Eryon.
        // Screens.getButtons devuelve la lista real de botones de la pantalla.
        List<ClickableWidget> botones = Screens.getButtons(self);
        botones.clear();

        int buttonWidth = Math.min(220, width - 48);
        int left = (width - buttonWidth) / 2;
        int buttonHeight = 20;
        int gap = 8;
        int menuHeight = buttonHeight * 3 + gap * 2;
        int top = Math.max(8, (height - menuHeight) / 2);

        botones.add(new EryonStyledButton(left, top, buttonWidth, buttonHeight,
            Text.literal(I18n.translate("menu.singleplayer").toUpperCase()),
            button -> MinecraftClient.getInstance().setScreen(new SelectWorldScreen(self))));

        botones.add(new EryonStyledButton(left, top + buttonHeight + gap,
            buttonWidth, buttonHeight,
            Text.literal(I18n.translate("menu.multiplayer").toUpperCase()),
            button -> MinecraftClient.getInstance().setScreen(new MultiplayerScreen(self))));

        int halfWidth = (buttonWidth - gap) / 2;
        botones.add(new EryonStyledButton(left, top + 2 * (buttonHeight + gap),
            halfWidth, buttonHeight,
            Text.literal(I18n.translate("menu.options").toUpperCase()),
            button -> MinecraftClient.getInstance().setScreen(
                new OptionsScreen(self, MinecraftClient.getInstance().options))));

        botones.add(new EryonStyledButton(left + halfWidth + gap,
            top + 2 * (buttonHeight + gap), halfWidth, buttonHeight,
            Text.literal(I18n.translate("menu.quit").toUpperCase()),
            button -> MinecraftClient.getInstance().scheduleStop()));
    }

    @Inject(method = "render", at = @At("TAIL"))
    private void eryon$dibujarEstilo(DrawContext context, int mouseX, int mouseY, float delta, CallbackInfo ci) {
        if (!(((Object) this) instanceof TitleScreen)) return;

        EryonTitleStyle.dibujarFondo(context, this.eryon$ancho, this.eryon$alto);
        context.fill(0, 0, this.eryon$ancho, this.eryon$alto, 0x30000000);

        for (ClickableWidget button : Screens.getButtons((Screen) (Object) this)) {
            button.render(context, mouseX, mouseY, delta);
        }

        context.drawTextWithShadow(MinecraftClient.getInstance().textRenderer,
            Text.literal("Tu Minecraft Tu experiencia"), 14, 12, 0xFFE8F5EA);
        context.drawTextWithShadow(MinecraftClient.getInstance().textRenderer,
            Text.literal("Minecraft 1.21.1"), 14, this.eryon$alto - 18, 0xFFD1E4D4);
        String marca = "Eryon Launcher";
        int anchoMarca = MinecraftClient.getInstance().textRenderer.getWidth(marca);
        context.drawTextWithShadow(MinecraftClient.getInstance().textRenderer,
            Text.literal(marca), this.eryon$ancho - anchoMarca - 14, this.eryon$alto - 18, 0xFFD1E4D4);
    }
}
