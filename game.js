/**
 * game.js — 注音 Wordle 主邏輯
 *
 * 主要功能:
 * 1. Token 解密 + 從 URL 載入題目
 * 2. 注音鍵盤輸入(5 格 + Enter)
 * 3. 滿 5 格時即時顯示候選詞(電腦右側、手機上方)
 * 4. 按 Enter 若不是合法詞 → 整列變紅,需玩家自己用刪除鍵收回(不算一次機會)
 * 5. 答對/失敗 → 顯示 modal(關閉 modal 後保留遊戲畫面但不能重玩)
 */

(() => {
  // ──────────────────────────────────────────────────────
  // 常數
  // ──────────────────────────────────────────────────────
  const ROWS = 7, COLS = 5;

  const KEYBOARD_LAYOUT = [
    ['ㄅ','ㄉ','ㄓ','ㄚ','ㄞ','ㄢ','ㄦ'],
    ['ㄆ','ㄊ','ㄍ','ㄐ','ㄔ','ㄗ','ㄧ','ㄛ','ㄟ','ㄣ'],
    ['ㄇ','ㄋ','ㄎ','ㄑ','ㄕ','ㄘ','ㄨ','ㄜ','ㄠ','ㄤ'],
    ['ㄈ','ㄌ','ㄏ','ㄒ','ㄖ','ㄙ','ㄩ','ㄝ','ㄡ','ㄥ'],
  ];

  // ──────────────────────────────────────────────────────
  // Token 處理
  // ──────────────────────────────────────────────────────
  const PASSPHRASE = 'bopowordle2026!@#xK9mP2vL';

  function getTokenFromURL() {
    const params = new URLSearchParams(window.location.search);
    return params.get('t');
  }

  function decodeToken(token) {
    try {
      let s = token.replace(/-/g, '+').replace(/_/g, '/');
      const pad = s.length % 4;
      if (pad) s += '='.repeat(4 - pad);
      const binary = atob(s);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) & 0xff;
      const keyBytes = new TextEncoder().encode(PASSPHRASE);
      const decoded = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) {
        decoded[i] = bytes[i] ^ keyBytes[i % keyBytes.length];
      }
      const json = new TextDecoder('utf-8').decode(decoded);
      return JSON.parse(json);
    } catch (e) {
      console.error('Token 解碼失敗', e);
      return null;
    }
  }

  // ──────────────────────────────────────────────────────
  // localStorage 進度
  // ──────────────────────────────────────────────────────
  const LS_KEY_PREFIX = 'wordle_progress_';
  function getProgressKey(puzzle) {
    return LS_KEY_PREFIX + [
      puzzle.issue, puzzle.date, puzzle.bopo, puzzle.userId, puzzle.guildId
    ].join('|');
  }
  function loadProgress(puzzle) {
    try {
      const raw = localStorage.getItem(getProgressKey(puzzle));
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }
  function saveProgress(puzzle, data) {
    try {
      localStorage.setItem(getProgressKey(puzzle), JSON.stringify(data));
    } catch (e) { /* ignore */ }
  }

  // ──────────────────────────────────────────────────────
  // 比對邏輯
  // ──────────────────────────────────────────────────────
  function evaluate(guess, answer) {
    const n = answer.length;
    const result = new Array(n).fill('absent');
    const used = new Array(n).fill(false);
    for (let i = 0; i < n; i++) {
      if (guess[i] === answer[i]) { result[i] = 'correct'; used[i] = true; }
    }
    for (let i = 0; i < n; i++) {
      if (result[i] === 'correct') continue;
      for (let j = 0; j < n; j++) {
        if (!used[j] && guess[i] === answer[j]) {
          result[i] = 'present';
          used[j] = true;
          break;
        }
      }
    }
    return result;
  }

  // ──────────────────────────────────────────────────────
  // Relay
  // ──────────────────────────────────────────────────────
  async function sendEvent(event, payload) {
    if (!CONFIG.RELAY_URL || CONFIG.RELAY_URL.includes('你的帳號')) {
      console.warn('CONFIG 未設定,跳過發送');
      return;
    }
    try {
      const body = { event, token: state.token, ...payload };
      await fetch(CONFIG.RELAY_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Wordle-Secret': CONFIG.SHARED_SECRET,
        },
        body: JSON.stringify(body),
      });
    } catch (e) {
      console.warn('發送事件失敗', e);
    }
  }

  // ──────────────────────────────────────────────────────
  // 全域狀態
  // ──────────────────────────────────────────────────────
  const state = {
    token: null,
    puzzle: null,
    attempts: [],
    currentInput: '',
    finished: false,
    startTime: null,
    invalidMode: false,  // 當前列「找不到這個詞」的鎖定狀態
  };

  // ──────────────────────────────────────────────────────
  // UI 渲染
  // ──────────────────────────────────────────────────────
  function buildBoard() {
    const board = document.getElementById('board');
    board.innerHTML = '';
    for (let r = 0; r < ROWS; r++) {
      const row = document.createElement('div');
      row.className = 'row';
      row.id = 'row-' + r;
      for (let c = 0; c < COLS; c++) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.id = `cell-${r}-${c}`;
        row.appendChild(cell);
      }
      board.appendChild(row);
    }
  }

  function buildKeyboard() {
    const kb = document.getElementById('keyboard');
    kb.innerHTML = '';
    KEYBOARD_LAYOUT.forEach(rowKeys => {
      const row = document.createElement('div');
      row.className = 'kb-row';
      rowKeys.forEach(k => {
        const btn = document.createElement('button');
        btn.className = 'key';
        btn.textContent = k;
        btn.dataset.key = k;
        btn.addEventListener('click', () => onKey(k));
        row.appendChild(btn);
      });
      kb.appendChild(row);
    });
    const ctrlRow = document.createElement('div');
    ctrlRow.className = 'kb-row';
    const del = document.createElement('button');
    del.className = 'key wide'; del.textContent = '⌫ 刪除';
    del.addEventListener('click', () => onKey('BACK'));
    const enter = document.createElement('button');
    enter.className = 'key wide'; enter.textContent = '送出 ENTER';
    enter.addEventListener('click', () => onKey('ENTER'));
    ctrlRow.appendChild(del);
    ctrlRow.appendChild(enter);
    kb.appendChild(ctrlRow);
  }

  function showToast(msg, ms = 1600) {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(showToast._t);
    showToast._t = setTimeout(() => t.classList.remove('show'), ms);
  }

  function shakeRow(rIdx) {
    const row = document.getElementById('row-' + rIdx);
    if (!row) return;
    row.classList.remove('shake');
    void row.offsetWidth;
    row.classList.add('shake');
  }

  function renderCurrentInput() {
    const r = state.attempts.length;
    if (r >= ROWS) return;
    for (let c = 0; c < COLS; c++) {
      const cell = document.getElementById(`cell-${r}-${c}`);
      if (!cell) continue;
      const ch = state.currentInput[c] || '';
      cell.textContent = ch;
      // invalid 樣式不要被洗掉
      if (state.invalidMode) {
        cell.className = 'cell invalid' + (ch ? ' filled' : '');
      } else {
        cell.className = 'cell' + (ch ? ' filled' : '');
      }
    }
    updateSuggestions();
  }

  async function renderAttemptResult(rIdx, attempt) {
    for (let c = 0; c < COLS; c++) {
      const cell = document.getElementById(`cell-${rIdx}-${c}`);
      if (!cell) continue;
      cell.textContent = attempt.guess[c];
      setTimeout(() => {
        cell.classList.add('flip');
        setTimeout(() => {
          cell.className = 'cell ' + attempt.statuses[c];
        }, 300);
      }, c * 200);
    }
    setTimeout(() => updateKeyboardColors(), COLS * 200 + 300);
  }

  function updateKeyboardColors() {
    const priority = { correct: 3, present: 2, absent: 1 };
    const best = {};
    state.attempts.forEach(att => {
      for (let i = 0; i < att.guess.length; i++) {
        const ch = att.guess[i];
        const st = att.statuses[i];
        if (!best[ch] || priority[st] > priority[best[ch]]) {
          best[ch] = st;
        }
      }
    });
    document.querySelectorAll('.key').forEach(btn => {
      const k = btn.dataset.key;
      if (!k || k === 'ENTER' || k === 'BACK') return;
      btn.classList.remove('correct','present','absent');
      if (best[k]) btn.classList.add(best[k]);
    });
  }

  // ──────────────────────────────────────────────────────
  // invalid 狀態管理
  // ──────────────────────────────────────────────────────
  function setInvalidRow() {
    state.invalidMode = true;
    const r = state.attempts.length;
    for (let c = 0; c < COLS; c++) {
      const cell = document.getElementById(`cell-${r}-${c}`);
      if (cell) cell.classList.add('invalid');
    }
    showToast('找不到這個詞,請按刪除鍵修改');
  }

  function clearInvalidRow() {
    if (!state.invalidMode) return;
    state.invalidMode = false;
    const r = state.attempts.length;
    for (let c = 0; c < COLS; c++) {
      const cell = document.getElementById(`cell-${r}-${c}`);
      if (cell) cell.classList.remove('invalid');
    }
  }

  // ──────────────────────────────────────────────────────
  // 候選詞:當前輸入(滿 5 格)反查可能的中文兩字詞
  // ──────────────────────────────────────────────────────
  function getSuggestions(bopo) {
    if (!bopo || bopo.length !== COLS) return [];
    const validSet = new Set(VALID_BOPOS);
    const results = [];
    const seen = new Set();

    for (const split of [1, 2, 3, 4]) {
      const part1 = bopo.substring(0, split);
      const part2 = bopo.substring(split);
      if (!validSet.has(part1) || !validSet.has(part2)) continue;

      const chars1 = BOPO_TO_CHARS[part1] || [];
      const chars2 = BOPO_TO_CHARS[part2] || [];
      if (chars1.length === 0 || chars2.length === 0) continue;

      for (const c1 of chars1) {
        for (const c2 of chars2) {
          const word = c1 + c2;
          if (!seen.has(word)) {
            seen.add(word);
            results.push(word);
          }
          if (results.length >= 40) return results;
        }
      }
    }
    return results;
  }

  function updateSuggestions() {
    const box = document.getElementById('suggestions');
    if (!box) return;

    const bopo = state.currentInput;

    if (state.finished || bopo.length !== COLS) {
      box.classList.remove('show');
      box.innerHTML = '';
      return;
    }

    const list = getSuggestions(bopo);
    if (list.length === 0) {
      box.innerHTML = '<div class="sug-title">⚠️ 找不到符合的詞</div>';
      box.classList.add('show');
      return;
    }

    box.innerHTML =
      '<div class="sug-title">可能的詞</div>' +
      '<div class="sug-list">' +
      list.map(w => `<span class="sug-item">${w}</span>`).join('') +
      '</div>';
    box.classList.add('show');
  }

  // ──────────────────────────────────────────────────────
  // 主互動
  // ──────────────────────────────────────────────────────
  function onKey(k) {
    if (state.finished) return;

    if (k === 'BACK') {
      // invalid 狀態下,按刪除就是收回 → 解除 invalid + 同時刪一格
      if (state.invalidMode) {
        clearInvalidRow();
      }
      state.currentInput = state.currentInput.slice(0, -1);
      renderCurrentInput();
      return;
    }
    if (k === 'ENTER') {
      if (state.invalidMode) {
        showToast('請先按刪除鍵修改答案');
        shakeRow(state.attempts.length);
        return;
      }
      submitGuess();
      return;
    }
    // 一般輸入
    if (state.invalidMode) {
      // invalid 狀態下,玩家必須先刪除才能繼續
      showToast('請先按刪除鍵修改答案');
      shakeRow(state.attempts.length);
      return;
    }
    if (state.currentInput.length >= COLS) return;
    state.currentInput += k;
    renderCurrentInput();
  }

  // ──────────────────────────────────────────────────────
  // 詞庫驗證:5 格能切成兩個合法注音?
  // ──────────────────────────────────────────────────────
  function isValidWord(bopo5) {
    const validSet = new Set(VALID_BOPOS);
    for (const split of [1, 2, 3, 4]) {
      const part1 = bopo5.substring(0, split);
      const part2 = bopo5.substring(split);
      if (validSet.has(part1) && validSet.has(part2)) {
        return true;
      }
    }
    return false;
  }

  async function submitGuess() {
    if (state.currentInput.length !== COLS) {
      showToast('要剛好 5 格注音!');
      shakeRow(state.attempts.length);
      return;
    }
    const guessBopo = state.currentInput;

    if (!isValidWord(guessBopo)) {
      // 不算機會,變紅鎖住,玩家自己按刪除收回
      shakeRow(state.attempts.length);
      setInvalidRow();
      return;
    }

    clearInvalidRow();

    const answerBopo = state.puzzle.bopo;
    const statuses = evaluate(guessBopo, answerBopo);
    const attempt = { guess: guessBopo, word: '', statuses };
    state.attempts.push(attempt);
    const rIdx = state.attempts.length - 1;
    state.currentInput = '';

    await renderAttemptResult(rIdx, attempt);
    updateSuggestions();  // 清掉候選詞顯示

    saveProgress(state.puzzle, {
      attempts: state.attempts,
      finished: state.finished,
      startTime: state.startTime,
      announced: true,
    });

    const isWin = statuses.every(s => s === 'correct');
    const isLose = !isWin && state.attempts.length >= ROWS;

    if (isWin) {
      state.finished = true;
      saveProgress(state.puzzle, {
        attempts: state.attempts,
        finished: true,
        startTime: state.startTime,
        announced: true,
      });
      setTimeout(() => onWin(), COLS * 200 + 600);
    } else if (isLose) {
      state.finished = true;
      saveProgress(state.puzzle, {
        attempts: state.attempts,
        finished: true,
        startTime: state.startTime,
        announced: true,
      });
      setTimeout(() => onLose(), COLS * 200 + 600);
    }
  }

  function getElapsedSec() {
    if (!state.startTime) return 0;
    return Math.max(0, Math.round((Date.now() - state.startTime) / 1000));
  }

  function fmtTime(sec) {
    if (sec < 60) return sec + '秒';
    const m = Math.floor(sec / 60), s = sec % 60;
    return `${m}分${s}秒`;
  }

  async function onWin() {
    const attempts = state.attempts.length;
    const elapsed = getElapsedSec();
    document.getElementById('modal-title').textContent = '🎉 答對了!';
    document.getElementById('modal-text').textContent = `恭喜你用 ${attempts} 次猜中!`;
    document.getElementById('stat-attempts').textContent = `${attempts}/7`;
    document.getElementById('stat-time').textContent = fmtTime(elapsed);
    document.getElementById('modal').classList.add('show');

    await sendEvent('finished', {
      won: true,
      attempts,
      grid: state.attempts.map(a => a.statuses),
      elapsed,
    });
  }

  async function onLose() {
    document.getElementById('modal-title').textContent = '💔 挑戰失敗';
    document.getElementById('modal-text').textContent = '7 次機會用完了!';
    document.getElementById('stat-attempts').textContent = 'X/7';
    document.getElementById('stat-time').textContent = fmtTime(getElapsedSec());
    document.getElementById('modal').classList.add('show');

    await sendEvent('finished', {
      won: false,
      attempts: state.attempts.length,
      grid: state.attempts.map(a => a.statuses),
      elapsed: getElapsedSec(),
    });
  }

  // ──────────────────────────────────────────────────────
  // 啟動
  // ──────────────────────────────────────────────────────
  async function init() {
    const token = getTokenFromURL();
    if (!token) {
      showError('沒有偵測到玩家連結。請從 Discord 點擊「Play now」按鈕進入。');
      return;
    }
    const puzzle = decodeToken(token);
    if (!puzzle || !puzzle.bopo || puzzle.bopo.length !== 5) {
      showError('連結資料不正確或已過期。請從 Discord 重新點擊「Play now」按鈕。');
      return;
    }
    state.token = token;
    state.puzzle = puzzle;

    document.getElementById('puzzle-info').textContent =
      `第 ${puzzle.issue} 期 · ${puzzle.date}`;
    document.getElementById('player-info').textContent =
      `玩家:${puzzle.userName}`;

    buildBoard();
    buildKeyboard();

    const prev = loadProgress(state.puzzle);
    let alreadyAnnounced = false;

    if (puzzle.readonly) {
      state.finished = true;
      alreadyAnnounced = true;
      if (prev) {
        state.attempts = prev.attempts || [];
        state.startTime = prev.startTime || Date.now();
        state.attempts.forEach((att, idx) => {
          for (let c = 0; c < COLS; c++) {
            const cell = document.getElementById(`cell-${idx}-${c}`);
            if (cell) {
              cell.textContent = att.guess[c];
              cell.className = 'cell ' + att.statuses[c];
            }
          }
        });
        updateKeyboardColors();
      }
      if (puzzle.finishedWon) {
        document.getElementById('modal-title').textContent = '🎉 你已經答對了!';
        document.getElementById('modal-text').textContent =
          state.attempts.length > 0 ? `用了 ${state.attempts.length} 次猜中` : '今日成績已公布到頻道';
        document.getElementById('stat-attempts').textContent =
          state.attempts.length > 0 ? `${state.attempts.length}/7` : '✓';
      } else {
        document.getElementById('modal-title').textContent = '💔 你今日已挑戰失敗';
        document.getElementById('modal-text').textContent = '明天再來吧!';
        document.getElementById('stat-attempts').textContent = 'X/7';
      }
      document.getElementById('stat-time').textContent = '-';
      document.getElementById('modal').classList.add('show');
    } else if (prev) {
      state.attempts = prev.attempts || [];
      state.finished = prev.finished || false;
      state.startTime = prev.startTime || Date.now();
      alreadyAnnounced = prev.announced || false;
      state.attempts.forEach((att, idx) => {
        for (let c = 0; c < COLS; c++) {
          const cell = document.getElementById(`cell-${idx}-${c}`);
          if (cell) {
            cell.textContent = att.guess[c];
            cell.className = 'cell ' + att.statuses[c];
          }
        }
      });
      updateKeyboardColors();
      if (state.finished) {
        const lastWin = state.attempts.length > 0 &&
          state.attempts[state.attempts.length-1].statuses.every(s => s === 'correct');
        if (lastWin) {
          document.getElementById('modal-title').textContent = '🎉 你已經答對了!';
          document.getElementById('modal-text').textContent =
            `用了 ${state.attempts.length} 次猜中`;
          document.getElementById('stat-attempts').textContent = `${state.attempts.length}/7`;
        } else {
          document.getElementById('modal-title').textContent = '💔 你今日已挑戰失敗';
          document.getElementById('modal-text').textContent = '明天再來吧!';
          document.getElementById('stat-attempts').textContent = 'X/7';
        }
        document.getElementById('stat-time').textContent = '-';
        document.getElementById('modal').classList.add('show');
      }
    } else {
      state.startTime = Date.now();
    }

    if (!alreadyAnnounced) {
      saveProgress(state.puzzle, {
        attempts: state.attempts,
        finished: state.finished,
        startTime: state.startTime,
        announced: true,
      });
      await sendEvent('playing', {});
    }
  }

  function showError(msg) {
    document.getElementById('game').style.display = 'none';
    document.getElementById('error-msg').textContent = msg;
    document.getElementById('error').classList.add('show');
  }

  // 鍵盤實體支援(電腦玩家用)
  document.addEventListener('keydown', e => {
    if (e.key === 'Enter') { onKey('ENTER'); e.preventDefault(); }
    else if (e.key === 'Backspace') { onKey('BACK'); e.preventDefault(); }
  });

  init();
})();
