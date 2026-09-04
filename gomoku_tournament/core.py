"""与浏览器无关的赛制、平台棋局规则和报告生成。"""

from __future__ import annotations

from collections import defaultdict
from copy import deepcopy
from datetime import datetime, timezone
import random
from typing import Any, Callable

BOARD_SIZE = 15
EMPTY, BLACK, WHITE = -1, 0, 1


class PlayerFault(RuntimeError):
    """平台已经执行了选手程序，但结果按平台规则应判负。"""


class ServiceUnavailable(RuntimeError):
    """网络或平台暂不可用；不能把它记为选手输棋。"""


def utc_now() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat(timespec="seconds")


def fixture_id(prefix: str, number: int) -> str:
    return f"{prefix}-{number:02d}"


def parse_roster(text: str) -> list[str]:
    ids: list[str] = []
    for line in text.splitlines():
        content = line.split("#", 1)[0].strip()
        for raw in content.replace(",", " ").replace("，", " ").split():
            if not raw.isdigit() or len(raw) < 6:
                raise ValueError(f"不是有效学号：{raw}")
            if raw in ids:
                raise ValueError(f"学号重复：{raw}")
            ids.append(raw)
    if len(ids) != 20:
        raise ValueError(f"赛制固定为 20 人，当前名单有 {len(ids)} 人。")
    return ids


def new_tournament(roster: list[str], seed: str) -> dict[str, Any]:
    """创建固定的随机分组和 30 场小组双局对阵。"""
    if len(roster) != 20 or len(set(roster)) != 20:
        raise ValueError("必须提供 20 名互不重复的选手。")
    rng = random.Random(seed)
    shuffled = roster[:]
    rng.shuffle(shuffled)
    ties = {uid: rng.random() for uid in shuffled}
    groups = [
        {"name": chr(ord("A") + index), "players": shuffled[index * 4 : index * 4 + 4]}
        for index in range(5)
    ]
    fixtures: list[dict[str, Any]] = []
    number = 1
    for group in groups:
        players = group["players"]
        for left in range(4):
            for right in range(left + 1, 4):
                fixtures.append(
                    {
                        "id": fixture_id("group", number),
                        "phase": "group",
                        "group": group["name"],
                        "round": f"小组 {group['name']}",
                        "players": [players[left], players[right]],
                        "games": [],
                        "status": "pending",
                    }
                )
                number += 1
    return {
        "format": 1,
        "created_at": utc_now(),
        "seed": seed,
        "roster": shuffled,
        "tie_draws": ties,
        "groups": groups,
        "group_fixtures": fixtures,
        "knockout": None,
        "events": [],
    }


def blank_board() -> list[list[int]]:
    return [[EMPTY for _ in range(BOARD_SIZE)] for _ in range(BOARD_SIZE)]


def exact_five(board: list[list[int]]) -> int:
    for row in range(BOARD_SIZE):
        for col in range(BOARD_SIZE):
            color = board[row][col]
            if color == EMPTY:
                continue
            for dr, dc in ((0, 1), (1, 0), (1, 1), (1, -1)):
                end_row, end_col = row + dr * 4, col + dc * 4
                if not (0 <= end_row < BOARD_SIZE and 0 <= end_col < BOARD_SIZE):
                    continue
                if any(board[row + dr * step][col + dc * step] != color for step in range(1, 5)):
                    continue
                before_row, before_col = row - dr, col - dc
                after_row, after_col = row + dr * 5, col + dc * 5
                extends_before = (
                    0 <= before_row < BOARD_SIZE
                    and 0 <= before_col < BOARD_SIZE
                    and board[before_row][before_col] == color
                )
                extends_after = (
                    0 <= after_row < BOARD_SIZE
                    and 0 <= after_col < BOARD_SIZE
                    and board[after_row][after_col] == color
                )
                if not extends_before and not extends_after:
                    return color
    return EMPTY


def long_ban(board: list[list[int]], row: int, col: int) -> bool:
    for dr, dc in ((1, 0), (0, 1), (1, 1), (1, -1)):
        length = 1
        r, c = row - dr, col - dc
        while 0 <= r < BOARD_SIZE and 0 <= c < BOARD_SIZE and board[r][c] == BLACK:
            length += 1
            r, c = r - dr, c - dc
        r, c = row + dr, col + dc
        while 0 <= r < BOARD_SIZE and 0 <= c < BOARD_SIZE and board[r][c] == BLACK:
            length += 1
            r, c = r + dr, c + dc
        if length > 5:
            return True
    return False


