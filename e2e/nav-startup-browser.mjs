/**
 * nav-startup-browser.js — Browser startup stub for nav-ai.
 *
 * Creates a NHBrowserEnv and starts navigation.
 * Injected by Playwright after nav-ai.js loads.
 *
 * Expects: window.startNavigation, window.NHBrowserEnv, stat-dlvl in DOM
 */

(function() {
  'use strict';

  var EnvClass = window.NHBrowserEnv;
  if (!EnvClass) {
    console.error('[NAV-STARTUP] NHBrowserEnv not found');
    return;
  }

  var env = new EnvClass();
  var startDlvl = env.getDlvl();

  console.log('[NAV-STARTUP] Starting navigation, dlvl=' + startDlvl);

  window.startNavigation(startDlvl, function(reason) {
    console.log('[NAV] Navigation ended:', reason);
  }, env);
})();
