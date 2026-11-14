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
import java.awt.Color;
import java.awt.Graphics;
import java.awt.image.BufferedImage;
import java.io.IOException;
import java.io.InputStream;

public final class SplashBackground {
    private static ResourceLocation texture;
    private static int textureWidth;
    private static int textureHeight;
    private static ResourceLocation whiteTexture;

    private SplashBackground() {}

    public static void draw(Minecraft minecraft, TextureManager textureManager) {
        try {
            if (!ensureTexture(textureManager)) return;

            GlStateManager.enableTexture2D();
            GlStateManager.color(1.0F, 1.0F, 1.0F, 1.0F);
            textureManager.bindTexture(texture);
            // drawSplashScreen configures an orthographic projection in GUI
            // (scaled) coordinates, not physical display pixels.
            ScaledResolution resolution = new ScaledResolution(minecraft);
            double width = resolution.getScaledWidth();
            double height = resolution.getScaledHeight();
            double screenAspect = width / height;
            double imageAspect = (double) textureWidth / textureHeight;
            double u0 = 0.0D;
            double u1 = 1.0D;
            double v0 = 0.0D;
            double v1 = 1.0D;
            // Fill the viewport without stretching: crop only the excess edge.
            if (imageAspect > screenAspect) {
                double visibleU = screenAspect / imageAspect;
                u0 = (1.0D - visibleU) / 2.0D;
                u1 = u0 + visibleU;
            } else if (imageAspect < screenAspect) {
                double visibleV = imageAspect / screenAspect;
                v0 = (1.0D - visibleV) / 2.0D;
                v1 = v0 + visibleV;
            }
            WorldRenderer renderer = Tessellator.getInstance().getWorldRenderer();
            renderer.begin(7, DefaultVertexFormats.POSITION_TEX_COLOR);
            renderer.pos(0.0D, height, 0.0D)
                .tex(u0, v1).color(255, 255, 255, 255).endVertex();
            renderer.pos(width, height, 0.0D)
                .tex(u1, v1).color(255, 255, 255, 255).endVertex();
            renderer.pos(width, 0.0D, 0.0D)
                .tex(u1, v0).color(255, 255, 255, 255).endVertex();
            renderer.pos(0.0D, 0.0D, 0.0D)
                .tex(u0, v0).color(255, 255, 255, 255).endVertex();
            Tessellator.getInstance().draw();
        } catch (IOException | RuntimeException error) {
            // Si el fondo personalizado falla, Minecraft conserva su splash vanilla.
        }
    }

    public static void drawMenuBackground(Minecraft minecraft, TextureManager textureManager) {
        draw(minecraft, textureManager);
        ScaledResolution resolution = new ScaledResolution(minecraft);
        GlStateManager.disableTexture2D();
        GlStateManager.enableBlend();
        GlStateManager.tryBlendFuncSeparate(770, 771, 1, 0);
        Gui.drawRect(0, 0, resolution.getScaledWidth(), resolution.getScaledHeight(),
            0x38000000);
        GlStateManager.disableBlend();
        GlStateManager.enableTexture2D();
    }

    /**
     * Textura blanca solida de 1x1 para listas: el quad de fondo del GuiSlot
     * (tinte 32/32/32) la convierte en un panel oscuro uniforme sobre el
     * fondo Eryon, sin tiles de dirt.
     */
    public static void bindWhiteTexture(TextureManager textureManager) {
        if (whiteTexture == null) {
            BufferedImage image = new BufferedImage(1, 1, BufferedImage.TYPE_INT_RGB);
            Graphics graphics = image.getGraphics();
            graphics.setColor(new Color(255, 255, 255));
            graphics.fillRect(0, 0, 1, 1);
            graphics.dispose();
            whiteTexture = textureManager.getDynamicTextureLocation(
                "eryon_solid_white", new DynamicTexture(image));
        }
        textureManager.bindTexture(whiteTexture);
    }

    private static boolean ensureTexture(TextureManager textureManager) throws IOException {
        if (texture != null) return true;
        try (InputStream input = SplashBackground.class.getResourceAsStream(
            "/assets/eryon/textures/menu-background.png"
        )) {
            if (input == null) return false;
            BufferedImage image = ImageIO.read(input);
            if (image == null) return false;
            textureWidth = image.getWidth();
            textureHeight = image.getHeight();
            texture = textureManager.getDynamicTextureLocation(
                "eryon_splash_background",
                new DynamicTexture(image)
            );
            return true;
        }
    }
}
