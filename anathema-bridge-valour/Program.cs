using System.Collections.Concurrent;
using System.Diagnostics;
using System.Net;
using System.Net.Http.Json;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;
using Valour.Sdk.Client;
using Valour.Sdk.E2ee;
using Valour.Sdk.Models;
using AnathemaValourAdapter;

// Every SDK call below is bounded so a stall surfaces as an error instead of silence.
var stepTimeout = TimeSpan.FromSeconds(
    double.TryParse(Environment.GetEnvironmentVariable("VALOUR_STEP_TIMEOUT_SECONDS"), out var configured)
        ? configured
        : 45);

var runStarted = Stopwatch.StartNew();

void Step(string message) =>
    Console.WriteLine($"[{DateTime.Now:HH:mm:ss.fff} +{runStarted.ElapsedMilliseconds}ms] {message}");

static async Task RunBoundedVoid(Task task, string label, TimeSpan stepTimeout)
{
    try
    {
        await task.WaitAsync(stepTimeout);
    }
    catch (TimeoutException)
    {
        Console.Error.WriteLine(
            $"[Valour] {label}: no result after {stepTimeout.TotalSeconds:0}s. The SDK is stalled inside this call.");
        throw;
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine($"[Valour] {label}: {ex.GetType().Name}: {ex.Message}");
        throw;
    }
}

async Task<T> RunBounded<T>(Task<T> task, string label, TimeSpan stepTimeout)
{
    try
    {
        var result = await task.WaitAsync(stepTimeout);
        return result;
    }
    catch (TimeoutException)
    {
        Console.Error.WriteLine(
            $"[Valour] {label}: no result after {stepTimeout.TotalSeconds:0}s. The SDK is stalled inside this call.");
        throw;
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine($"[Valour] {label}: {ex.GetType().Name}: {ex.Message}");
        throw;
    }
}

// Keep the SDK's E2EE key store in this project directory so it survives restarts.
var projectRoot = Path.GetFullPath(Path.Combine(AppContext.BaseDirectory, "..", "..", ".."));
Directory.SetCurrentDirectory(projectRoot);

// ---------- Shared configuration ----------
// One file, ../config.json, drives the bridge, this adapter and the Fabric mod.
var configPath = Environment.GetEnvironmentVariable("ANATHEMA_CONFIG")
    ?? Path.GetFullPath(Path.Combine(projectRoot, "..", "config.json"));

if (!File.Exists(configPath))
{
    Console.Error.WriteLine($"[Config] missing {configPath}. Copy config.example.json to config.json and fill it in.");
    return 1;
}

JsonElement root;
try
{
    using var document = JsonDocument.Parse(File.ReadAllText(configPath));
    root = document.RootElement.Clone();
}

catch (JsonException ex)
{
    Console.Error.WriteLine($"[Config] {configPath} is not valid JSON: {ex.Message}");
    return 1;
}

string? Required(JsonElement parent, string name, string key)
{
    if (parent.ValueKind == JsonValueKind.Object &&
        parent.TryGetProperty(name, out var value) &&
        value.ValueKind == JsonValueKind.String &&
        !string.IsNullOrWhiteSpace(value.GetString()))
    {
        return value.GetString();
    }

    Console.Error.WriteLine($"[Config] required setting \"{key}\" is missing or empty in {configPath}");
    return null;
}

var configRoot = root.ValueKind == JsonValueKind.Object ? root : default;

var valourSection = configRoot.TryGetProperty("valour", out var valourElement) ? valourElement : default;
var bridgeSection = configRoot.TryGetProperty("bridge", out var bridgeElement) ? bridgeElement : default;

var token = Required(valourSection, "botToken", "valour.botToken");
var channelText = Required(valourSection, "targetChannelId", "valour.targetChannelId");
var planetText = Required(valourSection, "planetId", "valour.planetId");
var bridgeSecret = Required(bridgeSection, "secret", "bridge.secret");

if (token is null || channelText is null || planetText is null || bridgeSecret is null)
{
    return 1;
}

if (!long.TryParse(channelText, out var targetChannelId))
{
    Console.Error.WriteLine("[Config] valour.targetChannelId must be a numeric channel id.");
    return 1;
}

if (!long.TryParse(planetText, out var targetPlanetId))
{
    Console.Error.WriteLine("[Config] valour.planetId must be a numeric planet id.");
    return 1;
}

