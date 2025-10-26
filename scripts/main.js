// Main JavaScript file for Reframe MHS website with bilingual support

document.addEventListener('DOMContentLoaded', function() {
    // Initialize all functionality
    initializeNavigation();
    initializeLanguageSwitcher();
    initializeNewsletterForm();
    initializeContactForm();
    initializeScrollAnimations();
    initializeSmoothScrolling();
    initializeProjectFilters();
    initializeAccessibility();
    initializeTimelineTabs();
    initializeCalendarNavigation();
    initializeProjectExpansion();
    initializePartnersCarousel();
    
    // Load saved language preference
    loadLanguagePreference();
});

// Language switching functionality
function initializeLanguageSwitcher() {
    const langButtons = document.querySelectorAll('.lang-btn');
    
    langButtons.forEach(button => {
        button.addEventListener('click', function() {
            const selectedLang = this.dataset.lang;
            switchLanguage(selectedLang);
            
            // Update active state
            langButtons.forEach(btn => btn.classList.remove('active'));
            this.classList.add('active');
            
            // Save preference
            localStorage.setItem('preferredLanguage', selectedLang);
        });
    });
}

// Switch language function
function switchLanguage(lang) {
    const html = document.documentElement;
    const body = document.body;
    
    // Update language and direction attributes
    html.setAttribute('lang', lang);
    html.setAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
    
    // Add transition class for smooth switching
    body.classList.add('language-switching');
    
    setTimeout(() => {
        // Update all translatable elements
        const translatableElements = document.querySelectorAll('[data-translate]');
        translatableElements.forEach(element => {
            const key = element.getAttribute('data-translate');
            const translation = getTranslation(key, lang);
            
            if (translation) {
                if (element.tagName === 'INPUT' && element.type === 'email') {
                    element.placeholder = translation;
                } else if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
                    element.placeholder = translation;
                } else {
                    element.textContent = translation;
                }
            }
        });
        
        // Update document title and meta description
        const titleElement = document.querySelector('title[data-translate]');
        const metaDescription = document.querySelector('meta[name="description"][data-translate]');
        
        if (titleElement) {
            const titleKey = titleElement.getAttribute('data-translate');
            const titleTranslation = getTranslation(titleKey, lang);
            if (titleTranslation) {
                document.title = titleTranslation;
            }
        }
        
        if (metaDescription) {
            const metaKey = metaDescription.getAttribute('data-translate');
            const metaTranslation = getTranslation(metaKey, lang);
            if (metaTranslation) {
                metaDescription.setAttribute('content', metaTranslation);
            }
        }
        
        // Remove transition class
        body.classList.remove('language-switching');
        
        // Trigger custom event for other components
        const languageChangeEvent = new CustomEvent('languageChanged', {
            detail: { language: lang }
        });
        document.dispatchEvent(languageChangeEvent);
        
    }, 100);
}

// Get translation function
function getTranslation(key, lang) {
    if (typeof translations !== 'undefined' && translations[lang] && translations[lang][key]) {
        return translations[lang][key];
    }
    return null;
}

// Load language preference
function loadLanguagePreference() {
    const savedLang = localStorage.getItem('preferredLanguage');
    const browserLang = navigator.language.startsWith('ar') ? 'ar' : 'en';
    const defaultLang = savedLang || browserLang;
    
    if (defaultLang === 'ar') {
        switchLanguage('ar');
        document.querySelector('.lang-btn[data-lang="ar"]').classList.add('active');
        document.querySelector('.lang-btn[data-lang="en"]').classList.remove('active');
    }
}

