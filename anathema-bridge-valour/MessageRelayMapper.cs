using Valour.Sdk.E2ee;

namespace AnathemaValourAdapter;

public sealed record RelayPayload(string Username, string Message);

public static class MessageRelayMapper
{
    public static bool TryMap(
        long targetChannelId,
        long incomingChannelId,
        string? username,
        string? content,
        string? attachmentSummary,
        MessageDecryptionState decryptionState,
        out RelayPayload? payload)
    {
        payload = null;
        if (incomingChannelId != targetChannelId ||
            decryptionState != MessageDecryptionState.Decrypted)
        {
            return false;
        }

        // Text and the attachment tag are combined here so an attachment-only post
        // still relays instead of vanishing.
        var text = string.Join(
            ' ',
            new[] { content?.Trim(), attachmentSummary?.Trim() }
                .Where(part => !string.IsNullOrWhiteSpace(part)));

        if (text.Length == 0)
        {
            return false;
        }

        var normalizedUsername = string.IsNullOrWhiteSpace(username) ? "ValourUser" : username.Trim();
        payload = new RelayPayload(normalizedUsername, text);
        return true;
    }
}
