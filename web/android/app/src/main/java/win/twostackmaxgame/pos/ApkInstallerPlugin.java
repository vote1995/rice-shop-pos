package win.twostackmaxgame.pos;

import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.SystemClock;
import android.provider.Settings;

import androidx.core.content.FileProvider;
import androidx.core.content.pm.PackageInfoCompat;

import com.getcapacitor.JSObject;
import com.getcapacitor.Logger;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Locale;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Tiny in-app self-update plugin.
 *
 * Downloads an APK over HTTPS into the app's private cache, verifies its
 * SHA-256 digest and hands it to the system package installer through a
 * FileProvider URI (authority: "<applicationId>.apkprovider", paths exposed
 * in res/xml/apk_file_paths.xml).
 *
 * Security notes:
 * - Only https URLs (initial and every redirect hop) are accepted. The plugin
 *   cannot know the app's API origin, so host pinning is left to the caller.
 * - Downloads are hard-capped at the announced APK size + 1 MB.
 * - Error messages never contain the request URL (it carries a signed token);
 *   callers only get stable error codes plus generic messages.
 */
@CapacitorPlugin(name = "ApkInstaller")
public class ApkInstallerPlugin extends Plugin {

    /** Directory (inside getCacheDir()) the APK is downloaded into. */
    static final String UPDATE_DIR_NAME = "apk-update";

    /** File name of the staged APK. */
    static final String UPDATE_FILE_NAME = "update.apk";

    /** Bytes tolerated on top of the announced APK size. */
    static final long SIZE_TOLERANCE_BYTES = 1024L * 1024L;

    /** Maximum redirect hops followed while downloading. */
    static final int MAX_REDIRECTS = 5;

    static final int CONNECT_TIMEOUT_MS = 20_000;
    static final int READ_TIMEOUT_MS = 60_000;

    /** Throttle for "progress" events: ~5 per second. */
    static final long PROGRESS_INTERVAL_MS = 200L;

    static final int IO_BUFFER_SIZE = 64 * 1024;

    /**
     * Serializes downloads so two calls can never race on the same file.
     * Daemon threads so a lingering download never keeps the process alive.
     */
    private static final ExecutorService DOWNLOAD_EXECUTOR = Executors.newSingleThreadExecutor(runnable -> {
        Thread thread = new Thread(runnable, "ApkInstallerDownload");
        thread.setDaemon(true);
        return thread;
    });

    /** IOException whose message is safe to surface to the web layer. */
    private static final class DownloadException extends IOException {

        DownloadException(String safeMessage) {
            super(safeMessage);
        }
    }

    /**
     * @return {versionCode: int, versionName: string} of the installed app.
     */
    @PluginMethod
    public void getVersion(PluginCall call) {
        try {
            PackageInfo info = getContext().getPackageManager().getPackageInfo(getContext().getPackageName(), 0);
            JSObject result = new JSObject();
            result.put("versionCode", (int) PackageInfoCompat.getLongVersionCode(info));
            result.put("versionName", info.versionName == null ? "" : info.versionName);
            call.resolve(result);
        } catch (PackageManager.NameNotFoundException ex) {
            // Impossible for our own package, but don't crash if it happens.
            call.reject("Unable to read the installed app version", "version_failed");
        }
    }

    /**
     * Downloads (or reuses) the update APK, verifies it and starts the system
     * installer.
     *
     * Options: { url: string, sha256: string, size: number }
     *
     * Reject codes: invalid_arguments, invalid_url, download_failed,
     * sha_mismatch, need_permission, install_failed.
     * Emits "progress" events: { received: number, total: number }.
     */
    @PluginMethod
    public void downloadAndInstall(PluginCall call) {
        String urlString = call.getString("url");
        String expectedSha256 = call.getString("sha256");
        long expectedSize = call.getData() == null ? -1L : call.getData().optLong("size", -1L);

        if (urlString == null || urlString.trim().isEmpty()) {
            call.reject("url is required and must be an https URL", "invalid_arguments");
            return;
        }

        final URL url;
        try {
            url = new URL(urlString.trim());
        } catch (IOException ex) {
            call.reject("url is not a valid URL", "invalid_url");
            return;
        }
        if (!"https".equalsIgnoreCase(url.getProtocol()) || url.getHost() == null || url.getHost().isEmpty()) {
            call.reject("only https URLs are allowed", "invalid_url");
            return;
        }
        if (expectedSha256 == null || !expectedSha256.trim().matches("^[0-9a-fA-F]{64}$")) {
            call.reject("sha256 must be a hex encoded SHA-256 digest", "invalid_arguments");
            return;
        }
        if (expectedSize <= 0) {
            call.reject("size must be the expected APK size in bytes", "invalid_arguments");
            return;
        }

        final String digest = expectedSha256.trim().toLowerCase(Locale.US);
        // Run off the bridge thread: this call can take minutes.
        DOWNLOAD_EXECUTOR.execute(() -> downloadVerifyAndInstall(call, url, digest, expectedSize));
    }

