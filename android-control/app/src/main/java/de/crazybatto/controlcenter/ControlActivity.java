package de.crazybatto.controlcenter;

import android.app.AlertDialog;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.widget.Toast;

import com.google.androidbrowserhelper.trusted.LauncherActivity;
import com.google.androidbrowserhelper.trusted.TwaLauncher;

/** Opens the verified chat origin using the browser's maintained media and push support. */
public final class ControlActivity extends LauncherActivity {
    @Override
    protected Uri getUrlForIntent(Intent intent) {
        String accepted = ControlLaunchUrl.accepted(intent == null ? null : intent.getDataString());
        return accepted == null ? null : Uri.parse(accepted);
    }

    @Override
    protected Uri getLaunchingUrl() {
        Uri accepted = getUrlForIntent(getIntent());
        return accepted == null ? Uri.parse(ControlLaunchUrl.DEFAULT_URL) : accepted;
    }

    @Override
    protected TwaLauncher.FallbackStrategy getFallbackStrategy() {
        // A missing TWA provider must not silently become a less capable WebView wrapper.
        return (context, builder, providerPackage, completionCallback) -> {
            if (isFinishing()) return;
            new AlertDialog.Builder(this)
                    .setTitle(R.string.browser_required_title)
                    .setMessage(R.string.browser_required_message)
                    .setPositiveButton(R.string.chrome_install, (dialog, which) -> openChromeStore())
                    .setNegativeButton(R.string.close, (dialog, which) -> finish())
                    .setOnCancelListener(dialog -> finish())
                    .show();
        };
    }

    private void openChromeStore() {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW,
                    Uri.parse("market://details?id=com.android.chrome")));
        } catch (ActivityNotFoundException | SecurityException unavailable) {
            Toast.makeText(this, R.string.store_unavailable, Toast.LENGTH_LONG).show();
        }
        finish();
    }
}
