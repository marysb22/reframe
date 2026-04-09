// Main JavaScript file for Reframe MHS website with bilingual support

document.addEventListener("DOMContentLoaded", function () {
  initializeNavigation();
  initializeLanguageSwitcher();
  initializeNewsletterForm();
  initializeContactForm();
  initializeFormspreeContact();
  initializeLabSubscribe();
  initializeScrollAnimations();
  initializeSmoothScrolling();
  initializeProjectFilters();
  initializeAccessibility();
  initializeTimelineTabs();
  initializeCalendarNavigation();
  initializeProjectExpansion();
  initializeGallery();
  initializeCalendar();
  initializeVideoPlayers();
  initializeProjectHoverEffects();
  initializeImagePreloading();

  if (typeof initializePartnersCarousel === "function") {
    initializePartnersCarousel();
  }

  loadLanguagePreference();
});

// =========================
// Language

function initializeLanguageSwitcher() {
  const langButtons = document.querySelectorAll(".lang-btn");

  langButtons.forEach((button) => {
    button.addEventListener("click", function () {
      const selectedLang = this.dataset.lang;
      localStorage.setItem("preferredLanguage", selectedLang);
      switchLanguage(selectedLang);

      langButtons.forEach((btn) => btn.classList.remove("active"));
      this.classList.add("active");
    });
  });
}

function switchLanguage(lang) {
  document.documentElement.lang = lang;
  document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";

  document.querySelectorAll("[data-translate]").forEach((element) => {
    const key = element.getAttribute("data-translate");
    if (translations[lang] && translations[lang][key] !== undefined) {
      element.textContent = translations[lang][key];
    }
  });

  document.querySelectorAll("[data-translate-placeholder]").forEach((element) => {
    const key = element.getAttribute("data-translate-placeholder");
    if (translations[lang] && translations[lang][key] !== undefined) {
      element.placeholder = translations[lang][key];
    }
  });

  document.querySelectorAll("[data-translate-option]").forEach((element) => {
    const key = element.getAttribute("data-translate-option");
    if (translations[lang] && translations[lang][key] !== undefined) {
      element.textContent = translations[lang][key];
    }
  });

  const arBtn = document.querySelector('.lang-btn[data-lang="ar"]');
  const enBtn = document.querySelector('.lang-btn[data-lang="en"]');

  if (arBtn) arBtn.classList.toggle("active", lang === "ar");
  if (enBtn) enBtn.classList.toggle("active", lang === "en");
}

function loadLanguagePreference() {
  const savedLang = localStorage.getItem("preferredLanguage") || "en";
  switchLanguage(savedLang);
}

document.addEventListener("DOMContentLoaded", function () {
  initializeLanguageSwitcher();
  loadLanguagePreference();
  
});
// Navigation
// =========================
function initializeNavigation() {
  const hamburger = document.querySelector(".hamburger");
  const overlay = document.querySelector(".overlay");
  const closeBtn = document.querySelector(".close-btn");
  const navLinks = document.querySelectorAll(".overlay .nav-link");

  if (hamburger && overlay) {
    hamburger.addEventListener("click", function () {
      hamburger.classList.toggle("active");
      overlay.classList.toggle("active");
      document.body.style.overflow = overlay.classList.contains("active") ? "hidden" : "";
    });
  }

  if (closeBtn && hamburger && overlay) {
    closeBtn.addEventListener("click", function () {
      hamburger.classList.remove("active");
      overlay.classList.remove("active");
      document.body.style.overflow = "";
    });
  }

  navLinks.forEach((link) => {
    link.addEventListener("click", function () {
      if (hamburger && overlay) {
        hamburger.classList.remove("active");
        overlay.classList.remove("active");
        document.body.style.overflow = "";
      }
    });
  });

  if (overlay && hamburger) {
    overlay.addEventListener("click", function (event) {
      if (event.target === overlay) {
        hamburger.classList.remove("active");
        overlay.classList.remove("active");
        document.body.style.overflow = "";
      }
    });
  }

  window.addEventListener(
    "scroll",
    debounce(function () {
      const navbar = document.querySelector(".navbar");
      if (!navbar) return;

      if (window.scrollY > 50) {
        navbar.classList.add("scrolled");
      } else {
        navbar.classList.remove("scrolled");
      }
    }, 10)
  );

  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && overlay && overlay.classList.contains("active") && hamburger) {
      hamburger.classList.remove("active");
      overlay.classList.remove("active");
      document.body.style.overflow = "";
    }
  });
}

