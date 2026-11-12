package de.crazybatto.robotschichtlog;

import java.util.List;
import java.util.Map;

/** Human-readable export without app paths, authentication data, or attachment download links. */
final class OrderTextExport {
    private OrderTextExport() {}

    static String render(Record selected, List<Record> records, Map<Long, List<Attachment>> attachments) {
        StringBuilder text = new StringBuilder("ROBOT SCHICHTLOG\r\n");
        line(text, "Auftrag", selected.orderNumber);
        line(text, "Roboter", String.valueOf(selected.robot));
        line(text, "Einträge", String.valueOf(records.size()));
        text.append("\r\nChronologischer Verlauf\r\n");
        for (Record record : records) {
            text.append("\r\n----------------------------------------\r\n");
            line(text, "Eintrag", "#" + record.id);
            line(text, "Datum / Uhrzeit", ShiftUtils.formatDateTime(record.timestamp));
            line(text, "Schicht", record.shift);
            line(text, "Typ", record.source);
            line(text, "Personalnummer", record.personnelNumber);
            line(text, "Artikelnummer", record.articleNumber);
            line(text, "Programm", record.programInfo);
            line(text, "Menge", String.valueOf(record.quantity));
            line(text, "Ereignis", record.eventType);
            line(text, "Wichtig", record.important ? "Ja" : "Nein");
            if (record.startedAt > 0) line(text, "Auftrag gestartet", ShiftUtils.formatDateTime(record.startedAt));
            if (record.endedAt > 0) line(text, "Schicht beendet".equals(record.source) ? "Schichtende" : "Auftrag beendet", ShiftUtils.formatDateTime(record.endedAt));
            line(text, "Teile fehlen", record.missingParts);
            line(text, "Notiz", record.note);
            line(text, "Schichtübergabe", record.handoverNote);
            List<Attachment> files = attachments.get(record.id);
            line(text, "Anhänge", files == null ? "0" : String.valueOf(files.size()));
            if (files != null) for (Attachment file : files) text.append("  - ").append(clean(file.displayName)).append("\r\n");
        }
        text.append("\r\nAnhänge sind mit Dateinamen aufgeführt. Die Bilder selbst sind nicht in dieser Textdatei enthalten.\r\n");
        return text.toString();
    }

    private static void line(StringBuilder text, String label, String value) {
        text.append(label).append(": ").append(clean(value)).append("\r\n");
    }

    private static String clean(String value) {
        if (value == null || value.trim().isEmpty()) return "—";
        return value.replace("\r\n", "\n").replace('\r', '\n').replace("\n", "\r\n");
    }
}
