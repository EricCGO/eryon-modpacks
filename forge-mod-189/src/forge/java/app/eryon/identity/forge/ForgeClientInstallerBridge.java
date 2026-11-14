package app.eryon.identity.forge;

import java.io.File;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;

/**
 * Invoca el instalador de cliente legacy incluido en Forge 1.8.9.
 * Esa versión no expone --installClient en SimpleInstaller, pero sí
 * conserva ClientInstall para el instalador gráfico.
 */
public final class ForgeClientInstallerBridge {
    private ForgeClientInstallerBridge() {}

    public static void main(String[] args) {
        if (args.length != 1) {
            throw new IllegalArgumentException(
                "Se esperaba la carpeta de Minecraft como único argumento."
            );
        }

        try {
            Class<?> clientInstallClass = Class.forName(
                "net.minecraftforge.installer.ClientInstall"
            );
            Constructor<?> constructor = clientInstallClass
                .getDeclaredConstructor();
            Object installer = constructor.newInstance();
            Class<?> predicateClass = Class.forName(
                "com.google.common.base.Predicate"
            );
            Object predicate = Proxy.newProxyInstance(
                ForgeClientInstallerBridge.class.getClassLoader(),
                new Class<?>[] { predicateClass },
                (proxy, method, values) -> {
                    if ("apply".equals(method.getName())) return true;
                    if ("toString".equals(method.getName())) return "all";
                    if ("hashCode".equals(method.getName())) return 0;
                    if ("equals".equals(method.getName())) {
                        return proxy == values[0];
                    }
                    return null;
                }
            );
            Method run = clientInstallClass.getMethod(
                "run",
                File.class,
                predicateClass
            );
            boolean installed = (Boolean) run.invoke(
                installer,
                new File(args[0]),
                predicate
            );

            if (!installed) {
                throw new IllegalStateException(
                    "Forge no pudo instalar el perfil del cliente."
                );
            }
        } catch (ReflectiveOperationException error) {
            throw new IllegalStateException(
                "No se pudo invocar el instalador de cliente de Forge.",
                error
            );
        }
    }
}