int Port(string name, int fallback) =>
    bridgeSection.ValueKind == JsonValueKind.Object &&
    bridgeSection.TryGetProperty(name, out var value) &&
    value.TryGetInt32(out var port)
        ? port
        : fallback;

var valourIngressPort = Port("valourIngressPort", 3001);
var valourSendPort = Port("valourSendPort", 3002);
var nodeIngressUrl = $"http://127.0.0.1:{valourIngressPort}/valour/messages";
var valourCommandUrl = $"http://127.0.0.1:{valourIngressPort}/valour/command";

// Valour members allowed to run !bridger commands; empty means nobody.
var allowedValourUsers = new HashSet<string>(StringComparer.Ordinal);
if (configRoot.TryGetProperty("control", out var controlSection) &&
    controlSection.ValueKind == JsonValueKind.Object &&
    controlSection.TryGetProperty("valourUserIds", out var valourIds) &&
    valourIds.ValueKind == JsonValueKind.Array)
{
    foreach (var entry in valourIds.EnumerateArray())
    {
        if (entry.ValueKind == JsonValueKind.String && !string.IsNullOrWhiteSpace(entry.GetString()))
        {
            allowedValourUsers.Add(entry.GetString()!);
        }
        else if (entry.ValueKind == JsonValueKind.Number)
        {
            allowedValourUsers.Add(entry.GetRawText());
        }
    }
}

// Commands are only accepted from the alerts channel; everything else is chat.
long alertsChannelId = 0;
if (configRoot.TryGetProperty("consolealerts", out var alertsSection) &&
    alertsSection.ValueKind == JsonValueKind.Object &&
    alertsSection.TryGetProperty("valourChannelId", out var alertsValue))
{
    if (alertsValue.ValueKind == JsonValueKind.String)
    {
        long.TryParse(alertsValue.GetString(), out alertsChannelId);
    }
    else if (alertsValue.ValueKind == JsonValueKind.Number)
    {
        alertsChannelId = alertsValue.GetInt64();
    }
}

Step($"config: {configPath}");
Step($"config: channel={targetChannelId} planet={targetPlanetId} ingress={valourIngressPort} send={valourSendPort}");

var client = new ValourClient("https://api.valour.gg/");
client.SetupHttpClient();
Step("client: SetupHttpClient done");

Valour.Sdk.Models.Planet planet;
Valour.Sdk.Models.Channel channel;

try
{
    var login = await RunBounded(client.InitializeUser(token), "InitializeUser", stepTimeout);
    if (!login.Success)
    {
        Console.Error.WriteLine("Valour bot login failed. Check the local bot token; it is not printed here.");
        return 1;
    }

    Step($"login: ok as {client.Me.Name} (ID {client.Me.Id})");

    var joined = client.PlanetService.JoinedPlanets.FirstOrDefault(p => p.Id == targetPlanetId);
    Step($"planets: {client.PlanetService.JoinedPlanets.Count} joined, target {(joined is null ? "missing" : "found")}");
    if (joined is null)
    {
        Console.Error.WriteLine($"[Valour] Bot is not joined to target planet {targetPlanetId}.");
        return 1;
    }

    planet = joined;

    await RunBoundedVoid(planet.EnsureReadyAsync(), "EnsureReadyAsync", stepTimeout);

    var initialData = await RunBounded(planet.FetchInitialDataAsync(), "FetchInitialDataAsync", stepTimeout);
    if (!initialData.Success)
    {
        Console.Error.WriteLine("[Valour] Could not load planet data.");
        return 1;
    }

    var found = planet.Channels.FirstOrDefault(c => c.Id == targetChannelId);
    if (found is null)
    {
        Console.Error.WriteLine($"[Valour] Channel {targetChannelId} was not found in planet {targetPlanetId}.");
        return 1;
    }

    channel = found;

    var openResult = await RunBounded(channel.OpenWithResult(client.Me.Name), "OpenWithResult", stepTimeout);
    if (!openResult.Success)
    {
        Console.Error.WriteLine("[Valour] Could not open the target chat channel; check the bot's channel access.");
        return 1;
    }

    Step("channel: opened");
}
catch (TimeoutException)
{
    Console.Error.WriteLine("[Valour] Aborting: startup stall. No realtime listener was established.");
    return 1;
}

var seenMessageIds = new ConcurrentDictionary<long, byte>();
var authorNames = new ConcurrentDictionary<long, string>();
using var httpClient = new HttpClient();

