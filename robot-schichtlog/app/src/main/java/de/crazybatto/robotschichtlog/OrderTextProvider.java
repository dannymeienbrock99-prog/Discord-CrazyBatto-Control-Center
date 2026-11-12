package de.crazybatto.robotschichtlog;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.MatrixCursor;
import android.net.Uri;
import android.os.ParcelFileDescriptor;
import android.provider.OpenableColumns;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.UUID;

/** Read-only temporary TXT exports; never exposes databases, photos, or arbitrary app files. */
public final class OrderTextProvider extends ContentProvider {
    static Uri write(Context context, String orderNumber, String text) throws IOException {
        File folder = new File(context.getCacheDir(), "order-text");
        if (!folder.isDirectory() && !folder.mkdirs()) throw new IOException("Exportordner konnte nicht erstellt werden.");
        String order = orderNumber == null ? "Auftrag" : orderNumber.replaceAll("[^A-Za-z0-9_-]", "_");
        if (order.length() > 60) order = order.substring(0, 60);
        File file = new File(folder, "Auftrag_" + order + "_" + UUID.randomUUID() + ".txt");
        try (FileOutputStream output = new FileOutputStream(file)) {
            output.write(text.getBytes(StandardCharsets.UTF_8));
        }
        return new Uri.Builder().scheme("content").authority(context.getPackageName() + ".ordertext")
                .appendPath("order-text").appendPath(file.getName()).build();
    }

    @Override public boolean onCreate() { return true; }

    private File resolve(Uri uri) throws FileNotFoundException {
        if (!"content".equals(uri.getScheme()) || !(getContext().getPackageName() + ".ordertext").equals(uri.getAuthority())
                || uri.getPathSegments().size() != 2 || !"order-text".equals(uri.getPathSegments().get(0)))
            throw new FileNotFoundException("Ungültiger Export.");
        String name = uri.getLastPathSegment();
        if (name == null || !name.matches("Auftrag_[A-Za-z0-9_-]+\\.txt")) throw new FileNotFoundException("Ungültiger Exportname.");
        try {
            File folder = new File(getContext().getCacheDir(), "order-text").getCanonicalFile();
            File file = new File(folder, name).getCanonicalFile();
            if (!folder.equals(file.getParentFile()) || !file.isFile()) throw new FileNotFoundException("Export nicht mehr verfügbar.");
            return file;
        } catch (IOException ex) { throw new FileNotFoundException("Export nicht verfügbar."); }
    }

    @Override public ParcelFileDescriptor openFile(Uri uri, String mode) throws FileNotFoundException {
        if (!"r".equals(mode)) throw new FileNotFoundException("Nur Lesen ist erlaubt.");
        return ParcelFileDescriptor.open(resolve(uri), ParcelFileDescriptor.MODE_READ_ONLY);
    }

    @Override public Cursor query(Uri uri, String[] projection, String selection, String[] args, String sortOrder) {
        try {
            File file = resolve(uri);
            String[] columns = projection == null ? new String[]{OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE} : projection;
            MatrixCursor result = new MatrixCursor(columns, 1);
            Object[] values = new Object[columns.length];
            for (int i = 0; i < columns.length; i++) {
                if (OpenableColumns.DISPLAY_NAME.equals(columns[i])) values[i] = file.getName();
                if (OpenableColumns.SIZE.equals(columns[i])) values[i] = file.length();
            }
            result.addRow(values);
            return result;
        } catch (FileNotFoundException ex) { return null; }
    }

    @Override public String getType(Uri uri) { return "text/plain"; }
    @Override public Uri insert(Uri uri, ContentValues values) { throw new UnsupportedOperationException("Read only"); }
    @Override public int update(Uri uri, ContentValues values, String selection, String[] args) { throw new UnsupportedOperationException("Read only"); }
    @Override public int delete(Uri uri, String selection, String[] args) { throw new UnsupportedOperationException("Read only"); }
}
