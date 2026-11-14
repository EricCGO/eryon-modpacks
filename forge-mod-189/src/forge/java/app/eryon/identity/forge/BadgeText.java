package app.eryon.identity.forge;

// Reserva el espacio para el bitmap del distintivo; los mixins de
// TAB y nametag dibujan el mismo PNG que usa el cliente moderno.
public final class BadgeText {
    public static final String BADGE_PREFIX =
        "\u00A7r  ";

    private BadgeText() {}

    public static boolean isEryonPlayer(String playerName) {
        return PresenceCache.isEryonPlayer(playerName);
    }
}
