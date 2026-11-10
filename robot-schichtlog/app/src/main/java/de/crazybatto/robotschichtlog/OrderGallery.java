package de.crazybatto.robotschichtlog;

import android.app.Activity;
import android.app.AlertDialog;
import android.app.Application;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Bitmap;
import android.graphics.Typeface;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.LruCache;
import android.view.View;
import android.view.ViewGroup;
import android.widget.BaseAdapter;
import android.widget.Button;
import android.widget.GridView;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;
import java.io.File;
import java.io.IOException;
import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import javax.net.ssl.SSLException;
import static de.crazybatto.robotschichtlog.PhotoGallery.*;

/** A gallery lives only as long as its attached order view or dialog. Device photos remain
 * available independently of the paired website. Remote thumbnails are scoped to this view. */
final class OrderGallery implements Application.ActivityLifecycleCallbacks {
    private static final ExecutorService LISTS = Executors.newFixedThreadPool(2);
    private static final ExecutorService IMAGES = Executors.newFixedThreadPool(2);
    private static File transferDirectory;
    private final Activity activity;
    private final AppDesign theme;
    private final DbHelper db;
    private final String article, order;
    private final List<OrderPhotos.Photo> local;
    private final Map<String,WebsiteTarget.RemotePhoto> server = new LinkedHashMap<>();
    private final Set<String> cursors = new HashSet<>();
    private final LruCache<String,Bitmap> thumbs = new LruCache<String,Bitmap>(4*1024*1024) {
        @Override protected int sizeOf(String k, Bitmap image) { return image.getAllocationByteCount(); }
    };
    private volatile int generation;
    private volatile boolean active;
    private String revision, next, message = "";
    private boolean attached, inFlight, retry, denied;
    private List<Item> items = new ArrayList<>();
    private View anchor;
    private TextView heading, status;
    private LinearLayout preview;
    private GridView grid;
    private Button refresh, more;
    private AlertDialog viewer;
    private final Runnable accessCheck = this::checkAccess;
    private final BroadcastReceiver settingsChanged = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) {
            if (!active) return;
            String selected = NasSync.galleryRevision(activity);
            if (!Objects.equals(selected, revision) || (selected != null && !NasSync.galleryCurrent(activity, selected) && !denied)) {
                reload();
            } else if (grid != null) {
                ((BaseAdapter)grid.getAdapter()).notifyDataSetChanged();
            }
        }
    };

    OrderGallery(Activity activity, DbHelper db, String article, String order) {
        this.activity = activity;
        this.theme = AppDesign.current(activity);
        this.db = db;
        this.article = article == null ? "" : article;
        this.order = order == null ? "" : order;
        local = OrderPhotos.forOrder(db, this.article, this.order);
    }

    private static final class Item {
        final OrderPhotos.Photo phone;
        final WebsiteTarget.RemotePhoto web;
        final String day;
        Item(OrderPhotos.Photo phone, WebsiteTarget.RemotePhoto web) {
            this.phone = phone;
            this.web = web;
            day = web != null ? web.day : Instant.ofEpochMilli(phone.time)
                    .atZone(ZoneId.systemDefault()).toLocalDate().toString();
        }
        String name() { return phone != null ? phone.name : "Auftragsfoto · " + day; }
        String date() { return phone != null ? ShiftUtils.formatDateTime(phone.time) : day; }
    }

    private List<Item> merge() {
        List<Item> result = new ArrayList<>();
        Map<String,OrderPhotos.Photo> byId = new HashMap<>();
        for (OrderPhotos.Photo photo : local) {
            File file = OrderPhotos.privateCopy(activity, photo.uri);
            String id = file == null ? null : OrderPhotos.photoId(file);
            if (id != null && file.isFile() && server.containsKey(id)) byId.put(id, photo);
            else if (id == null || !server.containsKey(id)) result.add(new Item(photo,null));
        }
        for (WebsiteTarget.RemotePhoto photo : server.values()) result.add(new Item(byId.get(photo.id), photo));
        // Stable sort retains newest-first order within each source for photographs on the same day.
        Collections.sort(result, (a,b) -> b.day.compareTo(a.day));
        return result;
    }

    void section(LinearLayout parent, boolean dark, Runnable addPhotos) {
        LinearLayout body = new LinearLayout(activity);
        body.setOrientation(LinearLayout.VERTICAL);
        heading = label(activity, "", 20, theme.text);
        heading.setTypeface(Typeface.DEFAULT, Typeface.BOLD);
        heading.setPadding(0, dp(activity,12),0,dp(activity,4));
        body.addView(heading);
        preview = new LinearLayout(activity);
        body.addView(preview);
        status = label(activity, "", 13, theme.muted);
        status.setPadding(0,dp(activity,5),0,dp(activity,5));
        Button open = PhotoGallery.button(activity, "Fotos öffnen", true);
        open.setOnClickListener(v -> PhotoGallery.openOrder(activity, db, article, order));
        LinearLayout.LayoutParams openSize = new LinearLayout.LayoutParams(-1,-2);
        openSize.topMargin = dp(activity,6);
        body.addView(open, openSize);
        body.addView(status);
        Button add = button(activity, "Fotos hinzufügen");
        add.setOnClickListener(v -> addPhotos.run());
        LinearLayout.LayoutParams addSize = new LinearLayout.LayoutParams(-1,-2);
        addSize.topMargin = dp(activity,5);
        body.addView(add, addSize);
        bind(body);
        parent.addView(body);
    }

    void open() {
        LinearLayout body = new LinearLayout(activity);
        body.setOrientation(LinearLayout.VERTICAL);
        body.setBackgroundColor(theme.surface);
        int gap = dp(activity,8);
        body.setPadding(gap, gap, gap, 0);
        status = label(activity, "", 14, theme.muted);
        body.addView(status);
        grid = new GridView(activity);
        grid.setNumColumns(2);
        grid.setHorizontalSpacing(gap);
        grid.setVerticalSpacing(gap);
        grid.setAdapter(new TileAdapter());
        grid.setOnItemClickListener((p,v,i,id) -> showViewer(i));
        int height = Math.round(activity.getResources().getDisplayMetrics().heightPixels * 0.46f);
        body.addView(grid, new LinearLayout.LayoutParams(-1, height));
        LinearLayout actions = new LinearLayout(activity);
        refresh = button(activity, "Aktualisieren");
        refresh.setOnClickListener(v -> reload());
        actions.addView(refresh,new LinearLayout.LayoutParams(0,-2,1));
        more = button(activity, "Mehr laden");
        more.setOnClickListener(v -> fetch(next));
        actions.addView(more,new LinearLayout.LayoutParams(0,-2,1));
        body.addView(actions);
        bind(body);
        String title = "Auftrag " + order + (article.isEmpty() ? " · ohne Artikelnummer" : " · Artikel " + article);
        new AlertDialog.Builder(activity).setTitle(title).setView(body).setPositiveButton("Schließen",null).show();
    }

    private void bind(View root) {
        anchor = root;
        render();
        root.addOnAttachStateChangeListener(new View.OnAttachStateChangeListener() {
            public void onViewAttachedToWindow(View v) {
                attached = true;
                activity.getApplication().registerActivityLifecycleCallbacks(OrderGallery.this);
                IntentFilter filter = new IntentFilter(NasSync.ACTION_STATUS);
                if (Build.VERSION.SDK_INT >= 33) activity.registerReceiver(settingsChanged,filter,Context.RECEIVER_NOT_EXPORTED);
                else activity.registerReceiver(settingsChanged,filter);
                activate();
            }
            public void onViewDetachedFromWindow(View v) {
                attached = false;
                activity.unregisterReceiver(settingsChanged);
                activity.getApplication().unregisterActivityLifecycleCallbacks(OrderGallery.this);
                stop();
            }
        });
    }

    private void activate() {
        if (active) return;
        active = true;
        reload();
    }

    private void stop() {
        active = false;
        clearRemote();
        message = "";
        if (attached) render();
    }

    private void clearRemote() {
        generation++;
        anchor.removeCallbacks(accessCheck);
        if (viewer != null) viewer.dismiss();
        server.clear();
        cursors.clear();
        thumbs.evictAll();
        next = null;
        inFlight = false;
        denied = false;
        retry = false;
    }

    private void reload() {
        if (!active) return;
        clearRemote();
        revision = NasSync.galleryRevision(activity);
        if (revision == null) {
            message = "Nur Gerätefotos. Für Website-Fotos crazybatto.de unter Fotospeicher verbinden.";
            render();
        } else if (order.trim().isEmpty()) {
            message = "Für Website-Fotos wird die Auftragsnummer benötigt.";
            render();
        } else if (!NasSync.galleryCurrent(activity, revision)) {
            deny(401);
        } else fetch(null);
    }

    private boolean current(int gen, String pairing) {
        return active && generation == gen && NasSync.galleryCurrent(activity, pairing);
    }

    private void fetch(String cursor) {
        if (inFlight || !active) return;
        int gen = generation;
        String pairing = revision;
        inFlight = true;
        message = cursor == null ? "Website-Fotos werden geladen …" : "Weitere Website-Fotos werden geladen …";
        render();
        LISTS.execute(() -> {
            try {
                if (!current(gen,pairing)) return;
                WebsiteTarget.Page page = NasSync.galleryTarget(activity,pairing).listPhotos(order,article,cursor);
                activity.runOnUiThread(() -> {
                    if (!current(gen,pairing)) return;
                    inFlight = false;
                    retry = false;
                    for (WebsiteTarget.RemotePhoto photo : page.photos) server.put(photo.id, photo);
                    next = page.nextCursor;
                    if (next != null && !cursors.add(next)) {
                        next = null;
                        message = "Unvollständige Antwort der Webseite. Bitte aktualisieren.";
                        retry = true;
                    } else message = next == null ? "" : "Weitere Website-Fotos sind verfügbar.";
                    render();
                    scheduleCheck();
                });
            } catch (Exception ex) { activity.runOnUiThread(() -> failure(gen,pairing,ex)); }
        });
    }

    private void scheduleCheck() {
        anchor.removeCallbacks(accessCheck);
        if (active && !denied) anchor.postDelayed(accessCheck,60_000);
    }

    private void checkAccess() {
        int gen = generation;
        String pairing = revision;
        if (!current(gen,pairing) || denied) return;
        LISTS.execute(() -> {
            try {
                boolean allowed = NasSync.galleryTarget(activity,pairing).verifyPairing();
                activity.runOnUiThread(() -> {
                    if (!current(gen,pairing)) return;
                    if (!allowed) deny(403); else scheduleCheck();
                });
            } catch (Exception ex) { activity.runOnUiThread(() -> failure(gen,pairing,ex)); }
        });
    }

    private void failure(int gen, String pairing, Exception error) {
        if (!active || generation != gen || !Objects.equals(pairing,NasSync.galleryRevision(activity))) return;
        int code = error instanceof WebsiteTarget.SiteError ? ((WebsiteTarget.SiteError)error).code : -1;
        if (code == 401 || code == 403) { deny(code); return; }
        clearRemote();
        retry = true;
        if (error instanceof SSLException) message = "Website-Zertifikat konnte nicht geprüft werden. Gerätefotos sind verfügbar.";
        else if (code == 404 || code == 405) message = "Fotoabruf auf der Webseite nicht verfügbar. Gerätefotos werden angezeigt.";
        else if (code >= 0) message = "Website-Fotos konnten nicht bestätigt werden. Gerätefotos werden angezeigt.";
        else message = "Website-Fotos nicht erreichbar. Gerätefotos sind weiterhin verfügbar.";
        render();
    }

    private void deny(int code) {
        clearRemote();
        denied = true;
        message = code == 403 ? "Dieser Gerätecode erlaubt nur Uploads. Den Fotoabruf unter Handys auf der Webseite freigeben."
                : "Gerätecode ungültig oder widerrufen. Unter Fotospeicher neu verbinden.";
        if (code == 401) NasSync.galleryUnauthorized(activity, revision);
        render();
    }

    @Override public void onActivityStopped(Activity a) { if (a == activity) stop(); }
    @Override public void onActivityResumed(Activity a) { if (a == activity && attached) activate(); }
    @Override public void onActivityCreated(Activity a, Bundle b) {}
    @Override public void onActivityStarted(Activity a) {}
    @Override public void onActivityPaused(Activity a) {}
    @Override public void onActivitySaveInstanceState(Activity a, Bundle b) {}
    @Override public void onActivityDestroyed(Activity a) {}

    private void render() {
        items = merge();
        if (heading != null) heading.setText("Auftragsfotos (" + items.size() + (next == null ? "" : "+") + ")");
        status.setText(message.isEmpty() && items.isEmpty() ? "Noch keine Fotos für diesen Auftrag." : message);
        if (preview != null) {
            preview.removeAllViews();
            for (int i = 0; i < Math.min(2,items.size()); i++) {
                int index = i;
                Item item = items.get(i);
                ImageView thumb = image(activity,item.name(),false);
                LinearLayout.LayoutParams size = new LinearLayout.LayoutParams(0,dp(activity,104),1f);
                size.setMargins(0,0,i == 0 && items.size() > 1 ? dp(activity,8) : 0,0);
                preview.addView(thumb,size);
                showImage(item,thumb,320,false,null);
                thumb.setOnClickListener(v -> showViewer(index));
            }
        }
        if (grid != null) {
            ((BaseAdapter)grid.getAdapter()).notifyDataSetChanged();
            more.setVisibility(next == null ? View.GONE : View.VISIBLE);
            more.setEnabled(!inFlight);
            refresh.setEnabled(!inFlight);
            refresh.setText(retry ? "Erneut versuchen" : "Aktualisieren");
        }
    }

    private final class TileAdapter extends BaseAdapter {
        public int getCount() { return items.size(); }
        public Object getItem(int i) { return items.get(i); }
        public long getItemId(int i) { return i; }
        public View getView(int i, View convert, ViewGroup parent) {
            Item item = items.get(i);
            LinearLayout card = (LinearLayout)convert;
            if (card == null) {
                card = new LinearLayout(activity);
                card.setOrientation(LinearLayout.VERTICAL);
                card.addView(image(activity,"",false),new LinearLayout.LayoutParams(-1,dp(activity,125)));
                card.addView(label(activity,"",13,theme.text));
                card.addView(label(activity,"",12,theme.muted));
            }
            ImageView thumb = (ImageView)card.getChildAt(0);
            thumb.setContentDescription(item.name());
            ((TextView)card.getChildAt(1)).setText(item.date());
            TextView details = (TextView)card.getChildAt(2);
            details.setText(source(item));
            showImage(item,thumb,420,false,() -> details.setText("Vorschau nicht verfügbar"));
            return card;
        }
    }

    private String source(Item item) {
        if (item.phone == null) return "Von crazybatto.de";
        File file = OrderPhotos.privateCopy(activity,item.phone.uri);
        if (file == null) return "Originalverknüpfung";
        if (!file.isFile()) return "Datei fehlt";
        return item.web == null ? NasSync.status(activity,OrderPhotos.photoId(file)) : "Gerät und crazybatto.de";
    }

    private void showViewer(int index) {
        if (index < 0 || index >= items.size()) return;
        List<Item> sequence = new ArrayList<>(items);
        LinearLayout body = new LinearLayout(activity);
        body.setOrientation(LinearLayout.VERTICAL);
        body.setBackgroundColor(theme.surface);
        ImageView picture = image(activity,"",true);
        int height = Math.round(activity.getResources().getDisplayMetrics().heightPixels * 0.56f);
        body.addView(picture,new LinearLayout.LayoutParams(-1,height));
        TextView caption = label(activity,"",14,theme.text);
        caption.setPadding(dp(activity,12),dp(activity,6),dp(activity,12),0);
        body.addView(caption);
        AlertDialog dialog = new AlertDialog.Builder(activity).setView(body)
                .setNegativeButton("Zurück",null).setNeutralButton("Weiter",null)
                .setPositiveButton("Schließen",null).create();
        viewer = dialog;
        dialog.setOnDismissListener(d -> {
            picture.setTag(null);
            picture.setImageDrawable(null);
            if (viewer == dialog) viewer = null;
        });
        dialog.show();
        int[] position = {index};
        Runnable update = () -> {
            Item item = sequence.get(position[0]);
            dialog.setTitle("Foto " + (position[0]+1) + " von " + sequence.size());
            picture.setContentDescription(item.name());
            caption.setText(item.name() + "\n" + item.date() + " · " + source(item));
            showImage(item,picture,1800,true,() -> caption.setText(item.name()+"\nFoto kann derzeit nicht geöffnet werden."));
            dialog.getButton(-2).setEnabled(position[0] > 0);
            dialog.getButton(-3).setEnabled(position[0] < sequence.size()-1);
        };
        dialog.getButton(-2).setOnClickListener(v -> { position[0]--; update.run(); });
        dialog.getButton(-3).setOnClickListener(v -> { position[0]++; update.run(); });
        update.run();
    }

    private static synchronized File stage(Context context) throws IOException {
        if (transferDirectory == null) {
            File directory = new File(context.getCacheDir(),"site-gallery-transfers");
            if (!directory.isDirectory() && !directory.mkdirs()) throw new IOException("Kein Speicher für die Vorschau.");
            File[] orphaned = directory.listFiles((dir,name) ->
                    (name.startsWith("photo-") && name.endsWith(".tmp"))
                    || (name.startsWith(".schichtlog-") && name.endsWith(".part")));
            if (orphaned != null) for (File old : orphaned) old.delete();
            transferDirectory = directory;
        }
        return File.createTempFile("photo-",".tmp",transferDirectory);
    }

    private void showImage(Item item, ImageView target, int pixels, boolean full, Runnable failed) {
        if (item.phone != null) {
            PhotoGallery.load(activity,target,Uri.parse(item.phone.uri),pixels,full,failed);
            return;
        }
        int gen = generation;
        String pairing = revision;
        String key = gen + "/" + item.web.id + "/" + item.web.sha256 + "/" + pixels;
        if (key.equals(target.getTag())) return;
        target.setTag(key);
        Bitmap cached = !full && current(gen,pairing) ? thumbs.get(key) : null;
        target.setImageBitmap(cached);
        if (cached != null || !current(gen,pairing)) return;
        IMAGES.execute(() -> {
            if (!current(gen,pairing) || !key.equals(target.getTag())) return;
            File tmp = null;
            try {
                tmp = stage(activity);
                WebsiteTarget remote = NasSync.galleryTarget(activity,pairing);
                remote.downloadPhoto(order,article,item.web,tmp);
                if (!current(gen,pairing)) return;
                Bitmap decoded = PhotoGallery.decode(activity,Uri.fromFile(tmp),pixels);
                activity.runOnUiThread(() -> {
                    if (!current(gen,pairing) || !key.equals(target.getTag())) return;
                    if (decoded == null) imageFailed(target,failed);
                    else {
                        if (!full) thumbs.put(key,decoded);
                        target.setImageBitmap(decoded);
                    }
                });
            } catch (Exception error) {
                activity.runOnUiThread(() -> {
                    if (!active || gen != generation) return;
                    if (error instanceof WebsiteTarget.SiteError) {
                        int code = ((WebsiteTarget.SiteError)error).code;
                        if (code == 401 || code == 403) { deny(code); return; }
                    }
                    if (key.equals(target.getTag())) imageFailed(target,failed);
                });
            } finally {
                if (tmp != null) tmp.delete();
            }
        });
    }

    private static void imageFailed(ImageView target, Runnable failed) {
        target.setImageResource(android.R.drawable.ic_menu_gallery);
        if (failed != null) failed.run();
    }
}
