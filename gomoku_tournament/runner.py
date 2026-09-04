"""命令行入口：运行、暂停和恢复本地赛事。"""

from __future__ import annotations

import argparse
from datetime import datetime
from pathlib import Path
import sys
import time
from typing import Any

from .core import ServiceUnavailable, all_groups_done, blank_board, finished_fixture, new_tournament, next_fixture, parse_roster, play_game, utc_now
from .display import serve_dashboard
from .platform import PlatformClient
from .storage import RunStore


def default_run_dir() -> Path:
    return Path("runs") / datetime.now().strftime("%Y-%m-%d_%H-%M-%S")


def profile_for(run_dir: Path, browser: str) -> Path:
    return run_dir.parent.parent / "data" / f"browser-profile-{browser}"


def validate_roster(client: PlatformClient, state: dict[str, Any]) -> None:
    missing = [uid for uid in state["roster"] if uid not in client.available_players()]
    if missing:
        raise RuntimeError("以下学号当前没有可执行提交：" + "、".join(missing))


def _publish_live(
    store: RunStore,
    fixture: dict[str, Any],
    game_number: int,
    black: str,
    white: str,
    moves: int = 0,
    board: list[list[int]] | None = None,
    last_move: list[int] | None = None,
    message: str = "正在对局",
    status: str = "playing",
) -> None:
    store.save_live(
        {
            "updated_at": utc_now(),
            "status": status,
            "tables": [
                {
                    "table": 1,
                    "fixture_id": fixture["id"],
                    "phase": fixture["phase"],
                    "round": fixture["round"],
                    "group": fixture.get("group"),
                    "game": game_number,
                    "black": black,
                    "white": white,
                    "moves": moves,
                    "board": board if board is not None else blank_board(),
                    "last_move": last_move,
                    "message": message,
                }
            ],
        }
    )


def _wait_for_next_game(store: RunStore, fixture: dict[str, Any], game_number: int) -> None:
    game_key = f"{fixture['id']}:{game_number}"
    store.arm_next_game(game_key)
    print("本局已保存；请在大屏看板点击“开始下一局”。")
    while not store.consume_next_game(game_key):
        time.sleep(0.2)


def _wait_for_restored_control(store: RunStore) -> None:
    control = store.read_control()
    if not control:
        return
    game_key = control.get("game_key")
    if not isinstance(game_key, str):
        store.clear_control()
        return
    print("检测到上一局已结束，继续等待大屏看板的“开始下一局”按钮。")
    while not store.consume_next_game(game_key):
        time.sleep(0.2)


def run_one_fixture(state: dict[str, Any], store: RunStore, client: PlatformClient, manual_next: bool) -> bool:
    fixture = next_fixture(state)
    if fixture is None:
        return False
    fixture["status"] = "running"
    store.log({"at": utc_now(), "type": "fixture_started", "fixture": fixture["id"], "players": fixture["players"]})
    store.save(state)
    pair = fixture["players"]
    orders = [(pair[0], pair[1]), (pair[1], pair[0])]
    for index in range(len(fixture["games"]), 2):
        black, white = orders[index]
        store.log({"at": utc_now(), "type": "game_started", "fixture": fixture["id"], "game": index + 1, "black": black, "white": white})
        print(f"{fixture['round']}，第 {index + 1}/2 局：{black} 黑 vs {white} 白")
        _publish_live(store, fixture, index + 1, black, white)
        final_board = blank_board()
        final_last_move: list[int] | None = None

        def observe(moves: int, board: list[list[int]], color: int, row: int, col: int) -> None:
            nonlocal final_board, final_last_move
            final_board, final_last_move = board, [row, col]
            _publish_live(store, fixture, index + 1, black, white, moves, board, [row, col])
            print(f"  {moves} 手", end="\r", flush=True)

        try:
            game = play_game(black, white, client.move_for, observe)
        except ServiceUnavailable:
            # 当前局没有加入 games；下一次会从同一局重新开始。
            print()
            store.save(state)
            raise
        print(f"  结束：{game['winner']}，{game['moves']} 手，{game['reason']}" + " " * 20)
        game["finished_at"] = utc_now()
        fixture["games"].append(game)
        # 先提交唯一断点状态：此后中断也绝不会重赛已经结束的一局。
        store.save(state)
        store.save_game_record(fixture, index + 1, game)
        store.log({"at": utc_now(), "type": "game_finished", "fixture": fixture["id"], "game": game})
        if game["winner"] == "draw":
            outcome = f"本局平局；规则计 {game['white']} 白胜；{game['moves']} 手"
        else:
            winner = game["black"] if game["winner"] == "black" else game["white"]
            outcome = f"本局结束：{winner} 获胜；{game['moves']} 手"
        _publish_live(
            store, fixture, index + 1, black, white, game["moves"], final_board, final_last_move,
            outcome, "waiting_for_next" if manual_next else "completed",
        )
        if manual_next:
            _wait_for_next_game(store, fixture, index + 1)
    finished_fixture(state, fixture)
    store.save(state)
    return True


def command_init(args: argparse.Namespace) -> int:
    run_dir = Path(args.run_dir) if args.run_dir else default_run_dir()
    store = RunStore(run_dir)
    if store.state_path.exists():
        raise RuntimeError(f"运行目录已存在：{run_dir}")
    roster = parse_roster(Path(args.roster).read_text(encoding="utf-8"))
    state = new_tournament(roster, args.seed)
    state["run_dir"] = str(run_dir.resolve())
    state["browser"] = args.browser
    store.save(state)
    print(f"已创建：{run_dir.resolve()}")
    print("下一步：python3 -m gomoku_tournament.runner login --run-dir " + str(run_dir))
    return 0