async Task ForwardValourCommandAsync(string text, string username, long userId)
{
    using var command = new HttpRequestMessage(HttpMethod.Post, valourCommandUrl);
    command.Headers.TryAddWithoutValidation("X-Bridge-Secret", bridgeSecret);
    command.Content = JsonContent.Create(new { username, userId = userId.ToString(), text });

    try
    {
        using var response = await httpClient.SendAsync(command);
        Console.WriteLine(response.IsSuccessStatusCode
            ? $"[Valour] command from {username}: {text}"
            : $"[Valour] command from {username} rejected by the bridge (HTTP {(int)response.StatusCode}).");
    }
    catch (HttpRequestException)
    {
        Console.Error.WriteLine("[Valour] could not reach the local bridge for that command.");
    }
}

async Task HandleMessageAsync(Message incoming)
{
    if (incoming.PlanetId != targetPlanetId || incoming.AuthorUserId == client.Me.Id)
    {
        return;
    }

    var username = incoming.OverrideName;
    if (string.IsNullOrWhiteSpace(username))
    {
        // One API call per author, not per message: chat volume would otherwise turn
        // into a lookup for every line.
        if (!authorNames.TryGetValue(incoming.AuthorUserId, out username))
        {
            try
            {
                username = (await incoming.FetchAuthorAsync())?.Name;
            }
            catch
            {
            }

            if (!string.IsNullOrWhiteSpace(username))
            {
                authorNames[incoming.AuthorUserId] = username;
            }
        }
    }
    username ??= $"ValourUser-{incoming.AuthorUserId}";

    // Commands are handled here rather than relayed as chat, and only from whitelisted
    // users in the alerts channel.
    var commandText = incoming.Content?.Trim();
    if (commandText is not null && commandText.StartsWith("!bridger", StringComparison.OrdinalIgnoreCase))
    {
        if (alertsChannelId > 0 && incoming.ChannelId == alertsChannelId &&
            allowedValourUsers.Contains(incoming.AuthorUserId.ToString()))
        {
            await ForwardValourCommandAsync(commandText, username, incoming.AuthorUserId);
        }

        return;
    }

    if (!MessageRelayMapper.TryMap(
            targetChannelId,
            incoming.ChannelId,
            username,
            incoming.Content,
            AttachmentSummary.Describe(incoming.Attachments),
            incoming.DecryptionState,
            out var payload) || payload is null)
    {
        return;
    }

    if (!seenMessageIds.TryAdd(incoming.Id, 0))
    {
        return;
    }

    using var request = new HttpRequestMessage(HttpMethod.Post, nodeIngressUrl);
    request.Headers.TryAddWithoutValidation("X-Bridge-Secret", bridgeSecret);
    request.Content = JsonContent.Create(new { username = payload.Username, message = payload.Message });

    try
    {
        using var response = await httpClient.SendAsync(request);
        if (response.IsSuccessStatusCode)
        {
            Console.WriteLine("[Valour -> Discord] Local bridge accepted the message.");
        }
        else
        {
            Console.Error.WriteLine($"[Valour -> Discord] Local bridge returned HTTP {(int)response.StatusCode}.");
        }
    }
    catch (HttpRequestException)
    {
        Console.Error.WriteLine("[Valour -> Discord] Could not reach the local Node ingress.");
    }
}

client.MessageService.MessageReceived += HandleMessageAsync;
client.MessageService.MessageDecrypted += HandleMessageAsync;

Console.WriteLine($"[Valour] Listening on #{channel.Name} (channel {targetChannelId}).");
Console.WriteLine("[Valour] Forwarding enabled.");
Console.WriteLine($"[Valour] Command whitelist: {allowedValourUsers.Count} user(s).");

// Extra channels are opened on demand: alerts live in their own channel, and opening
// it is what gives the SDK the keys it needs to post there.
var openChannels = new ConcurrentDictionary<long, Channel>();
openChannels[targetChannelId] = channel;

// Failed channels are remembered briefly so a wrong id does not trigger a full channel
// refetch on every alert.
var channelRetryAfter = new ConcurrentDictionary<long, DateTime>();

