package de.crazybatto.robotschichtlog;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ContentValues;
import android.content.Context;
import android.content.SharedPreferences;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.widget.Toast;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.text.DateFormat;
import java.util.Date;
import java.util.UUID;

/** Versioned sync of real local entries. Conflicts retain both versions for explicit review. */
final class RobotOrderSync {
    private static final String[][] TEXT={
        {"orderNumber","order_number"},{"articleNumber","article_number"},{"programInfo","program_info"},
        {"missingParts","missing_parts"},{"shift","shift"},{"eventType","event_type"},{"note","note"},
        {"handoverNote","handover_note"},{"source","source"},{"personnelNumber","personnel_number"}};
    private static final String[][] NUMBER={{"robot","robot"},{"quantity","quantity"},{"timestamp","timestamp"},{"startedAt","started_at"},{"endedAt","ended_at"}};
    private static final int[] TEXT_LIMITS={256,256,2000,4000,80,120,8000,8000,120,80};
    private static final String[] TEXT_LABELS={"Auftragsnummer","Artikelnummer","Programm","Fehlteile","Schicht","Ereignis","Notiz","Übergabe","Eintragsart","Personalnummer"};
    private static SharedPreferences prefs(Context context){return context.getSharedPreferences("control-order-sync",Context.MODE_PRIVATE);}
    private static String string(Cursor row,String column){return row.getString(row.getColumnIndexOrThrow(column));}
    private static long number(Cursor row,String column){return row.getLong(row.getColumnIndexOrThrow(column));}
    static void migrate(SQLiteDatabase db){
        db.execSQL("ALTER TABLE entries ADD COLUMN sync_id TEXT NOT NULL DEFAULT ''");
        db.execSQL("ALTER TABLE entries ADD COLUMN sync_revision INTEGER NOT NULL DEFAULT 0");
        db.execSQL("ALTER TABLE entries ADD COLUMN sync_local_revision INTEGER NOT NULL DEFAULT 1");
        db.execSQL("ALTER TABLE entries ADD COLUMN sync_deleted INTEGER NOT NULL DEFAULT 0");
        db.execSQL("ALTER TABLE entries ADD COLUMN sync_dirty INTEGER NOT NULL DEFAULT 1");
        db.execSQL("ALTER TABLE entries ADD COLUMN sync_conflict TEXT NOT NULL DEFAULT ''");
        db.execSQL("ALTER TABLE entries ADD COLUMN sync_mutation TEXT NOT NULL DEFAULT ''");
        try(Cursor rows=db.rawQuery("SELECT id FROM entries",null)){
            while(rows.moveToNext())db.execSQL("UPDATE entries SET sync_id=? WHERE id=?",new Object[]{UUID.randomUUID().toString(),rows.getLong(0)});
        }
        db.execSQL("CREATE UNIQUE INDEX idx_entries_sync_id ON entries(sync_id)");
        db.execSQL("CREATE TABLE order_sync_queue(mutation_id TEXT PRIMARY KEY,entry_id INTEGER UNIQUE NOT NULL,local_revision INTEGER NOT NULL,payload TEXT NOT NULL)");
    }
    private static JSONObject entryData(Cursor row)throws JSONException{
        JSONObject data=new JSONObject();for(String[] field:TEXT)data.put(field[0],string(row,field[1]));
        for(String[] field:NUMBER)data.put(field[0],number(row,field[1]));
        data.put("important",number(row,"important")!=0);return data;
    }
    private static void errorStore(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE IF NOT EXISTS order_sync_errors(entry_id INTEGER PRIMARY KEY,local_revision INTEGER NOT NULL,message TEXT NOT NULL)");
    }
    private static String invalid(JSONObject value)throws JSONException {
        JSONObject data=value.getJSONObject("data");
        for(int i=0;i<TEXT.length;i++){
            String text=data.getString(TEXT[i][0]);
            if(text.length()>TEXT_LIMITS[i]||text.matches("(?s).*[\\x00-\\x08\\x0B\\x0C\\x0E-\\x1F\\x7F].*"))return TEXT_LABELS[i]+" prüfen (höchstens "+TEXT_LIMITS[i]+" Zeichen)";
        }
        if(data.getString("orderNumber").trim().isEmpty())return "Auftragsnummer fehlt";
        if(data.getLong("robot")<1||data.getLong("robot")>999)return "Roboter muss zwischen 1 und 999 liegen";
        if(data.getLong("quantity")<0||data.getLong("quantity")>100000000)return "Menge prüfen";
        for(String key:new String[]{"timestamp","startedAt","endedAt"})
            if(data.getLong(key)<(key.equals("timestamp")?1:0)||data.getLong(key)>4102444800000L)return "Zeitangabe prüfen";
        if(data.getLong("startedAt")>0&&data.getLong("endedAt")>0&&data.getLong("endedAt")<data.getLong("startedAt"))return "Ende liegt vor Beginn";
        return null;
    }
    private static void block(SQLiteDatabase db,long id,long revision,String message){
        ContentValues problem=new ContentValues();problem.put("entry_id",id);problem.put("local_revision",revision);problem.put("message",message);
        db.insertWithOnConflict("order_sync_errors",null,problem,SQLiteDatabase.CONFLICT_REPLACE);
    }
    private static JSONArray pending(SQLiteDatabase db)throws JSONException{
        errorStore(db);
        db.beginTransaction();try{
            // Old queued payloads are immutable once sent. Locally invalid payloads have
            // never been accepted by the server and can be isolated without data loss.
            try(Cursor rows=db.rawQuery("SELECT * FROM order_sync_queue",null)){
                while(rows.moveToNext()){
                    String reason=invalid(new JSONObject(string(rows,"payload")));
                    if(reason!=null){block(db,number(rows,"entry_id"),number(rows,"local_revision"),reason);db.delete("order_sync_queue","entry_id=?",new String[]{String.valueOf(number(rows,"entry_id"))});}
                }
            }
            try(Cursor rows=db.rawQuery("SELECT * FROM entries e WHERE sync_dirty=1 AND sync_conflict='' AND id NOT IN(SELECT entry_id FROM order_sync_queue) AND NOT EXISTS(SELECT 1 FROM order_sync_errors x WHERE x.entry_id=e.id AND x.local_revision=e.sync_local_revision) ORDER BY id LIMIT 100",null)){
                int queued=0;
                while(rows.moveToNext()){
                    String mutation=UUID.randomUUID().toString();
                    JSONObject value=new JSONObject().put("id",string(rows,"sync_id")).put("baseRevision",number(rows,"sync_revision"))
                        .put("mutationId",mutation).put("deleted",number(rows,"sync_deleted")!=0).put("data",entryData(rows));
                    String reason=invalid(value);
                    if(reason!=null){block(db,number(rows,"id"),number(rows,"sync_local_revision"),reason);continue;}
                    ContentValues queue=new ContentValues();queue.put("mutation_id",mutation);queue.put("entry_id",number(rows,"id"));
                    queue.put("local_revision",number(rows,"sync_local_revision"));queue.put("payload",value.toString());db.insertOrThrow("order_sync_queue",null,queue);
                    db.delete("order_sync_errors","entry_id=?",new String[]{String.valueOf(number(rows,"id"))});
                    if(++queued==5)break;
                }
            }
            JSONArray result=new JSONArray();int bytes=0;
            try(Cursor rows=db.rawQuery("SELECT payload FROM order_sync_queue ORDER BY entry_id LIMIT 5",null)){
                while(rows.moveToNext()){
                    String payload=rows.getString(0);int size=payload.getBytes(StandardCharsets.UTF_8).length;
                    if(bytes+size>240*1024)break; // leave space for the envelope; retries keep the exact mutation
                    bytes+=size;result.put(new JSONObject(payload));
                }
            }
            db.setTransactionSuccessful();return result;
        }finally{db.endTransaction();}
    }
    private static ContentValues remoteFields(JSONObject order)throws JSONException,IOException{
        if(!order.getString("id").matches("[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}")||order.getLong("revision")<1)throw new IOException("Ungültiger Auftragsstand.");
        ContentValues values=new ContentValues();
        for(String[] field:TEXT){String value=order.getString(field[0]);if(value.length()>8000)throw new IOException("Auftragstext ist zu lang.");values.put(field[1],value);}
        for(String[] field:NUMBER){long value=order.getLong(field[0]);if(value<0||value>4102444800000L)throw new IOException("Ungültiger Auftragswert.");values.put(field[1],value);}
        values.put("important",order.getBoolean("important")?1:0);values.put("sync_deleted",order.getBoolean("deleted")?1:0);
        values.put("sync_revision",order.getLong("revision"));values.put("sync_dirty",0);values.put("sync_conflict","");values.put("sync_mutation","");return values;
    }
    private static boolean resolved(JSONObject order,String mutation)throws JSONException{
        JSONArray values=order.optJSONArray("resolvedMutations");if(values==null||mutation.isEmpty())return false;
        for(int i=0;i<values.length();i++)if(mutation.equals(values.getString(i)))return true;return false;
    }
    private static void remote(SQLiteDatabase db,JSONObject order,Long acknowledgedLocalRevision)throws JSONException,IOException{
        ContentValues fields=remoteFields(order);String id=order.getString("id");
        try(Cursor row=db.rawQuery("SELECT * FROM entries WHERE sync_id=?",new String[]{id})){
            if(!row.moveToFirst())return; // Server never invents a local job or active machine state.
            long revision=number(row,"sync_revision"),local=number(row,"sync_local_revision");
            if(order.getLong("revision")<revision)return;
            boolean conflictResolved=resolved(order,string(row,"sync_mutation"));
            boolean unchanged=acknowledgedLocalRevision!=null&&acknowledgedLocalRevision==local;
            if(number(row,"sync_dirty")!=0&&!unchanged&&!conflictResolved){
                if(acknowledgedLocalRevision!=null){ContentValues update=new ContentValues();update.put("sync_revision",order.getLong("revision"));db.update("entries",update,"id=?",new String[]{String.valueOf(number(row,"id"))});}
                return;
            }
            // A conflict resolution may concern an older mutation while a subsequent local deletion exists.
            if(conflictResolved&&!string(row,"sync_conflict").isEmpty()){
                JSONObject conflict=new JSONObject(string(row,"sync_conflict"));
                if(conflict.optLong("localRevision",local)!=local){
                    ContentValues update=new ContentValues();update.put("sync_revision",order.getLong("revision"));update.put("sync_conflict","");update.put("sync_mutation","");db.update("entries",update,"id=?",new String[]{String.valueOf(number(row,"id"))});return;
                }
            }
            long entryId=number(row,"id");
            db.update("entries",fields,"id=?",new String[]{String.valueOf(entryId)});
            DbHelper.refreshActiveDraftFromSnapshot(db,entryId);
        }
    }
    private static void receive(SQLiteDatabase db,JSONObject result)throws JSONException,IOException{
        if(result.getInt("protocol")!=1)throw new IOException("Unbekanntes Synchronisierungsformat.");
        JSONArray accepted=result.getJSONArray("accepted"),conflicts=result.getJSONArray("conflicts"),changes=result.getJSONArray("changes");
        if(accepted.length()>5||conflicts.length()>5||changes.length()>100||result.getLong("cursor")<0)throw new IOException("Ungültige Synchronisierungsantwort.");
        db.beginTransaction();try{
            for(int type=0;type<2;type++){
                JSONArray values=type==0?accepted:conflicts;
                for(int i=0;i<values.length();i++){
                    JSONObject value=values.getJSONObject(i);String mutation=value.getString("mutationId");
                    try(Cursor queue=db.rawQuery("SELECT * FROM order_sync_queue WHERE mutation_id=?",new String[]{mutation})){
                        if(!queue.moveToFirst())continue;
                        JSONObject sent=new JSONObject(string(queue,"payload"));
                        if(!sent.getString("id").equals(value.getString("id"))||!value.getString("id").equals(value.getJSONObject("order").getString("id")))throw new IOException("Auftragsantwort passt nicht zur Anfrage.");
                        if(type==0)remote(db,value.getJSONObject("order"),number(queue,"local_revision"));
                        else{
                            ContentValues update=new ContentValues();update.put("sync_conflict",new JSONObject().put("remote",value.getJSONObject("order")).put("localRevision",number(queue,"local_revision")).toString());update.put("sync_mutation",mutation);
                            db.update("entries",update,"id=?",new String[]{String.valueOf(number(queue,"entry_id"))});
                        }
                        db.delete("order_sync_queue","mutation_id=?",new String[]{mutation});
                    }
                }
            }
            for(int i=0;i<changes.length();i++)remote(db,changes.getJSONObject(i),null);
            db.setTransactionSuccessful();
        }finally{db.endTransaction();}
    }
    static boolean enabled(Context context){return prefs(context).getBoolean("enabled",false);}
    static void enable(Context context){prefs(context).edit().putBoolean("enabled",true).apply();}
    static final class Attempt {
        final boolean retry;
        final ServerUpload.Step step;
        Attempt(boolean ok,boolean more,long progress,String details,boolean retry){
            this.step=new ServerUpload.Step(ok,more,progress,details);this.retry=retry;
        }
    }
    private static Attempt failed(SharedPreferences settings,String message,boolean retry){
        settings.edit().putString("status",message).apply();
        return new Attempt(false,false,0,message,retry);
    }
    static synchronized boolean run(Context context){return runAttempt(context).retry;}
    static synchronized Attempt runAttempt(Context context){
        return runAttempt(context,null);
    }
    static synchronized Attempt runAttempt(Context context,String requiredPairing){
        SharedPreferences settings=prefs(context);
        if(!settings.getBoolean("enabled",false))return failed(settings,"Auftragsabgleich ist ausgeschaltet.",false);
        String pairing=NasSync.galleryRevision(context);
        if(pairing==null||!NasSync.galleryCurrent(context,pairing))return failed(settings,"Bitte zuerst den Fotospeicher mit crazybatto.de verbinden.",false);
        if(requiredPairing!=null&&!requiredPairing.equals(pairing))return failed(settings,"Serververbindung wurde geändert. Bitte den Upload erneut starten.",false);
        try(DbHelper helper=new DbHelper(context)){
            SQLiteDatabase db=helper.getWritableDatabase();
            if(!pairing.equals(settings.getString("pairing","")))settings.edit().putString("pairing",pairing).putLong("cursor",0).commit();
            boolean more=false;long progress=0;
            for(int page=0;page<20;page++){
                if(Thread.currentThread().isInterrupted())return failed(settings,"Auftragsabgleich unterbrochen. Daten bleiben gespeichert.",true);
                JSONArray changes=pending(db);long cursor=settings.getLong("cursor",0);
                JSONObject request=new JSONObject().put("protocol",1).put("cursor",cursor).put("changes",changes);
                JSONObject result=NasSync.galleryTarget(context,pairing).syncOrders(request);
                if(!NasSync.galleryCurrent(context,pairing)||!settings.getBoolean("enabled",false))return failed(settings,"Verbindung oder Auftragsfreigabe wurde während der Übertragung geändert.",false);
                receive(db,result);long next=result.getLong("cursor");if(next<cursor)throw new IOException("Synchronisierungsstand ging zurück.");
                settings.edit().putLong("cursor",next).putLong("lastSuccess",System.currentTimeMillis()).putString("lastSuccessPairing",pairing).commit();
                try(Cursor remaining=db.rawQuery("SELECT 1 FROM entries e WHERE sync_dirty=1 AND sync_conflict='' AND NOT EXISTS(SELECT 1 FROM order_sync_errors x WHERE x.entry_id=e.id AND x.local_revision=e.sync_local_revision) LIMIT 1",null)){
                    more=result.getBoolean("hasMore")||remaining.moveToFirst();
                }
                // A response without an acknowledgement must not spin or look like a completed upload.
                long acknowledged=0;
                for(int i=0;i<changes.length();i++){
                    try(Cursor queued=db.rawQuery("SELECT 1 FROM order_sync_queue WHERE mutation_id=?",new String[]{changes.getJSONObject(i).getString("mutationId")})){
                        if(!queued.moveToFirst())acknowledged++;
                    }
                }
                if(more&&next==cursor&&acknowledged==0)throw new IOException("Der Server hat keine weiteren Aufträge bestätigt. Erneuter Versuch folgt.");
                progress+=acknowledged+(next>cursor?1:0);
                if(!more)break;
            }
            long unresolved;try(Cursor count=db.rawQuery("SELECT COUNT(*) FROM entries WHERE sync_conflict<>''",null)){count.moveToFirst();unresolved=count.getLong(0);}
            long blocked;try(Cursor count=db.rawQuery("SELECT COUNT(*) FROM order_sync_errors x JOIN entries e ON e.id=x.entry_id AND e.sync_local_revision=x.local_revision WHERE e.sync_dirty=1",null)){count.moveToFirst();blocked=count.getLong(0);}
            String message=blocked>0?blocked+" Eintrag/Einträge benötigen eine Korrektur im Verlauf. Andere Aufträge werden übertragen."
                :unresolved>0?unresolved+" Konflikt(e) im Control Center prüfen. Beide Stände bleiben erhalten.":more?"Weitere Aufträge warten auf den nächsten Abgleich.":"Aufträge abgeglichen. Änderungen im Center erscheinen beim nächsten Abgleich.";
            settings.edit().putString("status",message).apply();
            return new Attempt(true,more,progress,message,more);
        }catch(WebsiteTarget.SiteError error){
            if(error.code==401||error.code==403){
                NasSync.galleryUnauthorized(context,pairing);
                return failed(settings,"Geräteverbindung abgelaufen oder widerrufen. Unter Fotospeicher erneut mit crazybatto.de verbinden.",false);
            }
            return failed(settings,"Serverantwort konnte nicht geprüft werden. Daten bleiben auf dem Handy; erneuter Versuch folgt.",true);
        }catch(WebsiteTarget.OrderError error){
            return failed(settings,error.getMessage(),error.retryable());
        }catch(Exception error){
            String message=error instanceof IOException?error.getMessage():"Auftragsabgleich nicht möglich. Die Daten bleiben auf dem Handy.";
            return failed(settings,message==null?"Auftragsabgleich unterbrochen.":message,true);
        }
    }
    static boolean hasBlocked(Context context){
        try(DbHelper helper=new DbHelper(context)){
            SQLiteDatabase db=helper.getWritableDatabase();errorStore(db);
            try(Cursor rows=db.rawQuery("SELECT 1 FROM entries e WHERE sync_conflict<>'' OR sync_dirty=1 OR EXISTS(SELECT 1 FROM order_sync_queue q WHERE q.entry_id=e.id) LIMIT 1",null)){
                return rows.moveToFirst();
            }
        }
    }
    static void showSettings(Activity activity){
        SharedPreferences settings=prefs(activity);boolean enabled=settings.getBoolean("enabled",false);
        String message=statusSummary(activity)+"\n\nÜberträgt Aufträge, gespeicherte Zwischenstände, Mengen und Notizen in deine private Verwaltung. Bilder werden separat übertragen. Änderungen und Papierkorb-Aktionen im Center werden zurück auf dieses Handy übernommen. Der laufende Maschinenauftrag bleibt lokal.\n\nEinrichtung: Fotospeicher → Geräte-Token auf crazybatto.de holen. Danach im Control Center → Robot SchichtLog → dieses Handy für Aufträge freigeben.";
        AlertDialog dialog=new AlertDialog.Builder(activity).setTitle("Control Center · Aufträge").setMessage(message)
            .setPositiveButton(enabled?"Jetzt abgleichen":"Synchronisierung einschalten",(d,w)->{
                settings.edit().putBoolean("enabled",true).apply();
                String pairing=NasSync.galleryRevision(activity);
                if(pairing==null||!NasSync.galleryCurrent(activity,pairing)){NasSync.showSettings(activity);return;}
                ServerUpload.start(activity,false);
                Toast.makeText(activity,"Serverupload läuft. Fortschritt über „Zum Server hochladen“ ansehen.",Toast.LENGTH_LONG).show();
            }).setNegativeButton("Schließen",null)
            .setNeutralButton(enabled?"Synchronisierung ausschalten":"Fotospeicher einrichten",(d,w)->{
                if(enabled)settings.edit().putBoolean("enabled",false).apply();
                else NasSync.showSettings(activity);
            }).create();dialog.show();
    }
    static String statusSummary(Context context){
        SharedPreferences settings=prefs(context);String pairing=NasSync.galleryRevision(context);
        String setup=pairing==null?"Fotospeicher zuerst mit crazybatto.de verbinden."
            :!NasSync.galleryCurrent(context,pairing)?"Geräteverbindung erneuern."
            :!settings.getBoolean("enabled",false)?"Auftragsabgleich ist ausgeschaltet."
            :settings.getString("status","Bereit. Jetzt abgleichen, um die Gerätefreigabe zu prüfen.");
        StringBuilder text=new StringBuilder(setup);
        try(DbHelper helper=new DbHelper(context)){
            SQLiteDatabase db=helper.getWritableDatabase();errorStore(db);
            try(Cursor row=db.rawQuery("SELECT SUM(CASE WHEN sync_dirty=1 THEN 1 ELSE 0 END),SUM(CASE WHEN sync_dirty=0 THEN 1 ELSE 0 END) FROM entries",null)){
                row.moveToFirst();text.append("\n").append(row.getLong(0)).append(" Einträge warten · ").append(row.getLong(1)).append(" abgeglichen");
            }
            try(Cursor row=db.rawQuery("SELECT e.id,x.message FROM order_sync_errors x JOIN entries e ON e.id=x.entry_id AND e.sync_local_revision=x.local_revision WHERE e.sync_dirty=1 ORDER BY e.id LIMIT 3",null)){
                while(row.moveToNext())text.append("\nEintrag #").append(row.getLong(0)).append(": ").append(row.getString(1));
            }
        }
        text.append("\n").append(NasSync.queueSummary(context));
        long last=settings.getLong("lastSuccess",0);
        if(last>0&&pairing!=null&&pairing.equals(settings.getString("lastSuccessPairing","")))text.append("\nLetzter erfolgreicher Abgleich: ").append(DateFormat.getDateTimeInstance(DateFormat.SHORT,DateFormat.SHORT).format(new Date(last)));
        else text.append("\nFür diese Verbindung noch kein erfolgreicher Auftragsabgleich.");
        text.append("\nIm Hintergrund nach Netzverbindung; Android kann Übertragungen bei Energiesparen verschieben.");
        return text.toString();
    }
}
