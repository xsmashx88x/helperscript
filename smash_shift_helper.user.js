// ==UserScript==
// @name         smash SHiFT tracker redeem helper
// @namespace    bl4-shift-helper-enhanced
// @version      2.5.5
// @description  Receives codes from the tracker site and redeems them on the SHiFT page. Groups expired/used codes into a single, more descriptive log message.
// @match        https://xsmashx88x.github.io/Shift-Codes/*
// @match        https://shift.gearboxsoftware.com/rewards*
// @include      https://shift.gearboxsoftware.com/*
// @run-at       document-end
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_deleteValue
// @grant        unsafeWindow
// ==/UserScript==

(function () {
  'use strict';

  const GM_QUEUE_KEY = 'shift_helper_gm_queue';

  // --- DOMAIN-SPECIFIC LOGIC ---
  if (window.location.hostname.includes('github.io')) {
    unsafeWindow.__sendCodeToHelper = async function(code) {
      try {
        const queue = await GM_getValue(GM_QUEUE_KEY, []);
        if (!queue.includes(code)) {
          queue.push(code);
          await GM_setValue(GM_QUEUE_KEY, queue);
        }
        return true;
      } catch (e) {
        console.error('SHiFT Helper Userscript Error (on Tracker Site):', e);
        return false;
      }
    };
    console.log('SHiFT Helper: Communication bridge created on tracker website.');
    return;
  }

  // --- SHIFT WEBSITE UI AND LOGIC ---
  const TYPE_PAUSE_MS            = 160;
  const AFTER_CHECK_PAUSE_MS     = 350;
  const VALIDATION_WAIT_MS       = 3500;
  const REDEEM_BTN_WAIT_MS       = 7000;
  const CONFIRM_WAIT_MS          = 3500;
  const POST_REDEEM_PAUSE_MS     = 1200;
  const BETWEEN_CODES_COOLDOWN   = 800;
  const STATUS_SCAN_TIMEOUT_MS   = 6000;
  const STATUS_SCAN_INTERVAL_MS  = 250;
  const FORM_READY_TIMEOUT_MS    = 12000;
  const FORM_READY_POLL_MS       = 200;
  const MAX_CONSECUTIVE_ERRORS   = 5;
  const CODE_RE = /\b(?:[A-Z0-9]{4,5}-){4}[A-Z0-9]{4,5}\b/ig;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const $ = (s, r = document) => r.querySelector(s);
  const STORE_KEY     = 'shift_helper_state_v200';
  const ATTEMPT_KEY   = 'shift_helper_attempted_v200';

  function* deepNodes(root = document) { /* ... (This function is unchanged) ... */
    const stack = [root];
    while (stack.length) {
      const node = stack.pop(); if (!node) continue; yield node;
      if (node.shadowRoot) stack.push(node.shadowRoot);
      if (node.children) { for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]); }
    }
  }
  function isVisible(el) { /* ... (This function is unchanged) ... */
    if (!el?.getBoundingClientRect) return false; const rect = el.getBoundingClientRect(); const style = getComputedStyle(el);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }
  function deepFindClickable(testFn) { /* ... (This function is unchanged) ... */
    for (const node of deepNodes()) {
      if (!(node instanceof HTMLElement) || !isVisible(node)) continue;
      const tag = node.tagName; const type = (node.getAttribute('type') || '').toLowerCase();
      const isButton = tag === 'BUTTON' || (tag === 'INPUT' && (type === 'submit' || type === 'button')) || node.getAttribute('role') === 'button';
      if (!isButton) continue;
      const label = (node.innerText || node.textContent || node.getAttribute('value') || node.getAttribute('aria-label') || '').trim();
      if (label && testFn(label, node)) return node;
    }
    return null;
  }
  function deepFindInputNearCode() { /* ... (This function is unchanged) ... */
    for (const node of deepNodes()) {
      if (!(node instanceof HTMLInputElement) || !isVisible(node)) continue;
      const placeholder = (node.placeholder || '').toLowerCase(); const name = (node.name || '').toLowerCase(); const ariaLabel = (node.getAttribute('aria-label') || '').toLowerCase();
      if (/code/.test(placeholder) || /code/.test(name) || /code/.test(ariaLabel)) return node;
    }
    for (const node of deepNodes()) { if (node instanceof HTMLInputElement && node.type === 'text' && isVisible(node)) return node; }
    return null;
  }

  const STATUS_PATTERNS = {
    success:     [/redeemed/i, /claimed/i, /added to/i, /success/i, /enjoy/i],
    unavailable: [/already\s+(?:been\s+)?redeemed/i, /already used/i, /previously redeemed/i, /expired/i, /no longer valid/i, /out of date/i],
    invalid:     [/invalid/i, /not (?:a )?valid/i, /not recognized/i, /does not exist/i],
    throttled:   [/too many/i, /rate.?limit/i, /try again later/i, /slow down/i],
    platform:    [/not available on your platform/i, /wrong platform/i],
    genericOk:   [/code accepted/i],
  };
  
  function grabStatusTexts() { /* ... (This function is unchanged) ... */
    const texts = new Set();
    for (const node of deepNodes()) {
      if (!(node instanceof HTMLElement) || !isVisible(node)) continue;
      const isStatusElement = node.matches?.('[role="alert"], [aria-live], [role="dialog"]') || /alert|toast|snackbar|notification|message|error|success/i.test(node.className || '');
      if (!isStatusElement) continue;
      const text = (node.innerText || node.textContent || '').trim();
      if (text) texts.add(text.replace(/\s+/g, ' '));
    }
    return Array.from(texts);
  }
  
  function classifyStatus(texts) {
    const combinedText = texts.join(' \n ');
    const test = patterns => patterns.some(re => re.test(combinedText));
    
    if (test(STATUS_PATTERNS.unavailable)) return { type: 'unavailable', text: combinedText };
    if (test(STATUS_PATTERNS.invalid)) return { type: 'invalid', text: combinedText };
    if (test(STATUS_PATTERNS.platform)) return { type: 'platform', text: combinedText };
    if (test(STATUS_PATTERNS.throttled)) return { type: 'throttled', text: combinedText };
    if (test(STATUS_PATTERNS.success) || test(STATUS_PATTERNS.genericOk)) return { type: 'success', text: combinedText };
    
    return { type: 'unknown', text: combinedText };
  }

  async function waitForStatus(timeoutMs) {
    const startTime = Date.now(); let lastSeenText = '';
    while (Date.now() - startTime < timeoutMs) {
      const texts = grabStatusTexts(); const currentText = texts.join('|');
      if (currentText && currentText !== lastSeenText) {
        const result = classifyStatus(texts);
        if (result.type !== 'unknown' || currentText.length > 20) return result;
      }
      lastSeenText = currentText; await sleep(STATUS_SCAN_INTERVAL_MS);
    }
    return { type: 'unknown', text: '' };
  }

  function ensurePanel() {
    if ($('#shift-helper-panel')) return true;
    if (!document.body) return false;
    const panel = document.createElement('div');
    panel.id = 'shift-helper-panel';
    panel.style.cssText = 'position:fixed; right:18px; bottom:18px; width:500px; z-index:2147483647; background:rgb(14 14 14); color:#fff; border:2px solid #ffc600; border-radius:5px; box-shadow:0 0 15px rgba(255, 198, 0, 0.4); font-family: \'Oswald\', \'Chakra Petch\', sans-serif;';
    panel.innerHTML = `
      <div style="display:flex; align-items:center; justify-content:space-between; padding:10px 14px; border-bottom:1px solid #ffc600;">
        <strong style="font-size: 16px; color: #ffc600; text-shadow: 1px 1px 0 #000;">SMASH SHiFT TRACKER REDEEM HELPER</strong>
        <div style="display:flex; gap:6px;">
          <button id="sh-min" title="Minimize" style="background:#333; border:1px solid #ffc600; color:#ffc600; border-radius:4px; padding:4px 8px; cursor:pointer;">_</button>
          <button id="sh-x" title="Close" style="background:#333; border:1px solid #ffc600; color:#ffc600; border-radius:4px; padding:4px 8px; cursor:pointer;">×</button>
        </div>
      </div>
      <div id="sh-body" style="padding:14px; display:flex; flex-direction:column; gap:12px;">
        <div style="display:flex; gap:8px; align-items:center;">
          <label style="font-size:13px; color:#ffc600;">Platform:</label>
          <select id="sh-platform" title="The platform to redeem codes for." style="background:#0a0a0a; color:#fff; border:1px solid #ffc600; border-radius:4px; padding:6px 10px; flex-grow:1; font-family: 'Oswald', sans-serif;">
            <option>Steam</option><option>Xbox Live</option><option>Epic</option><option>PSN</option>
          </select>
        </div>
        <textarea id="sh-in" placeholder="Paste codes here, or send them from the tracker website." style="width:100%; min-height:140px; background:#0a0a0a; color:#fff; border:1px solid #ffc600; border-radius:4px; padding:10px; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,'Courier New',monospace; resize:vertical;"></textarea>
        <div style="display:flex; gap:8px; flex-wrap:wrap; font-family: 'Chakra Petch', sans-serif;">
          <button id="sh-start" title="Parse codes from the text area and start redeeming them." style="background: linear-gradient(to bottom, #ff7c00, #e56a00); border: 1px solid #ffc600; color: #fff; text-shadow: 1px 1px 0 #000; border-radius:4px; padding:10px 14px; cursor:pointer; font-weight:700; flex-grow:2;">Start Redeeming</button>
          <button id="sh-stop" title="Stop the script after the current code is finished." style="background: linear-gradient(to bottom, #CC0000, #800000); border: 1px solid #FF4444; color:#fff; text-shadow: 1px 1px 0 #000; border-radius:4px; padding:10px 14px; cursor:pointer; flex-grow:1;">Stop</button>
          <button id="sh-resume" title="Resume a previous run that was interrupted." style="background: linear-gradient(to bottom, #541375, #8519bb); border: 1px solid #b200ff; color:#fff; text-shadow: 1px 1px 0 #000; border-radius:4px; padding:10px 14px; cursor:pointer; flex-grow:1;">Resume</button>
        </div>
        <div id="sh-stats" style="font-size:13px; color:#ffc600; text-align:center; padding: 4px; background: #1a1a1a; border: 1px solid #ffc600; border-radius: 4px;">Ready.</div>
        <div id="sh-log" style="max-height:260px; overflow-y:auto; font-size:12px; background:#0a0a0a; border:1px solid #ffc600; border-radius:4px; padding:8px; line-height:1.6;"></div>
        <details><summary style="cursor:pointer; font-size:12px; color:#ff9e40;">Advanced Options</summary><div style="display:flex; gap:8px; margin-top:8px; flex-wrap:wrap; font-family: 'Chakra Petch', sans-serif;"><button id="sh-load" title="Load a previously saved list of codes." style="background:#222; border:1px solid #ffc600; color:#ffc600; border-radius:4px; padding:8px 10px; cursor:pointer;">Load List</button><button id="sh-save" title="Save the codes currently in the text area." style="background:#222; border:1px solid #ffc600; color:#ffc600; border-radius:4px; padding:8px 10px; cursor:pointer;">Save List</button><button id="sh-export" title="Export the results of the last run as a CSV file." style="background:#222; border:1px solid #ffc600; color:#ffc600; border-radius:4px; padding:8px 10px; cursor:pointer;">Export Results</button><button id="sh-clear-attempts" title="Clear the history of all attempted codes." style="background:#222; border:1px solid #ffc600; color:#ffc600; border-radius:4px; padding:8px 10px; cursor:pointer;">Reset History</button></div></details>
      </div>`;
    document.body.appendChild(panel);
    $('#sh-x').onclick = () => panel.remove();
    $('#sh-min').onclick = () => { const body = $('#sh-body'); body.style.display = body.style.display === 'none' ? 'flex' : 'none'; };
    return true;
  }
  function log(message, kind = 'info') {
    const logEl = $('#sh-log'); if (!logEl) return; const entry = document.createElement('div');
    entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    const colors = { error: '#ff7a90', ok: '#52e2b7', warn: '#ffd36a', info: '#cfe1ff' };
    entry.style.color = colors[kind] || colors.info; logEl.prepend(entry);
  }
  function setStats(queued = 0, errors = 0, success = 0, index = 0, total = 0) {
    const statsEl = $('#sh-stats'); if (statsEl) { statsEl.textContent = `Queued: ${queued} | Success: ${success} | Problems: ${errors} | Progress: ${index}/${total}`; }
  }
  function parseCodes(text) {
    const matches = text.toUpperCase().match(CODE_RE) || []; return [...new Set(matches)];
  }

  /* ================================================================================= */
  /* ===== CORE REDEMPTION LOGIC (The step-by-step process for a single code)    ===== */
  /* ================================================================================= */

  async function clickCheck() {
    const btn = deepFindClickable(txt => /(^|\b)(check|verify|submit|continue|redeem)(\b|$)/i.test(txt));
    if (!btn) throw new Error('Could not find the "Check/Submit" button.');
    btn.click();
    await sleep(AFTER_CHECK_PAUSE_MS);
  }
  async function clickRedeemForPlatform(platform) {
    const targetLabel = `redeem for ${platform.toLowerCase()}`;
    const startTime = Date.now();
    while (Date.now() - startTime < REDEEM_BTN_WAIT_MS) {
      const btn = deepFindClickable(txt => txt.toLowerCase().includes(targetLabel));
      if (btn) {
        btn.click();
        return true;
      }
      await sleep(150);
    }
    return false;
  }
  async function clickConfirmIfPresent() {
    const startTime = Date.now();
    while (Date.now() - startTime < CONFIRM_WAIT_MS) {
      const btn = deepFindClickable(txt => /confirm|redeem|claim|accept|continue/i.test(txt));
      if (btn) {
        btn.click();
        return true;
      }
      await sleep(150);
    }
    return false;
  }
  async function closeDialogsToasts() {
    const closeLabels = ['close', 'ok', 'done', 'continue', 'got it', 'dismiss', 'x'];
    for (let i = 0; i < 5; i++) {
      const btn = deepFindClickable(txt => closeLabels.some(label => txt.toLowerCase().includes(label)));
      if (btn) {
        btn.click();
        await sleep(250);
      } else {
        break;
      }
    }
  }
  async function waitForFormReady() {
    const startTime = Date.now();
    while (Date.now() - startTime < FORM_READY_TIMEOUT_MS) {
      const input = deepFindInputNearCode();
      if (input && !input.disabled && isVisible(input)) {
        return input;
      }
      await sleep(FORM_READY_POLL_MS);
    }
    throw new Error('Form did not become ready for the next code.');
  }

  async function redeemOne(code, platform) {
    const input = await waitForFormReady(); input.focus(); input.value = '';
    input.dispatchEvent(new Event('input', { bubbles: true })); await sleep(50);
    input.value = code; input.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(TYPE_PAUSE_MS); await clickCheck(); await sleep(VALIDATION_WAIT_MS);
    const platformButtonFound = await clickRedeemForPlatform(platform);
    if (!platformButtonFound) { const earlyStatus = await waitForStatus(1000); if (earlyStatus.type !== 'unknown') return earlyStatus; throw new Error(`Could not find the "Redeem for ${platform}" button.`); }
    await clickConfirmIfPresent(); await sleep(POST_REDEEM_PAUSE_MS);
    const status = await waitForStatus(STATUS_SCAN_TIMEOUT_MS); await closeDialogsToasts();
    await sleep(BETWEEN_CODES_COOLDOWN); return status;
  }
  function loadAttempted() {
    try { return new Set(JSON.parse(localStorage.getItem(ATTEMPT_KEY) || '[]')); } catch { return new Set(); }
  }
  function saveAttempted(attemptedSet) {
    try { localStorage.setItem(ATTEMPT_KEY, JSON.stringify(Array.from(attemptedSet))); } catch (e) { console.error('Failed to save attempt history:', e); }
  }
  function markAttempted(codeUpper, attemptedSet) {
    if (!attemptedSet.has(codeUpper)) { attemptedSet.add(codeUpper); saveAttempted(attemptedSet); }
  }
  function clearAttempted() {
    try { localStorage.removeItem(ATTEMPT_KEY); } catch {}
  }
  function saveState(state) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(state)); } catch (e) { console.error('Failed to save state:', e); }
  }
  function loadState() {
    try { return JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { return null; }
  }
  function clearState() {
    try { localStorage.removeItem(STORE_KEY); } catch {}
  }
  async function pollForQueuedCodes() {
      try {
          const codes = await GM_getValue(GM_QUEUE_KEY, []);
          if (Array.isArray(codes) && codes.length > 0) {
              const textarea = $('#sh-in');
              if (textarea) {
                  const newCodes = codes.join('\n');
                  textarea.value += (textarea.value ? '\n' : '') + newCodes;
                  log(`Received ${codes.length} code(s) from tracker website.`, 'ok');
                  if(typeof prepareQueue === 'function') { setTimeout(prepareQueue, 50); }
              }
              await GM_deleteValue(GM_QUEUE_KEY);
          }
      } catch (e) {
          log(`Error processing queued codes: ${e.message}`, 'error');
          await GM_deleteValue(GM_QUEUE_KEY);
      }
  }

  let prepareQueue = () => {};
  function attach() {
    const elements = {
      codeTextarea: $('#sh-in'), startBtn: $('#sh-start'), stopBtn: $('#sh-stop'), resumeBtn: $('#sh-resume'),
      loadBtn: $('#sh-load'), saveBtn: $('#sh-save'), exportBtn: $('#sh-export'),
      clearAttemptsBtn: $('#sh-clear-attempts'), platformSelect: $('#sh-platform'),
    };
    let state = {
      queue: [], running: false, errors: 0, success: 0, currentIndex: 0, results: [], attempted: loadAttempted(),
    };
    const refreshStats = () => {
      const total = state.currentIndex + state.queue.length;
      setStats(state.queue.length, state.errors, state.success, state.currentIndex, total);
    };
    function filterUnattempted(codes) {
      const unattempted = codes.filter(c => !state.attempted.has(c.toUpperCase()));
      if (codes.length - unattempted.length > 0) { log(`Skipped ${codes.length - unattempted.length} already-attempted code(s).`, 'warn'); }
      return unattempted;
    }
    prepareQueue = () => {
      const allCodes = parseCodes(elements.codeTextarea.value);
      state.queue = filterUnattempted(allCodes);
      state.currentIndex = 0; log(`Parsed ${allCodes.length} unique code(s). Queued ${state.queue.length} new code(s).`);
      refreshStats();
    };
    elements.codeTextarea.addEventListener('paste', () => { setTimeout(prepareQueue, 50); });
    elements.saveBtn.onclick = () => {
      const codes = parseCodes(elements.codeTextarea.value); localStorage.setItem('bl_codes_list', JSON.stringify(codes));
      log(`Saved ${codes.length} code(s) to browser storage.`, 'ok');
    };
    elements.loadBtn.onclick = () => {
      try { const codes = JSON.parse(localStorage.getItem('bl_codes_list') || '[]'); elements.codeTextarea.value = codes.join('\n');
        log(`Loaded ${codes.length} code(s).`, 'ok'); prepareQueue();
      } catch (e) { log(`Failed to load codes: ${e.message}`, 'error'); }
    };
    elements.exportBtn.onclick = () => {
      if (state.results.length === 0) { log('No results to export.', 'warn'); return; }
      const header = 'code,status,details'; const csvRows = state.results.map(r => `"${r.code}","${r.status}","${(r.details || '').replace(/\s+/g, ' ').replace(/"/g, '""')}"`);
      const csv = [header, ...csvRows].join('\n'); const blob = new Blob([csv], { type: 'text/csv' });
      const url = URL.createObjectURL(blob); const a = document.createElement('a');
      a.href = url; a.download = `shift_results_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
      a.click(); URL.revokeObjectURL(url);
    };
    elements.clearAttemptsBtn.onclick = () => {
      if (confirm('Are you sure you want to clear all attempt history? The script will try all codes again.')) {
        clearAttempted(); state.attempted = new Set(); log('Attempt history cleared.', 'ok');
      }
    };
    elements.stopBtn.onclick = () => {
      if (state.running) { state.running = false; log('Stopping after the current code finishes...'); saveState({ ...state, running: false }); }
    };
    elements.resumeBtn.onclick = async () => {
      const saved = loadState(); if (!saved || !saved.queue || saved.queue.length === 0) { log('No saved run found to resume.', 'warn'); return; }
      const unattemptedQueue = saved.queue.filter(c => !state.attempted.has(c.toUpperCase()));
      state.queue = unattemptedQueue; state.currentIndex = Math.min(saved.currentIndex || 0, unattemptedQueue.length);
      state.errors = saved.errors || 0; state.success = saved.success || 0;
      elements.platformSelect.value = saved.platform || elements.platformSelect.value;
      log(`Resuming run. ${state.queue.length} code(s) remaining.`, 'ok'); startRedeeming(true);
    };
    async function startRedeeming(isResume = false) {
      if (state.running) { log('Already running.', 'warn'); return; }
      if (!isResume) {
        prepareQueue(); if (state.queue.length === 0) { log('No new codes to redeem.', 'warn'); return; }
        state.errors = 0; state.success = 0; state.results = [];
      }
      state.running = true; const platform = elements.platformSelect.value; let consecutiveErrors = 0;
      for (; state.currentIndex < state.queue.length; state.currentIndex++) {
        if (!state.running) break;
        const code = state.queue[state.currentIndex]; const codeUpper = code.toUpperCase();
        saveState({ ...state, platform, currentIndex: state.currentIndex + 1 });
        log(`[${state.currentIndex + 1}/${state.queue.length}] Attempting: ${code} for ${platform}...`);
        try {
          const result = await redeemOne(code, platform);
          state.results.push({ code, status: result.type, details: result.text });
          markAttempted(codeUpper, state.attempted);
          consecutiveErrors = 0;
          let kind = 'info', message = 'Status unknown';
          
          switch (result.type) {
            case 'success':     kind = 'ok';    message = '✅ Active';                  state.success++; break;
            case 'unavailable': kind = 'error'; message = '❌ Expired/Already Used';  state.errors++;  break;
            case 'invalid':     kind = 'error'; message = '❌ Invalid';                  state.errors++;  break;
            case 'platform':    kind = 'warn';  message = '⚠️ Wrong platform';         state.errors++;  break;
            case 'throttled':   kind = 'warn';  message = '⏳ Rate limited';            state.errors++;  break;
          }

          // ===== THIS LOGGING BLOCK HAS BEEN MODIFIED =====
          if (result.type === 'unavailable') {
            const reason = "This code has expired or been redeemed already.";
            log(`${message}: ${reason} (${code})`, kind);
          } else {
            log(`${message}: ${code}`, kind);
            if (result.text) { log(`   Details: ${result.text.substring(0, 180)}...`, 'info'); }
          }
          // ===== END OF MODIFICATION =====

        } catch (e) {
          state.errors++; consecutiveErrors++; log(`Error on ${code}: ${e.message}`, 'error');
          if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) { log('Stopping due to too many consecutive errors.', 'error'); state.running = false; break; }
        } finally { refreshStats(); }
      }
      state.running = false; clearState();
      log(`Finished. Success: ${state.success}, Problems: ${state.errors}.`, state.success > 0 ? 'ok' : 'warn');
    }
    elements.startBtn.onclick = () => startRedeeming(false);
  }

  function bootstrap() {
    if (ensurePanel()) { attach(); }
    setInterval(pollForQueuedCodes, 2000);
    const observer = new MutationObserver(() => {
      if (!$('#shift-helper-panel')) { if (ensurePanel()) { attach(); } }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    const savedState = loadState();
    if (savedState && savedState.running) {
      setTimeout(() => {
        if (ensurePanel()) { if (!$('#sh-resume').onclick) { attach(); } $('#sh-resume')?.click(); }
      }, 1000);
    }
  }

  bootstrap();

})();
