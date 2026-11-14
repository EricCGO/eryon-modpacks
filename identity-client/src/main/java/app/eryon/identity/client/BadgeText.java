package app.eryon.identity.client;

import net.minecraft.text.MutableText;
import net.minecraft.text.Style;
import net.minecraft.text.Text;
import net.minecraft.util.Identifier;

public final class BadgeText {
    private BadgeText() {}

    public static Text prepend(Text original) {
        if (original == null) return null;
        MutableText badge = Text.literal("\uE000")
            .setStyle(Style.EMPTY.withFont(Identifier.of(
                "eryon",
                "badge_" + IdentityState.logoSize()
            )));
        MutableText result = Text.empty();
        result.append(badge);
        result.append(Text.literal(" "));
        result.append(original);
        return result;
    }
}
