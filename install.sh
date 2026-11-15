#!/bin/sh
set -eu
cd "$(dirname "$0")"

show_access=0
local_mode=0
advanced=0
for flag in "$@"; do
  case "$flag" in
    --local) local_mode=1 ;;
    --advanced) advanced=1 ;;
    --show-access) show_access=1 ;;
    --help|-h) printf '%s\n' 'Usage: sh install.sh [--local] [--advanced] [--show-access]'; exit 0 ;;
    *) printf 'Unknown option: %s\n' "$flag" >&2; exit 2 ;;
  esac
done

if [ "$advanced" -eq 1 ] && [ "$local_mode" -ne 1 ]; then
  echo "Use --local with --advanced." >&2
  exit 2
fi

if [ "$local_mode" -eq 1 ]; then
  export ABDB_BIND=127.0.0.1 ABDB_LOCAL_ONLY=1 COOKIE_SECURE=0
  export ABDB_IP='' ABDB_DOMAIN=''
fi

if [ "$show_access" -eq 0 ]; then
  export ABDB_ADVANCED_ENABLED="$advanced"
  if [ "$local_mode" -eq 1 ]; then
    engine_version=$(docker version --format '{{.Server.Version}}')
    major=${engine_version%%.*}
    case "$major" in
      ''|*[!0-9]*) echo 'Could not determine the Docker Engine version.' >&2; exit 1 ;;
    esac
    if [ "$major" -lt 28 ]; then
      echo 'Local-only mode requires Docker Engine 28 or newer. Upgrade Docker and rerun the installer.' >&2
      exit 1
    fi
  fi
  if [ "$advanced" -eq 1 ]; then
    docker compose --profile advanced up --build -d --wait
  else
    docker compose up --build -d --wait
  fi
fi

compose_value() {
  docker compose exec -T abdbadmin printenv "$1" 2>/dev/null || true
}
port=$(compose_value ABDB_PORT)
running_local=$(compose_value ABDB_LOCAL_ONLY)
if [ "$local_mode" -eq 1 ] && [ "$running_local" != 1 ]; then
  echo 'This instance was started without --local. Run sh install.sh --local to apply local-only mode.' >&2
  exit 1
fi

printf '\nAbDbAdmin\n'
printf 'Local:       http://127.0.0.1:%s\n' "${port:-8099}"
if [ "$running_local" = 1 ]; then
  printf '%s\n' 'Local-only mode: Docker publishes the port on 127.0.0.1.'
else
  ip=$(compose_value ABDB_IP)
  domain=$(compose_value ABDB_DOMAIN)
  if [ -z "$ip" ] && command -v ip >/dev/null 2>&1; then
    ip=$(ip -4 route get 192.0.2.1 2>/dev/null | awk '{for (i=1;i<NF;i++) if ($i=="src") {print $(i+1);exit}}')
  fi
  if [ -z "$ip" ] && command -v hostname >/dev/null 2>&1; then
    ip=$(hostname -I 2>/dev/null | awk '{print $1}')
  fi
  case "$ip" in
    \[*\]) ;;
    *:*) ip="[$ip]" ;;
    '') ip='{ip}' ;;
  esac
  if [ -z "$domain" ]; then domain='{domain}'; fi
  printf 'Private IP:  http://%s:%s\n' "$ip" "${port:-8099}"
  printf 'HTTPS:       https://%s\n' "$domain"
  printf 'Redirect:    http://%s:8080\n' "$domain"
  printf '%s\n' 'The IP and domain links require network or proxy setup. Use HTTPS for remote sign-in.'
fi
if [ "$advanced" -eq 1 ]; then
  address=$(docker compose --profile advanced port phpmyadmin 80)
  printf 'Advanced MySQL/MariaDB: http://%s\n' "$address"
fi
docker compose exec -T abdbadmin node --disable-warning=ExperimentalWarning server.mjs show-access
