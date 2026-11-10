package de.crazybatto.robotschichtlog;

import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

final class OrderDesignHeader {
    private final Context context;
    private final AppDesign theme;
    private final ActiveJob job;
    private TextView shiftLabel;
    private TextView startLabel;
    private final long now;

    static void addTo(Context context, LinearLayout parent, ActiveJob job, long now) {
        new OrderDesignHeader(context, job, now).render(parent);
    }

    private OrderDesignHeader(Context context, ActiveJob job, long now) {
        this.context = context;
        this.job = job;
        this.now = now;
        this.theme = AppDesign.current(context);
    }

    private void render(LinearLayout parent) {
        if (theme == AppDesign.SCHWEISSLICHT) {
            addWeldingHero(parent);
        } else if (theme == AppDesign.WERKSTATT) {
            addWorkshopTitle(parent);
            parent.addView(image(), matchWidth(imageHeight(0.70f)));
        } else {
            parent.addView(image(), matchWidth(imageHeight(0.88f)));
            addBlueprintTitle(parent);
        }
        if (job == null) {
            bindClock();
            return;
        }

        if (theme == AppDesign.CAD) {
            rule(parent);
            LinearLayout columns = new LinearLayout(context);
            columns.setPadding(0, dp(8), 0, dp(8));
            metadataColumn(columns, "Artikelnummer", job.articleNumber);
            View split = new View(context);
            split.setBackgroundColor(theme.border);
            columns.addView(split, new LinearLayout.LayoutParams(dp(1), ViewGroup.LayoutParams.MATCH_PARENT));
            metadataColumn(columns, personnelLabel(), job.personnelNumber);
            parent.addView(columns);
            rule(parent);
        } else {
            metadataRow(parent, "Artikelnummer", job.articleNumber);
            metadataRow(parent, personnelLabel(), job.personnelNumber);
        }
        startLabel = text("", 13, false, theme.muted);
        startLabel.setPadding(dp(3), dp(8), dp(3), dp(2));
        parent.addView(startLabel);
        if (job.programInfo != null && !job.programInfo.isEmpty()) {
            TextView program = text("Programm " + job.programInfo, 14, false, theme.text);
            program.setPadding(dp(3), 0, dp(3), dp(4));
            parent.addView(program);
        }
        bindClock();
    }

    private String personnelLabel() {
        return job.paused ? "Letzte Personalnummer" : "Personalnummer";
    }

    private void addWeldingHero(LinearLayout parent) {
        FrameLayout hero = new FrameLayout(context);
        int height = dp(imageHeight(0.93f));
        hero.setMinimumHeight(height);
        hero.setBackgroundColor(theme.bg);
        hero.addView(image(), new FrameLayout.LayoutParams(-1, height));
        View scrim = new View(context);
        scrim.setBackground(new GradientDrawable(GradientDrawable.Orientation.LEFT_RIGHT,
                new int[]{0xDB06090C, 0x9A06090C, 0x1506090C}));
        hero.addView(scrim, new FrameLayout.LayoutParams(-1, -1));

        LinearLayout copy = column();
        copy.setPadding(dp(18), dp(18), dp(16), dp(24));
        shiftLabel = text("", 17, true, Color.WHITE);
        copy.addView(marker(shiftLabel));
        TextView state = text(job == null ? "Kein aktiver Auftrag" : state(), job == null ? 27 : 21, true, Color.WHITE);
        state.setPadding(0, dp(job == null ? 18 : 38), 0, dp(2));
        copy.addView(state);
        if (job != null) {
            copy.addView(orderText(Color.WHITE));
            TextView robot = text("Roboter " + job.robot, 19, false, 0xFFF2F1EE);
            copy.addView(robot);
        }
        hero.addView(copy, new FrameLayout.LayoutParams(-1, -2, Gravity.TOP | Gravity.START));
        parent.addView(hero, new LinearLayout.LayoutParams(-1, -2));
    }

    private void addWorkshopTitle(LinearLayout parent) {
        LinearLayout copy = column();
        copy.setPadding(dp(2), dp(8), dp(2), dp(12));
        if (job == null) {
            copy.addView(text("Kein aktiver Auftrag", 27, true, theme.text));
        } else {
            copy.addView(orderText(theme.text));
            TextView badge = text(state(), 16, true, theme.accent);
            badge.setPadding(dp(9), dp(3), dp(9), dp(3));
            GradientDrawable fill = new GradientDrawable();
            fill.setColor(theme.surfaceAlt);
            fill.setCornerRadius(dp(7));
            badge.setBackground(fill);
            copy.addView(badge, new LinearLayout.LayoutParams(-2, -2));
        }
        shiftLabel = text("", 17, false, theme.text);
        shiftLabel.setPadding(0, dp(5), 0, 0);
        copy.addView(shiftLabel);
        parent.addView(copy);
    }

    private void addBlueprintTitle(LinearLayout parent) {
        LinearLayout copy = column();
        copy.setPadding(dp(4), dp(12), dp(4), dp(12));
        copy.addView(marker(text(job == null ? "Kein aktiver Auftrag" : state(), job == null ? 23 : 18, true, theme.text)));
        if (job != null) copy.addView(orderText(theme.text));
        shiftLabel = text("", 17, false, theme.text);
        shiftLabel.setPadding(0, dp(3), 0, 0);
        copy.addView(shiftLabel);
        parent.addView(copy);
    }

