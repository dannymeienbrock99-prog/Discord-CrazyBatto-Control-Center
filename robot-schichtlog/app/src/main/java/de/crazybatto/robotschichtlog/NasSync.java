package de.crazybatto.robotschichtlog;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.ActivityNotFoundException;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.text.InputType;
import android.util.Base64;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import java.io.File;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.time.LocalDate;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;
import javax.net.ssl.SSLException;

public final class NasSync {
    public static final String ACTION_STATUS = "de.crazybatto.robotschichtlog.NAS_STATUS";
    public static final int REQUEST_FOLDER = 7306;
    private static final int GRANTS = Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_WRITE_URI_PERMISSION;
    private static final ExecutorService FOLDER_SETUP = Executors.newSingleThreadExecutor();
    private static final int JOB = 172461;
    private static final int PERIODIC = JOB + 1;
    private static final String KEY = "schichtlog_webdav_v1";
    private static Store store;

    private NasSync() {}

    private static class Store extends SQLiteOpenHelper {
        Store(Context context) { super(context, "nas-uploads.db", null, 1); }

        @Override public void onCreate(SQLiteDatabase db) {
            db.execSQL("CREATE TABLE uploads(id TEXT PRIMARY KEY, file TEXT NOT NULL, day TEXT NOT NULL, "
                    + "article TEXT, order_no TEXT, remote_file TEXT NOT NULL, sent INTEGER NOT NULL DEFAULT 0, "
                    + "detail TEXT NOT NULL DEFAULT '')");
        }
        @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {}
    }

    private static synchronized SQLiteDatabase db(Context context) {
        if (store == null) store = new Store(context.getApplicationContext());
        return store.getWritableDatabase();
    }

    /** The photo ID and private local file must remain stable across launches. Safe to call again. */
    public static void enqueue(Context context, String photoId, File localPhoto, String dayIso,
                               String article, String order) {
        String day = LocalDate.parse(dayIso).toString();
        ContentValues row = new ContentValues();
        row.put("id", photoId);
        row.put("file", localPhoto.getAbsolutePath());
        row.put("day", day);
        row.put("article", article);
        row.put("order_no", order);
        String suffix = extension(localPhoto.getName());
        String remoteId = photoId.matches("(?i)[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}") ? photoId
                : UUID.nameUUIDFromBytes(photoId.getBytes(StandardCharsets.UTF_8)).toString();
        row.put("remote_file", remoteId + suffix);
        if (db(context).insertWithOnConflict("uploads", null, row, SQLiteDatabase.CONFLICT_IGNORE) != -1) {
            schedule(context);
        }
    }

    public static void forget(Context context, String photoId) {
        db(context).delete("uploads", "id=?", new String[]{photoId});
    }

    private static String extension(String name) {
        int dot = name.lastIndexOf('.');
        if (dot < 0) return "";
        String ext = name.substring(dot).toLowerCase(Locale.ROOT);
        return ext.matches("\\.[a-z0-9]{1,8}") ? ext : "";
    }

    static String mimeFor(String filename) {
        String ext = extension(filename);
        if (ext.isEmpty()) return "application/octet-stream";
        String mime = android.webkit.MimeTypeMap.getSingleton().getMimeTypeFromExtension(ext.substring(1));
        return mime == null ? "application/octet-stream" : mime;
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences("nas-settings", Context.MODE_PRIVATE);
    }

    private static boolean configured(SharedPreferences settings) {
        return settings.getBoolean("website", false) || !settings.getString("url", "").isEmpty()
                || !settings.getString("tree", "").isEmpty();
    }

    // Remote gallery work is scoped to one pairing revision. Never reuse decrypted credentials
    // or a previous gallery after replacing the device token, switching targets or disconnecting.
    static String galleryRevision(Context context) {
        SharedPreferences settings = prefs(context);
        return settings.getBoolean("website", false) ? settings.getString("revision", "") : null;
    }

    static boolean galleryCurrent(Context context, String revision) {
        return revision != null && revision.equals(galleryRevision(context))
                && !prefs(context).getBoolean("reauth", false);
    }

    static synchronized WebsiteTarget galleryTarget(Context context, String revision) throws IOException {
        if (!galleryCurrent(context, revision)) throw new WebsiteTarget.SiteError(401);
        try {
            return new WebsiteTarget(decrypt(prefs(context)));
        } catch (GeneralSecurityException | IllegalArgumentException failure) {
            throw new WebsiteTarget.SiteError(401);
        }
    }

