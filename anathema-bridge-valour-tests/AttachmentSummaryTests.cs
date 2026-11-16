using AnathemaValourAdapter;
using Valour.Sdk.Models;
using Xunit;

namespace AnathemaValourAdapter.Tests;

public class AttachmentSummaryTests
{
    [Fact]
    public void DescribesSingleImage()
    {
        Assert.Equal("[image]", AttachmentSummary.Describe([Attachment("image/png", "shot.png")]));
    }

    [Fact]
    public void DescribesGifByMimeOrExtension()
    {
        Assert.Equal("[GIF]", AttachmentSummary.Describe([Attachment("image/gif", "loop.gif")]));
        Assert.Equal("[GIF]", AttachmentSummary.Describe([Attachment("", "loop.gif")]));
    }

    [Fact]
    public void DescribesVideoAndAudio()
    {
        Assert.Equal("[video]", AttachmentSummary.Describe([Attachment("video/mp4", "clip.mp4")]));
        Assert.Equal("[audio]", AttachmentSummary.Describe([Attachment("audio/ogg", "voice.ogg")]));
    }

    [Fact]
    public void DescribesUnknownTypesAsFile()
    {
        Assert.Equal("[file]", AttachmentSummary.Describe([Attachment("application/pdf", "notes.pdf")]));
        Assert.Equal("[file]", AttachmentSummary.Describe([Attachment(null, null)]));
    }

    [Fact]
    public void CountsMultipleAttachments()
    {
        Assert.Equal("[3 files]", AttachmentSummary.Describe(
        [
            Attachment("image/png", "a.png"),
            Attachment("image/png", "b.png"),
            Attachment("video/mp4", "c.mp4"),
        ]));
    }

    [Fact]
    public void HandlesNoAttachments()
    {
        Assert.Equal(string.Empty, AttachmentSummary.Describe(null));
        Assert.Equal(string.Empty, AttachmentSummary.Describe([]));
    }

    private static MessageAttachment Attachment(string? mimeType, string? fileName)
    {
        return new MessageAttachment
        {
            MimeType = mimeType,
            FileName = fileName,
        };
    }
}
