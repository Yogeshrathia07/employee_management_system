// Older pages still load this entry point. The server renders the role menu.
(function() {
  function refreshNavigation() {
    if (typeof initSidebarNavigation === 'function') initSidebarNavigation();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refreshNavigation, { once: true });
  else refreshNavigation();
})();
