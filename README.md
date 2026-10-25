# Discord call transcriber

A self-hosted Discord bot that transcribes voice calls with [whisper.cpp](https://github.com/ggml-org/whisper.cpp) on your own GPU. Audio stays in memory and only goes to your own whisper-server.

| Command | What it does |
| --- | --- |
| `/join` | Joins your voice channel and starts transcribing. |
| `/leave` | Stops transcribing and leaves. |
| `/newsession` | Starts the next session file. |

Only members with Manage Server can use these by default. You can change that in Server Settings → Integrations.

Transcripts go under a `# Transcript` heading in the newest `Session N.md` in `SESSIONS_DIR`, one line per utterance:

```
[19:32:05] **Alice:** I check the door for traps.
```

## How it works

```
Discord ─▶ bot (bot/) ─▶ host:8080 ─▶ systemd-socket-proxyd ─▶ whisper-server in Podman (whisper/)
```

The first connection starts whisper-server, and it stops after 10 idle minutes to free the GPU. Until it's up, the bot keeps clips in memory and retries.

## Setup

**Discord.** Create an application, copy the bot token, leave the privileged intents off, and turn off Public Bot. Invite it with `https://discord.com/oauth2/authorize?client_id=APP_ID&scope=bot+applications.commands&permissions=1049600` (View Channel and Connect).

**GPU host.** Needs NVIDIA driver 580+, Podman 4.4+, and nvidia-container-toolkit. `setup.sh` checks for these, downloads the model, installs the systemd units, and prints the firewall rule to add.

```sh
sudo systemctl enable --now nvidia-cdi-refresh.service   # keeps the GPU's CDI spec current across driver updates
cd whisper && cp config.env.example config.env && ./setup.sh
```

On Podman before 5.0 (e.g. Ubuntu 24.04), `setup.sh` will tell you to add a feature flag so the toolkit writes a CDI spec that Podman can read.

**Bot.** Needs Node.js 22.18+. `setup.sh` installs it as a systemd user service.

```sh
cd bot && cp .env.example .env   # fill in WHISPER_URL and SESSIONS_DIR
./set-token.sh                    # asks for the bot token; rerun it whenever you reset the token
./setup.sh
```

To test without a GPU, point `WHISPER_URL` at a CPU whisper-server and run `npm run smoke-test -- some.wav`.

## License

GPL-3.0-or-later