// =========================
// Newsletter Form
// =========================
function initializeNewsletterForm() {
  const form = document.getElementById("newsletterForm");
  const successMessage = document.getElementById("newsletterSuccess");

  if (!form) return;

  form.addEventListener("submit", function (e) {
    e.preventDefault();

    const emailInput = form.querySelector('input[type="email"]');
    const button = form.querySelector("button");

    if (!emailInput || !button) return;

    const email = emailInput.value.trim();

    if (!validateEmail(email)) {
      showMessage("Please enter a valid email address.", "error");
      return;
    }

    showLoading(button, true);

    setTimeout(() => {
      showLoading(button, false);
      form.reset();

      if (successMessage) {
        successMessage.classList.add("show");
        setTimeout(() => {
          successMessage.classList.remove("show");
        }, 5000);
      } else {
        showMessage("Thank you for subscribing! We'll keep you updated.", "success");
      }
    }, 1500);
  });
}

// =========================
// Contact Form
// =========================
function initializeContactForm() {
  const form = document.getElementById("contactForm");
  if (!form) return;

  form.addEventListener("submit", function (e) {
    e.preventDefault();

    const formData = new FormData(form);
    const data = Object.fromEntries(formData);

    const requiredFields = ["firstName", "lastName", "email", "subject", "message"];
    const missingFields = requiredFields.filter((field) => !data[field]);

    if (missingFields.length > 0) {
      showMessage("Please fill in all required fields.", "error");
      return;
    }

    if (!validateEmail(data.email)) {
      showMessage("Please enter a valid email address.", "error");
      return;
    }

    const submitButton = form.querySelector('button[type="submit"]');
    showLoading(submitButton, true);

    setTimeout(() => {
      showLoading(submitButton, false);
      form.reset();
      showMessage("Thank you for your message! We'll get back to you soon.", "success");
    }, 2000);
  });
}

// =========================
// Formspree Contact
// =========================
function initializeFormspreeContact() {
  const contactFormSpree = document.getElementById("contact-form");
  const statusDiv = document.getElementById("status");
  const formspreeURL = "";

  if (!contactFormSpree || !statusDiv || !formspreeURL) return;

  contactFormSpree.addEventListener("submit", function (e) {
    e.preventDefault();

    const formData = new FormData(contactFormSpree);

    fetch(formspreeURL, {
      method: "POST",
      body: formData,
      headers: {
        Accept: "application/json",
      },
    })
      .then((response) => {
        if (response.ok) {
          statusDiv.innerText = "Message sent successfully! 😊";
          contactFormSpree.reset();
        } else {
          response.json().then((data) => {
            if (data.errors) {
              statusDiv.innerText = data.errors.map((error) => error.message).join(", ");
            } else {
              statusDiv.innerText = "Oops! There was a problem sending your message.";
            }
          });
        }
      })
      .catch(() => {
        statusDiv.innerText = "Oops! There was a problem sending your message.";
      });
  });
}

// =========================
// Lab Subscribe
// =========================
function initializeLabSubscribe() {
  const form = document.getElementById("lab-subscribe");
  if (!form) return;

  const wrap = form.querySelector(".input-wrap");
  const email = form.querySelector("#lab-email");
  const msg = document.getElementById("lab-message");

  if (!wrap || !email || !msg) return;

  const isValid = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

  email.addEventListener("input", () => {
    wrap.classList.remove("error", "success", "loading");
    msg.textContent = "";
    msg.className = "form-message";
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = email.value.trim();

    if (!isValid(v)) {
      wrap.classList.add("error");
      msg.textContent = "Please enter a valid email.";
      msg.className = "form-message error";
      email.focus();
      return;
    }

    wrap.classList.add("loading");
    email.readOnly = true;

    try {
      const res = await fetch(form.action || "/api/subscribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: v }),
      });

      if (!res.ok) throw new Error();

      wrap.classList.remove("loading");
      wrap.classList.add("success");
      msg.textContent = "Thanks! Check your inbox to confirm.";
      msg.className = "form-message success";
      form.reset();
    } catch {
      wrap.classList.remove("loading");
      msg.textContent = "Something went wrong. Try again.";
      msg.className = "form-message error";
    } finally {
      email.readOnly = false;
    }
  });
}

