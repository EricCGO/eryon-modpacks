package app.eryon.identity.forge;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Gui;
import net.minecraft.client.gui.ScaledResolution;
import net.minecraft.client.renderer.GlStateManager;
import net.minecraft.client.renderer.Tessellator;
import net.minecraft.client.renderer.WorldRenderer;
import net.minecraft.client.renderer.vertex.DefaultVertexFormats;
import net.minecraft.client.renderer.texture.DynamicTexture;
import net.minecraft.client.renderer.texture.TextureManager;
import net.minecraft.util.ResourceLocation;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.IOException;
import java.io.InputStream;

/** Black Eryon startup splash with Minecraft's real loading percentage. */
public final class StartupSplashOverlay {
    private static ResourceLocation logoTexture;
    private static volatile int progress;
    private static volatile String message = "Iniciando Minecraft";

    private StartupSplashOverlay() {}

    public static void setProgress(int value) {
        progress = Math.max(0, Math.min(100, value));
    }

    public static void setMessage(String value) {
        if (value != null && !value.trim().isEmpty()) {
            message = value.trim();
        }
    }

    public static void draw(Minecraft minecraft) {
        draw(minecraft, false);
    }

    /** Draws in physical display pixels during Minecraft's early framebuffer splash. */
    public static void drawWindowSplash(Minecraft minecraft) {
        draw(minecraft, true);
    }

    private static void draw(Minecraft minecraft, boolean physicalPixels) {
        ScaledResolution resolution = physicalPixels ? null : new ScaledResolution(minecraft);
        int width = physicalPixels ? minecraft.displayWidth : resolution.getScaledWidth();
        int height = physicalPixels ? minecraft.displayHeight : resolution.getScaledHeight();

        GlStateManager.disableDepth();
        GlStateManager.disableLighting();
        GlStateManager.disableTexture2D();
        GlStateManager.enableBlend();
        GlStateManager.tryBlendFuncSeparate(770, 771, 1, 0);
        Gui.drawRect(0, 0, width, height, 0xFF000000);

        drawLogo(minecraft, width, height);

        int barWidth = Math.min(680, Math.max(180, width - 72));
        int barX = (width - barWidth) / 2;
        int barY = Math.min(height - 42, Math.max(0, (int) (height * 0.84D)));
        int barHeight = 9;

        GlStateManager.disableTexture2D();
        Gui.drawRect(barX, barY, barX + barWidth, barY + barHeight, 0xFFE6E6E6);
        Gui.drawRect(barX + 1, barY + 1, barX + barWidth - 1,
            barY + barHeight - 1, 0xFF111111);
        int fillWidth = (barWidth - 2) * progress / 100;
        if (fillWidth > 0) {
            Gui.drawRect(barX + 1, barY + 1, barX + 1 + fillWidth,
                barY + barHeight - 1, 0xFF55D66B);
        }
        GlStateManager.enableTexture2D();

        if (minecraft.fontRendererObj != null) {
            String label = message + "  " + progress + "%";
            minecraft.fontRendererObj.drawStringWithShadow(label,
                (width - minecraft.fontRendererObj.getStringWidth(label)) / 2,
                barY - 19, 0xFFE4E8E5);
        }
        GlStateManager.disableBlend();
        GlStateManager.enableDepth();
    }

    private static void drawLogo(Minecraft minecraft, int screenWidth, int screenHeight) {
        TextureManager textureManager = minecraft.getTextureManager();
        if (!ensureLogo(textureManager)) return;

        int size = Math.min(600, Math.max(150, (int) (screenHeight * 0.66D)));
        int x = (screenWidth - size) / 2;
        int y = Math.max(16, screenHeight / 2 - size / 2 - 20);

        GlStateManager.enableTexture2D();
        GlStateManager.color(1.0F, 1.0F, 1.0F, 1.0F);
        textureManager.bindTexture(logoTexture);
        WorldRenderer renderer = Tessellator.getInstance().getWorldRenderer();
        renderer.begin(7, DefaultVertexFormats.POSITION_TEX_COLOR);
        renderer.pos(x, y + size, 0).tex(0, 1).color(255, 255, 255, 255).endVertex();
        renderer.pos(x + size, y + size, 0).tex(1, 1).color(255, 255, 255, 255).endVertex();
        renderer.pos(x + size, y, 0).tex(1, 0).color(255, 255, 255, 255).endVertex();
        renderer.pos(x, y, 0).tex(0, 0).color(255, 255, 255, 255).endVertex();
        Tessellator.getInstance().draw();
    }

    private static boolean ensureLogo(TextureManager textureManager) {
        if (logoTexture != null) return true;
        try (InputStream input = StartupSplashOverlay.class.getResourceAsStream(
            "/assets/eryon/textures/splash-logo.png"
        )) {
            if (input == null) return false;
            BufferedImage image = ImageIO.read(input);
            if (image == null) return false;
            logoTexture = textureManager.getDynamicTextureLocation(
                "eryon_startup_logo", new DynamicTexture(image)
            );
            return true;
        } catch (IOException | RuntimeException error) {
            return false;
        }
    }
}
