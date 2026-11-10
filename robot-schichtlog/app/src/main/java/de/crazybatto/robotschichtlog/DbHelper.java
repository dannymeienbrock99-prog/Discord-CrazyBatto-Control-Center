package de.crazybatto.robotschichtlog;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import java.util.ArrayList;
import java.util.List;

public class DbHelper extends SQLiteOpenHelper {
    private static final String DB_NAME = "robot_schichtlog.db";
    private static final int DB_VERSION = 5;

    public DbHelper(Context context) {
        super(context, DB_NAME, null, DB_VERSION);
    }

    @Override
    public void onConfigure(SQLiteDatabase db) {
        super.onConfigure(db);
        db.setForeignKeyConstraintsEnabled(true);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE entries (" +
                "id INTEGER PRIMARY KEY AUTOINCREMENT," +
                "robot INTEGER NOT NULL," +
                "order_number TEXT NOT NULL," +
                "article_number TEXT NOT NULL DEFAULT ''," +
                "program_info TEXT NOT NULL DEFAULT ''," +
                "missing_parts TEXT NOT NULL DEFAULT ''," +
                "quantity INTEGER NOT NULL DEFAULT 0," +
                "timestamp INTEGER NOT NULL," +
                "shift TEXT NOT NULL," +
                "event_type TEXT NOT NULL DEFAULT 'Kein Ereignis'," +
                "important INTEGER NOT NULL DEFAULT 0," +
                "note TEXT NOT NULL DEFAULT ''," +
                "handover_note TEXT NOT NULL DEFAULT ''," +
                "started_at INTEGER NOT NULL DEFAULT 0," +
                "ended_at INTEGER NOT NULL DEFAULT 0," +
                "source TEXT NOT NULL DEFAULT 'Eintrag'," +
                "personnel_number TEXT NOT NULL DEFAULT ''" +
                ")");

        db.execSQL("CREATE TABLE attachments (" +
                "id INTEGER PRIMARY KEY AUTOINCREMENT," +
                "entry_id INTEGER NOT NULL," +
                "uri TEXT NOT NULL," +
                "mime_type TEXT NOT NULL DEFAULT 'application/octet-stream'," +
                "display_name TEXT NOT NULL DEFAULT 'Anhang'," +
                "added_at INTEGER NOT NULL DEFAULT 0," +
                "FOREIGN KEY(entry_id) REFERENCES entries(id) ON DELETE CASCADE" +
                ")");

        createActiveJobTable(db);
        createIndexes(db);
        RobotOrderSync.migrate(db);
    }

    private void createActiveJobTable(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE IF NOT EXISTS active_job (" +
                "id INTEGER PRIMARY KEY CHECK(id=1)," +
                "robot INTEGER NOT NULL," +
                "order_number TEXT NOT NULL," +
                "article_number TEXT NOT NULL DEFAULT ''," +
                "program_info TEXT NOT NULL DEFAULT ''," +
                "started_at INTEGER NOT NULL," +
                "start_shift TEXT NOT NULL," +
                "personnel_number TEXT NOT NULL DEFAULT ''," +
                "paused INTEGER NOT NULL DEFAULT 0," +
                "revision INTEGER NOT NULL DEFAULT 0" +
                ")");
    }

