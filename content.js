// TikTok Slow Unfollower v1.2 - content script
// 1. Opens your Following list (goes to your profile first if needed)
// 2. Clicks each "Following" button slowly to unfollow
// All logs go to the page console (F12 > Console, filter "[TikTok Unfollower]") and to the extension popup.

(() => {
  const TAG = '[TikTok Unfollower]';

  // Button labels in English, Portuguese and Spanish (TikTok follows your app language)
  const FOLLOWING_LABELS = ['following', 'friends', 'a seguir', 'seguindo', 'amigos', 'siguiendo'];
  const FOLLOW_LABELS = ['follow', 'follow back', 'seguir', 'seguir de volta', 'seguir também', 'seguir tambem', 'seguir también'];
  const CONFIRM_LABELS = ['unfollow', 'deixar de seguir', 'dejar de seguir'];
  const LIMIT_PATTERNS = [
    /too fast/i, /try again later/i, /slow down/i, /rate limit/i,
    /demasiado r[aá]pido/i, /muito r[aá]pido/i, /mais tarde/i, /m[aá]s tarde/i
  ];
  const CLICKABLE = 'button, [role="button"], [data-e2e*="follow" i]';
  const DEFAULTS = { minDelay: 4, maxDelay: 9, batchSize: 25, batchPause: 120, dailyCap: 150 };
  const MAX_EMPTY_RELOADS = 3;   // stop after this many refreshes in a row that unfollow nobody
  const RELOAD_WAIT_SEC = 10;    // pause before refreshing the page

  let running = false;
  let stoppedByUser = false;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const text = (el) => norm(el.innerText || el.textContent);
  const today = () => new Date().toISOString().slice(0, 10);
  const visible = (el) => !!(el && (el.offsetWidth || el.offsetHeight || el.getClientRects().length));

  // ---------- logging (console + popup) ----------
  const pending = [];
  let flushTimer = null;

  function fmt(a) {
    if (a instanceof Error) return a.message;
    if (typeof a === 'object') { try { return JSON.stringify(a); } catch (e) { return String(a); } }
    return String(a);
  }

  function log(level, ...args) {
    (console[level] || console.log).call(console, TAG, ...args);
    pending.push(`${new Date().toLocaleTimeString()} ${level.toUpperCase()} ${args.map(fmt).join(' ')}`);
    if (!flushTimer) flushTimer = setTimeout(flushLogs, 300);
  }

  async function flushLogs() {
    flushTimer = null;
    try {
      const { logs = [] } = await chrome.storage.local.get('logs');
      await chrome.storage.local.set({ logs: logs.concat(pending.splice(0)).slice(-100) });
    } catch (e) {
      console.warn(TAG, 'Could not save logs (extension was reloaded? refresh the TikTok tab)', e);
    }
  }

  // ---------- on-page status badge ----------
  function badge(msg) {
    let b = document.getElementById('ttu-badge');
    if (!b) {
      b = document.createElement('div');
      b.id = 'ttu-badge';
      Object.assign(b.style, {
        position: 'fixed', bottom: '16px', right: '16px', zIndex: 2147483647,
        background: '#111', color: '#fff', padding: '10px 14px', borderRadius: '10px',
        font: '13px/1.4 system-ui, sans-serif', maxWidth: '320px',
        boxShadow: '0 4px 16px rgba(0,0,0,.35)', border: '1px solid #fe2c55'
      });
      document.body.appendChild(b);
    }
    b.textContent = 'Unfollower: ' + msg;
  }

  async function setStatus(msg) {
    badge(msg);
    try { await chrome.storage.local.set({ status: { text: msg, running, at: Date.now() } }); } catch (e) {}
  }

  async function loadState() {
    const s = await chrome.storage.local.get(['settings', 'stats']);
    const settings = { ...DEFAULTS, ...(s.settings || {}) };
    let stats = s.stats || { date: today(), today: 0, total: 0 };
    if (stats.date !== today()) stats = { ...stats, date: today(), today: 0 };
    return { settings, stats };
  }

  // ---------- DOM helpers ----------
  function findCandidates(root) {
    const els = [...root.querySelectorAll(CLICKABLE)].filter((el) =>
      !el.dataset.ttuDone &&
      visible(el) &&
      !el.closest('[role="tablist"], [role="tab"], #ttu-badge') &&
      FOLLOWING_LABELS.includes(text(el))
    );
    // keep only the innermost match when a button sits inside another clickable element
    return els.filter((el) => !els.some((o) => o !== el && el.contains(o)));
  }

  function scrollableAncestor(el) {
    let p = el && el.parentElement;
    while (p && p !== document.body && p !== document.documentElement) {
      const oy = getComputedStyle(p).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && p.scrollHeight > p.clientHeight + 10) return p;
      p = p.parentElement;
    }
    return null;
  }

  function getContainer() {
    const popup = document.querySelector('[data-e2e="follow-info-popup"]');
    if (visible(popup)) return { el: popup, how: 'data-e2e follow-info-popup' };

    const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].filter(visible).reverse();
    for (const d of dialogs) {
      if (findCandidates(d).length || /following|a seguir|seguindo|siguiendo/i.test((d.innerText || '').slice(0, 400))) {
        return { el: d, how: 'dialog' };
      }
    }

    // Fallback: a scrollable list that contains "Following" buttons (only on profile pages)
    if (location.pathname.startsWith('/@')) {
      for (const c of findCandidates(document)) {
        const sc = scrollableAncestor(c);
        if (sc) return { el: sc, how: 'scrollable list fallback' };
      }
    }
    return null;
  }

  function findScroller(container, lastBtn) {
    const fromBtn = lastBtn && lastBtn.isConnected && scrollableAncestor(lastBtn);
    if (fromBtn && container.contains(fromBtn)) return fromBtn;
    let best = null;
    for (const el of container.querySelectorAll('*')) {
      const oy = getComputedStyle(el).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 20) {
        if (!best || el.scrollHeight > best.scrollHeight) best = el;
      }
    }
    return best || container;
  }

  function usernameNear(btn) {
    let p = btn;
    for (let i = 0; i < 8 && p; i++, p = p.parentElement) {
      const a = p.querySelector && p.querySelector('a[href*="/@"]');
      if (a) return decodeURIComponent(a.getAttribute('href').split('/@')[1] || '').split(/[/?]/)[0];
    }
    return '(unknown)';
  }

  async function clickConfirmIfShown() {
    const btn = [...document.querySelectorAll('button, [role="button"]')]
      .find((el) => visible(el) && CONFIRM_LABELS.includes(text(el)));
    if (btn) { log('info', 'Confirm dialog found, clicking "' + text(btn) + '"'); btn.click(); await sleep(1000); }
  }

  function limitHit() {
    const nodes = document.querySelectorAll('[role="alert"], [class*="toast" i], [class*="notice" i], [class*="tip" i]');
    for (const n of nodes) {
      const t = n.innerText || '';
      if (t.length < 200 && LIMIT_PATTERNS.some((p) => p.test(t))) { log('warn', 'Limit message seen:', t); return true; }
    }
    return false;
  }

  function diagnostics() {
    const buttons = [...document.querySelectorAll(CLICKABLE)].filter(visible);
    return {
      url: location.href,
      followingCountElement: !!document.querySelector('[data-e2e="following-count"]'),
      profileNavLink: !!profileLink(),
      followPopup: !!document.querySelector('[data-e2e="follow-info-popup"]'),
      visibleDialogs: [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')].filter(visible).length,
      followingButtonsFound: findCandidates(document).length,
      sampleButtonTexts: [...new Set(buttons.map(text).filter(Boolean))].slice(0, 25)
    };
  }

  // Reads numbers like "245", "1,234", "1.2K", "3,4 mil", "1M"
  function parseCount(t) {
    t = norm(t).replace(/\s/g, '');
    const m = t.match(/^([\d.,]+)(mil|k|m)?/i);
    if (!m) return null;
    let num = m[1];
    const suf = (m[2] || '').toLowerCase();
    const mult = suf === 'k' || suf === 'mil' ? 1e3 : suf === 'm' ? 1e6 : 1;
    num = mult > 1 ? num.replace(',', '.') : num.replace(/[.,]/g, '');
    const n = parseFloat(num);
    return isNaN(n) ? null : Math.round(n * mult);
  }

  function getFollowingCount() {
    const el = document.querySelector('[data-e2e="following-count"]');
    return el ? parseCount(el.textContent) : null;
  }

  function profileLink() {
    return document.querySelector('a[data-e2e="nav-profile"], [data-e2e="nav-profile"] a, a[data-e2e="nav-profile-link"]');
  }

  // Opens the Following list. Returns 'opened', 'navigating' or 'failed'.
  async function openFollowingList() {
    const countEl = document.querySelector('[data-e2e="following-count"]');
    if (countEl) {
      const target = countEl.parentElement || countEl;
      log('info', 'On a profile page. Clicking the "Following" counter to open the list...');
      target.click();
      await sleep(3000);
      return 'opened';
    }

    const link = profileLink();
    if (link && link.href) {
      log('info', 'Not on your profile. Going to your profile first:', link.href);
      await setStatus('Going to your profile...');
      await chrome.storage.local.set({ autostart: Date.now() });
      await flushLogs();
      location.href = link.href;
      return 'navigating';
    }

    log('error', 'Could not find the "Following" counter or your profile link.', diagnostics());
    return 'failed';
  }

  async function wait(ms, label) {
    const end = Date.now() + ms;
    while (running && Date.now() < end) {
      if (label) badge(`${label} ${Math.ceil((end - Date.now()) / 1000)}s`);
      await sleep(500);
    }
  }

  // ---------- main loop ----------
  async function run(manual = false) {
    running = true;
    stoppedByUser = false;
    let finalMsg = 'Stopped.';
    let stats = { today: 0, total: 0 };

    try {
      const state = await loadState();
      const settings = state.settings;
      stats = state.stats;
      if (manual) await chrome.storage.local.set({ reloadStreak: 0 });
      const { reloadStreak = 0 } = await chrome.storage.local.get('reloadStreak');
      log('info', 'Started with settings', settings, 'stats', stats, 'empty refreshes so far', reloadStreak);
      await setStatus('Started');

      const startCount = getFollowingCount();
      if (startCount === 0) {
        finalMsg = `All done! Following is 0 (${stats.total} unfollowed in total).`;
        log('info', finalMsg);
        running = false;
        await chrome.storage.local.set({ reloadStreak: 0 });
        await setStatus(finalMsg);
        return;
      }
      if (startCount !== null) log('info', 'Profile shows following =', startCount);

      let sinceBatch = 0, emptyScrolls = 0, failStreak = 0, openAttempts = 0, lastBtn = null, lastHow = '';
      let unfollowedThisPage = 0;

      while (running) {
        if (stats.today >= settings.dailyCap) {
          finalMsg = `Daily cap reached (${stats.today} today). Come back tomorrow.`;
          log('warn', finalMsg);
          break;
        }

        const ctx = getContainer();
        if (!ctx) {
          if (openAttempts >= 2) {
            finalMsg = 'Could not open the Following list. Check the log in the popup.';
            log('error', finalMsg, diagnostics());
            break;
          }
          openAttempts++;
          const r = await openFollowingList();
          if (r === 'navigating') return; // page reloads, run continues after load
          if (r === 'failed') { finalMsg = 'Open your TikTok profile, then press Start.'; break; }
          continue;
        }
        if (ctx.how !== lastHow) { log('info', 'Following list found via:', ctx.how); lastHow = ctx.how; }

        const btn = findCandidates(ctx.el)[0];

        if (!btn) {
          const scroller = findScroller(ctx.el, lastBtn);
          log('debug', 'No "Following" buttons visible, scrolling list to load more...');
          scroller.scrollTop = scroller.scrollHeight;
          await sleep(2500);
          if (findCandidates(ctx.el).length === 0) {
            emptyScrolls++;
            if (emptyScrolls >= 4) {
              const count = getFollowingCount();
              log('info', `No more "Following" buttons in this list. Profile shows following = ${count === null ? 'unknown' : count}`);

              if (count === 0) {
                finalMsg = `All done! Following is 0 (${stats.total} unfollowed in total).`;
                log('info', finalMsg);
                await chrome.storage.local.set({ reloadStreak: 0 });
                break;
              }

              const streak = unfollowedThisPage > 0 ? 0 : reloadStreak + 1;
              if (streak > MAX_EMPTY_RELOADS) {
                finalMsg = `Refreshed ${MAX_EMPTY_RELOADS} times without finding anyone to unfollow. Stopped. Following shows: ${count === null ? 'unknown' : count}.`;
                log('error', finalMsg, diagnostics());
                await chrome.storage.local.set({ reloadStreak: 0 });
                break;
              }

              log('info', `Refreshing the page in ${RELOAD_WAIT_SEC}s to load more (empty refreshes in a row: ${streak}/${MAX_EMPTY_RELOADS})`);
              await wait(RELOAD_WAIT_SEC * 1000, 'List finished, refreshing page in');
              if (!running) break;
              await chrome.storage.local.set({ reloadStreak: streak, autostart: Date.now() });
              await flushLogs();
              location.reload();
              return; // continues automatically after the page loads
            }
          } else {
            emptyScrolls = 0;
          }
          continue;
        }

        emptyScrolls = 0;
        lastBtn = btn;
        const user = usernameNear(btn);
        btn.scrollIntoView({ block: 'center' });
        await sleep(rand(400, 900));
        log('info', `Clicking "${text(btn)}" for @${user}`);
        btn.click();
        btn.dataset.ttuDone = '1';
        await sleep(1300);
        await clickConfirmIfShown();
        await sleep(700);

        if (limitHit()) {
          finalMsg = 'TikTok asked to slow down. Stopped. Try again in a few hours.';
          break;
        }

        const after = btn.isConnected ? text(btn) : '(button re-rendered)';
        const ok = !btn.isConnected || FOLLOW_LABELS.includes(after);
        if (ok) {
          failStreak = 0;
          stats.today++; stats.total++; sinceBatch++; unfollowedThisPage++;
          await chrome.storage.local.set({ stats });
          log('info', `Unfollowed @${user} (button now: ${after}). Today ${stats.today}, total ${stats.total}`);
          await setStatus(`Unfollowed ${stats.today} today (${stats.total} total)`);
        } else {
          failStreak++;
          log('warn', `Unfollow of @${user} did not stick, button still says "${after}" (${failStreak}/3)`);
          if (failStreak >= 3) {
            finalMsg = 'Unfollows are not going through (probably a TikTok limit). Stopped. Try later.';
            log('error', finalMsg);
            break;
          }
        }

        if (sinceBatch >= settings.batchSize) {
          sinceBatch = 0;
          log('info', `Batch done, resting ${settings.batchPause}s`);
          await wait(settings.batchPause * 1000, 'Batch done, resting');
        } else {
          await wait(rand(settings.minDelay * 1000, settings.maxDelay * 1000), `${stats.today} today, next in`);
        }
      }
    } catch (e) {
      finalMsg = 'Crashed: ' + e.message + ' (see log)';
      log('error', 'Crash:', e.message, e.stack);
    }

    running = false;
    const msg = stoppedByUser ? `Stopped by you. ${stats.today} today, ${stats.total} total.` : finalMsg;
    log('info', 'Finished:', msg);
    await setStatus(msg);
  }

  // ---------- messages from popup ----------
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    if (msg.cmd === 'ping') {
      reply({ alive: true, running });
    } else if (msg.cmd === 'start') {
      if (running) { log('info', 'Already running'); }
      else run(true);
      reply({ ok: true });
    } else if (msg.cmd === 'stop') {
      stoppedByUser = true;
      running = false;
      log('info', 'Stop requested');
      reply({ ok: true });
    } else if (msg.cmd === 'diagnose') {
      const d = diagnostics();
      log('info', 'Diagnose:', d);
      reply(d);
    }
    return true;
  });

  // ---------- continue after navigating to the profile ----------
  chrome.storage.local.get('autostart').then(({ autostart }) => {
    if (autostart && Date.now() - autostart < 60000) {
      chrome.storage.local.remove('autostart');
      log('info', 'Arrived on profile, continuing in 4s...');
      setTimeout(() => { if (!running) run(); }, 4000);
    }
  });

  log('info', 'Content script loaded on', location.href);
})();
