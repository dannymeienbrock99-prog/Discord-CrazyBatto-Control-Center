package de.crazybatto.controlcenter;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import com.google.androidbrowserhelper.trusted.DelegationService;

/** Browser delegation retains the library's verified-caller checks. */
public final class ControlNotificationService extends DelegationService {
    private static final String CHANNEL = "control_requests_v1";
    private NotificationManager manager() {
        NotificationManager manager=getSystemService(NotificationManager.class);
        NotificationChannel channel=new NotificationChannel(CHANNEL,"Neue Anfragen und Mitglieder",NotificationManager.IMPORTANCE_HIGH);
        channel.setDescription("Neue PC-Hilfe, Aufträge und Registrierungen im Crazy_Batto Control Center");
        channel.enableVibration(true);
        channel.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION),new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_NOTIFICATION).build());
        channel.setLockscreenVisibility(Notification.VISIBILITY_PRIVATE);
        manager.createNotificationChannel(channel);
        return manager;
    }
    @Override public boolean onAreNotificationsEnabled(String channelName) {
        NotificationManager manager=manager();
        return manager.areNotificationsEnabled()&&manager.getNotificationChannel(CHANNEL).getImportance()!=NotificationManager.IMPORTANCE_NONE;
    }
    @Override public boolean onNotifyNotificationWithChannel(String tag,int id,Notification notification,String channelName) {
        try {
            NotificationManager manager=manager();if(!onAreNotificationsEnabled(channelName))return false;
            Notification publicVersion=new Notification.Builder(this,CHANNEL).setSmallIcon(R.drawable.ic_notification)
                .setContentTitle("Crazy_Batto Control Center").setContentText("Eine neue Anfrage ist eingegangen.").build();
            Notification safe=Notification.Builder.recoverBuilder(this,notification).setChannelId(CHANNEL)
                .setVisibility(Notification.VISIBILITY_PRIVATE).setPublicVersion(publicVersion).setAutoCancel(true).build();
            manager.notify(tag,id,safe);return true;
        } catch(SecurityException denied) {
            return false;
        }
    }
}
