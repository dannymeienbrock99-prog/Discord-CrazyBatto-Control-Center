package de.crazybatto.robotschichtlog;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.util.Log;
import android.webkit.MimeTypeMap;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

final class OrderPhotos {
    static final ExecutorService IMPORTS = Executors.newSingleThreadExecutor();
    private static final String SELECT = "SELECT a.id,a.uri,a.display_name," +
            "CASE WHEN a.added_at=0 THEN e.timestamp ELSE a.added_at END AS photo_time," +
            "e.article_number,e.order_number FROM attachments a JOIN entries e ON e.id=a.entry_id " +
            "WHERE a.mime_type LIKE 'image/%'";

    static final class Photo {
        final long id, time;
        final String uri, name, article, order;

        Photo(Cursor row) {
            id = row.getLong(0);
            uri = row.getString(1);
            name = row.getString(2);
            time = row.getLong(3);
            article = row.getString(4);
            order = row.getString(5);
        }
    }

    static List<Photo> forOrder(DbHelper db, String article, String order) {
        return query(db, " AND e.article_number=? AND e.order_number=? ORDER BY photo_time DESC,a.id DESC",
                new String[]{article == null ? "" : article, order});
    }

    private static List<Photo> query(DbHelper db, String filter, String[] args) {
        List<Photo> photos = new ArrayList<>();
        try (Cursor rows = db.getReadableDatabase().rawQuery(SELECT + filter, args)) {
            while (rows.moveToNext()) photos.add(new Photo(rows));
        }
        return photos;
    }

    // Keep the original bytes, including EXIF metadata. Validate before publishing the private copy.
    static File importImage(Context context, Uri source) throws IOException {
        File directory = new File(context.getFilesDir(), "order-photos");
        if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Fotoordner ist nicht verfügbar.");
        String id = UUID.randomUUID().toString();
        File temporary = new File(directory, id + ".part");
        try {
            try (InputStream in = context.getContentResolver().openInputStream(source);
                 FileOutputStream out = new FileOutputStream(temporary)) {
                if (in == null) throw new IOException("Bild kann nicht geöffnet werden.");
                byte[] buffer = new byte[32768];
                int count;
                while ((count = in.read(buffer)) != -1) out.write(buffer, 0, count);
            }
            BitmapFactory.Options bounds = new BitmapFactory.Options();
            bounds.inJustDecodeBounds = true;
            BitmapFactory.decodeFile(temporary.getPath(), bounds);
            if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw new IOException("Dieses Bildformat lässt sich nicht anzeigen.");
            String extension = MimeTypeMap.getSingleton().getExtensionFromMimeType(bounds.outMimeType);
            File photo = new File(directory, id + "." + (extension == null ? "img" : extension));
            if (!temporary.renameTo(photo)) throw new IOException("Foto konnte nicht gespeichert werden.");
            return photo;
        } finally {
            if (temporary.exists()) temporary.delete();
        }
    }

    static File privateCopy(Context context, String uri) {
        Uri parsed = Uri.parse(uri);
        if (!"file".equals(parsed.getScheme()) || parsed.getPath() == null) return null;
        File photo = new File(parsed.getPath());
        File directory = new File(context.getFilesDir(), "order-photos");
        return directory.equals(photo.getParentFile()) ? photo : null;
    }

    static String photoId(File file) {
        String name = file.getName();
        int dot = name.indexOf('.');
        return dot < 0 ? name : name.substring(0, dot);
    }

    static long save(Context app, Record record, List<Attachment> media, boolean manual) throws IOException {
        List<File> copies = new ArrayList<>();
        boolean committed = false;
        try (DbHelper db = new DbHelper(app)) {
            for (Attachment attachment : media) {
                if (!attachment.mimeType.startsWith("image/")) continue;
                File local = importImage(app, Uri.parse(attachment.uri));
                copies.add(local);
                attachment.uri = Uri.fromFile(local).toString();
            }
            long id;
            if (manual) {
                id = db.insertRecordWithAttachments(record, media);
            } else {
                SQLiteDatabase sql = db.getWritableDatabase();
                sql.beginTransaction();
                try {
                    id = record.id > 0 ? record.id : findStart(db, record);
                    for (Attachment photo : media) db.insertAttachment(id, photo.uri, photo.mimeType, photo.displayName);
                    sql.setTransactionSuccessful();
                } finally {
                    sql.endTransaction();
                }
            }
            committed = true;
            syncEntry(app, id);
            return id;
        } finally {
            if (!committed) for (File file : copies) file.delete();
        }
    }

