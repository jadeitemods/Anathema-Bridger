package com.anathema.bridge;

import net.fabricmc.api.DedicatedServerModInitializer;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents;
import net.fabricmc.fabric.api.message.v1.ServerMessageEvents;
import net.minecraft.server.MinecraftServer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class AnathemaBridgeMod implements DedicatedServerModInitializer {
    public static final String MOD_ID = "anathema-bridge";
    public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

    // Written on the server thread, read from the bridge thread.
    private static volatile MinecraftServer server;
    private static BridgeClient bridgeClient;

    @Override
    public void onInitializeServer() {
        BridgeConfig.load();

        ServerLifecycleEvents.SERVER_STARTED.register(s -> {
            server = s;
            bridgeClient = new BridgeClient();
            bridgeClient.start();
        });

        ServerLifecycleEvents.SERVER_STOPPING.register(s -> {
            if (bridgeClient != null) {
                bridgeClient.stop();
                bridgeClient = null;
            }
            server = null;
        });

        ServerMessageEvents.CHAT_MESSAGE.register((message, sender, params) -> {
            if (sender == null) return;
            if (bridgeClient == null) return;

            String content = message.getContent().getString();

            // Do not bridge commands.
            if (content.startsWith("/")) return;

            bridgeClient.sendChat(sender.getName().getString(), content);
        });

        // Commands are audit information: the alerts channel sees them, the chat
        // platforms do not. Only player-issued commands count; console and command
        // blocks have no entity, and auditing our own `say` calls would be noise.
        ServerMessageEvents.COMMAND_MESSAGE.register((message, source, params) -> {
            if (source == null || bridgeClient == null) return;
            if (source.getEntity() == null) return;

            String command = message.getContent().getString().trim();
            if (command.isEmpty()) return;

            bridgeClient.sendCommand(source.getName(), command);
        });

        LOGGER.info("Anathema Bridge initialized.");
    }

    public static MinecraftServer getServer() {
        return server;
    }
}