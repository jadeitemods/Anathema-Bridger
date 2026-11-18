package com.anathema.bridge;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import net.minecraft.server.MinecraftServer;
import net.minecraft.text.MutableText;
import net.minecraft.text.Text;
import net.minecraft.util.Formatting;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.WebSocket;
import java.nio.ByteBuffer;
import java.time.Duration;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.Executors;
import java.util.concurrent.RejectedExecutionException;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.ThreadLocalRandom;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;

public class BridgeClient {
    private static final Gson GSON = new Gson();

    private static final Duration HANDSHAKE_TIMEOUT = Duration.ofSeconds(15);
    private static final long BASE_RECONNECT_SECONDS = 5;
    private static final long MAX_RECONNECT_SECONDS = 60;
    private static final long HEARTBEAT_SECONDS = 30;

    /** Refuse frames larger than this rather than growing a buffer until the server dies. */
    private static final int MAX_FRAME_CHARS = 64 * 1024;
    /** Back-pressure: stop queueing once this many sends are outstanding. */
    private static final int MAX_PENDING_SENDS = 100;

    private static final int MAX_USERNAME_LENGTH = 32;
    private static final int MAX_MESSAGE_LENGTH = 256;

    private final HttpClient httpClient = HttpClient.newHttpClient();
    private final ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor(runnable -> {
        Thread thread = new Thread(runnable, "anathema-bridge");
        thread.setDaemon(true);
        return thread;
    });

    private final AtomicInteger pendingSends = new AtomicInteger();

    private volatile WebSocket webSocket;
    private volatile boolean running = false;
    private volatile boolean reconnectScheduled = false;
    private volatile boolean disconnectLogged = false;

    private int reconnectAttempt = 0;
    private CompletableFuture<WebSocket> outbound = CompletableFuture.completedFuture(null);

    public void start() {
        if (!BridgeConfig.INSTANCE.enabled) {
            AnathemaBridgeMod.LOGGER.info("Anathema Bridge is disabled in config.");
            return;
        }

        running = true;
        connect();
        scheduler.scheduleWithFixedDelay(this::heartbeat, HEARTBEAT_SECONDS, HEARTBEAT_SECONDS, TimeUnit.SECONDS);
    }

    public void stop() {
        running = false;

        WebSocket ws = webSocket;
        if (ws != null) {
            try {
                ws.sendClose(WebSocket.NORMAL_CLOSURE, "shutdown");
            } catch (Exception ignored) {
            }
            ws.abort();
        }

        scheduler.shutdownNow();
    }

    private void connect() {
        if (!running) return;

        // Clear the pending flag as this attempt starts. Without this, a failed attempt
        // (for example a handshake timeout) leaves the flag set, every later
        // scheduleReconnect() returns early, and the mod never tries again.
        reconnectScheduled = false;

        String url = BridgeConfig.INSTANCE.bridgeUrl;
        String secret = BridgeConfig.INSTANCE.secret == null ? "" : BridgeConfig.INSTANCE.secret.trim();

        // Fail closed: a missing secret would otherwise mean an unauthenticated bridge.
        if (secret.isEmpty()) {
            AnathemaBridgeMod.LOGGER.error(
                    "Bridge secret is not configured. Either set 'secret' in config/anathema-bridge.json, "
                            + "or set 'sharedConfig' to the path of AnathemaBridger/config.json.");
            return;
        }

        URI endpoint;
        try {
            endpoint = URI.create(url);
        } catch (IllegalArgumentException e) {
            AnathemaBridgeMod.LOGGER.error("Bridge URL is not valid; not connecting.");
            return;
        }

        AnathemaBridgeMod.LOGGER.info("Connecting to bridge at {}", UriRedactor.redact(endpoint));

        httpClient.newWebSocketBuilder()
                // The secret travels in a header, not the query string, so it stays out of
                // URLs, logs and any proxy in between.
                .header("X-Bridge-Secret", secret)
                .buildAsync(endpoint, new WebSocket.Listener() {
                    private final StringBuilder buffer = new StringBuilder();

                    @Override
                    public void onOpen(WebSocket ws) {
                        webSocket = ws;
                        reconnectScheduled = false;
                        reconnectAttempt = 0;
                        disconnectLogged = false;
                        AnathemaBridgeMod.LOGGER.info("Connected to bridge.");

                        JsonObject hello = new JsonObject();
                        hello.addProperty("type", "hello");
                        hello.addProperty("client", "minecraft");
                        ws.sendText(GSON.toJson(hello), true);
                        ws.request(1);
                    }

                    @Override
                    public CompletionStage<?> onText(WebSocket ws, CharSequence data, boolean last) {
                        buffer.append(data);

                        if (buffer.length() > MAX_FRAME_CHARS) {
                            // A peer that sends this much is broken or hostile; drop it.
                            AnathemaBridgeMod.LOGGER.warn(
                                    "Bridge sent a frame larger than {} characters; closing the connection.",
                                    MAX_FRAME_CHARS);
                            buffer.setLength(0);
                            ws.abort();
                            scheduleReconnect();
                            return null;
                        }

                        if (last) {
                            String full = buffer.toString();
                            buffer.setLength(0);
                            handleMessage(full);
                        }

                        ws.request(1);
                        return null;
                    }

                    @Override
                    public CompletionStage<?> onClose(WebSocket ws, int statusCode, String reason) {
                        AnathemaBridgeMod.LOGGER.warn("Bridge connection closed: {} {}", statusCode, reason);
                        if (webSocket == ws) {
                            webSocket = null;
                        }
                        scheduleReconnect();
                        return null;
                    }

                    @Override
                    public void onError(WebSocket ws, Throwable error) {
                        AnathemaBridgeMod.LOGGER.error("Bridge WebSocket error: {}", error.toString());
                        if (webSocket == ws) {
                            webSocket = null;
                        }
                        scheduleReconnect();
                    }
                })
                // A blackholed handshake would otherwise hang forever with no reconnect.
                .orTimeout(HANDSHAKE_TIMEOUT.toSeconds(), TimeUnit.SECONDS)
                .whenComplete((ignored, error) -> {
                    if (error != null) {
                        AnathemaBridgeMod.LOGGER.error("Bridge handshake failed after {}s: {}",
                                HANDSHAKE_TIMEOUT.toSeconds(), error.toString());
                        scheduleReconnect();
                    }
                });
    }

