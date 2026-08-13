#!/usr/bin/env python3
"""Create a persistent Telegram user session using QR login."""

import argparse
import asyncio
import json
import os
from pathlib import Path

import qrcode
from telethon import TelegramClient, errors


def read_config(path: Path) -> dict:
    config = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(config.get("apiId"), int) or not config.get("apiHash"):
        raise ValueError("MTProto API ID/API Hash 未配置")
    return config


async def authorize(config_path: Path, qr_path: Path) -> None:
    config = read_config(config_path)
    session_path = Path(os.path.expanduser(config.get("sessionPath") or str(config_path.with_suffix(".session"))))
    session_path.parent.mkdir(parents=True, exist_ok=True)
    client = TelegramClient(str(session_path), config["apiId"], config["apiHash"])
    await client.connect()
    try:
        if await client.is_user_authorized():
            me = await client.get_me()
            print(json.dumps({"ok": True, "alreadyAuthorized": True, "userId": int(me.id)}))
            return
        while True:
            qr_login = await client.qr_login()
            qrcode.make(qr_login.url).save(qr_path)
            os.chmod(qr_path, 0o600)
            print(json.dumps({"event": "qr_ready", "path": str(qr_path), "url": qr_login.url}), flush=True)
            try:
                user = await qr_login.wait(timeout=55)
                print(json.dumps({"ok": True, "userId": int(user.id)}), flush=True)
                return
            except asyncio.TimeoutError:
                continue
            except errors.SessionPasswordNeededError:
                print(json.dumps({"ok": False, "code": "password_needed"}), flush=True)
                return
    finally:
        await client.disconnect()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--qr", required=True)
    args = parser.parse_args()
    asyncio.run(authorize(
        Path(os.path.expanduser(args.config)).resolve(),
        Path(os.path.expanduser(args.qr)).resolve(),
    ))


if __name__ == "__main__":
    main()