// Navigation functionality
function initializeNavigation() {
    const hamburger = document.querySelector('.hamburger');
    const overlay = document.querySelector('.overlay');
    const closeBtn = document.querySelector('.close-btn');
    const navLinks = document.querySelectorAll('.overlay .nav-link');

    // Hamburger menu toggle
    if (hamburger && overlay) {
        hamburger.addEventListener('click', function() {
            hamburger.classList.toggle('active');
            overlay.classList.toggle('active');
            document.body.style.overflow = overlay.classList.contains('active') ? 'hidden' : '';
        });
    }

    // Close button
    if (closeBtn) {
        closeBtn.addEventListener('click', function() {
            hamburger.classList.remove('active');
            overlay.classList.remove('active');
            document.body.style.overflow = '';
        });
    }

    // Close menu when clicking on a link
    navLinks.forEach(link => {
        link.addEventListener('click', function() {
            hamburger.classList.remove('active');
            overlay.classList.remove('active');
            document.body.style.overflow = '';
        });
    });

    // Close menu when clicking outside
    if (overlay) {
        overlay.addEventListener('click', function(event) {
            if (event.target === overlay) {
                hamburger.classList.remove('active');
                overlay.classList.remove('active');
                document.body.style.overflow = '';
            }
        });
    }

    // Navbar scroll effect
    window.addEventListener('scroll', debounce(function() {
        const navbar = document.querySelector('.navbar');
        if (window.scrollY > 50) {
            navbar.classList.add('scrolled');
        } else {
            navbar.classList.remove('scrolled');
        }
    }, 10));

    // Handle escape key for overlay
    document.addEventListener('keydown', function(event) {
        if (event.key === 'Escape' && overlay.classList.contains('active')) {
            hamburger.classList.remove('active');
            overlay.classList.remove('active');
            document.body.style.overflow = '';
        }
    });
}

// Newsletter form functionality
function initializeNewsletterForm() {
    const form = document.getElementById('newsletterForm');
    const successMessage = document.getElementById('newsletterSuccess');

    if (form) {
        form.addEventListener('submit', function(e) {
            e.preventDefault();
            
            const email = form.querySelector('input[type="email"]').value;
            
            // Basic email validation
            if (!validateEmail(email)) {
                showMessage('Please enter a valid email address.', 'error');
                return;
            }

            // Show loading state
            showLoading(form.querySelector('button'), true);
            
            // Simulate form submission
            setTimeout(() => {
                showLoading(form.querySelector('button'), false);
                form.reset();
                
                if (successMessage) {
                    successMessage.classList.add('show');
                    setTimeout(() => {
                        successMessage.classList.remove('show');
                    }, 5000);
                } else {
                    showMessage('Thank you for subscribing! We\'ll keep you updated.', 'success');
                }
            }, 1500);
        });
    }
}

// Contact form functionality
function initializeContactForm() {
    const form = document.getElementById('contactForm');

    if (form) {
        form.addEventListener('submit', function(e) {
            e.preventDefault();
            
            // Get form data

            const formData = new FormData(form);
            const data = Object.fromEntries(formData);
            
            // Validate required fields
            const requiredFields = ['firstName', 'lastName', 'email', 'subject', 'message'];
            const missingFields = requiredFields.filter(field => !data[field]);
            
            if (missingFields.length > 0) {
                showMessage('Please fill in all required fields.', 'error');
                return;
            }

            // Validate email
            if (!validateEmail(data.email)) {
                showMessage('Please enter a valid email address.', 'error');
                return;
            }

            // Show loading state
            const submitButton = form.querySelector('button[type="submit"]');
            showLoading(submitButton, true);
            
            // Simulate form submission
            setTimeout(() => {
                showLoading(submitButton, false);
                form.reset();
                showMessage('Thank you for your message! We\'ll get back to you soon.', 'success');
            }, 2000);
        });
    }
}

// Project filters functionality
function initializeProjectFilters() {
    const filterButtons = document.querySelectorAll('.filter-btn');
    const projectCards = document.querySelectorAll('.project-card');

    if (filterButtons.length > 0) {
        filterButtons.forEach(button => {
            button.addEventListener('click', function() {
                const filter = this.dataset.filter;
                
                // Update active button
                filterButtons.forEach(btn => btn.classList.remove('active'));
                this.classList.add('active');
                
                // Filter projects
                projectCards.forEach(card => {
                    const category = card.dataset.category;
                    
                    if (filter === 'all' || category === filter) {
                        card.style.display = 'block';
                        card.style.animation = 'fadeInUp 0.5s ease forwards';
                    } else {
                        card.style.display = 'none';
                    }
                });
            });
        });
    }
}

// Email validation function
function validateEmail(email) {
    const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return re.test(email);
}

// Show loading state
function showLoading(button, isLoading) {
    if (!button) return;
    
    if (isLoading) {
        button.dataset.originalText = button.textContent;
        button.textContent = 'Loading...';
        button.disabled = true;
        button.classList.add('loading');
    } else {
        button.textContent = button.dataset.originalText || button.textContent;
        button.disabled = false;
        button.classList.remove('loading');
    }
}

