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
    private static final int DB_VERSION = 6;

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
        migrateDraftState(db);
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
        if (oldVersion < 6) migrateDraftState(db);
    }

    private void migrateDraftState(SQLiteDatabase db) {
        String[][] columns = {
                {"signed_out", "INTEGER NOT NULL DEFAULT 0"},
                {"shift_started_at", "INTEGER NOT NULL DEFAULT 0"},
                {"shift_ended_at", "INTEGER NOT NULL DEFAULT 0"},
                {"session_shift", "TEXT NOT NULL DEFAULT ''"},
                {"snapshot_entry_id", "INTEGER NOT NULL DEFAULT 0"},
                {"draft_quantity", "INTEGER NOT NULL DEFAULT 0"},
                {"draft_event_type", "TEXT NOT NULL DEFAULT 'Kein Ereignis'"},
                {"draft_important", "INTEGER NOT NULL DEFAULT 0"},
                {"draft_note", "TEXT NOT NULL DEFAULT ''"},
                {"draft_handover_note", "TEXT NOT NULL DEFAULT ''"},
                {"draft_missing_parts", "TEXT NOT NULL DEFAULT ''"},
                {"draft_saved_at", "INTEGER NOT NULL DEFAULT 0"},
                {"snapshot_notice", "TEXT NOT NULL DEFAULT ''"}
        };
        for (String[] column : columns) {
            if (!hasColumn(db, "active_job", column[0])) {
                db.execSQL("ALTER TABLE active_job ADD COLUMN " + column[0] + " " + column[1]);
            }
        }
        db.execSQL("UPDATE active_job SET shift_started_at=started_at WHERE shift_started_at=0");
        db.execSQL("UPDATE active_job SET session_shift=start_shift WHERE session_shift=''");
        db.execSQL("CREATE TABLE IF NOT EXISTS article_history (" +
                "article_number TEXT PRIMARY KEY COLLATE NOCASE," +
                "last_used INTEGER NOT NULL DEFAULT 0)");
        db.execSQL("INSERT OR IGNORE INTO article_history(article_number,last_used) " +
                "SELECT TRIM(article_number),MAX(timestamp) FROM entries " +
                "WHERE TRIM(article_number)<>'' GROUP BY TRIM(article_number) COLLATE NOCASE");
        db.execSQL("INSERT OR IGNORE INTO article_history(article_number,last_used) " +
                "SELECT TRIM(article_number),started_at FROM active_job WHERE TRIM(article_number)<>''");
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
        ContentValues cv = recordValues(record);
        cv.put("sync_id", java.util.UUID.randomUUID().toString());
        long id = getWritableDatabase().insertOrThrow("entries", null, cv);
        rememberArticle(record.articleNumber, record.timestamp);
        return id;
    }

    private ContentValues recordValues(Record record) {
        ContentValues cv = new ContentValues();
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
        return cv;
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
        if (start.startedAt <= 0 || safe(start.orderNumber).trim().isEmpty()) {
            throw new IllegalArgumentException("Bitte Auftrag und Startzeit angeben.");
        }
        ContentValues cv = new ContentValues();
        cv.put("id", 1);
        cv.put("robot", start.robot);
        cv.put("order_number", start.orderNumber);
        cv.put("article_number", safe(start.articleNumber));
        cv.put("program_info", safe(start.programInfo));
        cv.put("started_at", start.startedAt);
        String shift = ShiftUtils.getShiftForSignIn(start.startedAt);
        cv.put("start_shift", shift);
        cv.put("personnel_number", safe(start.personnelNumber));
        cv.put("shift_started_at", start.startedAt);
        cv.put("session_shift", shift);
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            db.insertOrThrow("active_job", null, cv);
            Record event = sessionRecord(getActiveJob(), start, "Auftrag gestartet", start.startedAt, 0);
            event.quantity = 0;
            insertRecord(event);
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
            job.signedOut = c.getInt(c.getColumnIndexOrThrow("signed_out")) != 0;
            job.shiftStartedAt = c.getLong(c.getColumnIndexOrThrow("shift_started_at"));
            job.shiftEndedAt = c.getLong(c.getColumnIndexOrThrow("shift_ended_at"));
            job.sessionShift = c.getString(c.getColumnIndexOrThrow("session_shift"));
            job.snapshotEntryId = c.getLong(c.getColumnIndexOrThrow("snapshot_entry_id"));
            job.draftQuantity = c.getInt(c.getColumnIndexOrThrow("draft_quantity"));
            job.draftEventType = c.getString(c.getColumnIndexOrThrow("draft_event_type"));
            job.draftImportant = c.getInt(c.getColumnIndexOrThrow("draft_important")) != 0;
            job.draftNote = c.getString(c.getColumnIndexOrThrow("draft_note"));
            job.draftHandoverNote = c.getString(c.getColumnIndexOrThrow("draft_handover_note"));
            job.draftMissingParts = c.getString(c.getColumnIndexOrThrow("draft_missing_parts"));
            job.draftSavedAt = c.getLong(c.getColumnIndexOrThrow("draft_saved_at"));
            job.snapshotNotice = c.getString(c.getColumnIndexOrThrow("snapshot_notice"));
            return job;
        }
    }

    enum JobAction { PAUSE, RESUME, HANDOVER, FINISH }

    public void saveJobDraft(ActiveJob expected, Record draft) {
        saveSession(expected, draft, "Zwischenstand", 0, false);
    }

    /** Ends the person's shift at the entered time; the machine order remains open. */
    public void endShift(ActiveJob expected, Record draft, long endedAt) {
        saveSession(expected, draft, "Schicht beendet", endedAt, true);
    }

    private void saveSession(ActiveJob expected, Record draft, String source, long endedAt, boolean signOut) {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            ActiveJob current = requireCurrentJob(expected);
            requireSignedIn(current);
            if (signOut) validateShiftEnd(current, endedAt);
            long savedAt = signOut ? endedAt : System.currentTimeMillis();
            Record snapshot = sessionRecord(current, draft, source, savedAt, endedAt);
            long id = saveSnapshot(db, current.snapshotEntryId, snapshot);
            ContentValues update = draftValues(snapshot, savedAt, id);
            if (id != current.snapshotEntryId) update.put("snapshot_notice", "");
            update.put("revision", current.revision + 1);
            if (signOut) {
                update.put("signed_out", 1);
                update.put("shift_ended_at", endedAt);
            }
            updateCurrentJob(db, current, update);
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    /** Starts a new shift for the same order; previous shift totals are kept separately. */
    public void resumeShift(ActiveJob expected, String personnelNumber, long signedInAt) {
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            ActiveJob current = requireCurrentJob(expected);
            if (!current.signedOut) throw new IllegalStateException("Diese Schicht ist bereits angemeldet.");
            if (safe(personnelNumber).trim().isEmpty()) {
                throw new IllegalArgumentException("Bitte deine Personalnummer angeben.");
            }
            if (signedInAt < current.shiftEndedAt || signedInAt > System.currentTimeMillis()) {
                throw new IllegalArgumentException("Die Anmeldung muss nach dem letzten Schichtende liegen und darf nicht in der Zukunft liegen.");
            }
            String shift = ShiftUtils.getShiftForSignIn(signedInAt);
            ContentValues update = new ContentValues();
            update.put("revision", current.revision + 1);
            update.put("signed_out", 0);
            update.put("shift_started_at", signedInAt);
            update.put("shift_ended_at", 0);
            update.put("session_shift", shift);
            update.put("personnel_number", personnelNumber.trim());
            update.put("snapshot_entry_id", 0);
            update.put("draft_quantity", 0);
            update.put("draft_event_type", "Kein Ereignis");
            update.put("draft_important", 0);
            update.put("draft_saved_at", 0);
            update.put("snapshot_notice", "");
            updateCurrentJob(db, current, update);
            Record event = sessionRecord(getActiveJob(), new Record(), "Schicht angemeldet", signedInAt, 0);
            event.eventType = "Schicht angemeldet";
            insertRecord(event);
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    public void recordJobAction(ActiveJob job, JobAction action, Record event) {
        if (action == JobAction.HANDOVER) {
            saveSession(job, event, "Schichtübergabe", 0, false);
            return;
        }
        SQLiteDatabase db = getWritableDatabase();
        db.beginTransaction();
        try {
            ActiveJob current = requireCurrentJob(job);
            requireSignedIn(current);
            if ((action == JobAction.PAUSE && current.paused) || (action == JobAction.RESUME && !current.paused)) {
                throw new IllegalStateException("Dieser Vorgang passt nicht zum aktuellen Auftragsstatus.");
            }
            if (action == JobAction.FINISH) {
                long endedAt = event.endedAt > 0 ? event.endedAt : System.currentTimeMillis();
                validateShiftEnd(current, endedAt);
                Record snapshot = sessionRecord(current, event, "Auftrag beendet", endedAt, endedAt);
                saveSnapshot(db, current.snapshotEntryId, snapshot);
                db.delete("active_job", "id=1", null);
            } else {
                ContentValues update = new ContentValues();
                update.put("revision", current.revision + 1);
                if (action == JobAction.PAUSE) update.put("paused", 1);
                if (action == JobAction.RESUME) update.put("paused", 0);
                updateCurrentJob(db, current, update);
                Record actionRecord = sessionRecord(current, event,
                        action == JobAction.PAUSE ? "Auftrag pausiert" : "Auftrag fortgesetzt",
                        System.currentTimeMillis(), 0);
                actionRecord.quantity = 0;
                insertRecord(actionRecord);
            }
            db.setTransactionSuccessful();
        } finally {
            db.endTransaction();
        }
    }

    private ActiveJob requireCurrentJob(ActiveJob expected) {
        ActiveJob current = getActiveJob();
        if (expected == null || current == null || current.startedAt != expected.startedAt || current.revision != expected.revision) {
            throw new IllegalStateException("Der Auftrag wurde inzwischen geändert. Bitte den Auftrag erneut öffnen.");
        }
        return current;
    }

    private void requireSignedIn(ActiveJob job) {
        if (job.signedOut) throw new IllegalStateException("Bitte zuerst für die nächste Schicht anmelden.");
    }

    private void validateShiftEnd(ActiveJob job, long endedAt) {
        if (endedAt < job.shiftStartedAt || endedAt > System.currentTimeMillis()) {
            throw new IllegalArgumentException("Das Schichtende muss nach der Anmeldung liegen und darf nicht in der Zukunft liegen.");
        }
    }

    private void updateCurrentJob(SQLiteDatabase db, ActiveJob job, ContentValues update) {
        int changed = db.update("active_job", update, "id=1 AND started_at=? AND revision=?",
                new String[]{String.valueOf(job.startedAt), String.valueOf(job.revision)});
        if (changed != 1) throw new IllegalStateException("Der Auftrag wurde inzwischen geändert. Bitte den Auftrag erneut öffnen.");
    }

    private Record sessionRecord(ActiveJob job, Record values, String source, long timestamp, long endedAt) {
        if (values == null || values.quantity < 0) throw new IllegalArgumentException("Bitte eine gültige Menge ab 0 eingeben.");
        Record record = new Record();
        record.robot = job.robot;
        record.orderNumber = job.orderNumber;
        record.articleNumber = job.articleNumber;
        record.programInfo = job.programInfo;
        record.startedAt = job.startedAt;
        record.endedAt = endedAt;
        record.timestamp = timestamp;
        record.shift = job.sessionShift;
        record.personnelNumber = job.personnelNumber;
        record.source = source;
        record.quantity = values.quantity;
        record.eventType = values.eventType == null ? "Kein Ereignis" : values.eventType;
        record.important = values.important;
        record.note = safe(values.note);
        record.handoverNote = safe(values.handoverNote);
        record.missingParts = safe(values.missingParts);
        return record;
    }

    private ContentValues draftValues(Record draft, long savedAt, long entryId) {
        ContentValues values = new ContentValues();
        values.put("draft_quantity", draft.quantity);
        values.put("draft_event_type", draft.eventType);
        values.put("draft_important", draft.important ? 1 : 0);
        values.put("draft_note", safe(draft.note));
        values.put("draft_handover_note", safe(draft.handoverNote));
        values.put("draft_missing_parts", safe(draft.missingParts));
        values.put("draft_saved_at", savedAt);
        values.put("snapshot_entry_id", entryId);
        return values;
    }

    private long saveSnapshot(SQLiteDatabase db, long entryId, Record record) {
        ContentValues values = recordValues(record);
        values.put("sync_dirty", 1);
        // Center corrections to historical identity/assignment must not be silently undone by
        // the still-running machine order. Its identity stays local; this existing row keeps its own.
        if (entryId > 0) {
            try (Cursor row = db.rawQuery("SELECT * FROM entries WHERE id=? AND sync_deleted=0", new String[]{String.valueOf(entryId)})) {
                if (row.moveToFirst()) {
                    for (String field : new String[]{"order_number", "article_number", "program_info", "personnel_number", "shift"}) {
                        values.put(field, row.getString(row.getColumnIndexOrThrow(field)));
                    }
                    values.put("robot", row.getInt(row.getColumnIndexOrThrow("robot")));
                    values.put("started_at", row.getLong(row.getColumnIndexOrThrow("started_at")));
                }
            }
        }
        if (entryId > 0 && db.update("entries", values, "id=? AND sync_deleted=0",
                new String[]{String.valueOf(entryId)}) == 1) {
            // Keep sync_id, remote revision, attachments and an already queued mutation intact.
            // Its acknowledgement will then leave this newer local revision dirty for the next upload.
            db.execSQL("UPDATE entries SET sync_local_revision=sync_local_revision+1 WHERE id=?", new Object[]{entryId});
            rememberArticle(record.articleNumber, record.timestamp);
            return entryId;
        }
        return insertRecord(record);
    }

    /** Called only after the sync layer has actually accepted a server version of this row. */
    static void refreshActiveDraftFromSnapshot(SQLiteDatabase db, long entryId) {
        try (Cursor row = db.rawQuery("SELECT e.*,a.draft_quantity,a.draft_event_type,a.draft_important," +
                "a.draft_note,a.draft_handover_note,a.draft_missing_parts,a.snapshot_notice," +
                "a.robot AS active_robot,a.order_number AS active_order,a.article_number AS active_article," +
                "a.program_info AS active_program,a.started_at AS active_started,a.personnel_number AS active_personnel," +
                "a.session_shift AS active_shift FROM entries e JOIN active_job a ON a.snapshot_entry_id=e.id WHERE e.id=?",
                new String[]{String.valueOf(entryId)})) {
            if (!row.moveToFirst()) return;
            ContentValues update = new ContentValues();
            boolean changed = false;
            String[][] draftColumns = {{"quantity", "draft_quantity"}, {"event_type", "draft_event_type"},
                    {"important", "draft_important"}, {"note", "draft_note"},
                    {"handover_note", "draft_handover_note"}, {"missing_parts", "draft_missing_parts"}};
            for (String[] pair : draftColumns) {
                String value = row.getString(row.getColumnIndexOrThrow(pair[0]));
                if (!value.equals(row.getString(row.getColumnIndexOrThrow(pair[1])))) changed = true;
                update.put(pair[1], value);
            }
            String notice = "";
            if (row.getInt(row.getColumnIndexOrThrow("sync_deleted")) != 0) {
                notice = "Der gespeicherte Schichtstand wurde im Control Center in den Papierkorb verschoben. " +
                        "Der Maschinenauftrag bleibt offen. Beim nächsten Speichern entsteht ein neuer Zwischenstand.";
            } else {
                String[][] identityColumns = {{"robot", "active_robot"}, {"order_number", "active_order"},
                        {"article_number", "active_article"}, {"program_info", "active_program"},
                        {"started_at", "active_started"}, {"personnel_number", "active_personnel"}, {"shift", "active_shift"}};
                for (String[] pair : identityColumns) {
                    if (!row.getString(row.getColumnIndexOrThrow(pair[0])).equals(row.getString(row.getColumnIndexOrThrow(pair[1])))) {
                        notice = "Die Auftrags- oder Schichtzuordnung dieses Zwischenstands wurde im Control Center korrigiert. " +
                                "Der laufende Maschinenauftrag bleibt unverändert. Die Korrektur im Verlauf bleibt beim Speichern erhalten.";
                        break;
                    }
                }
            }
            if (!notice.equals(row.getString(row.getColumnIndexOrThrow("snapshot_notice")))) changed = true;
            if (!changed) return; // A normal upload acknowledgement must not invalidate the open form.
            update.put("snapshot_notice", notice);
            update.put("draft_saved_at", row.getLong(row.getColumnIndexOrThrow("timestamp")));
            db.update("active_job", update, "id=1 AND snapshot_entry_id=?", new String[]{String.valueOf(entryId)});
            db.execSQL("UPDATE active_job SET revision=revision+1 WHERE id=1 AND snapshot_entry_id=?", new Object[]{entryId});
        }
    }

    private void rememberArticle(String number, long timestamp) {
        String article = safe(number).trim();
        if (article.isEmpty()) return;
        SQLiteDatabase db = getWritableDatabase();
        ContentValues values = new ContentValues();
        values.put("article_number", article);
        values.put("last_used", timestamp);
        db.insertWithOnConflict("article_history", null, values, SQLiteDatabase.CONFLICT_IGNORE);
        db.execSQL("UPDATE article_history SET last_used=MAX(last_used,?) WHERE article_number=? COLLATE NOCASE",
                new Object[]{timestamp, article});
    }

    public List<String> getArticleNumbers(String prefix) {
        List<String> articles = new ArrayList<>();
        // Include received server entries as well as local history and the open order.
        String sql = "SELECT article_number,MAX(last_used) AS used FROM (" +
                "SELECT article_number,last_used FROM article_history UNION ALL " +
                "SELECT TRIM(article_number),timestamp FROM entries WHERE sync_deleted=0 UNION ALL " +
                "SELECT TRIM(article_number),started_at FROM active_job) " +
                "WHERE article_number<>'' AND instr(upper(article_number),upper(?))=1 " +
                "GROUP BY article_number COLLATE NOCASE " +
                "ORDER BY CASE WHEN upper(article_number) LIKE 'HE%' THEN 0 ELSE 1 END,used DESC,article_number COLLATE NOCASE";
        try (Cursor cursor = getReadableDatabase().rawQuery(sql, new String[]{safe(prefix).trim()})) {
            while (cursor.moveToNext()) articles.add(cursor.getString(0));
        }
        return articles;
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
