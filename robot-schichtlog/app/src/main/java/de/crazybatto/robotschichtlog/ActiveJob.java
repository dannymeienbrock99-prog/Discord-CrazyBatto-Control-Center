package de.crazybatto.robotschichtlog;

public class ActiveJob {
    public int robot;
    public String orderNumber;
    public String articleNumber;
    public String programInfo;
    public long startedAt;
    public String startShift;
    public String personnelNumber;
    public boolean paused;
    public int revision;

    // An order can remain open across several signed-in shifts and operators.
    public boolean signedOut;
    public long shiftStartedAt;
    public long shiftEndedAt;
    public String sessionShift;

    // One replaceable snapshot per signed-in shift; quantity is that shift's total.
    public long snapshotEntryId;
    public int draftQuantity;
    public String draftEventType;
    public boolean draftImportant;
    public String draftNote;
    public String draftHandoverNote;
    public String draftMissingParts;
    public long draftSavedAt;
    public String snapshotNotice;
}
