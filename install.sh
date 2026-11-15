#!/bin/sh
set -eu
cd "$(dirname "$0")"

case "${1:-}" in
  '') ;;
  --show-access) ;;
  *) echo 'Использование: ./install.sh [--show-access]' >&2; exit 2 ;;
esac

if [ "${1:-}" != '--show-access' ]; then
  docker compose up --build -d --wait
fi

compose_value() {
  docker compose exec -T abdbadmin printenv "$1" 2>/dev/null || true
}
port=$(compose_value ABDB_PORT)
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
printf '\n%s\n' 'AbDbAdmin'
printf 'Локально                         http://127.0.0.1:%s\n' "${port:-8099}"
printf 'IP сервера (локальная сеть)      http://%s:%s\n' "$ip" "${port:-8099}"
printf 'Домен (вход через HTTPS-прокси)  https://%s\n' "$domain"
printf 'Домен (HTTP-переадресация)       http://%s:8080\n' "$domain"
printf '%s\n' 'IP по HTTP доступен после настройки привязки. По внешней сети используйте HTTPS или SSH-туннель.'
docker compose exec -T abdbadmin node --disable-warning=ExperimentalWarning server.mjs show-access
