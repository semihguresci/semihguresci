(() => {
  const root = document.documentElement;
  root.classList.replace('no-js', 'js');
  const themeToggle = document.getElementById('theme-toggle');
  const storageKey = 'site-theme';
  function applyTheme(theme) {
    root.dataset.theme = theme;
    themeToggle?.setAttribute('aria-label', `Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`);
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.content = theme === 'dark' ? '#101317' : '#f5f4ef';
  }
  applyTheme(root.dataset.theme || 'dark');
  themeToggle?.addEventListener('click', () => {
    const theme = root.dataset.theme === 'dark' ? 'light' : 'dark';
    applyTheme(theme);
    try { localStorage.setItem(storageKey, theme); } catch { /* The theme works without storage. */ }
  });
  const navToggle = document.getElementById('nav-toggle');
  const mobileNav = document.getElementById('mobile-nav');
  function setNav(open) {
    navToggle?.setAttribute('aria-expanded', String(open));
    navToggle?.setAttribute('aria-label', open ? 'Close navigation menu' : 'Open navigation menu');
    mobileNav?.setAttribute('aria-hidden', String(!open));
    mobileNav?.classList.toggle('is-open', open);
  }
  navToggle?.addEventListener('click', () => setNav(navToggle.getAttribute('aria-expanded') !== 'true'));
  mobileNav?.querySelectorAll('a').forEach(link => link.addEventListener('click', () => setNav(false)));
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && navToggle?.getAttribute('aria-expanded') === 'true') {
      setNav(false);
      navToggle.focus();
    }
  });
  window.matchMedia('(min-width: 901px)').addEventListener('change', event => { if (event.matches) setNav(false); });
  if ('IntersectionObserver' in window) {
    const navLinks = document.querySelectorAll('.nav [data-section]');
    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        const link = Array.from(navLinks).find(item => item.dataset.section === entry.target.id);
        if (link) {
          if (entry.isIntersecting) link.setAttribute('aria-current', 'location');
          else link.removeAttribute('aria-current');
        }
      });
    }, { rootMargin: '-15% 0px -55% 0px' });
    document.querySelectorAll('#projects, #experience, #about').forEach(section => observer.observe(section));
  }
})();
