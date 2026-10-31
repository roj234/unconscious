#!/bin/sh
# sadbox linux-helper.sh
#
# Runs as the first process inside the bubblewrap sandbox (uid 0 in the user
# namespace).  Sets up the COW overlay (kernel overlayfs when root, otherwise
# fuse-overlayfs), rebuilds the virtual filesystems inside the merged root,
# applies the fileWhitelist / fileBlacklist policy, signals readiness to the
# host process, then drops all capabilities and execs the payload inside the
# merged root.
#
# Environment (set by linux-impl.js via bwrap --setenv):
#   SADBOX_LOWER     -> /lower        (host root, read-only, overlay lower)
#   SADBOX_UPPER     -> /sadbox-upper (overlay upperdir / COW layer)
#   SADBOX_WORK      -> /sadbox-work  (overlay workdir)
#   SADBOX_MERGE     -> /merged       (overlay mountpoint, chroot target)
#   SADBOX_META      -> /sadbox-meta  (sandbox dir bind, host-visible)
#   SADBOX_READY     -> /sadbox-meta/ready    (readiness marker)
#   SADBOX_ERRFILE   -> /sadbox-meta/setup.log
#   SADBOX_WL_FILE   -> /sadbox-meta/whitelist.map (one host path per line)
#   SADBOX_BLACKLIST -> newline-separated deny paths
#   SADBOX_CWD       -> working directory inside the merged root
#   SADBOX_ROOT      -> "1" when running with real root (kernel overlayfs)
#   SADBOX=1
#
# argv after "--": the payload command (preserved; helper execs it).

set -eu

[ "${1:-}" = "--" ] && shift

log()  { [ -n "${SADBOX_ERRFILE:-}" ] && echo "sadbox: $*" >> "$SADBOX_ERRFILE" || true; }
fail() { log "$*"; exit 1; }

[ -n "${SADBOX_MERGE:-}" ] || fail "SADBOX_MERGE not set"
[ -n "${SADBOX_LOWER:-}" ] || fail "SADBOX_LOWER not set"
[ -n "${SADBOX_UPPER:-}" ] || fail "SADBOX_UPPER not set"
[ -n "${SADBOX_WORK:-}" ]  || fail "SADBOX_WORK not set"

# ------------------------------------------------------------------ #
# 1. COW overlay
# ------------------------------------------------------------------ #
mkdir -p "$SADBOX_MERGE" || fail "cannot mkdir $SADBOX_MERGE"

if [ "${SADBOX_ROOT:-0}" = "1" ] && command -v mount >/dev/null 2>&1; then
    mount -t overlay overlay \
        -o "lowerdir=$SADBOX_LOWER,upperdir=$SADBOX_UPPER,workdir=$SADBOX_WORK" \
        "$SADBOX_MERGE" >> "$SADBOX_ERRFILE" 2>&1 \
        || fail "kernel overlay mount failed (run as root / CAP_SYS_ADMIN required)"
else
    command -v fuse-overlayfs >/dev/null 2>&1 \
        || fail "fuse-overlayfs not found (install fuse-overlayfs), or run as root"
    fuse-overlayfs \
        -o "lowerdir=$SADBOX_LOWER,upperdir=$SADBOX_UPPER,workdir=$SADBOX_WORK" \
        "$SADBOX_MERGE" >> "$SADBOX_ERRFILE" 2>&1 \
        || fail "fuse-overlayfs mount failed (need /dev/fuse; see setup.log)"
fi

# ------------------------------------------------------------------ #
# 2. Virtual filesystems inside the merged root
#    (/proc /sys /dev /tmp /run are separate host mounts, not part of
#    the lower layer, so they must be rebuilt after chroot)
# ------------------------------------------------------------------ #
for m in proc sys dev tmp run dev/shm; do
    mkdir -p "$SADBOX_MERGE/$m"
done
mount -t proc proc "$SADBOX_MERGE/proc"              || log "proc mount failed"
mount -t sysfs sysfs "$SADBOX_MERGE/sys"              || log "sysfs mount failed"
# /dev must be bind-mounted RECURSIVELY (--rbind): as root, bwrap's --dev
# builds /dev as a tmpfs with each host device node bind-mounted in as a
# SUBMOUNT (udev /dev/null, /dev/zero, ...).  A plain `mount --bind` of a
# mountpoint only copies that mount and drops all submounts, leaving an
# empty /dev with bwrap's 444 placeholder files -> "cannot create /dev/null".
mount --rbind /dev "$SADBOX_MERGE/dev" 2>>"$SADBOX_ERRFILE" \
    || mount --bind /dev "$SADBOX_MERGE/dev" 2>>"$SADBOX_ERRFILE" \
    || mount -t tmpfs devtmpfs "$SADBOX_MERGE/dev"    || log "dev mount failed"