// =========================
// Project Filters
// =========================
function initializeProjectFilters() {
  const filterButtons = document.querySelectorAll(".filter-btn");
  const projectCards = document.querySelectorAll(".project-card");

  if (filterButtons.length === 0) return;

  filterButtons.forEach((button) => {
    button.addEventListener("click", function () {
      const filter = this.dataset.filter;

      filterButtons.forEach((btn) => btn.classList.remove("active"));
      this.classList.add("active");

      projectCards.forEach((card) => {
        const category = card.dataset.category;

        if (filter === "all" || category === filter) {
          card.style.display = "block";
          card.style.animation = "fadeInUp 0.5s ease forwards";
        } else {
          card.style.display = "none";
        }
      });
    });
  });
}

// =========================
// Scroll Animations
// =========================
function initializeScrollAnimations() {
  const observerOptions = {
    threshold: 0.1,
    rootMargin: "0px 0px -50px 0px",
  };

  const observer = new IntersectionObserver(function (entries) {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("animate-on-scroll");
        observer.unobserve(entry.target);
      }
    });
  }, observerOptions);

  const elementsToAnimate = document.querySelectorAll(
    ".value-card, .guidance-card, .featured-card, .asset-card, .event-card, .project-card, .service-card, .team-member, .resource-card, .category-card, .category-item"
  );

  elementsToAnimate.forEach((element) => {
    observer.observe(element);
  });
}

// =========================
// Smooth Scrolling
// =========================
function initializeSmoothScrolling() {
  document.querySelectorAll('a[href^="#"]').forEach((anchor) => {
    anchor.addEventListener("click", function (e) {
      const targetId = this.getAttribute("href");
      const target = document.querySelector(targetId);

      if (!target) return;

      e.preventDefault();

      const navbar = document.querySelector(".navbar");
      const navbarHeight = navbar ? navbar.offsetHeight : 0;
      const targetPosition = target.offsetTop - navbarHeight - 20;

      window.scrollTo({
        top: targetPosition,
        behavior: "smooth",
      });
    });
  });
}

// =========================
// Accessibility
// =========================
function initializeAccessibility() {
  const skipLink = document.createElement("a");
  skipLink.href = "#main-content";
  skipLink.textContent = "Skip to main content";
  skipLink.className = "skip-link";
  document.body.insertBefore(skipLink, document.body.firstChild);

  const main = document.querySelector("main") || document.querySelector(".hero");
  if (main && !main.id) {
    main.id = "main-content";
  }

  const hamburger = document.querySelector(".hamburger");
  if (hamburger) {
    hamburger.addEventListener("keydown", function (e) {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        this.click();
      }
    });
  }

  const langButtons = document.querySelectorAll(".lang-btn");
  langButtons.forEach((button) => {
    const lang = button.dataset.lang;
    button.setAttribute("aria-label", `Switch to ${lang === "en" ? "English" : "Arabic"}`);
  });

  const overlay = document.querySelector(".overlay");
  const hamburgerBtn = document.querySelector(".hamburger");

  if (overlay && hamburgerBtn) {
    hamburgerBtn.setAttribute("aria-expanded", "false");
    hamburgerBtn.setAttribute("aria-controls", "mobile-menu");
    overlay.setAttribute("id", "mobile-menu");

    const updateAriaExpanded = () => {
      const isActive = overlay.classList.contains("active");
      hamburgerBtn.setAttribute("aria-expanded", isActive.toString());
      overlay.setAttribute("aria-hidden", (!isActive).toString());
    };

    const observer = new MutationObserver(updateAriaExpanded);
    observer.observe(overlay, { attributes: true, attributeFilter: ["class"] });
  }
}

// =========================
// Gallery
// =========================
function initializeGallery() {
  const mainImage = document.querySelector(".gallery-main img");
  const thumbImages = document.querySelectorAll(".gallery-thumbs img");

  if (!mainImage || thumbImages.length === 0) return;

  thumbImages.forEach((thumb) => {
    thumb.addEventListener("click", function () {
      const newSrc = this.src;
      const newAlt = this.alt;

      mainImage.style.opacity = "0.5";
      setTimeout(() => {
        mainImage.src = newSrc;
        mainImage.alt = newAlt;
        mainImage.style.opacity = "1";
      }, 150);

      thumbImages.forEach((t) => t.classList.remove("active"));
      this.classList.add("active");
    });
  });

  thumbImages[0].classList.add("active");
}

