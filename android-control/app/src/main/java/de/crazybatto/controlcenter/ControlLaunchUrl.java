package de.crazybatto.controlcenter;

import java.net.URI;
import java.net.URISyntaxException;

/** Explicit component intents must obey the same chat entry rule as verified Android links. */
final class ControlLaunchUrl {
    static final String DEFAULT_URL = "https://crazybatto.de/control-center/?native=android";

    private ControlLaunchUrl() {}

    static String accepted(String candidate) {
        if (candidate == null) return null;
        try {
            URI uri = new URI(candidate);
            if (!"https".equalsIgnoreCase(uri.getScheme())
                    || !"crazybatto.de".equalsIgnoreCase(uri.getHost())
                    || uri.getRawUserInfo() != null
                    || (uri.getPort() != -1 && uri.getPort() != 443)
                    || !"/control-center/".equals(uri.getRawPath())) {
                return null;
            }
            // Preserve the selected conversation and fragment from notification links unchanged.
            return candidate;
        } catch (URISyntaxException invalid) {
            return null;
        }
    }
}
