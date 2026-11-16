using AnathemaValourAdapter;
using Valour.Sdk.E2ee;
using Xunit;

namespace AnathemaValourAdapter.Tests;

public class MessageRelayMapperTests
{
    private const long TargetChannelId = 47924572231303168;

    [Fact]
    public void MapsDecryptedMessageFromConfiguredChannel()
    {
        var mapped = MessageRelayMapper.TryMap(
            TargetChannelId,
            TargetChannelId,
            "Anathema_Core",
            "relay-probe",
            null,
            MessageDecryptionState.Decrypted,
            out var payload);

        Assert.True(mapped);
        Assert.Equal(new RelayPayload("Anathema_Core", "relay-probe"), payload);
    }

    [Fact]
    public void IgnoresMessagesFromOtherChannels()
    {
        var mapped = MessageRelayMapper.TryMap(
            TargetChannelId,
            TargetChannelId + 1,
            "Anathema_Core",
            "not-for-this-bridge",
            null,
            MessageDecryptionState.Decrypted,
            out var payload);

        Assert.False(mapped);
        Assert.Null(payload);
    }

    [Fact]
    public void IgnoresMessagesThatAreNotDecrypted()
    {
        var mapped = MessageRelayMapper.TryMap(
            TargetChannelId,
            TargetChannelId,
            "Anathema_Core",
            "encrypted-content-not-ready",
            null,
            MessageDecryptionState.WaitingForKey,
            out var payload);

        Assert.False(mapped);
        Assert.Null(payload);
    }

    [Fact]
    public void RelaysAttachmentOnlyMessage()
    {
        var mapped = MessageRelayMapper.TryMap(
            TargetChannelId,
            TargetChannelId,
            "Anathema_Core",
            "   ",
            "[image]",
            MessageDecryptionState.Decrypted,
            out var payload);

        Assert.True(mapped);
        Assert.Equal(new RelayPayload("Anathema_Core", "[image]"), payload);
    }

    [Fact]
    public void CombinesTextAndAttachmentTag()
    {
        var mapped = MessageRelayMapper.TryMap(
            TargetChannelId,
            TargetChannelId,
            "Anathema_Core",
            "look at this",
            "[GIF]",
            MessageDecryptionState.Decrypted,
            out var payload);

        Assert.True(mapped);
        Assert.Equal(new RelayPayload("Anathema_Core", "look at this [GIF]"), payload);
    }

    [Fact]
    public void IgnoresEmptyMessagesWithoutAttachments()
    {
        var mapped = MessageRelayMapper.TryMap(
            TargetChannelId,
            TargetChannelId,
            "Anathema_Core",
            "  ",
            "",
            MessageDecryptionState.Decrypted,
            out var payload);

        Assert.False(mapped);
        Assert.Null(payload);
    }
}
