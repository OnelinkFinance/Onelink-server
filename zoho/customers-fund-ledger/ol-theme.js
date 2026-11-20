/* Background and glass theme for the whole Customers Fund Ledger page (styles: ol-theme.css).
   Sets data-olbg / data-oltone on <html>, remembers the choice in the viewer's browser and adds the switcher to the header.
   "Original" removes the theme and returns the page to its own look. */
(function () {
'use strict';
var BGS = [['aurora', 'Aurora', 'dark'], ['emerald', 'Emerald', 'dark'], ['dusk', 'Dusk', 'dark'], ['ocean', 'Ocean', 'dark'], ['sand', 'Sand', 'light'], ['mist', 'Mist', 'light'], ['plain', 'Original', '']];
var root = document.documentElement, own = root.getAttribute('data-theme'), cur = 'aurora';
try { var s = localStorage.getItem('ol.bg'); if (BGS.some(function (b) { return b[0] === s; })) cur = s; } catch (e) {}
function apply() {
  var b = BGS.filter(function (x) { return x[0] === cur; })[0];
  if (cur === 'plain') { root.removeAttribute('data-olbg'); root.removeAttribute('data-oltone'); if (own == null) root.removeAttribute('data-theme'); else root.setAttribute('data-theme', own); }
  else { root.setAttribute('data-olbg', cur); root.setAttribute('data-oltone', b[2]); root.setAttribute('data-theme', b[2]); }
  var bs = document.querySelectorAll('.olbg [data-olbg]');
  for (var i = 0; i < bs.length; i++) bs[i].setAttribute('aria-pressed', String(bs[i].getAttribute('data-olbg') === cur));
  try { document.dispatchEvent(new CustomEvent('ol-bg', { detail: cur })); } catch (e) {}
}
function set(k) { if (!BGS.some(function (b) { return b[0] === k; })) return; cur = k; try { localStorage.setItem('ol.bg', k); } catch (e) {} apply(); }
window.OLTheme = { get: function () { return cur; }, set: set, list: BGS };
apply();
function mount() {
  var host = document.querySelector('.top .status'); if (!host || host.querySelector('.olbg')) return;
  var g = document.createElement('span'); g.className = 'olbg'; g.setAttribute('role', 'group'); g.setAttribute('aria-label', 'Background');
  g.innerHTML = '<span>Background</span>' + BGS.map(function (b) { return '<button type="button" data-olbg="' + b[0] + '" title="' + b[1] + '" aria-label="' + b[1] + ' background"></button>'; }).join('');
  g.addEventListener('click', function (ev) { var t = ev.target.closest('[data-olbg]'); if (t) set(t.getAttribute('data-olbg')); });
  host.appendChild(g); apply();
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
