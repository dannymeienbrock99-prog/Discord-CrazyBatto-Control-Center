package de.crazybatto.robotschichtlog;

import android.content.ContentResolver;
import android.content.Context;
import android.content.UriPermission;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.provider.DocumentsContract.Document;
import java.io.File;
import java.io.FileNotFoundException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;

final class FolderTarget {
    private final ContentResolver resolver;
    private final Uri tree;
    private final Uri root;

    FolderTarget(Context context, Uri tree) {
        if (!DocumentsContract.isTreeUri(tree) || !"content".equals(tree.getScheme()))
            throw new IllegalArgumentException("Bitte einen Ordner im Android-Dateidialog wählen.");
        resolver = context.getContentResolver();
        this.tree = tree;
        root = DocumentsContract.buildDocumentUriUsingTree(tree, DocumentsContract.getTreeDocumentId(tree));
    }

    String validate() throws IOException {
        boolean persisted = false;
        for (UriPermission grant : resolver.getPersistedUriPermissions()) {
            if (tree.equals(grant.getUri()) && grant.isReadPermission() && grant.isWritePermission()) {
                persisted = true;
                break;
            }
        }
        if (!persisted) throw new SecurityException("Ordner erneut freigeben.");
        try (Cursor row = resolver.query(root, new String[]{Document.COLUMN_DISPLAY_NAME,
                Document.COLUMN_MIME_TYPE, Document.COLUMN_FLAGS}, null, null, null)) {
            if (row == null || !row.moveToFirst()) throw new IOException("Ordner nicht erreichbar.");
            if (!Document.MIME_TYPE_DIR.equals(row.getString(1))
                    || (row.getInt(2) & Document.FLAG_DIR_SUPPORTS_CREATE) == 0)
                throw new IOException("Ordner erlaubt keine neuen Dateien.");
            return row.getString(0);
        }
    }

    void upload(String day, String article, String order, String name, File local) throws IOException {
        Uri dir = root;
        for (String part : new String[]{day, DavTarget.folder("Artikel-", article), DavTarget.folder("Auftrag-", order)})
            dir = child(dir, part, Document.MIME_TYPE_DIR);
        Uri file = child(dir, name, NasSync.mimeFor(name));
        MessageDigest expected = sha256();
        OutputStream stream;
        try {
            stream = resolver.openOutputStream(file, "wt");
        } catch (FileNotFoundException | UnsupportedOperationException unsupported) {
            stream = resolver.openOutputStream(file, "w");
        }
        if (stream == null) throw new IOException("Datei nicht beschreibbar.");
        try (OutputStream out = stream; InputStream in = Files.newInputStream(local.toPath())) {
            transfer(in, out, expected);
        }
        MessageDigest actual = sha256();
        try (InputStream in = resolver.openInputStream(file)) {
            if (in == null) throw new IOException("Datei im Zielordner nicht lesbar.");
            transfer(in, null, actual);
        }
        if (!MessageDigest.isEqual(expected.digest(), actual.digest()))
            throw new IOException("Die Kopie im Zielordner ist unvollständig.");
    }

    private static void transfer(InputStream in, OutputStream out, MessageDigest digest) throws IOException {
        byte[] bytes = new byte[65536];
        int count;
        while ((count = in.read(bytes)) != -1) {
            if (Thread.currentThread().isInterrupted()) throw new IOException("Übertragung unterbrochen.");
            if (out != null) out.write(bytes, 0, count);
            digest.update(bytes, 0, count);
        }
    }

    private static MessageDigest sha256() {
        try {
            return MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException impossible) {
            throw new AssertionError(impossible);
        }
    }

    private Uri child(Uri parent, String name, String mime) throws IOException {
        Uri found = find(parent, name, mime);
        if (found != null) return found;
        // Concurrent devices may create the same date/article/job folder. Re-read the canonical name.
        try {
            Uri created = DocumentsContract.createDocument(resolver, parent, mime, name);
            if (created != null) {
                try (Cursor row = resolver.query(created, new String[]{Document.COLUMN_DISPLAY_NAME}, null, null, null)) {
                    if (row != null && row.moveToFirst() && name.equals(row.getString(0))) return created;
                }
            }
        } catch (FileNotFoundException raced) {
            found = find(parent, name, mime);
            if (found != null) return found;
            throw raced;
        }
        found = find(parent, name, mime);
        if (found == null) throw new IOException("Ziel konnte nicht unter dem vorgesehenen Namen erstellt werden.");
        return found;
    }

    private Uri find(Uri parent, String name, String mime) throws IOException {
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, DocumentsContract.getDocumentId(parent));
        try (Cursor rows = resolver.query(children, new String[]{Document.COLUMN_DOCUMENT_ID,
                Document.COLUMN_DISPLAY_NAME, Document.COLUMN_MIME_TYPE}, null, null, null)) {
            if (rows == null || rows.getExtras().getBoolean(DocumentsContract.EXTRA_LOADING)
                    || rows.getExtras().getString(DocumentsContract.EXTRA_ERROR) != null)
                throw new IOException("Ordnerinhalt ist derzeit nicht verfügbar.");
            while (rows.moveToNext()) {
                if (!name.equals(rows.getString(1))) continue;
                if (Document.MIME_TYPE_DIR.equals(mime) != Document.MIME_TYPE_DIR.equals(rows.getString(2)))
                    throw new IOException("Name im Zielordner bereits anders belegt.");
                return DocumentsContract.buildDocumentUriUsingTree(tree, rows.getString(0));
            }
        }
        return null;
    }
}