    private static long findStart(DbHelper db, Record job) {
        try (Cursor row = db.getReadableDatabase().rawQuery(
                "SELECT id FROM entries WHERE started_at=? AND robot=? AND order_number=? AND article_number=? " +
                "AND source IN ('Auftrag gestartet','Auftragsfotos') ORDER BY id LIMIT 1",
                new String[]{Long.toString(job.startedAt), Integer.toString(job.robot), job.orderNumber, job.articleNumber})) {
            if (row.moveToFirst()) return row.getLong(0);
        }
        // Jobs already active on v1.5.1 have no start entry.
        return db.insertRecord(job);
    }

    static void recover(Context context) {
        sync(context, null);
    }

    static void syncEntry(Context context, long id) {
        sync(context, id);
    }

    static void deleteEntry(Context context, DbHelper db, long entryId) {
        List<Photo> removed = query(db, " AND a.entry_id=?", new String[]{Long.toString(entryId)});
        db.deleteRecord(entryId);
        for (Photo photo : removed) {
            File file = privateCopy(context, photo.uri);
            if (file != null && !isLinked(db, file)) forgetCopy(context, file);
        }
    }

    private static boolean isLinked(DbHelper db, File file) {
        try (Cursor row = db.getReadableDatabase().rawQuery("SELECT 1 FROM attachments WHERE uri=? LIMIT 1",
                new String[]{Uri.fromFile(file).toString()})) {
            return row.moveToFirst();
        }
    }

    private static void forgetCopy(Context context, File file) {
        NasSync.forget(context, photoId(file));
        file.delete();
    }

    private static void sync(Context context, Long entryId) {
        Context app = context.getApplicationContext();
        IMPORTS.execute(() -> {
            try (DbHelper db = new DbHelper(app)) {
                List<Photo> photos = entryId == null ? query(db, "", null)
                        : query(db, " AND a.entry_id=?", new String[]{entryId.toString()});
                if (entryId == null) {
                    // Reclaim incomplete imports and complete a deletion interrupted by process death.
                    Set<String> linked = new HashSet<>();
                    for (Photo photo : photos) linked.add(photo.uri);
                    File[] files = new File(app.getFilesDir(), "order-photos").listFiles();
                    if (files != null) for (File file : files) {
                        if (file.isFile() && !linked.contains(Uri.fromFile(file).toString())) forgetCopy(app, file);
                    }
                }
                for (Photo photo : photos) {
                    try {
                        File copy = privateCopy(app, photo.uri);
                        if (copy == null) {
                            copy = importImage(app, Uri.parse(photo.uri));
                            ContentValues changed = new ContentValues();
                            changed.put("uri", Uri.fromFile(copy).toString());
                            int updated = db.getWritableDatabase().update("attachments", changed, "id=? AND uri=?",
                                    new String[]{String.valueOf(photo.id), photo.uri});
                            if (updated != 1) { copy.delete(); continue; }
                        }
                        if (copy.isFile()) {
                            String day = new SimpleDateFormat("yyyy-MM-dd", Locale.ROOT).format(new Date(photo.time));
                            NasSync.enqueue(app, photoId(copy), copy, day, photo.article, photo.order);
                        }
                    } catch (Exception ex) {
                        // A broken historic document grant must not prevent uploads for other orders.
                        Log.w("OrderPhotos", "Foto " + photo.id + " konnte nicht bereitgestellt werden", ex);
                    }
                }
            }
        });
    }

    private OrderPhotos() {}
}
