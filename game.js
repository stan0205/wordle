/**
 * game.js — 注音 Wordle 主邏輯
 *
 * 流程:
 * 1. 從 URL 讀取 token(來自 bot 給的 Play now 連結)
 * 2. 解密 token 得到:玩家、伺服器、答案注音、答案詞、第幾期
 * 3. 玩家點擊注音鍵盤逐格輸入
 * 4. 滿 5 格 + Enter 送出 → 比對答案 → 顯示綠/黃/灰
 * 5. 第一次點開 → 自動發 "playing" 通知到 Cloudflare → Discord
 * 6. 通關/失敗 → 自動發 "finished" / "failed" 通知
 *
 * 答案保護:token 內的答案用 XOR + base64 加密,F12 看到的是亂碼
 */

(() => {
  // ──────────────────────────────────────────────────────
  // 常數
  // ──────────────────────────────────────────────────────
  const ROWS = 6, COLS = 5;
  const TONE_MARKS = 'ˇˊˋ˙';

  // 注音鍵盤布局(只放注音符號,不放聲調 — 玩家不需要選聲調)
  // 排成 4 行,每行 9-10 個,適合手機螢幕
  const KEYBOARD_LAYOUT = [
    ['ㄅ','ㄉ','ㄓ','ㄚ','ㄞ','ㄢ','ㄦ'],
    ['ㄆ','ㄊ','ㄍ','ㄐ','ㄔ','ㄗ','ㄧ','ㄛ','ㄟ','ㄣ'],
    ['ㄇ','ㄋ','ㄎ','ㄑ','ㄕ','ㄘ','ㄨ','ㄜ','ㄠ','ㄤ'],
    ['ㄈ','ㄌ','ㄏ','ㄒ','ㄖ','ㄙ','ㄩ','ㄝ','ㄡ','ㄥ'],
  ];

  // ──────────────────────────────────────────────────────
  // 工具:從 URL 解析 token
  // ──────────────────────────────────────────────────────
  function getTokenFromURL() {
    const params = new URLSearchParams(window.location.search);
    return params.get('t');
  }

  // ──────────────────────────────────────────────────────
  // Token 解密
  // 格式:base64url( UTF8(JSON.stringify({...})) XOR PASSPHRASE )
  // 內容:{ guildId, userId, userName, channelId, issue, date, word, bopo }
  // ──────────────────────────────────────────────────────
  const PASSPHRASE = 'bopowordle2026!@#xK9mP2vL'; // 跟 bot 端一致

  function decodeToken(token) {
    try {
      // base64url decode → bytes
      let s = token.replace(/-/g, '+').replace(/_/g, '/');
      const pad = s.length % 4;
      if (pad) s += '='.repeat(4 - pad);
      const binary = atob(s);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) & 0xff;

      // XOR 解密(byte 層級,跟密鑰的 UTF-8 bytes 對 XOR)
      const keyBytes = new TextEncoder().encode(PASSPHRASE);
      const decoded = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) {
        decoded[i] = bytes[i] ^ keyBytes[i % keyBytes.length];
      }

      // bytes → UTF-8 string
      const json = new TextDecoder('utf-8').decode(decoded);
      return JSON.parse(json);
    } catch (e) {
      console.error('Token 解碼失敗', e);
      return null;
    }
  }

  // ──────────────────────────────────────────────────────
  // localStorage:記錄今日進度,避免重複發開始通知
  // key 用 puzzle 的 issue + date + bopo 組合,確保不同題目絕不撞 key
  // ──────────────────────────────────────────────────────
  const LS_KEY_PREFIX = 'wordle_progress_';
  function getProgressKey(puzzle) {
    // 用題目本身的識別:期數 + 日期 + 答案注音 + 玩家ID
    return LS_KEY_PREFIX + [
      puzzle.issue,
      puzzle.date,
      puzzle.bopo,
      puzzle.userId,
      puzzle.guildId,
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
    } catch (e) { /* 隱私模式可能無法寫,忽略 */ }
  }

  // ──────────────────────────────────────────────────────
  // 字 → 注音
  // ──────────────────────────────────────────────────────
  function chineseToBopomofo(word) {
    let result = '';
    for (const c of word) {
      const bopo = CHAR_TO_BOPO[c];
      if (!bopo) return null;
      result += bopo;
    }
    return result;
  }

  // ──────────────────────────────────────────────────────
  // 比對邏輯(同 Wordle,正確處理重複注音)
  // ──────────────────────────────────────────────────────
  function evaluate(guess, answer) {
    const n = answer.length;
    const result = new Array(n).fill('absent');
    const used = new Array(n).fill(false);
    // 先找 correct
    for (let i = 0; i < n; i++) {
      if (guess[i] === answer[i]) { result[i] = 'correct'; used[i] = true; }
    }
    // 再找 present
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
  // Relay:把事件送到 Cloudflare → Discord
  // ──────────────────────────────────────────────────────
  async function sendEvent(event, payload) {
    if (!CONFIG.RELAY_URL || CONFIG.RELAY_URL.includes('你的帳號')) {
      console.warn('CONFIG 未設定,跳過發送');
      return;
    }
    try {
      const body = {
        event,
        token: state.token,
        ...payload,
      };
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
    puzzle: null,         // { guildId, userId, userName, channelId, issue, date, word, bopo }
    attempts: [],         // [{ guess: 'ㄋㄩㄒㄧㄥ', word: '女星', statuses: [...] }]
    currentInput: '',     // 當前正在輸入的注音(0~5格)
    finished: false,
    startTime: null,
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
    // 控制鍵列:刪除 + 送出
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
      cell.className = 'cell' + (ch ? ' filled' : '');
    }
  }

  async function renderAttemptResult(rIdx, attempt) {
    for (let c = 0; c < COLS; c++) {
      const cell = document.getElementById(`cell-${rIdx}-${c}`);
      if (!cell) continue;
      cell.textContent = attempt.guess[c];
      // 翻轉動畫,逐格延遲
      setTimeout(() => {
        cell.classList.add('flip');
        setTimeout(() => {
          cell.className = 'cell ' + attempt.statuses[c];
        }, 300);
      }, c * 200);
    }
    // 更新鍵盤狀態
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
  // 主互動
  // ──────────────────────────────────────────────────────
  function onKey(k) {
    if (state.finished) return;
    if (k === 'BACK') {
      state.currentInput = state.currentInput.slice(0, -1);
      renderCurrentInput();
      return;
    }
    if (k === 'ENTER') {
      submitGuess();
      return;
    }
    if (state.currentInput.length >= COLS) return;
    state.currentInput += k;
    renderCurrentInput();
  }

  async function submitGuess() {
    if (state.currentInput.length !== COLS) {
      showToast('要剛好 5 格注音!');
      shakeRow(state.attempts.length);
      return;
    }
    const guessBopo = state.currentInput;
    const answerBopo = state.puzzle.bopo;
    const statuses = evaluate(guessBopo, answerBopo);
    const attempt = { guess: guessBopo, word: '', statuses };
    state.attempts.push(attempt);
    const rIdx = state.attempts.length - 1;
    state.currentInput = '';

    await renderAttemptResult(rIdx, attempt);

    // 儲存進度
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
    document.getElementById('stat-attempts').textContent = `${attempts}/6`;
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
    document.getElementById('modal-text').textContent = '6 次機會用完了!';
    document.getElementById('stat-attempts').textContent = 'X/6';
    document.getElementById('stat-time').textContent = fmtTime(getElapsedSec());
    document.getElementById('modal').classList.add('show');

    await sendEvent('finished', {
      won: false,
      attempts: 6,
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

    // 顯示資訊
    document.getElementById('puzzle-info').textContent =
      `第 ${puzzle.issue} 期 · ${puzzle.date}`;
    document.getElementById('player-info').textContent =
      `玩家:${puzzle.userName}`;

    buildBoard();
    buildKeyboard();

    // 載入進度
    const prev = loadProgress(state.puzzle);
    let alreadyAnnounced = false;
    if (prev) {
      state.attempts = prev.attempts || [];
      state.finished = prev.finished || false;
      state.startTime = prev.startTime || Date.now();
      alreadyAnnounced = prev.announced || false;
      // 重繪所有已完成的列
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
      // 如果已完成,直接顯示結果 modal
      if (state.finished) {
        const lastWin = state.attempts.length > 0 &&
          state.attempts[state.attempts.length-1].statuses.every(s => s === 'correct');
        if (lastWin) {
          document.getElementById('modal-title').textContent = '🎉 你已經答對了!';
          document.getElementById('modal-text').textContent =
            `用了 ${state.attempts.length} 次猜中`;
          document.getElementById('stat-attempts').textContent = `${state.attempts.length}/6`;
        } else {
          document.getElementById('modal-title').textContent = '💔 你今日已挑戰失敗';
          document.getElementById('modal-text').textContent = '明天再來吧!';
          document.getElementById('stat-attempts').textContent = 'X/6';
        }
        document.getElementById('stat-time').textContent = '-';
        document.getElementById('modal').classList.add('show');
      }
    } else {
      state.startTime = Date.now();
    }

    // 第一次進來才發開始通知
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
    // 注音鍵盤對應 ㄅㄆㄇ等需要切輸入法,所以只支援 Enter/Backspace
    // 點擊 UI 鍵盤即可
  });

  init();
})();
