package de.crazybatto.robotschichtlog;

import android.content.Context;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.BaseAdapter;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.List;

public class RecordAdapter extends BaseAdapter {
    private final Context context;
    private final AppDesign theme;
    private final List<Record> records;

    public RecordAdapter(Context context, List<Record> records) {
        this.context = context;
        this.theme = AppDesign.current(context);
        this.records = records;
    }

    @Override public int getCount() { return records.size(); }
    @Override public Record getItem(int position) { return records.get(position); }
    @Override public long getItemId(int position) { return records.get(position).id; }

    @Override
    public View getView(int position, View convertView, ViewGroup parent) {
        Record r = getItem(position);
        LinearLayout card = new LinearLayout(context);
        card.setOrientation(LinearLayout.VERTICAL);
        int pad = dp(14);
        card.setPadding(pad, pad, pad, pad);

        GradientDrawable bg = new GradientDrawable();
        bg.setColor(theme.surface);
        bg.setCornerRadius(dp(14));
        bg.setStroke(dp(1), theme.border);
        card.setBackground(bg);

        LinearLayout.LayoutParams cardLp = new LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        cardLp.setMargins(dp(10), dp(7), dp(10), dp(7));
        card.setLayoutParams(cardLp);

        LinearLayout top = new LinearLayout(context);
        top.setOrientation(LinearLayout.HORIZONTAL);
        top.setGravity(Gravity.CENTER_VERTICAL);

        TextView title = text("Roboter " + r.robot + "  ·  Auftrag " + r.orderNumber, 16, true, theme.text);
        top.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f));

        if (r.important) {
            TextView warning = text("WICHTIG", 11, true, theme.onDanger);
            warning.setPadding(dp(8), dp(4), dp(8), dp(4));
            GradientDrawable wb = new GradientDrawable();
            wb.setColor(theme.danger);
            wb.setCornerRadius(dp(20));
            warning.setBackground(wb);
            top.addView(warning);
        }
        card.addView(top);

        String source = (r.source == null || r.source.isEmpty()) ? "Eintrag" : r.source;
        String metaText = ShiftUtils.formatDateTime(r.timestamp) + "  ·  " + r.shift + "  ·  " + source;
        if (r.personnelNumber != null && !r.personnelNumber.isEmpty()) metaText += "  ·  Pers.-Nr. " + r.personnelNumber;
        if (r.articleNumber != null && !r.articleNumber.trim().isEmpty()) metaText += "  ·  Artikel " + r.articleNumber;
        TextView meta = text(metaText, 13, false, theme.muted);
        meta.setPadding(0, dp(6), 0, 0);
        card.addView(meta);

        String lower = "Menge: " + r.quantity + "  ·  " + r.eventType;
        if (r.startedAt > 0) {
            long end = r.endedAt > 0 ? r.endedAt : r.timestamp;
            lower += "  ·  Dauer: " + durationText(r.startedAt, end);
        }
        if (r.programInfo != null && !r.programInfo.trim().isEmpty()) lower += "  ·  Programm: " + r.programInfo;
        if (r.attachmentCount > 0) lower += "  ·  Anhänge: " + r.attachmentCount;
        TextView info = text(lower, 14, false, theme.accent);
        info.setPadding(0, dp(7), 0, 0);
        card.addView(info);


        if (r.missingParts != null && !r.missingParts.trim().isEmpty()) {
            TextView missing = text("TEILE FEHLEN: " + shortText(r.missingParts), 13, true, theme.danger);
            missing.setPadding(0, dp(7), 0, 0);
            card.addView(missing);
        }

        if (r.note != null && !r.note.trim().isEmpty()) {
            TextView noteView = text(shortText(r.note), 13, false, theme.text);
            noteView.setPadding(0, dp(7), 0, 0);
            card.addView(noteView);
        }

        if (r.handoverNote != null && !r.handoverNote.trim().isEmpty()) {
            TextView handover = text("Übergabe: " + shortText(r.handoverNote), 13, true, theme.accent);
            handover.setPadding(0, dp(7), 0, 0);
            card.addView(handover);
        }

        return card;
    }

    private String shortText(String value) {
        String s = value.trim().replace('\n', ' ');
        return s.length() > 90 ? s.substring(0, 90) + "…" : s;
    }

    private String durationText(long start, long end) {
        long mins = Math.max(0, (end - start) / 60000L);
        long hours = mins / 60;
        long rest = mins % 60;
        return hours > 0 ? hours + "h " + rest + "m" : rest + "m";
    }

    private TextView text(String value, int sp, boolean bold, int color) {
        TextView tv = new TextView(context);
        tv.setText(value);
        tv.setTextSize(sp);
        tv.setTextColor(color);
        if (bold) tv.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        return tv;
    }

    private int dp(int value) {
        return Math.round(value * context.getResources().getDisplayMetrics().density);
    }
}
