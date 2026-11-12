package de.crazybatto.robotschichtlog;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.LocalDate;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import javax.net.ssl.HttpsURLConnection;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

final class WebsiteTarget {
    static final String PORTAL = "https://crazybatto.de/robot-schichtlog/";
    private static final String API = "https://crazybatto.de/api/robot-schichtlog/photos";
    private final String token;

    WebsiteTarget(String token) {
        if (!token.matches("[A-Za-z0-9._~+/=-]{16,512}"))
            throw new IllegalArgumentException("Bitte das vollständige Geräte-Token eingeben.");
        this.token = token;
    }

    JSONObject syncOrders(JSONObject payload) throws IOException {
        byte[] bytes=payload.toString().getBytes(StandardCharsets.UTF_8);
        if(bytes.length>256*1024)throw new IOException("Zu viele Auftragsdaten in einer Übertragung.");
        HttpsURLConnection request=(HttpsURLConnection)new URL("https://crazybatto.de/api/robot-schichtlog/orders/sync").openConnection();
        request.setInstanceFollowRedirects(false);request.setConnectTimeout(15000);request.setReadTimeout(30000);
        request.setUseCaches(false);request.setRequestMethod("POST");request.setRequestProperty("Authorization","Bearer "+token);
        request.setRequestProperty("Content-Type","application/json; charset=utf-8");request.setRequestProperty("Accept","application/json");
        request.setDoOutput(true);request.setFixedLengthStreamingMode(bytes.length);
        try{
            try(OutputStream out=request.getOutputStream()){out.write(bytes);}
            int code=request.getResponseCode();
            if(code==401)throw new SiteError(code);
            if(code!=200)throw new OrderError(code);
            if(!"application/json".equals(mediaType(request)))throw new IOException("Ungültige Synchronisierungsantwort.");
            try(InputStream in=request.getInputStream()){return new JSONObject(readJson(in,4*1024*1024));}
            catch(JSONException invalid){throw new IOException("Ungültige Synchronisierungsantwort.");}
        }finally{request.disconnect();}
    }

    static final class OrderError extends IOException {
        final int code;
        OrderError(int code) {
            super(code==403 ? "Auftragszugriff für dieses Handy im Control Center prüfen: Robot SchichtLog → Geräte → Aufträge freigeben."
                : code==400 || code==413 || code==422 ? "Ein Auftragsstand wurde abgelehnt (HTTP "+code+"). Angaben im Verlauf prüfen; deine Daten bleiben lokal."
                : code==409 ? "Ein Auftrag gehört zu einem anderen Änderungsstand. Gerätezuordnung im Control Center prüfen."
                : code==404 || code==405 ? "Der Server unterstützt den Auftragsabgleich noch nicht. Control Center und Server aktualisieren."
                : "Auftragsabgleich vorübergehend nicht erreichbar (HTTP "+code+"). Wird erneut versucht.");
            this.code=code;
        }
        boolean retryable(){return code==408 || code==429 || code>=500;}
    }

    private HttpsURLConnection open(String method, String suffix) throws IOException {
        HttpsURLConnection request = (HttpsURLConnection) new URL(API + suffix).openConnection();
        request.setInstanceFollowRedirects(false);
        request.setConnectTimeout(15000);
        request.setReadTimeout(30000);
        request.setUseCaches(false);
        request.setRequestMethod(method);
        request.setRequestProperty("Authorization", "Bearer " + token);
        request.setRequestProperty("Accept", "application/json");
        return request;
    }

    boolean verifyPairing() throws IOException {
        HttpsURLConnection request = open("HEAD", "");
        try {
            int code = request.getResponseCode();
            if (code != 200 && code != 204) throw new SiteError(code);
            if (!"1".equals(request.getHeaderField("X-Schichtlog-Paired")))
                throw new SiteError(0);
            return "1".equals(request.getHeaderField("X-Schichtlog-Photo-Read"));
        } finally {
            request.disconnect();
        }
    }

