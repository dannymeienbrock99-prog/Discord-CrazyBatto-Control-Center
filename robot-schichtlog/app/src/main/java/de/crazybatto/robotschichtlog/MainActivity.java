package de.crazybatto.robotschichtlog;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.ContentResolver;
import android.content.Context;
import android.content.ClipData;
import android.content.Intent;
import android.database.Cursor;
import android.graphics.Color;
import android.graphics.drawable.Drawable;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.provider.OpenableColumns;
import android.text.InputType;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.TextView;
import android.widget.Toast;

import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Calendar;
import java.util.Date;
import java.util.List;
import java.util.Locale;

public class MainActivity extends Activity {
    private static final int REQUEST_IMAGE = 1001;
    private static final int REQUEST_VIDEO = 1002;
    private static final int REQUEST_EXPORT_CSV = 1003;
    private static final int REQUEST_ORDER_PHOTOS = 1004;

    private AppDesign design;
    private String selectedScreen = "auftrag";

    private DbHelper db;
    private FrameLayout content;
    private TextView liveStatus;
    private Button navJob;
    private Button navNew;
    private Button navHistory;
    private Button navPhotos;
    private Button navStats;
    private EditText photoSearchOrder;
    private EditText photoSearchArticle;
    private final Handler clockHandler = new Handler(Looper.getMainLooper());

    private Spinner robotSpinner;
    private Spinner shiftSpinner;
    private Spinner eventSpinner;
    private EditText orderInput;
    private EditText articleInput;
    private EditText programInput;
    private EditText missingPartsInput;
    private EditText quantityInput;
    private EditText noteInput;
    private EditText handoverInput;
    private CheckBox importantCheck;
    private LinearLayout attachmentList;
    private final List<PendingAttachment> pendingAttachments = new ArrayList<>();
    private Record pickerTarget;
    private LinearLayout visiblePhotoSection;
    private Record visiblePhotoOrder;
    private boolean visiblePhotoDark;
    private boolean manualForm;
    private boolean savingMedia;
    private Bundle parkedDraft;

    private List<Record> currentHistoryRecords = new ArrayList<>();
    private Integer currentRobotFilter = null;
    private String currentShiftFilter = null;
    private String currentSearch = "";
    private String currentHistoryDate = "";

