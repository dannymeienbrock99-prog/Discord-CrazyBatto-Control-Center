package de.crazybatto.controlcenter;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import org.junit.Test;

public final class ControlLaunchUrlTest {
    @Test public void acceptsDefaultAndPreservesNotificationConversation() {
        assertEquals(ControlLaunchUrl.DEFAULT_URL, ControlLaunchUrl.accepted(ControlLaunchUrl.DEFAULT_URL));
        String notification = "https://crazybatto.de/control-center/?thread=550e8400-e29b-41d4-a716-446655440000#message-7";
        assertEquals(notification, ControlLaunchUrl.accepted(notification));
        String explicitTlsPort = "HTTPS://CRAZYBATTO.DE:443/control-center/?thread=demo%20chat";
        assertEquals(explicitTlsPort, ControlLaunchUrl.accepted(explicitTlsPort));
    }

    @Test public void rejectsForeignOriginsCredentialsAndNonTlsSchemes() {
        String[] invalid = {
            null, "", "/control-center/", "http://crazybatto.de/control-center/",
            "https://example.com/control-center/", "https://crazybatto.de.example.com/control-center/",
            "https://www.crazybatto.de/control-center/", "https://crazybatto.de.:443/control-center/",
            "https://user@crazybatto.de/control-center/", "https://user:pass@crazybatto.de/control-center/",
            "https://crazybatto.de:444/control-center/", "javascript:alert(1)", "file:///control-center/",
            "content://de.crazybatto.controlcenter/private", "intent://crazybatto.de/control-center/",
            "https://crazybatto.de\\@example.com/control-center/",
            "https://crazybatto.de/control-center/\r\nother"
        };
        for (String candidate : invalid) assertNull(candidate, ControlLaunchUrl.accepted(candidate));
    }

    @Test public void rejectsOtherPathsAndEncodedPathBypasses() {
        String[] invalid = {
            "https://crazybatto.de/admin.html", "https://crazybatto.de/", "https://crazybatto.de/control-center//",
            "https://crazybatto.de/../control-center/", "https://crazybatto.de/%6Eachrichten.html",
            "https://crazybatto.de/control-center/%3Fthread=1", "https://crazybatto.de//control-center/",
            "https://crazybatto.de/Nachrichten.html"
        };
        for (String candidate : invalid) assertNull(candidate, ControlLaunchUrl.accepted(candidate));
    }
}
