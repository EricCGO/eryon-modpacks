package app.eryon.identity.forge;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Gui;
import net.minecraft.client.renderer.GlStateManager;
import net.minecraft.util.ResourceLocation;
import org.lwjgl.opengl.GL11;

public final class BadgeRenderer {
    private static final ResourceLocation BADGE_TEXTURE =
        new ResourceLocation("eryon", "textures/badge.png");

    private BadgeRenderer() {}

    public static void draw(int x, int y, int size) {
        boolean blendingWasEnabled = GL11.glIsEnabled(GL11.GL_BLEND);
        Minecraft.getMinecraft().getTextureManager().bindTexture(BADGE_TEXTURE);
        GlStateManager.color(1.0F, 1.0F, 1.0F, 1.0F);
        GlStateManager.enableBlend();
        GlStateManager.tryBlendFuncSeparate(770, 771, 1, 0);
        Gui.drawModalRectWithCustomSizedTexture(
            x,
            y,
            0.0F,
            0.0F,
            size,
            size,
            size,
            size
        );
        if (!blendingWasEnabled) {
            GlStateManager.disableBlend();
        }
    }
}
