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