async Task<Channel> GetOpenChannelAsync(long channelId)
{
    if (openChannels.TryGetValue(channelId, out var cached))
    {
        return cached;
    }

    if (channelRetryAfter.TryGetValue(channelId, out var retryAfter) && DateTime.UtcNow < retryAfter)
    {
        throw new InvalidOperationException($"channel {channelId} failed recently; retrying after {retryAfter:HH:mm:ss} UTC");
    }

    // Refresh first: a channel created after login is not in the cache yet.
    await planet.FetchChannelsAsync();

    var fetched = planet.Channels.FirstOrDefault(c => c.Id == channelId);

    // Direct fetch with skipCache: a channel created after login may not be in the cache.
    fetched ??= await client.ChannelService.FetchPlanetChannelAsync(channelId, planet, true);

    if (fetched is null)
    {
        // Classify the failure: a thread id looks like a channel id but never appears in
        // the channel list, and posting needs a different path entirely.
        var thread = await client.ThreadService.FetchThreadAsync(targetPlanetId, channelId, true);
        if (thread is not null)
        {
            throw new InvalidOperationException(
                $"id {channelId} is a thread ('{thread.Title}'), not a channel; posting there needs thread support.");
        }

        var visible = string.Join(", ", planet.Channels.Select(c => $"{c.Name} ({c.Id})"));
        channelRetryAfter[channelId] = DateTime.UtcNow.AddSeconds(60);
        throw new InvalidOperationException(
            $"channel {channelId} is not visible to the bot in planet {targetPlanetId} " +
            $"(not a thread either). {planet.Channels.Count} visible channels: {visible}");
    }

    var opened = await fetched.OpenWithResult(client.Me.Name);
    if (!opened.Success)
    {
        channelRetryAfter[channelId] = DateTime.UtcNow.AddSeconds(60);
        throw new InvalidOperationException($"could not open channel {channelId}: {opened.Message}");
    }

    openChannels[channelId] = fetched;
    Console.WriteLine($"[Valour] Opened extra channel #{fetched.Name} ({channelId}).");
    return fetched;
}

// Open the alerts channel up front so its messages reach us; commands are only
// accepted there.
if (alertsChannelId > 0 && alertsChannelId != targetChannelId)
{
    try
    {
        var alertsChannel = await GetOpenChannelAsync(alertsChannelId);
        Console.WriteLine($"[Valour] Commands accepted in #{alertsChannel.Name}.");
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine($"[Valour] alerts channel unavailable: {ex.Message}");
    }
}

// ---------- Local send ingress: Discord/Minecraft -> Valour ----------
// The target channel is E2EE, so only this process (which holds the SDK keys) can post to it.
// The Node bridge POSTs here instead of calling the Valour REST API directly.
var sendPort = valourSendPort;

var sendIngress = new TcpListener(IPAddress.Loopback, sendPort);
sendIngress.Start();
Console.WriteLine($"[Valour] Send ingress listening on http://127.0.0.1:{sendPort}/valour/send");
Console.WriteLine($"[Valour] Target channel encrypted: {channel.IsEncrypted}.");

_ = Task.Run(async () =>
{
    while (true)
    {
        TcpClient connection;
        try
        {
            connection = await sendIngress.AcceptTcpClientAsync();
        }
        catch (ObjectDisposedException)
        {
            return;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[Valour <-] accept failed: {ex.GetType().Name}: {ex.Message}");
            return;
        }

        _ = Task.Run(() => HandleSendConnectionAsync(connection));
    }
});

