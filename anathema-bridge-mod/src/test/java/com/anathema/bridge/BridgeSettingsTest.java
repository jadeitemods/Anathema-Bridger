package com.anathema.bridge;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNull;

class BridgeSettingsTest {

    @TempDir
    Path gameDir;

    @Test
    void readsLauncherProperties() throws IOException {
        Files.writeString(gameDir.resolve(BridgeSettings.LAUNCHER_PROPERTIES), """
                serverJar=server.jar
                anathema.bridge.url=wss://bridge.example.test/minecraft
                anathema.bridge.secret=launcher-secret
                """);

        assertEquals("wss://bridge.example.test/minecraft",
                BridgeSettings.fromLauncherProperties(gameDir, "url").text());
        assertEquals("launcher-secret",
                BridgeSettings.fromLauncherProperties(gameDir, "secret").text());
        assertEquals(BridgeSettings.LAUNCHER_PROPERTIES,
                BridgeSettings.fromLauncherProperties(gameDir, "secret").origin());
    }

    @Test
    void returnsNullWhenLauncherFileOrKeyMissing() throws IOException {
        assertNull(BridgeSettings.fromLauncherProperties(gameDir, "secret"));

        Files.writeString(gameDir.resolve(BridgeSettings.LAUNCHER_PROPERTIES), "serverJar=server.jar\n");
        assertNull(BridgeSettings.fromLauncherProperties(gameDir, "secret"));
    }

    @Test
    void readsWorldFile() throws IOException {
        Path world = Files.createDirectories(gameDir.resolve("world"));
        Files.writeString(world.resolve(BridgeSettings.WORLD_OVERRIDE), """
                { "url": "wss://world.example.test/minecraft", "secret": "world-secret" }
                """);

        assertEquals("wss://world.example.test/minecraft",
                BridgeSettings.fromWorldFile(gameDir, "url").text());
        assertEquals("world-secret", BridgeSettings.fromWorldFile(gameDir, "secret").text());
    }

    @Test
    void ignoresMalformedWorldFile() throws IOException {
        Path world = Files.createDirectories(gameDir.resolve("world"));
        Files.writeString(world.resolve(BridgeSettings.WORLD_OVERRIDE), "not json");

        assertNull(BridgeSettings.fromWorldFile(gameDir, "secret"));
    }

    @Test
    void systemPropertyWins() {
        System.setProperty("anathema.bridge.secret", "  property-secret  ");
        try {
            BridgeSettings.Value value = BridgeSettings.fromSystem("secret");

            assertEquals("property-secret", value.text());
            assertEquals("-Danathema.bridge.secret", value.origin());
        } finally {
            System.clearProperty("anathema.bridge.secret");
        }
    }

    @Test
    void blankValuesAreNull() {
        assertNull(BridgeSettings.trimToNull(null));
        assertNull(BridgeSettings.trimToNull("   "));
        assertEquals("value", BridgeSettings.trimToNull("  value "));
    }
}
