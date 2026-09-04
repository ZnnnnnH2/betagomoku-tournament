"""原子化保存运行状态，并生成便于人工查阅的文件。"""

from __future__ import annotations

import csv
import json
import os
from pathlib import Path
from typing import Any

from .core import games_rows, markdown_report


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