    private void createIndexes(SQLiteDatabase db) {
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_entries_timestamp ON entries(timestamp DESC)");
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_entries_robot ON entries(robot)");
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_entries_order ON entries(order_number)");
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_entries_article ON entries(article_number)");
        db.execSQL("CREATE INDEX IF NOT EXISTS idx_attachments_entry ON attachments(entry_id)");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        if (oldVersion < 2) {
            db.execSQL("ALTER TABLE entries ADD COLUMN handover_note TEXT NOT NULL DEFAULT ''");
            db.execSQL("ALTER TABLE entries ADD COLUMN started_at INTEGER NOT NULL DEFAULT 0");
            db.execSQL("ALTER TABLE entries ADD COLUMN ended_at INTEGER NOT NULL DEFAULT 0");
            db.execSQL("ALTER TABLE entries ADD COLUMN source TEXT NOT NULL DEFAULT 'Eintrag'");
            createActiveJobTable(db);
        }
        if (oldVersion < 3) {
            db.execSQL("ALTER TABLE entries ADD COLUMN article_number TEXT NOT NULL DEFAULT ''");
            db.execSQL("ALTER TABLE entries ADD COLUMN program_info TEXT NOT NULL DEFAULT ''");
            db.execSQL("ALTER TABLE entries ADD COLUMN missing_parts TEXT NOT NULL DEFAULT ''");
            createActiveJobTable(db);
            if (!hasColumn(db, "active_job", "article_number")) {
                db.execSQL("ALTER TABLE active_job ADD COLUMN article_number TEXT NOT NULL DEFAULT ''");
            }
            if (!hasColumn(db, "active_job", "program_info")) {
                db.execSQL("ALTER TABLE active_job ADD COLUMN program_info TEXT NOT NULL DEFAULT ''");
            }
        }
        if (oldVersion < 4) {
            db.execSQL("ALTER TABLE entries ADD COLUMN personnel_number TEXT NOT NULL DEFAULT ''");
            db.execSQL("ALTER TABLE attachments ADD COLUMN added_at INTEGER NOT NULL DEFAULT 0");
            // A direct upgrade from v1 may have created the latest active_job table above.
            if (!hasColumn(db, "active_job", "personnel_number")) {
                db.execSQL("ALTER TABLE active_job ADD COLUMN personnel_number TEXT NOT NULL DEFAULT ''");
                db.execSQL("ALTER TABLE active_job ADD COLUMN paused INTEGER NOT NULL DEFAULT 0");
                db.execSQL("ALTER TABLE active_job ADD COLUMN revision INTEGER NOT NULL DEFAULT 0");
            }
        }
        createIndexes(db);
        if (oldVersion < 5) RobotOrderSync.migrate(db);
    }

    private boolean hasColumn(SQLiteDatabase db, String table, String column) {
        try (Cursor c = db.rawQuery("PRAGMA table_info(" + table + ")", null)) {
            int nameIndex = c.getColumnIndex("name");
            while (c.moveToNext()) {
                if (column.equals(c.getString(nameIndex))) return true;
            }
        }
        return false;
    }

    public long insertRecord(Record record) {
        ContentValues cv = new ContentValues();
        cv.put("sync_id", java.util.UUID.randomUUID().toString());
        cv.put("robot", record.robot);
        cv.put("order_number", record.orderNumber);
        cv.put("article_number", safe(record.articleNumber));
        cv.put("program_info", safe(record.programInfo));
        cv.put("missing_parts", safe(record.missingParts));
        cv.put("quantity", record.quantity);
        cv.put("timestamp", record.timestamp);
        cv.put("shift", record.shift);
        cv.put("event_type", record.eventType == null ? "Kein Ereignis" : record.eventType);
        cv.put("important", record.important ? 1 : 0);
        cv.put("note", safe(record.note));
        cv.put("handover_note", safe(record.handoverNote));
        cv.put("started_at", record.startedAt);
        cv.put("ended_at", record.endedAt);
        cv.put("source", record.source == null ? "Eintrag" : record.source);
        cv.put("personnel_number", safe(record.personnelNumber));
        return getWritableDatabase().insertOrThrow("entries", null, cv);
    }

