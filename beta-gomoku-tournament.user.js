// ==UserScript==
// @name         BetaGomoku 赛事助手（真实 Start）
// @namespace    ruc-gomoku-ta
// @version      2.0.0
// @description  驱动网页真实 Start，保存本地完整赛果、计分板和棋谱。
// @match        http://gomoku.ruc.rvalue.moe/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * 裁判边界：本脚本只操作 player0、player1、fastmode、start_button。
 * 网页自身 game() 是唯一裁判：它执行选手、判禁手、画棋盘和写终局消息。
 * 脚本只观察网页实际 draw_chess、api/exec 响应和终局消息，绝不重算胜负。
 */
(() => {
  'use strict';

  const KEY = 'ruc-betagomoku-real-start-v2';
  const $id = id => document.getElementById(id);
  const esc = value => String(value == null ? '' : value).replace(/[&<>'"]/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
  })[c]);
  let active = false;
  let capture = null;
  let fetchHooked = false;
  let drawHooked = false;
  let autoNextTimer = null;

  function save(state) { localStorage.setItem(KEY, JSON.stringify(state)); }
  function load() {
    try {
      const state = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (state) {
        state.settings = Object.assign({ autoDownload: true, autoNext: false }, state.settings);
        state.archives = Object.assign({ group: false, final: false }, state.archives);
      }
      return state;
    }
    catch (error) { console.error(error); return null; }
  }
  function tell(message, error) {
    const node = $id('bgta-status');
    if (!node) return;
    node.textContent = message;
    node.style.color = error ? '#b42318' : '#175cd3';
  }
  function id(prefix) { return prefix + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8); }
  function rng(seed) {
    let state = 2166136261;
    for (const c of String(seed)) { state ^= c.charCodeAt(0); state = Math.imul(state, 16777619); }
    return () => {
      state += 0x6D2B79F5;
      let value = state;
      value = Math.imul(value ^ (value >>> 15), value | 1);
      value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
      return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(items, random) {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(random() * (i + 1));
      [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
  }
  function parseRoster(text) {
    const roster = text.split(/[\s,;，；]+/).filter(Boolean);
    if (roster.length !== 20) throw new Error('需要恰好 20 个学号，当前为 ' + roster.length + ' 个。');
    if (roster.some(uid => !/^\d{6,}$/.test(uid))) throw new Error('名单中存在不是学号的内容。');
    if (new Set(roster).size !== 20) throw new Error('名单中存在重复学号。');
    const available = new Set([...document.querySelectorAll('#player0 option')].map(item => item.value).filter(Boolean));
    const missing = roster.filter(uid => !available.has(uid));
    if (missing.length) throw new Error('网页当前没有以下学号的提交：' + missing.join('、'));
    return roster;
  }
  function createState(roster, seed) {
    const random = rng(seed);
    const people = shuffle(roster, random);
    const ties = Object.fromEntries(people.map(uid => [uid, random()]));
    const groups = ['A', 'B', 'C', 'D', 'E'].map((name, n) => ({ name, people: people.slice(n * 4, n * 4 + 4) }));
    const groupFixtures = [];
    groups.forEach(group => {
      for (let left = 0; left < 4; left += 1) for (let right = left + 1; right < 4; right += 1) {
        groupFixtures.push({
          id: id('group-' + group.name), phase: 'group', group: group.name, round: '小组 ' + group.name,
          players: [group.people[left], group.people[right]], games: [], status: 'pending'
        });
      }
    });
    return {
      format: 'beta-gomoku-page-record-2.0', createdAt: new Date().toISOString(), seed, roster: people,
      ties, groups, groupFixtures, knockout: null, events: [], waiting: null,
      archives: { group: false, final: false }, settings: { autoDownload: true, autoNext: false }
    };
  }

  function scored(game) { return game.winner === 'black' ? game.black : game.white; }
  function groupRows(state, group) {
    const rows = Object.fromEntries(group.people.map(uid => [uid, { uid, wins: 0, whiteWins: 0, blackMoves: [], tie: state.ties[uid] }]));
    state.groupFixtures.filter(item => item.group === group.name && item.status === 'done').forEach(fixture => {
      fixture.games.forEach(game => {
        const winner = scored(game);
        rows[winner].wins += 1;
        if (winner === game.white) rows[winner].whiteWins += 1;
        if (winner === game.black) rows[winner].blackMoves.push(game.moves);
      });
    });
    return Object.values(rows).map(row => Object.assign(row, {
      blackAverage: row.blackMoves.length ? row.blackMoves.reduce((a, b) => a + b, 0) / row.blackMoves.length : null
    }));
  }
  function rank(rows) {
    return rows.slice().sort((a, b) => b.wins - a.wins || b.whiteWins - a.whiteWins ||
      (a.blackAverage == null ? Infinity : a.blackAverage) - (b.blackAverage == null ? Infinity : b.blackAverage) || a.tie - b.tie);
  }
  function groupsDone(state) { return state.groupFixtures.every(item => item.status === 'done'); }
  function qualification(state) {
    const rankedGroups = state.groups.map(group => ({ group, rows: rank(groupRows(state, group)) }));
    const entrants = rankedGroups.map(item => {
      const row = item.rows[0];
      return {
        uid: row.uid, group: item.group.name, rank: 1,
        reason: '小组 ' + item.group.name + ' 第一（总胜 ' + row.wins + '，白胜 ' + row.whiteWins + '，黑胜均手 ' + (row.blackAverage == null ? '—' : row.blackAverage.toFixed(2)) + '）'
      };
    });
    const secondRows = rankedGroups.map(item => Object.assign({}, item.rows[1], { group: item.group.name }));
    const rankedSeconds = rank(secondRows);
    rankedSeconds.slice(0, 3).forEach((row, index) => entrants.push({
      uid: row.uid, group: row.group, rank: 2,
      reason: '小组 ' + row.group + ' 第二；五个小组第二横向比较第 ' + (index + 1) + ' 名（总胜 ' + row.wins + '，白胜 ' + row.whiteWins + '，黑胜均手 ' + (row.blackAverage == null ? '—' : row.blackAverage.toFixed(2)) + '）'
    }));
    return { entrants, rankedGroups, rankedSeconds };
  }
  function pairGroups(entries, random) {
    const pairs = [];
    function search(rest) {
      if (!rest.length) return true;
      const first = rest[0];
      for (const second of shuffle(rest.slice(1), random)) {
        if (first.group === second.group) continue;
        pairs.push([first, second]);
        if (search(rest.filter(item => item !== first && item !== second))) return true;
        pairs.pop();
      }
      return false;
    }
    if (!search(shuffle(entries, random))) throw new Error('无法构造同组回避的八强签表。');
    return pairs;
  }
  function prepareKnockout(state) {
    if (state.knockout) return;
    if (!groupsDone(state)) throw new Error('小组赛尚未完成，不能进入淘汰赛。');
    const entrants = qualification(state).entrants;
    state.knockout = {
      entrants, champion: null,
      rounds: [pairGroups(entrants, rng(state.seed + ':knockout')).map((pair, n) => ({
        id: id('qf'), phase: 'knockout', round: '八强第 ' + (n + 1) + ' 场',
        players: pair.map(item => item.uid), groups: pair.map(item => item.group),
        games: [], status: 'pending', winner: null, winnerBasis: null
      }))]
    };
    state.events.push({ type: 'knockout_draw', at: new Date().toISOString(), entrants });
    save(state);
  }
  function knockoutDecision(state, fixture) {
    const [first, second] = fixture.games;
    const a = scored(first), b = scored(second);
    if (a === b) return [a, '两局计分胜者一致'];
    const random = rng(state.seed + ':' + fixture.id);
    if (a === first.black && b === second.black) {
      if (first.moves !== second.moves) return [first.moves < second.moves ? a : b, '黑棋获胜手数更少'];
      return [random() < 0.5 ? a : b, '黑棋获胜手数相同，稳定抽签'];
    }
    const firstActual = first.winner === 'white', secondActual = second.winner === 'white';
    if (firstActual !== secondActual) return [firstActual ? a : b, '白棋实际取胜优先于平局计白胜'];
    if (firstActual && first.moves !== second.moves) return [first.moves < second.moves ? a : b, '白棋获胜手数更少'];
    return [random() < 0.5 ? a : b, '规则指标相同，稳定抽签'];
  }
  function advance(state) {
    const current = state.knockout.rounds.at(-1);
    if (!current.every(item => item.status === 'done')) return;
    const winners = current.map(item => item.winner);
    if (winners.length === 1) { state.knockout.champion = winners[0]; return; }
    const label = winners.length === 4 ? '半决赛' : '决赛';
    state.knockout.rounds.push(Array.from({ length: winners.length / 2 }, (_, n) => ({
      id: id(winners.length === 4 ? 'sf' : 'final'), phase: 'knockout', round: label + '第 ' + (n + 1) + ' 场',
      players: [winners[n * 2], winners[n * 2 + 1]], groups: [], games: [], status: 'pending', winner: null, winnerBasis: null
    })));
  }
  function nextFixture(state) {
    const group = state.groupFixtures.find(item => item.status !== 'done');
    if (group) return group;
    if (!state.knockout) return null;
    if (state.knockout.champion) return null;
    const fixture = state.knockout.rounds.at(-1).find(item => item.status !== 'done');
    if (fixture) return fixture;
    advance(state);
    return nextFixture(state);
  }

  function installHooks() {
    if (!fetchHooked) {
      fetchHooked = true;
      const originalFetch = window.fetch.bind(window);
      window.fetch = async (...args) => {
        try {
          const response = await originalFetch(...args);
          if (capture && String(args[0]).includes('/api/exec')) {
            let payload = {}, responseBody = null;
            try { payload = JSON.parse((args[1] || {}).body || '{}'); } catch (_) {}
            try { responseBody = await response.clone().json(); } catch (_) {}
            capture.executions.push({
              at: new Date().toISOString(), uid: payload.uid || null, input: payload.input || null,
              color: Number(String(payload.input || '').split('\n')[0]), response: responseBody
            });
          }
          return response;
        } catch (error) {
          if (capture && String(args[0]).includes('/api/exec')) capture.executions.push({ at: new Date().toISOString(), transportError: String(error) });
          throw error;
        }
      };
    }
    if (!drawHooked && typeof window.draw_chess === 'function') {
      const originalDraw = window.draw_chess;
      const wrappedDraw = function () {
        const [row, col, color] = arguments;
        if (capture) capture.history.push({
          ply: capture.history.length + 1, row, col, color: color === 0 ? 'black' : 'white',
          uid: color === 0 ? capture.black : capture.white
        });
        return originalDraw.apply(this, arguments);
      };
      wrappedDraw.__bgtaWrapped = true;
      window.draw_chess = wrappedDraw;
      drawHooked = true;
    }
  }
  function setPlayer(selector, uid) {
    const select = $id(selector);
    if (!select) throw new Error('网页缺少 #' + selector + '。');
    select.value = uid;
    select.dispatchEvent(new Event('change', { bubbles: true }));
    if (window.$) window.$(select).change();
  }
  function setFastMode() {
    if (window.$) window.$('#fastmode').checkbox('set checked');
    else $id('fastmode')?.querySelector('input')?.click();
  }
  function outcome(messages) {
    // 网页在非法落子时可能同时追加红色 FATAL 消息和绿色 Game Over 消息。
    // 红色消息才是终局原因，必须优先记录，不能被绿色“某方获胜”概述覆盖。
    const message = messages.find(node => node.classList.contains('negative')) || messages.find(node => node.classList.contains('success'));
    if (!message) throw new Error('网页没有可解析的终局消息。');
    const text = message.innerText.replace(/\s+/g, ' ').trim();
    const pageMessages = messages.map(node => node.innerText.replace(/\s+/g, ' ').trim());
    if (message.classList.contains('success')) {
      if (/Draw\./i.test(text)) return { winner: 'draw', reason: '网页 Game Over：Draw.', pageMessage: text, pageMessages };
      const match = text.match(/Player #([01]) \(([^)]+)\) won\./i);
      if (!match) throw new Error('无法解析网页终局消息：' + text);
      return { winner: match[1] === '0' ? 'black' : 'white', reason: '网页 Game Over：' + match[0], pageMessage: text, pageMessages };
    }
    const fault = text.match(/Player #([01]) FATAL ERROR:?\s*(.*)/i);
    if (!fault) throw new Error('无法解析网页错误消息：' + text);
    return { winner: fault[1] === '0' ? 'white' : 'black', reason: '网页 ' + text, pageMessage: text, pageMessages };
  }
  function waitForEnd(previousMessages) {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + 16 * 60 * 1000;
      let firstTerminalAt = null;
      const timer = setInterval(() => {
        const messages = [...document.querySelectorAll('.ui.message')].filter(node =>
          !previousMessages.has(node) && (node.classList.contains('success') || node.classList.contains('negative')));
        if (messages.length && firstTerminalAt == null) firstTerminalAt = Date.now();
        if (messages.length && Date.now() - firstTerminalAt >= 300 && !$id('start_button').classList.contains('disabled')) {
          clearInterval(timer);
          try { resolve(outcome(messages)); } catch (error) { reject(error); }
        } else if (Date.now() > deadline) {
          clearInterval(timer);
          reject(new Error('网页 16 分钟内没有返回终局结果；本局未记分。'));
        }
      }, 100);
    });
  }
  async function realGame(black, white) {
    installHooks();
    if (!$id('start_button')) throw new Error('请先进入 BetaGomoku 主页面。');
    if (!drawHooked) throw new Error('未能挂接网页的落子函数；为保证棋谱完整，本局没有启动。请刷新页面后重试。');
    setPlayer('player0', black);
    setPlayer('player1', white);
    setFastMode();
    const previousMessages = new Set(document.querySelectorAll('.ui.message'));
    capture = { black, white, history: [], executions: [] };
    try {
      $id('start_button').click();
      const result = await waitForEnd(previousMessages);
      return {
        black, white, winner: result.winner, moves: capture.history.length, history: capture.history,
        executions: capture.executions, reason: result.reason, pageMessage: result.pageMessage, pageMessages: result.pageMessages, finishedAt: new Date().toISOString()
      };
    } finally {
      capture = null;
    }
  }

  function fixtures(state) { return state.groupFixtures.concat(state.knockout ? state.knockout.rounds.flat() : []); }
  function download(name, mime, text) {
    const blob = new Blob([text], { type: mime });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }
  function record(state, fixture, game, number) {
    return {
      format: 'beta-gomoku-page-record-1.0', tournament: { createdAt: state.createdAt, seed: state.seed },
      fixture: { id: fixture.id, phase: fixture.phase, groupOrRound: fixture.group || fixture.round, players: fixture.players, game: number },
      game
    };
  }
  function toCsv(state) {
    const rows = [['fixture', 'phase', 'group_or_round', 'game', 'black', 'white', 'raw_result', 'scored_winner', 'moves', 'reason', 'finished_at']];
    fixtures(state).forEach(fixture => fixture.games.forEach((game, n) => rows.push([
      fixture.id, fixture.phase, fixture.group || fixture.round, n + 1, game.black, game.white, game.winner,
      scored(game), game.moves, game.reason, game.finishedAt
    ])));
    return rows.map(row => row.map(value => '"' + String(value == null ? '' : value).replaceAll('"', '""') + '"').join(',')).join('\n');
  }
  function downloadArchive(state, stage) {
    const suffix = stage === 'group' ? 'group-stage-complete' : 'tournament-complete';
    download('betagomoku-' + suffix + '.json', 'application/json;charset=utf-8', JSON.stringify(state, null, 2));
    download('betagomoku-' + suffix + '.csv', 'text/csv;charset=utf-8', '\uFEFF' + toCsv(state));
  }
  function archiveOnce(state, stage) {
    if (state.archives[stage]) return;
    state.archives[stage] = true;
    state.events.push({ type: stage + '_archive_created', at: new Date().toISOString() });
    save(state);
    downloadArchive(state, stage);
  }
  function finishGroupStage(state) {
    if (state.groupFinishedAt || !groupsDone(state)) return;
    state.groupFinishedAt = new Date().toISOString();
    state.events.push({ type: 'group_stage_finished', at: state.groupFinishedAt, entrants: qualification(state).entrants });
    save(state);
    archiveOnce(state, 'group');
  }
  function finishTournament(state) {
    if (!state.knockout?.champion || state.finishedAt) return;
    state.finishedAt = new Date().toISOString();
    state.events.push({ type: 'tournament_finished', at: state.finishedAt, champion: state.knockout.champion });
    save(state);
    archiveOnce(state, 'final');
  }
  function scheduleAutoNext(state) {
    clearTimeout(autoNextTimer);
    tell('本局记录已保存；自动模式将在 3 秒后开始下一局。');
    autoNextTimer = setTimeout(() => {
      autoNextTimer = null;
      const latest = load();
      if (!latest || latest.createdAt !== state.createdAt || !latest.settings.autoNext || active) return;
      runOne(latest);
    }, 3000);
  }
  async function runOne(state) {
    if (active) return;
    const fixture = nextFixture(state);
    if (!fixture) {
      render(state);
      tell(!state.knockout ? '小组赛已完成；请核对晋级名单后点击“进入淘汰赛”。' : '赛事已结束，冠军：' + state.knockout.champion);
      return;
    }
    const number = fixture.games.length + 1;
    const [first, second] = fixture.players;
    const [black, white] = number === 1 ? [first, second] : [second, first];
    fixture.status = 'running';
    state.waiting = null;
    state.events.push({ type: 'game_started', at: new Date().toISOString(), fixture: fixture.id, game: number, black, white });
    save(state);
    active = true;
    render(state);
    tell(fixture.round + ' 第 ' + number + '/2 局：' + black + ' 黑 vs ' + white + ' 白；正在运行网页 Start。');
    let autoNext = false;
    try {
      const game = await realGame(black, white);
      fixture.games.push(game);
      if (fixture.games.length === 2) {
        fixture.status = 'done';
        if (fixture.phase === 'knockout') {
          [fixture.winner, fixture.winnerBasis] = knockoutDecision(state, fixture);
          advance(state);
        }
      }
      const groupComplete = fixture.phase === 'group' && groupsDone(state);
      const tournamentComplete = Boolean(state.knockout?.champion);
      autoNext = Boolean(state.settings.autoNext) && !groupComplete && !tournamentComplete;
      const nextMessage = groupComplete ? '小组赛已全部完成，已自动导出总记录；请核对晋级名单后点击“进入淘汰赛”。' : (tournamentComplete ? '赛事已全部完成，已自动导出总记录；最终榜单见下方。' : (autoNext ? '自动模式将在 3 秒后继续。' : '点击“开始下一局”继续。'));
      state.waiting = { fixture: fixture.id, game: number, at: game.finishedAt, message: fixture.round + ' 第 ' + number + ' 局已结束；' + nextMessage };
      state.events.push({ type: 'game_finished', at: game.finishedAt, fixture: fixture.id, game: number, result: game });
      save(state);
      if (state.settings.autoDownload) download('betagomoku-' + fixture.id + '-game-' + number + '.json', 'application/json;charset=utf-8', JSON.stringify(record(state, fixture, game, number), null, 2));
      if (groupComplete) finishGroupStage(state);
      if (tournamentComplete) finishTournament(state);
      render(state);
      tell(state.waiting.message);
    } catch (error) {
      state.events.push({ type: 'game_aborted', at: new Date().toISOString(), fixture: fixture.id, game: number, error: String(error) });
      save(state);
      render(state);
      tell('本局未记分：' + (error.message || error), true);
    } finally {
      active = false;
      render(state);
      if (autoNext) scheduleAutoNext(state);
    }
  }

  function groupHtml(state, group) {
    const rows = rank(groupRows(state, group));
    const order = Object.fromEntries(rows.slice().sort((a, b) => a.tie - b.tie).map((row, n) => [row.uid, n + 1]));
    let html = '<section class="bgta-group"><h3>小组 ' + group.name + '</h3><table><thead><tr><th>排</th><th>学号</th><th>总胜</th><th>白胜</th><th>黑胜均手</th><th>抽签序</th></tr></thead><tbody>';
    rows.forEach((row, n) => {
      html += '<tr class="' + (n === 0 ? 'leader' : '') + '"><td>' + (n + 1) + '</td><td>' + esc(row.uid) + '</td><td>' + row.wins + '</td><td>' + row.whiteWins + '</td><td>' + (row.blackAverage == null ? '—' : row.blackAverage.toFixed(2)) + '</td><td>' + order[row.uid] + '</td></tr>';
    });
    return html + '</tbody></table><small>排序：总胜 → 白胜 → 黑棋获胜平均手数（少优先）→ 抽签序</small></section>';
  }
  function knockoutHtml(state) {
    if (!state.knockout) return '';
    let html = '<section class="bgta-knockout"><h3>淘汰赛</h3>';
    state.knockout.rounds.flat().forEach(fixture => {
      html += '<div class="bgta-fixture"><b>' + esc(fixture.round) + '：</b>' + esc(fixture.players[0]) + ' vs ' + esc(fixture.players[1]) + (fixture.winner ? '<strong>晋级 ' + esc(fixture.winner) + '</strong>' : '待赛');
      fixture.games.forEach((game, n) => { html += '<small>第 ' + (n + 1) + ' 局：' + esc(game.black) + ' 黑 vs ' + esc(game.white) + ' 白；' + esc(game.winner) + '，计分 ' + esc(scored(game)) + '，' + game.moves + ' 手</small>'; });
      if (fixture.winnerBasis) html += '<small>晋级依据：' + esc(fixture.winnerBasis) + '</small>';
      html += '</div>';
    });
    return html + (state.knockout.champion ? '<p>冠军：<b>' + esc(state.knockout.champion) + '</b></p>' : '') + '</section>';
  }
  function qualificationHtml(state) {
    if (!groupsDone(state)) return '';
    const entrants = state.knockout ? state.knockout.entrants : qualification(state).entrants;
    let html = '<section class="bgta-qualification"><h3>八强晋级名单</h3><p>小组赛已封存；请核对后再进入淘汰赛。</p><ol>';
    entrants.forEach(entry => { html += '<li><b>' + esc(entry.uid) + '</b>（小组 ' + esc(entry.group) + '）<small>' + esc(entry.reason || '八强参赛者') + '</small></li>'; });
    return html + '</ol></section>';
  }
  function leaderboardHtml(state) {
    if (!state.knockout?.champion) return '';
    const rounds = state.knockout.rounds;
    const final = rounds.at(-1)[0];
    const runnerUp = final.players.find(uid => uid !== state.knockout.champion);
    const semiFinals = rounds.find(round => round.length === 2) || [];
    const quarterFinals = rounds[0] || [];
    const semifinalists = semiFinals.map(item => item.players.find(uid => uid !== item.winner));
    const quarterfinalists = quarterFinals.map(item => item.players.find(uid => uid !== item.winner));
    let html = '<section class="bgta-leaderboard"><h3>最终榜单</h3><ol><li><b>冠军：' + esc(state.knockout.champion) + '</b></li><li><b>亚军：' + esc(runnerUp) + '</b></li>';
    semifinalists.forEach(uid => { html += '<li>并列四强：' + esc(uid) + '</li>'; });
    quarterfinalists.forEach(uid => { html += '<li>八强：' + esc(uid) + '</li>'; });
    return html + '</ol><small>没有三、四名决赛时，半决赛负者并列四强；四分之一决赛负者列为八强。</small></section>';
  }
  function latestResultHtml(state) {
    const event = state.events.slice().reverse().find(item => item.type === 'game_finished');
    if (!event) return '<section class="bgta-result"><h3>最近终局</h3><p>尚无已完成对局。</p></section>';
    const game = event.result;
    const fixture = fixtures(state).find(item => item.id === event.fixture);
    const number = event.game || (fixture ? fixture.games.indexOf(game) + 1 : '?');
    const rawWinner = game.winner === 'draw' ? '和棋（赛制计白方胜）' : (game.winner === 'black' ? '黑方 ' + game.black + ' 胜' : '白方 ' + game.white + ' 胜');
    const messages = game.pageMessages || (game.pageMessage ? [game.pageMessage] : []);
    const fatal = messages.find(message => /FATAL ERROR/i.test(message)) || (/FATAL ERROR/i.test(game.reason || '') ? game.reason : null);
    let html = '<section class="bgta-result ' + (fatal ? 'bgta-fatal' : '') + '"><h3>最近终局</h3><p><b>' + esc(fixture ? fixture.round : '对局') + ' 第 ' + number + ' 局</b></p><p>黑方：' + esc(game.black) + '　白方：' + esc(game.white) + '</p><p class="bgta-winner">网页结果：' + esc(rawWinner) + '；计分胜者：' + esc(scored(game)) + '；' + game.moves + ' 手</p><p>终局原因：' + esc(game.reason || '网页未提供') + '</p>';
    if (fatal) html += '<p class="bgta-fatal-text">FATAL：' + esc(fatal) + '</p>';
    if (messages.length) html += '<details><summary>网页全部终局消息</summary><ul>' + messages.map(message => '<li>' + esc(message) + '</li>').join('') + '</ul></details>';
    return html + '</section>';
  }
  function render(state) {
    const panel = $id('bgta-panel');
    if (!panel) return;
    if (!state) {
      panel.innerHTML = '<h2>BetaGomoku 赛事助手</h2><p>本版本只驱动网页真实 Start；网页是单局裁判。</p><textarea id="bgta-roster" placeholder="粘贴 20 个学号，每行一个"></textarea><label>抽签种子 <input id="bgta-seed" value="' + new Date().toISOString().slice(0, 10) + '"></label><button id="bgta-create">随机分组</button><p id="bgta-status"></p>';
      $id('bgta-create').onclick = () => {
        try { const state = createState(parseRoster($id('bgta-roster').value), $id('bgta-seed').value.trim() || Date.now()); save(state); render(state); tell('分组已保存。点击“开始下一局”启动首局。'); }
        catch (error) { tell(error.message || String(error), true); }
      };
      return;
    }
    const groupGames = state.groupFixtures.reduce((sum, item) => sum + item.games.length, 0);
    const totalGames = fixtures(state).reduce((sum, item) => sum + item.games.length, 0);
    const waiting = state.waiting ? state.waiting.message : (active ? '网页正在执行当前局…' : '准备开始下一局。');
    const enterKnockout = groupsDone(state) && !state.knockout;
    const phaseButton = enterKnockout ? '<button id="bgta-enter-knockout" ' + (active ? 'disabled' : '') + '>进入淘汰赛</button>' : '<button id="bgta-next" ' + (active || state.knockout?.champion ? 'disabled' : '') + '>开始下一局</button>';
    panel.innerHTML = '<h2>BetaGomoku 赛事助手</h2><p class="bgta-waiting">' + esc(waiting) + '</p><p>小组赛 ' + groupGames + '/60 局；全赛事 ' + totalGames + '/74 局。</p><div class="bgta-actions">' + phaseButton + '<button id="bgta-auto-next" ' + (active || enterKnockout || state.knockout?.champion ? 'disabled' : '') + '>' + (state.settings.autoNext ? '自动开始：开（点击关闭）' : '自动开始：关（点击开启）') + '</button><button id="bgta-json">导出完整 JSON</button><button id="bgta-csv">导出 CSV</button><button id="bgta-reset">清除本机赛事</button></div><label class="bgta-check"><input id="bgta-auto" type="checkbox" ' + (state.settings.autoDownload ? 'checked' : '') + '> 每局结束自动下载完整 JSON 记录</label><p id="bgta-status"></p>' + latestResultHtml(state) + leaderboardHtml(state) + qualificationHtml(state) + knockoutHtml(state) + '<div class="bgta-groups">' + state.groups.map(group => groupHtml(state, group)).join('') + '</div>';
    if ($id('bgta-next')) $id('bgta-next').onclick = () => runOne(state);
    if ($id('bgta-enter-knockout')) $id('bgta-enter-knockout').onclick = () => { try { prepareKnockout(state); save(state); render(state); tell('八强签表已生成；点击“开始下一局”进入淘汰赛。'); } catch (error) { tell(error.message || String(error), true); } };
    $id('bgta-auto-next').onclick = () => { state.settings.autoNext = !state.settings.autoNext; save(state); render(state); tell(state.settings.autoNext ? '已开启自动开始：每局终局展示 3 秒后继续。' : '已关闭自动开始：下一局需手动点击。'); };
    $id('bgta-json').onclick = () => download('betagomoku-tournament.json', 'application/json;charset=utf-8', JSON.stringify(state, null, 2));
    $id('bgta-csv').onclick = () => download('betagomoku-games.csv', 'text/csv;charset=utf-8', '\uFEFF' + toCsv(state));
    $id('bgta-auto').onchange = event => { state.settings.autoDownload = event.target.checked; save(state); };
    $id('bgta-reset').onclick = () => { if (confirm('仅清除本浏览器保存的赛程、赛果和名单，确定吗？')) { localStorage.removeItem(KEY); render(null); } };
  }
  function mount() {
    if ($id('bgta-launch')) return;
    const style = document.createElement('style');
    style.textContent = '#bgta-launch{position:fixed;z-index:10000;right:20px;bottom:20px;border:0;border-radius:999px;padding:12px 16px;background:#175cd3;color:#fff;font-weight:700;box-shadow:0 3px 12px #0005;cursor:pointer}#bgta-panel{position:fixed;z-index:10001;right:20px;top:60px;width:min(660px,calc(100vw - 40px));max-height:calc(100vh - 90px);overflow:auto;padding:18px;border:1px solid #d0d5dd;border-radius:12px;background:#fff;color:#182230;box-shadow:0 8px 30px #0004;font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif}#bgta-panel h2{margin:0 0 8px}#bgta-panel h3{margin:12px 0 4px;color:#175cd3}#bgta-panel textarea{width:100%;height:160px;margin:8px 0;box-sizing:border-box}#bgta-panel button{margin:4px 6px 4px 0;padding:7px 10px;border:1px solid #98a2b3;border-radius:6px;background:#fff;cursor:pointer}#bgta-panel #bgta-next,#bgta-panel #bgta-enter-knockout{background:#175cd3;color:#fff;border-color:#175cd3}#bgta-panel button:disabled{opacity:.55;cursor:wait}.bgta-waiting{font-weight:700}.bgta-check{display:block;margin:8px 0}.bgta-result,.bgta-qualification,.bgta-leaderboard{margin:10px 0;padding:10px;border:1px solid #b2ddff;border-radius:8px;background:#eff8ff}.bgta-result h3,.bgta-qualification h3,.bgta-leaderboard h3{margin-top:0}.bgta-result p,.bgta-qualification p{margin:4px 0}.bgta-winner{font-weight:700;color:#175cd3}.bgta-fatal{border-color:#fecdca;background:#fef3f2}.bgta-fatal-text{font-weight:700;color:#b42318}.bgta-result details{margin-top:6px}.bgta-result ul,.bgta-qualification ol,.bgta-leaderboard ol{margin:4px 0;padding-left:20px}.bgta-qualification small{display:block;color:#475467}.bgta-leaderboard{border-color:#fedf89;background:#fffaeb}.bgta-groups{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}.bgta-group{border:1px solid #e4e7ec;border-radius:8px;padding:7px}.bgta-group h3{margin-top:0}#bgta-panel table{width:100%;border-collapse:collapse;font-size:12px}#bgta-panel th,#bgta-panel td{padding:2px;text-align:right;border-top:1px solid #eef1f4}#bgta-panel th:first-child,#bgta-panel td:first-child,#bgta-panel th:nth-child(2),#bgta-panel td:nth-child(2){text-align:left}.leader{font-weight:700;color:#175cd3}.bgta-group small,.bgta-fixture small{display:block;color:#667085;font-size:11px}.bgta-knockout{margin-top:10px}.bgta-fixture{padding:6px 0;border-top:1px solid #e4e7ec}.bgta-fixture strong{float:right;color:#8a5a00}';
    document.head.append(style);
    const button = document.createElement('button');
    button.id = 'bgta-launch';
    button.textContent = '赛事助手';
    button.onclick = () => {
      const panel = $id('bgta-panel');
      if (panel) panel.remove();
      else { const next = document.createElement('aside'); next.id = 'bgta-panel'; document.body.append(next); render(load()); }
    };
    document.body.append(button);
  }
  installHooks();
  mount();
  window.addEventListener('beforeunload', event => {
    if (!active) return;
    event.preventDefault();
    event.returnValue = '网页正在执行当前局；关闭后该未完成局不会记分。';
  });
})();
