require('dotenv').config();
const {
    Client,
    GatewayIntentBits,
    WebhookClient,
    REST,
    Routes,
    SlashCommandBuilder,
    PermissionsBitField,
    DiscordAPIError,
    ChannelType
} = require('discord.js');
const sqlite3 = require('sqlite3').verbose();
const { open } = require('sqlite');
const path = require('path');
const fs = require('fs');

const RATE_LIMIT_WINDOW = 60000;
const RATE_LIMIT_MAX = 3;
const ROTATION_INTERVAL = 86400000;

const userMessageCounts = new Map();
let db;

// --- Datenbank Initialisierung ---
(async () => {
    try {
        const dataDir = path.join(__dirname, 'data');
        if (!fs.existsSync(dataDir)) {
            fs.mkdirSync(dataDir);
            console.log('Der "data"-Ordner für die Datenbank wurde erstellt.');
        }

        db = await open({
            filename: path.join(dataDir, 'database.db'), // Umbenannt für mehr Klarheit
            driver: sqlite3.Database
        });

        // Tabelle für Webhook-Zugangsdaten
        await db.run(`CREATE TABLE IF NOT EXISTS webhooks (
            channelId TEXT PRIMARY KEY,
            webhookId TEXT NOT NULL,
            webhookToken TEXT NOT NULL
        )`);

        // NEU: Tabelle für die erlaubten Relay-Kanäle
        await db.run(`CREATE TABLE IF NOT EXISTS relay_channels (
            channelId TEXT PRIMARY KEY,
            guildId TEXT NOT NULL
        )`);

        // NEU: Tabelle zur Verknüpfung von Original- und Webhook-Nachrichten
        await db.run(`CREATE TABLE IF NOT EXISTS message_map (
            originalMessageId TEXT PRIMARY KEY,
            webhookMessageId TEXT NOT NULL,
            channelId TEXT NOT NULL,
            webhookId TEXT NOT NULL,
            webhookToken TEXT NOT NULL
        )`);

        await db.run(`CREATE TABLE IF NOT EXISTS bot_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        )`);

        console.log('Datenbank erfolgreich initialisiert.');
    } catch (error) {
        console.error('Fehler bei der Initialisierung der Datenbank:', error);
        process.exit(1);
    }
})();

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMembers
    ]
});

// --- Hilfsfunktionen ---
async function isRelayChannel(channelId) {
    const result = await db.get('SELECT 1 FROM relay_channels WHERE channelId = ?', channelId);
    return !!result;
}

async function getOrCreateWebhook(channel) {
    try {
        const row = await db.get('SELECT webhookId, webhookToken FROM webhooks WHERE channelId = ?', channel.id);
        if (row) {
            return { id: row.webhookId, token: row.webhookToken };
        }
        const newWebhook = await channel.createWebhook({ name: 'Relay Webhook', reason: 'Wiederverwendbarer Webhook' });
        await db.run('INSERT INTO webhooks (channelId, webhookId, webhookToken) VALUES (?, ?, ?)', channel.id, newWebhook.id, newWebhook.token);
        return { id: newWebhook.id, token: newWebhook.token };
    } catch (error) {
        if (error instanceof DiscordAPIError && error.code === 10015) {
             await db.run('DELETE FROM webhooks WHERE channelId = ?', channel.id);
             return getOrCreateWebhook(channel);
        }
        console.error(`Konnte keinen Webhook für Kanal ${channel.id} erstellen oder abrufen:`, error);
        return null;
    }
}

async function sendWebhookMessage({ message, attachment, channel, username, displayAvatarURL }) {
    const webhookCredentials = await getOrCreateWebhook(channel);
    if (!webhookCredentials) {
        console.error(`Senden fehlgeschlagen: Kein Webhook für Kanal ${channel.id} verfügbar.`);
        return null;
    }
    try {
        const webhookClient = new WebhookClient(webhookCredentials);
        const sentMessage = await webhookClient.send({
            content: message || undefined,
            username: username,
            avatarURL: displayAvatarURL,
            files: attachment ? [attachment.url] : [],
            allowedMentions: { parse: [] }
        });
        return { sentMessage, webhookCredentials }; // Gibt die gesendete Nachricht und die Credentials zurück
    } catch (error) {
        console.error('Fehler beim Senden der Webhook-Nachricht:', error);
        return null;
    }
}