    public long insertRecordWithAttachments(Record record, List<Attachment> attachments) {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            long id = insertRecord(record);
            for (Attachment a : attachments) {
                insertAttachment(id, a.uri, a.mimeType, a.displayName);
            }
            db.setTransactionSuccessful();
            return id;
        } finally {
            db.endTransaction();
        }
    }

    public void startJob(Record start) {
        ContentValues cv = new ContentValues();
        cv.put("id", 1);
        cv.put("robot", start.robot);
        cv.put("order_number", start.orderNumber);
        cv.put("article_number", safe(start.articleNumber));
        cv.put("program_info", safe(start.programInfo));
        cv.put("started_at", start.startedAt);
        cv.put("start_shift", start.shift);
        cv.put("personnel_number", start.personnelNumber);
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            db.insertOrThrow("active_job", null, cv);
            insertRecord(start);
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    public ActiveJob getActiveJob() {
        try (Cursor c = getReadableDatabase().query(
                "active_job", null, "id=1", null, null, null, null)) {
            if (!c.moveToFirst()) return null;
            ActiveJob job = new ActiveJob();
            job.robot = c.getInt(c.getColumnIndexOrThrow("robot"));
            job.orderNumber = c.getString(c.getColumnIndexOrThrow("order_number"));
            job.articleNumber = c.getString(c.getColumnIndexOrThrow("article_number"));
            job.programInfo = c.getString(c.getColumnIndexOrThrow("program_info"));
            job.startedAt = c.getLong(c.getColumnIndexOrThrow("started_at"));
            job.startShift = c.getString(c.getColumnIndexOrThrow("start_shift"));
            job.personnelNumber = c.getString(c.getColumnIndexOrThrow("personnel_number"));
            job.paused = c.getInt(c.getColumnIndexOrThrow("paused")) != 0;
            job.revision = c.getInt(c.getColumnIndexOrThrow("revision"));
            return job;
        }
    }

    enum JobAction { PAUSE, RESUME, HANDOVER, FINISH }

    public void recordJobAction(ActiveJob job, JobAction action, Record event) {
        if ((action == JobAction.PAUSE && job.paused) || (action == JobAction.RESUME && !job.paused)) {
            throw new IllegalStateException("Dieser Vorgang passt nicht zum aktuellen Auftragsstatus.");
        }
        SQLiteDatabase db = getWritableDatabase();
        String where = "id=1 AND started_at=? AND revision=?";
        String[] args = {String.valueOf(job.startedAt), String.valueOf(job.revision)};
        db.beginTransaction();
        try {
            int changed;
            if (action == JobAction.FINISH) {
                changed = db.delete("active_job", where, args);
            } else {
                ContentValues update = new ContentValues();
                update.put("revision", job.revision + 1);
                if (action == JobAction.PAUSE) update.put("paused", 1);
                if (action == JobAction.RESUME) {
                    update.put("paused", 0);
                    update.put("personnel_number", event.personnelNumber);
                }
                changed = db.update("active_job", update, where, args);
            }
            if (changed != 1) throw new IllegalStateException("Der Auftrag wurde inzwischen geändert. Bitte den Auftrag erneut öffnen.");
            insertRecord(event);
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    public void insertAttachment(long entryId, String uri, String mimeType, String displayName) {
        ContentValues cv = new ContentValues();
        cv.put("entry_id", entryId);
        cv.put("uri", uri);
        cv.put("mime_type", mimeType == null ? "application/octet-stream" : mimeType);
        cv.put("display_name", displayName == null ? "Anhang" : displayName);
        cv.put("added_at", System.currentTimeMillis());
        getWritableDatabase().insertOrThrow("attachments", null, cv);
    }

    public List<Record> getRecords(Integer robotFilter, String shiftFilter, String search) {
        return getRecords(robotFilter, shiftFilter, search, null, null);
    }

    public List<Record> getRecords(Integer robotFilter, String shiftFilter, String search,
                                   Long dateStartInclusive, Long dateEndExclusive) {
        List<Record> result = new ArrayList<>();
        StringBuilder where = new StringBuilder("e.sync_deleted=0");
        List<String> args = new ArrayList<>();

        if (robotFilter != null) {
            where.append(" AND e.robot=?");
            args.add(String.valueOf(robotFilter));
        }
        if (shiftFilter != null && !shiftFilter.isEmpty()) {
            where.append(" AND e.shift=?");
            args.add(shiftFilter);
        }
        if (dateStartInclusive != null && dateEndExclusive != null) {
            where.append(" AND e.timestamp>=? AND e.timestamp<?");
            args.add(String.valueOf(dateStartInclusive));
            args.add(String.valueOf(dateEndExclusive));
        }
        if (search != null && !search.trim().isEmpty()) {
            where.append(" AND (e.order_number LIKE ? OR e.article_number LIKE ? OR e.program_info LIKE ? " +
                    "OR e.missing_parts LIKE ? OR e.note LIKE ? OR e.handover_note LIKE ? OR e.event_type LIKE ? OR e.source LIKE ? OR e.personnel_number LIKE ?)");
            String s = "%" + search.trim() + "%";
            for (int i = 0; i < 9; i++) args.add(s);
        }

        String sql = "SELECT e.*, " +
                "(SELECT COUNT(*) FROM attachments a WHERE a.entry_id=e.id) AS attachment_count " +
                "FROM entries e WHERE " + where + " ORDER BY e.timestamp DESC";

        try (Cursor c = getReadableDatabase().rawQuery(sql, args.toArray(new String[0]))) {
            while (c.moveToNext()) result.add(fromCursor(c));
        }
        return result;
    }

    public List<Attachment> getAttachments(long entryId) {
        List<Attachment> result = new ArrayList<>();
        try (Cursor c = getReadableDatabase().query(
                "attachments", null, "entry_id=?", new String[]{String.valueOf(entryId)},
                null, null, "id ASC")) {
            while (c.moveToNext()) {
                Attachment a = new Attachment();
                a.id = c.getLong(c.getColumnIndexOrThrow("id"));
                a.entryId = c.getLong(c.getColumnIndexOrThrow("entry_id"));
                a.uri = c.getString(c.getColumnIndexOrThrow("uri"));
                a.mimeType = c.getString(c.getColumnIndexOrThrow("mime_type"));
                a.displayName = c.getString(c.getColumnIndexOrThrow("display_name"));
                a.addedAt = c.getLong(c.getColumnIndexOrThrow("added_at"));
                result.add(a);
            }
        }
        return result;
    }

    public void deleteRecord(long id) {
        getWritableDatabase().execSQL("UPDATE entries SET sync_deleted=1,sync_dirty=1,sync_local_revision=sync_local_revision+1 WHERE id=?", new Object[]{id});
    }

    public Stats getStats(long startInclusive, long endExclusive) {
        Stats stats = new Stats();
        String[] args = {String.valueOf(startInclusive), String.valueOf(endExclusive)};

        String sql = "SELECT COUNT(*) AS cnt, COALESCE(SUM(quantity),0) AS qty, " +
                "COALESCE(SUM(important),0) AS important FROM entries " +
                "WHERE sync_deleted=0 AND timestamp>=? AND timestamp<?";
        try (Cursor c = getReadableDatabase().rawQuery(sql, args)) {
            if (c.moveToFirst()) {
                stats.count = c.getInt(c.getColumnIndexOrThrow("cnt"));
                stats.totalQuantity = c.getInt(c.getColumnIndexOrThrow("qty"));
                stats.importantCount = c.getInt(c.getColumnIndexOrThrow("important"));
            }
        }

        try (Cursor c = getReadableDatabase().rawQuery(
                "SELECT shift, COALESCE(SUM(quantity),0) AS qty FROM entries " +
                        "WHERE sync_deleted=0 AND timestamp>=? AND timestamp<? GROUP BY shift ORDER BY shift", args)) {
            while (c.moveToNext()) stats.byShift.put(c.getString(0), c.getInt(1));
        }

        try (Cursor c = getReadableDatabase().rawQuery(
                "SELECT robot, COALESCE(SUM(quantity),0) AS qty FROM entries " +
                        "WHERE sync_deleted=0 AND timestamp>=? AND timestamp<? GROUP BY robot ORDER BY robot", args)) {
            while (c.moveToNext()) stats.byRobot.put(c.getInt(0), c.getInt(1));
        }
        return stats;
    }

    private Record fromCursor(Cursor c) {
        Record r = new Record();
        r.id = c.getLong(c.getColumnIndexOrThrow("id"));
        r.robot = c.getInt(c.getColumnIndexOrThrow("robot"));
        r.orderNumber = c.getString(c.getColumnIndexOrThrow("order_number"));
        r.articleNumber = c.getString(c.getColumnIndexOrThrow("article_number"));
        r.programInfo = c.getString(c.getColumnIndexOrThrow("program_info"));
        r.missingParts = c.getString(c.getColumnIndexOrThrow("missing_parts"));
        r.quantity = c.getInt(c.getColumnIndexOrThrow("quantity"));
        r.timestamp = c.getLong(c.getColumnIndexOrThrow("timestamp"));
        r.shift = c.getString(c.getColumnIndexOrThrow("shift"));
        r.eventType = c.getString(c.getColumnIndexOrThrow("event_type"));
        r.important = c.getInt(c.getColumnIndexOrThrow("important")) == 1;
        r.note = c.getString(c.getColumnIndexOrThrow("note"));
        r.handoverNote = c.getString(c.getColumnIndexOrThrow("handover_note"));
        r.startedAt = c.getLong(c.getColumnIndexOrThrow("started_at"));
        r.endedAt = c.getLong(c.getColumnIndexOrThrow("ended_at"));
        r.source = c.getString(c.getColumnIndexOrThrow("source"));
        r.personnelNumber = c.getString(c.getColumnIndexOrThrow("personnel_number"));
        int index = c.getColumnIndex("attachment_count");
        r.attachmentCount = index >= 0 ? c.getInt(index) : 0;
        return r;
    }

    private String safe(String value) {
        return value == null ? "" : value;
    }
}
