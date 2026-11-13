package win.twostackmaxgame.pos;

import androidx.core.content.FileProvider;

/**
 * Distinct FileProvider subclass for the self-update APK hand-off. The manifest
 * already declares androidx.core.content.FileProvider for the app's other
 * files; two providers with the SAME class name collide (the system installer
 * then fails with "opening provider ... that is not exported"), so the update
 * provider gets its own component name.
 */
public class ApkFileProvider extends FileProvider {}
