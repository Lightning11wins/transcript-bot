#!/usr/bin/env bash
# Installs whisper-server on the GPU host as a rootless Podman container that
# starts on the first connection from the VM and stops after 10 idle minutes.
# Safe to rerun, e.g. after editing config.env.
set -euo pipefail
cd "$(dirname "$0")"

LISTEN_IP=192.168.122.1
VM_IP=
MODEL=ggml-large-v3-turbo.bin
LANGUAGE=en
IMAGE=ghcr.io/ggml-org/whisper.cpp:main-cuda
if [ -f config.env ]; then . ./config.env; fi

if [[ ! $MODEL =~ ^[A-Za-z0-9._-]+$ ]]; then echo "MODEL should be a file name like ggml-large-v3-turbo.bin" >&2; exit 1; fi
if [[ ! $LANGUAGE =~ ^[a-z]+$ ]]; then echo "LANGUAGE should be a code like en, or auto" >&2; exit 1; fi

# --- Prerequisites ---
problems=0
problem() { echo "✗ $1" >&2; echo "  $2" >&2; problems=1; }

if ! command -v podman >/dev/null; then
  problem "Podman isn't installed." "Install it with your package manager, e.g. sudo apt install podman"
else
  podman_version=$(podman --version | awk '{print $NF}')
  if [ "$(printf '%s\n' 4.4 "$podman_version" | sort -V | head -1)" != 4.4 ]; then
    problem "Podman $podman_version is too old for Quadlet; 4.4 or newer is needed." \
      "Upgrade Podman (Ubuntu 24.04 and Debian 13, for example, ship newer versions)."
  fi
fi
if ! command -v nvidia-ctk >/dev/null; then
  problem "nvidia-container-toolkit isn't installed." \
    "See https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html"
fi
if [ ! -f /etc/cdi/nvidia.yaml ]; then
  problem "/etc/cdi/nvidia.yaml (the CDI spec that gives containers the GPU) is missing." \
    "sudo nvidia-ctk cdi generate --output=/etc/cdi/nvidia.yaml"
fi
if ! command -v curl >/dev/null; then
  problem "curl isn't installed (used to download the model and check that the server is up)." "Install it with your package manager."
fi
PROXYD=
for path in /usr/lib/systemd/systemd-socket-proxyd /lib/systemd/systemd-socket-proxyd; do
  if [ -x "$path" ]; then PROXYD=$path; break; fi
done
if [ -z "$PROXYD" ]; then
  problem "systemd-socket-proxyd wasn't found." "It ships with systemd, but some distros package it separately."
fi
systemd_version=$(systemctl --version | awk 'NR == 1 {print $2}')
if [ "${systemd_version%%.*}" -lt 246 ]; then
  problem "systemd $systemd_version is too old for systemd-socket-proxyd --exit-idle-time (needs 246+)." "Upgrade the OS."
fi
if [ "$problems" = 1 ]; then exit 1; fi

# The main-cuda image is built on CUDA 13, which needs NVIDIA driver 580 or newer.
driver=$(nvidia-smi --query-gpu=driver_version --format=csv,noheader 2>/dev/null | head -1 || true)
if [ -n "$driver" ] && [ "${driver%%.*}" -lt 580 ] && [[ $IMAGE == *main-cuda* ]]; then
  echo "⚠ NVIDIA driver $driver is older than 580, which the CUDA 13 image needs. Update the driver if the server fails to start." >&2
fi

# --- Model and image ---
mkdir -p ~/whisper-models
if [ ! -f ~/whisper-models/"$MODEL" ]; then
  echo "Downloading $MODEL..."
  curl -fL --progress-bar -o ~/whisper-models/"$MODEL.part" "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/$MODEL"
  mv ~/whisper-models/"$MODEL.part" ~/whisper-models/"$MODEL"
fi
# Pull now so the first connection doesn't wait for a multi-GB download.
podman pull "$IMAGE"

# --- Units ---
fill() {
  sed -e "s|@IMAGE@|$IMAGE|g" -e "s|@MODEL@|$MODEL|g" -e "s|@LANGUAGE@|$LANGUAGE|g" \
    -e "s|@LISTEN_IP@|$LISTEN_IP|g" -e "s|@PROXYD@|$PROXYD|g" "$1" > "$2"
}
mkdir -p ~/.config/containers/systemd ~/.config/systemd/user
fill whisper.container ~/.config/containers/systemd/whisper.container
fill whisper-proxy.socket ~/.config/systemd/user/whisper-proxy.socket
fill whisper-proxy.service ~/.config/systemd/user/whisper-proxy.service

systemctl --user daemon-reload
if ! systemctl --user cat whisper.service >/dev/null 2>&1; then
  echo "Quadlet didn't generate whisper.service. To see why: /usr/libexec/podman/quadlet -dryrun -user" >&2
  exit 1
fi
systemctl --user enable whisper-proxy.socket
# Restart in case LISTEN_IP changed. Also stops a running server so a new model or image is used.
systemctl --user stop whisper-proxy.service whisper.service 2>/dev/null || true
systemctl --user restart whisper-proxy.socket
# Lets the socket listen at boot without anyone logging in.
loginctl enable-linger "$USER"

cat <<MSG

Done. whisper-server starts on the first connection to $LISTEN_IP:8080.
Test it from this machine (the first request waits for the model to load):
  curl http://$LISTEN_IP:8080/health

The VM needs one firewall rule, which you'll need to add yourself. In your nftables input chain:
  ip saddr ${VM_IP:-<VM_IP>} ip daddr $LISTEN_IP tcp dport 8080 accept
MSG
