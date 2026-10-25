import { entersState, joinVoiceChannel, VoiceConnectionStatus, type VoiceConnection } from '@discordjs/voice';
import {
  Client,
  Events,
  GatewayIntentBits,
  InteractionContextType,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
  type ChatInputCommandInteraction,
  type Guild,
} from 'discord.js';
import { existsSync } from 'node:fs';
import { Recorder } from './recorder.ts';
import { currentSession, newSession, sessionName, Transcript } from './transcript.ts';
import { drained, warmUp } from './whisper.ts';

for (const name of ['DISCORD_TOKEN', 'WHISPER_URL', 'SESSIONS_DIR']) {
  if (!process.env[name]) {
    console.error(`${name} is not set. Put it in .env (see .env.example).`);
    process.exit(1);
  }
}
if (!existsSync(process.env.SESSIONS_DIR!)) {
  console.error(`SESSIONS_DIR doesn't exist: ${process.env.SESSIONS_DIR}`);
  process.exit(1);
}

/** Leave once nobody but bots has been in the channel for this long. */
const ALONE_TIMEOUT_MS = 60_000;
/** On shutdown, how long to wait for queued clips to finish transcribing. */
const SHUTDOWN_WAIT_MS = 60_000;

const commands = [
  new SlashCommandBuilder().setName('join').setDescription('Join your voice channel and start transcribing'),
  new SlashCommandBuilder().setName('leave').setDescription('Stop transcribing and leave the voice channel'),
  new SlashCommandBuilder()
    .setName('newsession')
    .setDescription('Start a new session file; transcripts go there from now on'),
].map((c) =>
  c
    .setContexts(InteractionContextType.Guild)
    // Server admins can open this up to other roles in Server Settings > Integrations.
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .toJSON(),
);

interface Call {
  connection: VoiceConnection;
  recorder: Recorder;
  aloneTimer?: NodeJS.Timeout;
}

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
  allowedMentions: { parse: [] },
});
const calls = new Map<string, Call>();

async function registerCommands(guild: Guild) {
  try {
    await guild.commands.set(commands);
    console.log(`Registered commands in ${guild.name}`);
  } catch (err) {
    console.error(`Failed to register commands in ${guild.name}:`, err);
  }
}

client.once(Events.ClientReady, async (c) => {
  console.log(`Logged in as ${c.user.tag}`);
  await Promise.all(c.guilds.cache.map(registerCommands));
});
client.on(Events.GuildCreate, registerCommands);

function endCall(guildId: string) {
  const call = calls.get(guildId);
  if (!call) return;
  calls.delete(guildId);
  clearTimeout(call.aloneTimer);
  call.recorder.stop();
  if (call.connection.state.status !== VoiceConnectionStatus.Destroyed) call.connection.destroy();
  console.log(`[call] left voice in ${guildId}`);
}

// Leave if everyone else has left, so nobody joins later and gets transcribed unawares.
client.on(Events.VoiceStateUpdate, (_old, state) => {
  const call = calls.get(state.guild.id);
  if (!call) return;
  const channel = state.guild.members.me?.voice.channel;
  if (channel && !channel.members.every((m) => m.user.bot)) {
    clearTimeout(call.aloneTimer);
    call.aloneTimer = undefined;
  } else {
    call.aloneTimer ??= setTimeout(() => endCall(state.guild.id), ALONE_TIMEOUT_MS);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isChatInputCommand() || !interaction.inCachedGuild()) return;
  try {
    await handle(interaction);
  } catch (err) {
    console.error(`/${interaction.commandName} failed:`, err);
    const content = `❌ Something went wrong: ${err instanceof Error ? err.message : String(err)}`.slice(0, 1000);
    if (interaction.deferred || interaction.replied) await interaction.editReply(content).catch(() => {});
    else await interaction.reply({ content, flags: MessageFlags.Ephemeral }).catch(() => {});
  }
});

async function handle(interaction: ChatInputCommandInteraction<'cached'>) {
  const guild = interaction.guild;
  const call = calls.get(guild.id);
  const ephemeral = (content: string) => interaction.reply({ content, flags: MessageFlags.Ephemeral });

  switch (interaction.commandName) {
    case 'join': {
      const channel = interaction.member.voice.channel;
      if (!channel) return ephemeral('Join a voice channel first, then use /join.');
      if (call) return ephemeral(`Already transcribing ${guild.members.me?.voice.channel ?? 'a call'}. Use /leave first.`);
      if (!channel.permissionsFor(guild.members.me!).has(PermissionFlagsBits.Connect)) {
        return ephemeral(`I don't have permission to connect to ${channel}.`);
      }

      await interaction.deferReply();
      // Before joining, so a problem with the notes folder doesn't leave a connection behind.
      const transcript = new Transcript(currentSession());
      const connection = joinVoiceChannel({
        channelId: channel.id,
        guildId: guild.id,
        adapterCreator: guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: true,
      });
      // Voice network errors are emitted here; without a listener they'd crash the process.
      connection.on('error', (err) => console.warn('[voice]', err.message));
      try {
        await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
      } catch {
        connection.destroy();
        return interaction.editReply("❌ Couldn't connect to the voice channel. Try again?");
      }

      calls.set(guild.id, { connection, recorder: new Recorder(connection, guild, transcript) });
      connection.on(VoiceConnectionStatus.Destroyed, () => endCall(guild.id));
      // From the discord.js voice guide: a disconnect that doesn't start reconnecting
      // within 5s means we were kicked or the channel was deleted.
      connection.on(VoiceConnectionStatus.Disconnected, async () => {
        try {
          await Promise.race([
            entersState(connection, VoiceConnectionStatus.Signalling, 5_000),
            entersState(connection, VoiceConnectionStatus.Connecting, 5_000),
          ]);
        } catch {
          endCall(guild.id);
        }
      });
      console.log(`[call] transcribing ${channel.name} in ${guild.name} into ${transcript.file}`);

      await interaction.editReply(
        `🎙️ Transcribing ${channel} into **${sessionName(transcript.file)}**. Use /leave to stop.`,
      );
      if (!(await warmUp())) {
        await interaction
          .followUp({
            content: "⚠️ The transcription server isn't responding. Speech is kept in memory and retried until it is.",
            flags: MessageFlags.Ephemeral,
          })
          .catch(() => {});
      }
      return;
    }

    case 'leave':
      if (!call) return ephemeral("I'm not in a voice channel.");
      endCall(guild.id);
      return interaction.reply('⏹️ Stopped transcribing.');

    case 'newsession': {
      const file = newSession();
      if (call) call.recorder.transcript.file = file;
      return interaction.reply(`📄 Started **${sessionName(file)}**${call ? ' and switched the transcript to it' : ''}.`);
    }
  }
}

async function shutdown() {
  console.log('Shutting down');
  for (const guildId of [...calls.keys()]) endCall(guildId);
  await Promise.race([drained(), new Promise((resolve) => setTimeout(resolve, SHUTDOWN_WAIT_MS))]);
  await client.destroy();
  process.exit(0);
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);

await client.login(process.env.DISCORD_TOKEN);