    void upload(String day, String article, String order, String filename, File local) throws IOException {
        String id = filename.split("\\.", 2)[0];
        String hash = sha256(local);
        HttpsURLConnection request = open("POST", "");
        try {
            request.setDoOutput(true);
            request.setFixedLengthStreamingMode(local.length());
            request.setRequestProperty("Content-Type", NasSync.mimeFor(filename));
            request.setRequestProperty("X-Photo-Id", id);
            request.setRequestProperty("X-Photo-Day", day);
            request.setRequestProperty("X-Photo-Article", encode(article));
            request.setRequestProperty("X-Photo-Order", encode(order));
            request.setRequestProperty("X-Photo-SHA256", hash);
            try (OutputStream out = request.getOutputStream()) {
                Files.copy(local.toPath(), out);
            }
            int code = request.getResponseCode();
            if (code != 200 && code != 201) throw new SiteError(code);
            try (InputStream body = request.getInputStream()) {
                JSONObject receipt = new JSONObject(readJson(body, 8192));
                if (!id.equals(receipt.getString("id")) || !hash.equals(receipt.getString("sha256")))
                    throw new SiteError(0);
            } catch (JSONException invalid) {
                throw new SiteError(0);
            }
        } finally {
            request.disconnect();
        }
    }

    static final class Page {
        final List<RemotePhoto> photos;
        final String nextCursor;
        Page(List<RemotePhoto> photos, String nextCursor) {
            this.photos = photos;
            this.nextCursor = nextCursor;
        }
    }

    static final class RemotePhoto {
        final String id, sha256, mime, day;
        final long size;

        private RemotePhoto(JSONObject item) throws JSONException, SiteError {
            id = item.getString("id");
            sha256 = item.getString("sha256");
            mime = item.getString("mime");
            day = item.getString("day");
            Object bytes = item.get("size");
            if (!(bytes instanceof Integer || bytes instanceof Long)) throw new SiteError(0);
            size = ((Number) bytes).longValue();
            if (!id.matches("[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}")
                    || !sha256.matches("[a-f0-9]{64}") || size < 1 || size > 40L * 1024 * 1024
                    || !mime.matches("image/(?:png|jpeg|webp|gif|bmp|avif|heic|heif)")
                    || !day.matches("[0-9]{4}-[0-9]{2}-[0-9]{2}")) throw new SiteError(0);
            try { LocalDate.parse(day); } catch (DateTimeParseException badDate) { throw new SiteError(0); }
        }
    }

    Page listPhotos(String order, String article, String cursor) throws IOException {
        if (cursor != null && !cursor.matches("[a-zA-Z0-9_-]{1,384}")) throw new SiteError(0);
        HttpsURLConnection request = open("GET", cursor == null ? "" : "?cursor=" + cursor);
        try {
            scoped(request, order, article);
            int code = request.getResponseCode();
            if (code != 200) throw new SiteError(code);
            if (!"application/json".equals(mediaType(request))) throw new SiteError(0);
            try (InputStream in = request.getInputStream()) {
                JSONObject page = new JSONObject(readJson(in, 32768));
                JSONArray records = page.getJSONArray("photos");
                if (!page.has("nextCursor") || records.length() > 32) throw new SiteError(0);
                String next = page.isNull("nextCursor") ? null : page.getString("nextCursor");
                if (next != null && (!next.matches("[a-zA-Z0-9_-]{1,384}") || next.equals(cursor) || records.length() == 0))
                    throw new SiteError(0);
                List<RemotePhoto> photos = new ArrayList<>();
                Set<String> ids = new HashSet<>();
                for (int i = 0; i < records.length(); i++) {
                    RemotePhoto photo = new RemotePhoto(records.getJSONObject(i));
                    if (!ids.add(photo.id)) throw new SiteError(0);
                    photos.add(photo);
                }
                return new Page(photos, next);
            } catch (JSONException badData) { throw new SiteError(0); }
        } finally { request.disconnect(); }
    }