    private final Runnable clockTick = new Runnable() {
        @Override public void run() {
            updateClock();
            clockHandler.postDelayed(this, 30_000);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        design = AppDesign.current(this);
        setTheme(!design.dark ? R.style.Theme_RobotSchichtLog_Werkstatt :
                "cad".equals(design.id) ? R.style.Theme_RobotSchichtLog_Cad : R.style.Theme_RobotSchichtLog);
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(design.bg);
        getWindow().setNavigationBarColor(design.nav);
        int lightBars = View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR;
        View decor = getWindow().getDecorView();
        int flags = decor.getSystemUiVisibility();
        decor.setSystemUiVisibility(design.dark ? (flags & ~lightBars) : (flags | lightBars));
        db = new DbHelper(this);
        buildShell();
        if (savedInstanceState != null) pickerTarget = restoreTarget(savedInstanceState.getBundle("photoTarget"));
        if (savedInstanceState != null) parkedDraft = savedInstanceState.getBundle("parkedDraft");
        if (savedInstanceState != null && savedInstanceState.getBoolean("manualForm")) {
            showNewEntry();
            restoreDraft(savedInstanceState);
        } else if (savedInstanceState != null && savedInstanceState.containsKey("photoSearchOrder")) {
            showPhotos();
            photoSearchOrder.setText(savedInstanceState.getString("photoSearchOrder"));
            photoSearchArticle.setText(savedInstanceState.getString("photoSearchArticle"));
        } else if (savedInstanceState != null && "verlauf".equals(savedInstanceState.getString("screen"))) {
            showHistory(savedInstanceState.getBundle("appliedHistoryFilters"));
        } else if (savedInstanceState != null && "auswertung".equals(savedInstanceState.getString("screen"))) {
            showStats();
        } else showJob();
        OrderPhotos.recover(this);
        NasSync.schedule(this);
        clockHandler.post(clockTick);
    }

    @Override
    protected void onDestroy() {
        clockHandler.removeCallbacks(clockTick);
        if (db != null) db.close();
        super.onDestroy();
    }

    private void buildShell() {
        FrameLayout shell = new FrameLayout(this);
        shell.setBackgroundColor(design.bg);

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setBackgroundColor(Color.TRANSPARENT);
        root.setPadding(dp(14), dp(10), dp(14), dp(10));
        if (android.os.Build.VERSION.SDK_INT >= 35) {
            root.setOnApplyWindowInsetsListener((view, insets) -> {
                android.graphics.Insets bars = insets.getInsets(android.view.WindowInsets.Type.systemBars()
                        | android.view.WindowInsets.Type.displayCutout());
                view.setPadding(dp(14) + bars.left, dp(10) + bars.top, dp(14) + bars.right, dp(10) + bars.bottom);
                return insets;
            });
        }

        TextView title = text("Robot SchichtLog", 21, true, design.text);
        title.setLetterSpacing(-0.025f);
        LinearLayout heading = new LinearLayout(this);
        heading.setGravity(Gravity.CENTER_VERTICAL);
        heading.addView(title, new LinearLayout.LayoutParams(0, -2, 1));
        Button chooseDesign = miniButton("Design", design.accent);
        chooseDesign.setMinWidth(dp(54));
        chooseDesign.setMinimumWidth(dp(54));
        chooseDesign.setTextSize(13);
        chooseDesign.setMinHeight(dp(48));
        chooseDesign.setContentDescription("Design auswählen");
        chooseDesign.setOnClickListener(v -> AppDesign.choose(this, this::recreate));
        heading.addView(chooseDesign);
        Button photoStorage = miniButton("Fotospeicher", design.accent);
        photoStorage.setMinWidth(dp(64));
        photoStorage.setMinimumWidth(dp(64));
        photoStorage.setTextSize(12);
        photoStorage.setMinHeight(dp(48));
        photoStorage.setContentDescription("Fotospeicher und Website-Verbindung einrichten");
        photoStorage.setOnClickListener(v -> NasSync.showSettings(this));
        LinearLayout.LayoutParams tools = new LinearLayout.LayoutParams(-2,-2);
        tools.leftMargin = dp(5);
        heading.addView(photoStorage, tools);
        root.addView(heading);
        Button controlSync = miniButton("Control Center · Aufträge verbinden", design.accent);
        controlSync.setContentDescription("Auftragssynchronisierung mit dem privaten Control Center verwalten");
        controlSync.setOnClickListener(v -> RobotOrderSync.showSettings(this));
        root.addView(controlSync);

        liveStatus = text("", 13, false, design.muted);
        liveStatus.setPadding(0, dp(4), 0, dp(10));
        root.addView(liveStatus);

        LinearLayout nav = new LinearLayout(this);
        nav.setOrientation(LinearLayout.HORIZONTAL);
        nav.setGravity(Gravity.CENTER);

        navJob = navButton("Auftrag", R.drawable.nav_auftrag);
        navNew = navButton("Eintrag", R.drawable.nav_eintrag);
        navHistory = navButton("Verlauf", R.drawable.nav_verlauf);
        navPhotos = navButton("Fotos", R.drawable.nav_fotos);
        navStats = navButton("Auswertung", R.drawable.nav_auswertung);
        nav.addView(navJob, weightParams());
        nav.addView(navNew, weightParams());
        nav.addView(navHistory, weightParams());
        nav.addView(navPhotos, weightParams());
        LinearLayout.LayoutParams statsWidth = weightParams();
        statsWidth.weight = 1.28f;
        nav.addView(navStats, statsWidth);

        content = new FrameLayout(this);
        content.setBackgroundColor(Color.TRANSPARENT);
        LinearLayout.LayoutParams cp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f);
        cp.topMargin = dp(3);
        root.addView(content, cp);
        View divider = new View(this);
        divider.setBackgroundColor(design.border);
        root.addView(divider, new LinearLayout.LayoutParams(-1,dp(1)));
        nav.setBackgroundColor(design.nav);
        root.addView(nav);

        navJob.setOnClickListener(v -> showJob());
        navNew.setOnClickListener(v -> { if (!manualForm) showNewEntry(); });
        navHistory.setOnClickListener(v -> showHistory());
        navPhotos.setOnClickListener(v -> showPhotos());
        navStats.setOnClickListener(v -> showStats());

        shell.addView(root, new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        setContentView(shell);
    }

    private void updateClock() {
        long now = System.currentTimeMillis();
        liveStatus.setText(ShiftUtils.getShift(now) + "  ·  " + ShiftUtils.formatDateTime(now));
    }

    private void showJob() {
        setActiveNav(navJob);
        content.removeAllViews();

        ScrollView scroll = new ScrollView(this);
        scroll.setId(R.id.job_scroll);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(2), dp(4), dp(2), dp(30));
        scroll.addView(root);

        ActiveJob job = db.getActiveJob();
        long now = System.currentTimeMillis();
        OrderDesignHeader.addTo(this, root, job, now);

        if (job == null) {

            root.addView(label("Roboter"));
            Spinner robot = spinner(new String[]{
                    "Roboter 1", "Roboter 2", "Roboter 3", "Roboter 4",
                    "Roboter 5", "Roboter 6", "Roboter 7", "Roboter 8"});
            robot.setId(R.id.start_robot);
            root.addView(robot, fieldLp());

            root.addView(label("Auftragsnummer *"));
            EditText order = edit("z. B. A-2026-0815", InputType.TYPE_CLASS_TEXT);
            order.setId(R.id.start_order);
            root.addView(order, fieldLp());

            EditText personnel = addPersonnelField(root);
            personnel.setId(R.id.start_personnel);

            root.addView(label("Artikelnummer"));
            EditText article = edit("Optional: Artikel-/Teilenummer", InputType.TYPE_CLASS_TEXT);
            article.setId(R.id.start_article);
            root.addView(article, fieldLp());

            root.addView(label("Programm (optional)"));
            EditText program = edit("Nur falls bekannt / hinterlegt", InputType.TYPE_CLASS_TEXT);
            program.setId(R.id.start_program);
            root.addView(program, fieldLp());

            root.addView(statCard("Aktuelle Schicht", ShiftUtils.getShift(now), ShiftUtils.formatDateTime(now)));

            Button start = actionButton("AUF AUFTRAG ANMELDEN", true);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, dp(56));
            lp.topMargin = dp(12);
            root.addView(start, lp);
            start.setOnClickListener(v -> {
                String orderNumber = order.getText().toString().trim();
                if (orderNumber.isEmpty()) {
                    order.setError("Auftragsnummer fehlt");
                    order.requestFocus();
                    return;
                }
                String number = requirePersonnel(personnel);
                if (number == null) return;
                Record entry = new Record();
                entry.startedAt = entry.timestamp = System.currentTimeMillis();
                entry.robot = robot.getSelectedItemPosition() + 1;
                entry.orderNumber = orderNumber;
                entry.articleNumber = article.getText().toString().trim();
                entry.programInfo = program.getText().toString().trim();
                entry.shift = ShiftUtils.getShift(entry.timestamp);
                entry.personnelNumber = number;
                entry.source = entry.eventType = "Auftrag gestartet";
                try {
                    db.startJob(entry);
                    NasSync.schedule(this);
                    Toast.makeText(this, "Auf Auftrag " + orderNumber + " angemeldet", Toast.LENGTH_LONG).show();
                    showJob();
                } catch (Exception ex) {
                    showError("Auftrag konnte nicht gestartet werden", ex.getMessage());
                }
            });
        } else {
            addPhotoSection(root, jobEvent(job, "", "Auftragsfotos"), design.dark);
            EditText personnel = addPersonnelField(root);
            personnel.setId(R.id.job_personnel);

            root.addView(label("Produzierte Menge beim Beenden *"));
            EditText quantity = edit("z. B. 420", InputType.TYPE_CLASS_NUMBER);
            quantity.setId(R.id.job_quantity);
            root.addView(quantity, fieldLp());

            root.addView(label("Ereignis / Vorgang"));
            Spinner event = spinner(new String[]{
                    "Kein Ereignis", "Störung", "Material", "Qualität", "Wartung", "Umrüstung", "Sonstiges"});
            event.setId(R.id.job_event);
            root.addView(event, fieldLp());

            root.addView(label("Teile fehlen"));
            EditText missingParts = edit("Optional: Was fehlt? z. B. Halter, Schrauben, Rohteil …", InputType.TYPE_CLASS_TEXT);
            missingParts.setId(R.id.job_missing_parts);
            root.addView(missingParts, fieldLp());

            CheckBox important = new CheckBox(this);
            important.setText("Als wichtiges Ereignis markieren");
            important.setTextColor(design.text);
            important.setTextSize(14);
            important.setButtonTintList(android.content.res.ColorStateList.valueOf(design.accent));
            important.setPadding(0, dp(4), 0, dp(8));
            important.setId(R.id.job_important);
            root.addView(important);

            root.addView(label("Notiz / was ist vorgefallen?"));
            EditText note = edit("Störung, Ursache, Maßnahme oder sonstige Information …",
                    InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
            note.setMinLines(4);
            note.setGravity(Gravity.TOP | Gravity.START);
            LinearLayout.LayoutParams noteLp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, dp(116));
            note.setId(R.id.job_note);
            root.addView(note, noteLp);

            root.addView(label("Info für Schichtübergabe"));
            EditText handover = edit("Was muss die nächste Schicht wissen? Stand, Problem, Material, nächster Schritt …",
                    InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
            handover.setMinLines(4);
            handover.setGravity(Gravity.TOP | Gravity.START);
            LinearLayout.LayoutParams handLp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, dp(116));
            handLp.bottomMargin = dp(8);
            handover.setId(R.id.job_handover);
            root.addView(handover, handLp);

            Button saveHandover = actionButton("SCHICHTÜBERGABE SPEICHERN", false);
            LinearLayout.LayoutParams hlp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, dp(52));
            hlp.topMargin = dp(6);
            root.addView(saveHandover, hlp);
            saveHandover.setOnClickListener(v -> {
                String info = handover.getText().toString().trim();
                if (info.isEmpty()) {
                    handover.setError("Übergabe-Info fehlt");
                    handover.requestFocus();
                    return;
                }
                String number = requirePersonnel(personnel);
                if (number != null) saveShiftHandover(job, number, note.getText().toString().trim(), info,
                        missingParts.getText().toString().trim());
            });

            Button pauseResume = actionButton(job.paused ? "AUFTRAG FORTSETZEN" : "AUFTRAG UNTERBRECHEN", false);
            root.addView(pauseResume, hlp);
            pauseResume.setOnClickListener(v -> {
                String number = requirePersonnel(personnel);
                if (number == null) return;
                String type = job.paused ? "Auftrag fortgesetzt" : "Auftrag unterbrochen";
                Record r = jobEvent(job, number, type);
                r.note = note.getText().toString().trim();
                r.handoverNote = handover.getText().toString().trim();
                r.missingParts = missingParts.getText().toString().trim();
                r.important = important.isChecked();
                try {
                    db.recordJobAction(job, job.paused ? DbHelper.JobAction.RESUME : DbHelper.JobAction.PAUSE, r);
                    NasSync.schedule(this);
                    Toast.makeText(this, type, Toast.LENGTH_SHORT).show();
                    showJob();
                } catch (Exception ex) {
                    showError("Auftragsstatus konnte nicht gespeichert werden", ex.getMessage());
                }
            });

