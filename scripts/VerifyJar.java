import java.util.jar.JarFile;
import java.util.Enumeration;
import java.util.zip.CRC32;
import java.io.InputStream;

public class VerifyJar {
    public static void main(String[] args) throws Exception {
        try (JarFile jar = new JarFile(args[0])) {
            Enumeration<java.util.jar.JarEntry> en = jar.entries();
            int total = 0, errors = 0, dirs = 0;
            String mixins = null;
            byte[] buf = new byte[1 << 16];
            while (en.hasMoreElements()) {
                java.util.jar.JarEntry e = en.nextElement();
                if (e.isDirectory()) { dirs++; continue; }
                total++;
                CRC32 crc = new CRC32();
                try (InputStream in = jar.getInputStream(e)) {
                    int n;
                    while ((n = in.read(buf)) != -1) crc.update(buf, 0, n);
                } catch (Exception ex) {
                    errors++;
                    System.out.println("ERROR " + e.getName() + ": " + ex);
                    continue;
                }
                if (crc.getValue() != e.getCrc()) {
                    errors++;
                    System.out.println("CRC DISTINTO " + e.getName());
                }
                if (e.getName().equals("ruleta.mixins.json")) {
                    try (InputStream in = jar.getInputStream(e)) {
                        mixins = new String(in.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
                    }
                }
            }
            System.out.println("total archivos: " + total + " (dirs: " + dirs + ") | errores: " + errors);
            if (mixins != null) {
                boolean titulo = mixins.contains("\"TitleScreenMixin\"");
                boolean splash = mixins.contains("\"SplashOverlayMixin\"");
                System.out.println("TitleScreenMixin presente: " + titulo);
                System.out.println("SplashOverlayMixin presente: " + splash);
                System.out.println(mixins.contains("MenuPrincipalMixin") ? "MenuPrincipalMixin presente: true" : "MenuPrincipalMixin presente: false");
            }
            System.out.println(errors == 0 ? "JAR OK" : "JAR DANADO");
            System.exit(errors == 0 ? 0 : 1);
        }
    }
}
