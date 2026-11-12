package de.crazybatto.robotschichtlog;

import android.content.Context;
import java.util.concurrent.Executor;

/** A user-requested transfer starts immediately on the same serial worker as scheduled uploads. */
final class ServerUpload {
    static final class Snapshot {
        final boolean busy, success, needsSetup, needsEnable;
        final String title, details;
        Snapshot(boolean busy, String title, String details, boolean success, boolean needsSetup, boolean needsEnable) {
            this.busy=busy; this.title=title; this.details=details;
            this.success=success; this.needsSetup=needsSetup; this.needsEnable=needsEnable;
        }
    }

    static final class Step {
        final boolean ok, more;
        final long progress;
        final String details;
        Step(boolean ok, boolean more, long progress, String details) {
            this.ok=ok; this.more=more; this.progress=progress; this.details=details;
        }
    }

    interface Backend {
        String pairing();
        boolean current(String pairing);
        boolean enabled();
        void enable();
        void recover() throws Exception;
        Step orders(String pairing);
        Step photos(String pairing);
        String summary();
        long remainingPhotos();
        boolean blocked();
        void schedule();
    }

    /** Package-visible dependencies also allow offline workflow tests without device credentials. */
    static final class Controller {
        private final Executor executor;
        private final Backend backend;
        private volatile Snapshot state=new Snapshot(false,"Zum Server hochladen",
                "Gespeicherte Aufträge und Bilder mit crazybatto.de abgleichen.",false,false,false);
        private String statePairing;
        Controller(Executor executor, Backend backend) { this.executor=executor; this.backend=backend; }

        synchronized Snapshot snapshot() {
            if(state.busy)return state;
            String pairing=backend.pairing();
            if(pairing==null||!backend.current(pairing))return setup();
            if(!backend.enabled())return disabled();
            if(statePairing!=null&&!statePairing.equals(pairing))return new Snapshot(false,"Neue Serververbindung",
                    "Jetzt hochladen, um die neue Verbindung zu prüfen.",false,false,false);
            if(state.needsSetup||state.needsEnable)return new Snapshot(false,"Bereit zum Hochladen",
                    "Gespeicherte Aufträge und Bilder jetzt mit crazybatto.de abgleichen.",false,false,false);
            return state;
        }

        synchronized boolean start(boolean enableOrders) {
            if(state.busy)return false;
            String pairing=backend.pairing();
            if(pairing==null||!backend.current(pairing)){state=setup();return false;}
            if(!backend.enabled()&&enableOrders)backend.enable();
            if(!backend.enabled()){state=disabled();return false;}
            statePairing=pairing;
            state=new Snapshot(true,"Upload startet …","Ein bereits laufender Abgleich wird zuerst beendet.",false,false,false);
            try { executor.execute(()->run(pairing)); }
            catch(RuntimeException unavailable) {
                state=new Snapshot(false,"Upload konnte nicht starten","Bitte erneut versuchen. Deine Daten bleiben auf dem Handy.",false,false,false);
                return false;
            }
            return true;
        }