function isUserRateLimited(userId) {
    if (!userMessageCounts.has(userId)) {
        userMessageCounts.set(userId, []);
    }
    const timestamps = userMessageCounts.get(userId);
    const currentTime = Date.now();
    while (timestamps.length > 0 && timestamps[0] <= currentTime - RATE_LIMIT_WINDOW) {
        timestamps.shift();
    }
    timestamps.push(currentTime);
    return timestamps.length > RATE_LIMIT_MAX;
}


async function rotateWebhooks() {
    console.log('Starte tägliche Webhook-Rotation...');
    const allWebhooks = await db.all('SELECT * FROM webhooks');
    if (allWebhooks.length === 0) {
        console.log('Keine Webhooks zur Rotation in der Datenbank gefunden.');
        // Trotzdem Zeitstempel aktualisieren, um nicht ständig zu prüfen
        await db.run("INSERT OR REPLACE INTO bot_meta (key, value) VALUES (?, ?)", 'lastRotationTimestamp', Date.now().toString());
        return;
    }

    let rotatedCount = 0;
    for (const webhook of allWebhooks) {
        try {
            const channel = await client.channels.fetch(webhook.channelId);
            if (!channel) throw new Error('Kanal nicht gefunden');

            const oldWebhookClient = new WebhookClient({ id: webhook.webhookId, token: webhook.webhookToken });
            await oldWebhookClient.delete().catch(() => {});

            const newWebhook = await channel.createWebhook({
                name: 'General Webhook',
                reason: 'Tägliche Rotation'
            });

            await db.run('UPDATE webhooks SET webhookId = ?, webhookToken = ? WHERE channelId = ?',
                newWebhook.id, newWebhook.token, channel.id
            );
            rotatedCount++;
        } catch (error) {
            console.warn(`Fehler bei Rotation für Kanal ${webhook.channelId}. Entferne Eintrag. Fehler: ${error.message}`);
            await db.run('DELETE FROM webhooks WHERE channelId = ?', webhook.channelId);
        }
    }
    // Speichere den Zeitstempel nach einer erfolgreichen Rotation
    await db.run("INSERT OR REPLACE INTO bot_meta (key, value) VALUES (?, ?)", 'lastRotationTimestamp', Date.now().toString());
    console.log(`Webhook-Rotation abgeschlossen. ${rotatedCount} Webhooks rotiert.`);
}


// --- Event Handlers ---