    void downloadPhoto(String order, String article, RemotePhoto photo, File destination) throws IOException {
        HttpsURLConnection request = open("GET", "/" + photo.id);
        Path temporary = null;
        try {
            scoped(request, order, article);
            request.setRequestProperty("Accept", photo.mime);
            request.setRequestProperty("Accept-Encoding", "identity");
            int code = request.getResponseCode();
            if (code != 200) throw new SiteError(code);
            if (!photo.mime.equals(mediaType(request)) || request.getContentLengthLong() != photo.size
                    || !photo.sha256.equals(request.getHeaderField("X-Photo-SHA256"))) throw new SiteError(0);
            Path output = destination.toPath().toAbsolutePath();
            temporary = Files.createTempFile(output.getParent(), ".schichtlog-", ".part");
            MessageDigest hash = newSha256();
            long count = 0;
            try (InputStream in = request.getInputStream(); OutputStream out = Files.newOutputStream(temporary)) {
                byte[] bytes = new byte[32768];
                int n;
                while ((n = in.read(bytes)) != -1) {
                    count += n;
                    if (count > photo.size) throw new SiteError(0);
                    out.write(bytes, 0, n);
                    hash.update(bytes, 0, n);
                }
            }
            if (count != photo.size || !photo.sha256.equals(hex(hash.digest()))) throw new SiteError(0);
            Files.move(temporary, output, StandardCopyOption.REPLACE_EXISTING);
        } finally {
            request.disconnect();
            if (temporary != null) Files.deleteIfExists(temporary);
        }
    }

    private static String mediaType(HttpsURLConnection request) {
        String type = request.getContentType();
        return type == null ? "" : type.split(";", 2)[0].trim().toLowerCase(Locale.ROOT);
    }

    private static void scoped(HttpsURLConnection request, String order, String article) throws SiteError {
        if (order == null || order.trim().isEmpty()) throw new SiteError(400);
        request.setRequestProperty("X-Photo-Order", encode(order));
        request.setRequestProperty("X-Photo-Article", encode(article));
    }

    private static String encode(String text) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(
                (text == null ? "" : text).getBytes(StandardCharsets.UTF_8));
    }

    private static String sha256(File file) throws IOException {
        MessageDigest digest = newSha256();
        try (InputStream in = Files.newInputStream(file.toPath())) {
            byte[] bytes = new byte[65536];
            int n;
            while ((n = in.read(bytes)) != -1) digest.update(bytes, 0, n);
        }
        return hex(digest.digest());
    }

    private static MessageDigest newSha256() {
        try { return MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException impossible) { throw new AssertionError(impossible); }
    }

    private static String hex(byte[] digest) {
        StringBuilder result = new StringBuilder(64);
        for (byte value : digest) result.append(String.format(Locale.ROOT, "%02x", value));
        return result.toString();
    }

    private static String readJson(InputStream body, int limit) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream();
        byte[] bytes = new byte[1024];
        int n;
        while ((n = body.read(bytes)) != -1) {
            if (buffer.size() + n > limit) throw new SiteError(0);
            buffer.write(bytes, 0, n);
        }
        return new String(buffer.toByteArray(), StandardCharsets.UTF_8);
    }

    static final class SiteError extends IOException {
        final int code;
        SiteError(int code) {
            super("Robot-SchichtLog upload response: " + code);
            this.code = code;
        }
        String hint() {
            switch (code) {
                case 401: case 403: return "Geräte-Token ungültig oder abgelaufen · neu verbinden";
                case 400: case 422: return "Webseite lehnt die Fotodaten ab";
                case 404: case 405: return "Fotozugang auf crazybatto.de noch nicht verfügbar";
                case 409: return "Foto-ID ist auf der Webseite bereits anders belegt";
                case 413: return "Foto überschreitet das Größenlimit der Webseite";
                case 415: return "Bildformat auf der Webseite nicht unterstützt";
                case 429: return "Webseite ausgelastet · wartet";
                case 0: return "Webseite hat den Fotozugang nicht bestätigt";
                default: return "Webseite meldet HTTP " + code;
            }
        }
    }
}