// Show message function
function showMessage(message, type = 'info') {
    const messageDiv = document.createElement('div');
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
    
    // Set background color based on type
    if (type === 'error') {
        messageDiv.style.backgroundColor = '#dc3545';
    } else if (type === 'success') {
        messageDiv.style.backgroundColor = '#28a745';
    } else {
        messageDiv.style.backgroundColor = '#2c5aa0';
    }
    
    document.body.appendChild(messageDiv);
    
    // Auto remove after 5 seconds
    setTimeout(() => {
        messageDiv.style.animation = 'slideOutRight 0.3s ease';
        setTimeout(() => {
            if (messageDiv.parentNode) {
                messageDiv.remove();
            }
        }, 300);
    }, 5000);
    
    // Add click to dismiss
    messageDiv.addEventListener('click', function() {
        this.style.animation = 'slideOutRight 0.3s ease';
        setTimeout(() => {
            if (this.parentNode) {
                this.remove();
            }
        }, 300);
    });
}

// Scroll animations
function initializeScrollAnimations() {
    const observerOptions = {
        threshold: 0.1,
        rootMargin: '0px 0px -50px 0px'
    };

    const observer = new IntersectionObserver(function(entries) {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.classList.add('animate-on-scroll');
                // Unobserve after animation to improve performance
                observer.unobserve(entry.target);
            }
        });
    }, observerOptions);

    // Observe elements for animation
    const elementsToAnimate = document.querySelectorAll(
        '.value-card, .guidance-card, .featured-card, .asset-card, .event-card, .project-card, .service-card, .team-member, .resource-card, .category-card, .category-item'
    );

    elementsToAnimate.forEach(element => {
        observer.observe(element);
    });
}

// Smooth scrolling for anchor links
function initializeSmoothScrolling() {
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            e.preventDefault();
            const targetId = this.getAttribute('href');
            const target = document.querySelector(targetId);
            
            if (target) {
                const navbarHeight = document.querySelector('.navbar').offsetHeight;
                const targetPosition = target.offsetTop - navbarHeight - 20;
                
                window.scrollTo({
                    top: targetPosition,
                    behavior: 'smooth'
                });
            }
        });
    });
}

// Accessibility improvements
function initializeAccessibility() {
    // Add skip to main content link
    const skipLink = document.createElement('a');
    skipLink.href = '#main-content';
    skipLink.textContent = 'Skip to main content';
    skipLink.className = 'skip-link';
    
    document.body.insertBefore(skipLink, document.body.firstChild);

    // Add main content id if it doesn't exist
    const main = document.querySelector('main') || document.querySelector('.hero');
    if (main && !main.id) {
        main.id = 'main-content';
    }

    // Improve keyboard navigation for hamburger menu
    const hamburger = document.querySelector('.hamburger');
    if (hamburger) {
        hamburger.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                this.click();
            }
        });
    }

    // Add ARIA labels for better screen reader support
    const langButtons = document.querySelectorAll('.lang-btn');
    langButtons.forEach(button => {
        const lang = button.dataset.lang;
        button.setAttribute('aria-label', `Switch to ${lang === 'en' ? 'English' : 'Arabic'}`);
    });

    // Update ARIA attributes for mobile menu
    const overlay = document.querySelector('.overlay');
    const hamburgerBtn = document.querySelector('.hamburger');
    
    if (overlay && hamburgerBtn) {
        hamburgerBtn.setAttribute('aria-expanded', 'false');
        hamburgerBtn.setAttribute('aria-controls', 'mobile-menu');
        overlay.setAttribute('id', 'mobile-menu');
        
        // Update aria-expanded when menu opens/closes
        const updateAriaExpanded = () => {
            const isActive = overlay.classList.contains('active');
            hamburgerBtn.setAttribute('aria-expanded', isActive.toString());
            overlay.setAttribute('aria-hidden', (!isActive).toString());
        };
        
        // Listen for class changes
        const observer = new MutationObserver(updateAriaExpanded);
        observer.observe(overlay, { attributes: true, attributeFilter: ['class'] });
    }
}

// Utility function to debounce scroll events
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

// Gallery functionality for hero images
function initializeGallery() {
    const mainImage = document.querySelector('.gallery-main img');
    const thumbImages = document.querySelectorAll('.gallery-thumbs img');

    if (mainImage && thumbImages.length > 0) {
        thumbImages.forEach(thumb => {
            thumb.addEventListener('click', function() {
                const newSrc = this.src;
                const newAlt = this.alt;
                
                // Fade transition
                mainImage.style.opacity = '0.5';
                setTimeout(() => {
                    mainImage.src = newSrc;
                    mainImage.alt = newAlt;
                    mainImage.style.opacity = '1';
                }, 150);
                
                // Update active thumb
                thumbImages.forEach(t => t.classList.remove('active'));
                this.classList.add('active');
            });
        });
        
        // Set first thumb as active
        thumbImages[0].classList.add('active');
    }
}

