using Valour.Sdk.Models;

namespace AnathemaValourAdapter;

/// <summary>
/// Turns attachments into a short tag for chat, because neither Minecraft nor a
/// text bridge can show a file. A message that is only an attachment still needs
/// something to relay, otherwise it disappears silently.
/// </summary>
public static class AttachmentSummary
{
    public static string Describe(IEnumerable<MessageAttachment>? attachments)
    {
        if (attachments is null)
        {
            return string.Empty;
        }

        var list = attachments.Where(attachment => attachment is not null).ToList();
        if (list.Count == 0)
        {
            return string.Empty;
        }

        return list.Count > 1 ? $"[{list.Count} files]" : Label(list[0]!);
    }

    private static string Label(MessageAttachment attachment)
    {
        var mime = attachment.MimeType?.Trim().ToLowerInvariant() ?? string.Empty;
        var name = attachment.FileName?.Trim().ToLowerInvariant() ?? string.Empty;

        if (mime == "image/gif" || name.EndsWith(".gif", StringComparison.Ordinal))
        {
            return "[GIF]";
        }

        if (mime.StartsWith("image/", StringComparison.Ordinal))
        {
            return "[image]";
        }

        if (mime.StartsWith("video/", StringComparison.Ordinal))
        {
            return "[video]";
        }

        if (mime.StartsWith("audio/", StringComparison.Ordinal))
        {
            return "[audio]";
        }

        return "[file]";
    }
}