client.once('ready', async () => {
    console.log(`Bot ist als ${client.user.tag} bereit!`);
    const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_BOT_TOKEN);

    const relayCommand = new SlashCommandBuilder()
        .setName('relay')
        .setDescription('Verwaltet die Relay-Kanäle.')
        .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator)
        .addSubcommand(subcommand =>
            subcommand
                .setName('addchannel')
                .setDescription('Fügt einen Kanal zur Relay-Liste hinzu.')
                .addChannelOption(option => option.setName('kanal').setDescription('Der hinzuzufügende Kanal').setRequired(true).addChannelTypes(ChannelType.GuildText)))
        .addSubcommand(subcommand =>
            subcommand
                .setName('removechannel')
                .setDescription('Entfernt einen Kanal von der Relay-Liste.')
                .addChannelOption(option => option.setName('kanal').setDescription('Der zu entfernende Kanal').setRequired(true).addChannelTypes(ChannelType.GuildText)));

    const webhookCommand = new SlashCommandBuilder()
        .setName('webhook')
        .setDescription('Sende eine Nachricht oder einen Anhang als Webhook.')
        .addStringOption(option => option.setName('message').setDescription('Die zu sendende Nachricht').setRequired(false))
        .addAttachmentOption(option => option.setName('attachment').setDescription('Der zu sendende Anhang').setRequired(false));

    const commands = [relayCommand.toJSON(), webhookCommand.toJSON()];

    try {
        await rest.put(Routes.applicationCommands(process.env.DISCORD_CLIENT_ID), { body: commands });
        console.log('Slash-Befehle erfolgreich registriert.');
    } catch(e) {
        console.error("Fehler bei der Registrierung der Slash-Befehle:", e);
    }

    const scheduleRotation = async () => {
        const lastRotation = await db.get("SELECT value FROM bot_meta WHERE key = ?", 'lastRotationTimestamp');
        const now = Date.now();
        let nextRotationTime;

        if (!lastRotation || !lastRotation.value) {
            console.log("Keine vorherige Rotation gefunden. Führe Rotation sofort aus.");
            await rotateWebhooks();
            nextRotationTime = Date.now() + ROTATION_INTERVAL;
        } else {
            const lastRotationTimestamp = parseInt(lastRotation.value, 10);
            if (now >= lastRotationTimestamp + ROTATION_INTERVAL) {
                console.log("Rotationsintervall überschritten. Führe Rotation aus.");
                await rotateWebhooks();
                nextRotationTime = Date.now() + ROTATION_INTERVAL;
            } else {
                nextRotationTime = lastRotationTimestamp + ROTATION_INTERVAL;
                console.log("Nächste planmäßige Rotation ist fällig am:", new Date(nextRotationTime).toLocaleString('de-DE'));
            }
        }
        
        const delay = nextRotationTime - Date.now();
        // Setze einen Timer für die nächste Ausführung
        setTimeout(async () => {
            await rotateWebhooks();
            scheduleRotation(); // Plane die übernächste Rotation nach dem Durchlauf
        }, delay > 0 ? delay : 0);
    };

    // Starte den Planungs-Prozess
    await scheduleRotation();
});


client.on('interactionCreate', async interaction => {
    if (!interaction.isCommand()) return;

    // --- Relay-Befehle ---
    if (interaction.commandName === 'relay') {
        if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
            return interaction.reply({ content: 'Du hast keine Berechtigung, diesen Befehl zu verwenden.', ephemeral: true });
        }

        const subcommand = interaction.options.getSubcommand();
        const channel = interaction.options.getChannel('kanal');

        if (subcommand === 'addchannel') {
            const existing = await db.get('SELECT 1 FROM relay_channels WHERE channelId = ?', channel.id);
            if (existing) {
                return interaction.reply({ content: `Der Kanal ${channel} ist bereits ein Relay-Kanal.`, ephemeral: true });
            }
            await db.run('INSERT INTO relay_channels (guildId, channelId) VALUES (?, ?)', interaction.guildId, channel.id);
            return interaction.reply({ content: `Der Kanal ${channel} wurde erfolgreich als Relay-Kanal hinzugefügt.`, ephemeral: true });
        }

        if (subcommand === 'removechannel') {
            const existing = await db.get('SELECT 1 FROM relay_channels WHERE channelId = ?', channel.id);
            if (!existing) {
                return interaction.reply({ content: `Der Kanal ${channel} ist kein Relay-Kanal.`, ephemeral: true });
            }
            await db.run('DELETE FROM relay_channels WHERE channelId = ?', channel.id);
            return interaction.reply({ content: `Der Kanal ${channel} wurde erfolgreich als Relay-Kanal entfernt.`, ephemeral: true });
        }
    }

    // --- Webhook-Befehl ---
    if (interaction.commandName === 'webhook') {
        if (!await isRelayChannel(interaction.channelId)) {
            return interaction.reply({ content: 'Dieser Befehl kann in diesem Kanal nicht verwendet werden.', ephemeral: true });
        }
        
        const message = interaction.options.getString('message');
        const attachment = interaction.options.getAttachment('attachment');
        
        if (!message && !attachment) {
            return interaction.reply({ content: 'Du musst entweder eine Nachricht oder einen Anhang angeben.', ephemeral: true });
        }
        
        await interaction.reply({ content: 'Deine Nachricht wird gesendet...', ephemeral: true });

        const result = await sendWebhookMessage({
            message: message,
            attachment: attachment,
            channel: interaction.channel,
            username: interaction.member.displayName,
            displayAvatarURL: interaction.user.displayAvatarURL({ format: 'png' })
        });
        
        // Da dies eine Interaktion ist, speichern wir keine Message Map,
        // da es keine "Originalnachricht" zum Bearbeiten/Löschen gibt.
    }
});