    private void downloadVerifyAndInstall(PluginCall call, URL url, String expectedSha256, long expectedSize) {
        File apkFile = null;
        try {
            apkFile = stagedApkFile();
            boolean reused = reuseVerifiedApk(apkFile, expectedSha256, expectedSize);

            if (!reused) {
                downloadTo(url, apkFile, expectedSize);
                String actualSha256 = sha256Of(apkFile);
                if (!expectedSha256.equals(actualSha256)) {
                    deleteQuietly(apkFile);
                    call.reject("Downloaded update failed the integrity check", "sha_mismatch");
                    return;
                }
            }

            // Keep the verified APK around when the user must grant the
            // install permission first, so the retry can skip the download.
            final File file = apkFile;
            final boolean fromCache = reused;
            getActivity().runOnUiThread(() -> launchInstaller(call, file, fromCache));
        } catch (DownloadException ex) {
            deleteQuietly(apkFile);
            call.reject(ex.getMessage(), "download_failed");
        } catch (Exception ex) {
            // The exception message may contain the request URL (signed
            // token), so only the exception type is logged.
            Logger.warn(getLogTag(), "APK update failed: " + ex.getClass().getSimpleName());
            deleteQuietly(apkFile);
            call.reject("Download failed", "download_failed");
        }
    }

    /** Reuses a previously verified APK (e.g. retry after granting permission). */
    private boolean reuseVerifiedApk(File apkFile, String expectedSha256, long expectedSize) throws IOException, NoSuchAlgorithmException {
        if (!apkFile.isFile() || apkFile.length() <= 0L || apkFile.length() > expectedSize + SIZE_TOLERANCE_BYTES) {
            deleteQuietly(apkFile);
            return false;
        }
        if (expectedSha256.equals(sha256Of(apkFile))) {
            Logger.debug(getLogTag(), "Reusing previously downloaded APK");
            emitProgress(apkFile.length(), apkFile.length());
            return true;
        }
        deleteQuietly(apkFile);
        return false;
    }

