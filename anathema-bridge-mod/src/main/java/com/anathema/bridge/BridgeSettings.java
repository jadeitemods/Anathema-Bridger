package com.anathema.bridge;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

import java.io.IOException;
import java.io.Reader;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;
import java.util.Properties;

/**
 * Finds bridge settings in the places a hosted server can actually provide them.
 *
 * <p>Managed hosts often allow uploads only to {@code mods/} and the world folder, so a
 * config file under {@code config/} may be impossible to place. These fallbacks keep the
 * mod configurable without that directory existing.
 *
 * <p>Deliberately free of Minecraft types so it can be unit tested.
 */
final class BridgeSettings {

    /** A setting plus where it came from, for logging without exposing the value. */
    record Value(String text, String origin) {
    }

    static final String LAUNCHER_PROPERTIES = "fabric-server-launcher.properties";
    static final String WORLD_OVERRIDE = "anathema-bridge.json";
    static final String PROPERTY_PREFIX = "anathema.bridge.";
    static final String ENVIRONMENT_PREFIX = "ANATHEMA_BRIDGE_";

    private BridgeSettings() {
    }

    /** Highest priority: JVM system property, then environment variable. */
    static Value fromSystem(String key) {
        String propertyName = PROPERTY_PREFIX + key;
        String value = trimToNull(System.getProperty(propertyName));
        if (value != null) {
            return new Value(value, "-D" + propertyName);
        }

        String environmentName = ENVIRONMENT_PREFIX + key.toUpperCase(Locale.ROOT);
        value = trimToNull(System.getenv(environmentName));
        if (value != null) {
            return new Value(value, "env " + environmentName);
        }

        return null;
    }

    /** The Fabric launcher's properties file lives in the server root and is upload-friendly. */
    static Value fromLauncherProperties(Path gameDir, String key) {
        Path file = gameDir.resolve(LAUNCHER_PROPERTIES);
        if (!Files.isRegularFile(file)) {
            return null;
        }

        Properties properties = new Properties();
        try (Reader reader = Files.newBufferedReader(file)) {
            properties.load(reader);
        } catch (IOException | IllegalArgumentException e) {
            System.getLogger("anathema-bridge").log(System.Logger.Level.WARNING,
                    "Could not read " + file + ": " + e);
            return null;
        }

        String value = trimToNull(properties.getProperty(PROPERTY_PREFIX + key));
        return value == null ? null : new Value(value, file.getFileName().toString());
    }

    /** Last resort: a small JSON file inside the world folder. */
    static Value fromWorldFile(Path gameDir, String key) {
        Path file = gameDir.resolve("world").resolve(WORLD_OVERRIDE);
        if (!Files.isRegularFile(file)) {
            return null;
        }

        try {
            JsonObject root = JsonParser.parseString(Files.readString(file)).getAsJsonObject();
            if (!root.has(key) || !root.get(key).isJsonPrimitive()) {
                return null;
            }

            String value = trimToNull(root.get(key).getAsString());
            return value == null ? null : new Value(value, "world/" + WORLD_OVERRIDE);
        } catch (Exception e) {
            System.getLogger("anathema-bridge").log(System.Logger.Level.WARNING,
                    "Could not read " + file + ": " + e);
            return null;
        }
    }

    static String trimToNull(String value) {
        if (value == null) {
            return null;
        }

        String trimmed = value.trim();
        return trimmed.isEmpty() ? null : trimmed;
    }
}