client.on('messageCreate', async message => {
    if (message.author.bot || !await isRelayChannel(message.channelId)) {
        return;
    }
    try {
        // Speichere alle benötigten Informationen, bevor die Nachricht gelöscht wird.
        const originalContent = message.content;
        const originalAttachment = message.attachments.first();
        const originalMember = message.member;
        const originalAuthor = message.author;
        const originalChannel = message.channel;
        const originalId = message.id;

        // 1. LÖSCHE DIE ORIGINALNACHRICHT ZUERST.
        // Dies löst 'messageDelete' aus, aber da noch keine Verknüpfung existiert, passiert nichts.
        await message.delete();

        // Prüfe das Rate-Limit, nachdem die Nachricht bereits weg ist.
        if (!originalMember.permissions.has(PermissionsBitField.Flags.Administrator)) {
            if (isUserRateLimited(originalAuthor.id)) {
                 await originalAuthor.send('Du sendest Nachrichten zu schnell. Deine letzte Nachricht wurde ignoriert.').catch(() => {});
                 return;
            }
        }
        
        // 2. SENDE DIE WEBHOOK-NACHRICHT.
        const result = await sendWebhookMessage({
            message: originalContent,
            attachment: originalAttachment,
            channel: originalChannel,
            username: originalMember.displayName,
            displayAvatarURL: originalAuthor.displayAvatarURL({ format: 'png' })
        });
        
        // 3. ERSTELLE DIE VERKNÜPFUNG IN DER DATENBANK, NACHDEM ALLES ERLEDIGT IST.
        if (result && result.sentMessage) {
            await db.run(
                'INSERT INTO message_map (originalMessageId, webhookMessageId, channelId, webhookId, webhookToken) VALUES (?, ?, ?, ?, ?)',
                originalId,
                result.sentMessage.id,
                originalChannel.id,
                result.webhookCredentials.id,
                result.webhookCredentials.token
            );
        }

    } catch (error) {
        console.error('Fehler bei der Verarbeitung einer Nachricht:', error);
    }
});

// --- Event Handler für messageUpdate & messageDelete ---

client.on('messageUpdate', async (oldMessage, newMessage) => {
    if (newMessage.author.bot) return;

    const mapping = await db.get('SELECT * FROM message_map WHERE originalMessageId = ?', newMessage.id);
    if (!mapping) return;

    try {
        const webhookClient = new WebhookClient({ id: mapping.webhookId, token: mapping.webhookToken });
        await webhookClient.editMessage(mapping.webhookMessageId, {
            content: newMessage.content,
        });
    } catch (error) {
        console.error(`Konnte Webhook-Nachricht nicht bearbeiten:`, error);
    }
});

client.on('messageDelete', async message => {
    const mapping = await db.get('SELECT * FROM message_map WHERE originalMessageId = ?', message.id);
    if (!mapping) return;

    try {
        const webhookClient = new WebhookClient({ id: mapping.webhookId, token: mapping.webhookToken });
        await webhookClient.deleteMessage(mapping.webhookMessageId);
    } catch (error) {
        // Ignoriere Fehler, falls die Nachricht schon weg ist
    } finally {
        await db.run('DELETE FROM message_map WHERE originalMessageId = ?', message.id);
    }
});

client.login(process.env.DISCORD_BOT_TOKEN).catch(console.error);