// Calendar event highlighting
function initializeCalendar() {
    const eventDays = document.querySelectorAll('.event-day');
    
    eventDays.forEach(day => {
        day.addEventListener('click', function() {
            // You could implement event details modal here
            showMessage('Event details would appear here in a full implementation.', 'info');
        });
    });
}

// Video player initialization for asset cards
function initializeVideoPlayers() {
    const playButtons = document.querySelectorAll('.play-button');
    
    playButtons.forEach(button => {
        button.addEventListener('click', function() {
            // In a real implementation, this would open a video modal or navigate to video page
            showMessage('Video player would open here in a full implementation.', 'info');
        });
    });
}

// Initialize additional features when DOM is ready
document.addEventListener('DOMContentLoaded', function() {
    initializeGallery();
    initializeCalendar();
    initializeVideoPlayers();
});

// Handle language change events for dynamic content
document.addEventListener('languageChanged', function(event) {
    const newLang = event.detail.language;
    
    // Update any dynamic content that might not have data-translate attributes
    updateDynamicContent(newLang);
    
    // Update form placeholders that might be dynamically generated
    updateFormPlaceholders(newLang);
});

function updateDynamicContent(lang) {
    // Update any dynamic content like dates, numbers, etc.
    const dateElements = document.querySelectorAll('.date, .asset-date, .resource-date');
    dateElements.forEach(element => {
        // You could implement date localization here
        // For now, keeping the original format
    });
}

function updateFormPlaceholders(lang) {
    // Update form placeholders that might not have data-translate
    const forms = document.querySelectorAll('form');
    forms.forEach(form => {
        const inputs = form.querySelectorAll('input, textarea');
        inputs.forEach(input => {
            if (!input.hasAttribute('data-translate')) {
                // Add basic placeholder translations
                if (input.type === 'email' && !input.placeholder) {
                    input.placeholder = lang === 'ar' ? 'أدخل عنوان البريد الإلكتروني' : 'Enter your email';
                }
            }
        });
    });
}

// Error handling
window.addEventListener('error', function(e) {
    console.error('JavaScript error:', e.error);
    // In production, you might want to send this to an error reporting service
});

// Performance monitoring
window.addEventListener('load', function() {
    // Log page load time for performance monitoring
    if (window.performance && window.performance.timing) {
        const loadTime = window.performance.timing.loadEventEnd - window.performance.timing.navigationStart;
        console.log('Page load time:', loadTime + 'ms');
    }
});

// Service worker registration for better performance (optional)
if ('serviceWorker' in navigator) {
    window.addEventListener('load', function() {
        // You could register a service worker here for caching
        // navigator.serviceWorker.register('/sw.js');
    });
}

// Add CSS animation styles for slide effects
const style = document.createElement('style');
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

// Initialize Timeline Tabs
function initializeTimelineTabs() {
    const tabBtns = document.querySelectorAll('.tab-btn');
    const tabContents = document.querySelectorAll('.tab-content');
    
    if (tabBtns.length === 0) return;
    
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const targetTab = btn.getAttribute('data-tab');
            
            // Remove active class from all buttons and contents
            tabBtns.forEach(b => b.classList.remove('active'));
            tabContents.forEach(c => c.classList.remove('active'));
            
            // Add active class to clicked button and corresponding content
            btn.classList.add('active');
            const targetContent = document.getElementById(targetTab);
            if (targetContent) {
                targetContent.classList.add('active');
            }
        });
    });
}

