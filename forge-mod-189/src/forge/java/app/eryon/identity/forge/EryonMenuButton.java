package app.eryon.identity.forge;

import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Gui;
import net.minecraft.client.gui.GuiButton;

/** Minimal dark glass button used by Eryon's custom 1.8.9 main menu. */
public final class EryonMenuButton extends GuiButton {
    public EryonMenuButton(int id, int x, int y, int width, int height, String label) {
        super(id, x, y, width, height, label);
    }

    @Override
    public void drawButton(Minecraft minecraft, int mouseX, int mouseY) {
        drawButton(minecraft, mouseX, mouseY, 255);
    }

    public void drawButton(Minecraft minecraft, int mouseX, int mouseY, int opacity) {
        hovered = mouseX >= xPosition && mouseY >= yPosition
            && mouseX < xPosition + width && mouseY < yPosition + height;
        drawStyledButton(this, minecraft, hovered, opacity);
    }

    public static void drawStyledButton(
        GuiButton button,
        Minecraft minecraft,
        boolean hovered
    ) {
        drawStyledButton(button, minecraft, hovered, 255);
    }

    public static void drawStyledButton(
        GuiButton button,
        Minecraft minecraft,
        boolean hovered,
        int opacity
    ) {
        if (!button.visible || opacity <= 0) return;

        int alpha = Math.max(0, Math.min(255, opacity));
        boolean active = button.enabled;
        int outline = !active ? 0x665C665E
            : hovered ? 0xFF66F28B : 0xAA67C77C;
        int fill = !active ? 0x88303030
            : hovered ? 0xD91A3423 : 0xC909110D;
        Gui.drawRect(button.xPosition, button.yPosition,
            button.xPosition + button.width, button.yPosition + button.height,
            withOpacity(outline, alpha));
        Gui.drawRect(button.xPosition + 1, button.yPosition + 1,
            button.xPosition + button.width - 1, button.yPosition + button.height - 1,
            withOpacity(fill, alpha));
        minecraft.fontRendererObj.drawStringWithShadow(button.displayString,
            button.xPosition + (button.width
                - minecraft.fontRendererObj.getStringWidth(button.displayString)) / 2,
            button.yPosition + (button.height - 8) / 2,
            withOpacity(!active ? 0xFF888888
                : hovered ? 0xFFB8FFC3 : 0xFFF0F5F1, alpha));
    }

    private static int withOpacity(int color, int opacity) {
        int sourceAlpha = color >>> 24;
        int alpha = sourceAlpha * opacity / 255;
        return (color & 0x00FFFFFF) | (alpha << 24);
    }
}
