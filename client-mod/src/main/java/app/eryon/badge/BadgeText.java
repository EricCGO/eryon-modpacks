package app.eryon.badge;

import net.minecraft.text.MutableText;
import net.minecraft.text.Style;
import net.minecraft.text.Text;
import net.minecraft.util.Identifier;

public final class BadgeText {
    private BadgeText() {}

    public static Text prependIfEryon(String playerName, Text original) {
        if (!PresenceCache.isEryonPlayer(playerName)) return original;
        MutableText badge = Text.literal("\uE000")
            .setStyle(Style.EMPTY.withFont(new Identifier("eryon", "badge")));
        MutableText result = Text.empty();
        result.append(badge);
        result.append(Text.literal(" "));
        result.append(original);
        return result;
    }
}
