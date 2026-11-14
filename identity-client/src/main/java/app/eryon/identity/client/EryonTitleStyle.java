package app.eryon.identity.client;

import net.minecraft.client.gui.DrawContext;
import net.minecraft.util.Identifier;

/** Fondo de menu Eryon (misma estetica que el mod Forge 1.8.9). */
public final class EryonTitleStyle {
    private static final Identifier FONDO =
        Identifier.of("eryon", "textures/menu-background.png");
    private static final int TextANCHO = 1365;
    private static final int TextALTO = 768;

    private EryonTitleStyle() {}

    /** Dibuja la textura recortada para llenar la pantalla sin deformar. */
    public static void dibujarFondo(DrawContext context, int width, int height) {
        double screenAspect = width / (double) height;
        double imageAspect = TextANCHO / (double) TextALTO;
        int u;
        int v;
        int regionWidth;
        int regionHeight;
        if (imageAspect > screenAspect) {
            regionHeight = TextALTO;
            double visible = screenAspect / imageAspect;
            regionWidth = (int) Math.round(TextANCHO * visible);
            u = (TextANCHO - regionWidth) / 2;
            v = 0;
        } else {
            regionWidth = TextANCHO;
            double visible = imageAspect / screenAspect;
            regionHeight = (int) Math.round(TextALTO * visible);
            u = 0;
            v = (TextALTO - regionHeight) / 2;
        }
        if (regionWidth <= 0 || regionHeight <= 0) {
            regionWidth = TextANCHO;
            regionHeight = TextALTO;
            u = 0;
            v = 0;
        }
        context.drawTexture(FONDO, 0, 0, width, height, u, v, regionWidth, regionHeight, TextANCHO, TextALTO);
        context.fill(0, 0, width, height, 0x38000000);
    }
}
