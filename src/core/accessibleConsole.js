/**
 * Accessible Console — src/core/accessibleConsole.js
 *
 * Portable, self-initializing crash catcher.
 *
 * Drop this script into any project with a standard <script src="…"> tag.
 * No dependencies, no module system, no framework assumptions.
 *
 * What it does:
 *   1. Attaches window.onerror and window.addEventListener('unhandledrejection')
 *      immediately — before DOMContentLoaded — so errors during page load are
 *      captured into a pending queue.
 *   2. On DOMContentLoaded (or immediately if the DOM is already ready),
 *      prepends a fixed-position Error Log panel to document.body.
 *   3. Flushes any queued pre-DOM errors into the panel's read-only textarea.
 *   4. Each subsequent error appends a formatted entry to the textarea and
 *      triggers an aria-live="assertive" announcement so screen readers
 *      interrupt the current utterance and read "New error logged."
 *
 * Panel elements created (all inside a single container div):
 *   <div role="region" aria-label="Error Log" id="accessible-error-container">
 *     <textarea id="accessible-error-log" readonly …>   ← copyable log
 *     <div aria-live="assertive" …>                      ← screen-reader alert
 *     <p id="accessible-error-log-label">               ← visible heading
 *     <p id="accessible-error-log-desc">                ← visually-hidden description
 *   </div>
 *
 * The textarea uses .value += (a DOM property, not innerHTML) so no injection
 * risk from error message content (which originates from the browser itself).
 *
 * Toggle visibility:
 *   accessibleConsole.show() / .hide() / .toggle() are exposed on the
 *   returned object from the IIFE for programmatic control from the DevTools
 *   console. The panel is visible by default so errors are never missed.
 */

/* global window, document, requestAnimationFrame */

