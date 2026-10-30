'use strict';

(() => {
  const api = window.autoPresence;
  const $ = (selector) => document.querySelector(selector);
  let language = 'en';
  const dictionary = window.autoPresenceTranslations || {};
  const t = (value) => language === 'ko' && typeof value === 'string' ? (dictionary[value] || value) : value;
  const translatedNodes = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) { const node = walker.currentNode; const value = node.nodeValue; const trimmed = value.trim(); if (dictionary[trimmed]) translatedNodes.push({node, value, trimmed}); }
  function setLanguage(value) {
    language = value === 'ko' ? 'ko' : 'en';
    document.documentElement.lang = language;
    $('#onboarding').querySelector('[role=region]').setAttribute('aria-label', language === 'ko' ? 'AutoPresence 시작 설정' : 'AutoPresence setup');
    for (const entry of translatedNodes) entry.node.nodeValue = entry.value.replace(entry.trimmed, t(entry.trimmed));
    for (const node of document.querySelectorAll('[placeholder]')) {
      if (!node.dataset.originalPlaceholder) node.dataset.originalPlaceholder = node.getAttribute('placeholder');
      node.setAttribute('placeholder', t(node.dataset.originalPlaceholder));
    }
  }
  const activitySelectors = new Set(['#activity-name', '#activity-details', '#preview-name', '#preview-details', '#preview-state']);
  const text = (selector, value) => { $(selector).textContent = activitySelectors.has(selector) ? value : t(value); };
  const clone = (value) => JSON.parse(JSON.stringify(value));
  const defaults = { autoStart: false, minimizeToTray: true, discordReconnect: true, discordClientId: '', idleEnabled: false, detectionIntervalMs: 2000, theme: 'system', language: 'en', onboardingComplete: false, excludedApps: [], excludedDomains: [], detailedDomains: [], disabledAdapters: [], rules: [] };
  let settings = clone(defaults);
  let state = {};
  let editingRuleId = null;
  let noticeTimer;
  let initialized = false;
  let onboardingStep = 'language';
  const names = { dashboard: 'Dashboard', applications: 'Applications', websites: 'Websites', rules: 'Activity rules', settings: 'Settings', diagnostics: 'Diagnostics' };
  const adapters = ['github', 'figma', 'notion', 'youtube', 'google-docs'];

  function notice(message, isError = false) {
    const node = $('#notice');
    node.textContent = t(message);
    node.classList.toggle('error', isError);
    node.hidden = false;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => { node.hidden = true; }, 5000);
  }
  function errorMessage(err) { return t(err && typeof err.message === 'string' ? err.message : 'The operation could not be completed.'); }
  function normalizeSettings(value) {
    const next = { ...defaults, ...(value && typeof value === 'object' ? value : {}) };
    for (const field of ['excludedApps', 'excludedDomains', 'detailedDomains', 'disabledAdapters', 'rules']) if (!Array.isArray(next[field])) next[field] = [];
    return next;
  }
  async function save(next, silent = false) {
    if (!api || typeof api.saveSettings !== 'function') throw new Error('Settings service is unavailable.');
    const result = await api.saveSettings(clone(next));
    if (result === false || (result && result.ok === false)) throw new Error(result && result.error || 'Settings were not saved.');
    settings = normalizeSettings(result && result.settings ? result.settings : next);
    setLanguage(settings.language);
    renderSettings();
    renderLists();
    renderStatus();
    text('#rule-editor-title', editingRuleId === null ? 'New rule' : 'Edit rule');
    const activePage = document.querySelector('.nav.active');
    if (activePage) text('#page-title', names[activePage.dataset.page]);
    renderOnboarding();
    if (!silent) notice('Settings saved.');
  }
  function present(value, connected, disconnected) { return t(value === true ? connected : value === false ? disconnected : 'Not verified'); }
  // Accept only bounded PNG data URLs with a valid signature and IHDR dimensions.
  // Never load local paths, remote URLs, SVG, or arbitrary data in an image element.
  function isPngIcon(value) {
    if (typeof value !== 'string' || value.length > 350000) return false;
    const prefix = 'data:image/png;base64,';
    if (!value.startsWith(prefix)) return false;
    const data = value.slice(prefix.length);
    if (data.length < 32 || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) return false;
    try {
      const head = atob(data.slice(0, 32));
      const bytes = Array.from(head, c => c.charCodeAt(0));
      if (![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)) return false;
      if (bytes[8] !== 0 || bytes[9] !== 0 || bytes[10] !== 0 || bytes[11] !== 13 ||
          bytes[12] !== 73 || bytes[13] !== 72 || bytes[14] !== 68 || bytes[15] !== 82) return false;
      const integer = (offset) => ((bytes[offset] * 0x1000000) + (bytes[offset + 1] << 16) + (bytes[offset + 2] << 8) + bytes[offset + 3]);
      const width = integer(16), height = integer(20);
      return width > 0 && width <= 512 && height > 0 && height <= 512;
    } catch { return false; }
  }
  function iconImage(value, className) {
    if (!isPngIcon(value)) return null;
    const image = document.createElement('img');
    image.className = className;
    image.alt = '';
    image.setAttribute('aria-hidden', 'true');
    image.src = value;
    return image;
  }
  function renderPreviewIcon(activity) {
    const container = $('#preview-icon');
    const image = activity && iconImage(state.activityIcon, 'preview-app-icon');
    container.replaceChildren();
    if (image) {
      image.addEventListener('error', () => { if (image.parentNode === container) container.textContent = '◫'; }, { once: true });
      container.append(image);
    } else container.textContent = '◫';
  }
  function renderStatus() {
    const paused = state.paused === true;
    const pill = $('#status-pill');
    pill.textContent = t(paused ? 'Paused' : state.paused === false ? 'Detection active' : 'Status unknown');
    pill.classList.toggle('paused', paused);
    $('#pause-button').textContent = t(paused ? 'Resume detection' : 'Pause detection');
    $('#pause-button').disabled = !api || typeof api.pause !== 'function' || typeof state.paused !== 'boolean';
    $('#quit-button').disabled = !api || typeof api.quit !== 'function';
    const activity = state.activity && typeof state.activity === 'object' ? state.activity : null;
    renderPreviewIcon(activity);
    const application = activity && typeof activity.application === 'string' ? activity.application : t('Waiting for activity');
    const details = activity && typeof activity.details === 'string' ? activity.details : t('No activity is currently available.');
    text('#activity-name', application);
    text('#activity-details', details);
    text('#activity-confidence', activity ? (activity.confidence === 'confirmed' ? 'Observed activity' : 'General activity') : 'Nothing shared yet');
    text('#preview-name', activity ? application : t('Discord application'));
    text('#preview-details', activity ? details : t('Your activity will appear here.'));
    text('#preview-image', activity && activity.imageKey ? `${t('Image asset key')}: ${activity.imageKey}` : 'No image asset key');
    text('#preview-state', activity && typeof activity.state === 'string' ? activity.state : '');
    text('#discord-status', present(state.discordConnected, 'Connected', 'Disconnected'));
    text('#discord-indicator', present(state.discordConnected, 'Ready', 'Not connected'));
    const browserDisabled = state.browserDisabled === true;
    text('#browser-status', browserDisabled ? 'Disabled' : present(state.browserConnected, 'Connected', 'Disconnected'));
    text('#browser-indicator', browserDisabled ? 'Disabled' : present(state.browserConnected, 'Ready', 'Not connected'));
    const websiteNav = document.querySelector('.nav[data-page=websites]');
    websiteNav.hidden = browserDisabled;
    $('#rule-domain').disabled = browserDisabled;
    $('#rule-path').disabled = browserDisabled;
    if (browserDisabled && websiteNav.classList.contains('active')) document.querySelector('.nav[data-page=dashboard]').click();
    renderEvents();
    renderDiagnostics();
    renderApps();
  }
  function renderEvents() {
    const list = $('#event-list'); list.replaceChildren();
    // Only fixed, local status labels are shown. Raw logs can contain sensitive data.
    const labels = [];
    if (typeof state.paused === 'boolean') labels.push(state.paused ? 'Detection paused' : 'Detection active');
    if (typeof state.discordConnected === 'boolean') labels.push(state.discordConnected ? 'Discord connected' : 'Discord disconnected');
    if (state.browserDisabled === true) labels.push('Browser detection disabled');
    else if (typeof state.browserConnected === 'boolean') labels.push(state.browserConnected ? 'Browser extension connected' : 'Browser extension disconnected');
    if (!labels.length) labels.push('No events yet.');
    for (const label of labels) { const li = document.createElement('li'); li.textContent = t(label); if (label === 'No events yet.') li.className = 'empty'; list.append(li); }
  }
  function renderDiagnostics() {
    const list = $('#diagnostic-list'); list.replaceChildren();
    const diagnostic = state.diagnostics && typeof state.diagnostics === 'object' ? state.diagnostics : {};
    const entries = [ ['Detection', present(state.paused, 'Paused', 'Active')], ['Discord connection', present(state.discordConnected, 'Connected', 'Disconnected')], ['Browser connection', state.browserDisabled === true ? t('Disabled') : present(state.browserConnected, 'Connected', 'Disconnected')], ['Engine', present(diagnostic.engineReady, 'Ready', 'Unavailable')], ['Windows detection', present(diagnostic.windowsAvailable, 'Available', 'Unavailable')] ];
    for (const [label, value] of entries) { const dt = document.createElement('dt'); const dd = document.createElement('dd'); dt.textContent = t(label); dd.textContent = value; list.append(dt, dd); }
  }
  function renderApps() {
    const list = $('#apps-list'); list.replaceChildren();
    const apps = Array.isArray(state.runningApps) ? state.runningApps :
      (Array.isArray(state.detectedApps) ? state.detectedApps.map(name => ({ name, icon: null })) : []);
    // The main process supplies names and local PNG data only; never display paths.
    const safeApps = apps.filter((app) => app && typeof app.name === 'string' && app.name.length > 0 && app.name.length <= 255 && !/[\\/]/.test(app.name)).slice(0, 100);
    if (!safeApps.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = t('No running applications detected.'); list.append(li); }
    for (const app of safeApps) {
      const li = document.createElement('li'); li.className = 'running-app';
      const image = iconImage(app.icon, 'running-app-icon');
      if (image) { image.addEventListener('error', () => image.remove(), { once: true }); li.append(image); }
      const name = document.createElement('span'); name.textContent = app.name; li.append(name); list.append(li);
    }
  }
  function renderTagList(selector, field) {
    const list = $(selector); list.replaceChildren();
    if (!settings[field].length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = t('None'); list.append(li); return; }
    settings[field].forEach((value, index) => {
      if (typeof value !== 'string') return;
      const li = document.createElement('li'); const name = document.createElement('span'); name.textContent = value;
      const button = document.createElement('button'); button.type = 'button'; button.textContent = t('Remove'); button.setAttribute('aria-label', `${t('Remove')} ${value}`);
      button.addEventListener('click', async () => { const next = clone(settings); next[field].splice(index, 1); try { await save(next); } catch (err) { notice(errorMessage(err), true); } });
      li.append(name, button); list.append(li);
    });
  }
  function renderAdapters() {
    const container = $('#adapter-list'); container.replaceChildren();
    for (const id of adapters) {
      const label = document.createElement('label'); const box = document.createElement('input'); box.type = 'checkbox'; box.checked = !settings.disabledAdapters.includes(id); const name = document.createElement('span'); name.textContent = id;
      box.addEventListener('change', async () => { const next = clone(settings); next.disabledAdapters = next.disabledAdapters.filter((item) => item !== id); if (!box.checked) next.disabledAdapters.push(id); try { await save(next); } catch (err) { box.checked = !box.checked; notice(errorMessage(err), true); } });
      label.append(box, name); container.append(label);
    }
  }
  function renderRules() {
    const list = $('#rules-list'); list.replaceChildren();
    if (!settings.rules.length) { const li = document.createElement('li'); li.className = 'empty'; li.textContent = t('No rules yet.'); list.append(li); return; }
    settings.rules.forEach((rule, index) => {
      if (!rule || typeof rule !== 'object') return;
      const li = document.createElement('li'); const description = document.createElement('div'); const title = document.createElement('strong'); title.textContent = String(rule.id || t('Unnamed rule')); const detail = document.createElement('small'); detail.textContent = `${rule.enabled === false ? t('Disabled · ') : ''}${rule.presence && rule.presence.details || t('No details')}`; description.append(title, detail);
      const actions = document.createElement('div'); actions.className = 'rule-actions';
      for (const [label, action] of [['Edit', 'edit'], ['↑', 'up'], ['↓', 'down'], ['Delete', 'delete']]) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = t(label); button.setAttribute('aria-label', `${t(label)} ${rule.id || t('rule')}`); if ((action === 'up' && index === 0) || (action === 'down' && index === settings.rules.length - 1)) button.disabled = true;
        button.addEventListener('click', async () => {
          if (action === 'edit') { editRule(rule); return; }
          const next = clone(settings);
          if (action === 'delete') next.rules.splice(index, 1);
          else { const other = action === 'up' ? index - 1 : index + 1; [next.rules[index], next.rules[other]] = [next.rules[other], next.rules[index]]; }
          try { await save(next); } catch (err) { notice(errorMessage(err), true); }
        }); actions.append(button);
      }
      li.append(description, actions); list.append(li);
    });
  }
  function renderLists() { renderTagList('#excluded-apps', 'excludedApps'); renderTagList('#excluded-domains', 'excludedDomains'); renderTagList('#detailed-domains', 'detailedDomains'); renderAdapters(); renderRules(); }
  function renderSettings() {
    const form = $('#settings-form');
    for (const key of ['autoStart', 'minimizeToTray', 'discordReconnect', 'idleEnabled']) form.elements[key].checked = settings[key] === true;
    form.elements.discordClientId.value = typeof settings.discordClientId === 'string' ? settings.discordClientId : '';
    form.elements.detectionIntervalMs.value = settings.detectionIntervalMs;
    form.elements.language.value = settings.language === 'ko' ? 'ko' : 'en';
    form.elements.theme.value = ['system', 'light', 'dark'].includes(settings.theme) ? settings.theme : 'system';
    if (settings.theme === 'light' || settings.theme === 'dark') document.documentElement.dataset.theme = settings.theme; else delete document.documentElement.dataset.theme;
  }
  function validDomain(value) { return value.length <= 253 && value.includes('.') && value.split('.').every((part) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)); }
  function bindListForm(formId, inputId, field, domain) {
    $(formId).addEventListener('submit', async (event) => {
      event.preventDefault(); const input = $(inputId); const value = input.value.trim().toLowerCase();
      if (!value || (domain && !validDomain(value)) || (!domain && (/[\\/]/.test(value) || value.length > 255))) { notice(domain ? 'Enter a valid domain without a URL or path.' : 'Enter an executable name without a path.', true); return; }
      if (settings[field].includes(value)) { notice('This entry already exists.'); return; }
      const next = clone(settings); next[field].push(value);
      try { await save(next); input.value = ''; } catch (err) { notice(errorMessage(err), true); }
    });
  }
  function resetRule() { editingRuleId = null; $('#rule-form').reset(); $('#rule-enabled').checked = true; text('#rule-editor-title', 'New rule'); $('#rule-cancel').hidden = true; text('#rule-result', ''); }
  function editRule(rule) {
    $('#rule-image-key').value = rule.presence && rule.presence.imageKey || '';
    $('#rule-display-name').value = rule.presence && rule.presence.application || '';
    editingRuleId = rule.id; $('#rule-id').value = rule.id || ''; $('#rule-executable').value = rule.match && rule.match.executableName || ''; $('#rule-domain').value = rule.match && rule.match.domain || ''; $('#rule-path').value = rule.match && rule.match.pathPattern || ''; $('#rule-details').value = rule.presence && rule.presence.details || ''; $('#rule-state').value = rule.presence && rule.presence.state || ''; $('#rule-enabled').checked = rule.enabled !== false; text('#rule-editor-title', 'Edit rule'); $('#rule-cancel').hidden = false; text('#rule-result', ''); $('#rule-id').focus();
  }
  function validImageKeyOrUrl(value) {
    if (!value || value.length > 512 || /[\x00-\x20\x7f-\x9f\\]/.test(value)) return false;
    if (/^[a-zA-Z0-9_-]{1,64}$/.test(value)) return true;
    if (/[?#]/.test(value) || /^https:\/\/[^/]*@/i.test(value)) return false;
    try {
      const parsed = new URL(value), host = parsed.hostname.toLowerCase();
      if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port ||
          host.startsWith('[') || host.endsWith('.') || !host.includes('.') ||
          /(?:^|\.)(?:localhost|local|internal|invalid|test)$/.test(host)) return false;
      if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
      return true;
    } catch { return false; }
  }
  function ruleFromForm() {
    const id = $('#rule-id').value.trim(); const executableName = $('#rule-executable').value.trim(); const domain = $('#rule-domain').value.trim().toLowerCase(); const pathPattern = $('#rule-path').value.trim(); const details = $('#rule-details').value.trim(); const presenceState = $('#rule-state').value.trim(); const imageKey = $('#rule-image-key').value.trim(); const displayName = $('#rule-display-name').value.trim();
    if (!/^[a-zA-Z0-9_-]{1,80}$/.test(id)) throw new Error(t('Rule ID may contain only letters, numbers, underscores and hyphens.'));
    if (!executableName && !domain && !pathPattern) throw new Error(t('Add at least one matching condition.'));
    if (domain && !validDomain(domain)) throw new Error(t('Enter a valid domain.'));
    if (pathPattern && (!domain || !pathPattern.startsWith('/') || /[?#]/.test(pathPattern) || pathPattern.length > 256)) throw new Error(t('A path pattern requires a domain, must start with / and cannot contain a query or fragment.'));
    if (!details || details.length > 128 || presenceState.length > 128 || displayName.length > 128) throw new Error(t('Details are required and presence text must be at most 128 characters.'));
    if (imageKey && !validImageKeyOrUrl(imageKey)) throw new Error(t('Enter an asset key or a public HTTPS image URL without credentials, query or fragment.'));
    const previous = editingRuleId === null ? null : settings.rules.find((item) => item && item.id === editingRuleId);
    // Preserve fields from rules authored outside this editor.
    const match = { ...(previous && previous.match || {}) }; delete match.executableName; delete match.domain; delete match.pathPattern;
    if (executableName) match.executableName = executableName; if (domain) match.domain = domain; if (pathPattern) match.pathPattern = pathPattern;
    const presence = { ...(previous && previous.presence || {}), details }; delete presence.state; if (presenceState) presence.state = presenceState; delete presence.imageKey; if (imageKey) presence.imageKey = imageKey; delete presence.application; if (displayName) presence.application = displayName;
    return { ...(previous || {}), id, enabled: $('#rule-enabled').checked, match, presence };
  }
  for (const button of document.querySelectorAll('.nav')) button.addEventListener('click', () => {
    const page = button.dataset.page; for (const node of document.querySelectorAll('.page')) node.hidden = node.id !== page;
    for (const nav of document.querySelectorAll('.nav')) { const active = nav === button; nav.classList.toggle('active', active); if (active) nav.setAttribute('aria-current', 'page'); else nav.removeAttribute('aria-current'); }
    text('#page-title', names[page]);
  });
  bindListForm('#app-form', '#app-input', 'excludedApps', false);
  bindListForm('#domain-form', '#domain-input', 'excludedDomains', true);
  bindListForm('#detail-form', '#detail-input', 'detailedDomains', true);
  $('#settings-form').addEventListener('submit', async (event) => {
    event.preventDefault(); const form = event.currentTarget; const interval = Number(form.elements.detectionIntervalMs.value);
    if (!Number.isInteger(interval) || interval < 500 || interval > 10000) { notice('Choose a detection interval between 500 and 10000 ms.', true); return; }
    const next = clone(settings); for (const key of ['autoStart', 'minimizeToTray', 'discordReconnect', 'idleEnabled']) next[key] = form.elements[key].checked;
    const clientId = form.elements.discordClientId.value.trim();
    if (clientId && !/^[0-9]{15,20}$/.test(clientId)) { notice('Discord Application ID must contain 15–20 digits.', true); return; }
    next.discordClientId = clientId; next.detectionIntervalMs = interval; next.theme = form.elements.theme.value; next.language = form.elements.language.value;
    try { await save(next); } catch (err) { notice(errorMessage(err), true); }
  });
  $('#rule-form').addEventListener('submit', async (event) => {
    event.preventDefault(); try {
      const rule = ruleFromForm(); const next = clone(settings); const index = next.rules.findIndex((item) => item && item.id === editingRuleId);
      if (next.rules.some((item, i) => item && item.id === rule.id && i !== index)) throw new Error(t('A rule with this ID already exists.'));
      if (index < 0) next.rules.push(rule); else next.rules[index] = rule;
      await save(next); resetRule();
    } catch (err) { notice(errorMessage(err), true); }
  });
  $('#rule-test').addEventListener('click', async () => { try { const rule = ruleFromForm(); if (!api || typeof api.testRule !== 'function') throw new Error(t('Rule testing is unavailable.')); const result = await api.testRule(rule); text('#rule-result', typeof result === 'string' ? result : result && typeof result.message === 'string' ? result.message : result && result.matches === true ? 'Rule matches the current activity.' : result && result.matches === false ? 'Rule does not match the current activity.' : 'Rule test returned no result.'); } catch (err) { text('#rule-result', errorMessage(err)); } });
  $('#rule-cancel').addEventListener('click', resetRule);
  $('#pause-button').addEventListener('click', async () => { try { const result = await api.pause(!state.paused); if (result === false || result && result.ok === false) throw new Error(t('Could not change detection state.')); } catch (err) { notice(errorMessage(err), true); } });
  $('#quit-button').addEventListener('click', async () => { try { await api.quit(); } catch (err) { notice(errorMessage(err), true); } });
  function renderOnboarding() {
    const active = initialized && settings.onboardingComplete !== true;
    $('#onboarding').hidden = !active;
    $('.shell').hidden = active || !initialized;
    $('#language-step').hidden = onboardingStep !== 'language';
    $('#discord-step').hidden = onboardingStep !== 'discord';
    const discordStatus = state.discordStatus || (state.discordConnected ? 'connected' : 'stopped');
    let message = 'Not configured. Enter an Application ID to connect.';
    if (settings.discordClientId && discordStatus === 'stopped') message = 'Not connected';
    if (discordStatus === 'connecting') message = 'Connecting to Discord…';
    else if (discordStatus === 'connected') message = 'Connected to Discord';
    else if (settings.discordClientId && discordStatus === 'disconnected') message = 'Connection unavailable. Check that Discord is running and the Application ID is correct.';
    text('#onboarding-discord-status', message);
    $('#onboarding-finish').disabled = discordStatus !== 'connected';
  }
  function onboardingError(message) {
    const node = $('#onboarding-error'); node.textContent = t(message); node.hidden = !message;
  }
  async function finishOnboarding() {
    try { const next = clone(settings); next.onboardingComplete = true; await save(next, true); renderOnboarding(); $('.nav.active').focus(); }
    catch (err) { onboardingError(errorMessage(err)); }
  }
  $('#onboarding-language').addEventListener('change', (event) => { setLanguage(event.currentTarget.value); });
  $('#onboarding-next').addEventListener('click', async () => {
    try {
      $('#onboarding-language-error').hidden = true;
      const next = clone(settings); next.language = $('#onboarding-language').value === 'ko' ? 'ko' : 'en';
      await save(next, true); onboardingStep = 'discord'; $('#onboarding-discord-id').value = settings.discordClientId || '';
      onboardingError(''); renderOnboarding(); $('#onboarding-discord-id').focus();
    } catch (err) { const node = $('#onboarding-language-error'); node.textContent = errorMessage(err); node.hidden = false; }
  });
  $('#onboarding-back').addEventListener('click', () => { onboardingStep = 'language'; renderOnboarding(); $('#onboarding-language').focus(); });
  $('#onboarding-connect').addEventListener('click', async () => {
    const id = $('#onboarding-discord-id').value.trim();
    if (!/^[0-9]{15,20}$/.test(id)) { onboardingError('Enter a valid 15–20 digit Discord Application ID.'); return; }
    try { onboardingError(''); const next = clone(settings); next.discordClientId = id; await save(next, true); }
    catch (err) { onboardingError(errorMessage(err)); }
  });
  $('#onboarding-finish').addEventListener('click', finishOnboarding);
  $('#onboarding-skip').addEventListener('click', finishOnboarding);
  function applyState(next) { if (!next || typeof next !== 'object') return; const firstState = !initialized; state = next; initialized = true; if (next.settings && typeof next.settings === 'object') { const incoming = normalizeSettings(next.settings); if (JSON.stringify(incoming) !== JSON.stringify(settings)) { settings = incoming; setLanguage(settings.language); renderSettings(); renderLists(); } } if (firstState) $('#onboarding-language').value = settings.language; renderStatus(); renderOnboarding(); }
  setLanguage(settings.language); renderSettings(); renderLists(); renderStatus(); renderOnboarding();
  if (api && typeof api.onState === 'function') api.onState(applyState);
  if (api && typeof api.getState === 'function') Promise.resolve(api.getState()).then(applyState).catch((err) => { initialized = true; settings.onboardingComplete = true; renderOnboarding(); notice(errorMessage(err), true); });
  else { initialized = true; settings.onboardingComplete = true; renderOnboarding(); notice('The application service is unavailable.', true); }
})();
