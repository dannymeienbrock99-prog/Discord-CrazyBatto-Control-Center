package de.crazybatto.robotschichtlog;

import java.util.LinkedHashMap;
import java.util.Map;

public class Stats {
    public int count;
    public int totalQuantity;
    public int importantCount;
    public final Map<String, Integer> byShift = new LinkedHashMap<>();
    public final Map<Integer, Integer> byRobot = new LinkedHashMap<>();
}
