# Discord call transcriber

A self-hosted Discord bot that transcribes voice calls with [whisper.cpp](https://github.com/ggml-org/whisper.cpp) on your own GPU. Audio and text only travel between Discord and your own machines. Audio never touches the disk. The bot decodes it in memory, sends it to whisper-server, and throws it away.

The bot adds transcripts to Markdown session notes, such as the ones in an Obsidian vault:

```
[19:32:05] **Alice:** I check the door for traps.
[19:32:09] **Bob:** Roll for it.
```

| Command | What it does |
| --- | --- |
| `/join` | Joins your voice channel and starts transcribing into the newest session file. |
| `/leave` | Stops transcribing and leaves. Clips it already recorded still get transcribed. |
| `/newsession` | Creates the next session file and sends the transcript there from now on. |

By default only members with Manage Server can use these. To allow other roles, go to Server Settings → Integrations. The bot also leaves on its own a minute after everyone else leaves the channel, so nobody who joins later gets transcribed without noticing.

## Session files

`SESSIONS_DIR` holds notes named `Session 1.md`, `Session 2.md`, and so on. Each one starts with a link line:

```
[[Session 3|Previous Session]] - [[Session 5|Next Session]]
```

- `/join` uses the highest-numbered file. If that file has no `# Transcript` heading yet, the bot adds one at the end and writes below it. After a crash or restart, run `/join` again and it carries on in the same file.
- `/newsession` creates the next file with a link line and a `# Transcript` heading, then points the previous file's `Next Session` at it.

The bot writes lines in the order people started speaking. Each line goes out once every earlier line is transcribed. Times use the bot machine's local clock.

If the file is open in an editor while the bot writes to it, let the editor reload before you save. Otherwise you can overwrite the new lines.

## How it works

```
Discord ──voice──▶ bot (VM) ──WAV over HTTP──▶ host:8080 ─▶ systemd-socket-proxyd ─▶ whisper-server (Podman, GPU)
```

**The bot** lives in `bot/`. It's Node.js, runs on any Linux machine, and uses discord.js and `@discordjs/voice`, which handles Discord's DAVE end-to-end encryption.

- It listens to each speaker separately, and 0.8 s of silence ends a clip.
- It decodes the Opus audio straight to 16 kHz mono, which is the format whisper wants.
- A clip under 1 s waits up to 5 s to be merged into the same speaker's next clip. A clip over 25 s gets split at the next pause, or at 40 s if nobody pauses.
- It sends clips to whisper-server's `/inference` one at a time, with the speaker's previous line as the prompt.
- If whisper-server is unreachable, clips wait in memory and the bot keeps retrying, backing off to 30 s between tries. Either side can start first.
- It ignores other bots, like a music bot, and labels speakers with their server display names.

**whisper-server** lives in `whisper/` and runs on the machine with the GPU. It's whisper.cpp's CUDA image in rootless Podman, set up as a Quadlet unit, and it only runs while something needs it:

- `whisper-proxy.socket` listens on `LISTEN_IP:8080`. The first connection starts `whisper-proxy.service`, which starts the container's `whisper.service`.
- The container loads the model before it accepts connections. Until it's ready, connections wait on the socket.
- `systemd-socket-proxyd` exits after 10 idle minutes. `StopWhenUnneeded=yes` stops the container with it, which frees the GPU memory.
- The bot's machine gets that one port and nothing else, so it can't control the host.

On `/join`, the bot sends a health check so the model starts loading before anyone speaks.

## Setup

### 1. Discord app

1. At https://discord.com/developers/applications, create an application. In the **Bot** tab, reset the token and copy it.
2. Leave all Privileged Gateway Intents off.
3. Under **Installation**, set Install Link to "None" and uncheck User Install. Then turn off **Public Bot** in the **Bot** tab, so only you can add it to servers.
4. Invite it with `https://discord.com/oauth2/authorize?client_id=APP_ID&scope=bot+applications.commands&permissions=1049600`, replacing `APP_ID` with the Application ID. The bot gets View Channel and Connect. It never speaks or posts messages, so it doesn't need anything else.

### 2. GPU host

You need an NVIDIA GPU with driver 580 or newer, since the image uses CUDA 13. You also need Podman 4.4+, [nvidia-container-toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html), and systemd 246+.

```sh
sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml
cd whisper
cp config.env.example config.env   # optional: change the IP, model, or image
./setup.sh
```

`setup.sh` checks the requirements and downloads the model to `~/whisper-models`. The default is `ggml-large-v3-turbo.bin`, about 1.6 GB. Then it pulls the image, installs the units, and enables the socket. It leaves your firewall alone and prints the one nftables rule the bot's machine needs:

```
ip saddr <VM_IP> ip daddr 192.168.122.1 tcp dport 8080 accept
```

`192.168.122.1` is the host's address on libvirt's default network. If your bot runs somewhere else, change `LISTEN_IP`.

After every NVIDIA driver update, regenerate the CDI spec. Otherwise the container won't find the GPU.

```sh
sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml
```

### 3. Bot

You need Node.js 22.18 or newer.

```sh
cd bot
cp .env.example .env && chmod 600 .env   # then fill in the token, WHISPER_URL, and SESSIONS_DIR
./setup.sh
```

`setup.sh` runs `npm ci` and installs a systemd user service that starts at boot and restarts after crashes. The service records the repo's path and Node's path, so rerun the script if either one changes.

To try it in the foreground first, run `npm ci && npm start`.

### Testing without the GPU

Point `WHISPER_URL` at a CPU build of whisper-server with a small model:

```sh
git clone https://github.com/ggml-org/whisper.cpp && cd whisper.cpp
cmake -B build && cmake --build build -j --target whisper-server
curl -fLO https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin
build/bin/whisper-server -m ggml-base.en.bin --host 127.0.0.1 --port 8090
```

To check the Opus decoding and the server without Discord, run `WHISPER_URL=http://127.0.0.1:8090 npm run smoke-test -- path/to/whisper.cpp/samples/jfk.wav`.

## Running

```sh
# Bot machine
systemctl --user status transcript-bot
npm run logs                                   # follow the bot's logs

# GPU host
systemctl --user status whisper-proxy.socket whisper.service
journalctl --user -u whisper.service -f        # whisper-server's logs
curl http://192.168.122.1:8080/health          # starts it, and answers once the model is loaded
```

## Troubleshooting

- **The bot says the transcription server isn't responding.** On the host, check `systemctl --user status whisper.service`. If the socket shows "failed" after several failed starts, fix the cause, then run `systemctl --user reset-failed` and `systemctl --user restart whisper-proxy.socket`.
- **The container can't find the GPU.** Regenerate the CDI spec and make sure the driver is version 580 or newer.
- **Quadlet didn't create `whisper.service`.** Run `/usr/libexec/podman/quadlet -dryrun -user` to see the error.
- **Nothing gets transcribed.** Check that nobody server-deafened the bot. It joins undeafened and only hears people, not other bots.

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).