def four_on_line(board: list[list[int]], row: int, col: int, dr: int, dc: int) -> int:
    """逐字等价于平台页面的 getFourOnOneLine。"""
    before, middle, after = 0, 1, 0
    gap = False
    r, c = row - dr, col - dc
    while True:
        if not (0 <= r < BOARD_SIZE and 0 <= c < BOARD_SIZE) or board[r][c] == WHITE:
            if not gap:
                before = -1
            break
        if board[r][c] == BLACK:
            if gap:
                before += 1
            else:
                middle += 1
        else:
            if gap:
                break
            gap = True
        r, c = r - dr, c - dc
    gap = False
    r, c = row + dr, col + dc
    while True:
        if not (0 <= r < BOARD_SIZE and 0 <= c < BOARD_SIZE) or board[r][c] == WHITE:
            if not gap:
                after = -1
            break
        if board[r][c] == BLACK:
            if gap:
                after += 1
            else:
                middle += 1
        else:
            if gap:
                break
            gap = True
        r, c = r + dr, c + dc
    if middle == 4:
        return 1 if before == 0 or after == 0 else 0
    return int(before > 0 and before + middle == 4) + int(after > 0 and middle + after == 4)


def four_four_ban(board: list[list[int]], row: int, col: int) -> bool:
    return sum(four_on_line(board, row, col, dr, dc) for dr, dc in ((1, 0), (0, 1), (-1, 1), (1, 1))) > 1


def platform_input(board: list[list[int]], color: int) -> str:
    return f"{color}\n" + "\n".join(" ".join(map(str, row)) for row in board) + "\n"


MoveProvider = Callable[[str, str], tuple[int, int]]
MoveObserver = Callable[[int, list[list[int]], int, int, int], None]


def play_game(black_uid: str, white_uid: str, move_for: MoveProvider, observe_move: MoveObserver | None = None) -> dict[str, Any]:
    """执行单局，并复刻网页的胜负和禁手处理。"""
    board = blank_board()
    color = BLACK
    moves = 0
    history: list[dict[str, Any]] = []
    while exact_five(board) == EMPTY:
        if moves == BOARD_SIZE * BOARD_SIZE:
            return {"black": black_uid, "white": white_uid, "winner": "draw", "moves": moves, "history": history, "reason": "draw"}
        uid = black_uid if color == BLACK else white_uid
        try:
            row, col = move_for(uid, platform_input(board, color))
            if not (0 <= row < BOARD_SIZE and 0 <= col < BOARD_SIZE):
                raise PlayerFault("Move outside board")
            if board[row][col] != EMPTY:
                raise PlayerFault("Tried to put on another chess piece")
            if color == BLACK and long_ban(board, row, col):
                raise PlayerFault("LongBan")
            if color == BLACK and four_four_ban(board, row, col):
                raise PlayerFault("FourFourBan")
            board[row][col] = color
            moves += 1
            history.append({"ply": moves, "color": "black" if color == BLACK else "white", "row": row, "col": col})
            if observe_move:
                # 看板只读这份快照；比赛状态仍只在一局结束后才持久化。
                observe_move(moves, deepcopy(board), color, row, col)
        except ServiceUnavailable:
            raise
        except PlayerFault as error:
            winner = WHITE if color == BLACK else BLACK
            return {
                "black": black_uid,
                "white": white_uid,
                "winner": "black" if winner == BLACK else "white",
                "moves": moves,
                "history": history,
                "reason": f"Player #{color} FATAL ERROR: {error}",
            }
        color = WHITE if color == BLACK else BLACK
    winner = exact_five(board)
    return {
        "black": black_uid,
        "white": white_uid,
        "winner": "black" if winner == BLACK else "white",
        "moves": moves,
        "history": history,
        "reason": "five",
    }


def score_winner(game: dict[str, Any]) -> str:
    """本赛制平局判白方胜。"""
    return game["black"] if game["winner"] == "black" else game["white"]