    private TextView orderText(int color) {
        // Long real order numbers can wrap; they are never clipped to a fixture width.
        int size = job.orderNumber.length() <= 10 ? 44 : 32;
        TextView label = text(job.orderNumber, size, true, color);
        label.setLetterSpacing(-0.035f);
        return label;
    }

    private void bindClock() {
        refreshClock(now);
        Runnable update = new Runnable() {
            @Override public void run() {
                long time = System.currentTimeMillis();
                refreshClock(time);
                shiftLabel.postDelayed(this, 60_000 - time % 60_000);
            }
        };
        shiftLabel.addOnAttachStateChangeListener(new View.OnAttachStateChangeListener() {
            public void onViewAttachedToWindow(View v) { update.run(); }
            public void onViewDetachedFromWindow(View v) { v.removeCallbacks(update); }
        });
        if (shiftLabel.isAttachedToWindow()) update.run();
    }

    private void refreshClock(long time) {
        String shift = ShiftUtils.getShift(time);
        shiftLabel.setText(job == null || theme == AppDesign.SCHWEISSLICHT ? shift : shift + " · Roboter " + job.robot);
        if (startLabel != null) {
            String since = "Start " + ShiftUtils.formatDateTime(job.startedAt) + " · " + duration(job.startedAt, time);
            if (job.startShift != null && !job.startShift.equals(shift)) since += " · " + job.startShift;
            startLabel.setText(since);
        }
    }

    private String state() {
        return job.paused ? "Auftrag unterbrochen" : "Aktiver Auftrag";
    }

    private LinearLayout marker(TextView label) {
        LinearLayout row = new LinearLayout(context);
        row.setGravity(Gravity.CENTER_VERTICAL);
        View accent = new View(context);
        accent.setBackgroundColor(theme.accent);
        LinearLayout.LayoutParams line = new LinearLayout.LayoutParams(dp(4), dp(18));
        line.rightMargin = dp(8);
        row.addView(accent, line);
        row.addView(label);
        return row;
    }

    private void metadataRow(LinearLayout parent, String label, String value) {
        LinearLayout row = new LinearLayout(context);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(theme.dark ? 12 : 2), dp(9), dp(theme.dark ? 12 : 2), dp(9));
        if (theme.dark) {
            GradientDrawable panel = new GradientDrawable();
            panel.setColor(theme.surface);
            panel.setStroke(dp(1), theme.border);
            panel.setCornerRadius(dp(8));
            row.setBackground(panel);
        }
        row.addView(text(label, 15, false, theme.text), new LinearLayout.LayoutParams(0, -2, 1));
        TextView data = text(valueOrDash(value), 17, true, theme.text);
        data.setGravity(Gravity.END);
        row.addView(data, new LinearLayout.LayoutParams(0, -2, 1));
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(-1, -2);
        if (theme.dark) lp.topMargin = dp(6);
        parent.addView(row, lp);
        if (!theme.dark) rule(parent);
    }

    private void metadataColumn(LinearLayout row, String label, String value) {
        LinearLayout stack = column();
        stack.setPadding(dp(8), 0, dp(8), 0);
        stack.addView(text(label, 13, false, theme.muted));
        stack.addView(text(valueOrDash(value), 20, true, theme.text));
        row.addView(stack, new LinearLayout.LayoutParams(0, -2, 1));
    }

    private ImageView image() {
        ImageView view = new ImageView(context);
        view.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO);
        view.setScaleType(ImageView.ScaleType.CENTER_CROP);
        view.setImageResource(theme.hero);
        return view;
    }

    private int imageHeight(float ratio) {
        int width = context.getResources().getConfiguration().screenWidthDp;
        int height = Math.round(Math.max(280, width) * ratio);
        int screenHeight = context.getResources().getConfiguration().screenHeightDp;
        if (job == null) return Math.min(screenHeight > width ? 142 : 100, height);
        return Math.min(Math.max(174, (int) (screenHeight * 0.46f)), Math.min(360, height));
    }

    private LinearLayout.LayoutParams matchWidth(int heightDp) {
        return new LinearLayout.LayoutParams(-1, dp(heightDp));
    }

    private void rule(LinearLayout parent) {
        View divider = new View(context);
        divider.setBackgroundColor(theme.border);
        parent.addView(divider, new LinearLayout.LayoutParams(-1, dp(1)));
    }

    private LinearLayout column() {
        LinearLayout group = new LinearLayout(context);
        group.setOrientation(LinearLayout.VERTICAL);
        return group;
    }

    private TextView text(String value, int size, boolean bold, int color) {
        TextView view = new TextView(context);
        view.setText(value);
        view.setTextSize(size);
        view.setTextColor(color);
        if (bold) view.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        view.setIncludeFontPadding(false);
        return view;
    }

    private String valueOrDash(String value) {
        return value == null || value.trim().isEmpty() ? "—" : value;
    }

    private String duration(long start, long end) {
        long minutes = Math.max(0L, (end - start) / 60000L);
        return minutes >= 60 ? (minutes / 60) + " h " + (minutes % 60) + " min" : minutes + " min";
    }

    private int dp(int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }
}

