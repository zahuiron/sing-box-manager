#!/bin/sh
set -eu
umask 077

usage() {
    cat <<'EOF'
Usage: sh install-sing-box-manager-panel.sh [options]
  Automatically detects Debian-based Linux / Alpine and x86_64 / ARM64.
  --port PORT             Panel port (default: 18080)
  --listen ADDRESS        Bind address; overrides --port (default: 0.0.0.0:18080)
  --secret SECRET         Panel access secret; preserve existing or generate one
  --cert PATH --key PATH  Optional HTTPS certificate and private key
  --data-dir PATH         Data directory (default: /var/lib/sing-box-manager-panel)
  --binary PATH           Local panel binary; otherwise download a release
  --version VERSION       Panel release version (default: latest)
  --help                  Show this message
EOF
}

fail() { printf '%s\n' "$*" >&2; exit 1; }
absolute() { case "$1" in /*) printf '%s\n' "$1";; *) printf '%s/%s\n' "$PWD" "$1";; esac; }
source_binary=
version=latest
while [ "$#" -gt 0 ]; do
    case "$1" in
        --help|-h) usage; exit 0;;
        --port|--listen|--secret|--cert|--key|--data-dir|--binary|--version)
            [ "$#" -ge 2 ] && [ -n "$2" ] || fail "Missing value for $1"
            case "$1" in
                --port) PANEL_PORT=$2; export PANEL_PORT;;
                --listen) PANEL_LISTEN=$2; export PANEL_LISTEN;;
                --secret) PANEL_SECRET=$2; export PANEL_SECRET;;
                --cert) PANEL_TLS_CERT=$(absolute "$2"); export PANEL_TLS_CERT;;
                --key) PANEL_TLS_KEY=$(absolute "$2"); export PANEL_TLS_KEY;;
                --data-dir) PANEL_DATA_DIR=$(absolute "$2"); export PANEL_DATA_DIR;;
                --binary) source_binary=$(absolute "$2");;
                --version) version=$2;;
            esac
            shift 2;;
        *) fail "Unknown option: $1";;
    esac
done
[ "$(id -u)" = 0 ] || fail 'Run as root.'
[ "$(uname -s)" = Linux ] || fail 'Only Linux is supported.'
machine=$(uname -m)
case "$machine" in
    x86_64|amd64) arch=amd64;;
    aarch64|arm64) arch=arm64;;
    *) fail "Unsupported CPU architecture: $machine. Use x86_64/amd64 or aarch64/arm64 (64-bit).";;
esac

release_file=/etc/os-release
[ -r "$release_file" ] || release_file=/usr/lib/os-release
if [ -r "$release_file" ]; then
    distribution=$(
        unset ID ID_LIKE
        . "$release_file"
        printf '%s %s' "${ID:-}" "${ID_LIKE:-}"
    )
elif [ -f /etc/alpine-release ]; then
    distribution=alpine
elif [ -f /etc/debian_version ]; then
    distribution=debian
else
    distribution=unknown
fi
case " $distribution " in
    *" alpine "*)
        system=Alpine
        driver=openrc
        unit=/etc/init.d/sing-box-manager-panel
        for tool in rc-service rc-update; do
            command -v "$tool" >/dev/null 2>&1 || fail "Alpine requires OpenRC ($tool is missing)."
        done
        [ -x /sbin/openrc-run ] || fail 'Alpine requires /sbin/openrc-run.';;
    *" debian "*|*" ubuntu "*)
        system=Debian
        driver=systemd
        unit=/etc/systemd/system/sing-box-manager-panel.service
        command -v systemctl >/dev/null 2>&1 || fail 'Debian-based systems require systemd.';;
    *) fail "Unsupported Linux distribution: $distribution. Use Debian-based Linux or Alpine.";;
esac
printf 'Detected: %s, %s -> %s, %s\n' "$system" "$machine" "$arch" "$driver"

target=/usr/local/bin/sing-box-manager-panel
config=/etc/sing-box-manager-panel/config.json
if [ ! -f "$config" ] && [ -z "${PANEL_DATA_DIR:-}" ]; then
    PANEL_DATA_DIR=/var/lib/sing-box-manager-panel
    export PANEL_DATA_DIR
fi
stage=$(mktemp -d "${TMPDIR:-/tmp}/sing-box-manager-panel.XXXXXX")
committed=0
was_running=0
if [ "$driver" = systemd ]; then
    systemctl is-active --quiet sing-box-manager-panel && was_running=1 || :
else
    rc-service sing-box-manager-panel status >/dev/null 2>&1 && was_running=1 || :
fi
cleanup() {
    status=$?
    trap - EXIT HUP INT TERM
    set +e
    if [ "$status" -ne 0 ] && [ "$committed" = 1 ]; then
        if [ "$driver" = systemd ]; then systemctl stop sing-box-manager-panel; else rc-service sing-box-manager-panel stop; fi
        for name in binary config unit; do
            case "$name" in binary) destination=$target;; config) destination=$config;; unit) destination=$unit;; esac
            if [ -f "$stage/previous-$name" ]; then cp -p "$stage/previous-$name" "$destination"; else rm -f "$destination"; fi
        done
        if [ "$driver" = systemd ]; then systemctl daemon-reload; fi
        if [ "$was_running" = 1 ]; then
            if [ "$driver" = systemd ]; then systemctl start sing-box-manager-panel; else rc-service sing-box-manager-panel start; fi
        fi
    fi
    case "$stage" in "${TMPDIR:-/tmp}"/sing-box-manager-panel.*) rm -rf -- "$stage";; esac
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP
fetch() {
    if command -v curl >/dev/null 2>&1; then curl -fLsS --connect-timeout 10 --max-time 180 "$1" -o "$2"
    elif command -v wget >/dev/null 2>&1; then wget -q -T 180 -O "$2" "$1"
    else fail 'curl or wget is required, or pass --binary PATH.'; fi
}
if [ -n "$source_binary" ]; then
    cp "$source_binary" "$stage/panel"
else
    case "$version" in
        latest) release=https://github.com/zahuiron/sing-box-manager/releases/latest/download;;
        *[!A-Za-z0-9._-]*) fail 'Invalid release version.';;
        *) release=https://github.com/zahuiron/sing-box-manager/releases/download/$version;;
    esac
    asset=sing-box-manager-panel-linux-$arch.tar.gz
    fetch "$release/$asset" "$stage/package.tar.gz" || fail 'No release available. Use a local binary.'
    tar -xzf "$stage/package.tar.gz" -O sing-box-manager-panel > "$stage/panel"
fi
chmod 755 "$stage/panel"
mkdir -p /usr/local/bin /etc/sing-box-manager-panel
"$stage/panel" -config "$config" -write-config "$stage/panel.json"
"$stage/panel" -config "$stage/panel.json" -init
unset PANEL_SECRET
if [ "$driver" = systemd ]; then
    cat > "$stage/unit" <<'EOF'
[Unit]
Description=sing-box-manager-panel
After=network.target
[Service]
Type=simple
ExecStart=/usr/local/bin/sing-box-manager-panel -config /etc/sing-box-manager-panel/config.json
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
RestartSec=3
TimeoutStopSec=10
[Install]
WantedBy=multi-user.target
EOF
    chmod 644 "$stage/unit"
else
    cat > "$stage/unit" <<'EOF'
#!/sbin/openrc-run
description="sing-box-manager-panel"
command="/usr/local/bin/sing-box-manager-panel"
command_args="-config /etc/sing-box-manager-panel/config.json"
command_background=yes
pidfile="/run/${RC_SVCNAME}.pid"
output_log="/var/log/sing-box-manager-panel.log"
error_log="/var/log/sing-box-manager-panel.log"
extra_started_commands="reload"
depend() { after net dns; }
reload() {
    read -r panel_pid < "$pidfile" || return 1
    kill -HUP "$panel_pid"
}
EOF
    chmod 755 "$stage/unit"
fi
for name in binary config unit; do
    case "$name" in binary) original=$target;; config) original=$config;; unit) original=$unit;; esac
    if [ -f "$original" ]; then cp -p "$original" "$stage/previous-$name"; fi
done
committed=1
cp "$stage/panel" "$target.new"
chmod 755 "$target.new"
mv -f "$target.new" "$target"
cp "$stage/panel.json" "$config.new"
chmod 600 "$config.new"
mv -f "$config.new" "$config"
cp -p "$stage/unit" "$unit"
if [ "$driver" = systemd ]; then
    systemctl daemon-reload
    systemctl restart sing-box-manager-panel
    sleep 1
    systemctl is-active --quiet sing-box-manager-panel
    systemctl enable sing-box-manager-panel
else
    if [ "$was_running" = 1 ]; then rc-service sing-box-manager-panel stop; fi
    rc-service sing-box-manager-panel start
    sleep 1
    rc-service sing-box-manager-panel status
    rc-update add sing-box-manager-panel default
fi
committed=0
printf 'sing-box-manager-panel deployed (%s). Runtime config: %s\nConnect with URL and the secret saved in this file.\n' "$driver" "$config"
