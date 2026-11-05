#!/bin/sh
set -eu
umask 077

usage() {
    cat <<'EOF'
Usage: sh install-agent.sh [options]
  Automatically detects Debian-based Linux / Alpine and x86_64 / ARM64.
  --port PORT               Agent HTTPS port (default: 9091 on first install)
  --listen ADDRESS          Bind address, overrides --port
  --cert PATH --key PATH    Override automatically discovered certificate paths
  --tls-domain DOMAIN      Select a domain when several certificates are configured
  --acme-dir PATH          Override the CertMagic data directory
  --token TOKEN             Node token; generated on first install if omitted
  --binary PATH            Local Agent binary; otherwise download a release
  --version VERSION        Agent release version (default: latest)
  --sing-box-version VERSION  sing-box version (default: latest stable)
  --skip-sing-box           Use the existing sing-box binary
  --sing-box-binary PATH    Existing sing-box executable
  --sing-box-config PATH    Existing single configuration file
  --work-dir PATH           Existing sing-box working directory
  --auto-start BOOL         Start the managed core with Agent (default: true)
  --service NAME            Existing sing-box service name
  --help                    Show this message
EOF
}

fail() { printf '%s\n' "$*" >&2; exit 1; }
absolute() { case "$1" in /*) printf '%s\n' "$1";; *) printf '%s/%s\n' "$PWD" "$1";; esac; }

source_binary=
version=latest
core_version=latest
install_core=1
while [ "$#" -gt 0 ]; do
    case "$1" in
        --help|-h) usage; exit 0;;
        --skip-sing-box) install_core=0; shift; continue;;
        --port|--listen|--cert|--key|--tls-domain|--acme-dir|--token|--binary|--version|--sing-box-version|--sing-box-binary|--sing-box-config|--work-dir|--auto-start|--service)
            [ "$#" -ge 2 ] && [ -n "$2" ] || fail "Missing value for $1"
            case "$1" in
                --port) AGENT_PORT=$2; export AGENT_PORT;;
                --listen) AGENT_LISTEN=$2; export AGENT_LISTEN;;
                --cert) AGENT_TLS_CERT=$(absolute "$2"); export AGENT_TLS_CERT;;
                --key) AGENT_TLS_KEY=$(absolute "$2"); export AGENT_TLS_KEY;;
                --tls-domain) AGENT_TLS_DOMAIN=$2; export AGENT_TLS_DOMAIN;;
                --acme-dir) AGENT_ACME_DIR=$(absolute "$2"); export AGENT_ACME_DIR;;
                --token) AGENT_TOKEN=$2; export AGENT_TOKEN;;
                --binary) source_binary=$(absolute "$2");;
                --version) version=$2;;
                --sing-box-version) core_version=$2;;
                --sing-box-binary) SING_BOX_BINARY=$(absolute "$2"); export SING_BOX_BINARY;;
                --sing-box-config) SING_BOX_CONFIG=$(absolute "$2"); export SING_BOX_CONFIG;;
                --work-dir) SING_BOX_WORK_DIR=$(absolute "$2"); export SING_BOX_WORK_DIR;;
                --auto-start) SING_BOX_AUTO_START=$2; export SING_BOX_AUTO_START;;
                --service) AGENT_SERVICE=$2; export AGENT_SERVICE;;
            esac
            shift 2;;
        *) fail "Unknown option: $1";;
    esac
done

[ "$(id -u)" = 0 ] || fail "Run as root."
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
        unit=/etc/init.d/sing-box-agent
        for tool in rc-service rc-update supervise-daemon; do
            command -v "$tool" >/dev/null 2>&1 || fail "Alpine requires OpenRC ($tool is missing)."
        done
        [ -x /sbin/openrc-run ] || fail 'Alpine requires /sbin/openrc-run.';;
    *" debian "*|*" ubuntu "*)
        system=Debian
        driver=systemd
        unit=/etc/systemd/system/sing-box-agent.service
        command -v systemctl >/dev/null 2>&1 || fail 'Debian-based systems require systemd.';;
    *) fail "Unsupported Linux distribution: $distribution. Use Debian-based Linux or Alpine.";;
esac
printf 'Detected: %s, %s -> %s, %s\n' "$system" "$machine" "$arch" "$driver"

control_service() {
    if [ "$driver" = systemd ]; then systemctl "$1" "$2"; else rc-service "$2" "$1"; fi
}
service_running() {
    if [ "$driver" = systemd ]; then systemctl is-active --quiet "$1"; else rc-service "$1" status >/dev/null 2>&1; fi
}

target=/usr/local/bin/sing-box-agent
config=/etc/sing-box-manager/agent.json
stage=$(mktemp -d "${TMPDIR:-/tmp}/sbm-agent.XXXXXX")
committed=0
was_running=0
core_service=
core_running=0
core_touched=0
core_present=0
core_enabled=
core_unit=
service_running sing-box-agent && was_running=1 || :

cleanup() {
    status=$?
    trap - EXIT HUP INT TERM
    set +e
    if [ "$status" -ne 0 ] && [ "$committed" = 1 ]; then
        printf '%s\n' 'Deployment failed; restoring previous Agent files.' >&2
        control_service stop sing-box-agent
        for name in binary config unit; do
            case "$name" in binary) destination=$target;; config) destination=$config;; unit) destination=$unit;; esac
            if [ -f "$stage/previous-$name" ]; then
                cp -p "$stage/previous-$name" "$destination.new"
                mv -f "$destination.new" "$destination"
            else
                rm -f "$destination"
            fi
        done
        if [ "$driver" = systemd ]; then systemctl daemon-reload; fi
        if [ "$core_touched" = 1 ]; then
            if [ "$driver" = systemd ]; then
                case "$core_enabled" in
                    enabled) systemctl enable "$core_unit";;
                    enabled-runtime) systemctl enable --runtime "$core_unit";;
                esac
            else
                while IFS= read -r level; do rc-update add "$core_service" "$level"; done < "$stage/core-runlevels"
            fi
            if [ "$core_running" = 1 ]; then control_service start "$core_service"; fi
        fi
        if [ "$was_running" = 1 ]; then control_service start sing-box-agent; fi
    fi
    case "$stage" in "${TMPDIR:-/tmp}"/sbm-agent.*) rm -rf -- "$stage";; esac
    exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM HUP

fetch() {
    if command -v curl >/dev/null 2>&1; then
        curl -fLsS --connect-timeout 10 --max-time 180 "$1" -o "$2"
    elif command -v wget >/dev/null 2>&1; then
        wget -q -T 180 -O "$2" "$1"
    else
        fail 'curl or wget is required to download; alternatively pass --binary PATH.'
    fi
}

if [ -n "$source_binary" ]; then
    [ -f "$source_binary" ] || fail "Agent binary not found: $source_binary"
    cp "$source_binary" "$stage/agent"
else
    case "$version" in
        latest) release=https://github.com/zahuiron/sing-box-manager/releases/latest/download;;
        *[!A-Za-z0-9._-]*) fail 'Invalid release version.';;
        *) release=https://github.com/zahuiron/sing-box-manager/releases/download/$version;;
    esac
    asset=sing-box-agent-linux-$arch.tar.gz
    fetch "$release/$asset" "$stage/package.tar.gz" || fail 'Download failed; no release may be published yet. Use --binary for local deployment.'
    tar -xzf "$stage/package.tar.gz" -O sing-box-agent > "$stage/agent"
fi
chmod 755 "$stage/agent"

mkdir -p /usr/local/bin /etc/sing-box-manager
if [ "$install_core" = 1 ]; then
    "$stage/agent" -config "$config" -install-sing-box -sing-box-version "$core_version"
fi
"$stage/agent" -config "$config" -write-config "$stage/agent.json"
service_info=$("$stage/agent" -config "$stage/agent.json" -service-info)
core_service=${service_info#* }
case "$core_service" in sing-box-agent|sing-box-agent.service|sing-box-panel|sing-box-panel.service) fail 'Core service name conflicts with a manager service.';; esac
if [ "$driver" = systemd ]; then
    core_load=$(systemctl show "$core_service" --property=LoadState --value 2>/dev/null || :)
    case "$core_load" in
        loaded|masked)
            core_present=1
            core_unit=$(systemctl show "$core_service" --property=Id --value)
            core_enabled=$(systemctl is-enabled "$core_unit" 2>/dev/null || :);;
        not-found) :;;
        *) fail "Cannot inspect existing core service: $core_service";;
    esac
else
    : > "$stage/core-runlevels"
    if [ -f "/etc/init.d/$core_service" ]; then
        core_present=1
        for level_path in /etc/runlevels/*; do
            if [ -L "$level_path/$core_service" ]; then printf '%s\n' "${level_path##*/}" >> "$stage/core-runlevels"; fi
        done
    fi
