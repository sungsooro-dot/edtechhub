/* ===================================
   EdTech HUB — main.js
   =================================== */

document.addEventListener('DOMContentLoaded', () => {

  /* ── Sticky header shadow ── */
  const header = document.getElementById('header');
  window.addEventListener('scroll', () => {
    header.classList.toggle('scrolled', window.scrollY > 10);
  }, { passive: true });

  /* ── Mobile hamburger ── */
  const hamburger  = document.getElementById('hamburger');
  const mobileNav  = document.getElementById('mobileNav');

  hamburger?.addEventListener('click', () => {
    const open = mobileNav.classList.toggle('open');
    const spans = hamburger.querySelectorAll('span');
    if (open) {
      spans[0].style.cssText = 'transform:rotate(45deg) translate(5px,5px)';
      spans[1].style.opacity = '0';
      spans[2].style.cssText = 'transform:rotate(-45deg) translate(5px,-5px)';
    } else {
      spans.forEach(s => s.removeAttribute('style'));
    }
  });

  // Close on outside click
  document.addEventListener('click', e => {
    if (!mobileNav?.contains(e.target) && !hamburger?.contains(e.target)) {
      mobileNav?.classList.remove('open');
      hamburger?.querySelectorAll('span').forEach(s => s.removeAttribute('style'));
    }
  });

  /* ── Active nav link on scroll ── */
  const sections  = [...document.querySelectorAll('section[id], div[id]')];
  const navLinks  = [...document.querySelectorAll('.nav-link')];

  const sectionObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (!entry.isIntersecting) return;
      const id = entry.target.id;
      navLinks.forEach(l => {
        l.classList.toggle('active', l.getAttribute('href') === `#${id}`);
      });
    });
  }, { threshold: 0.35 });

  sections.forEach(s => sectionObserver.observe(s));

  /* ── Stat counter animation ── */
  const counters = document.querySelectorAll('.stat-num[data-target]');

  const runCounter = el => {
    const target   = +el.dataset.target;
    const duration = 1800;
    const start    = performance.now();

    const tick = now => {
      const p = Math.min((now - start) / duration, 1);
      const ease = 1 - Math.pow(1 - p, 3); // ease-out cubic
      el.textContent = Math.round(target * ease).toLocaleString();
      if (p < 1) requestAnimationFrame(tick);
      else el.textContent = target.toLocaleString();
    };
    requestAnimationFrame(tick);
  };

  const counterObserver = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      if (entry.isIntersecting) {
        runCounter(entry.target);
        counterObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.6 });

  counters.forEach(el => counterObserver.observe(el));

  /* ── News filter pills ── */
  const pills = document.querySelectorAll('.filter-pill');
  pills.forEach(pill => {
    pill.addEventListener('click', () => {
      pills.forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
    });
  });

  /* ── Scroll-reveal for cards ── */
  const revealTargets = document.querySelectorAll(
    '.news-card, .event-card, .comm-card, .ps-partner-card, ' +
    '.prog-card, .stat-card, .event-hero-card, .newsletter-box'
  );

  const revealObs = new IntersectionObserver(entries => {
    entries.forEach((entry, i) => {
      if (entry.isIntersecting) {
        setTimeout(() => {
          entry.target.style.opacity  = '1';
          entry.target.style.transform = 'translateY(0)';
        }, (i % 4) * 80);
        revealObs.unobserve(entry.target);
      }
    });
  }, { threshold: 0.06, rootMargin: '0px 0px -30px 0px' });

  revealTargets.forEach(el => {
    el.style.opacity   = '0';
    el.style.transform = 'translateY(18px)';
    el.style.transition = 'opacity .5s ease, transform .5s ease';
    revealObs.observe(el);
  });

  /* ── Smooth scroll for anchor links ── */
  document.querySelectorAll('a[href^="#"]').forEach(a => {
    a.addEventListener('click', e => {
      const target = document.querySelector(a.getAttribute('href'));
      if (!target) return;
      e.preventDefault();
      const offset = header.offsetHeight + 12;
      window.scrollTo({ top: target.offsetTop - offset, behavior: 'smooth' });
      mobileNav?.classList.remove('open');
      hamburger?.querySelectorAll('span').forEach(s => s.removeAttribute('style'));
    });
  });

  /* ── Newsletter form ── */
  document.getElementById('nlForm')?.addEventListener('submit', e => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    btn.textContent = '✓ Subscribed!';
    btn.style.background = '#22c55e';
    btn.style.borderColor = '#22c55e';
    e.target.reset();
    setTimeout(() => {
      btn.textContent = 'Subscribe';
      btn.style.cssText = '';
    }, 3500);
  });

  /* ── Contact form ── */
  document.getElementById('contactForm')?.addEventListener('submit', e => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    btn.textContent = '✓ Message Sent!';
    btn.style.background = '#22c55e';
    btn.style.borderColor = '#22c55e';
    e.target.reset();
    setTimeout(() => {
      btn.textContent = 'Send Message';
      btn.style.cssText = '';
    }, 3500);
  });

  /* ── Back to top ── */
  document.getElementById('backToTop')?.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  /* ── Subtle hero parallax ── */
  const heroInner = document.querySelector('.hero-inner');
  window.addEventListener('scroll', () => {
    if (window.scrollY < window.innerHeight && heroInner) {
      heroInner.style.transform = `translateY(${window.scrollY * 0.12}px)`;
    }
  }, { passive: true });

  /* ── Console brand ── */
  console.log('%c EdTech HUB ', 'background:#1D3557;color:#fff;font-size:18px;font-weight:900;padding:4px 8px;border-radius:4px');
  console.log('%c Connecting the Global EdTech Ecosystem ', 'color:#E63946;font-size:12px;');
});