mount -t tmpfs tmpfs "$SADBOX_MERGE/tmp"              || log "tmp mount failed"
mount -t tmpfs tmpfs "$SADBOX_MERGE/run"              || log "run mount failed"
mount -t tmpfs tmpfs "$SADBOX_MERGE/dev/shm" 2>>"$SADBOX_ERRFILE" || true

# ------------------------------------------------------------------ #
# 3. fileWhitelist -> direct write (RW bind of the host path on top of
#    the COW view; source binds /sadbox-wl-N are created by bwrap)
# ------------------------------------------------------------------ #
n=0
# `|| [ -n "$p" ]` keeps the last line even when the file lacks a
# trailing newline (dash's `read` otherwise returns EOF and skips it)
while IFS= read -r p || [ -n "$p" ]; do
    case "$p" in /*) ;; *) continue ;; esac
    # the destination may sit on a fresh tmpfs (e.g. /tmp) and not exist
    # in the merged view yet — create it so the direct-write bind applies
    [ -e "$SADBOX_MERGE$p" ] || mkdir -p "$SADBOX_MERGE$p" 2>>"$SADBOX_ERRFILE" || continue
    mount --bind "/sadbox-wl-$n" "$SADBOX_MERGE$p" 2>>"$SADBOX_ERRFILE" \
        || log "whitelist bind failed: $p"
    n=$((n + 1))
done < "${SADBOX_WL_FILE:-/dev/null}" || true

# ------------------------------------------------------------------ #
# 4. fileBlacklist -> deny access (empty tmpfs over dirs, /dev/null
#    over files)
# ------------------------------------------------------------------ #
if [ -n "${SADBOX_BLACKLIST:-}" ]; then
    printf '%s\n' "$SADBOX_BLACKLIST" | while IFS= read -r p; do
        case "$p" in /*) ;; *) continue ;; esac
        if [ -d "$SADBOX_MERGE$p" ]; then
            mount -t tmpfs deny "$SADBOX_MERGE$p" || log "blacklist deny failed: $p"
        elif [ -e "$SADBOX_MERGE$p" ]; then
            # truncate the COW copy in upper (host file untouched).
            # NOTE: do not rely on /dev/null here — some sandboxed/container
            # environments block access to device nodes even for root.
            : > "$SADBOX_MERGE$p" 2>>"$SADBOX_ERRFILE" || log "blacklist deny failed: $p"
        fi
    done || true
fi

# ------------------------------------------------------------------ #
# 5. Signal readiness to the host process
# ------------------------------------------------------------------ #
if [ -n "${SADBOX_READY:-}" ]; then
    echo ready > "$SADBOX_READY" || true
fi

# ------------------------------------------------------------------ #
# 6. chroot into the merged root, drop all capabilities, exec payload.
#    Caps must be dropped *after* chroot so that CAP_SYS_CHROOT /
#    CAP_SYS_ADMIN cannot be used to escape the chroot or unmount the
#    COW layers.  setpriv is preferred; plain chroot as a fallback.
# ------------------------------------------------------------------ #
# avoid `> /dev/null` redirections inside the sandbox: some container
# environments block device-node access even for root, which would print
# spurious "cannot create /dev/null" errors on every start.
if command -v setpriv >/dev/null 2>&1; then
    setpriv_cmd="$(command -v setpriv)"
    if [ -x "$SADBOX_MERGE$setpriv_cmd" ]; then
        exec chroot "$SADBOX_MERGE" "$setpriv_cmd" \
            --bounding-set=-all --inh-caps=-all --no-new-privs \
            /bin/sh -c 'cd "${SADBOX_CWD:-/}" || cd /; exec "$@"' sadbox "$@"
    fi
fi
exec chroot "$SADBOX_MERGE" \
    /bin/sh -c 'cd "${SADBOX_CWD:-/}" || cd /; exec "$@"' sadbox "$@"
