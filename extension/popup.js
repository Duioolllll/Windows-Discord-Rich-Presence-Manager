'use strict';
const api = globalThis.browser || globalThis.chrome;
(async () => {
  const saved = await api.storage.local.get('detailDomains');
  const enabled = new Set(Array.isArray(saved.detailDomains) ? saved.detailDomains : []);
  for (const box of document.querySelectorAll('input[type=checkbox]')) {
    box.checked = enabled.has(box.value);
    box.addEventListener('change', async () => {
      if (box.checked && box.value === 'youtube.com') {
        try {
          if (!await api.permissions.request({ origins: ['https://*.youtube.com/*'] })) { box.checked = false; return; }
        } catch { box.checked = false; return; }
      }
      if (box.checked) enabled.add(box.value); else enabled.delete(box.value);
      await api.storage.local.set({ detailDomains: [...enabled] });
      if (!box.checked && box.value === 'youtube.com') {
        try { await api.permissions.remove({ origins: ['https://*.youtube.com/*'] }); } catch { /* no permission */ }
      }
      document.getElementById('status').textContent = 'Privacy settings saved.';
    });
  }
})().catch(() => { document.getElementById('status').textContent = 'Settings could not be loaded.'; });