def command_login(args: argparse.Namespace) -> int:
    run_dir = Path(args.run_dir)
    store = RunStore(run_dir)
    state = store.load()
    browser = state.get("browser", "default")
    with PlatformClient(profile_for(run_dir, browser), browser=browser) as client:
        client.wait_for_login()
        validate_roster(client, state)
    print("登录成功，且 20 名选手均有可执行提交。")
    return 0


def command_run(args: argparse.Namespace) -> int:
    run_dir = Path(args.run_dir)
    store = RunStore(run_dir)
    state = store.load()
    limit = {"next": 1, "group": 30, "all": 37}[args.mode]
    completed = 0
    browser = state.get("browser", "default")
    manual_next = not args.auto_next
    try:
        _wait_for_restored_control(store)
        with PlatformClient(profile_for(run_dir, browser), browser=browser) as client:
            client.wait_for_login()
            validate_roster(client, state)
            while completed < limit:
                fixture = next_fixture(state)
                if fixture is None:
                    break
                if args.mode == "group" and fixture["phase"] != "group":
                    break
                run_one_fixture(state, store, client, manual_next)
                completed += 1
    finally:
        # 已结束局留在看板上；只有未完成局的临时棋盘需要清除。
        live = None
        try:
            import json
            live = json.loads(store.live_path.read_text(encoding="utf-8"))
        except (FileNotFoundError, json.JSONDecodeError):
            pass
        if live and live.get("status") == "playing":
            store.clear_live()
            store.clear_control()
        elif not live or live.get("status") != "waiting_for_next":
            store.clear_control()
    print(f"本次完成 {completed} 场双局。文件已写入：{run_dir.resolve()}")
    return 0


def command_status(args: argparse.Namespace) -> int:
    run_dir = Path(args.run_dir)
    state = RunStore(run_dir).load()
    done = sum(len(item["games"]) for item in state["group_fixtures"])
    print(f"运行目录：{run_dir.resolve()}")
    print(f"小组赛已完成：{done}/60 局")
    if state["knockout"] and state["knockout"]["champion"]:
        print("冠军：" + state["knockout"]["champion"])
    elif not all_groups_done(state):
        fixture = next(item for item in state["group_fixtures"] if item["status"] != "done")
        print(f"下一场：{fixture['round']}，{fixture['players'][0]} vs {fixture['players'][1]}")
    elif state["knockout"] is None:
        print("小组赛已完成；下一次执行会生成八强签表。")
    else:
        current = state["knockout"]["rounds"][-1]
        fixture = next((item for item in current if item["status"] != "done"), None)
        if fixture:
            print(f"下一场：{fixture['round']}，{fixture['players'][0]} vs {fixture['players'][1]}")
        else:
            print("当前轮已结束；下一次执行会生成下一轮。")
    return 0


def command_display(args: argparse.Namespace) -> int:
    run_dir = Path(args.run_dir)
    RunStore(run_dir).load()  # 在启动服务前及早报告路径或状态文件错误。
    serve_dashboard(run_dir, args.host, args.port, open_browser=not args.no_open)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="BetaGomoku 本地赛事运行器")
    sub = parser.add_subparsers(dest="command", required=True)
    init = sub.add_parser("init", help="创建本地赛程目录")
    init.add_argument("--roster", required=True, help="20 人名单文本文件")
    init.add_argument("--run-dir", help="输出目录，默认自动创建 runs/时间戳")
    init.add_argument("--seed", default=datetime.now().strftime("%Y-%m-%d"), help="可复现的抽签种子")
    init.add_argument("--browser", choices=("default", "chrome", "edge"), default="default", help="执行浏览器；默认跟随 macOS 默认浏览器")
    init.set_defaults(handler=command_init)
    login = sub.add_parser("login", help="打开持久浏览器，完成一次登录并校验名单")
    login.add_argument("--run-dir", required=True)
    login.set_defaults(handler=command_login)
    for name, help_text in (("next", "执行下一场双局"), ("group", "执行剩余小组赛"), ("all", "执行完整届赛事")):
        run = sub.add_parser(name, help=help_text)
        run.add_argument("--run-dir", required=True)
        run.add_argument("--auto-next", action="store_true", help="不等待大屏按钮，连续执行下一局")
        run.set_defaults(handler=command_run, mode=name)
    status = sub.add_parser("status", help="读取本地状态，不打开浏览器")
    status.add_argument("--run-dir", required=True)
    status.set_defaults(handler=command_status)
    display = sub.add_parser("display", help="启动大屏本地看板（单个网页）")
    display.add_argument("--run-dir", required=True)
    display.add_argument("--host", default="127.0.0.1", help="默认仅本机可访问")
    display.add_argument("--port", type=int, default=8765)
    display.add_argument("--no-open", action="store_true", help="只启动服务，不自动在系统默认浏览器中打开")
    display.set_defaults(handler=command_display)
    return parser


def main() -> int:
    args = build_parser().parse_args()
    try:
        return args.handler(args)
    except KeyboardInterrupt:
        print("\n已中断：已完成局已保存，当前未完成局不会记分。", file=sys.stderr)
        return 130
    except Exception as error:
        print(f"错误：{error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
