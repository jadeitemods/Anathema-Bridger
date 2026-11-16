package com.anathema.bridge;

import org.junit.jupiter.api.Test;

import java.net.URI;

import static org.junit.jupiter.api.Assertions.assertEquals;

class UriRedactorTest {

    @Test
    void stripsCredentialsQueryAndFragment() {
        URI endpoint = URI.create("ws://user:pass@example.test:3000/minecraft?secret=sample-secret&mode=test#fragment");

        assertEquals("ws://example.test:3000/minecraft", UriRedactor.redact(endpoint));
    }

    @Test
    void keepsHostAndPort() {
        URI endpoint = URI.create("ws://127.0.0.1:3000/minecraft");

        assertEquals("ws://127.0.0.1:3000/minecraft", UriRedactor.redact(endpoint));
    }
}