fi
if [ "$core_present" = 1 ]; then
    service_running "$core_service" && core_running=1 || :
    previous_info=$("$stage/agent" -config "$config" -service-info 2>/dev/null || :)
    if [ "$core_running" = 0 ] && [ "${previous_info%% *}" != process ] && [ -z "${SING_BOX_AUTO_START+x}" ]; then
        SING_BOX_AUTO_START=false
        export SING_BOX_AUTO_START
        "$stage/agent" -config "$config" -write-config "$stage/agent.json"
    fi
fi

if [ "$driver" = systemd ]; then
    cat > "$stage/unit" <<'EOF'
[Unit]
Description=sing-box manager Agent
After=network.target

[Service]
Type=simple
ExecStart=/usr/local/bin/sing-box-agent -config /etc/sing-box-manager/agent.json
ExecReload=/bin/kill -HUP $MAINPID
Restart=on-failure
RestartSec=3
TimeoutStopSec=10
KillMode=mixed

[Install]
WantedBy=multi-user.target
EOF
    chmod 644 "$stage/unit"
else
    cat > "$stage/unit" <<'EOF'
#!/sbin/openrc-run
description="sing-box manager Agent"
supervisor="supervise-daemon"
command="/usr/local/bin/sing-box-agent"
command_args="-config /etc/sing-box-manager/agent.json"
respawn_delay=3
respawn_max=5
respawn_period=60
retry="TERM/10/KILL/1"
output_log="/var/log/sing-box-agent.log"
error_log="/var/log/sing-box-agent.log"
extra_started_commands="reload"
depend() { after net dns; }
reload() {
    ebegin "Reloading Agent TLS certificate"
    supervise-daemon "$RC_SVCNAME" --signal HUP
    eend $?
}
EOF
    chmod 755 "$stage/unit"
