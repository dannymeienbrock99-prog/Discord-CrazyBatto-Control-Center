package de.crazybatto.robotschichtlog;

import android.util.Base64;
import java.io.BufferedReader;
import java.io.File;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.util.Locale;
import javax.net.ssl.HttpsURLConnection;
import javax.net.ssl.SSLParameters;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

final class DavTarget {
    private static final int TIMEOUT = 15000;
    private final URI root;
    private final String auth;

    DavTarget(String address, String user, String password) {
        root = normalize(address);
        auth = user.isEmpty() ? null : "Basic " + Base64.encodeToString(
                (user + ":" + password).getBytes(StandardCharsets.UTF_8), Base64.NO_WRAP);
    }

    static URI normalize(String address) {
        URI uri = URI.create(address.trim());
        if (!"https".equalsIgnoreCase(uri.getScheme()) || uri.getHost() == null
                || uri.getRawUserInfo() != null || uri.getRawQuery() != null
                || uri.getRawFragment() != null || uri.getPort() == 0 || uri.getPort() > 65535) {
            throw new IllegalArgumentException("HTTPS-Adresse des vorhandenen WebDAV-Zielordners eingeben.");
        }
        String ascii = uri.toASCIIString();
        return URI.create(ascii.endsWith("/") ? ascii : ascii + "/");
    }

    // Windows/SMB-compatible, readable names. Distinguish identifiers that sanitize to the same text.
    static String folder(String prefix, String value) {
        if (value == null || value.trim().isEmpty()) return prefix + "ohne-Nummer";
        String input = value.trim();
        String clean = input.replaceAll("[^\\p{L}\\p{N}._ -]", "_");
        if (clean.length() > 65) clean = clean.substring(0, clean.offsetByCodePoints(0,
                Math.min(65, clean.codePointCount(0, clean.length()))));
        clean = clean.replaceAll("[ .]+$", "");
        if (!clean.equals(input) || clean.equalsIgnoreCase("ohne-Nummer")) clean += "-" + digest(input);
        return prefix + clean;
    }

    private static String digest(String value) {
        try {
            byte[] hash = MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder result = new StringBuilder();
            for (int i = 0; i < 6; i++) result.append(String.format(Locale.ROOT, "%02x", hash[i]));
            return result.toString();
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new AssertionError(impossible);
        }
    }

    static URI child(URI parent, String name, boolean directory) {
        try {
            String part = new URI(null, null, "/" + name, null).toASCIIString().substring(1);
            return URI.create(parent.toASCIIString() + part + (directory ? "/" : ""));
        } catch (java.net.URISyntaxException invalid) {
            throw new IllegalArgumentException("Ungültiger NAS-Ordnername", invalid);
        }
    }

    void upload(String day, String article, String order, String name, File file) throws IOException {
        URI dir = root;
        for (String part : new String[]{day, folder("Artikel-", article), folder("Auftrag-", order)}) {
            dir = child(dir, part, true);
            int code = mkdir(dir);
            if (code != 201 && code != 405) throw new DavError(code);
        }
        URI target = child(dir, name, false);
        HttpsURLConnection request = (HttpsURLConnection) target.toURL().openConnection();
        try {
            request.setInstanceFollowRedirects(false);
            request.setConnectTimeout(TIMEOUT);
            request.setReadTimeout(TIMEOUT);
            request.setRequestMethod("PUT");
            request.setDoOutput(true);
            request.setFixedLengthStreamingMode(file.length());
            if (auth != null) request.setRequestProperty("Authorization", auth);
            request.setRequestProperty("Content-Type", NasSync.mimeFor(name));
            try (OutputStream out = request.getOutputStream()) {
                Files.copy(file.toPath(), out);
            }
            int status = request.getResponseCode();
            if (status != 201 && status != 200 && status != 204) throw new DavError(status);
        } finally {
            request.disconnect();
        }
    }

    // Android's HttpURLConnection only accepts standard verbs. Use TLS with hostname verification
    // for MKCOL, retaining HttpURLConnection for the streamed photo body.
    private int mkdir(URI uri) throws IOException {
        String host = uri.getHost().replaceAll("^\\[|\\]$", "");
        int port = uri.getPort() == -1 ? 443 : uri.getPort();
        try (Socket tcp = new Socket()) {
            tcp.connect(new InetSocketAddress(host, port), TIMEOUT);
            tcp.setSoTimeout(TIMEOUT);
            SSLSocketFactory factory = HttpsURLConnection.getDefaultSSLSocketFactory();
            try (SSLSocket tls = (SSLSocket) factory.createSocket(tcp, host, port, true)) {
                SSLParameters verify = tls.getSSLParameters();
                verify.setEndpointIdentificationAlgorithm("HTTPS");
                tls.setSSLParameters(verify);
                tls.startHandshake();
                String headers = "MKCOL " + uri.getRawPath() + " HTTP/1.1\r\nHost: " + uri.getRawAuthority()
                        + "\r\nContent-Length: 0\r\nConnection: close\r\n"
                        + (auth == null ? "" : "Authorization: " + auth + "\r\n") + "\r\n";
                tls.getOutputStream().write(headers.getBytes(StandardCharsets.US_ASCII));
                tls.getOutputStream().flush();
                BufferedReader in = new BufferedReader(new InputStreamReader(
                        tls.getInputStream(), StandardCharsets.US_ASCII));
                String line = in.readLine();
                if (line == null || !line.matches("HTTP/1\\.[01] [0-9]{3}( .*)?")) {
                    throw new IOException("Ungültige Antwort des WebDAV-Servers.");
                }
                return Integer.parseInt(line.substring(9, 12));
            }
        }
    }

    static final class DavError extends IOException {
        final int status;
        DavError(int status) {
            super("WebDAV HTTP " + status);
            this.status = status;
        }
    }
}