def group_table(state: dict[str, Any], group_name: str) -> list[dict[str, Any]]:
    group = next(group for group in state["groups"] if group["name"] == group_name)
    rows = {
        uid: {"uid": uid, "wins": 0, "white_wins": 0, "black_win_moves": [], "tie": state["tie_draws"][uid]}
        for uid in group["players"]
    }
    for fixture in state["group_fixtures"]:
        if fixture["group"] != group_name or fixture["status"] != "done":
            continue
        for game in fixture["games"]:
            winner = score_winner(game)
            rows[winner]["wins"] += 1
            if winner == game["white"]:
                rows[winner]["white_wins"] += 1
            if winner == game["black"]:
                rows[winner]["black_win_moves"].append(game["moves"])
    result = []
    for row in rows.values():
        black_moves = row["black_win_moves"]
        result.append({**row, "black_average": sum(black_moves) / len(black_moves) if black_moves else None})
    return result


def rank_rows(rows: list[dict[str, Any]]) -> list[dict[str, Any]]:
    return sorted(
        rows,
        key=lambda row: (
            -row["wins"],
            -row["white_wins"],
            row["black_average"] if row["black_average"] is not None else float("inf"),
            row["tie"],
        ),
    )


def all_groups_done(state: dict[str, Any]) -> bool:
    return all(fixture["status"] == "done" for fixture in state["group_fixtures"])


def _pair_avoiding_groups(entries: list[dict[str, str]], rng: random.Random) -> list[tuple[dict[str, str], dict[str, str]]]:
    entries = entries[:]
    rng.shuffle(entries)
    pairs: list[tuple[dict[str, str], dict[str, str]]] = []

    def search(remaining: list[dict[str, str]]) -> bool:
        if not remaining:
            return True
        first = remaining[0]
        candidates = remaining[1:]
        rng.shuffle(candidates)
        for second in candidates:
            if first["group"] == second["group"]:
                continue
            rest = [entry for entry in remaining if entry is not first and entry is not second]
            pairs.append((first, second))
            if search(rest):
                return True
            pairs.pop()
        return False

    if not search(entries):
        raise RuntimeError("无法构造满足同组回避的八强签表。")
    return pairs


def prepare_knockout(state: dict[str, Any]) -> None:
    if state["knockout"] is not None:
        return
    if not all_groups_done(state):
        raise RuntimeError("小组赛尚未全部结束。")
    group_rankings = [(group["name"], rank_rows(group_table(state, group["name"]))) for group in state["groups"]]
    entrants = [{"uid": ranking[0]["uid"], "group": name} for name, ranking in group_rankings]
    seconds = []
    for name, ranking in group_rankings:
        seconds.append({**ranking[1], "group": name})
    entrants.extend({"uid": row["uid"], "group": row["group"]} for row in rank_rows(seconds)[:3])
    rng = random.Random(f"{state['seed']}:knockout")
    pairs = _pair_avoiding_groups(entrants, rng)
    fixtures = []
    for number, pair in enumerate(pairs, 1):
        fixtures.append(
            {
                "id": fixture_id("qf", number),
                "phase": "knockout",
                "round": f"八强第 {number} 场",
                "groups": [pair[0]["group"], pair[1]["group"]],
                "players": [pair[0]["uid"], pair[1]["uid"]],
                "games": [],
                "status": "pending",
                "winner": None,
            }
        )
    state["knockout"] = {"entrants": entrants, "rounds": [fixtures], "champion": None}
    state["events"].append({"at": utc_now(), "type": "knockout_draw", "entrants": entrants})


def knockout_decision(state: dict[str, Any], fixture: dict[str, Any]) -> tuple[str, str]:
    """返回淘汰赛晋级者及规则中实际使用的判定依据。"""
    first, second = fixture["games"]
    first_winner, second_winner = score_winner(first), score_winner(second)
    if first_winner == second_winner:
        return first_winner, "两局计分胜者一致"
    rng = random.Random(f"{state['seed']}:{fixture['id']}")
    black_wins = first_winner == first["black"] and second_winner == second["black"]
    if black_wins:
        if first["moves"] != second["moves"]:
            return (first_winner if first["moves"] < second["moves"] else second_winner), "黑棋获胜手数更少"
        return (first_winner if rng.random() < 0.5 else second_winner), "黑棋获胜手数相同，稳定抽签"
    # 另一个 1:1 分支只能是双方各以白棋得分。
    first_actual, second_actual = first["winner"] == "white", second["winner"] == "white"
    if first_actual != second_actual:
        return (first_winner if first_actual else second_winner), "白棋实际取胜优先于平局计白胜"
    if first_actual and first["moves"] != second["moves"]:
        return (first_winner if first["moves"] < second["moves"] else second_winner), "白棋获胜手数更少"
    return (first_winner if rng.random() < 0.5 else second_winner), "规则指标相同，稳定抽签"


