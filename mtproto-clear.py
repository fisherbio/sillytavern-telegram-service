#!/usr/bin/env python3
"""Clear the complete private-chat history with the configured Telegram bot."""

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

from telethon import TelegramClient
from telethon.tl.types import MessageActionHistoryClear


def emit(payload: dict, exit_code: int = 0) -> None:
    print(json.dumps(payload, ensure_ascii=False))
    raise SystemExit(exit_code)


def read_config(path: Path) -> dict:
    try:
        config = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        emit({"ok": False, "code": "not_configured", "message": "MTProto 尚未配置"}, 2)
    except (OSError, json.JSONDecodeError) as error:
        emit({"ok": False, "code": "bad_config", "message": f"MTProto 配置无效：{error}"}, 2)
    if not isinstance(config.get("apiId"), int) or not config.get("apiHash"):
        emit({"ok": False, "code": "bad_config", "message": "MTProto API ID/API Hash 未配置"}, 2)
    return config


def is_history_clear_marker(message) -> bool:
    """Telegram keeps this internal service marker after clearing a dialog."""
    return isinstance(getattr(message, "action", None), MessageActionHistoryClear)


async def clear_history(config_path: Path, peer: str) -> None:
    config = read_config(config_path)
    session_path = Path(os.path.expanduser(config.get("sessionPath") or str(config_path.with_suffix(".session"))))
    session_file = session_path if session_path.suffix == ".session" else Path(f"{session_path}.session")
    session_path.parent.mkdir(parents=True, exist_ok=True)
    if session_file.exists():
        os.chmod(session_file, 0o600)
    client = TelegramClient(str(session_path), config["apiId"], config["apiHash"])
    await client.connect()
    try:
        if not await client.is_user_authorized():
            emit({"ok": False, "code": "not_authorized", "message": "Telegram 用户账号尚未授权"}, 3)
        me = await client.get_me()
        if getattr(me, "bot", False):
            emit({"ok": False, "code": "bot_session", "message": "清空全部历史必须使用用户账号会话"}, 3)
        entity = await client.get_entity(peer)
        deleted_count = 0
        batch_count = 0
        while True:
            messages = await client.get_messages(entity, limit=100)
            message_ids = [int(message.id) for message in messages if not is_history_clear_marker(message)]
            if not message_ids:
                break
            await client.delete_messages(entity, message_ids, revoke=True)
            deleted_count += len(message_ids)
            batch_count += 1
            if batch_count >= 1_000:
                emit({
                    "ok": False,
                    "code": "batch_limit",
                    "message": "消息数量超过安全批次上限，清理未完全结束",
                    "deletedCount": deleted_count,
                }, 4)
            await asyncio.sleep(0.2)

        remaining = await client.get_messages(entity, limit=100)
        remaining_count = sum(1 for message in remaining if not is_history_clear_marker(message))
        if remaining_count > 0:
            emit({
                "ok": False,
                "code": "verification_failed",
                "message": f"服务器仍保留 {remaining_count} 条消息",
                "deletedCount": deleted_count,
                "remainingCount": remaining_count,
            }, 4)

        emit({
            "ok": True,
            "peer": peer,
            "authorizedUserId": int(me.id),
            "deletedCount": deleted_count,
            "remainingCount": 0,
            "message": "Telegram 私聊全部历史已清空",
        })
    finally:
        await client.disconnect()
        if session_file.exists():
            os.chmod(session_file, 0o600)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", required=True)
    parser.add_argument("--peer", required=True)
    args = parser.parse_args()
    config_path = Path(os.path.expanduser(args.config)).resolve()
    try:
        asyncio.run(clear_history(config_path, args.peer))
    except SystemExit:
        raise
    except Exception as error:  # Telethon errors are surfaced without credentials.
        emit({"ok": False, "code": type(error).__name__, "message": str(error)}, 1)


if __name__ == "__main__":
    main()
