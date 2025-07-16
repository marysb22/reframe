# Reframe MHS - Mental Health Services Website

## Overview

This is a professional mental health services website for Reframe MHS, a mental health organization serving the Middle East. The website provides information about services, insights, events, projects, and includes a professional hub for mental health practitioners. The site is designed to be fully bilingual (English/Arabic) with proper RTL support.

## User Preferences

Preferred communication style: Simple, everyday language.

## System Architecture

### Frontend Architecture
- **Static Website**: Pure HTML, CSS, and JavaScript implementation
- **Multi-page Architecture**: Traditional multi-page website with shared navigation and styling
- **Responsive Design**: Mobile-first approach with hamburger navigation for mobile devices
- **Bilingual Support**: Complete English/Arabic language switching with RTL layout support

### Key Technologies
- **HTML5**: Semantic markup with proper accessibility attributes
- **CSS3**: Modern CSS with custom properties, flexbox, and grid layouts
- **Vanilla JavaScript**: No frameworks, pure JavaScript for interactivity
- **Font Integration**: Google Fonts (Inter for Latin, Noto Sans Arabic for Arabic text)
- **Icon System**: Font Awesome for iconography

## Key Components

### Navigation System
- Fixed navigation bar with responsive design
- Hamburger menu for mobile devices
- Overlay menu system for mobile navigation
- Language switcher (EN/AR) with visual indicators
- Active page highlighting

### Language System
- Complete bilingual support (English/Arabic)
- RTL (Right-to-Left) layout switching for Arabic
- Translation system using JavaScript objects
- Language preference persistence via localStorage
- Smooth language switching without page reload

### Page Structure
- **Home (index.html)**: Main landing page with hero section
- **About (about.html)**: Organization information and mission
- **Insights (insights.html)**: Expert content and resources
- **Events (events.html)**: Training events and workshops
- **Projects (projects.html)**: Research projects and initiatives
- **Hub (hub.html)**: Professional resources and community
- **Contact (contact.html)**: Contact information and forms

### Styling System
- **Color Palette**: Professional mental health-focused colors
- **Typography**: Inter font family for Latin text, Noto Sans Arabic for Arabic
- **Layout**: Flexbox and Grid-based responsive layouts
- **Animations**: Smooth transitions and hover effects
- **Accessibility**: ARIA labels, semantic HTML, keyboard navigation

## Data Flow

### Language Switching
1. User clicks language button (EN/AR)
2. JavaScript updates HTML lang and dir attributes
3. All translatable elements are updated using data-translate attributes
4. CSS adjusts layout for RTL when Arabic is selected
5. Language preference is saved to localStorage

### Navigation
1. User interacts with navigation elements
2. Active states are managed through CSS classes
3. Mobile menu toggles visibility through JavaScript
4. Smooth scrolling and page transitions

### Form Handling
- Contact forms with validation
- Newsletter signup functionality
- Form submission handling through JavaScript

## External Dependencies

### CDN Resources
- **Google Fonts**: Inter and Noto Sans Arabic font families
- **Font Awesome**: Icon library (v6.0.0)
- **http-server**: Local development server (Node.js dependency)

### Font Integration
- Inter font for English/Latin text (weights: 300, 400, 500, 600, 700)
- Noto Sans Arabic for Arabic text (weights: 300, 400, 500, 600, 700)

## Deployment Strategy

### Development Environment
- **Local Server**: Uses http-server for local development
- **File Structure**: Traditional static website structure
- **Asset Organization**: Separate directories for styles, scripts, and assets

### Production Considerations
- Static files can be deployed to any web server
- No server-side processing required
- CDN integration for fonts and icons
- Proper meta tags and SEO optimization included

### Performance Optimization
- Optimized font loading with display=swap
- Minimal JavaScript for core functionality
- CSS custom properties for consistent theming
- Responsive images and layouts

### Accessibility Features
- ARIA labels and semantic HTML
- Keyboard navigation support
- Screen reader compatibility
- High contrast color scheme
- Proper heading hierarchy

## Technical Notes

### Bilingual Implementation
- Uses data-translate attributes for all translatable content
- JavaScript translation system with comprehensive language objects
- RTL layout support with CSS direction switching
- Font family switching based on language selection

### Mobile Responsiveness
- Hamburger navigation for mobile devices
- Overlay menu system
- Touch-friendly interface elements
- Responsive typography and spacing

### Browser Compatibility
- Modern browsers with CSS Grid and Flexbox support
- Progressive enhancement approach
- Graceful degradation for older browsers