// =========================
// Calendar Event Highlighting
// =========================
function initializeCalendar() {
  const eventDays = document.querySelectorAll(".event-day");

  eventDays.forEach((day) => {
    day.addEventListener("click", function () {
      showMessage("Event details would appear here in a full implementation.", "info");
    });
  });
}

// =========================
// Video Players
// =========================
function initializeVideoPlayers() {
  const playButtons = document.querySelectorAll(".play-button");

  playButtons.forEach((button) => {
    button.addEventListener("click", function () {
      showMessage("Video player would open here in a full implementation.", "info");
    });
  });
}

// =========================
// Timeline Tabs
// =========================
function initializeTimelineTabs() {
  const tabBtns = document.querySelectorAll(".tab-btn");
  const tabContents = document.querySelectorAll(".tab-content");

  if (tabBtns.length === 0) return;

  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetTab = btn.getAttribute("data-tab");

      tabBtns.forEach((b) => b.classList.remove("active"));
      tabContents.forEach((c) => c.classList.remove("active"));

      btn.classList.add("active");

      const targetContent = document.getElementById(targetTab);
      if (targetContent) {
        targetContent.classList.add("active");
      }
    });
  });
}

// =========================
// Calendar Navigation
// =========================
function initializeCalendarNavigation() {
  const prevBtn = document.querySelector(".prev-month");
  const nextBtn = document.querySelector(".next-month");
  const monthTitle = document.querySelector(".calendar-header h3");

  if (!prevBtn || !nextBtn || !monthTitle) return;

  const months = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
  ];

  const arabicMonths = [
    "يناير", "فبراير", "مارس", "أبريل", "مايو", "يونيو",
    "يوليو", "أغسطس", "سبتمبر", "أكتوبر", "نوفمبر", "ديسمبر",
  ];

  let currentMonth = 6;
  let currentYear = 2025;

  function updateCalendar() {
    const lang = document.documentElement.lang || "en";
    const monthNames = lang === "ar" ? arabicMonths : months;
    monthTitle.textContent = `${monthNames[currentMonth]} ${currentYear}`;
  }

  prevBtn.addEventListener("click", () => {
    currentMonth--;
    if (currentMonth < 0) {
      currentMonth = 11;
      currentYear--;
    }
    updateCalendar();
  });

  nextBtn.addEventListener("click", () => {
    currentMonth++;
    if (currentMonth > 11) {
      currentMonth = 0;
      currentYear++;
    }
    updateCalendar();
  });

  updateCalendar();
}

// =========================
// Project Expansion
// =========================
function initializeProjectExpansion() {
  const projectHeaders = document.querySelectorAll(".project-header");

  projectHeaders.forEach((header) => {
    header.addEventListener("click", () => {
      const projectItem = header.closest(".project-item");
      if (!projectItem) return;

      const content = projectItem.querySelector(".project-content");
      const expandBtn = header.querySelector(".expand-btn i");

      projectItem.classList.toggle("expanded");

      if (content) {
        content.style.maxHeight = projectItem.classList.contains("expanded")
          ? content.scrollHeight + "px"
          : "0px";
      }

      if (expandBtn) {
        expandBtn.style.transform = projectItem.classList.contains("expanded")
          ? "rotate(45deg)"
          : "rotate(0deg)";
      }
    });
  });
}

// =========================
// Project Hover Effects
// =========================
function initializeProjectHoverEffects() {
  document.querySelectorAll(".project-item").forEach((item) => {
    item.addEventListener("mouseenter", () => {
      item.style.transform = "scale(1.05) rotate(-1deg)";
      item.style.boxShadow = "0 12px 30px rgba(22,160,133,0.4)";
    });

    item.addEventListener("mouseleave", () => {
      item.style.transform = "scale(1) rotate(0)";
      item.style.boxShadow = "0 3px 10px rgba(0,0,0,0.05)";
    });
  });
}

