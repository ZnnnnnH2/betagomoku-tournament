// ==UserScript==
// @name         BetaGomoku 赛事诊断记录器
// @namespace    ruc-gomoku-ta
// @version      1.0.0
// @description  只读记录 Start 来源、页面生命周期、终局消息和赛事状态变化，便于诊断重复对局。
// @match        http://gomoku.ruc.rvalue.moe/*
// @run-at       document-start
// @noframes
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  const VERSION = '1.0.0';
  const LOG_KEY = 'ruc-betagomoku-debug-log-v1';
  const TOURNAMENT_KEY = 'ruc-betagomoku-real-start-v2';
  const MAX_ENTRIES = 1600;
  const SESSION_ID = 'debug-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  let sequence = 0;
  let lastStateSignature = null;
  let stateTimer = null;
  const seenMessages = new WeakSet();

  function iso() { return new Date().toISOString(); }
  function json(value, fallback) {
    try { return JSON.parse(value); }
    catch (_) { return fallback; }
  }
  function readEntries() { return json(localStorage.getItem(LOG_KEY) || '[]', []); }
  function writeEntries(entries) {
    try { localStorage.setItem(LOG_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES))); }
    catch (error) { console.error('[BGTA Debug] 无法写入日志', error); }
  }
  function sanitize(value, depth = 0) {
    if (depth > 4) return '[depth-limit]';
    if (value == null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
    if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack || null };
    if (Array.isArray(value)) return value.slice(0, 40).map(item => sanitize(item, depth + 1));
    if (typeof value === 'object') {
      const out = {};
      Object.entries(value).slice(0, 60).forEach(([key, item]) => { out[key] = sanitize(item, depth + 1); });
      return out;
    }
    return String(value);
  }
  function log(type, data = {}) {
    const entries = readEntries();
    const entry = {
      at: iso(), performanceMs: Math.round(performance.now()), sessionId: SESSION_ID,
      sequence: ++sequence, type, data: sanitize(data)
    };
    entries.push(entry);
    writeEntries(entries);
    console.debug('[BGTA Debug]', type, entry.data);
    updateButton(entries);
    updatePanel(entries);
    return entry;
  }
  function stateSummary() {
    const state = json(localStorage.getItem(TOURNAMENT_KEY) || 'null', null);
    if (!state) return null;
    const allFixtures = (state.groupFixtures || []).concat(state.knockout ? (state.knockout.rounds || []).flat() : []);
    return {
      format: state.format || null,
      createdAt: state.createdAt || null,
      settings: state.settings || null,
      waiting: state.waiting || null,
      inFlight: state.inFlight || null,
      eventCount: (state.events || []).length,
      lastEvents: (state.events || []).slice(-20).map(event => ({
        type: event.type, at: event.at, attemptId: event.attemptId || null,
        fixture: event.fixture || null, game: event.game || null,
        black: event.black || null, white: event.white || null,
        error: event.error || null,
        result: event.result ? {
          black: event.result.black, white: event.result.white, winner: event.result.winner,
          moves: event.result.moves, reason: event.result.reason
        } : null
      })),
      fixtures: allFixtures.map(fixture => ({
        id: fixture.id, phase: fixture.phase, group: fixture.group || null, round: fixture.round || null,
        players: fixture.players, status: fixture.status, games: (fixture.games || []).length,
        winner: fixture.winner || null
      })),
      champion: state.knockout ? state.knockout.champion : null
    };
  }
  function sampleState(source) {
    const summary = stateSummary();
    const signature = JSON.stringify(summary && {
      createdAt: summary.createdAt, settings: summary.settings, waiting: summary.waiting,
      inFlight: summary.inFlight, eventCount: summary.eventCount,
      lastEvent: summary.lastEvents.at(-1) || null,
      fixtures: summary.fixtures.map(item => [item.id, item.status, item.games, item.winner])
    });
    if (signature !== lastStateSignature) {
      lastStateSignature = signature;
      log('tournament_state_changed', { source, summary });
    }
  }
  function playerSnapshot() {
    const black = document.getElementById('player0');
    const white = document.getElementById('player1');
    const start = document.getElementById('start_button');
    return {
      black: black ? black.value : null,
      white: white ? white.value : null,
      startClass: start ? start.className : null,
      startText: start ? start.innerText.replace(/\s+/g, ' ').trim() : null,
      assistantVersion: window.__bgtaTournamentAssistantVersion || null,
      url: location.href,
      visibility: document.visibilityState
    };
  }
  function clickStack() {
    try { throw new Error('Start click stack'); }
    catch (error) { return error.stack || null; }
  }
  function inspectMessage(node) {
    if (!(node instanceof Element) || seenMessages.has(node)) return;
    if (node.matches('.ui.message')) {
      seenMessages.add(node);
      log('page_message_added', {
        classes: node.className,
        text: node.innerText.replace(/\s+/g, ' ').trim(),
        players: playerSnapshot()
      });
    }
    node.querySelectorAll?.('.ui.message').forEach(inspectMessage);
  }
  function startDomObserver() {
    const root = document.documentElement;
    if (!root) return;
    const observer = new MutationObserver(records => {
      records.forEach(record => {
        if (record.type === 'childList') record.addedNodes.forEach(inspectMessage);
        if (record.type === 'attributes' && record.target instanceof Element && record.target.id === 'start_button') {
          log('start_button_changed', playerSnapshot());
        }
      });
    });
    observer.observe(root, { subtree: true, childList: true, attributes: true, attributeFilter: ['class', 'disabled'] });
    document.querySelectorAll('.ui.message').forEach(node => seenMessages.add(node));
  }
  function download(name, data) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
  }
  function debugBundle() {
    return {
      format: 'betagomoku-debug-1.0', exportedAt: iso(), debuggerVersion: VERSION,
      page: {
        href: location.href, userAgent: navigator.userAgent, language: navigator.language,
        timeOrigin: performance.timeOrigin, visibility: document.visibilityState,
        assistantVersion: window.__bgtaTournamentAssistantVersion || null
      },
      currentPlayers: playerSnapshot(),
      tournamentSummary: stateSummary(),
      entries: readEntries()
    };
  }
  function summaryText() {
    const entries = readEntries();
    const starts = entries.filter(entry => entry.type === 'start_click');
    const sessions = new Set(entries.map(entry => entry.sessionId));
    const last = stateSummary();
    return [
      'BetaGomoku Debug v' + VERSION,
      'sessions=' + sessions.size,
      'startClicks=' + starts.length,
      'trusted=' + starts.filter(entry => entry.data.isTrusted).length,
      'synthetic=' + starts.filter(entry => !entry.data.isTrusted).length,
      'assistantVersion=' + (window.__bgtaTournamentAssistantVersion || 'unknown'),
      'eventCount=' + (last ? last.eventCount : 0),
      'inFlight=' + JSON.stringify(last ? last.inFlight : null),
      'lastStart=' + JSON.stringify(starts.at(-1) || null)
    ].join('\n');
  }
  function updateButton(entries = readEntries()) {
    const button = document.getElementById('bgta-debug-launch');
    if (!button) return;
    const starts = entries.filter(entry => entry.type === 'start_click').length;
    button.textContent = 'Debug · Start ' + starts;
  }
  function updatePanel(entries = readEntries()) {
    const body = document.getElementById('bgta-debug-body');
    if (!body) return;
    const recent = entries.slice(-35).reverse();
    body.innerHTML = recent.map(entry => {
      const time = entry.at.slice(11, 23);
      const detail = entry.type === 'start_click'
        ? ((entry.data.isTrusted ? '人工' : '脚本') + ' · ' + (entry.data.players?.black || '?') + ' 黑 vs ' + (entry.data.players?.white || '?') + ' 白')
        : (entry.type === 'page_message_added' ? entry.data.text : '');
      return '<div class="bgta-debug-row"><b>' + time + ' ' + entry.type + '</b><small>' + escapeHtml(detail) + '</small></div>';
    }).join('');
  }
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, char => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);
  }
  function mount() {
    if (document.getElementById('bgta-debug-launch')) return;
    const style = document.createElement('style');
    style.textContent = '#bgta-debug-launch{position:fixed;z-index:2147483646;left:16px;bottom:16px;padding:8px 12px;border:0;border-radius:999px;background:#b54708;color:#fff;font:700 12px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;box-shadow:0 3px 12px #0004;cursor:pointer}#bgta-debug-panel{position:fixed;z-index:2147483647;left:16px;bottom:58px;width:min(440px,calc(100vw - 32px));max-height:62vh;overflow:auto;padding:12px;border:1px solid #f79009;border-radius:10px;background:#fff;color:#182230;box-shadow:0 8px 30px #0004;font:12px/1.4 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif}#bgta-debug-panel h3{margin:0 0 6px;color:#b54708}#bgta-debug-panel button{margin:3px 5px 7px 0;padding:5px 8px}.bgta-debug-row{padding:5px 0;border-top:1px solid #eee}.bgta-debug-row small{display:block;color:#667085;word-break:break-all}';
    document.head.append(style);
    const button = document.createElement('button');
    button.id = 'bgta-debug-launch';
    button.onclick = () => {
      const existing = document.getElementById('bgta-debug-panel');
      if (existing) { existing.remove(); return; }
      const panel = document.createElement('aside');
      panel.id = 'bgta-debug-panel';
      panel.innerHTML = '<h3>赛事诊断记录器 v' + VERSION + '</h3><p>只观察，不会点击 Start 或修改赛果。</p><button id="bgta-debug-export">导出调试 JSON</button><button id="bgta-debug-copy">复制摘要</button><button id="bgta-debug-clear">清空旧日志</button><div id="bgta-debug-body"></div>';
      document.body.append(panel);
      document.getElementById('bgta-debug-export').onclick = () => {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        log('debug_exported', {});
        download('betagomoku-debug-' + stamp + '.json', debugBundle());
      };
      document.getElementById('bgta-debug-copy').onclick = async () => {
        try { await navigator.clipboard.writeText(summaryText()); log('summary_copied', {}); }
        catch (error) { log('summary_copy_failed', { error }); }
      };
      document.getElementById('bgta-debug-clear').onclick = () => {
        if (!confirm('只清空诊断日志，不会删除赛事记录。确定吗？')) return;
        localStorage.removeItem(LOG_KEY);
        log('debug_log_cleared', {});
      };
      updatePanel();
    };
    document.body.append(button);
    updateButton();
  }

  if (window.__bgtaDebuggerVersion) {
    log('duplicate_debugger_injection', { existingVersion: window.__bgtaDebuggerVersion, newVersion: VERSION });
    return;
  }
  window.__bgtaDebuggerVersion = VERSION;

  document.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target.closest('#start_button') : null;
    if (!target) return;
    log('start_click', {
      isTrusted: event.isTrusted, eventType: event.type, detail: event.detail,
      players: playerSnapshot(), stack: clickStack()
    });
  }, true);
  document.addEventListener('change', event => {
    if (!(event.target instanceof Element) || !['player0', 'player1'].includes(event.target.id)) return;
    log('player_selection_changed', { id: event.target.id, isTrusted: event.isTrusted, players: playerSnapshot() });
  }, true);
  window.addEventListener('error', event => log('window_error', {
    message: event.message, filename: event.filename, line: event.lineno, column: event.colno, error: event.error
  }));
  window.addEventListener('unhandledrejection', event => log('unhandled_rejection', { reason: event.reason }));
  window.addEventListener('storage', event => {
    if (event.key === TOURNAMENT_KEY) sampleState('storage_event');
  });
  document.addEventListener('visibilitychange', () => log('visibility_changed', { visibility: document.visibilityState }));
  window.addEventListener('pagehide', event => log('page_hidden', { persisted: event.persisted }));
  window.addEventListener('pageshow', event => log('page_shown', { persisted: event.persisted }));
  window.addEventListener('beforeunload', () => log('before_unload', {}));

  try {
    const resources = new PerformanceObserver(list => {
      list.getEntries().filter(entry => entry.name.includes('/api/exec')).forEach(entry => {
        log('api_exec_resource', {
          name: entry.name, startTime: Math.round(entry.startTime), duration: Math.round(entry.duration),
          transferSize: entry.transferSize || null, initiatorType: entry.initiatorType
        });
      });
    });
    resources.observe({ type: 'resource', buffered: true });
  } catch (error) { log('performance_observer_unavailable', { error }); }

  log('debug_session_started', {
    version: VERSION, href: location.href, readyState: document.readyState,
    topLevel: window.top === window.self, userAgent: navigator.userAgent
  });
  document.addEventListener('DOMContentLoaded', () => {
    log('dom_content_loaded', playerSnapshot());
    startDomObserver();
    mount();
    sampleState('dom_content_loaded');
    stateTimer = setInterval(() => sampleState('poll'), 750);
  }, { once: true });
  window.addEventListener('load', () => log('window_loaded', playerSnapshot()), { once: true });
})();