fi

for name in binary config unit; do
    case "$name" in binary) original=$target;; config) original=$config;; unit) original=$unit;; esac
    if [ -f "$original" ]; then cp -p "$original" "$stage/previous-$name"; fi
done
committed=1
if [ "$was_running" = 1 ]; then control_service stop sing-box-agent; fi
if [ "$core_present" = 1 ]; then
    core_touched=1
    if [ "$core_running" = 1 ]; then control_service stop "$core_service"; fi
    if [ "$driver" = systemd ]; then
        case "$core_enabled" in
            enabled) systemctl disable "$core_unit";;
            enabled-runtime) systemctl disable --runtime "$core_unit";;
        esac
    else
        while IFS= read -r level; do rc-update del "$core_service" "$level"; done < "$stage/core-runlevels"
    fi
fi
cp "$stage/agent" "$target.new"
chmod 755 "$target.new"
mv -f "$target.new" "$target"
cp "$stage/agent.json" "$config.new"
chmod 600 "$config.new"
mv -f "$config.new" "$config"
cp -p "$stage/unit" "$unit"

if [ "$driver" = systemd ]; then systemctl daemon-reload; fi
control_service start sing-box-agent
sleep 1
service_running sing-box-agent || fail 'Agent did not remain running.'
if [ "$driver" = systemd ]; then systemctl enable sing-box-agent; else rc-update add sing-box-agent default; fi
committed=0
printf 'Agent deployed (%s). Config: %s\nNode token is stored in the protected config file.\n' "$driver" "$config"