// =========================
// Image Preloading
// =========================
function initializeImagePreloading() {
  const images = document.querySelectorAll("img");

  images.forEach((img) => {
    const src = img.getAttribute("data-src") || img.src;
    if (src) {
      const preImg = new Image();
      preImg.src = src;
    }
  });

  const options = { rootMargin: "250px", threshold: 0.1 };
  const observer = new IntersectionObserver((entries, obs) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        const img = entry.target;
        const src = img.getAttribute("data-src");
        if (src && img.src !== src) {
          img.src = src;
          img.onload = () => img.classList.add("loaded");
          obs.unobserve(img);
        }
      }
    });
  }, options);

  images.forEach((img) => observer.observe(img));

  window.addEventListener("load", () => {
    if ("caches" in window) {
      caches.open("instant-image-cache").then((cache) => {
        images.forEach((img) => {
          const src = img.getAttribute("data-src") || img.src;
          if (src) {
            fetch(src)
              .then((res) => {
                if (res.ok) cache.put(src, res);
              })
              .catch(() => null);
          }
        });
      });
    }
  });
}

// =========================
// Language Changed Event
// =========================
document.addEventListener("languageChanged", function (event) {
  const newLang = event.detail.language;
  updateDynamicContent(newLang);
  updateFormPlaceholders(newLang);
});

function updateDynamicContent(lang) {
  const dateElements = document.querySelectorAll(".date, .asset-date, .resource-date");
  dateElements.forEach(() => {});
}

function updateFormPlaceholders(lang) {
  const forms = document.querySelectorAll("form");
  forms.forEach((form) => {
    const inputs = form.querySelectorAll("input, textarea");
    inputs.forEach((input) => {
      if (!input.hasAttribute("data-translate")) {
        if (input.type === "email" && !input.placeholder) {
          input.placeholder = lang === "ar" ? "أدخل عنوان البريد الإلكتروني" : "Enter your email";
        }
      }
    });
  });
}

// =========================
// Helpers
// =========================
function validateEmail(email) {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

function showLoading(button, isLoading) {
  if (!button) return;

  if (isLoading) {
    button.dataset.originalText = button.textContent;
    button.textContent = "Loading...";
    button.disabled = true;
    button.classList.add("loading");
  } else {
    button.textContent = button.dataset.originalText || button.textContent;
    button.disabled = false;
    button.classList.remove("loading");
  }
}

function showMessage(message, type = "info") {
  const messageDiv = document.createElement("div");
  messageDiv.className = `message message-${type}`;
  messageDiv.textContent = message;
  messageDiv.style.cssText = `
    position: fixed;
    top: 20px;
    right: 20px;
    padding: 15px 20px;
    border-radius: 5px;
    color: white;
    font-weight: 500;
    z-index: 10000;
    animation: slideInRight 0.3s ease;
    max-width: 300px;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  `;

  if (type === "error") {
    messageDiv.style.backgroundColor = "#dc3545";
  } else if (type === "success") {
    messageDiv.style.backgroundColor = "#28a745";
  } else {
    messageDiv.style.backgroundColor = "#2c5aa0";
  }

  document.body.appendChild(messageDiv);

  setTimeout(() => {
    messageDiv.style.animation = "slideOutRight 0.3s ease";
    setTimeout(() => {
      if (messageDiv.parentNode) {
        messageDiv.remove();
      }
    }, 300);
  }, 5000);

  messageDiv.addEventListener("click", function () {
    this.style.animation = "slideOutRight 0.3s ease";
    setTimeout(() => {
      if (this.parentNode) {
        this.remove();
      }
    }, 300);
  });
}

function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

// =========================
// Error Handling / Performance
// =========================
window.addEventListener("error", function (e) {
  console.error("JavaScript error:", e.error);
});

window.addEventListener("load", function () {
  if (window.performance && window.performance.timing) {
    const loadTime =
      window.performance.timing.loadEventEnd - window.performance.timing.navigationStart;
    console.log("Page load time:", loadTime + "ms");
  }
});

// =========================
// Optional Service Worker
// =========================
if ("serviceWorker" in navigator) {
  window.addEventListener("load", function () {
    // navigator.serviceWorker.register('/sw.js');
  });
}

// =========================
// Runtime Styles
// =========================
const style = document.createElement("style");
style.textContent = `
  @keyframes slideInRight {
    from { transform: translateX(100%); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }

  @keyframes slideOutRight {
    from { transform: translateX(0); opacity: 1; }
    to { transform: translateX(100%); opacity: 0; }
  }

  .language-switching {
    transition: all 0.3s ease;
  }

  .gallery-thumbs img.active {
    opacity: 1;
    border: 2px solid var(--primary-blue);
  }
`;
document.head.appendChild(style);