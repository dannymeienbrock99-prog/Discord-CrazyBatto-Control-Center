package de.crazybatto.robotschichtlog;

import android.app.Activity;
import android.app.AlertDialog;
import android.graphics.Typeface;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;

/** Observes uploads without rebuilding forms or retaining an Activity in a worker. */
final class ServerUploadUi {
    private static final String SAVE_HINT = "Übertragen werden gespeicherte Aufträge und Bilder. "
            + "Aktuelle Angaben zuerst als Zwischenstand speichern. Der Auftrag bleibt offen.";
    private final Activity activity;
    private final AppDesign design;
    private final TextView summary;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean observing;
    private AlertDialog dialog;
    private AlertDialog enableDialog;
    private TextView title;
    private TextView details;
    private ProgressBar progress;
    private final Runnable refresh = new Runnable() {
        @Override public void run() {
            if (!observing || activity.isDestroyed()) return;
            render(ServerUpload.snapshot(activity));
            handler.postDelayed(this, 1000);
        }
    };

    ServerUploadUi(Activity activity, AppDesign design, Button button, TextView summary) {
        this.activity = activity;
        this.design = design;
        this.summary = summary;
        button.setOnClickListener(v -> open());
        render(ServerUpload.snapshot(activity));
    }

    void startObserving() {
        stopObserving();
        observing = true;
        handler.post(refresh);
    }

    void stopObserving() {
        observing = false;
        handler.removeCallbacks(refresh);
    }

    void destroy() {
        stopObserving();
        if (dialog != null) dialog.dismiss();
        if (enableDialog != null) enableDialog.dismiss();
    }

    private void open() {
        ServerUpload.Snapshot state = ServerUpload.snapshot(activity);
        if (state.busy || state.needsSetup) showProgress();
        else if (state.needsEnable) confirmEnable();
        else {
            ServerUpload.start(activity, false);
            showProgress();
        }
    }

    private void confirmEnable() {
        if (enableDialog != null && enableDialog.isShowing()) return;
        enableDialog = new AlertDialog.Builder(activity)
                .setTitle("Aufträge zum Server hochladen")
                .setMessage("Die Auftragsübertragung ist auf diesem Handy ausgeschaltet. "
                        + "Mit dem Aktivieren werden gespeicherte Aufträge mit dem Control Center abgeglichen.\n\n"
                        + SAVE_HINT)
                .setNegativeButton("Abbrechen", null)
                .setPositiveButton("Aktivieren und hochladen", (d, which) -> {
                    ServerUpload.start(activity, true);
                    showProgress();
                }).create();
        enableDialog.setOnDismissListener(d -> enableDialog = null);
        enableDialog.show();
    }

    private void showProgress() {
        if (dialog != null && dialog.isShowing()) {
            render(ServerUpload.snapshot(activity));
            return;
        }
        LinearLayout box = new LinearLayout(activity);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(dp(24), dp(12), dp(24), dp(16));
        title = label(17, design.text);
        title.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        box.addView(title);
        progress = new ProgressBar(activity, null, android.R.attr.progressBarStyleHorizontal);
        progress.setIndeterminate(true);
        progress.setIndeterminateTintList(android.content.res.ColorStateList.valueOf(design.accent));
        LinearLayout.LayoutParams barParams = new LinearLayout.LayoutParams(-1, dp(8));
        barParams.topMargin = dp(16);
        barParams.bottomMargin = dp(12);
        box.addView(progress, barParams);
        details = label(14, design.text);
        details.setId(R.id.server_upload_details);
        box.addView(details);
        TextView hint = label(13, design.muted);
        hint.setText(SAVE_HINT + "\n\nDu kannst dieses Fenster schließen; ein laufender Upload wird dadurch nicht abgebrochen.");
        hint.setPadding(0, dp(20), 0, 0);
        box.addView(hint);
        ScrollView scroll = new ScrollView(activity);
        scroll.addView(box);
        dialog = new AlertDialog.Builder(activity)
                .setTitle("Server-Upload")
                .setView(scroll)
                .setNegativeButton("Schließen", null)
                .setPositiveButton("Erneut hochladen", null).create();
        dialog.setOnDismissListener(d -> { dialog = null; title = null; details = null; progress = null; });
        dialog.show();
        dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> {
            ServerUpload.Snapshot state = ServerUpload.snapshot(activity);
            if (state.busy) return;
            if (state.needsSetup) {
                dialog.dismiss();
                NasSync.showSettings(activity);
            } else if (state.needsEnable) {
                dialog.dismiss();
                confirmEnable();
            } else {
                ServerUpload.start(activity, false);
                render(ServerUpload.snapshot(activity));
            }
        });
        render(ServerUpload.snapshot(activity));
    }

    private void render(ServerUpload.Snapshot state) {
        String value = state.title;
        if (!value.contentEquals(summary.getText())) summary.setText(value);
        summary.setContentDescription(state.title + ". " + state.details);
        summary.setTextColor(state.busy || state.success ? design.accent : design.muted);
        if (dialog == null || !dialog.isShowing()) return;
        if (!state.title.contentEquals(title.getText())) title.setText(state.title);
        if (!state.details.contentEquals(details.getText())) details.setText(state.details);
        progress.setVisibility(state.busy ? View.VISIBLE : View.GONE);
        Button action = dialog.getButton(AlertDialog.BUTTON_POSITIVE);
        action.setEnabled(!state.busy);
        action.setText(state.busy ? "Upload läuft …" : state.needsSetup ? "Verbindung einrichten"
                : state.needsEnable ? "Übertragung aktivieren" : "Erneut hochladen");
    }

    private TextView label(int size, int color) {
        TextView view = new TextView(activity);
        view.setTextSize(size);
        view.setTextColor(color);
        return view;
    }

    private int dp(int value) { return Math.round(value * activity.getResources().getDisplayMetrics().density); }
}