var accessibleConsole = (function () {
  'use strict';

  // -------------------------------------------------------------------------
  // Internal state
  // -------------------------------------------------------------------------

  /** Errors captured before the DOM was ready. @type {string[]} */
  var _pending = [];

  /** The read-only <textarea> element. Null until _init() runs. @type {HTMLTextAreaElement|null} */
  var _textarea = null;

  /** The aria-live element. Null until _init() runs. @type {HTMLElement|null} */
  var _ariaAnnouncer = null;

  /** The outer container element. Null until _init() runs. @type {HTMLElement|null} */
  var _container = null;

  // -------------------------------------------------------------------------
  // Formatting
  // -------------------------------------------------------------------------

  /**
   * Format a window.onerror payload into a human-readable log entry.
   *
   * The source URL has the page origin stripped so the path is short enough
   * to read in a 150 px textarea without horizontal scrolling.
   *
   * @param {string|Event}  message  - error description (or Event for some browsers)
   * @param {string}        source   - script URL
   * @param {number}        lineno   - line number
   * @param {number}        colno    - column number
   * @param {Error|null}    error    - original Error object (may be null in old browsers)
   * @returns {string}
   */
  function _formatError(message, source, lineno, colno, error) {
    // message can be an Event in some legacy browsers — coerce to string safely.
    var msg  = (message && typeof message === 'object' && message.type)
               ? '[' + message.type + ' event]'
               : String(message || 'Unknown error');
    var file = source
               ? String(source).replace(window.location.origin, '')
               : '(unknown source)';
    var loc  = 'Line ' + (lineno || '?') + ', Col ' + (colno || '?');

    var lines = ['[ERROR] ' + msg, '  at ' + file + ' ' + loc];

    // Include the first stack frame if the Error object is available and the
    // stack adds information beyond the message (avoids duplicate output).
    if (error && error.stack) {
      var stack = String(error.stack)
        .split('\n')
        .slice(0, 6)               // cap at 6 lines to keep the log readable
        .map(function (l) { return '  ' + l.trim(); })
        .join('\n');
      lines.push(stack);
    }

    return lines.join('\n');
  }

  /**
   * Format an unhandledrejection event into a human-readable log entry.
   *
   * @param {*} reason - the rejection reason (may be an Error or any value)
   * @returns {string}
   */
  function _formatRejection(reason) {
    if (reason instanceof Error) {
      var stack = reason.stack
        ? '\n' + reason.stack
            .split('\n')
            .slice(0, 6)
            .map(function (l) { return '  ' + l.trim(); })
            .join('\n')
        : '';
      return '[UNHANDLED REJECTION] ' + reason.message + stack;
    }
    return '[UNHANDLED REJECTION] ' + String(reason);
  }

  /**
   * Prepend a UTC timestamp string (HH:MM:SS) for disambiguation when
   * multiple errors occur within the same page session.
   *
   * @returns {string}
   */
  function _timestamp() {
    var d = new Date();
    var h = String(d.getUTCHours()).padStart(2, '0');
    var m = String(d.getUTCMinutes()).padStart(2, '0');
    var s = String(d.getUTCSeconds()).padStart(2, '0');
    return h + ':' + m + ':' + s + ' UTC';
  }

  // -------------------------------------------------------------------------
  // Core log writer
  // -------------------------------------------------------------------------

  /**
   * Append a formatted entry to the textarea (or queue it if the DOM is not
   * yet ready) and trigger the aria-live announcement.
   *
   * @param {string} text - pre-formatted log entry
   */
  function _log(text) {
    var entry = '── ' + _timestamp() + ' ──\n' + text + '\n';

    if (_textarea) {
      _textarea.value += entry + '\n';
      // Scroll to bottom so the latest entry is always visible.
      _textarea.scrollTop = _textarea.scrollHeight;
    } else {
      _pending.push(entry);
    }

    _triggerAriaAnnouncement();
  }

  /**
   * Trigger the aria-live="assertive" announcement.
   *
   * Screen readers only fire a live-region update when the text *changes*.
   * We blank it first, then set it on the next animation frame to guarantee
   * a fresh mutation even if the previous announcement was identical.
   */
  function _triggerAriaAnnouncement() {
    if (!_ariaAnnouncer) return;
    _ariaAnnouncer.textContent = '';
    requestAnimationFrame(function () {
      if (_ariaAnnouncer) _ariaAnnouncer.textContent = 'New error logged.';
    });
  }

  // -------------------------------------------------------------------------
  // Global error listeners — attached IMMEDIATELY (before DOMContentLoaded)
  // -------------------------------------------------------------------------

  /**
   * window.onerror — catches synchronous runtime errors and script-load errors.
   *
   * Returning false preserves the browser's default error handling (console +
   * DevTools stack trace) so developers are not worse off with this script present.
   */
  window.onerror = function (message, source, lineno, colno, error) {
    _log(_formatError(message, source, lineno, colno, error));
    return false;
  };

  /**
   * unhandledrejection — catches Promise rejections not caught by a .catch().
   * Fires on the window in browsers and worker-global scopes.
   */
  window.addEventListener('unhandledrejection', function (event) {
    _log(_formatRejection(event.reason));
  });

  // -------------------------------------------------------------------------
  // DOM construction (deferred to DOMContentLoaded)
  // -------------------------------------------------------------------------

  function _init() {
    // Guard: do not double-initialise if the script is somehow loaded twice.
    if (document.getElementById('accessible-error-container')) return;

    // ── Outer container ────────────────────────────────────────────────────
    _container = document.createElement('div');
    _container.id = 'accessible-error-container';
    _container.setAttribute('role', 'region');
    _container.setAttribute('aria-label', 'Error Log');
    _container.setAttribute('aria-describedby', 'accessible-error-log-desc');
    _container.style.cssText = [
      'position:fixed',
      'bottom:0',
      'left:0',
      'right:0',
      'z-index:2147483647',   // maximum z-index — must float above all app chrome
      'background:#0a0000',
      'border-top:3px solid #ff4444',
      'padding:0.5rem 0.75rem 0.75rem',
      'font-family:Consolas,Cascadia Code,Fira Code,monospace',
      'font-size:0.8rem',
    ].join(';');

    // ── Visible heading ────────────────────────────────────────────────────
    var label = document.createElement('p');
    label.id = 'accessible-error-log-label';
    label.style.cssText = [
      'margin:0 0 0.3rem',
      'color:#ff4444',
      'font-weight:700',
      'font-size:0.8rem',
      'letter-spacing:0.05em',
    ].join(';');
    label.textContent = 'Error Log — select all and copy to share';

    // ── Read-only textarea ─────────────────────────────────────────────────
    // Uses .value property writes only — no innerHTML, no injection risk.
    _textarea = document.createElement('textarea');
    _textarea.id = 'accessible-error-log';
    _textarea.readOnly = true;
    _textarea.setAttribute('aria-labelledby', 'accessible-error-log-label');
    _textarea.setAttribute('aria-describedby', 'accessible-error-log-desc');
    _textarea.setAttribute('aria-multiline', 'true');
    _textarea.style.cssText = [
      'width:100%',
      'height:150px',
      'border:2px solid red',
      'background:#0a0000',
      'color:#ffaaaa',
      'font-family:inherit',
      'font-size:inherit',
      'resize:vertical',
      'padding:0.25rem 0.4rem',
      'line-height:1.5',
    ].join(';');

    // ── aria-live announcer (visually hidden) ──────────────────────────────
    //
    // Must NOT use display:none or visibility:hidden — those remove the element
    // from the accessibility tree and prevent live-region announcements.
    // The 1×1 px clip trick keeps it rendered but invisible (WCAG technique).
    _ariaAnnouncer = document.createElement('div');
    _ariaAnnouncer.id = 'accessible-error-announcer';
    _ariaAnnouncer.setAttribute('aria-live', 'assertive');
    _ariaAnnouncer.setAttribute('aria-atomic', 'true');
    _ariaAnnouncer.style.cssText = [
      'position:absolute',
      'width:1px',
      'height:1px',
      'padding:0',
      'margin:-1px',
      'overflow:hidden',
      'clip:rect(0,0,0,0)',
      'white-space:nowrap',
      'border:0',
    ].join(';');

    // ── Visually-hidden description (linked via aria-describedby) ──────────
    var desc = document.createElement('p');
    desc.id = 'accessible-error-log-desc';
    desc.style.cssText = [
      'position:absolute',
      'width:1px',
      'height:1px',
      'padding:0',
      'margin:-1px',
      'overflow:hidden',
      'clip:rect(0,0,0,0)',
      'white-space:nowrap',
      'border:0',
    ].join(';');
    desc.textContent = 'Read-only error log. JavaScript errors and unhandled promise ' +
                       'rejections are appended here. Select all text and copy to share.';

    // ── Assemble and prepend to body ───────────────────────────────────────
    _container.appendChild(label);
    _container.appendChild(_textarea);
    _container.appendChild(_ariaAnnouncer);
    _container.appendChild(desc);

    // insertBefore with firstChild prepends even when body has no children yet.
    document.body.insertBefore(_container, document.body.firstChild);

    // ── Flush errors that arrived before the DOM was ready ─────────────────
    if (_pending.length > 0) {
      _textarea.value = _pending.join('\n');
      _textarea.scrollTop = _textarea.scrollHeight;
      _pending = [];
      _triggerAriaAnnouncement();
    }
  }

  // Run immediately if DOMContentLoaded has already fired; otherwise defer.
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', _init);
  } else {
    _init();
  }

  // -------------------------------------------------------------------------
  // Public API (optional — accessible from DevTools console via the global)
  // -------------------------------------------------------------------------

  return {
    /**
     * Show the error panel (default state).
     */
    show: function () {
      if (_container) _container.style.display = '';
    },

    /**
     * Hide the error panel without removing it from the DOM or accessibility tree.
     * Errors continue to be captured and queued while hidden.
     */
    hide: function () {
      if (_container) _container.style.display = 'none';
    },

    /**
     * Toggle panel visibility.
     */
    toggle: function () {
      if (!_container) return;
      if (_container.style.display === 'none') {
        this.show();
      } else {
        this.hide();
      }
    },

    /**
     * Clear all entries from the textarea.
     * Useful for starting a fresh capture session mid-debug.
     */
    clear: function () {
      if (_textarea) _textarea.value = '';
      _pending = [];
    },

    /**
     * Append a single line of text without going through the INFO/WARN/ERROR
     * severity path.  Used by D-084 diagnostics so F2/F3 output lands in the
     * console without emitting UI_ANNOUNCE (H-022 safe — no TTS triggered).
     *
     * @param {*} text — coerced to string; nullish values become empty string
     */
    append: function (text) {
      _log(String(text ?? ''));
    },
  };
}());