    private void handleMessage(String json) {
        try {
            JsonObject obj = GSON.fromJson(json, JsonObject.class);
            if (obj == null) return;

            String type = obj.has("type") ? obj.get("type").getAsString() : "";
            if (!"chat".equals(type)) return;

            String source = ChatSanitiser.source(
                    obj.has("source") ? obj.get("source").getAsString() : "Bridge");

            String username = ChatSanitiser.clean(
                    obj.has("username") ? obj.get("username").getAsString() : "Unknown", MAX_USERNAME_LENGTH);
            String message = ChatSanitiser.clean(
                    obj.has("message") ? obj.get("message").getAsString() : "", MAX_MESSAGE_LENGTH);

            if (username.isEmpty() || message.isEmpty()) return;

            MinecraftServer server = AnathemaBridgeMod.getServer();
            if (server == null) return;

            try {
                server.execute(() -> {
                    MutableText prefix = Text.literal("[" + source + "]").formatted(Formatting.BOLD);
                    Text full = prefix.append(Text.literal(" " + username + ": " + message));
                    server.getPlayerManager().broadcast(full, false);
                });
            } catch (RejectedExecutionException e) {
                // The server is stopping; dropping the message is correct.
            }
        } catch (Exception e) {
            // Deliberately not logging the payload: it is attacker-controlled content.
            AnathemaBridgeMod.LOGGER.error("Failed to handle bridge message: {}", e.toString());
        }
    }

    public void sendChat(String username, String message) {
        send("chat", username, "message", message);
    }

    /** Player-issued commands go to the alerts channel, never to the chat platforms. */
    public void sendCommand(String username, String command) {
        send("command", username, "command", command);
    }

    private void send(String type, String username, String field, String value) {
        WebSocket ws = webSocket;
        if (!running || ws == null || ws.isOutputClosed()) {
            logDisconnectedOnce();
            return;
        }

        if (pendingSends.get() >= MAX_PENDING_SENDS) {
            AnathemaBridgeMod.LOGGER.warn("Dropping {} event: {} sends already queued to the bridge.", type, pendingSends.get());
            return;
        }

        JsonObject obj = new JsonObject();
        obj.addProperty("type", type);
        obj.addProperty("username", username);
        obj.addProperty(field, value);
        String payload = GSON.toJson(obj);

        // sendText throws while another send is pending, so chain sends instead of
        // firing them concurrently when players chat in a burst.
        CompletableFuture<WebSocket> queued;
        synchronized (this) {
            queued = outbound.handle((ignored, error) -> null)
                    .thenCompose(previous -> ws.sendText(payload, true));
            outbound = queued;
        }

        pendingSends.incrementAndGet();
        queued.whenComplete((ignored, error) -> {
            pendingSends.decrementAndGet();
            if (error != null) {
                AnathemaBridgeMod.LOGGER.warn("Bridge send failed: {}", error.toString());
            }
        });
    }

    private void heartbeat() {
        WebSocket ws = webSocket;
        if (!running || ws == null || ws.isOutputClosed()) return;

        // No pong handling needed: a dead socket fails the write, which triggers a reconnect.
        ws.sendPing(ByteBuffer.wrap(new byte[] {1}))
                .whenComplete((ignored, error) -> {
                    if (error != null) {
                        AnathemaBridgeMod.LOGGER.warn("Bridge heartbeat failed: {}", error.toString());
                        ws.abort();
                        scheduleReconnect();
                    }
                });
    }

    private void logDisconnectedOnce() {
        if (disconnectLogged) return;
        disconnectLogged = true;
        AnathemaBridgeMod.LOGGER.warn("Bridge is not connected; chat is not being forwarded.");
    }

    private synchronized void scheduleReconnect() {
        if (!running || reconnectScheduled) return;

        reconnectScheduled = true;
        reconnectAttempt++;

        long backoffSeconds = Math.min(
                MAX_RECONNECT_SECONDS,
                BASE_RECONNECT_SECONDS << Math.min(reconnectAttempt - 1, 5));
        long delayMillis = backoffSeconds * 1000 + ThreadLocalRandom.current().nextLong(0, 1000);

        AnathemaBridgeMod.LOGGER.info("Reconnecting to bridge in {} ms (attempt {}).", delayMillis, reconnectAttempt);
        scheduler.schedule(this::connect, delayMillis, TimeUnit.MILLISECONDS);
    }
}
