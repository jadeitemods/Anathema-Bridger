package com.anathema.bridge;

import java.net.URI;
import java.net.URISyntaxException;

final class UriRedactor {
    private UriRedactor() {
    }

    static String redact(URI uri) {
        try {
            return new URI(
                    uri.getScheme(),
                    null,
                    uri.getHost(),
                    uri.getPort(),
                    uri.getPath(),
                    null,
                    null
            ).toString();
        } catch (URISyntaxException e) {
            return "<bridge endpoint>";
        }
    }
}
