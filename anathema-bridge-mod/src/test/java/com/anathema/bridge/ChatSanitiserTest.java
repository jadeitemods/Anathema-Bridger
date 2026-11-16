package com.anathema.bridge;

import org.junit.jupiter.api.Test;

import static org.junit.jupiter.api.Assertions.assertEquals;

class ChatSanitiserTest {

    @Test
    void acceptsKnownSources() {
        assertEquals("Discord", ChatSanitiser.source("Discord"));
        assertEquals("Valour", ChatSanitiser.source("Valour"));
        assertEquals("Minecraft", ChatSanitiser.source("Minecraft"));
    }

    @Test
    void replacesUnknownSources() {
        assertEquals("Bridge", ChatSanitiser.source("Server"));
        assertEquals("Bridge", ChatSanitiser.source(""));
        assertEquals("Bridge", ChatSanitiser.source(null));
    }

    @Test
    void stripsSectionSignsAndControlCharacters() {
        assertEquals("hello cworld", ChatSanitiser.clean("hello\u00a7cworld", 64));
        assertEquals("lineonelinetwo", ChatSanitiser.clean("lineone\nlinetwo", 64));
        assertEquals("bell", ChatSanitiser.clean("bell\u0007", 64));
    }

    @Test
    void trimsAndClampsLongText() {
        String clamped = ChatSanitiser.clean("x".repeat(300), 32);

        assertEquals(33, clamped.length(), "32 characters plus the ellipsis");
        assertEquals("\u2026", clamped.substring(32));
    }

    @Test
    void handlesEmptyInput() {
        assertEquals("", ChatSanitiser.clean(null, 32));
        assertEquals("", ChatSanitiser.clean("anything", 0));
    }
}
