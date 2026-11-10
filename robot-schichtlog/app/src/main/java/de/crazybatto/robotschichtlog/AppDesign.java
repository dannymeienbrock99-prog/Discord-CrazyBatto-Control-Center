package de.crazybatto.robotschichtlog;

import android.app.Activity;
import android.app.Dialog;
import android.content.Context;
import android.content.res.ColorStateList;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.view.Gravity;
import android.view.View;
import android.view.Window;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.RadioButton;
import android.widget.RadioGroup;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;

/** Per-device appearance. All fields are fully opaque colors except the drawable resource IDs. */
public final class AppDesign {
    private static final String PREFERENCES = "robot-display";
    private static final String SELECTED = "selected-design";

    public static final AppDesign SCHWEISSLICHT = new AppDesign(
            "schweisslicht", "Schweißlicht", true, R.drawable.hero_schweisslicht, R.drawable.preview_schweisslicht,
            0xFF121517, 0xFF1C2023, 0xFF282D30, 0xFF676D70, 0xFFF6F4EF, 0xFFBABBB7,
            0xFFFF984A, 0xFF27170C, 0xFF171A1D, 0xFFE8E8E3, 0xFFFF9987, 0xFF301411);
    public static final AppDesign WERKSTATT = new AppDesign(
            "werkstatt", "Werkstatt Weiß", false, R.drawable.hero_werkstatt, R.drawable.preview_werkstatt,
            0xFFF4F1E9, 0xFFFFFEFA, 0xFFE9E7DF, 0xFF92958E, 0xFF182531, 0xFF515E69,
            0xFF2457B2, Color.WHITE, 0xFFFBF9F3, 0xFF23354B, 0xFFA32F35, Color.WHITE);
    public static final AppDesign CAD = new AppDesign(
            "cad", "CAD-Nachtschicht", true, R.drawable.hero_cad, R.drawable.preview_cad,
            0xFF0A1625, 0xFF112236, 0xFF1B3044, 0xFF587083, 0xFFEDF5F8, 0xFFB2C4CF,
            0xFF55DCCD, 0xFF06292A, 0xFF101E30, 0xFFE2EEF5, 0xFFFF9A8D, 0xFF341714);
    private static final AppDesign[] MODES = {SCHWEISSLICHT, WERKSTATT, CAD};

    public final String id, name;
    public final boolean dark;
    public final int hero, preview;
    public final int bg, surface, surfaceAlt, border, text, muted, accent, onAccent, nav, onNav, danger, onDanger;

    private AppDesign(String id, String name, boolean dark, int hero, int preview,
                      int bg, int surface, int surfaceAlt, int border, int text, int muted,
                      int accent, int onAccent, int nav, int onNav, int danger, int onDanger) {
        this.id = id;
        this.name = name;
        this.dark = dark;
        this.hero = hero;
        this.preview = preview;
        this.bg = bg;
        this.surface = surface;
        this.surfaceAlt = surfaceAlt;
        this.border = border;
        this.text = text;
        this.muted = muted;
        this.accent = accent;
        this.onAccent = onAccent;
        this.nav = nav;
        this.onNav = onNav;
        this.danger = danger;
        this.onDanger = onDanger;
    }

