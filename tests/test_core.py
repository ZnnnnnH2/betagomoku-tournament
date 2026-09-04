from __future__ import annotations

import json
import unittest
import tempfile
from pathlib import Path

from gomoku_tournament.core import (
    BLACK,
    WHITE,
    blank_board,
    exact_five,
    finished_fixture,
    group_table,
    knockout_decision,
    new_tournament,
    next_fixture,
    play_game,
    prepare_knockout,
)
from gomoku_tournament.storage import RunStore
from gomoku_tournament.display import dashboard_payload


class TournamentCoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.roster = [f"202520{number:04d}" for number in range(1, 21)]

    def test_exact_five_rejects_overline(self) -> None:
        board = blank_board()
        for col in range(6):
            board[7][col] = BLACK
        self.assertEqual(exact_five(board), -1)
        board = blank_board()
        for col in range(5):
            board[7][col] = WHITE
        self.assertEqual(exact_five(board), WHITE)

    def test_group_schedule_has_30_double_fixtures(self) -> None:
        state = new_tournament(self.roster, "seed")
        self.assertEqual(len(state["groups"]), 5)
        self.assertTrue(all(len(group["players"]) == 4 for group in state["groups"]))
        self.assertEqual(len(state["group_fixtures"]), 30)
        self.assertEqual(next_fixture(state)["phase"], "group")

    def test_knockout_draw_avoids_same_group(self) -> None:
        state = new_tournament(self.roster, "seed")
        for fixture in state["group_fixtures"]:
            black, white = fixture["players"]
            fixture["games"] = [
                {"black": black, "white": white, "winner": "black", "moves": 20, "reason": "five"},
                {"black": white, "white": black, "winner": "white", "moves": 21, "reason": "five"},
            ]
            finished_fixture(state, fixture)
        prepare_knockout(state)
        first_round = state["knockout"]["rounds"][0]
        self.assertEqual(len(first_round), 4)
        self.assertTrue(all(item["groups"][0] != item["groups"][1] for item in first_round))

    def test_group_table_counts_draw_as_white_win(self) -> None:
        state = new_tournament(self.roster, "seed")
        fixture = state["group_fixtures"][0]
        black, white = fixture["players"]
        fixture["games"] = [
            {"black": black, "white": white, "winner": "draw", "moves": 225, "reason": "draw"},
            {"black": white, "white": black, "winner": "black", "moves": 30, "reason": "five"},
        ]
        finished_fixture(state, fixture)
        rows = {row["uid"]: row for row in group_table(state, fixture["group"])}
        self.assertEqual(rows[white]["wins"], 2)
        self.assertEqual(rows[white]["white_wins"], 1)

    def test_store_writes_readable_recovery_files(self) -> None:
        state = new_tournament(self.roster, "seed")
        fixture = state["group_fixtures"][0]
        black, white = fixture["players"]
        fixture["games"] = [
            {"black": black, "white": white, "winner": "black", "moves": 31, "reason": "five", "finished_at": "2026-09-04T09:00:00+08:00"},
            {"black": white, "white": black, "winner": "white", "moves": 32, "reason": "five", "finished_at": "2026-09-04T09:01:00+08:00"},
        ]
        finished_fixture(state, fixture)
        with tempfile.TemporaryDirectory() as temporary:
            store = RunStore(Path(temporary))
            store.save(state)
            replay_path = store.save_game_record(fixture, 1, fixture["games"][0])
            self.assertEqual(store.load()["groups"], state["groups"])
            self.assertIn("2026-09-04T09:00:00", store.csv_path.read_text(encoding="utf-8-sig"))
            self.assertIn("# BetaGomoku 赛事报告", store.report_path.read_text(encoding="utf-8"))
            self.assertEqual(json.loads(replay_path.read_text(encoding="utf-8"))["moves"], 31)

    def test_dashboard_reads_live_board_without_changing_tournament_state(self) -> None:
        state = new_tournament(self.roster, "seed")
        with tempfile.TemporaryDirectory() as temporary:
            store = RunStore(Path(temporary))
            store.save(state)
            store.save_live({"updated_at": "2026-09-04T09:00:00+08:00", "tables": [{"black": "b", "white": "w", "board": [[-1]], "moves": 1}]})
            payload = dashboard_payload(Path(temporary))
            self.assertEqual(payload["live"]["tables"][0]["moves"], 1)
            self.assertEqual(store.load()["group_fixtures"][0]["status"], "pending")

    def test_knockout_decision_exposes_the_same_tiebreak_used_for_advancement(self) -> None:
        state = new_tournament(self.roster, "seed")
        fixture = {
            "id": "qf-01",
            "games": [
                {"black": "A", "white": "B", "winner": "black", "moves": 31, "reason": "five"},
                {"black": "B", "white": "A", "winner": "black", "moves": 20, "reason": "five"},
            ],
        }
        winner, basis = knockout_decision(state, fixture)
        self.assertEqual(winner, "B")
        self.assertEqual(basis, "黑棋获胜手数更少")

    def test_completed_game_contains_a_replayable_move_history(self) -> None:
        moves = iter([(7, 0), (0, 0), (7, 1), (0, 1), (7, 2), (0, 2), (7, 3), (0, 3), (7, 4)])
        game = play_game("black", "white", lambda _uid, _input: next(moves))
        self.assertEqual(game["winner"], "black")
        self.assertEqual(game["moves"], 9)
        self.assertEqual(game["history"][0], {"ply": 1, "color": "black", "row": 7, "col": 0})
        self.assertEqual(game["history"][-1]["color"], "black")


if __name__ == "__main__":
    unittest.main()
