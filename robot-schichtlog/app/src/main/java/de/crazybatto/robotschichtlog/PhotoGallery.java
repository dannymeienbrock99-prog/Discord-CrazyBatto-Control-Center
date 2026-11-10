package de.crazybatto.robotschichtlog;

import android.app.Activity;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.content.res.ColorStateList;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.graphics.Matrix;
import android.media.ExifInterface;
import android.net.Uri;
import android.util.LruCache;
import android.widget.Button;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.io.InputStream;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

final class PhotoGallery {
    private static final ExecutorService DECODER = Executors.newFixedThreadPool(2);
    private static final LruCache<String,Bitmap> THUMBNAILS = new LruCache<String,Bitmap>(6 * 1024 * 1024) {
        @Override protected int sizeOf(String key, Bitmap image) { return image.getAllocationByteCount(); }
    };

    static void section(Activity activity, LinearLayout parent, DbHelper db, String article, String order,
                        boolean dark, Runnable addPhotos) {
        new OrderGallery(activity, db, article, order).section(parent, dark, addPhotos);
    }

    static void openOrder(Activity activity, DbHelper db, String article, String order) {
        new OrderGallery(activity, db, article, order).open();
    }
    static ImageView pendingThumbnail(Activity activity, Uri uri, String name) {
        ImageView thumbnail = image(activity, name, false);
        load(activity, thumbnail, uri, 192, false, null);
        return thumbnail;
    }

    static ImageView image(Activity activity, String name, boolean fit) {
        ImageView image = new ImageView(activity);
        image.setScaleType(fit ? ImageView.ScaleType.FIT_CENTER : ImageView.ScaleType.CENTER_CROP);
        AppDesign theme = AppDesign.current(activity);
        GradientDrawable frame = new GradientDrawable();
        frame.setColor(theme.surfaceAlt);
        frame.setCornerRadius(dp(activity, fit ? 0 : 8));
        image.setBackground(frame);
        image.setClipToOutline(true);
        image.setContentDescription(name);
        return image;
    }

    static void load(Activity activity, ImageView target, Uri uri, int pixels, boolean full, Runnable failure) {
        String key = uri + "#" + pixels;
        target.setTag(key);
        Bitmap cached = full ? null : THUMBNAILS.get(key);
        target.setImageBitmap(cached);
        if (cached != null) return;
        DECODER.execute(() -> {
            if (!key.equals(target.getTag())) return;
            Bitmap decoded = decode(activity, uri, pixels);
            if (decoded != null && !full) THUMBNAILS.put(key, decoded);
            activity.runOnUiThread(() -> {
                if (activity.isDestroyed() || !key.equals(target.getTag())) return;
                if (decoded == null) {
                    target.setImageResource(android.R.drawable.ic_menu_gallery);
                    if (failure != null) failure.run();
                } else target.setImageBitmap(decoded);
            });
        });
    }

    static Bitmap decode(Activity activity, Uri uri, int max) {
        try {
            BitmapFactory.Options options = new BitmapFactory.Options();
            options.inJustDecodeBounds = true;
            try (InputStream in = activity.getContentResolver().openInputStream(uri)) {
                BitmapFactory.decodeStream(in, null, options);
            }
            options.inJustDecodeBounds = false;
            options.inSampleSize = 1;
            int longest = Math.max(options.outWidth, options.outHeight);
            while (longest / options.inSampleSize > max) options.inSampleSize *= 2;
            Bitmap bitmap;
            try (InputStream in = activity.getContentResolver().openInputStream(uri)) {
                bitmap = BitmapFactory.decodeStream(in, null, options);
            }
            if (bitmap == null) return null;
            try (InputStream in = activity.getContentResolver().openInputStream(uri)) {
                ExifInterface exif = new ExifInterface(in);
                int orientation = exif.getAttributeInt(ExifInterface.TAG_ORIENTATION, 1);
                Matrix rotation = new Matrix();
                switch (orientation) {
                    case 2: rotation.setScale(-1, 1); break;
                    case 3: rotation.setRotate(180); break;
                    case 4: rotation.setScale(1, -1); break;
                    case 5: rotation.setRotate(90); rotation.postScale(-1, 1); break;
                    case 6: rotation.setRotate(90); break;
                    case 7: rotation.setRotate(-90); rotation.postScale(-1, 1); break;
                    case 8: rotation.setRotate(-90); break;
                    default: return bitmap;
                }
                return Bitmap.createBitmap(bitmap, 0, 0, bitmap.getWidth(), bitmap.getHeight(), rotation, true);
            } catch (Exception ignored) { return bitmap; }
        } catch (Exception ex) { return null; }
    }

    static TextView label(Activity activity, String value, int sp, int color) {
        TextView text = new TextView(activity);
        text.setText(value);
        text.setTextSize(sp);
        text.setTextColor(color);
        return text;
    }

    static Button button(Activity activity, String value) {
        return button(activity, value, false);
    }

    static Button button(Activity activity, String value, boolean primary) {
        AppDesign design = AppDesign.current(activity);
        Button button = new Button(activity);
        button.setText(value);
        button.setAllCaps(false);
        button.setMinHeight(dp(activity, 46));
        button.setPadding(dp(activity, 10), dp(activity, 6), dp(activity, 10), dp(activity, 6));
        button.setTextColor(primary ? design.onAccent : design.text);
        button.setTypeface(Typeface.DEFAULT, primary ? Typeface.BOLD : Typeface.NORMAL);
        GradientDrawable shape = new GradientDrawable();
        shape.setColor(primary ? design.accent : design.surface);
        shape.setCornerRadius(dp(activity, 8));
        if (!primary) shape.setStroke(dp(activity, 1), design.border);
        int ripple = design.dark ? 0x38FFFFFF : 0x24000000;
        button.setBackground(new RippleDrawable(ColorStateList.valueOf(ripple), shape, null));
        return button;
    }

    static int dp(Activity activity, int value) {
        return Math.round(value * activity.getResources().getDisplayMetrics().density);
    }

    private PhotoGallery() {}
}