    public static AppDesign current(Context context) {
        String id = context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).getString(SELECTED, "");
        for (AppDesign design : MODES) if (design.id.equals(id)) return design;
        return SCHWEISSLICHT;
    }

    private boolean save(Context context) {
        return context.getSharedPreferences(PREFERENCES, Context.MODE_PRIVATE).edit().putString(SELECTED, id).commit();
    }

    /** Tapping a choice previews it inside this dialog. Only Übernehmen changes the app. */
    public static void choose(Activity activity, Runnable onChanged) {
        new Chooser(activity, onChanged).show();
    }

    private static final class Chooser {
        private final Activity activity;
        private final Runnable onChanged;
        private final Dialog dialog;
        private final LinearLayout body;
        private final TextView title;
        private final LinearLayout previewButton;
        private final TextView previewCaption;
        private final ImageView mockup;
        private final RadioGroup options;
        private final Button cancel, apply;
        private AppDesign selected;

        Chooser(Activity activity, Runnable onChanged) {
            this.activity = activity;
            this.onChanged = onChanged;
            selected = current(activity);
            dialog = new Dialog(activity);
            dialog.requestWindowFeature(Window.FEATURE_NO_TITLE);
            dialog.setTitle("Design auswählen");
            ScrollView scroll = new ScrollView(activity);
            scroll.setFillViewport(false);
            body = new LinearLayout(activity);
            body.setOrientation(LinearLayout.VERTICAL);
            int padding = dp(16);
            body.setPadding(padding, padding, padding, padding);
            scroll.addView(body);
            dialog.setContentView(scroll);
            dialog.setCanceledOnTouchOutside(true);

            title = new TextView(activity);
            title.setText("Design auswählen");
            title.setTextSize(22);
            title.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
            if (android.os.Build.VERSION.SDK_INT >= 28) title.setAccessibilityHeading(true);
            body.addView(title);

            LinearLayout previews = new LinearLayout(activity);
            int widthDp = activity.getResources().getConfiguration().screenWidthDp;
            float fontScale = activity.getResources().getConfiguration().fontScale;
            boolean wide = widthDp >= 380 && fontScale <= 1.15f;
            previews.setOrientation(wide ? LinearLayout.HORIZONTAL : LinearLayout.VERTICAL);
            previews.setGravity(Gravity.CENTER_VERTICAL);
            LinearLayout.LayoutParams previewArea = new LinearLayout.LayoutParams(-1, -2);
            previewArea.topMargin = dp(12);
            body.addView(previews, previewArea);

            previewButton = new LinearLayout(activity);
            previewButton.setOrientation(LinearLayout.VERTICAL);
            previewButton.setGravity(Gravity.CENTER);
            previewButton.setFocusable(true);
            previewButton.setOnClickListener(v -> enlarge());
            mockup = new ImageView(activity);
            mockup.setScaleType(ImageView.ScaleType.FIT_CENTER);
            mockup.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
            int height = activity.getResources().getConfiguration().screenHeightDp;
            int previewHeight = dp(Math.min(330, Math.max(150, Math.round(height * (wide ? .41f : .31f)))));
            previewButton.addView(mockup, new LinearLayout.LayoutParams(-1, previewHeight));
            previewCaption = new TextView(activity);
            previewCaption.setText("Vorschau vergrößern");
            previewCaption.setTextSize(13);
            previewCaption.setGravity(Gravity.CENTER);
            previewCaption.setPadding(dp(2), dp(4), dp(2), dp(4));
            previewCaption.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
            previewButton.addView(previewCaption);
            previews.addView(previewButton, wide ? new LinearLayout.LayoutParams(0, -2, .90f)
                    : new LinearLayout.LayoutParams(-1, -2));
            options = new RadioGroup(activity);
            options.setOrientation(RadioGroup.VERTICAL);
            LinearLayout.LayoutParams choices = wide ? new LinearLayout.LayoutParams(0,-2,1.12f)
                    : new LinearLayout.LayoutParams(-1,-2);
            if (wide) choices.setMarginStart(dp(12)); else choices.topMargin = dp(8);
            previews.addView(options, choices);

            for (AppDesign design : MODES) {
                RadioButton radio = new RadioButton(activity);
                radio.setId(View.generateViewId());
                radio.setText(design.name);
                radio.setTag(design);
                radio.setTextSize(16);
                radio.setMinHeight(dp(48));
                radio.setPaddingRelative(dp(10), dp(4), dp(8), dp(4));
                RadioGroup.LayoutParams row = new RadioGroup.LayoutParams(-1, -2);
                row.topMargin = dp(4);
                options.addView(radio, row);
                if (design == selected) radio.setChecked(true);
            }
            LinearLayout actions = new LinearLayout(activity);
            actions.setGravity(Gravity.END | Gravity.CENTER_VERTICAL);
            boolean stackActions = widthDp < 320 || (widthDp < 450 && fontScale > 1.4f);
            actions.setOrientation(stackActions ? LinearLayout.VERTICAL : LinearLayout.HORIZONTAL);
            LinearLayout.LayoutParams actionArea = new LinearLayout.LayoutParams(-1,-2);
            actionArea.topMargin = dp(14);
            body.addView(actions, actionArea);
            cancel = action("Abbrechen");
            cancel.setOnClickListener(v -> dialog.dismiss());
            actions.addView(cancel, new LinearLayout.LayoutParams(stackActions ? -1 : -2, -2));
            apply = action("Übernehmen");
            apply.setOnClickListener(v -> apply());
            LinearLayout.LayoutParams primary = new LinearLayout.LayoutParams(stackActions ? -1 : -2,-2);
            if (stackActions) primary.topMargin = dp(8); else primary.setMarginStart(dp(8));
            actions.addView(apply, primary);
            options.setOnCheckedChangeListener((group, checkedId) -> {
                RadioButton radio = group.findViewById(checkedId);
                if (radio != null) preview((AppDesign)radio.getTag());
            });
            preview(selected);
        }

        void show() {
            Window window = dialog.getWindow();
            window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            dialog.show();
            int available = Math.min(activity.getResources().getDisplayMetrics().widthPixels,
                    dp(activity.getResources().getConfiguration().screenWidthDp)) - dp(20);
            window.setLayout(Math.min(dp(560), available), WindowManager.LayoutParams.WRAP_CONTENT);
        }

        private void preview(AppDesign design) {
            selected = design;
            body.setBackground(shape(design.surface, dp(16), design.border));
            title.setTextColor(design.text);
            mockup.setImageResource(design.preview);
            previewButton.setContentDescription("Beispielansicht " + design.name + " vergrößern");
            previewButton.setBackground(ripple(design.bg, design.border, design.text));
            previewCaption.setTextColor(design.accent);
            mockup.setBackground(shape(design.bg, dp(8), design.border));
            mockup.setClipToOutline(true);
            for (int index = 0; index < options.getChildCount(); index++) {
                RadioButton radio = (RadioButton)options.getChildAt(index);
                boolean checked = radio.getTag() == design;
                radio.setTextColor(design.text);
                radio.setButtonTintList(ColorStateList.valueOf(checked ? design.accent : design.muted));
                radio.setBackground(ripple(checked ? design.surfaceAlt : design.surface,
                        checked ? design.accent : design.border, design.text));
            }
            cancel.setTextColor(design.text);
            cancel.setBackground(ripple(design.surfaceAlt, design.border, design.text));
            apply.setTextColor(design.onAccent);
            apply.setBackground(ripple(design.accent, design.accent, design.onAccent));
        }

        private void enlarge() {
            AppDesign design = selected;
            Dialog zoom = new Dialog(activity);
            zoom.requestWindowFeature(Window.FEATURE_NO_TITLE);
            zoom.setTitle(design.name + " · Vorschau");
            LinearLayout pane = new LinearLayout(activity);
            pane.setOrientation(LinearLayout.VERTICAL);
            pane.setPadding(dp(12), dp(12), dp(12), dp(12));
            pane.setBackground(shape(design.surface, dp(16), design.border));
            TextView name = new TextView(activity);
            name.setText(design.name + " · Vorschau mit Beispieldaten");
            name.setTextSize(16);
            name.setTextColor(design.text);
            pane.addView(name);
            ImageView full = new ImageView(activity);
            full.setImageResource(design.preview);
            full.setScaleType(ImageView.ScaleType.FIT_CENTER);
            full.setContentDescription("Beispielansicht " + design.name);
            LinearLayout.LayoutParams imageArea = new LinearLayout.LayoutParams(-1, 0, 1f);
            imageArea.topMargin = dp(6);
            imageArea.bottomMargin = dp(6);
            pane.addView(full, imageArea);
            Button back = action("Zurück zur Auswahl");
            back.setTextColor(design.onAccent);
            back.setBackground(ripple(design.accent, design.accent, design.onAccent));
            back.setOnClickListener(v -> zoom.dismiss());
            pane.addView(back);
            zoom.setContentView(pane);
            Window window = zoom.getWindow();
            window.setBackgroundDrawable(new ColorDrawable(Color.TRANSPARENT));
            zoom.show();
            android.content.res.Configuration config = activity.getResources().getConfiguration();
            window.setLayout(dp(Math.min(600, config.screenWidthDp - 12)), dp(config.screenHeightDp - 16));
        }

        private void apply() {
            boolean changed = current(activity) != selected;
            if (!selected.save(activity)) {
                Toast.makeText(activity, "Design konnte nicht gespeichert werden.", Toast.LENGTH_LONG).show();
                return;
            }
            dialog.dismiss();
            if (changed && onChanged != null) onChanged.run();
        }

        private Button action(String label) {
            Button button = new Button(activity);
            button.setText(label);
            button.setAllCaps(false);
            button.setTextSize(15);
            button.setMinHeight(dp(48));
            button.setPadding(dp(14), dp(6), dp(14), dp(6));
            return button;
        }

        private GradientDrawable shape(int fill, int radius, int stroke) {
            GradientDrawable drawable = new GradientDrawable();
            drawable.setColor(fill);
            drawable.setCornerRadius(radius);
            drawable.setStroke(dp(1), stroke);
            return drawable;
        }

        private RippleDrawable ripple(int fill, int border, int ink) {
            int pressed = (ink & 0x00FFFFFF) | 0x28000000;
            return new RippleDrawable(ColorStateList.valueOf(pressed), shape(fill, dp(8), border), null);
        }

        private int dp(int value) {
            return Math.round(value * activity.getResources().getDisplayMetrics().density);
        }
    }
}