// Initialize Calendar Navigation
function initializeCalendarNavigation() {
    const prevBtn = document.querySelector('.prev-month');
    const nextBtn = document.querySelector('.next-month');
    const monthTitle = document.querySelector('.calendar-header h3');
    
    if (!prevBtn || !nextBtn || !monthTitle) return;
    
    const months = [
        'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December'
    ];
    
    const arabicMonths = [
        'يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو',
        'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'
    ];
    
    let currentMonth = 6; // July (0-indexed)
    let currentYear = 2025;
    
    function updateCalendar() {
        const lang = document.documentElement.lang || 'en';
        const monthNames = lang === 'ar' ? arabicMonths : months;
        monthTitle.textContent = `${monthNames[currentMonth]} ${currentYear}`;
    }
    
    prevBtn.addEventListener('click', () => {
        currentMonth--;
        if (currentMonth < 0) {
            currentMonth = 11;
            currentYear--;
        }
        updateCalendar();
    });
    
    nextBtn.addEventListener('click', () => {
        currentMonth++;
        if (currentMonth > 11) {
            currentMonth = 0;
            currentYear++;
        }
        updateCalendar();
    });
    function generateCalendarDays(month, year) {
    const daysContainer = document.getElementById('calendar-days');
    daysContainer.innerHTML = ''; // Clear old days

    const daysInMonth = new Date(year, month + 1, 0).getDate(); // Total days in month
    const firstDayIndex = new Date(year, month, 1).getDay(); // 0 = Sunday, 1 = Monday...

    // Optional: Add empty spans before 1st day for alignment (assuming week starts on Sunday)
    for (let i = 0; i < firstDayIndex; i++) {
        const emptySpan = document.createElement('span');
        emptySpan.classList.add('empty');
        daysContainer.appendChild(emptySpan);
    }

    // Generate actual days
    for (let day = 1; day <= daysInMonth; day++) {
        const daySpan = document.createElement('span');
        daySpan.textContent = day;
        daysContainer.appendChild(daySpan);
    }
}

}

// Initialize Project Expansion (for Projects page)
function initializeProjectExpansion() {
    const projectHeaders = document.querySelectorAll('.project-header');
    
    projectHeaders.forEach(header => {
        header.addEventListener('click', () => {
            const projectItem = header.closest('.project-item');
            const content = projectItem.querySelector('.project-content');
            const expandBtn = header.querySelector('.expand-btn i');
            
            // Toggle expanded state
            projectItem.classList.toggle('expanded');
            
            if (projectItem.classList.contains('expanded')) {
                // Expand
                content.style.maxHeight = content.scrollHeight + 'px';
                expandBtn.style.transform = 'rotate(45deg)';
            } else {
                // Collapse
                content.style.maxHeight = '0px';
                expandBtn.style.transform = 'rotate(0deg)';
            }
        });
    });
}


    // Uncomment the line below to enable auto-scrolling
    // setInterval(autoScroll, 50);

  document.addEventListener("DOMContentLoaded", function () {
    const buttons = document.querySelectorAll('.tab-btn');
    const contents = document.querySelectorAll('.tab-content');

    buttons.forEach(button => {
      button.addEventListener('click', () => {
        // Remove 'active' from all buttons
        buttons.forEach(btn => btn.classList.remove('active'));

        // Remove 'active' from all contents
        contents.forEach(content => content.classList.remove('active'));

        // Add 'active' to clicked button
        button.classList.add('active');

        // Show the matching content
        const targetId = button.getAttribute('data-tab');
        const targetContent = document.getElementById(targetId);
        if (targetContent) {
          targetContent.classList.add('active');
        }
      });
    });
  });
  // Contact form functionality
function initializeContactForm() {
    const form = document.getElementById('contactForm');

    if (form) {
        form.addEventListener('submit', function(e) {
            e.preventDefault();
            
            // Get form data
            const formData = new FormData(form);
            const data = Object.fromEntries(formData);
            
            // Validate required fields
            const requiredFields = ['firstName', 'lastName', 'email', 'subject', 'message'];
            const missingFields = requiredFields.filter(field => !data[field]);
            
            if (missingFields.length > 0) {
                showMessage('Please fill in all required fields.', 'error');
                return;
            }

            // Validate email
            if (!validateEmail(data.email)) {
                showMessage('Please enter a valid email address.', 'error');
                return;
            }

            // Show loading state
            const submitButton = form.querySelector('button[type="submit"]');
            showLoading(submitButton, true);
            
            // Simulate form submission
            setTimeout(() => {
                showLoading(submitButton, false);
                form.reset();
                showMessage('Thank you for your message! We\'ll get back to you soon.', 'success');
            }, 2000);
        });
    }
}

const form = document.getElementById("contact-form");
const statusDiv = document.getElementById("status");

// غيري هذا الرابط برابط الفورم الخاص في Formspree
const formspreeURL = "";

