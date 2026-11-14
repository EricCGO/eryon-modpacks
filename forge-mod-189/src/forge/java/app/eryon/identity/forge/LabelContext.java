package app.eryon.identity.forge;

import net.minecraft.entity.EntityLivingBase;

// Callback entre mixins: renderName recuerda la entails que
// está dibujando su etiqueta y ModifyVariable la consulta. Es
// suficiente porque renderLivingLabel solo se llama desde
// renderName (por frame, mismo hilo).
public final class LabelContext {
    private static final ThreadLocal<EntityLivingBase> CURRENT =
        new ThreadLocal<EntityLivingBase>();

    private LabelContext() {}

    public static void set(EntityLivingBase entity) {
        if (entity == null) {
            CURRENT.remove();
            return;
        }
        CURRENT.set(entity);
    }

    public static void clear() {
        CURRENT.remove();
    }

    public static EntityLivingBase current() {
        return CURRENT.get();
    }
}