    /** Opens the connection, following redirects manually so no hop can downgrade to http. */
    private HttpURLConnection openFollowingHttpsRedirects(URL initialUrl) throws IOException {
        URL current = initialUrl;
        for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
            if (!"https".equalsIgnoreCase(current.getProtocol())) {
                throw new DownloadException("Redirect target is not https");
            }
            HttpURLConnection connection = (HttpURLConnection) current.openConnection();
            connection.setInstanceFollowRedirects(false);
            connection.setConnectTimeout(CONNECT_TIMEOUT_MS);
            connection.setReadTimeout(READ_TIMEOUT_MS);
            connection.setRequestProperty("Accept", "application/vnd.android.package-archive, application/octet-stream, */*");

            int status = connection.getResponseCode();
            if (
                status == HttpURLConnection.HTTP_MOVED_PERM ||
                status == HttpURLConnection.HTTP_MOVED_TEMP ||
                status == HttpURLConnection.HTTP_SEE_OTHER ||
                status == 307 ||
                status == 308
            ) {
                String location = connection.getHeaderField("Location");
                connection.disconnect();
                if (location == null || location.trim().isEmpty()) {
                    throw new DownloadException("Redirect without a target");
                }
                current = new URL(current, location.trim());
                continue;
            }
            return connection;
        }
        throw new DownloadException("Too many redirects");
    }

    private void downloadTo(URL url, File target, long expectedSize) throws IOException {
        long maxBytes = expectedSize + SIZE_TOLERANCE_BYTES;
        HttpURLConnection connection = openFollowingHttpsRedirects(url);
        try {
            int status = connection.getResponseCode();
            if (status < 200 || status >= 300) {
                throw new DownloadException("Server responded with HTTP " + status);
            }

            long contentLength = connection.getContentLengthLong();
            if (contentLength > maxBytes) {
                throw new DownloadException("Update file is larger than expected");
            }
            long total = contentLength > 0 ? contentLength : expectedSize;

            long received = 0L;
            long lastEmit = 0L;
            try (
                InputStream in = new BufferedInputStream(connection.getInputStream(), IO_BUFFER_SIZE);
                OutputStream out = new FileOutputStream(target)
            ) {
                byte[] buffer = new byte[IO_BUFFER_SIZE];
                int read;
                while ((read = in.read(buffer)) != -1) {
                    received += read;
                    if (received > maxBytes) {
                        throw new DownloadException("Update file is larger than expected");
                    }
                    out.write(buffer, 0, read);

                    long now = SystemClock.elapsedRealtime();
                    if (now - lastEmit >= PROGRESS_INTERVAL_MS) {
                        lastEmit = now;
                        emitProgress(received, total);
                    }
                }
            }
            emitProgress(received, total);
        } finally {
            connection.disconnect();
        }
    }

    /** Must be called on the UI thread (it starts Activities). */
    private void launchInstaller(PluginCall call, File apkFile, boolean fromCache) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getContext().getPackageManager().canRequestPackageInstalls()) {
                Intent settingsIntent = new Intent(
                    Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + getContext().getPackageName())
                );
                settingsIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                try {
                    getActivity().startActivity(settingsIntent);
                } catch (ActivityNotFoundException ex) {
                    Logger.warn(getLogTag(), "Unknown-app-sources settings screen is unavailable");
                }
                call.reject("Permission to install apps from this source is required", "need_permission");
                return;
            }

            Uri apkUri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".apkprovider", apkFile);
            Intent installIntent = new Intent(Intent.ACTION_VIEW);
            installIntent.setDataAndType(apkUri, "application/vnd.android.package-archive");
            installIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            installIntent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getActivity().startActivity(installIntent);

            JSObject result = new JSObject();
            result.put("status", "install_started");
            result.put("fromCache", fromCache);
            call.resolve(result);
        } catch (RuntimeException ex) { // includes ActivityNotFoundException
            Logger.warn(getLogTag(), "Unable to start the package installer: " + ex.getClass().getSimpleName());
            call.reject("Unable to start the package installer", "install_failed");
        }
    }

    private File stagedApkFile() throws IOException {
        File dir = new File(getContext().getCacheDir(), UPDATE_DIR_NAME);
        if (!dir.isDirectory() && !dir.mkdirs() && !dir.isDirectory()) {
            throw new DownloadException("Unable to create the update directory");
        }
        return new File(dir, UPDATE_FILE_NAME);
    }

    private static String sha256Of(File file) throws IOException, NoSuchAlgorithmException {
        MessageDigest digest = MessageDigest.getInstance("SHA-256");
        try (InputStream in = new FileInputStream(file)) {
            byte[] buffer = new byte[IO_BUFFER_SIZE];
            int read;
            while ((read = in.read(buffer)) != -1) {
                digest.update(buffer, 0, read);
            }
        }
        StringBuilder hex = new StringBuilder(64);
        for (byte b : digest.digest()) {
            hex.append(Character.forDigit((b >> 4) & 0xF, 16));
            hex.append(Character.forDigit(b & 0xF, 16));
        }
        return hex.toString();
    }

    private void emitProgress(long received, long total) {
        JSObject data = new JSObject();
        data.put("received", received);
        data.put("total", total);
        notifyListeners("progress", data);
    }

    private static void deleteQuietly(File file) {
        if (file == null) {
            return;
        }
        try {
            //noinspection ResultOfMethodCallIgnored
            file.delete();
        } catch (RuntimeException ignored) {
            // Best effort cleanup only.
        }
    }
}
