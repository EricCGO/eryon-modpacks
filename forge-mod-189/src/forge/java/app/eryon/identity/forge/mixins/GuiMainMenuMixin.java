package app.eryon.identity.forge.mixins;

import app.eryon.identity.forge.EryonMenuButton;
import app.eryon.identity.forge.SplashBackground;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Gui;
import net.minecraft.client.gui.GuiButton;
import net.minecraft.client.gui.GuiMainMenu;
import net.minecraft.client.resources.I18n;
import net.minecraft.client.renderer.GlStateManager;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(GuiMainMenu.class)
public abstract class GuiMainMenuMixin {
    @Unique
    private long eryon$menuFadeStartedAt;

    @Inject(method = "initGui", at = @At("TAIL"))
    private void eryon$replaceMenuButtons(CallbackInfo ci) {
        eryon$menuFadeStartedAt = 0L;
        GuiScreenAccessor screen = (GuiScreenAccessor) (Object) this;
        int width = screen.eryon$getWidth();
        int height = screen.eryon$getHeight();
        java.util.List<GuiButton> buttonList = screen.eryon$getButtonList();
        buttonList.clear();

        int buttonWidth = Math.min(200, width - 48);
        int left = (width - buttonWidth) / 2;
        int buttonHeight = 20;
        int gap = 8;
        int menuHeight = buttonHeight * 3 + gap * 2;
        int top = Math.max(8, (height - menuHeight) / 2);

        buttonList.add(new EryonMenuButton(1, left, top, buttonWidth, buttonHeight,
            I18n.format("menu.singleplayer").toUpperCase()));
        buttonList.add(new EryonMenuButton(2, left, top + buttonHeight + gap,
            buttonWidth, buttonHeight, I18n.format("menu.multiplayer").toUpperCase()));

        int halfWidth = (buttonWidth - gap) / 2;
        buttonList.add(new EryonMenuButton(0, left, top + 2 * (buttonHeight + gap),
            halfWidth, buttonHeight, I18n.format("menu.options").toUpperCase()));
        buttonList.add(new EryonMenuButton(4, left + halfWidth + gap,
            top + 2 * (buttonHeight + gap), halfWidth, buttonHeight,
            I18n.format("menu.quit").toUpperCase()));
    }

    @Inject(method = "drawScreen", at = @At("HEAD"), cancellable = true)
    private void eryon$drawCustomMainMenu(
        int mouseX,
        int mouseY,
        float partialTicks,
        CallbackInfo ci
    ) {
        GuiScreenAccessor screen = (GuiScreenAccessor) (Object) this;
        int width = screen.eryon$getWidth();
        int height = screen.eryon$getHeight();
        Minecraft minecraft = Minecraft.getMinecraft();
        if (eryon$menuFadeStartedAt == 0L) {
            eryon$menuFadeStartedAt = System.currentTimeMillis();
        }
        long elapsed = System.currentTimeMillis() - eryon$menuFadeStartedAt;
        SplashBackground.drawMenuBackground(minecraft, minecraft.getTextureManager());

        GlStateManager.disableTexture2D();
        GlStateManager.enableBlend();
        GlStateManager.tryBlendFuncSeparate(770, 771, 1, 0);
        Gui.drawRect(0, 0, width, height, 0x30000000);
        GlStateManager.disableBlend();
        GlStateManager.enableTexture2D();

        int buttonIndex = 0;
        for (GuiButton button : screen.eryon$getButtonList()) {
            long buttonElapsed = elapsed - buttonIndex * 120L;
            double progress = Math.max(0.0D, Math.min(1.0D, buttonElapsed / 700.0D));
            double easedProgress = progress * progress * (3.0D - 2.0D * progress);
            int opacity = (int) Math.round(easedProgress * 255.0D);
            if (button instanceof EryonMenuButton) {
                ((EryonMenuButton) button).drawButton(minecraft, mouseX, mouseY, opacity);
            } else {
                button.drawButton(minecraft, mouseX, mouseY);
            }
            buttonIndex++;
        }

        minecraft.fontRendererObj.drawStringWithShadow(
            "Tu Minecraft Tu experiencia", 14, 12, 0xFFE8F5EA
        );
        minecraft.fontRendererObj.drawStringWithShadow(
            "Minecraft 1.8.9  •  OptiFine", 14, height - 18, 0xFFD1E4D4
        );
        minecraft.fontRendererObj.drawStringWithShadow(
            "Eryon Launcher", width - minecraft.fontRendererObj.getStringWidth("Eryon Launcher") - 14,
            height - 18, 0xFFD1E4D4
        );
        ci.cancel();
    }
}
