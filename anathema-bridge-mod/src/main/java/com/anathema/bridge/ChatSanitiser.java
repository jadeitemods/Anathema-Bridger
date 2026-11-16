package com.anathema.bridge;

import java.util.Set;

/**
 * Cleans text that arrives from the bridge before it is shown to players.
 *
 * <p>Kept free of Minecraft types on purpose so it can be unit tested without a
 * game bootstrap.
 */
final class ChatSanitiser {
    /** Only these labels may appear as a chat prefix; anything else is replaced. */
    private static final Set<String> KNOWN_SOURCES = Set.of("Discord", "Valour", "Minecraft");

    private ChatSanitiser() {
    }

    /**
     * Restricts the chat prefix to a known set so a bridge peer cannot impersonate
     * the server or an admin.
     */
    static String source(String value) {
        String cleaned = clean(value, 16);
        return KNOWN_SOURCES.contains(cleaned) ? cleaned : "Bridge";
    }

    /**
     * Strips section signs and control characters, then clamps the length.
     *
     * <p>Section signs drive client-side formatting, so unescaped text from Discord or
     * Valour could otherwise recolour or garble chat for every player.
     */
    static String clean(String value, int maxLength) {
        if (value == null || maxLength < 1) return "";

        String cleaned = value
                .replace('\u00a7', ' ')
                .replaceAll("\\p{Cntrl}", "")
                .strip();

        if (cleaned.length() > maxLength) {
            cleaned = cleaned.substring(0, maxLength).strip() + "\u2026";
        }

        return cleaned;
    }
}
