from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[2]
HEARTBEAT_SECONDS = 15
REALTIME_ENV_KEYS = (
    "REALTIME_EVENT_RETENTION_SECONDS",
    "REALTIME_EVENT_PAYLOAD_MAX_BYTES",
    "REALTIME_REPLAY_LIMIT",
    "REALTIME_SUBSCRIBER_QUEUE_SIZE",
    "REALTIME_CONNECTION_LIMIT_PER_ACTOR",
    "REALTIME_HEARTBEAT_SECONDS",
    "REALTIME_DISPATCH_POLL_SECONDS",
    "REALTIME_CLEANUP_INTERVAL_SECONDS",
    "REALTIME_SSE_SEND_TIMEOUT_SECONDS",
)


def require(text: str, fragment: str, source: Path) -> None:
    if fragment not in text:
        raise AssertionError(f"{source}: missing realtime contract fragment: {fragment}")


def main() -> None:
    caddy_path = ROOT / "deploy" / "Caddyfile"
    nginx_path = ROOT / "ops" / "ec2" / "nginx.asklake.conf"
    compose_path = ROOT / "deploy" / "docker-compose.prod.yml"
    backend_env_path = ROOT / "backend" / ".env.example"
    deploy_env_path = ROOT / "deploy" / ".env.example"

    caddy = caddy_path.read_text(encoding="utf-8")
    nginx = nginx_path.read_text(encoding="utf-8")
    compose = compose_path.read_text(encoding="utf-8")
    backend_env = backend_env_path.read_text(encoding="utf-8")
    deploy_env = deploy_env_path.read_text(encoding="utf-8")

    for fragment in (
        "not path /api/realtime/events",
        "encode @not_realtime zstd gzip",
        "@realtime path /api/realtime/events",
        "flush_interval -1",
    ):
        require(caddy, fragment, caddy_path)

    for fragment in (
        "location = /api/realtime/events",
        "proxy_buffering off",
        "proxy_cache off",
        "gzip off",
        'add_header Cache-Control "no-cache, no-transform" always',
        'add_header X-Accel-Buffering "no" always',
    ):
        require(nginx, fragment, nginx_path)

    read_timeout = re.search(r"proxy_read_timeout\s+(\d+)s", nginx)
    send_timeout = re.search(r"proxy_send_timeout\s+(\d+)s", nginx)
    if read_timeout is None or int(read_timeout.group(1)) <= HEARTBEAT_SECONDS:
        raise AssertionError("NGINX realtime read timeout must exceed the heartbeat interval")
    if send_timeout is None or int(send_timeout.group(1)) <= HEARTBEAT_SECONDS:
        raise AssertionError("NGINX realtime send timeout must exceed the heartbeat interval")

    for key in REALTIME_ENV_KEYS:
        require(backend_env, f"{key}=", backend_env_path)
        require(deploy_env, f"{key}=", deploy_env_path)
        require(compose, f"{key}:", compose_path)

    print("Realtime proxy and deployment contract verification passed.")


if __name__ == "__main__":
    main()