        private Snapshot setup() {
            return new Snapshot(false,"Serververbindung einrichten",
                    "Fotospeicher mit crazybatto.de verbinden oder die Geräteverbindung erneuern. Ein NAS oder ein Handy-Ordner ist kein Upload zum Control Center.",false,true,false);
        }
        private Snapshot disabled() {
            return new Snapshot(false,"Auftragsabgleich ausgeschaltet",
                    "Zum Hochladen muss der Abgleich gespeicherter Aufträge eingeschaltet werden.",false,false,true);
        }
        private boolean valid(String pairing) {
            if(!backend.current(pairing)) {
                finish("Verbindung geändert oder abgelaufen","Upload angehalten. Bitte die Serververbindung prüfen und erneut starten.",false);
                return false;
            }
            if(!backend.enabled()) {
                finish("Auftragsabgleich ausgeschaltet","Upload angehalten. Bereits gespeicherte Daten bleiben erhalten.",false);
                return false;
            }
            if(Thread.currentThread().isInterrupted()) {
                finish("Upload unterbrochen","Offene Übertragungen bleiben gespeichert und werden später erneut versucht.",false);
                return false;
            }
            return true;
        }
        private void running(String title,String details) {
            state=new Snapshot(true,title,details,false,false,false);
        }
        private void finish(String title,String details,boolean success) {
            state=new Snapshot(false,title,details,success,false,false);
        }
        private void run(String pairing) {
            try {
                if(!valid(pairing))return;
                running("Aufträge werden hochgeladen …","Die Serverfreigabe wird geprüft. Danach folgen die Bilder.");
                while(true) {
                    if(!valid(pairing))return;
                    Step step=backend.orders(pairing);
                    if(!valid(pairing))return;
                    if(!step.ok){finish("Aufträge konnten nicht vollständig übertragen werden",step.details,false);return;}
                    if(!step.more)break;
                    if(step.progress<=0){finish("Upload wartet auf Rückmeldung","Der Server hat keine weiteren Aufträge bestätigt. Bitte später erneut versuchen.",false);return;}
                    running("Weitere Aufträge werden hochgeladen …",step.details);
                }
                running("Bilder werden vorbereitet …","Gespeicherte Auftragsbilder werden für die Übertragung geprüft.");
                backend.recover();
                if(!valid(pairing))return;
                while(backend.remainingPhotos()>0) {
                    running("Bilder werden hochgeladen …",backend.remainingPhotos()+" Bilder warten noch.\n"+backend.summary());
                    Step step=backend.photos(pairing);
                    if(!valid(pairing))return;
                    if(!step.ok){finish("Bilder konnten nicht vollständig übertragen werden",step.details+"\n"+backend.summary(),false);return;}
                    if(backend.remainingPhotos()>0&&step.progress<=0){finish("Bilder warten auf Übertragung","Keine weiteren Bilder wurden bestätigt.\n"+backend.summary(),false);return;}
                }
                if(!valid(pairing))return;
                String summary=backend.summary();
                boolean blocked=backend.blocked();
                if(!valid(pairing))return;
                finish(blocked?"Übertragung mit offenen Punkten":"Letzter Serverabgleich abgeschlossen",
                        summary+(blocked?"\nNeue Zwischenstände erneut hochladen; gemeldete Einträge oder Bilder bitte prüfen.":"\nGespeicherte Aufträge wurden in diesem Durchlauf vom Server geprüft."),!blocked);
            } catch(InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                finish("Upload unterbrochen","Offene Übertragungen bleiben gespeichert und werden später erneut versucht.",false);
            } catch(Exception unavailable) {
                finish("Upload derzeit nicht möglich","Bitte Internetverbindung und Serververbindung prüfen. Deine Daten bleiben auf dem Handy.",false);
            } finally {
                try { backend.schedule(); } catch(RuntimeException ignored) { /* Next saved entry schedules again. */ }
            }
        }
    }

    private static Controller controller;
    private static synchronized Controller controller(Context context) {
        if(controller==null) {
            Context app=context.getApplicationContext();
            controller=new Controller(task->NasUploadJob.submit(task),new Backend() {
                public String pairing(){return NasSync.galleryRevision(app);}
                public boolean current(String pairing){return NasSync.galleryCurrent(app,pairing);}
                public boolean enabled(){return RobotOrderSync.enabled(app);}
                public void enable(){RobotOrderSync.enable(app);}
                public void recover()throws Exception{OrderPhotos.recoverForUpload(app);}
                public Step orders(String pairing){return RobotOrderSync.runAttempt(app,pairing).step;}
                public Step photos(String pairing){return NasSync.uploadWebsiteBatch(app,pairing);}
                public String summary(){return RobotOrderSync.statusSummary(app);}
                public long remainingPhotos(){return NasSync.pendingPhotos(app);}
                public boolean blocked(){return RobotOrderSync.hasBlocked(app)||NasSync.hasBlockedPhotos(app);}
                public void schedule(){NasSync.schedule(app);}
            });
        }
        return controller;
    }
    static Snapshot snapshot(Context context){return controller(context).snapshot();}
    static boolean start(Context context,boolean enableOrders){return controller(context).start(enableOrders);}
}
