package app.eryon.identity.client.widget;

import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.gui.widget.ButtonWidget;
import net.minecraft.text.Text;

/** Boton de vidrio verde estilo Eryon, igual al del menu Forge 1.8.9. */
public final class EryonStyledButton extends ButtonWidget {

    public EryonStyledButton(int x, int y, int width, int height, Text label, PressAction action) {
        super(x, y, width, height, label, action, DEFAULT_NARRATION_SUPPLIER);
    }

    @Override
    protected void renderWidget(DrawContext context, int mouseX, int mouseY, float delta) {
        boolean hovered = this.hovered;
        int outline = hovered ? 0xFF66F28B : 0xAA67C77C;
        int fill = hovered ? 0xD91A3423 : 0xC909110D;
        int textColor = hovered ? 0xFFB8FFC3 : 0xFFF0F5F1;
        int x = getX();
        int y = getY();
        context.fill(x, y, x + this.width, y + this.height, outline);
        context.fill(x + 1, y + 1, x + this.width - 1, y + this.height - 1, fill);
        Text label = getMessage();
        int labelWidth = MinecraftClient.getInstance().textRenderer.getWidth(label);
        int labelHeight = 8;
        context.drawTextWithShadow(MinecraftClient.getInstance().textRenderer, label,
            x + (this.width - labelWidth) / 2, y + (this.height - labelHeight) / 2, textColor);
    }
}
