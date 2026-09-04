"""本机大屏看板：只读取赛事文件，不参与判定或保存赛果。"""

from __future__ import annotations

from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
from pathlib import Path
import subprocess
from typing import Any
from urllib.parse import urlparse

from .core import all_groups_done, group_table, rank_rows, score_winner
from .storage import RunStore


PAGE = r"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>BetaGomoku 赛事看板</title><style>
:root{color-scheme:light;--ink:#172435;--muted:#637287;--paper:#fff;--wash:#f3f6f9;--line:#d7e0e8;--blue:#165d9f;--gold:#9a6613;--black:#111;--green:#197a52;--red:#b23a35}
*{box-sizing:border-box}body{margin:0;background:var(--wash);color:var(--ink);font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;min-width:1080px}header{height:10vh;min-height:72px;padding:1.1rem 3vw;display:flex;align-items:center;justify-content:space-between;background:var(--paper);border-bottom:1px solid var(--line)}h1{font-size:clamp(1.4rem,2.2vw,2.3rem);margin:0;letter-spacing:.04em}.actions{display:flex;align-items:center;gap:1rem}.meta{color:var(--muted);font-size:1rem;text-align:right}.live{color:var(--green);font-weight:700}.next{border:0;border-radius:8px;background:var(--blue);color:#fff;padding:.72rem 1.05rem;font:700 1rem inherit;box-shadow:0 2px 5px #165d9f3b}.next:disabled{background:#b8c5d0;color:#f8fafc;box-shadow:none}.shell{display:grid;grid-template-columns:minmax(580px,1.18fr) minmax(470px,.82fr);gap:1.1rem;padding:1.1rem 2.2vw 1.4rem;height:90vh}.stage,.side{min-height:0}.stage{display:flex;flex-direction:column}.match{height:100%;border:1px solid var(--line);border-radius:14px;background:var(--paper);padding:1rem;display:grid;grid-template-rows:auto minmax(0,1fr);box-shadow:0 3px 14px #18273812}.matchhead{display:flex;justify-content:space-between;align-items:baseline;gap:1rem;padding:0 .35rem .7rem}.round{font-size:1.2rem;font-weight:700}.players{font-size:1rem;color:var(--muted);white-space:nowrap}.blackdot,.whitedot{display:inline-block;width:.75rem;height:.75rem;border-radius:50%;vertical-align:middle;margin-right:.3rem}.blackdot{background:var(--black)}.whitedot{background:#fff;border:1px solid #9aa7b5}.boardwrap{display:grid;place-items:center;min-height:0}.board{display:block;width:min(100%,calc(90vh - 190px));aspect-ratio:1;background:#d4a85d;border:8px solid #654520;border-radius:4px;box-shadow:inset 0 0 0 1px #f2ce88,0 7px 16px #4d37152a}.empty{color:var(--muted);text-align:center;font-size:1.15rem}.side{overflow:auto;scrollbar-color:#bdcbd8 transparent}.overview{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.65rem;margin-bottom:.8rem}.metric,.group,.bracket{border:1px solid var(--line);background:var(--paper);border-radius:10px;padding:.72rem}.metric b{display:block;font-size:1.5rem;color:var(--blue);margin-top:.15rem}.metric span,.group h2,.bracket h2{font-size:.86rem;color:var(--muted);font-weight:600;margin:0}.groups{display:grid;gap:.65rem}.group h2{color:var(--blue);margin-bottom:.45rem;font-size:1rem}.ranking{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}.ranking th{color:var(--muted);font-size:.72rem;font-weight:600;padding:.2rem .12rem;text-align:right;white-space:nowrap}.ranking th:nth-child(1),.ranking th:nth-child(2),.ranking td:nth-child(1),.ranking td:nth-child(2){text-align:left}.ranking td{padding:.3rem .12rem;border-top:1px solid #e8edf2;font-size:.84rem;text-align:right;white-space:nowrap}.ranking .leader{color:var(--blue);font-weight:700}.basis{font-size:.76rem;color:var(--muted);padding-top:.38rem}.bracket{margin-top:.7rem}.bracket h2{color:var(--blue);font-size:1rem}.fixture{padding:.48rem 0;border-top:1px solid #e1e8ee;font-size:.84rem}.fixture:first-of-type{border-top:0}.fixturehead{display:flex;justify-content:space-between;gap:.5rem;font-weight:650}.winner{color:var(--gold);white-space:nowrap}.game{display:block;color:var(--muted);padding:.13rem 0 0 .2rem}.basis strong{color:var(--ink)}
@media (min-width:1800px){.shell{grid-template-columns:minmax(800px,1.42fr) minmax(530px,.72fr)}.groups{grid-template-columns:repeat(2,minmax(0,1fr))}.board{width:min(100%,calc(90vh - 165px))}}
</style></head><body><header><h1>BetaGomoku 赛事看板</h1><div class="actions"><div class="meta" id="meta">正在读取本地赛事文件…</div><button class="next" id="next" disabled>等待本局结束</button></div></header><main class="shell"><section class="stage" id="stage"></section><aside class="side"><section class="overview" id="overview"></section><section class="groups" id="groups"></section><section class="bracket" id="bracket" hidden></section></aside></main>
<script>
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const nextButton=document.querySelector('#next');
async function requestNext(){nextButton.disabled=true;nextButton.textContent='正在开始…';try{const res=await fetch('/api/next',{method:'POST'});if(!res.ok)throw Error();nextButton.textContent='已确认'}catch(_){nextButton.textContent='确认失败，请重试'}}
nextButton.addEventListener('click',requestNext);
function boardCanvas(table){const canvas=document.createElement('canvas');canvas.className='board';canvas.width=900;canvas.height=900;const ctx=canvas.getContext('2d'),n=15,p=34,s=(900-2*p)/(n-1);ctx.fillStyle='#d4a85d';ctx.fillRect(0,0,900,900);ctx.strokeStyle='#4f351b';ctx.lineWidth=2;for(let i=0;i<n;i++){ctx.beginPath();ctx.moveTo(p,p+i*s);ctx.lineTo(900-p,p+i*s);ctx.stroke();ctx.beginPath();ctx.moveTo(p+i*s,p);ctx.lineTo(p+i*s,900-p);ctx.stroke()}[[3,3],[3,11],[7,7],[11,3],[11,11]].forEach(([r,c])=>{ctx.beginPath();ctx.arc(p+c*s,p+r*s,6,0,Math.PI*2);ctx.fillStyle='#4f351b';ctx.fill()});(table.board||[]).forEach((row,r)=>row.forEach((v,c)=>{if(v===-1)return;const x=p+c*s,y=p+r*s;ctx.beginPath();ctx.arc(x,y,s*.39,0,Math.PI*2);const g=ctx.createRadialGradient(x-s*.15,y-s*.18,s*.05,x,y,s*.42);if(v===0){g.addColorStop(0,'#505a63');g.addColorStop(1,'#080b0e')}else{g.addColorStop(0,'#fff');g.addColorStop(1,'#c9cbc9')}ctx.fillStyle=g;ctx.fill();if(table.last_move&&table.last_move[0]===r&&table.last_move[1]===c){ctx.strokeStyle=v===0?'#9a6613':'#b23a35';ctx.lineWidth=5;ctx.beginPath();ctx.arc(x,y,s*.43,0,Math.PI*2);ctx.stroke()}}));return canvas}
function groupCard(g){return `<article class="group"><h2>小组 ${esc(g.name)}</h2><table class="ranking"><thead><tr><th>排</th><th>学号</th><th>总胜</th><th>白胜</th><th>黑胜均手</th><th>抽签序</th></tr></thead><tbody>${g.rows.map((r,i)=>`<tr class="${i===0?'leader':''}"><td>${i+1}</td><td>${esc(r.uid)}</td><td>${r.wins}</td><td>${r.white_wins}</td><td>${r.black_average===null?'—':r.black_average.toFixed(2)}</td><td>${r.tie_order}</td></tr>`).join('')}</tbody></table><div class="basis">排序：总胜 → 白胜 → 黑棋获胜平均手数（少优先）→ 稳定抽签序</div></article>`}
function gameText(g,i){const raw={black:'黑胜',white:'白胜',draw:'平局（计白胜）'}[g.winner]||g.winner;return `第 ${i+1} 局：${esc(g.black)} 黑 vs ${esc(g.white)} 白；${raw}，计分 ${esc(g.scored_winner)}，${g.moves} 手`}
function render(data){const live=data.live&&data.live.tables&&data.live.tables[0],t=live||data.current;document.querySelector('#meta').innerHTML=`<span class="${live?'live':''}">${live?'● 对局进行中':'● 等待下一场'}</span><br>${esc(data.updated_at||'本地文件')}`;const stage=document.querySelector('#stage');stage.innerHTML='';const card=document.createElement('article');card.className='match';if(!t){card.innerHTML='<div class="empty">赛事已经全部结束</div>';stage.append(card)}else{const name=t.round||t.fixture_id||'下一场';card.innerHTML=`<div class="matchhead"><div><div class="round">${esc(name)} · 第 ${esc(t.game||1)} 局</div><div class="players"><i class="blackdot"></i>${esc(t.black)}　<i class="whitedot"></i>${esc(t.white)}　${esc(t.moves||0)} 手</div></div><div class="players">${esc(t.message||'待开始')}</div></div>`;const wrap=document.createElement('div');wrap.className='boardwrap';wrap.append(live?boardCanvas(t):Object.assign(document.createElement('div'),{className:'empty',textContent:'本局尚未开始'}));card.append(wrap);stage.append(card)}document.querySelector('#overview').innerHTML=`<div class="metric"><span>已完成对局</span><b>${data.completed_games} / 74</b></div><div class="metric"><span>当前阶段</span><b>${esc(data.phase)}</b></div>`;document.querySelector('#groups').innerHTML=data.groups.map(groupCard).join('');const bracket=document.querySelector('#bracket');if(data.knockout.length){bracket.hidden=false;bracket.innerHTML='<h2>淘汰赛（两局数据与晋级判定）</h2>'+data.knockout.map(f=>`<div class="fixture"><div class="fixturehead"><span>${esc(f.round)}：${esc(f.players[0])} vs ${esc(f.players[1])}</span><span class="winner">${esc(f.winner||'待赛')}</span></div>${f.games.map(gameText).map(t=>`<span class="game">${t}</span>`).join('')}${f.winner_basis?`<div class="basis"><strong>晋级依据：</strong>${esc(f.winner_basis)}</div>`:''}</div>`).join('')}else bracket.hidden=true}
function renderControl(data){const ready=data.control&&data.control.status==='waiting';nextButton.disabled=!ready;nextButton.textContent=ready?'开始下一局':'等待本局结束';if(data.live&&data.live.status==='waiting_for_next')document.querySelector('#meta').innerHTML='<span class="live">● 本局结束，等待裁判确认</span><br>'+esc(data.updated_at||'')}
async function refresh(){try{const res=await fetch('/api/state',{cache:'no-store'});if(!res.ok)throw Error();const data=await res.json();render(data);renderControl(data)}catch(_){document.querySelector('#meta').textContent='看板暂时无法读取本地赛事文件'}}refresh();setInterval(refresh,1000);
</script></body></html>"""


def _read_live(store: RunStore) -> dict[str, Any] | None:
    try:
        return json.loads(store.live_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return None


def _pending_fixture(state: dict[str, Any]) -> dict[str, Any] | None:
    for fixture in state["group_fixtures"]:
        if fixture["status"] != "done":
            return fixture
    knockout = state.get("knockout")
    if not knockout:
        return None
    for round_ in knockout["rounds"]:
        for fixture in round_:
            if fixture["status"] != "done":
                return fixture
    return None


def _group_rows(state: dict[str, Any], group_name: str) -> list[dict[str, Any]]:
    rows = rank_rows(group_table(state, group_name))
    tie_order = {row["uid"]: index for index, row in enumerate(sorted(rows, key=lambda row: row["tie"]), 1)}
    return [
        {"uid": row["uid"], "wins": row["wins"], "white_wins": row["white_wins"], "black_average": row["black_average"], "tie_order": tie_order[row["uid"]]}
        for row in rows
    ]


def dashboard_payload(run_dir: Path) -> dict[str, Any]:
    """序列化为浏览器所需的只读视图；不修改 tournament.json。"""
    store = RunStore(run_dir)
    state = store.load()
    groups = [{"name": group["name"], "rows": _group_rows(state, group["name"])} for group in state["groups"]]
    fixtures = state["group_fixtures"][:]
    knockout_view = []
    if state.get("knockout"):
        for round_ in state["knockout"]["rounds"]:
            fixtures.extend(round_)
            for fixture in round_:
                knockout_view.append({"round": fixture["round"], "players": fixture["players"], "winner": fixture.get("winner"), "winner_basis": fixture.get("winner_basis"), "games": [{**game, "scored_winner": score_winner(game)} for game in fixture["games"]]})
    next_item = _pending_fixture(state)
    current = None
    if next_item:
        game = len(next_item["games"]) + 1
        black, white = next_item["players"] if game == 1 else list(reversed(next_item["players"]))
        current = {"fixture_id": next_item["id"], "round": next_item["round"], "phase": next_item["phase"], "game": game, "black": black, "white": white, "moves": 0, "message": "等待比赛程序开始"}
    completed = sum(len(fixture["games"]) for fixture in fixtures)
    phase = "小组赛" if not all_groups_done(state) else ("已结束" if state.get("knockout", {}).get("champion") else "淘汰赛")
    live = _read_live(store)
    return {"updated_at": live.get("updated_at") if live else state["created_at"], "live": live, "control": store.read_control(), "current": current, "groups": groups, "knockout": knockout_view, "completed_games": completed, "phase": phase}


class DashboardHandler(BaseHTTPRequestHandler):
    run_dir: Path

    def do_GET(self) -> None:  # noqa: N802
        target = urlparse(self.path).path
        if target == "/":
            self._send(200, "text/html; charset=utf-8", PAGE.encode("utf-8"))
        elif target == "/api/state":
            try:
                self._send(200, "application/json; charset=utf-8", json.dumps(dashboard_payload(self.run_dir), ensure_ascii=False).encode("utf-8"))
            except (FileNotFoundError, json.JSONDecodeError) as error:
                self._send(503, "application/json; charset=utf-8", json.dumps({"error": str(error)}).encode("utf-8"))
        else:
            self._send(404, "text/plain; charset=utf-8", b"Not found")

    def do_POST(self) -> None:  # noqa: N802
        if urlparse(self.path).path != "/api/next":
            self._send(404, "text/plain; charset=utf-8", b"Not found")
            return
        accepted = RunStore(self.run_dir).approve_next_game()
        status = 200 if accepted else 409
        self._send(status, "application/json; charset=utf-8", json.dumps({"accepted": accepted}).encode("utf-8"))

    def _send(self, status: int, content_type: str, body: bytes) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *_args: Any) -> None:
        return


def serve_dashboard(run_dir: Path, host: str, port: int, open_browser: bool) -> None:
    handler = type("TournamentDashboardHandler", (DashboardHandler,), {"run_dir": run_dir})
    server = ThreadingHTTPServer((host, port), handler)
    url = f"http://{host}:{port}/"
    print(f"大屏看板已启动：{url}")
    if open_browser:
        subprocess.Popen(["open", url])
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n已关闭大屏看板。")
    finally:
        server.server_close()
