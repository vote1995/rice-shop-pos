package win.twostackmaxgame.pos;

import android.os.Bundle;
import android.view.View;

import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Locally-bundled plugins are not listed in capacitor.plugins.json
        // (only npm packages synced via `npx cap sync` are), so register them
        // manually. Must happen before super.onCreate(), which builds the
        // bridge and instantiates the registered plugins.
        registerPlugin(ApkInstallerPlugin.class);

        super.onCreate(savedInstanceState);

        // Android 15+ draws apps edge-to-edge, so the system navigation bar
        // (3-button or gesture pill) would sit on top of the POS bottom tabs
        // (ขาย / คิว / นับสต็อก). Pad the content by the bottom/side system-bar
        // insets so the web UI stays clear of them. Top is left alone: the
        // status bar area is already handled.
        View content = findViewById(android.R.id.content);
        ViewCompat.setOnApplyWindowInsetsListener(content, (v, windowInsets) -> {
            Insets bars = windowInsets.getInsets(
                WindowInsetsCompat.Type.systemBars() | WindowInsetsCompat.Type.displayCutout()
            );
            v.setPadding(bars.left, v.getPaddingTop(), bars.right, bars.bottom);
            return windowInsets;
        });
        ViewCompat.requestApplyInsets(content);
    }
}