    static synchronized void galleryUnauthorized(Context context, String revision) {
        if (galleryCurrent(context, revision)) {
            prefs(context).edit().putBoolean("reauth", true).apply();
            notifyGallery(context);
        }
    }

    public static String status(Context context, String photoId) {
        try (Cursor row = db(context).rawQuery("SELECT sent, detail FROM uploads WHERE id=?",
                new String[]{photoId})) {
            if (!row.moveToFirst()) return "Lokal";
            if (row.getInt(0) == 1) return "Auf dem NAS";
            if (row.getInt(0) == 2) return "Im gewählten Ordner";
            if (row.getInt(0) == 3) return "Privat auf crazybatto.de";
            if (!configured(prefs(context))) return "Lokal · Fotoziel einrichten";
            if (prefs(context).getBoolean("reauth", false)) return "Geräte-Token erneut verbinden";
            String detail = row.getString(1);
            return detail.isEmpty() ? "Wartet auf Fotoupload" : detail;
        }
    }

    static String queueSummary(Context context) {
        try (Cursor rows=db(context).rawQuery("SELECT SUM(CASE WHEN sent<0 THEN 1 ELSE 0 END),SUM(CASE WHEN sent=0 THEN 1 ELSE 0 END),SUM(CASE WHEN sent=3 THEN 1 ELSE 0 END) FROM uploads",null)) {
            rows.moveToFirst();
            return rows.getLong(1)+" Fotos warten · "+rows.getLong(2)+" Fotos auf crazybatto.de bestätigt"
                    +(rows.getLong(0)>0?" · "+rows.getLong(0)+" Fotos prüfen (Details am Bild)":"");
        }
    }

    /** Android persists a periodic safety job; the one-shot job sends new photos promptly. */
    public static synchronized void schedule(Context context) {
        if (!configured(prefs(context)) || prefs(context).getBoolean("reauth", false)) return;
        JobScheduler scheduler = context.getSystemService(JobScheduler.class);
        ComponentName service = new ComponentName(context, NasUploadJob.class);
        if (scheduler.getPendingJob(PERIODIC) == null) {
            scheduler.schedule(new JobInfo.Builder(PERIODIC, service)
                    .setPeriodic(15 * 60_000L).setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setPersisted(true).build());
        }
        if (scheduler.getPendingJob(JOB) == null) {
            scheduler.schedule(new JobInfo.Builder(JOB, service)
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setBackoffCriteria(60_000L, JobInfo.BACKOFF_POLICY_EXPONENTIAL)
                    .setPersisted(true).build());
        }
    }

    private interface Target {
        void upload(String day, String article, String order, String filename, File local) throws IOException;
    }

