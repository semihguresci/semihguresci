(() => {
  const root = document.documentElement;
  const main = document.getElementById('main');
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

  let pageEffects;

  function mountPage() {
    pageEffects?.abort();
    pageEffects = new AbortController();
    const { signal } = pageEffects;
    const links = Array.from(document.querySelectorAll('.nav [data-section]'));
    const sections = links.map(link => document.getElementById(link.dataset.section)).filter(Boolean);
    const reveals = main.querySelectorAll('.reveal');
    links.forEach(link => link.removeAttribute('aria-current'));

    if ('IntersectionObserver' in window && sections.length) {
      const spy = new IntersectionObserver(entries => {
        if (signal.aborted) return;
        entries.forEach(entry => {
          const link = links.find(item => item.dataset.section === entry.target.id);
          if (entry.isIntersecting) link.setAttribute('aria-current', 'location');
          else link.removeAttribute('aria-current');
        });
      }, { rootMargin: '-35% 0px -55% 0px' });
      sections.forEach(section => spy.observe(section));
      signal.addEventListener('abort', () => spy.disconnect());
    }

    if ('IntersectionObserver' in window && reveals.length && !reduceMotion.matches) {
      const reveal = new IntersectionObserver(entries => {
        entries.forEach(entry => {
          if (!entry.isIntersecting) return;
          entry.target.classList.add('is-visible');
          reveal.unobserve(entry.target);
        });
      }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
      reveals.forEach(element => reveal.observe(element));
      signal.addEventListener('abort', () => reveal.disconnect());
    } else {
      reveals.forEach(element => element.classList.add('is-visible'));
    }

    const bar = main.querySelector('[data-progress]');
    if (bar) {
      let frame = 0;
      const update = () => {
        frame = 0;
        const scrollable = root.scrollHeight - window.innerHeight;
        const ratio = scrollable > 0 ? Math.min(1, window.scrollY / scrollable) : 0;
        bar.style.transform = `scaleX(${ratio.toFixed(4)})`;
      };
      const schedule = () => {
        if (!frame) frame = requestAnimationFrame(update);
      };
      window.addEventListener('scroll', schedule, { passive: true, signal });
      window.addEventListener('resize', schedule, { passive: true, signal });
      signal.addEventListener('abort', () => cancelAnimationFrame(frame));
      update();
    }

    buildToc();
  }

  function buildToc() {
    const prose = main.querySelector('.prose');
    const headings = prose ? Array.from(prose.querySelectorAll('h2')) : [];
    if (headings.length <= 2 || main.querySelector('.toc')) return;
    const used = new Set();
    headings.forEach((heading, index) => {
      if (!heading.id) {
        const slug = heading.textContent.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || `section-${index + 1}`;
        let id = slug;
        for (let n = 2; used.has(id) || document.getElementById(id); n++) id = `${slug}-${n}`;
        heading.id = id;
      }
      used.add(heading.id);
    });
    const nav = document.createElement('nav');
    nav.className = 'toc';
    nav.setAttribute('aria-label', 'On this page');
    const title = document.createElement('p');
    title.className = 'toc__title';
    title.textContent = 'On this page';
    const list = document.createElement('ol');
    headings.forEach(heading => {
      const item = document.createElement('li');
      const link = document.createElement('a');
      link.href = `#${heading.id}`;
      link.textContent = heading.textContent.trim();
      item.appendChild(link);
      list.appendChild(item);
    });
    nav.append(title, list);
    prose.before(nav);
  }

  mountPage();

  const nav = window.navigation;
  if (!nav || typeof window.NavigateEvent?.prototype.intercept !== 'function') return;

  const sitePath = document.querySelector('.site-header .brand').pathname;
  const routeKey = ({ pathname, search }) => pathname + search;
  const pageMetadata = 'title, meta[name="description"], meta[name="robots"], link[rel="canonical"], '
    + 'meta[property^="og:"], meta[property^="article:"], meta[name^="twitter:"], script[type="application/ld+json"]';
  const pageLinks = document.querySelectorAll('.nav a:not([data-section]), .mobile-nav a');
  let renderedRoute = routeKey(location);

  nav.addEventListener('navigate', event => {
    if (!event.canIntercept || event.navigationType === 'reload' || event.downloadRequest !== null || event.formData) return;

    const url = new URL(event.destination.url);
    const route = routeKey(url);
    if (url.origin !== location.origin || !url.pathname.startsWith(sitePath)) return;
    if (route === renderedRoute && event.destination.sameDocument) return;
    // Only shared HTML routes use the persistent page shell.
    const path = url.pathname.slice(sitePath.length);
    if (path && !/^(?:blog\/(?:[^/]+\/)?|(?:cv|privacy|data-policy)\/|404\.html)$/.test(path)) return;

    event.intercept({
      focusReset: 'manual',
      async handler() {
        if (route === renderedRoute) {
          setOpen(false);
          main.focus({ preventScroll: true });
          return;
        }

        let next;
        let content;
        try {
          const response = await fetch(url, { signal: event.signal, headers: { Accept: 'text/html' } });
          if (!response.ok || response.redirected || !response.headers.get('Content-Type')?.includes('text/html')) {
            throw new Error('Expected a site page');
          }
          next = new DOMParser().parseFromString(await response.text(), 'text/html');
          content = next.querySelector('#main');
          if (!content || !next.querySelector('[data-volume-stage]')) throw new Error('Expected the shared page layout');
        } catch {
          if (!event.signal.aborted) location.reload();
          return;
        }
        if (event.signal.aborted) return;

        for (const node of document.head.querySelectorAll(pageMetadata)) node.remove();
        document.head.append(...next.head.querySelectorAll(pageMetadata));
        document.body.classList.toggle('home', next.body.classList.contains('home'));
        main.replaceChildren(...content.childNodes);
        renderedRoute = route;

        for (const link of pageLinks) {
          if (link.origin === url.origin && link.pathname === url.pathname && !link.hash) {
            link.setAttribute('aria-current', 'page');
          } else {
            link.removeAttribute('aria-current');
          }
        }
        setOpen(false);
        mountPage();
        window.dispatchEvent(new Event('site:page-change'));
        main.focus({ preventScroll: true });
      }
    });
  });
})();
