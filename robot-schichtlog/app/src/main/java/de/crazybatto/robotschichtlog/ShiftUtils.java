package de.crazybatto.robotschichtlog;

import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.Date;
import java.util.Locale;

public final class ShiftUtils {
    public static final String EARLY = "Frühschicht";
    public static final String LATE = "Spätschicht";
    public static final String NIGHT = "Nachtschicht";

    private ShiftUtils() {}

    public static String getShift(long timestamp) {
        Calendar c = Calendar.getInstance();
        c.setTimeInMillis(timestamp);
        int hour = c.get(Calendar.HOUR_OF_DAY);
        if (hour >= 6 && hour < 14) return EARLY;
        if (hour >= 14 && hour < 22) return LATE;
        return NIGHT;
    }

    /** A sign-in during the last 15 minutes before 06/14/22 belongs to the next shift. */
    public static String getShiftForSignIn(long timestamp) {
        return getShift(signInShiftWindow(timestamp)[0]);
    }

    public static long[] signInShiftWindow(long timestamp) {
        long[] current = currentShiftWindow(timestamp);
        if (timestamp >= current[1] - 15L * 60L * 1000L) {
            return currentShiftWindow(current[1]);
        }
        return current;
    }

    public static String formatDateTime(long timestamp) {
        return new SimpleDateFormat("dd.MM.yyyy · HH:mm", Locale.GERMANY).format(new Date(timestamp));
    }

    public static String formatDate(long timestamp) {
        return new SimpleDateFormat("dd.MM.yyyy", Locale.GERMANY).format(new Date(timestamp));
    }

    public static String formatTime(long timestamp) {
        return new SimpleDateFormat("HH:mm", Locale.GERMANY).format(new Date(timestamp));
    }

    public static long startOfToday(long now) {
        Calendar c = Calendar.getInstance();
        c.setTimeInMillis(now);
        c.set(Calendar.HOUR_OF_DAY, 0);
        c.set(Calendar.MINUTE, 0);
        c.set(Calendar.SECOND, 0);
        c.set(Calendar.MILLISECOND, 0);
        return c.getTimeInMillis();
    }

    public static long endOfToday(long now) {
        Calendar c = Calendar.getInstance();
        c.setTimeInMillis(startOfToday(now));
        c.add(Calendar.DAY_OF_MONTH, 1);
        return c.getTimeInMillis();
    }

    public static long[] currentShiftWindow(long now) {
        Calendar c = Calendar.getInstance();
        c.setTimeInMillis(now);
        int hour = c.get(Calendar.HOUR_OF_DAY);

        Calendar start = (Calendar) c.clone();
        Calendar end = (Calendar) c.clone();

        if (hour >= 6 && hour < 14) {
            setClock(start, 6, 0);
            setClock(end, 14, 0);
        } else if (hour >= 14 && hour < 22) {
            setClock(start, 14, 0);
            setClock(end, 22, 0);
        } else if (hour >= 22) {
            setClock(start, 22, 0);
            end.add(Calendar.DAY_OF_MONTH, 1);
            setClock(end, 6, 0);
        } else {
            start.add(Calendar.DAY_OF_MONTH, -1);
            setClock(start, 22, 0);
            setClock(end, 6, 0);
        }

        return new long[]{start.getTimeInMillis(), end.getTimeInMillis()};
    }

    private static void setClock(Calendar c, int hour, int minute) {
        c.set(Calendar.HOUR_OF_DAY, hour);
        c.set(Calendar.MINUTE, minute);
        c.set(Calendar.SECOND, 0);
        c.set(Calendar.MILLISECOND, 0);
    }
}