form.addEventListener("submit", function (e) {
  e.preventDefault();

  const formData = new FormData(form);

  fetch(formspreeURL, {
    method: "POST",
    body: formData,
    headers: {
      'Accept': 'application/json'
    },
  })
    .then(response => {
      if (response.ok) {
        statusDiv.innerText = "Message sent successfully! 😊";
        form.reset();
      } else {
        response.json().then(data => {
          if (data.errors) {
            statusDiv.innerText = data.errors.map(error => error.message).join(", ");
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


  setTimeout(() => {
    newsletterWidget.classList.remove('open');
    newsletterWidget.classList.add('closed');
    openBtn.classList.remove('hidden');
    successMsg.style.display = 'none';
    form.style.display = 'flex';
    form.reset();
  }, 3000); 
document.querySelectorAll('.calendar-nav button').forEach(button => {
  button.addEventListener('click', function () {
    alert('Button clicked!');
    // أو تغيير الشهر مثلاً
  });
});

// ننتظر تحميل كل عناصر الصفحة
document.addEventListener('DOMContentLoaded', function() {

  // إضافة تأثير hover قوي لكل project-item (اختياري)
  document.querySelectorAll('.project-item').forEach(item => {
    item.addEventListener("mouseenter", () => {
      item.style.transform = "scale(1.05) rotate(-1deg)";
      item.style.boxShadow = "0 12px 30px rgba(22,160,133,0.4)";
    });
    item.addEventListener("mouseleave", () => {
      item.style.transform = "scale(1) rotate(0)";
      item.style.boxShadow = "0 3px 10px rgba(0,0,0,0.05)";
    });
  });

  // دالة لتبديل عرض الملفات وتغيير أيقونة الزر
  function toggleFiles(button){
    const project = button.closest('.project-item');
    const icon = button.querySelector('i');
    project.classList.toggle('expanded');
    if(project.classList.contains('expanded')){
      icon.classList.replace('fa-plus','fa-minus');
    } else {
      icon.classList.replace('fa-minus','fa-plus');
    }
  }

  // إضافة حدث لكل header لفتح الملفات عند الضغط
  document.querySelectorAll('.project-header').forEach(header => {
    header.addEventListener('click', function(e) {
      // منع الضغط على أي عناصر داخل header من إيقاف عمل الزر
      const btn = header.querySelector('.expand-btn');
      toggleFiles(btn);
    });
  });

});(() => {
  const form = document.getElementById('lab-subscribe');
  const wrap = form.querySelector('.input-wrap');
  const email = form.querySelector('#lab-email');
  const msg = document.getElementById('lab-message');

  const isValid = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

  email.addEventListener('input', () => {
    wrap.classList.remove('error','success','loading');
    msg.textContent=''; msg.className='form-message';
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const v = email.value.trim();

    if (!isValid(v)){
      wrap.classList.add('error');
      msg.textContent='Please enter a valid email.'; msg.className='form-message error';
      email.focus(); return;
    }

    // loading state
    wrap.classList.add('loading');
    email.readOnly = true;

    try{
      const res = await fetch(form.action || '/api/subscribe', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ email: v })
      });
      if(!res.ok) throw new Error();

      wrap.classList.remove('loading'); wrap.classList.add('success');
      msg.textContent='Thanks! Check your inbox to confirm.'; msg.className='form-message success';
      form.reset();
    }catch{
      wrap.classList.remove('loading');
      msg.textContent='Something went wrong. Try again.'; msg.className='form-message error';
    }finally{
      email.readOnly = false;
    }
  });

document.addEventListener("DOMContentLoaded", () => {
  // اختار كل الصور بالصفحة
  const images = document.querySelectorAll("img");

  // ✅ أولاً: حمل كل الصور بالخلفية فوراً
  images.forEach(img => {
    const src = img.getAttribute("data-src") || img.src;
    if (src) {
      const preImg = new Image();
      preImg.src = src;
    }
  });

  // ✅ ثانياً: بدّل الصور المأجلة (data-src → src) بسرعة عند ظهورها
  const options = { rootMargin: "250px", threshold: 0.1 };
  const observer = new IntersectionObserver((entries, obs) => {
    entries.forEach(entry => {
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
  images.forEach(img => observer.observe(img));

  // ✅ ثالثاً: خزّن الصور بالكاش حتى تفتح فوراً في المرات القادمة
  window.addEventListener("load", () => {
    if ("caches" in window) {
      caches.open("instant-image-cache").then(cache => {
        images.forEach(img => {
          const src = img.getAttribute("data-src") || img.src;
          if (src) {
            fetch(src)
              .then(res => {
                if (res.ok) cache.put(src, res);
              })
              .catch(() => null);
          }
        });
      });
    }
  });
});


})
();


