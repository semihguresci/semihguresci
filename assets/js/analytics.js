(() => {
  const { measurementId, siteOrigin } = document.currentScript.dataset;
  if (!measurementId || window.location.origin !== siteOrigin) return;

  const panel = document.getElementById('analytics-consent');
  const title = document.getElementById('analytics-title');
  const preferences = document.getElementById('analytics-preferences');
  const storageKey = 'site-analytics-consent';
  const cookieLifetime = 180 * 24 * 60 * 60;
  const disableKey = `ga-disable-${measurementId}`;
  let temporaryChoice;
  let tagStarted = false;
  let openedFromFooter = false;

  function savedChoice() {
    if (temporaryChoice) return temporaryChoice;
    try {
      const saved = JSON.parse(localStorage.getItem(storageKey));
      if (saved?.expiresAt > Date.now() && ['granted', 'denied'].includes(saved.choice)) {
        return saved.choice;
      }
    } catch {
      // Without browser storage, visitors can still choose for this page.
    }
    return null;
  }

  function startAnalytics() {
    window[disableKey] = false;
    if (tagStarted) return;
    tagStarted = true;

    window.dataLayer = window.dataLayer || [];
    window.gtag = function () { window.dataLayer.push(arguments); };
    window.gtag('consent', 'default', {
      analytics_storage: 'denied',
      ad_storage: 'denied',
      ad_user_data: 'denied',
      ad_personalization: 'denied',
    });
    window.gtag('consent', 'update', { analytics_storage: 'granted' });
    window.gtag('js', new Date());
    window.gtag('config', measurementId, {
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
      cookie_domain: 'none',
      cookie_expires: cookieLifetime,
      cookie_update: false,
    });

    const tag = document.createElement('script');
    tag.async = true;
    tag.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(measurementId)}`;
    document.head.append(tag);
  }

  function showPreferences(show) {
    panel.hidden = !show;
    preferences.setAttribute('aria-expanded', String(show));
  }

  function applyChoice(choice) {
    if (choice === 'granted') {
      startAnalytics();
    } else {
      window[disableKey] = true;
      const cookieNames = ['_ga', `_ga_${measurementId.slice(2)}`];
      for (const name of cookieNames) {
        document.cookie = `${name}=; Max-Age=0; Path=/; Secure; SameSite=Lax`;
      }
    }
    showPreferences(!choice);
  }

  preferences.addEventListener('click', () => {
    openedFromFooter = true;
    showPreferences(true);
    title.focus({ preventScroll: true });
  });

  for (const button of panel.querySelectorAll('[data-analytics-choice]')) {
    button.addEventListener('click', () => {
      const choice = button.dataset.analyticsChoice;
      try {
        localStorage.setItem(storageKey, JSON.stringify({
          choice,
          expiresAt: Date.now() + cookieLifetime * 1000,
        }));
        temporaryChoice = undefined;
      } catch {
        temporaryChoice = choice;
      }
      applyChoice(choice);
      const returnFocus = openedFromFooter ? preferences : document.getElementById('main');
      returnFocus.focus({ preventScroll: true });
      openedFromFooter = false;
    });
  }

  window.addEventListener('storage', event => {
    if (event.key === storageKey || event.key === null) applyChoice(savedChoice());
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted) applyChoice(savedChoice());
  });

  preferences.hidden = false;
  applyChoice(savedChoice());
})();