            Button finish = actionButton("ABMELDEN UND AUFTRAG BEENDEN", true);
            LinearLayout.LayoutParams flp = new LinearLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, dp(56));
            flp.topMargin = dp(10);
            root.addView(finish, flp);
            finish.setOnClickListener(v -> {
                String number = requirePersonnel(personnel);
                if (number == null) return;
                String qtyRaw = quantity.getText().toString().trim();
                if (qtyRaw.isEmpty()) {
                    quantity.setError("Produktionsmenge fehlt");
                    quantity.requestFocus();
                    return;
                }
                int qty;
                try {
                    qty = Integer.parseInt(qtyRaw);
                    if (qty < 0) throw new NumberFormatException();
                } catch (NumberFormatException ex) {
                    quantity.setError("Bitte eine gültige Menge ab 0 eingeben");
                    return;
                }
                final int finalQty = qty;
                new AlertDialog.Builder(this)
                        .setTitle("Auftrag beenden?")
                        .setMessage("Auftrag " + job.orderNumber + " auf Roboter " + job.robot + " wird beendet und im Verlauf gespeichert.")
                        .setPositiveButton("Beenden", (d, w) -> finishActiveJob(job, number, finalQty,
                                event.getSelectedItem().toString(), important.isChecked(),
                                note.getText().toString().trim(), handover.getText().toString().trim(),
                                missingParts.getText().toString().trim()))
                        .setNegativeButton("Abbrechen", null)
                        .show();
            });
        }

        content.addView(scroll);
    }

    private EditText addPersonnelField(LinearLayout root) {
        root.addView(label("Eigene Personalnummer *"));
        EditText field = edit("Personalnummer eingeben", InputType.TYPE_CLASS_NUMBER);
        root.addView(field, fieldLp());
        return field;
    }

    private String requirePersonnel(EditText field) {
        String number = field.getText().toString().trim();
        if (number.matches("[0-9]+")) return number;
        field.setError("Bitte die eigene Personalnummer in Ziffern eingeben.");
        field.requestFocus();
        return null;
    }

    private Record jobEvent(ActiveJob job, String number, String source) {
        Record r = new Record();
        r.robot = job.robot;
        r.orderNumber = job.orderNumber;
        r.articleNumber = job.articleNumber;
        r.programInfo = job.programInfo;
        r.personnelNumber = number;
        r.timestamp = System.currentTimeMillis();
        r.shift = ShiftUtils.getShift(r.timestamp);
        r.startedAt = job.startedAt;
        r.source = r.eventType = source;
        return r;
    }

    private void saveShiftHandover(ActiveJob job, String number, String note, String handover, String missingParts) {
        Record r = jobEvent(job, number, "Schichtübergabe");
        r.missingParts = missingParts;
        r.important = true;
        r.note = note;
        r.handoverNote = handover;
        try {
            db.recordJobAction(job, DbHelper.JobAction.HANDOVER, r);
            NasSync.schedule(this);
            Toast.makeText(this, "Schichtübergabe gespeichert", Toast.LENGTH_LONG).show();
            showJob();
        } catch (Exception ex) {
            showError("Übergabe konnte nicht gespeichert werden", ex.getMessage());
        }
    }

    private void finishActiveJob(ActiveJob job, String number, int quantity, String eventType, boolean important,
                                 String note, String handover, String missingParts) {
        Record r = jobEvent(job, number, "Auftrag beendet");
        r.missingParts = missingParts;
        r.quantity = quantity;
        r.eventType = eventType;
        r.important = important;
        r.note = note;
        r.handoverNote = handover;
        r.endedAt = r.timestamp;
        try {
            db.recordJobAction(job, DbHelper.JobAction.FINISH, r);
            NasSync.schedule(this);
            Toast.makeText(this, "Auftrag beendet · Dauer " + durationText(job.startedAt, r.endedAt), Toast.LENGTH_LONG).show();
            showJob();
        } catch (Exception ex) {
            showError("Auftrag konnte nicht beendet werden", ex.getMessage());
        }
    }

    private void showNewEntry() {
        setActiveNav(navNew);
        content.removeAllViews();

        ScrollView scroll = new ScrollView(this);
        scroll.setId(R.id.manual_scroll);
        LinearLayout form = new LinearLayout(this);
        form.setOrientation(LinearLayout.VERTICAL);
        form.setPadding(dp(2), dp(4), dp(2), dp(30));
        scroll.addView(form);

        TextView heading = text("Neuen Arbeits-Eintrag erfassen", 20, true, design.text);
        form.addView(heading);
        TextView sub = text("Datum und Uhrzeit werden beim Speichern automatisch gesetzt.", 13, false, design.muted);
        sub.setPadding(0, dp(4), 0, dp(12));
        form.addView(sub);

        form.addView(label("Roboter"));
        robotSpinner = spinner(new String[]{
                "Roboter 1", "Roboter 2", "Roboter 3", "Roboter 4",
                "Roboter 5", "Roboter 6", "Roboter 7", "Roboter 8"});
        form.addView(robotSpinner, fieldLp());

        form.addView(label("Auftragsnummer *"));
        orderInput = edit("z. B. A-2026-0815", InputType.TYPE_CLASS_TEXT);
        form.addView(orderInput, fieldLp());

        form.addView(label("Artikelnummer"));
        articleInput = edit("Optional: Artikel-/Teilenummer", InputType.TYPE_CLASS_TEXT);
        form.addView(articleInput, fieldLp());

        form.addView(label("Programm (optional)"));
        programInput = edit("Nur falls bekannt / hinterlegt", InputType.TYPE_CLASS_TEXT);
        form.addView(programInput, fieldLp());

        ActiveJob activeJob = db.getActiveJob();
        if (activeJob != null) {
            robotSpinner.setSelection(Math.max(0, Math.min(7, activeJob.robot - 1)));
            orderInput.setText(activeJob.orderNumber);
            articleInput.setText(activeJob.articleNumber == null ? "" : activeJob.articleNumber);
            programInput.setText(activeJob.programInfo == null ? "" : activeJob.programInfo);
            TextView activeHint = text("Aktiver Auftrag wurde automatisch übernommen.", 12, true, design.accent);
            activeHint.setPadding(dp(4), dp(3), 0, dp(5));
            form.addView(activeHint);
        }

        form.addView(label("Produzierte Menge *"));
        quantityInput = edit("z. B. 420", InputType.TYPE_CLASS_NUMBER);
        form.addView(quantityInput, fieldLp());

        form.addView(label("Schicht"));
        shiftSpinner = spinner(new String[]{"Automatisch", ShiftUtils.EARLY, ShiftUtils.LATE, ShiftUtils.NIGHT});
        form.addView(shiftSpinner, fieldLp());

        TextView shiftHint = text("Automatisch: 06–14 Früh · 14–22 Spät · 22–06 Nacht", 12, false, design.muted);
        shiftHint.setPadding(dp(4), 0, 0, dp(8));
        form.addView(shiftHint);

        form.addView(label("Ereignis / Vorgang"));
        eventSpinner = spinner(new String[]{
                "Kein Ereignis", "Störung", "Material", "Qualität", "Wartung", "Umrüstung", "Sonstiges"});
        form.addView(eventSpinner, fieldLp());

        form.addView(label("Teile fehlen"));
        missingPartsInput = edit("Optional: Was fehlt?", InputType.TYPE_CLASS_TEXT);
        form.addView(missingPartsInput, fieldLp());

        importantCheck = new CheckBox(this);
        importantCheck.setText("Als wichtiges Ereignis markieren");
        importantCheck.setTextColor(design.text);
        importantCheck.setTextSize(14);
        importantCheck.setButtonTintList(android.content.res.ColorStateList.valueOf(design.accent));
        importantCheck.setPadding(0, dp(4), 0, dp(8));
        form.addView(importantCheck);

        form.addView(label("Notiz / was ist vorgefallen?"));
        noteInput = edit("Freitext: Störung, Ursache, Maßnahme, Übergabe an nächste Schicht …",
                InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        noteInput.setMinLines(5);
        noteInput.setGravity(Gravity.TOP | Gravity.START);
        LinearLayout.LayoutParams noteLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(132));
        noteLp.bottomMargin = dp(2);
        form.addView(noteInput, noteLp);

        form.addView(label("Info für Schichtübergabe"));
        handoverInput = edit("Optional: Was muss die nächste Schicht wissen?",
                InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE | InputType.TYPE_TEXT_FLAG_CAP_SENTENCES);
        handoverInput.setMinLines(3);
        handoverInput.setGravity(Gravity.TOP | Gravity.START);
        LinearLayout.LayoutParams handoverLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(100));
        handoverLp.bottomMargin = dp(4);
        form.addView(handoverInput, handoverLp);

        form.addView(label("Bilder und Videos"));
        LinearLayout mediaButtons = new LinearLayout(this);
        mediaButtons.setOrientation(LinearLayout.HORIZONTAL);
        Button addPhoto = actionButton("Foto hinzufügen", false);
        Button addVideo = actionButton("Video hinzufügen", false);
        mediaButtons.addView(addPhoto, weightParams());
        LinearLayout.LayoutParams second = weightParams();
        second.leftMargin = dp(8);
        mediaButtons.addView(addVideo, second);
        form.addView(mediaButtons);

        attachmentList = new LinearLayout(this);
        attachmentList.setOrientation(LinearLayout.VERTICAL);
        attachmentList.setPadding(0, dp(8), 0, dp(8));
        form.addView(attachmentList);
        renderPendingAttachments();

        addPhoto.setOnClickListener(v -> pickMedia("image/*", REQUEST_IMAGE));
        addVideo.setOnClickListener(v -> pickMedia("video/*", REQUEST_VIDEO));

        Button save = actionButton("EINTRAG SPEICHERN", true);
        LinearLayout.LayoutParams saveLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(54));
        saveLp.topMargin = dp(8);
        form.addView(save, saveLp);
        save.setOnClickListener(v -> saveEntry());

        content.addView(scroll);
        if (parkedDraft != null) {
            restoreDraft(parkedDraft);
            parkedDraft = null;
        }
    }

    private void saveEntry() {
        String order = orderInput.getText().toString().trim();
        String qtyRaw = quantityInput.getText().toString().trim();

        if (order.isEmpty()) {
            orderInput.setError("Auftragsnummer fehlt");
            orderInput.requestFocus();
            return;
        }
        if (qtyRaw.isEmpty()) {
            quantityInput.setError("Produktionsmenge fehlt");
            quantityInput.requestFocus();
            return;
        }

        int quantity;
        try {
            quantity = Integer.parseInt(qtyRaw);
            if (quantity < 0) throw new NumberFormatException();
        } catch (NumberFormatException ex) {
            quantityInput.setError("Bitte eine gültige Menge ab 0 eingeben");
            return;
        }

        long now = System.currentTimeMillis();
        Record r = new Record();
        r.robot = robotSpinner.getSelectedItemPosition() + 1;
        r.orderNumber = order;
        r.articleNumber = articleInput.getText().toString().trim();
        r.programInfo = programInput.getText().toString().trim();
        r.missingParts = missingPartsInput.getText().toString().trim();
        r.quantity = quantity;
        r.timestamp = now;
        r.shift = shiftSpinner.getSelectedItemPosition() == 0
                ? ShiftUtils.getShift(now)
                : shiftSpinner.getSelectedItem().toString();
        r.eventType = eventSpinner.getSelectedItem().toString();
        r.important = importantCheck.isChecked();
        r.note = noteInput.getText().toString().trim();
        r.handoverNote = handoverInput.getText().toString().trim();
        r.startedAt = 0;
        r.endedAt = 0;
        r.source = "Eintrag";

        List<Attachment> attachments = new ArrayList<>();
        for (PendingAttachment p : pendingAttachments) {
            attachments.add(attachment(p.uri, p.mimeType, p.displayName));
        }
        saveMedia(r, attachments, true);
    }

    private void pickMedia(String mime, int requestCode) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType(mime);
        intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_GRANT_PERSISTABLE_URI_PERMISSION);
        startActivityForResult(intent, requestCode);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == NasSync.REQUEST_FOLDER) {
            NasSync.onFolderResult(this, resultCode, data);
            return;
        }
        if (requestCode == REQUEST_ORDER_PHOTOS) {
            Record target = pickerTarget;
            pickerTarget = null;
            if (resultCode != RESULT_OK || data == null || target == null) return;
            List<Attachment> photos = new ArrayList<>();
            ClipData items = data.getClipData();
            if (items != null) {
                for (int i = 0; i < items.getItemCount(); i++)
                    photos.add(selectedPhoto(items.getItemAt(i).getUri()));
            } else if (data.getData() != null) photos.add(selectedPhoto(data.getData()));
            if (!photos.isEmpty()) saveMedia(target, photos, false);
            return;
        }
        if (resultCode != RESULT_OK || data == null) return;

        if (requestCode == REQUEST_IMAGE || requestCode == REQUEST_VIDEO) {
            ClipData clipData = data.getClipData();
            if (clipData != null) {
                for (int i = 0; i < clipData.getItemCount(); i++) {
                    addSelectedMedia(clipData.getItemAt(i).getUri(), requestCode, data.getFlags());
                }
            } else if (data.getData() != null) {
                addSelectedMedia(data.getData(), requestCode, data.getFlags());
            }
            renderPendingAttachments();
            return;
        }

        if (requestCode == REQUEST_EXPORT_CSV && data.getData() != null) {
            exportCsvTo(data.getData());
        }
    }

    private void addSelectedMedia(Uri uri, int requestCode, int intentFlags) {
        try {
            int flags = intentFlags & Intent.FLAG_GRANT_READ_URI_PERMISSION;
            getContentResolver().takePersistableUriPermission(uri, flags);
        } catch (Exception ignored) {
            // Einige Provider liefern keine persistierbare Berechtigung.
        }
        String mime = getContentResolver().getType(uri);
        String name = resolveDisplayName(uri);
        pendingAttachments.add(new PendingAttachment(uri,
                mime == null ? (requestCode == REQUEST_IMAGE ? "image/*" : "video/*") : mime,
                name));
    }

    private static Attachment attachment(Uri uri, String type, String name) {
        Attachment value = new Attachment();
        value.uri = uri.toString();
        value.mimeType = type;
        value.displayName = name;
        return value;
    }

    private Attachment selectedPhoto(Uri uri) {
        String type = getContentResolver().getType(uri);
        return attachment(uri, type != null && type.startsWith("image/") ? type : "image/*", resolveDisplayName(uri));
    }

    private void addPhotoSection(LinearLayout parent, Record record, boolean dark) {
        LinearLayout container = new LinearLayout(this);
        container.setOrientation(LinearLayout.VERTICAL);
        parent.addView(container);
        visiblePhotoSection = container;
        visiblePhotoOrder = record;
        visiblePhotoDark = dark;
        refreshPhotos();
    }

    private void refreshPhotos() {
        if (visiblePhotoSection == null || visiblePhotoOrder == null) return;
        visiblePhotoSection.removeAllViews();
        Record target = visiblePhotoOrder;
        PhotoGallery.section(this, visiblePhotoSection, db, target.articleNumber, target.orderNumber,
                visiblePhotoDark, () -> {
                    pickerTarget = target;
                    pickMedia("image/*", REQUEST_ORDER_PHOTOS);
                });
    }

    private void saveMedia(Record record, List<Attachment> attachments, boolean manual) {
        if (savingMedia) return;
        savingMedia = true;
        AlertDialog progress = new AlertDialog.Builder(this)
                .setMessage(manual ? "Eintrag wird gespeichert …" : "Fotos werden dem Auftrag zugeordnet …")
                .setCancelable(false).show();
        Context app = getApplicationContext();
        OrderPhotos.IMPORTS.execute(() -> {
            String error = null;
            try { OrderPhotos.save(app, record, attachments, manual); }
            catch (Exception ex) { error = ex.getLocalizedMessage() == null ? "Dateizugriff fehlgeschlagen." : ex.getLocalizedMessage(); }
            String result = error;
            runOnUiThread(() -> {
                savingMedia = false;
                if (isFinishing() || isDestroyed()) return;
                progress.dismiss();
                if (result != null) {
                    showError("Speichern fehlgeschlagen", result);
                    return;
                }
                if (manual) {
                    pendingAttachments.clear();
                    showNewEntry();
                } else refreshPhotos();
                String message = manual ? "Eintrag gespeichert" : attachments.size()
                        + (attachments.size() == 1 ? " Foto bei Auftrag " : " Fotos bei Auftrag ") + record.orderNumber;
                Toast.makeText(this, message, Toast.LENGTH_SHORT).show();
            });
        });
    }

    private static Bundle targetState(Record r) {
        if (r == null) return null;
        Bundle state = new Bundle();
        state.putLong("id", r.id);
        state.putLong("start", r.startedAt);
        state.putInt("robot", r.robot);
        state.putString("order", r.orderNumber);
        state.putString("article", r.articleNumber);
        state.putString("program", r.programInfo);
        return state;
    }

    private static Record restoreTarget(Bundle state) {
        if (state == null) return null;
        Record r = new Record();
        r.id = state.getLong("id");
        r.startedAt = state.getLong("start");
        r.robot = state.getInt("robot");
        r.orderNumber = state.getString("order");
        r.articleNumber = state.getString("article", "");
        r.programInfo = state.getString("program", "");
        r.timestamp = System.currentTimeMillis();
        r.shift = ShiftUtils.getShift(r.timestamp);
        r.source = r.eventType = "Auftragsfotos";
        return r;
    }

    @Override protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        state.putString("screen", selectedScreen);
        if ("verlauf".equals(selectedScreen)) {
            Bundle filters = new Bundle();
            filters.putInt("robot", currentRobotFilter == null ? 0 : currentRobotFilter);
            filters.putString("shift", currentShiftFilter);
            filters.putString("query", currentSearch);
            filters.putString("date", currentHistoryDate);
            state.putBundle("appliedHistoryFilters", filters);
        }
        if (photoSearchOrder != null) {
            state.putString("photoSearchOrder", photoSearchOrder.getText().toString());
            state.putString("photoSearchArticle", photoSearchArticle.getText().toString());
        }
        state.putBundle("photoTarget", targetState(pickerTarget));
        state.putBundle("parkedDraft", parkedDraft);
        state.putBoolean("manualForm", manualForm && !savingMedia);
        if (!manualForm || savingMedia) return;
        saveDraft(state);
    }

    private void saveDraft(Bundle state) {
        state.putStringArray("fields", new String[]{
            orderInput.getText().toString(), articleInput.getText().toString(), programInput.getText().toString(),
            missingPartsInput.getText().toString(), quantityInput.getText().toString(), noteInput.getText().toString(),
            handoverInput.getText().toString()});
        state.putIntArray("choices", new int[]{robotSpinner.getSelectedItemPosition(),
                shiftSpinner.getSelectedItemPosition(), eventSpinner.getSelectedItemPosition()});
        state.putBoolean("important", importantCheck.isChecked());
        ArrayList<String> media = new ArrayList<>();
        for (PendingAttachment p : pendingAttachments) {
            media.add(p.uri.toString()); media.add(p.mimeType); media.add(p.displayName);
        }
        state.putStringArrayList("pending", media);
    }

    private void restoreDraft(Bundle state) {
        String[] fields = state.getStringArray("fields");
        if (fields == null) return;
        EditText[] inputs = {orderInput, articleInput, programInput, missingPartsInput, quantityInput, noteInput, handoverInput};
        for (int i = 0; i < inputs.length; i++) inputs[i].setText(fields[i]);
        int[] choices = state.getIntArray("choices");
        robotSpinner.setSelection(choices[0]); shiftSpinner.setSelection(choices[1]); eventSpinner.setSelection(choices[2]);
        importantCheck.setChecked(state.getBoolean("important"));
        ArrayList<String> media = state.getStringArrayList("pending");
        pendingAttachments.clear();
        if (media != null) for (int i = 0; i + 2 < media.size(); i += 3)
            pendingAttachments.add(new PendingAttachment(Uri.parse(media.get(i)), media.get(i+1), media.get(i+2)));
        renderPendingAttachments();
    }

    private void renderPendingAttachments() {
        if (attachmentList == null) return;
        attachmentList.removeAllViews();
        if (pendingAttachments.isEmpty()) {
            TextView none = text("Noch keine Anhänge ausgewählt.", 12, false, design.muted);
            none.setPadding(dp(4), dp(3), 0, dp(3));
            attachmentList.addView(none);
            return;
        }
        for (int i = 0; i < pendingAttachments.size(); i++) {
            final int index = i;
            PendingAttachment p = pendingAttachments.get(i);
            LinearLayout row = cardRow();
            String kind = p.mimeType.startsWith("video") ? "VIDEO" : "FOTO";
            if (p.mimeType.startsWith("image/")) {
                row.addView(PhotoGallery.pendingThumbnail(this, p.uri, p.displayName),
                        new LinearLayout.LayoutParams(dp(58), dp(58)));
            }
            TextView tv = text(kind + "  ·  " + p.displayName, 13, false, design.text);
            row.addView(tv, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));
            Button remove = miniButton("Entfernen", design.danger);
            remove.setOnClickListener(v -> {
                pendingAttachments.remove(index);
                renderPendingAttachments();
            });
            row.addView(remove);
            attachmentList.addView(row);
        }
    }

    private void showPhotos() {
        setActiveNav(navPhotos);
        content.removeAllViews();
        ScrollView scroll = new ScrollView(this);
        scroll.setId(R.id.photos_scroll);
        LinearLayout body = new LinearLayout(this);
        body.setOrientation(LinearLayout.VERTICAL);
        body.setPadding(dp(2), dp(4), dp(2), dp(24));
        body.setFocusableInTouchMode(true);
        scroll.addView(body);
        body.addView(text("Auftragsfotos", 20, true, design.text));
        TextView hint = text("Öffne die Galerie eines Auftrags auf diesem Handy oder suche einen Auftrag von crazybatto.de.", 14, false, design.muted);
        hint.setPadding(0, dp(4), 0, dp(12));
        body.addView(hint);
        addRecentPhotoOrders(body);

        body.addView(sectionTitle("Auftrag suchen"));
        body.addView(label("Auftragsnummer"));
        EditText order = edit("Auftragsnummer eingeben", InputType.TYPE_CLASS_TEXT);
        body.addView(order, fieldLp());
        body.addView(label("Artikelnummer"));
        EditText article = edit("Leer lassen bei Aufträgen ohne Artikelnummer", InputType.TYPE_CLASS_TEXT);
        body.addView(article, fieldLp());
        photoSearchOrder = order;
        photoSearchArticle = article;
        Button find = actionButton("Fotos anzeigen", true);
        LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, dp(48));
        params.topMargin = dp(10);
        body.addView(find, params);
        find.setOnClickListener(v -> {
            String number = order.getText().toString().trim();
            if (number.isEmpty()) {
                order.setError("Bitte die Auftragsnummer eingeben.");
                order.requestFocus();
                return;
            }
            PhotoGallery.openOrder(this, db, article.getText().toString().trim(), number);
        });
        content.addView(scroll);
    }

    private void addRecentPhotoOrders(LinearLayout body) {
        String sql = "SELECT order_number, article_number, MAX(active) AS running, MAX(ts) AS last_used " +
                "FROM (SELECT order_number, article_number, 0 AS active, timestamp AS ts FROM entries " +
                "UNION ALL SELECT order_number, article_number, 1 AS active, started_at AS ts FROM active_job) " +
                "GROUP BY order_number, article_number ORDER BY running DESC, last_used DESC, order_number, article_number LIMIT 6";
        try (Cursor orders = db.getReadableDatabase().rawQuery(sql, null)) {
            if (!orders.moveToFirst()) return;
            body.addView(sectionTitle("Zuletzt auf diesem Handy"));
            do {
                String order = orders.getString(0);
                String article = orders.getString(1);
                String title = (orders.getInt(2) != 0 ? "Aktiv · Auftrag " : "Auftrag ") + order;
                Button open = actionButton(title + (article.isEmpty() ? "" : " · Artikel " + article), false);
                LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
                params.bottomMargin = dp(4);
                open.setMinHeight(dp(46));
                body.addView(open, params);
                open.setOnClickListener(v -> PhotoGallery.openOrder(this, db, article, order));
            } while (orders.moveToNext());
        }
    }

    private void showHistory() {
        showHistory(null);
    }

    private void showHistory(Bundle previousFilters) {
        setActiveNav(navHistory);
        content.removeAllViews();

        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);

        TextView heading = text("Verlauf", 20, true, design.text);
        root.addView(heading);
        TextView sub = text("Nach Auftragsnummer, Artikelnummer, Datum, Roboter oder Schicht suchen.", 13, false, design.muted);
        sub.setPadding(0, dp(3), 0, dp(10));
        root.addView(sub);

        LinearLayout filters = new LinearLayout(this);
        filters.setOrientation(LinearLayout.HORIZONTAL);
        Spinner robotFilter = spinner(new String[]{
                "Alle Roboter", "Roboter 1", "Roboter 2", "Roboter 3", "Roboter 4",
                "Roboter 5", "Roboter 6", "Roboter 7", "Roboter 8"});
        Spinner shiftFilter = spinner(new String[]{"Alle Schichten", ShiftUtils.EARLY, ShiftUtils.LATE, ShiftUtils.NIGHT});
        robotFilter.setId(R.id.history_robot);
        shiftFilter.setId(R.id.history_shift);
        filters.addView(robotFilter, weightParams());
        LinearLayout.LayoutParams slp = weightParams();
        slp.leftMargin = dp(8);
        filters.addView(shiftFilter, slp);
        root.addView(filters);

        EditText search = edit("Auftragsnummer / Artikelnummer / Programm / Notiz", InputType.TYPE_CLASS_TEXT);
        search.setId(R.id.history_search);
        LinearLayout.LayoutParams searchLp = fieldLp();
        searchLp.topMargin = dp(8);
        root.addView(search, searchLp);

        EditText dateSearch = edit("Datum: TT.MM.JJJJ oder JJJJ-MM-TT", InputType.TYPE_CLASS_TEXT);
        dateSearch.setId(R.id.history_date);
        LinearLayout.LayoutParams dateLp = fieldLp();
        dateLp.topMargin = dp(6);
        root.addView(dateSearch, dateLp);

        LinearLayout actions = new LinearLayout(this);
        actions.setOrientation(LinearLayout.HORIZONTAL);
        Button filterButton = actionButton("Filtern", false);
        Button exportButton = actionButton("CSV exportieren", false);
        actions.addView(filterButton, weightParams());
        LinearLayout.LayoutParams expLp = weightParams();
        expLp.leftMargin = dp(8);
        actions.addView(exportButton, expLp);
        root.addView(actions);

        ListView list = new ListView(this);
        list.setId(R.id.history_list);
        list.setDivider(null);
        list.setCacheColorHint(Color.TRANSPARENT);
        LinearLayout.LayoutParams listLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f);
        listLp.topMargin = dp(6);
        root.addView(list, listLp);

        if (previousFilters != null) {
            robotFilter.setSelection(previousFilters.getInt("robot", 0));
            String shift = previousFilters.getString("shift");
            for (int i = 1; i < shiftFilter.getCount(); i++) {
                if (shiftFilter.getItemAtPosition(i).equals(shift)) shiftFilter.setSelection(i);
            }
            search.setText(previousFilters.getString("query", ""));
            dateSearch.setText(previousFilters.getString("date", ""));
        }
        Runnable reload = () -> {
            Long dateStart = null;
            Long dateEnd = null;
            String dateRaw = dateSearch.getText().toString().trim();
            if (!dateRaw.isEmpty()) {
                long[] range = parseDateRange(dateRaw);
                if (range == null) {
                    dateSearch.setError("Datum bitte als TT.MM.JJJJ oder JJJJ-MM-TT eingeben");
                    dateSearch.requestFocus();
                    return;
                }
                dateStart = range[0];
                dateEnd = range[1];
            }
            currentRobotFilter = robotFilter.getSelectedItemPosition() == 0 ? null : robotFilter.getSelectedItemPosition();
            currentShiftFilter = shiftFilter.getSelectedItemPosition() == 0 ? null : shiftFilter.getSelectedItem().toString();
            currentSearch = search.getText().toString().trim();
            currentHistoryDate = dateRaw;
            currentHistoryRecords = db.getRecords(currentRobotFilter, currentShiftFilter, currentSearch, dateStart, dateEnd);
            list.setAdapter(new RecordAdapter(this, currentHistoryRecords));
            if (currentHistoryRecords.isEmpty()) {
                Toast.makeText(this, "Keine passenden Einträge gefunden.", Toast.LENGTH_SHORT).show();
            }
        };

        filterButton.setOnClickListener(v -> reload.run());
        exportButton.setOnClickListener(v -> {
            if (currentHistoryRecords.isEmpty()) {
                Toast.makeText(this, "Keine Einträge zum Exportieren.", Toast.LENGTH_SHORT).show();
            } else {
                startCsvExport();
            }
        });
        list.setOnItemClickListener((parent, view, position, id) -> showRecordDetails(currentHistoryRecords.get(position)));

        content.addView(root);
        reload.run();
    }

    private void showRecordDetails(Record r) {
        ScrollView scroll = new ScrollView(this);
        LinearLayout box = new LinearLayout(this);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(18), dp(8), dp(18), dp(8));
        scroll.addView(box);

        box.addView(detailLine("Roboter", "Roboter " + r.robot));
        box.addView(detailLine("Auftragsnummer", r.orderNumber));
        if (r.personnelNumber != null && !r.personnelNumber.isEmpty()) {
            box.addView(detailLine("Personalnummer", r.personnelNumber));
        }
        box.addView(detailLine("Artikelnummer", emptyDash(r.articleNumber)));
        box.addView(detailLine("Programm", emptyDash(r.programInfo)));
        box.addView(detailLine("Teile fehlen", emptyDash(r.missingParts)));
        box.addView(detailLine("Produktionsmenge", String.valueOf(r.quantity)));
        box.addView(detailLine("Zeit", ShiftUtils.formatDateTime(r.timestamp)));
        box.addView(detailLine("Schicht", r.shift));
        box.addView(detailLine("Ereignis", r.eventType + (r.important ? " · WICHTIG" : "")));
        box.addView(detailLine("Typ", (r.source == null || r.source.isEmpty()) ? "Eintrag" : r.source));
        if (r.startedAt > 0) {
            box.addView(detailLine("Auftrag gestartet", ShiftUtils.formatDateTime(r.startedAt)));
        }
        if (r.endedAt > 0) {
            box.addView(detailLine("Auftrag beendet", ShiftUtils.formatDateTime(r.endedAt)));
            box.addView(detailLine("Dauer", durationText(r.startedAt, r.endedAt)));
        }
        box.addView(detailLine("Notiz", (r.note == null || r.note.isEmpty()) ? "—" : r.note));
        box.addView(detailLine("Schichtübergabe", (r.handoverNote == null || r.handoverNote.isEmpty()) ? "—" : r.handoverNote));

        addPhotoSection(box, r, false);
        List<Attachment> attachments = db.getAttachments(r.id);
        attachments.removeIf(a -> a.mimeType.startsWith("image/"));
        if (!attachments.isEmpty()) {
            TextView mediaTitle = text("Weitere Anhänge", 14, true, design.text);
            mediaTitle.setPadding(0, dp(12), 0, dp(4));
            box.addView(mediaTitle);
            for (Attachment a : attachments) {
                Button open = new Button(this);
                open.setText(a.displayName);
                open.setAllCaps(false);
                open.setOnClickListener(v -> openAttachment(a));
                box.addView(open);
            }
        }

        AlertDialog dialog = new AlertDialog.Builder(this)
                .setTitle("Eintrag #" + r.id)
                .setView(scroll)
                .setPositiveButton("Schließen", null)
                .setNegativeButton("Löschen", null)
                .create();
        dialog.setOnShowListener(d -> {
            dialog.getButton(AlertDialog.BUTTON_NEGATIVE).setTextColor(design.danger);
            dialog.getButton(AlertDialog.BUTTON_NEGATIVE).setOnClickListener(v ->
                    new AlertDialog.Builder(this)
                            .setTitle("Eintrag löschen?")
                            .setMessage("Der Eintrag wird in den Papierkorb verschoben. Seine Fotos bleiben erhalten. Bei aktivierter Synchronisierung kann er im Control Center wiederhergestellt werden.")
                            .setPositiveButton("Löschen", (d2, w) -> {
                                OrderPhotos.deleteEntry(this, db, r.id);
                                NasSync.schedule(this);
                                dialog.dismiss();
                                showHistory();
                            })
                            .setNegativeButton("Abbrechen", null)
                            .show());
        });
        dialog.show();
    }

    private void openAttachment(Attachment a) {
        try {
            Uri uri = Uri.parse(a.uri);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, a.mimeType);
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            startActivity(intent);
        } catch (Exception ex) {
            showError("Anhang kann nicht geöffnet werden", "Die Datei wurde eventuell verschoben oder der Zugriff wurde entzogen.");
        }
    }

    private void startCsvExport() {
        Intent intent = new Intent(Intent.ACTION_CREATE_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("text/csv");
        String date = new SimpleDateFormat("yyyy-MM-dd", Locale.GERMANY).format(new Date());
        intent.putExtra(Intent.EXTRA_TITLE, "Robot_SchichtLog_" + date + ".csv");
        startActivityForResult(intent, REQUEST_EXPORT_CSV);
    }

    private void exportCsvTo(Uri uri) {
        try (OutputStream os = getContentResolver().openOutputStream(uri)) {
            if (os == null) throw new IllegalStateException("Ausgabedatei konnte nicht geöffnet werden.");
            os.write(new byte[]{(byte)0xEF, (byte)0xBB, (byte)0xBF});
            StringBuilder csv = new StringBuilder();
            csv.append("ID;Datum;Uhrzeit;Schicht;Roboter;Auftragsnummer;Artikelnummer;Programm;TeileFehlen;Menge;Typ;Start;Ende;Dauer;Ereignis;Wichtig;Notiz;Schichtuebergabe;Anhaenge;Personalnummer\r\n");
            for (Record r : currentHistoryRecords) {
                csv.append(r.id).append(';')
                        .append(csv(ShiftUtils.formatDate(r.timestamp))).append(';')
                        .append(csv(ShiftUtils.formatTime(r.timestamp))).append(';')
                        .append(csv(r.shift)).append(';')
                        .append(r.robot).append(';')
                        .append(csv(r.orderNumber)).append(';')
                        .append(csv(r.articleNumber)).append(';')
                        .append(csv(r.programInfo)).append(';')
                        .append(csv(r.missingParts)).append(';')
                        .append(r.quantity).append(';')
                        .append(csv(r.source)).append(';')
                        .append(csv(r.startedAt > 0 ? ShiftUtils.formatDateTime(r.startedAt) : "")).append(';')
                        .append(csv(r.endedAt > 0 ? ShiftUtils.formatDateTime(r.endedAt) : "")).append(';')
                        .append(csv(r.startedAt > 0 && r.endedAt > 0 ? durationText(r.startedAt, r.endedAt) : "")).append(';')
                        .append(csv(r.eventType)).append(';')
                        .append(r.important ? "Ja" : "Nein").append(';')
                        .append(csv(r.note)).append(';')
                        .append(csv(r.handoverNote)).append(';')
                        .append(r.attachmentCount).append(';')
                        .append(csv(r.personnelNumber))
                        .append("\r\n");
            }
            os.write(csv.toString().getBytes(StandardCharsets.UTF_8));
            Toast.makeText(this, "CSV wurde gespeichert.", Toast.LENGTH_LONG).show();
        } catch (Exception ex) {
            showError("CSV-Export fehlgeschlagen", ex.getMessage());
        }
    }

    private String csv(String s) {
        if (s == null) s = "";
        return "\"" + s.replace("\"", "\"\"").replace("\r", " ").replace("\n", " ") + "\"";
    }

    private long[] parseDateRange(String value) {
        String[] patterns = {"dd.MM.yyyy", "yyyy-MM-dd"};
        for (String pattern : patterns) {
            try {
                SimpleDateFormat sdf = new SimpleDateFormat(pattern, Locale.GERMANY);
                sdf.setLenient(false);
                Date parsed = sdf.parse(value);
                if (parsed == null) continue;
                Calendar start = Calendar.getInstance(Locale.GERMANY);
                start.setTime(parsed);
                start.set(Calendar.HOUR_OF_DAY, 0);
                start.set(Calendar.MINUTE, 0);
                start.set(Calendar.SECOND, 0);
                start.set(Calendar.MILLISECOND, 0);
                Calendar end = (Calendar) start.clone();
                end.add(Calendar.DAY_OF_MONTH, 1);
                return new long[]{start.getTimeInMillis(), end.getTimeInMillis()};
            } catch (Exception ignored) {}
        }
        return null;
    }

    private String emptyDash(String value) {
        return value == null || value.trim().isEmpty() ? "—" : value;
    }

    private void showStats() {
        setActiveNav(navStats);
        content.removeAllViews();
        long now = System.currentTimeMillis();
        long todayStart = ShiftUtils.startOfToday(now);
        long todayEnd = ShiftUtils.endOfToday(now);
        long[] shiftWindow = ShiftUtils.currentShiftWindow(now);

        Stats today = db.getStats(todayStart, todayEnd);
        Stats currentShift = db.getStats(shiftWindow[0], shiftWindow[1]);

        ScrollView scroll = new ScrollView(this);
        scroll.setId(R.id.stats_scroll);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(2), dp(4), dp(2), dp(30));
        scroll.addView(root);

        root.addView(text("Auswertung", 20, true, design.text));
        TextView sub = text("Lokale Übersicht deiner gespeicherten Produktionsdaten.", 13, false, design.muted);
        sub.setPadding(0, dp(3), 0, dp(10));
        root.addView(sub);

        root.addView(statCard("Aktuelle Schicht", ShiftUtils.getShift(now),
                "Menge: " + currentShift.totalQuantity + "  ·  Einträge: " + currentShift.count +
                        "  ·  Wichtig: " + currentShift.importantCount));
        root.addView(statCard("Heute", ShiftUtils.formatDate(now),
                "Menge: " + today.totalQuantity + "  ·  Einträge: " + today.count +
                        "  ·  Wichtig: " + today.importantCount));

        root.addView(sectionTitle("Heute nach Schicht"));
        root.addView(statCard(ShiftUtils.EARLY, String.valueOf(today.byShift.getOrDefault(ShiftUtils.EARLY, 0)), "produzierte Menge"));
        root.addView(statCard(ShiftUtils.LATE, String.valueOf(today.byShift.getOrDefault(ShiftUtils.LATE, 0)), "produzierte Menge"));
        root.addView(statCard(ShiftUtils.NIGHT, String.valueOf(today.byShift.getOrDefault(ShiftUtils.NIGHT, 0)), "produzierte Menge"));

        root.addView(sectionTitle("Heute nach Roboter"));
        for (int robot = 1; robot <= 8; robot++) {
            root.addView(statCard("Roboter " + robot,
                    String.valueOf(today.byRobot.getOrDefault(robot, 0)), "produzierte Menge"));
        }

        content.addView(scroll);
    }

    private View statCard(String title, String value, String detail) {
        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(16), dp(14), dp(16), dp(14));
        card.setBackground(roundRect(design.surface, design.border, 14));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.setMargins(0, dp(5), 0, dp(5));
        card.setLayoutParams(lp);

        card.addView(text(title, 14, true, design.muted));
        TextView v = text(value, 24, true, design.text);
        v.setPadding(0, dp(3), 0, dp(2));
        card.addView(v);
        card.addView(text(detail, 13, false, design.accent));
        return card;
    }

    private TextView sectionTitle(String value) {
        TextView t = text(value, 16, true, design.text);
        t.setPadding(0, dp(16), 0, dp(5));
        return t;
    }

    private TextView detailLine(String key, String value) {
        TextView tv = new TextView(this);
        tv.setText(key + "\n" + value);
        tv.setTextColor(design.text);
        tv.setTextSize(15);
        tv.setPadding(0, dp(8), 0, dp(8));
        return tv;
    }

    private void setActiveNav(Button active) {
        selectedScreen = active == navHistory ? "verlauf" : active == navStats ? "auswertung"
                : active == navPhotos ? "fotos" : active == navNew ? "eintrag" : "auftrag";
        photoSearchOrder = null;
        photoSearchArticle = null;
        if (manualForm && !savingMedia && active != navNew) {
            parkedDraft = new Bundle();
            saveDraft(parkedDraft);
        }
        manualForm = navNew == active;
        visiblePhotoSection = null;
        visiblePhotoOrder = null;
        styleNav(navJob, navJob == active);
        styleNav(navNew, navNew == active);
        styleNav(navHistory, navHistory == active);
        styleNav(navPhotos, navPhotos == active);
        styleNav(navStats, navStats == active);
    }

    private void styleNav(Button button, boolean active) {
        int ink = active ? design.accent : design.onNav;
        button.setTextColor(ink);
        button.setCompoundDrawableTintList(android.content.res.ColorStateList.valueOf(ink));
        button.setSelected(active);
        button.setBackgroundColor(design.nav);
    }

    private Button navButton(String label, int icon) {
        Button b = new Button(this);
        b.setText(label);
        b.setTextSize(11);
        b.setAllCaps(false);
        b.setMinHeight(0);
        b.setMinimumHeight(0);
        b.setPadding(dp(1), dp(7), dp(1), dp(5));
        Drawable symbol = getDrawable(icon).mutate();
        symbol.setBounds(0, 0, dp(22), dp(22));
        b.setCompoundDrawables(null, symbol, null, null);
        b.setCompoundDrawablePadding(dp(2));
        b.setMinHeight(dp(52));
        return b;
    }

    private Button actionButton(String label, boolean primary) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextSize(primary ? 15 : 13);
        b.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        b.setTextColor(primary ? design.onAccent : design.text);
        b.setMinHeight(0);
        b.setMinimumHeight(0);
        b.setBackground(roundRect(primary ? design.accent : design.surface, primary ? design.accent : design.border, 10));
        return b;
    }

    private Button miniButton(String label, int color) {
        Button b = new Button(this);
        b.setText(label);
        b.setAllCaps(false);
        b.setTextSize(11);
        b.setTextColor(color);
        b.setMinHeight(0);
        b.setMinimumHeight(0);
        b.setPadding(dp(8), dp(4), dp(8), dp(4));
        b.setBackground(roundRect(design.surfaceAlt, design.border, 8));
        return b;
    }

    private TextView label(String value) {
        TextView tv = text(value, 13, true, design.muted);
        tv.setPadding(dp(3), dp(10), 0, dp(5));
        return tv;
    }

    private EditText edit(String hint, int inputType) {
        EditText e = new EditText(this);
        e.setHint(hint);
        e.setHintTextColor(design.muted);
        e.setTextColor(design.text);
        e.setTextSize(15);
        e.setSingleLine((inputType & InputType.TYPE_TEXT_FLAG_MULTI_LINE) == 0);
        e.setInputType(inputType);
        e.setPadding(dp(13), dp(10), dp(13), dp(10));
        e.setBackground(roundRect(design.surface, design.border, 12));
        return e;
    }

    private Spinner spinner(String[] values) {
        Spinner s = new Spinner(this);
        DesignSpinnerAdapter adapter = new DesignSpinnerAdapter(this, values);
        s.setAdapter(adapter);
        s.setPadding(dp(8), dp(4), dp(8), dp(4));
        s.setBackground(roundRect(design.surface, design.border, 12));
        return s;
    }

    private LinearLayout cardRow() {
        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(12), dp(8), dp(8), dp(8));
        row.setBackground(roundRect(design.surface, design.border, 10));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.setMargins(0, dp(3), 0, dp(3));
        row.setLayoutParams(lp);
        return row;
    }

    private LinearLayout.LayoutParams fieldLp() {
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, dp(52));
        lp.bottomMargin = dp(2);
        return lp;
    }

    private LinearLayout.LayoutParams weightParams() {
        return new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f);
    }

    private GradientDrawable roundRect(int fill, int stroke, int radiusDp) {
        GradientDrawable gd = new GradientDrawable();
        gd.setColor(fill);
        gd.setCornerRadius(dp(radiusDp));
        gd.setStroke(dp(1), stroke);
        return gd;
    }

    private TextView text(String value, int sp, boolean bold, int color) {
        TextView tv = new TextView(this);
        tv.setText(value);
        tv.setTextSize(sp);
        tv.setTextColor(color);
        if (bold) tv.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return tv;
    }

    private String resolveDisplayName(Uri uri) {
        String result = "Anhang";
        if (ContentResolver.SCHEME_CONTENT.equals(uri.getScheme())) {
            try (Cursor cursor = getContentResolver().query(uri, null, null, null, null)) {
                if (cursor != null && cursor.moveToFirst()) {
                    int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                    if (index >= 0) result = cursor.getString(index);
                }
            } catch (Exception ignored) {}
        }
        if ((result == null || result.equals("Anhang")) && uri.getLastPathSegment() != null) {
            result = uri.getLastPathSegment();
        }
        return result == null ? "Anhang" : result;
    }

    private String durationText(long start, long end) {
        long mins = Math.max(0, (end - start) / 60000L);
        long hours = mins / 60;
        long rest = mins % 60;
        if (hours > 0) return hours + " Std. " + rest + " Min.";
        return rest + " Min.";
    }

    private void showError(String title, String message) {
        new AlertDialog.Builder(this)
                .setTitle(title)
                .setMessage(message == null || message.isEmpty() ? "Unbekannter Fehler" : message)
                .setPositiveButton("OK", null)
                .show();
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }

    private static final class PendingAttachment {
        final Uri uri;
        final String mimeType;
        final String displayName;
        PendingAttachment(Uri uri, String mimeType, String displayName) {
            this.uri = uri;
            this.mimeType = mimeType;
            this.displayName = displayName;
        }
    }

    private final class DesignSpinnerAdapter extends ArrayAdapter<String> {
        DesignSpinnerAdapter(Context context, String[] values) {
            super(context, android.R.layout.simple_spinner_item, values);
            setDropDownViewResource(android.R.layout.simple_spinner_dropdown_item);
        }

        @Override
        public View getView(int position, View convertView, ViewGroup parent) {
            View v = super.getView(position, convertView, parent);
            if (v instanceof TextView) {
                TextView tv = (TextView) v;
                tv.setTextColor(design.text);
                tv.setTextSize(14);
                tv.setPadding(8, 0, 8, 0);
            }
            return v;
        }

        @Override
        public View getDropDownView(int position, View convertView, ViewGroup parent) {
            View v = super.getDropDownView(position, convertView, parent);
            if (v instanceof TextView) {
                TextView tv = (TextView) v;
                tv.setTextColor(design.text);
                tv.setBackgroundColor(design.surface);
                tv.setTextSize(14);
                tv.setPadding(18, 18, 18, 18);
            }
            return v;
        }
    }
}
