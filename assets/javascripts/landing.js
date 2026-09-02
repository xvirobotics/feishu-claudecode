/* MetaBot product landing — progressive enhancement only.
   Everything on the page works without JavaScript; this file adds
   copy-to-clipboard, scroll reveals and a subtle hero glow drift. */
(function () {
  'use strict';

  var doc = document.documentElement;
  doc.classList.add('js');

  var reduceMotion = window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : { matches: false };

  /* ---- copy buttons ---- */
  function copyText(text, done) {
    if (navigator.clipboard && window.isSecureContext !== false) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(false); });
      return;
    }
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    document.body.removeChild(ta);
    done(ok);
  }

  Array.prototype.forEach.call(document.querySelectorAll('[data-mb-copy]'), function (btn) {
    btn.addEventListener('click', function () {
      var label = btn.querySelector('[data-mb-copy-label]');
      var original = label ? label.textContent : btn.textContent;
      copyText(btn.getAttribute('data-mb-copy') || '', function (ok) {
        btn.classList.add('is-copied');
        if (label) label.textContent = ok ? btn.getAttribute('data-mb-copied') || 'copied' : 'error';
        window.setTimeout(function () {
          btn.classList.remove('is-copied');
          if (label) label.textContent = original;
        }, 1600);
      });
    });
  });

  /* ---- reveal on scroll ---- */
  var revealEls = document.querySelectorAll('.mb-reveal');
  if (revealEls.length && 'IntersectionObserver' in window && !reduceMotion.matches) {
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-in');
          io.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 });
    Array.prototype.forEach.call(revealEls, function (el) { io.observe(el); });
  } else {
    Array.prototype.forEach.call(revealEls, function (el) { el.classList.add('is-in'); });
  }

  /* ---- hero glow drift (fine pointers, motion allowed) ---- */
  var finePointer = window.matchMedia ? window.matchMedia('(pointer: fine)') : { matches: false };
  var hero = document.querySelector('.mb-hero');
  var figure = document.querySelector('.mb-hero-figure');
  if (hero && figure && finePointer.matches) {
    var raf = null;
    var pending = null;
    hero.addEventListener('pointermove', function (ev) {
      if (reduceMotion.matches) return;
      pending = ev;
      if (raf) return;
      raf = window.requestAnimationFrame(function () {
        raf = null;
        if (!pending) return;
        var rect = hero.getBoundingClientRect();
        var dx = (pending.clientX - rect.left) / rect.width - 0.5;
        var dy = (pending.clientY - rect.top) / rect.height - 0.5;
        figure.style.setProperty('--gx', (dx * 26).toFixed(1) + 'px');
        figure.style.setProperty('--gy', (dy * 18).toFixed(1) + 'px');
        pending = null;
      });
    });
    hero.addEventListener('pointerleave', function () {
      figure.style.setProperty('--gx', '0px');
      figure.style.setProperty('--gy', '0px');
    });
  }
})();
