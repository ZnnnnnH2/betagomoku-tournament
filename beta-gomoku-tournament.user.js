// ==UserScript==
// @name         BetaGomoku 赛事助手
// @namespace    ruc-gomoku-ta
// @version      1.0.0
// @description  在已登录的 BetaGomoku 页面生成并执行 20 人小组赛与淘汰赛；赛果保存于本机浏览器。
// @match        http://gomoku.ruc.rvalue.moe/*
// @grant        none
// ==/UserScript==

/*
 * 安装方式见 README.md。脚本只调用当前已登录页面所使用的 /api/exec，
 * 不读取、不导出 Cookie；所有赛程和结果存储在此站点的 localStorage 中。
 */
(() => {
  'use strict';

  const STORE_KEY = 'ruc-gomoku-tournament-v1';
  const SIZE = 15;
  const EMPTY = -1;
  const BLACK = 0;
  const WHITE = 1;
  const EXEC_RETRIES = 4;

  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
  const byId = id => document.getElementById(id);
  let runnerActive = false;
  let stopAfterFixture = false;

  class PlayerError extends Error {}
  class ServiceError extends Error {}
  const esc = value => String(value).replace(/[&<>'"]/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[char]);

  function notify(message, error = false) {
    const box = byId('bgta-status');
    if (box) {
      box.textContent = message;
      box.style.color = error ? '#b42318' : '#175cd3';
    }
  }

  function createRng(seed) {
    let state = 2166136261;
    for (const char of String(seed)) {
      state ^= char.charCodeAt(0);
      state = Math.imul(state, 16777619);
    }
    return () => {
      state += 0x6D2B79F5;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
  }

  function shuffled(items, rng) {
    const result = [...items];
    for (let index = result.length - 1; index > 0; index -= 1) {
      const swap = Math.floor(rng() * (index + 1));
      [result[index], result[swap]] = [result[swap], result[index]];
    }
    return result;
  }

  function nowId(prefix) {
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  function parseRoster(text) {
    const seen = new Set();
    const people = [];
    for (const raw of text.split(/[\n,;，；\t ]+/)) {
      const uid = raw.trim();
      if (!uid) continue;
      if (!/^\d{6,}$/.test(uid)) throw new Error(`“${uid}”不是有效学号。`);
      if (seen.has(uid)) throw new Error(`学号 ${uid} 重复。`);
      seen.add(uid);
      people.push({ uid, name: uid, tie: 0 });
    }
    if (people.length !== 20) throw new Error(`需要恰好 20 个学号，当前为 ${people.length} 个。`);
    const available = new Set([...document.querySelectorAll('#player0 option')].map(option => option.value));
    const missing = people.map(person => person.uid).filter(uid => !available.has(uid));
    if (missing.length) throw new Error(`当前页面没有以下学号的已提交程序：${missing.join('、')}`);
    return people;
  }

  function initialState(roster, seed) {
    const rng = createRng(seed);
    const people = shuffled(roster, rng).map(person => ({ ...person, tie: rng() }));
    const groups = ['A', 'B', 'C', 'D', 'E'].map((name, index) => ({
      name,
      people: people.slice(index * 4, index * 4 + 4).map(person => person.uid)
    }));
    const personByUid = Object.fromEntries(people.map(person => [person.uid, person]));
    const fixtures = [];
    for (const group of groups) {
      for (let i = 0; i < group.people.length; i += 1) {
        for (let j = i + 1; j < group.people.length; j += 1) {
          fixtures.push({
            id: nowId(`group-${group.name}`), phase: 'group', group: group.name,
            players: [group.people[i], group.people[j]], status: 'pending', games: []
          });
        }
      }
    }
    return {
      version: 1, seed, createdAt: new Date().toISOString(), personByUid, groups,
      groupFixtures: fixtures, knockout: null, log: []
    };
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      console.error(error);
      return null;
    }
  }

  function saveState(state) {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  }

  function clearState() {
    localStorage.removeItem(STORE_KEY);
  }

  function emptyBoard() {
    return Array.from({ length: SIZE }, () => Array(SIZE).fill(EMPTY));
  }

  function exactFive(board) {
    for (let row = 0; row < SIZE; row += 1) {
      for (let col = 0; col < SIZE; col += 1) {
        const stone = board[row][col];
        if (stone === EMPTY) continue;
        for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
          const endRow = row + dr * 4;
          const endCol = col + dc * 4;
          if (endRow < 0 || endRow >= SIZE || endCol < 0 || endCol >= SIZE) continue;
          let valid = true;
          for (let step = 1; step < 5; step += 1) {
            if (board[row + dr * step][col + dc * step] !== stone) {
              valid = false;
              break;
            }
          }
          if (!valid) continue;
          const afterRow = row + dr * 5;
          const afterCol = col + dc * 5;
          const beforeRow = row - dr;
          const beforeCol = col - dc;
          const extendsAfter = afterRow >= 0 && afterRow < SIZE && afterCol >= 0 && afterCol < SIZE && board[afterRow][afterCol] === stone;
          const extendsBefore = beforeRow >= 0 && beforeRow < SIZE && beforeCol >= 0 && beforeCol < SIZE && board[beforeRow][beforeCol] === stone;
          if (!extendsAfter && !extendsBefore) return stone;
        }
      }
    }
    return EMPTY;
  }

  // 与网站当前 judgeLongBan 完全同义：pos 尚未写入棋盘，len 从新落子计为 1。
  function longBan(board, row, col) {
    for (const [dr, dc] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
      let length = 1;
      for (let r = row - dr, c = col - dc; r >= 0 && r < SIZE && c >= 0 && c < SIZE && board[r][c] === BLACK; r -= dr, c -= dc) length += 1;
      for (let r = row + dr, c = col + dc; r >= 0 && r < SIZE && c >= 0 && c < SIZE && board[r][c] === BLACK; r += dr, c += dc) length += 1;
      if (length > 5) return true;
    }
    return false;
  }

  // 复制平台的“四四”计数，不额外添加平台没有实现的三三禁手。
  function fourOnLine(board, row, col, dr, dc) {
    let before = 0;
    let middle = 1;
    let after = 0;
    let gap = false;
    for (let r = row - dr, c = col - dc; ; r -= dr, c -= dc) {
      if (r < 0 || r >= SIZE || c < 0 || c >= SIZE || board[r][c] === WHITE) {
        if (!gap) before = -1;
        break;
      }
      if (board[r][c] === BLACK) {
        if (gap) before += 1; else middle += 1;
      } else {
        if (gap) break;
        gap = true;
      }
    }
    gap = false;
    for (let r = row + dr, c = col + dc; ; r += dr, c += dc) {
      if (r < 0 || r >= SIZE || c < 0 || c >= SIZE || board[r][c] === WHITE) {
        if (!gap) after = -1;
        break;
      }
      if (board[r][c] === BLACK) {
        if (gap) after += 1; else middle += 1;
      } else {
        if (gap) break;
        gap = true;
      }
    }
    if (middle === 4) return before === 0 || after === 0 ? 1 : 0;
    return (before > 0 && before + middle === 4 ? 1 : 0) + (after > 0 && middle + after === 4 ? 1 : 0);
  }

  function fourFourBan(board, row, col) {
    return [[1, 0], [0, 1], [-1, 1], [1, 1]]
      .reduce((count, [dr, dc]) => count + fourOnLine(board, row, col, dr, dc), 0) > 1;
  }

  function makeInput(board, color) {
    return `${color}\n${board.map(row => row.join(' ')).join('\n')}\n`;
  }

  async function moveFor(uid, board, color) {
    for (let attempt = 1; attempt <= EXEC_RETRIES; attempt += 1) {
      try {
        const response = await fetch('/api/exec', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ uid, input: makeInput(board, color) })
        });
        if (!response.ok) {
          throw new ServiceError(`平台请求失败（HTTP ${response.status}）`);
        }
        let data;
        try { data = await response.json(); }
        catch { throw new ServiceError('平台返回了无法解析的响应'); }
        if (data?.result?.status !== 1) {
          const names = ['Unknown', 'OK', 'Time Limit Exceeded', 'Memory Limit Exceeded', 'Runtime Error', 'Cancelled', 'Output Limit Exceeded'];
          throw new PlayerError(names[data?.result?.status] || `执行状态 ${data?.result?.status}`);
        }
        const parts = String(data.output || '').trim().split(/\s+/).map(Number);
        if (parts.length !== 2 || !parts.every(Number.isInteger)) throw new PlayerError('Invalid output');
        return parts;
      } catch (error) {
        if (error instanceof PlayerError) throw error;
        const serviceError = error instanceof ServiceError ? error : new ServiceError(`网络连接失败：${error.message || error}`);
        if (attempt === EXEC_RETRIES) throw serviceError;
        const waitSeconds = 2 ** (attempt - 1);
        notify(`平台暂时不可用，${waitSeconds} 秒后重试（${attempt}/${EXEC_RETRIES}）；本局不会记分。`, true);
        await sleep(waitSeconds * 1000);
      }
    }
  }

  async function playGame(blackUid, whiteUid, onMove) {
    const board = emptyBoard();
    let next = BLACK;
    let moves = 0;
    let winner = EMPTY;
    let reason = 'draw';
    while ((winner = exactFive(board)) === EMPTY) {
      if (moves === 225) return { black: blackUid, white: whiteUid, winner: 'draw', moves, reason: 'draw' };
      const uid = next === BLACK ? blackUid : whiteUid;
      try {
        const [row, col] = await moveFor(uid, board, next);
        if (row < 0 || row >= SIZE || col < 0 || col >= SIZE) throw new Error('Move outside board');
        if (board[row][col] !== EMPTY) throw new Error('Tried to put on another chess piece');
        if (next === BLACK && longBan(board, row, col)) throw new Error('LongBan');
        if (next === BLACK && fourFourBan(board, row, col)) throw new Error('FourFourBan');
        board[row][col] = next;
        moves += 1;
        if (onMove && (moves % 10 === 0 || moves === 1)) onMove(moves, blackUid, whiteUid);
      } catch (error) {
        // 接口/网络故障不能误判为学生输棋；上层会保留已完成局并停止批量任务。
        if (error instanceof ServiceError) throw error;
        winner = next ^ 1;
        reason = `Player #${next} FATAL ERROR: ${error.message || error}`;
        return { black: blackUid, white: whiteUid, winner: winner === BLACK ? 'black' : 'white', moves, reason };
      }
      next ^= 1;
    }
    return { black: blackUid, white: whiteUid, winner: winner === BLACK ? 'black' : 'white', moves, reason: 'five' };
  }

  function scoreWinner(game) {
    return game.winner === 'black' ? game.black : game.white; // 规则：平局计白胜
  }

  async function runFixture(state, fixture) {
    fixture.status = 'running';
    saveState(state);
    const [first, second] = fixture.players;
    const games = [[first, second], [second, first]];
    for (let index = fixture.games.length; index < games.length; index += 1) {
      const [black, white] = games[index];
      notify(`${fixture.phase === 'group' ? `小组 ${fixture.group}` : fixture.round}：${black} 执黑 vs ${white} 执白，第 ${index + 1}/2 局`);
      const game = await playGame(black, white, moves => notify(`${fixture.phase === 'group' ? `小组 ${fixture.group}` : fixture.round}：${black} vs ${white}，第 ${index + 1}/2 局，已 ${moves} 手`));
      fixture.games.push({ ...game, at: new Date().toISOString() });
      state.log.push({ type: 'game', fixture: fixture.id, game });
      saveState(state);
      await sleep(100); // 只在两局之间让出事件循环，不并发压测平台。
    }
    fixture.status = 'done';
    saveState(state);
  }

  function groupStats(state, group) {
    const stats = Object.fromEntries(group.people.map(uid => [uid, { uid, wins: 0, whiteWins: 0, blackWinMoves: [] }]));
    for (const fixture of state.groupFixtures.filter(item => item.group === group.name && item.status === 'done')) {
      for (const game of fixture.games) {
        const winner = scoreWinner(game);
        stats[winner].wins += 1;
        if (winner === game.white) stats[winner].whiteWins += 1;
        if (winner === game.black) stats[winner].blackWinMoves.push(game.moves);
      }
    }
    return Object.values(stats).map(item => ({
      ...item,
      blackAverage: item.blackWinMoves.length ? item.blackWinMoves.reduce((a, b) => a + b, 0) / item.blackWinMoves.length : null,
      tie: state.personByUid[item.uid].tie
    }));
  }

  function rankStats(rows) {
    return [...rows].sort((a, b) =>
      b.wins - a.wins || b.whiteWins - a.whiteWins ||
      (a.blackAverage ?? Infinity) - (b.blackAverage ?? Infinity) || a.tie - b.tie
    );
  }

  function allGroupsDone(state) {
    return state.groupFixtures.every(fixture => fixture.status === 'done');
  }

  function makePairings(entries, rng) {
    const shuffledEntries = shuffled(entries, rng);
    const pairs = [];
    function search(remaining) {
      if (!remaining.length) return true;
      const first = remaining[0];
      const candidates = shuffled(remaining.slice(1), rng);
      for (const second of candidates) {
        if (first.group === second.group) continue;
        const rest = remaining.filter(entry => entry !== first && entry !== second);
        pairs.push([first, second]);
        if (search(rest)) return true;
        pairs.pop();
      }
      return false;
    }
    if (!search(shuffledEntries)) throw new Error('无法满足八强首轮同组回避；请检查晋级名单。');
    return pairs;
  }

  function prepareKnockout(state) {
    if (!allGroupsDone(state)) throw new Error('小组赛尚未全部完成。');
    if (state.knockout) return;
    const rankedGroups = state.groups.map(group => ({ group, ranked: rankStats(groupStats(state, group)) }));
    const entrants = rankedGroups.map(({ group, ranked }) => ({ uid: ranked[0].uid, group: group.name }));
    const seconds = rankStats(rankedGroups.map(({ group, ranked }) => ({ ...ranked[1], group: group.name }))).slice(0, 3);
    entrants.push(...seconds.map(row => ({ uid: row.uid, group: row.group })));
    const rng = createRng(`${state.seed}:knockout`);
    const pairs = makePairings(entrants, rng);
    state.knockout = {
      entrants, rounds: [[...pairs].map((pair, index) => ({
        id: nowId('qf'), phase: 'knockout', round: `八强第 ${index + 1} 场`, players: pair.map(item => item.uid),
        groups: pair.map(item => item.group), status: 'pending', games: [], winner: null
      }))], champion: null
    };
    saveState(state);
  }

  function knockoutWinner(state, fixture) {
    const [one, two] = fixture.games;
    const oneWinner = scoreWinner(one);
    const twoWinner = scoreWinner(two);
    if (oneWinner === twoWinner) return oneWinner;
    const rng = createRng(`${state.seed}:${fixture.id}`);
    const bothBlack = oneWinner === one.black && twoWinner === two.black;
    if (bothBlack) {
      if (one.moves !== two.moves) return one.moves < two.moves ? oneWinner : twoWinner;
      return rng() < 0.5 ? oneWinner : twoWinner;
    }
    // 只能是双方各以白方得分；白棋实际取胜优先于平局计白胜。
    const oneActual = one.winner === 'white';
    const twoActual = two.winner === 'white';
    if (oneActual !== twoActual) return oneActual ? oneWinner : twoWinner;
    if (oneActual && one.moves !== two.moves) return one.moves < two.moves ? oneWinner : twoWinner;
    return rng() < 0.5 ? oneWinner : twoWinner;
  }

  function advanceRound(state) {
    const rounds = state.knockout.rounds;
    const current = rounds.at(-1);
    if (!current.every(fixture => fixture.status === 'done')) return;
    const winners = current.map(fixture => fixture.winner);
    if (winners.length === 1) {
      state.knockout.champion = winners[0];
      return;
    }
    const label = winners.length === 4 ? '半决赛' : '决赛';
    rounds.push(Array.from({ length: winners.length / 2 }, (_, index) => ({
      id: nowId(`ko-${winners.length / 2}`), phase: 'knockout', round: `${label}第 ${index + 1} 场`,
      players: [winners[index * 2], winners[index * 2 + 1]], groups: [], status: 'pending', games: [], winner: null
    })));
  }

  async function runNext(state) {
    const groupFixture = state.groupFixtures.find(fixture => fixture.status !== 'done');
    if (groupFixture) {
      await runFixture(state, groupFixture);
      return;
    }
    prepareKnockout(state);
    const current = state.knockout.rounds.at(-1);
    const fixture = current.find(item => item.status !== 'done');
    if (!fixture) return;
    await runFixture(state, fixture);
    fixture.winner = knockoutWinner(state, fixture);
    state.log.push({ type: 'advance', fixture: fixture.id, winner: fixture.winner });
    advanceRound(state);
    saveState(state);
  }

  async function withRunner(state, action) {
    if (runnerActive) throw new Error('已有赛事任务在执行，请勿重复点击。');
    runnerActive = true;
    try {
      await action();
    } finally {
      runnerActive = false;
      render(state);
    }
  }

  function nextLabel(state) {
    const group = state.groupFixtures.find(fixture => fixture.status !== 'done');
    if (group) return `下一场：小组 ${group.group}，${group.players[0]} vs ${group.players[1]}`;
    if (!state.knockout) return '小组赛已结束，可生成八强签表。';
    if (state.knockout.champion) return `冠军：${state.knockout.champion}`;
    const fixture = state.knockout.rounds.at(-1).find(item => item.status !== 'done');
    return fixture ? `下一场：${fixture.round}，${fixture.players[0]} vs ${fixture.players[1]}` : '正在生成下一轮。';
  }

  function download(name, type, text) {
    const blob = new Blob([text], { type });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = name;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  function csv(state) {
    const rows = [['阶段', '分组或轮次', '黑方', '白方', '实际结果', '规则计分胜者', '总手数', '结束原因']];
    for (const fixture of [...state.groupFixtures, ...(state.knockout?.rounds.flat() || [])]) {
      for (const game of fixture.games) rows.push([
        fixture.phase, fixture.group || fixture.round, game.black, game.white, game.winner,
        scoreWinner(game), game.moves, game.reason
      ]);
    }
    return rows.map(row => row.map(value => `"${String(value).replaceAll('"', '""')}"`).join(',')).join('\n');
  }

  function render(state) {
    const panel = byId('bgta-panel');
    if (!panel) return;
    if (!state) {
      panel.innerHTML = `
        <h2>BetaGomoku 赛事助手</h2>
        <p>粘贴 20 个学号（空格、逗号或换行均可）。脚本会先检查每人是否已有可执行提交。</p>
        <textarea id="bgta-roster" placeholder="2025200001\n2025200002\n..."></textarea>
        <label>抽签种子 <input id="bgta-seed" value="${new Date().toISOString().slice(0, 10)}"></label>
        <button id="bgta-create">随机分组并生成赛程</button>
        <p id="bgta-status"></p>`;
      byId('bgta-create').onclick = () => {
        try {
          const roster = parseRoster(byId('bgta-roster').value);
          const next = initialState(roster, byId('bgta-seed').value.trim() || Date.now());
          saveState(next);
          render(next);
        } catch (error) { notify(error.message, true); }
      };
      return;
    }
    const groupHtml = state.groups.map(group => {
      const ranks = rankStats(groupStats(state, group));
      return `<section><h3>组 ${group.name}</h3><ol>${ranks.map(row => `<li>${esc(row.uid)} — 总胜 ${row.wins}，白胜 ${row.whiteWins}，黑胜平均手数 ${row.blackAverage === null ? '—' : row.blackAverage.toFixed(1)}</li>`).join('')}</ol></section>`;
    }).join('');
    const done = state.groupFixtures.filter(item => item.status === 'done').length;
    const knockout = state.knockout ? `<p>八强：${state.knockout.entrants.map(item => item.uid).join('、')}<br>${state.knockout.champion ? `冠军：<b>${state.knockout.champion}</b>` : ''}</p>` : '';
    panel.innerHTML = `
      <h2>BetaGomoku 赛事助手</h2>
      <p><b>${esc(nextLabel(state))}</b></p>
      <p>小组赛双局对阵：${done}/30；已完成单局：${state.groupFixtures.reduce((sum, item) => sum + item.games.length, 0)}/60。</p>
      <div class="bgta-actions">
        <button id="bgta-next">执行下一场双局</button>
        <button id="bgta-all-group">连续执行剩余小组赛</button>
        <button id="bgta-all">连续执行整届赛事</button>
        <button id="bgta-pause">本场结束后暂停</button>
        <button id="bgta-bracket">生成八强签表</button>
        <button id="bgta-json">导出 JSON</button>
        <button id="bgta-csv">导出 CSV</button>
        <button id="bgta-reset">清除本机赛事</button>
      </div>
      <p id="bgta-status"></p>${knockout}<div class="bgta-groups">${groupHtml}</div>`;
    byId('bgta-next').onclick = async () => {
      try {
        await withRunner(state, async () => { await runNext(state); notify('本场已保存。'); });
      } catch (error) { saveState(state); render(state); notify(error.message || String(error), true); }
    };
    byId('bgta-all-group').onclick = async () => {
      try {
        stopAfterFixture = false;
        await withRunner(state, async () => {
          while (state.groupFixtures.some(fixture => fixture.status !== 'done') && !stopAfterFixture) await runNext(state);
          notify(stopAfterFixture ? '已在本场结束后暂停。' : '小组赛全部完成。');
        });
      } catch (error) { saveState(state); render(state); notify(`已停止，当前未完成局不会记分：${error.message || error}`, true); }
    };
    byId('bgta-all').onclick = async () => {
      try {
        stopAfterFixture = false;
        await withRunner(state, async () => {
          while (!state.knockout?.champion && !stopAfterFixture) await runNext(state);
          notify(stopAfterFixture ? '已在本场结束后暂停。' : `赛事完成，冠军：${state.knockout.champion}`);
        });
      } catch (error) { saveState(state); render(state); notify(`已停止，当前未完成局不会记分：${error.message || error}`, true); }
    };
    byId('bgta-pause').onclick = () => {
      if (!runnerActive) { notify('当前没有连续执行任务。'); return; }
      stopAfterFixture = true;
      notify('将在当前双局对阵结束后暂停。');
    };
    byId('bgta-bracket').onclick = () => {
      try { prepareKnockout(state); render(state); notify('八强签表已生成。'); }
      catch (error) { notify(error.message, true); }
    };
    byId('bgta-json').onclick = () => download('gomoku-tournament.json', 'application/json', JSON.stringify(state, null, 2));
    byId('bgta-csv').onclick = () => download('gomoku-games.csv', 'text/csv;charset=utf-8', `\uFEFF${csv(state)}`);
    byId('bgta-reset').onclick = () => {
      if (confirm('仅清除本机浏览器保存的赛程和赛果，确定吗？')) { clearState(); render(null); }
    };
  }

  function mount() {
    if (byId('bgta-panel')) return;
    const style = document.createElement('style');
    style.textContent = `
      #bgta-launch { position: fixed; z-index: 10000; right: 20px; bottom: 20px; background:#175cd3; color:white; border:0; border-radius:999px; padding:12px 16px; cursor:pointer; box-shadow:0 3px 12px #0004; }
      #bgta-panel { position:fixed; z-index:10001; right:20px; bottom:70px; width:min(520px,calc(100vw - 40px)); max-height:80vh; overflow:auto; box-sizing:border-box; padding:18px; border:1px solid #d0d5dd; border-radius:12px; background:#fff; box-shadow:0 8px 30px #0003; font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
      #bgta-panel h2 { margin:0 0 10px; } #bgta-panel h3 { margin:12px 0 4px; } #bgta-panel textarea { width:100%; height:180px; box-sizing:border-box; margin:8px 0; } #bgta-panel button { margin:4px 6px 4px 0; padding:7px 10px; border:1px solid #98a2b3; border-radius:6px; background:#fff; cursor:pointer; } #bgta-panel #bgta-next, #bgta-panel #bgta-all-group { background:#175cd3; color:#fff; border-color:#175cd3; } #bgta-status { min-height:20px; } #bgta-panel ol { margin:3px 0; padding-left:22px; }`;
    document.head.append(style);
    const launch = document.createElement('button');
    launch.id = 'bgta-launch';
    launch.textContent = '赛事助手';
    launch.onclick = () => {
      const panel = byId('bgta-panel');
      if (panel) panel.remove(); else { const next = document.createElement('aside'); next.id = 'bgta-panel'; document.body.append(next); render(loadState()); }
    };
    document.body.append(launch);
  }

  mount();
  window.addEventListener('beforeunload', event => {
    if (!runnerActive) return;
    event.preventDefault();
    event.returnValue = '赛事助手正在执行；关闭页面会使当前未完成局作废。';
  });
})();
