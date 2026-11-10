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
import java.util.UUID;

/** Versioned sync of real local entries. Conflicts retain both versions for explicit review. */
final class RobotOrderSync {
    private static final String[][] TEXT={
        {"orderNumber","order_number"},{"articleNumber","article_number"},{"programInfo","program_info"},
        {"missingParts","missing_parts"},{"shift","shift"},{"eventType","event_type"},{"note","note"},
        {"handoverNote","handover_note"},{"source","source"},{"personnelNumber","personnel_number"}};
    private static final String[][] NUMBER={{"robot","robot"},{"quantity","quantity"},{"timestamp","timestamp"},{"startedAt","started_at"},{"endedAt","ended_at"}};
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
    private static JSONArray pending(SQLiteDatabase db)throws JSONException{
        db.beginTransaction();try{
            try(Cursor rows=db.rawQuery("SELECT * FROM entries WHERE sync_dirty=1 AND sync_conflict='' AND id NOT IN(SELECT entry_id FROM order_sync_queue) ORDER BY id LIMIT 5",null)){
                while(rows.moveToNext()){
                    String mutation=UUID.randomUUID().toString();
                    JSONObject value=new JSONObject().put("id",string(rows,"sync_id")).put("baseRevision",number(rows,"sync_revision"))
                        .put("mutationId",mutation).put("deleted",number(rows,"sync_deleted")!=0).put("data",entryData(rows));
                    ContentValues queue=new ContentValues();queue.put("mutation_id",mutation);queue.put("entry_id",number(rows,"id"));
                    queue.put("local_revision",number(rows,"sync_local_revision"));queue.put("payload",value.toString());db.insertOrThrow("order_sync_queue",null,queue);
                }
            }
            JSONArray result=new JSONArray();try(Cursor rows=db.rawQuery("SELECT payload FROM order_sync_queue ORDER BY entry_id LIMIT 5",null)){while(rows.moveToNext())result.put(new JSONObject(rows.getString(0)));}
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
            db.update("entries",fields,"id=?",new String[]{String.valueOf(number(row,"id"))});
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
    static synchronized boolean run(Context context){
        SharedPreferences settings=prefs(context);if(!settings.getBoolean("enabled",false))return false;
        String pairing=NasSync.galleryRevision(context);if(pairing==null||!NasSync.galleryCurrent(context,pairing)){settings.edit().putString("status","Bitte zuerst den Fotospeicher mit crazybatto.de verbinden.").apply();return false;}
        try(DbHelper helper=new DbHelper(context)){
            SQLiteDatabase db=helper.getWritableDatabase();
            if(!pairing.equals(settings.getString("pairing","")))settings.edit().putString("pairing",pairing).putLong("cursor",0).commit();
            boolean more=false;
            for(int page=0;page<20;page++){
                if(Thread.currentThread().isInterrupted())return true;
                JSONArray changes=pending(db);long cursor=settings.getLong("cursor",0);
                JSONObject request=new JSONObject().put("protocol",1).put("cursor",cursor).put("changes",changes);
                JSONObject result=NasSync.galleryTarget(context,pairing).syncOrders(request);
                if(!NasSync.galleryCurrent(context,pairing)||!settings.getBoolean("enabled",false))return false;
                receive(db,result);long next=result.getLong("cursor");if(next<cursor)throw new IOException("Synchronisierungsstand ging zurück.");
                settings.edit().putLong("cursor",next).putLong("lastSuccess",System.currentTimeMillis()).commit();
                more=result.getBoolean("hasMore")||changes.length()>0;if(!more)break;
            }
            long unresolved;try(Cursor count=db.rawQuery("SELECT COUNT(*) FROM entries WHERE sync_conflict<>''",null)){count.moveToFirst();unresolved=count.getLong(0);}
            settings.edit().putString("status",unresolved>0?unresolved+" Konflikt(e) im Control Center prüfen. Beide Stände bleiben erhalten.":"Aufträge abgeglichen. Änderungen im Center erscheinen beim nächsten Abgleich.").apply();
            return more;
        }catch(Exception error){
            String message=error instanceof IOException?error.getMessage():"Auftragsabgleich nicht möglich. Die Daten bleiben auf dem Handy.";
            settings.edit().putString("status",message==null?"Auftragsabgleich unterbrochen.":message).apply();return true;
        }
    }
    static void showSettings(Activity activity){
        SharedPreferences settings=prefs(activity);boolean enabled=settings.getBoolean("enabled",false);
        String message="Überträgt deine Schichtlog-Einträge mit Auftragsnummer, Personalnummer, Notizen und Mengen an deine private Verwaltung auf crazybatto.de. Änderungen und Papierkorb-Aktionen im Center werden zurück auf dieses Handy übernommen. Der laufende Maschinenauftrag bleibt lokal.\n\nZuerst Fotospeicher verbinden und im Control Center dieses Handy für Aufträge freigeben.\n\n"+settings.getString("status","Noch nicht verbunden.");
        AlertDialog dialog=new AlertDialog.Builder(activity).setTitle("Control Center · Aufträge").setMessage(message)
            .setPositiveButton(enabled?"Jetzt abgleichen":"Synchronisierung einschalten",(d,w)->{
                settings.edit().putBoolean("enabled",true).apply();NasSync.schedule(activity);
                Toast.makeText(activity,"Abgleich wurde eingeplant. Status hier erneut öffnen.",Toast.LENGTH_LONG).show();
            }).setNegativeButton("Schließen",null)
            .setNeutralButton(enabled?"Synchronisierung ausschalten":"Website öffnen",(d,w)->{
                if(enabled)settings.edit().putBoolean("enabled",false).apply();
                else activity.startActivity(new android.content.Intent(android.content.Intent.ACTION_VIEW,android.net.Uri.parse("https://crazybatto.de/control-center/")));
            }).create();dialog.show();
    }
}