    /** Drained on NasUploadJob's single worker. Returns true for retryable failures. */
    static boolean uploadPending(Context context) {
        SharedPreferences settings = prefs(context);
        Target destination;
        boolean isFolder, isWebsite;
        String revision;
        synchronized (NasSync.class) {
            String url = settings.getString("url", "");
            String tree = settings.getString("tree", "");
            isFolder = !tree.isEmpty();
            isWebsite = settings.getBoolean("website", false);
            if (isWebsite && settings.getBoolean("reauth", false)) return false;
            if (!isWebsite && !isFolder && url.isEmpty()) return false;
            revision = settings.getString("revision", "");
            try {
                if (isWebsite) destination = new WebsiteTarget(decrypt(settings))::upload;
                else if (isFolder) destination = new FolderTarget(context, Uri.parse(tree))::upload;
                else destination = new DavTarget(url, settings.getString("username", ""), decrypt(settings))::upload;
            } catch (Exception unavailable) {
                ContentValues failure = new ContentValues();
                failure.put("detail", isWebsite ? "Geräte-Token erneut verbinden" : "NAS-Zugang erneut speichern");
                db(context).update("uploads", failure, "sent=0", null);
                notifyGallery(context);
                return false;
            }
        }
        boolean retry = false;
        int attempted = 0;
        long deadline = android.os.SystemClock.elapsedRealtime() + 90_000;
        try (Cursor rows = db(context).rawQuery("SELECT id,file,day,article,order_no,remote_file "
                + "FROM uploads WHERE sent=0 ORDER BY rowid", null)) {
            while (rows.moveToNext() && !Thread.currentThread().isInterrupted()) {
                if (attempted >= 8 || android.os.SystemClock.elapsedRealtime() >= deadline) return true;
                if (!revision.equals(settings.getString("revision", ""))) return true;
                String id = rows.getString(0);
                try (Cursor live = db(context).rawQuery("SELECT 1 FROM uploads WHERE id=? AND sent=0",
                        new String[]{id})) {
                    if (!live.moveToFirst()) continue;
                }
                File file = new File(rows.getString(1));
                if (!file.isFile() || file.length() == 0) {
                    update(context, id, -1, "Lokale Bilddatei fehlt · Bild erneut hinzufügen");
                    continue;
                }
                try {
                    attempted++;
                    destination.upload(rows.getString(2), rows.getString(3), rows.getString(4),
                            rows.getString(5), file);
                    if (!revision.equals(settings.getString("revision", ""))) return true;
                    update(context, id, isWebsite ? 3 : (isFolder ? 2 : 1), "");
                } catch (WebsiteTarget.SiteError error) {
                    update(context, id, 0, error.hint());
                    if (error.code == 401 || error.code == 403) {
                        synchronized (NasSync.class) {
                            if (revision.equals(settings.getString("revision", "")))
                                settings.edit().putBoolean("reauth", true).apply();
                        }
                        notifyGallery(context);
                        return false;
                    }
                    if (error.code == 0 || error.code == 404 || error.code == 429 || error.code >= 500) return true;
                    update(context, id, -1, error.hint()+" · Foto prüfen und Fotoziel erneut verbinden");
                } catch (DavTarget.DavError error) {
                    String hint;
                    switch (error.status) {
                        case 401: hint = "NAS-Anmeldung prüfen"; break;
                        case 403: hint = "NAS-Schreibrecht prüfen"; break;
                        case 404: case 409: hint = "NAS-Zielordner prüfen"; break;
                        case 507: hint = "NAS-Speicher voll"; break;
                        default: hint = "NAS meldet HTTP " + error.status;
                    }
                    update(context, id, 0, hint);
                    retry = true;
                    if (error.status == 401 || error.status == 403 || error.status == 507) break;
                } catch (SSLException error) {
                    update(context, id, 0, isWebsite ? "HTTPS-Zertifikat der Webseite prüfen" : "NAS-Zertifikat oder HTTPS prüfen");
                    return true;
                } catch (SecurityException error) {
                    update(context, id, 0, "Ordnerberechtigung fehlt · neu wählen");
                    return true;
                } catch (IllegalArgumentException | UnsupportedOperationException error) {
                    update(context, id, 0, "NAS-Ziel prüfen");
                    return true;
                } catch (IOException error) {
                    update(context, id, 0, isWebsite ? "Webseite nicht erreichbar · wartet"
                            : (isFolder ? "Zielordner prüfen · wartet" : "NAS nicht erreichbar · wartet"));
                    return true;
                }
            }
        }
        return retry || Thread.currentThread().isInterrupted();
    }

    private static void update(Context context, String id, int sent, String detail) {
        ContentValues values = new ContentValues();
        values.put("sent", sent);
        values.put("detail", detail);
        db(context).update("uploads", values, "id=?", new String[]{id});
        notifyGallery(context);
    }

    private static void notifyGallery(Context context) {
        context.sendBroadcast(new Intent(ACTION_STATUS).setPackage(context.getPackageName()));
    }