def knockout_winner(state: dict[str, Any], fixture: dict[str, Any]) -> str:
    """保留简洁接口，供赛程逻辑和外部调用使用。"""
    return knockout_decision(state, fixture)[0]


def _advance_knockout(state: dict[str, Any]) -> None:
    knockout = state["knockout"]
    current = knockout["rounds"][-1]
    if not all(fixture["status"] == "done" for fixture in current):
        return
    winners = [fixture["winner"] for fixture in current]
    if len(winners) == 1:
        knockout["champion"] = winners[0]
        return
    label = "半决赛" if len(winners) == 4 else "决赛"
    prefix = "sf" if len(winners) == 4 else "final"
    next_round = []
    for index in range(0, len(winners), 2):
        number = index // 2 + 1
        next_round.append(
            {
                "id": fixture_id(prefix, number),
                "phase": "knockout",
                "round": f"{label}第 {number} 场",
                "groups": [],
                "players": [winners[index], winners[index + 1]],
                "games": [],
                "status": "pending",
                "winner": None,
            }
        )
    knockout["rounds"].append(next_round)


def next_fixture(state: dict[str, Any]) -> dict[str, Any] | None:
    for fixture in state["group_fixtures"]:
        if fixture["status"] != "done":
            return fixture
    prepare_knockout(state)
    knockout = state["knockout"]
    if knockout["champion"]:
        return None
    current = knockout["rounds"][-1]
    fixture = next((item for item in current if item["status"] != "done"), None)
    if fixture is not None:
        return fixture
    _advance_knockout(state)
    return next_fixture(state)


def finished_fixture(state: dict[str, Any], fixture: dict[str, Any]) -> None:
    fixture["status"] = "done"
    if fixture["phase"] == "knockout":
        fixture["winner"], fixture["winner_basis"] = knockout_decision(state, fixture)
    state["events"].append(
        {"at": utc_now(), "type": "fixture_finished", "fixture": fixture["id"], "winner": fixture.get("winner")}
    )


def games_rows(state: dict[str, Any]) -> list[dict[str, Any]]:
    fixtures = state["group_fixtures"][:]
    if state["knockout"]:
        fixtures.extend(fixture for round_ in state["knockout"]["rounds"] for fixture in round_)
    rows = []
    for fixture in fixtures:
        for game_index, game in enumerate(fixture["games"], 1):
            rows.append(
                {
                    "fixture": fixture["id"],
                    "phase": fixture["phase"],
                    "group_or_round": fixture.get("group") or fixture["round"],
                    "game": game_index,
                    "black": game["black"],
                    "white": game["white"],
                    "raw_result": game["winner"],
                    "scored_winner": score_winner(game),
                    "moves": game["moves"],
                    "reason": game["reason"],
                    "finished_at": game.get("finished_at", ""),
                }
            )
    return rows


def markdown_report(state: dict[str, Any]) -> str:
    lines = ["# BetaGomoku 赛事报告", "", f"- 创建时间：{state['created_at']}", f"- 抽签种子：`{state['seed']}`", ""]
    for group in state["groups"]:
        lines.extend([f"## 小组 {group['name']}", "", "| 排名 | 学号 | 总胜 | 白胜 | 黑胜平均手数 |", "| --- | --- | ---: | ---: | ---: |"])
        for rank, row in enumerate(rank_rows(group_table(state, group["name"])), 1):
            average = "—" if row["black_average"] is None else f"{row['black_average']:.2f}"
            lines.append(f"| {rank} | {row['uid']} | {row['wins']} | {row['white_wins']} | {average} |")
        lines.append("")
    if state["knockout"]:
        lines.extend(["## 淘汰赛", "", "八强：" + "、".join(item["uid"] for item in state["knockout"]["entrants"]), ""])
        for round_ in state["knockout"]["rounds"]:
            for fixture in round_:
                result = fixture["winner"] or "待赛"
                lines.append(f"- {fixture['round']}：{fixture['players'][0]} vs {fixture['players'][1]}；晋级：{result}")
        if state["knockout"]["champion"]:
            lines.extend(["", f"**冠军：{state['knockout']['champion']}**"])
    lines.append("")
    return "\n".join(lines)
