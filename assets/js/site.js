(() => {
  const root = document.documentElement;
  root.classList.remove('no-js');
  root.classList.add('js');

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const desktop = window.matchMedia('(min-width: 901px)');

  const toggle = document.getElementById('nav-toggle');
  const panel = document.getElementById('mobile-nav');
  const setOpen = open => {
    toggle?.setAttribute('aria-expanded', String(open));
    toggle?.setAttribute('aria-label', open ? 'Close menu' : 'Open menu');
    panel?.classList.toggle('is-open', open);
    panel?.setAttribute('aria-hidden', String(!open));
  };
  toggle?.addEventListener('click', () => setOpen(toggle.getAttribute('aria-expanded') !== 'true'));
  panel?.querySelectorAll('a').forEach(link => link.addEventListener('click', () => setOpen(false)));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && toggle?.getAttribute('aria-expanded') === 'true') {
      setOpen(false);
      toggle.focus();
    }
  });
  desktop.addEventListener('change', event => {
    if (event.matches) setOpen(false);
  });

  if ('IntersectionObserver' in window) {
    const links = Array.from(document.querySelectorAll('.nav [data-section]'));
    const sections = links.map(link => document.getElementById(link.dataset.section)).filter(Boolean);
    const spy = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        const link = links.find(item => item.dataset.section === entry.target.id);
        if (!link) return;
        if (entry.isIntersecting) link.setAttribute('aria-current', 'location');
        else link.removeAttribute('aria-current');
      });
    }, { rootMargin: '-35% 0px -55% 0px' });
    sections.forEach(section => spy.observe(section));
  }

  const reveals = document.querySelectorAll('.reveal');
  if ('IntersectionObserver' in window && !reduceMotion.matches) {
    const reveal = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (!entry.isIntersecting) return;
        entry.target.classList.add('is-visible');
        reveal.unobserve(entry.target);
      });
    }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
    reveals.forEach(element => reveal.observe(element));
  } else {
    reveals.forEach(element => element.classList.add('is-visible'));
  }

  const bar = document.querySelector('[data-progress]');
  if (bar) {
    let queued = false;
    const update = () => {
      queued = false;
      const scrollable = root.scrollHeight - window.innerHeight;
      const ratio = scrollable > 0 ? Math.min(1, window.scrollY / scrollable) : 0;
      bar.style.transform = `scaleX(${ratio.toFixed(4)})`;
    };
    const schedule = () => {
      if (!queued) {
        queued = true;
        requestAnimationFrame(update);
      }
    };
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule, { passive: true });
    update();
  }
})();