    private static SecretKey key() throws GeneralSecurityException, IOException {
        KeyStore keyStore = KeyStore.getInstance("AndroidKeyStore");
        keyStore.load(null);
        SecretKey existing = (SecretKey) keyStore.getKey(KEY, null);
        if (existing != null) return existing;
        KeyGenerator generator = KeyGenerator.getInstance("AES", "AndroidKeyStore");
        generator.init(new KeyGenParameterSpec.Builder(KEY,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build());
        return generator.generateKey();
    }

    private static synchronized String decrypt(SharedPreferences settings)
            throws GeneralSecurityException, IOException {
        String encrypted = settings.getString("secret", "");
        if (encrypted.isEmpty()) return "";
        Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
        cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128,
                Base64.decode(settings.getString("iv", ""), Base64.NO_WRAP)));
        return new String(cipher.doFinal(Base64.decode(encrypted, Base64.NO_WRAP)), StandardCharsets.UTF_8);
    }

    private static synchronized void save(Context context, String url, String user, String password, boolean website)
            throws GeneralSecurityException, IOException {
        String oldTree = prefs(context).getString("tree", "");
        SharedPreferences.Editor edit = prefs(context).edit().clear().putString("url", url).putString("username", user)
                .putBoolean("website", website).putString("revision", UUID.randomUUID().toString());
        if (password.isEmpty()) {
            edit.remove("iv").remove("secret");
        } else {
            Cipher cipher = Cipher.getInstance("AES/GCM/NoPadding");
            cipher.init(Cipher.ENCRYPT_MODE, key());
            byte[] encrypted = cipher.doFinal(password.getBytes(StandardCharsets.UTF_8));
            edit.putString("iv", Base64.encodeToString(cipher.getIV(), Base64.NO_WRAP))
                    .putString("secret", Base64.encodeToString(encrypted, Base64.NO_WRAP));
        }
        if (!edit.commit()) throw new IOException("NAS-Einstellungen konnten nicht gespeichert werden.");
        releaseTree(context, oldTree);
    }

    private static void releaseTree(Context context, String oldTree) {
        if (oldTree.isEmpty()) return;
        try {
            context.getContentResolver().releasePersistableUriPermission(Uri.parse(oldTree), GRANTS);
        } catch (SecurityException alreadyRevoked) { /* The provider or user revoked this grant. */ }
    }

    private static void restartQueue(Context context) {
        ContentValues values = new ContentValues();
        values.put("detail", "");
        values.put("sent", 0);
        db(context).update("uploads", values, "sent<=0", null);
        context.getSystemService(JobScheduler.class).cancel(JOB);
        schedule(context);
        notifyGallery(context);
    }

    static void retryPending(Context context) { restartQueue(context); }

    public static void onFolderResult(Activity activity, int resultCode, Intent data) {
        if (resultCode != Activity.RESULT_OK || data == null || data.getData() == null) return;
        Uri tree = data.getData();
        Context app = activity.getApplicationContext();
        boolean granted = (data.getFlags() & GRANTS) == GRANTS;
        FOLDER_SETUP.execute(() -> {
            String message;
            try {
                if (!granted) throw new SecurityException("Fehlende Berechtigung.");
                app.getContentResolver().takePersistableUriPermission(tree, GRANTS);
                String name = new FolderTarget(app, tree).validate();
                synchronized (NasSync.class) {
                    SharedPreferences settings = prefs(app);
                    String previous = settings.getString("tree", "");
                    if (!settings.edit().clear().putString("tree", tree.toString()).putString("label", name)
                            .putString("revision", UUID.randomUUID().toString()).commit())
                        throw new IOException("Ordner konnte nicht gespeichert werden.");
                    if (!previous.equals(tree.toString())) releaseTree(app, previous);
                }
                restartQueue(app);
                message = "Zielordner gespeichert: " + name;
            } catch (Exception unavailable) {
                if (!tree.toString().equals(prefs(app).getString("tree", ""))) releaseTree(app, tree.toString());
                message = "Ordner konnte nicht dauerhaft zum Lesen und Schreiben freigegeben werden.";
            }
            String result = message;
            new Handler(Looper.getMainLooper()).post(() -> Toast.makeText(app, result, Toast.LENGTH_LONG).show());
        });
    }

    private static EditText field(Activity activity, LinearLayout layout, String label, int type, String value) {
        TextView heading = new TextView(activity);
        heading.setText(label);
        EditText edit = new EditText(activity);
        edit.setSingleLine(true);
        edit.setInputType(type);
        edit.setText(value);
        edit.setId(View.generateViewId());
        heading.setLabelFor(edit.getId());
        layout.addView(heading);
        layout.addView(edit);
        return edit;
    }

    public static void showSettings(Activity activity) {
        SharedPreferences settings = prefs(activity);
        LinearLayout layout = new LinearLayout(activity);
        int pad = Math.round(20 * activity.getResources().getDisplayMetrics().density);
        layout.setPadding(pad, pad, pad, pad);
        layout.setOrientation(LinearLayout.VERTICAL);
        String active = "Noch kein Fotoziel verbunden";
        if (settings.getBoolean("website", false))
            active = settings.getBoolean("reauth", false) ? "Geräte-Token für crazybatto.de erneuern" : "Verbunden mit crazybatto.de";
        else if (!settings.getString("tree", "").isEmpty()) active = "Aktiv: " + settings.getString("label", "NAS-Ordner");
        else if (!settings.getString("url", "").isEmpty()) active = "Aktiv: WebDAV";
        TextView summary = new TextView(activity);
        summary.setText(active + "\n" + queueSummary(activity) + "\n\nErstelle auf deiner Webseite einen Gerätecode. Gib dort den Fotoabruf frei, "
                + "wenn dieses Handy vorhandene Auftragsfotos ansehen soll. Nach dem Verbinden werden neue "
                + "und noch offene Fotos privat an crazybatto.de übertragen.");
        layout.addView(summary);
        Button portal = new Button(activity);
        portal.setText("Geräte-Token auf crazybatto.de holen");
        portal.setAllCaps(false);
        portal.setOnClickListener(v -> {
            try {
                activity.startActivity(new Intent(Intent.ACTION_VIEW, Uri.parse(WebsiteTarget.PORTAL)));
            } catch (ActivityNotFoundException missing) {
                Toast.makeText(activity, WebsiteTarget.PORTAL, Toast.LENGTH_LONG).show();
            }
        });
        layout.addView(portal);
        if(configured(settings)) {
            Button retry=new Button(activity);retry.setText("Wartende Fotos erneut übertragen");retry.setAllCaps(false);
            retry.setOnClickListener(v->{restartQueue(activity);Toast.makeText(activity,"Fotoupload erneut eingeplant. Bildstatus nach dem Abgleich prüfen.",Toast.LENGTH_LONG).show();});
            layout.addView(retry);
        }
        EditText token = field(activity, layout, "Geräte-Token",
                InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD, "");
        token.setImportantForAutofill(View.IMPORTANT_FOR_AUTOFILL_NO);
        token.setSaveEnabled(false);
        Button alternatives = new Button(activity);
        alternatives.setText("NAS-Ordner oder WebDAV einrichten");
        alternatives.setAllCaps(false);
        layout.addView(alternatives);
        ScrollView scroll = new ScrollView(activity);
        scroll.addView(layout);
        AlertDialog.Builder builder = new AlertDialog.Builder(activity).setTitle("Privater Fotoupload")
                .setView(scroll).setNegativeButton("Schließen", null)
                .setPositiveButton("Verbinden", null);
        if (configured(settings)) builder.setNeutralButton("Trennen", (d, which) -> disconnect(activity));
        AlertDialog dialog = builder.create();
        dialog.show();
        alternatives.setOnClickListener(v -> { dialog.dismiss(); showNasOptions(activity); });
        Button connect = dialog.getButton(AlertDialog.BUTTON_POSITIVE);
        connect.setText("crazybatto.de verbinden");
        connect.setAllCaps(false);
        connect.setOnClickListener(v -> {
            String value = token.getText().toString().trim();
            WebsiteTarget target;
            try { target = new WebsiteTarget(value); }
            catch (IllegalArgumentException bad) { token.setError(bad.getMessage()); return; }
            connect.setEnabled(false);
            token.setEnabled(false);
            connect.setText("Zugang wird geprüft …");
            FOLDER_SETUP.execute(() -> {
                String failure = null;
                try { target.verifyPairing(); }
                catch (WebsiteTarget.SiteError response) { failure = response.hint(); }
                catch (SSLException tls) { failure = "HTTPS-Zertifikat der Webseite prüfen."; }
                catch (IOException network) { failure = "crazybatto.de ist nicht erreichbar."; }
                String error = failure;
                activity.runOnUiThread(() -> {
                    if (!dialog.isShowing() || activity.isFinishing() || activity.isDestroyed()) return;
                    connect.setEnabled(true);
                    token.setEnabled(true);
                    connect.setText("crazybatto.de verbinden");
                    if (error != null) { token.setError(error); return; }
                    try {
                        save(activity, "", "", value, true);
                        restartQueue(activity);
                        token.setText("");
                        dialog.dismiss();
                        Toast.makeText(activity, "Mit crazybatto.de verbunden.", Toast.LENGTH_LONG).show();
                    } catch (Exception unavailable) {
                        token.setError("Das Geräte-Token konnte nicht sicher gespeichert werden.");
                    }
                });
            });
        });
    }

    private static void disconnect(Activity activity) {
        SharedPreferences settings = prefs(activity);
        synchronized (NasSync.class) {
            String oldTree = settings.getString("tree", "");
            settings.edit().clear().apply();
            releaseTree(activity, oldTree);
        }
        JobScheduler scheduler = activity.getSystemService(JobScheduler.class);
        scheduler.cancel(JOB);
        scheduler.cancel(PERIODIC);
        notifyGallery(activity);
        Toast.makeText(activity, "Fotoziel getrennt. Deine Fotos bleiben auf dem Gerät.", Toast.LENGTH_LONG).show();
    }

    private static void showNasOptions(Activity activity) {
        SharedPreferences settings = prefs(activity);
        LinearLayout layout = new LinearLayout(activity);
        int pad = Math.round(20 * activity.getResources().getDisplayMetrics().density);
        layout.setPadding(pad, pad, pad, pad);
        layout.setOrientation(LinearLayout.VERTICAL);
        TextView intro = new TextView(activity);
        String targetLabel = settings.getString("label", "");
        intro.setText((targetLabel.isEmpty() ? "" : "Gewählter Ordner: " + targetLabel + "\n\n")
                + "Ist dein NAS im Android-Dateidialog sichtbar, wähle dort seinen Zielordner. "
                + "Alternativ kannst du unten einen WebDAV-Zugang hinterlegen. "
                + "Nach einem Zielwechsel gehen nur noch offene und neue Fotos an das neue Ziel.");
        layout.addView(intro);
        Button chooseFolder = new Button(activity);
        chooseFolder.setText("NAS-Ordner auswählen");
        chooseFolder.setAllCaps(false);
        layout.addView(chooseFolder);
        EditText url = field(activity, layout, "WebDAV-Zielordner (HTTPS)",
                InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_URI, settings.getString("url", ""));
        url.setHint("https://nas.example.de:5006/Schichtbilder/");
        EditText user = field(activity, layout, "Benutzername",
                InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS, settings.getString("username", ""));
        EditText pass = field(activity, layout, "Passwort",
                InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD, "");
        boolean hasSecret = !settings.getString("url", "").isEmpty()
                && !settings.getString("secret", "").isEmpty();
        if (hasSecret) pass.setHint("Gespeichertes Passwort beibehalten");
        ScrollView scroll = new ScrollView(activity);
        scroll.addView(layout);
        AlertDialog.Builder builder = new AlertDialog.Builder(activity).setTitle("NAS-Fotoupload")
                .setView(scroll).setNegativeButton("Abbrechen", null)
                .setPositiveButton("WebDAV speichern", null);
        if (configured(settings)) {
            builder.setNeutralButton("Trennen", (d, which) -> disconnect(activity));
        }
        AlertDialog dialog = builder.create();
        dialog.show();
        chooseFolder.setOnClickListener(v -> {
            Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
            pick.addFlags(GRANTS | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
            try {
                activity.startActivityForResult(pick, REQUEST_FOLDER);
                dialog.dismiss();
            } catch (ActivityNotFoundException missing) {
                Toast.makeText(activity, "Kein Android-Dateidialog verfügbar.", Toast.LENGTH_LONG).show();
            }
        });
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            String address;
            try {
                address = DavTarget.normalize(url.getText().toString()).toString();
            } catch (IllegalArgumentException invalid) {
                url.setError("HTTPS-Adresse ohne Zugangsdaten, Suchparameter oder Fragment eingeben.");
                return;
            }
            String username = user.getText().toString().trim();
            if (username.contains(":")) {
                user.setError("Der Benutzername darf keinen Doppelpunkt enthalten.");
                return;
            }
            String password = pass.getText().toString();
            if (!username.isEmpty() && password.isEmpty() && hasSecret) {
                if (!address.equals(settings.getString("url", ""))
                        || !username.equals(settings.getString("username", ""))) {
                    pass.setError("Für diesen NAS-Zugang das Passwort neu eingeben.");
                    return;
                }
                try {
                    password = decrypt(settings);
                } catch (Exception unavailable) {
                    pass.setError("Bitte Passwort erneut eingeben.");
                    return;
                }
            }
            if (username.isEmpty() && !password.isEmpty()) {
                user.setError("Für das Passwort wird ein Benutzername benötigt.");
                return;
            }
            try {
                save(activity, address, username, password, false);
                restartQueue(activity);
                dialog.dismiss();
                Toast.makeText(activity, "NAS gespeichert. Offene Fotos werden übertragen.", Toast.LENGTH_LONG).show();
            } catch (Exception unavailable) {
                pass.setError("NAS-Zugang konnte nicht sicher gespeichert werden.");
            }
        });
    }
}