async Task HandleSendConnectionAsync(TcpClient connection)
{
    using var _ = connection;
    var stream = connection.GetStream();

    try
    {
        var (headerText, body) = await ReadHttpRequestAsync(stream);
        var requestLine = headerText.Split("\r\n")[0];
        var parts = requestLine.Split(' ');

        if (parts.Length < 2 || !parts[1].Equals("/valour/send", StringComparison.OrdinalIgnoreCase))
        {
            await WriteHttpResponseAsync(stream, 404, "not found");
            return;
        }

        if (!parts[0].Equals("POST", StringComparison.Ordinal))
        {
            await WriteHttpResponseAsync(stream, 405, "POST only");
            return;
        }

        if (!HeaderValue(headerText, "X-Bridge-Secret").Equals(bridgeSecret, StringComparison.Ordinal) ||
            string.IsNullOrEmpty(bridgeSecret))
        {
            await WriteHttpResponseAsync(stream, 401, "bad secret");
            return;
        }

        string? message = null;
        long requestedChannelId = 0;
        try
        {
            using var document = JsonDocument.Parse(body);
            if (document.RootElement.ValueKind == JsonValueKind.Object)
            {
                if (document.RootElement.TryGetProperty("message", out var value))
                {
                    message = value.GetString();
                }

                if (document.RootElement.TryGetProperty("channelId", out var channelValue))
                {
                    if (channelValue.ValueKind == JsonValueKind.String)
                    {
                        long.TryParse(channelValue.GetString(), out requestedChannelId);
                    }
                    else if (channelValue.ValueKind == JsonValueKind.Number)
                    {
                        requestedChannelId = channelValue.GetInt64();
                    }
                }
            }
        }
        catch (JsonException)
        {
            await WriteHttpResponseAsync(stream, 400, "body is not valid JSON");
            return;
        }

        if (string.IsNullOrWhiteSpace(message))
        {
            await WriteHttpResponseAsync(stream, 400, "message is empty");
            return;
        }

        if (message.Length > 1800)
        {
            // Valour rejects oversized messages; fail here with a clear reason.
            await WriteHttpResponseAsync(stream, 400, "message longer than 1800 characters");
            return;
        }

        var target = requestedChannelId > 0 && requestedChannelId != targetChannelId
            ? await GetOpenChannelAsync(requestedChannelId)
            : channel;

        var sendResult = await target.SendMessageAsync(message, null!, null!);
        if (!sendResult.Success)
        {
            Console.Error.WriteLine($"[Valour <-] send failed: {sendResult.Message} {sendResult.Details}");
            await WriteHttpResponseAsync(stream, 502, sendResult.Message ?? "Valour rejected the message");
            return;
        }

        Console.WriteLine($"[Bridge -> Valour] Posted to #{target.Name} ({target.Id}).");
        await WriteHttpResponseAsync(stream, 204, string.Empty);
    }
    catch (Exception ex)
    {
        Console.Error.WriteLine($"[Valour <-] {ex.GetType().Name}: {ex.Message}");
        try
        {
            await WriteHttpResponseAsync(stream, 500, "internal error");
        }
        catch
        {
            // The client is gone; nothing useful left to do.
        }
    }
}

static string HeaderValue(string headerText, string name)
{
    foreach (var line in headerText.Split("\r\n"))
    {
        var separator = line.IndexOf(':');
        if (separator <= 0)
        {
            continue;
        }

        if (line[..separator].Trim().Equals(name, StringComparison.OrdinalIgnoreCase))
        {
            return line[(separator + 1)..].Trim();
        }
    }

    return string.Empty;
}

static async Task<(string HeaderText, string Body)> ReadHttpRequestAsync(NetworkStream stream)
{
    var head = new List<byte>(512);
    var single = new byte[1];

    while (true)
    {
        if (await stream.ReadAsync(single) == 0)
        {
            throw new IOException("connection closed before headers were complete");
        }

        head.Add(single[0]);

        if (head.Count >= 4 &&
            head[^4] == (byte)'\r' && head[^3] == (byte)'\n' &&
            head[^2] == (byte)'\r' && head[^1] == (byte)'\n')
        {
            break;
        }

        if (head.Count > 16 * 1024)
        {
            throw new IOException("headers too large");
        }
    }

    var headerText = Encoding.ASCII.GetString(head.ToArray());
    var contentLength = int.TryParse(HeaderValue(headerText, "Content-Length"), out var parsed) ? parsed : 0;

    if (contentLength is < 0 or > 32 * 1024)
    {
        throw new IOException("body too large");
    }

    var body = new byte[contentLength];
    var read = 0;
    while (read < contentLength)
    {
        var chunk = await stream.ReadAsync(body.AsMemory(read, contentLength - read));
        if (chunk == 0)
        {
            throw new IOException("connection closed mid-body");
        }
        read += chunk;
    }

    return (headerText, Encoding.UTF8.GetString(body));
}

static async Task WriteHttpResponseAsync(NetworkStream stream, int status, string body)
{
    var reason = status switch
    {
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        404 => "Not Found",
        405 => "Method Not Allowed",
        500 => "Internal Server Error",
        502 => "Bad Gateway",
        _ => "OK",
    };

    var payload = status == 204
        ? string.Empty
        : $"Content-Type: text/plain; charset=utf-8\r\nContent-Length: {Encoding.UTF8.GetByteCount(body)}\r\n";

    var head = $"HTTP/1.1 {status} {reason}\r\n{payload}Connection: close\r\n\r\n";
    var bytes = Encoding.UTF8.GetBytes(head + (status == 204 ? string.Empty : body));
    await stream.WriteAsync(bytes);
}

await Task.Delay(Timeout.InfiniteTimeSpan);
return 0;
