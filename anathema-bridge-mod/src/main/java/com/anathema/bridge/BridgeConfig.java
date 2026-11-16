package com.anathema.bridge;

import com.google.gson.Gson;
import com.google.gson.GsonBuilder;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import net.fabricmc.loader.api.FabricLoader;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

public class BridgeConfig {
    private static final Gson GSON = new GsonBuilder().setPrettyPrinting().create();
    private static final Path CONFIG_PATH = FabricLoader.getInstance()
            .getConfigDir()
            .resolve("anathema-bridge.json");

    /** Environment override, handy when the server is launched by a script. */
    private static final String SHARED_CONFIG_ENV = "ANATHEMA_CONFIG";

    static final String DEFAULT_BRIDGE_URL = "ws://127.0.0.1:3000/minecraft";

    public String bridgeUrl = DEFAULT_BRIDGE_URL;
    // Intentionally empty: the secret is per-deployment and must never ship in source.
    // The client refuses to connect until this is filled in.
    public String secret = "";
    /**
     * Path to the shared AnathemaBridger config.json. When set, the secret and bridge
     * address are read from there instead, so the bridge, adapter and mod all follow
     * one file.
     */
    public String sharedConfig = "";
    public boolean enabled = true;

    public static BridgeConfig INSTANCE;

    public static void load() {
        try {
            if (Files.exists(CONFIG_PATH)) {
                String json = Files.readString(CONFIG_PATH);
                INSTANCE = GSON.fromJson(json, BridgeConfig.class);
                if (INSTANCE == null) {
                    INSTANCE = new BridgeConfig();
                }
            } else {
                INSTANCE = new BridgeConfig();
                save();
            }
        } catch (Exception e) {
            AnathemaBridgeMod.LOGGER.error("Failed to load Anathema Bridge config, using defaults.", e);
            INSTANCE = new BridgeConfig();
        }

        applySharedConfig();
        applyOverrides();
    }

    /**
     * Applies settings from JVM properties, environment variables, the Fabric launcher
     * properties file, or the world folder. Hosted servers often cannot accept a file
     * under {@code config/}, so the mod must be configurable without one.
     */
    private static void applyOverrides() {
        Path gameDir = FabricLoader.getInstance().getGameDir();

        BridgeSettings.Value url = BridgeSettings.fromSystem("url");
        BridgeSettings.Value secret = BridgeSettings.fromSystem("secret");

        boolean secretMissing = INSTANCE.secret == null || INSTANCE.secret.isBlank();
        if (secret == null && secretMissing) {
            secret = BridgeSettings.fromLauncherProperties(gameDir, "secret");
            if (secret == null) {
                secret = BridgeSettings.fromWorldFile(gameDir, "secret");
            }
        }

        boolean urlIsDefault = DEFAULT_BRIDGE_URL.equals(INSTANCE.bridgeUrl);
        if (url == null && urlIsDefault) {
            url = BridgeSettings.fromLauncherProperties(gameDir, "url");
            if (url == null) {
                url = BridgeSettings.fromWorldFile(gameDir, "url");
            }
        }

        if (url != null) {
            INSTANCE.bridgeUrl = url.text();
            AnathemaBridgeMod.LOGGER.info("Bridge address loaded from {}.", url.origin());
        }

        if (secret != null) {
            // The value itself is never logged.
            INSTANCE.secret = secret.text();
            AnathemaBridgeMod.LOGGER.info("Bridge secret loaded from {}.", secret.origin());
        }
    }

    /**
     * Overlays the shared config.json on top of this file. Failure is not fatal: the
     * mod falls back to its own settings and says why.
     */
    private static void applySharedConfig() {
        String candidate = System.getenv(SHARED_CONFIG_ENV);
        if (candidate == null || candidate.isBlank()) {
            candidate = INSTANCE.sharedConfig;
        }

        if (candidate == null || candidate.isBlank()) {
            return;
        }

        Path sharedPath;
        try {
            sharedPath = Path.of(candidate);
        } catch (Exception e) {
            AnathemaBridgeMod.LOGGER.error("Shared config path '{}' is not usable: {}", candidate, e.toString());
            return;
        }

        if (!Files.exists(sharedPath)) {
            AnathemaBridgeMod.LOGGER.warn("Shared config {} does not exist; using this mod's own settings.", sharedPath);
            return;
        }

        try {
            JsonObject root = JsonParser.parseString(Files.readString(sharedPath)).getAsJsonObject();
            if (!root.has("bridge") || !root.get("bridge").isJsonObject()) {
                AnathemaBridgeMod.LOGGER.warn("Shared config {} has no \"bridge\" section.", sharedPath);
                return;
            }

            JsonObject bridge = root.getAsJsonObject("bridge");

            if (bridge.has("secret") && bridge.get("secret").isJsonPrimitive()) {
                INSTANCE.secret = bridge.get("secret").getAsString();
            }

            int port = bridge.has("websocketPort") ? bridge.get("websocketPort").getAsInt() : 3000;
            String path = bridge.has("websocketPath") ? bridge.get("websocketPath").getAsString() : "/minecraft";
            INSTANCE.bridgeUrl = "ws://127.0.0.1:" + port + path;

            AnathemaBridgeMod.LOGGER.info("Loaded bridge settings from shared config {}.", sharedPath);
        } catch (Exception e) {
            AnathemaBridgeMod.LOGGER.error("Could not read shared config {}: {}", sharedPath, e.toString());
        }
    }

    public static void save() {
        try {
            Files.createDirectories(CONFIG_PATH.getParent());
            Files.writeString(CONFIG_PATH, GSON.toJson(INSTANCE));
        } catch (IOException e) {
            AnathemaBridgeMod.LOGGER.error("Failed to save Anathema Bridge config.", e);
        }
    }
}
