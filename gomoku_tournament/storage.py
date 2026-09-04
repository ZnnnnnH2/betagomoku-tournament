"""原子化保存运行状态，并生成便于人工查阅的文件。"""

from __future__ import annotations

import csv
import json
import os
from pathlib import Path
from threading import Lock
from typing import Any

from .core import games_rows, markdown_report


_CONTROL_LOCK = Lock()


class RunStore:
    def __init__(self, run_dir: Path):
        self.run_dir = run_dir
        self.logs_dir = run_dir / "logs"
        self.replays_dir = run_dir / "replays"
        self.state_path = run_dir / "tournament.json"
        self.csv_path = run_dir / "games.csv"
        self.report_path = run_dir / "report.md"
        self.events_path = self.logs_dir / "events.jsonl"
        # 这是大屏的临时画面，不是可恢复的赛事状态。
        self.live_path = run_dir / "live.json"
        # 当前运行器与本机大屏之间的一次性“开始下一局”信号。
        self.control_path = run_dir / "control.json"

    def create(self) -> None:
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        self.replays_dir.mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _atomic_text(path: Path, text: str) -> None:
        temporary = path.with_suffix(path.suffix + ".tmp")
        temporary.write_text(text, encoding="utf-8")
        os.replace(temporary, path)

    def save(self, state: dict[str, Any]) -> None:
        self.create()
        self._atomic_text(self.state_path, json.dumps(state, ensure_ascii=False, indent=2) + "\n")
        rows = games_rows(state)
        temporary = self.csv_path.with_suffix(".csv.tmp")
        fields = ["fixture", "phase", "group_or_round", "game", "black", "white", "raw_result", "scored_winner", "moves", "reason", "finished_at"]
        with temporary.open("w", newline="", encoding="utf-8-sig") as file:
            writer = csv.DictWriter(file, fieldnames=fields)
            writer.writeheader()
            writer.writerows(rows)
        os.replace(temporary, self.csv_path)
        self._atomic_text(self.report_path, markdown_report(state))

    def load(self) -> dict[str, Any]:
        return json.loads(self.state_path.read_text(encoding="utf-8"))

    def log(self, event: dict[str, Any]) -> None:
        self.create()
        with self.events_path.open("a", encoding="utf-8") as file:
            file.write(json.dumps(event, ensure_ascii=False) + "\n")

    def save_game_record(self, fixture: dict[str, Any], game_number: int, game: dict[str, Any]) -> Path:
        """为每一局结束后的完整棋谱生成独立、可复盘的本地文件。"""
        self.create()
        path = self.replays_dir / f"{fixture['id']}-game-{game_number}.json"
        record = {
            "format": "beta-gomoku-record-1.0",
            "fixture": fixture["id"],
            "phase": fixture["phase"],
            "group_or_round": fixture.get("group") or fixture["round"],
            "game": game_number,
            **game,
        }
        self._atomic_text(path, json.dumps(record, ensure_ascii=False, indent=2) + "\n")
        return path

    def save_live(self, live: dict[str, Any]) -> None:
        """原子更新供本地看板轮询的临时棋盘。"""
        self.create()
        self._atomic_text(self.live_path, json.dumps(live, ensure_ascii=False) + "\n")

    def clear_live(self) -> None:
        """中断后不留下可被误认为正式赛果的半盘棋。"""
        if self.live_path.exists():
            self.live_path.unlink()

    def read_control(self) -> dict[str, Any] | None:
        try:
            return json.loads(self.control_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            return None

    def arm_next_game(self, game_key: str) -> None:
        """只允许看板确认当前刚刚结束的一局。"""
        with _CONTROL_LOCK:
            self.create()
            self._atomic_text(self.control_path, json.dumps({"game_key": game_key, "status": "waiting"}, ensure_ascii=False) + "\n")

    def approve_next_game(self) -> bool:
        """供本机看板调用；重复点击只会成功一次。"""
        with _CONTROL_LOCK:
            control = self.read_control()
            if not control or control.get("status") != "waiting":
                return False
            control["status"] = "approved"
            self._atomic_text(self.control_path, json.dumps(control, ensure_ascii=False) + "\n")
            return True

    def consume_next_game(self, game_key: str) -> bool:
        with _CONTROL_LOCK:
            control = self.read_control()
            if not control or control.get("game_key") != game_key or control.get("status") != "approved":
                return False
            self.control_path.unlink(missing_ok=True)
            return True

    def clear_control(self) -> None:
        with _CONTROL_LOCK:
            self.control_path.unlink(missing_ok=True)
