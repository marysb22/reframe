// Reframe MHS -- bilingual (EN/AR) translation dictionary.
// Consumed by scripts/main.js (switchLanguage) via data-translate /
// data-translate-placeholder / data-translate-option / data-translate-content
// attributes on the 9 public pages (index/about/contact/hub/events/projects/t/
// Training-Modules/login). Keys are grouped by their prefix purely for human
// navigation -- grouping has no effect on lookup.
//
// Deduplicated 2026 from a version of this file that had ~90 keys defined
// twice (sometimes 3x) with different values -- in a JS object literal the
// last occurrence silently wins, so the earlier ones were dead, confusing
// weight with no effect. This version keeps exactly the values that were
// already active, just without the duplicates. Also dropped hero_subtitle
// (en/ar): unused anywhere on the site, word-for-word duplicate content of
// hero_paragraph, and its ar value was a landmine empty string.

const translations = {
  en: {
    // ===== a11y =====
    "a11y_skip_link": "Skip to main content",

    // ===== about =====
    "about_hero_subtitle": "We envision a future where mental health is the foundation of every human system, and where challenges and failures are embraced as opportunities for growth and transformation.",
    "about_hero_title": "About Reframe MHS",

    // ===== accreditation =====
    "accreditation_cta_button": "Book Now",
    "accreditation_cta_text": "Contact us today and make your next event a success in every sense.",
    "accreditation_cta_title": "Are you ready to reserve your spot?",
    "accreditation_desc_1": "Reframe has been officially accredited by the Lebanese Order of Psychologists (LOPsy) as a Training Center in Systemic Psychotherapy, from October 1, 2025 to October 31, 2027.",
    "accreditation_desc_2": "This accreditation reflects our ongoing commitment to excellence, integrity, and evidence-based practice in the field of mental health and it reinforces our mission to empower professionals across the Middle East through high-quality, culturally relevant training and supervision.",
    "accreditation_desc_3": "We extend our heartfelt thanks to our team, supervisors, and community for being part of this journey. Together, we’re shaping a future where mental health education and practice are accessible, ethical, and deeply human.",
    "accreditation_hashtags": "#Accreditation #LOPsy #SystemicPsychotherapy #ProfessionalDevelopment #MentalHealthLebanon",
    "accreditation_title": "We’re proud to share our accreditation!",

    // ===== author =====
    "author_dr_ahmed": "Dr. Ahmed Hassan",
    "author_reframe_team": "Reframe Team",

    // ===== blog =====
    "blog_post_1_title": "Three Communication Tips for a Global Team",
    "blog_post_2_title": "Compliance Corner: Looking Beyond the Paperwork",
    "blog_post_3_title": "A Journey Through the Middle East – A Reflection on Reframe's Regional Impact",

    // ===== calendar =====
    "calendar_event1_title": "Peacebuilding & Psychosocial Support",
    "calendar_event2_title": "Eating Disorder Care Training",
    "calendar_fri": "Fri",
    "calendar_mon": "Mon",
    "calendar_sat": "Sat",
    "calendar_subtitle": "View our upcoming training sessions and workshops",
    "calendar_sun": "Sun",
    "calendar_this_month": "This Month's Events",
    "calendar_thu": "Thu",
    "calendar_title": "Upcoming Events",
    "calendar_tue": "Tue",
    "calendar_view_all": "View All Events",
    "calendar_wed": "Wed",

    // ===== category =====
    "category_conferences_count": "2+ Conferences",
    "category_conferences_description": "Multi-day conferences bringing together experts and practitioners from across the region.",
    "category_conferences_title": "Conferences",
    "category_hands_on": "Hands-on Learning",
    "category_networking": "Networking Opportunities",
    "category_online_count": "20+ Online Events",
    "category_online_description": "Virtual training sessions and webinars accessible from anywhere in the Middle East.",
    "category_online_title": "Online Sessions",
    "category_remote": "Remote Access",
    "category_training_count": "15+ Programs",
    "category_training_description": "Comprehensive training sessions covering various aspects of mental health care and therapy techniques.",
    "category_training_title": "Training Programs",
    "category_workshops_count": "10+ Workshops",
    "category_workshops_description": "Interactive workshops focused on specific skills and techniques for mental health professionals.",
    "category_workshops_title": "Workshops",

    // ===== changing =====
    "changing_words_1": "Individual Support",
    "changing_words_2": "Organizational Services",
    "changing_words_3": "Group Support",
    "changing_words_4": "Specialized Interventions",
    "changing_words_5": "Workshops & Training",

    // ===== close =====
    "close": "Close",

    // ===== consultations =====
    "consultations_about_subtitle": "Technical Consultations",
    "consultations_about_title": "About Us",
    "consultations_changing_word": "Vision",
    "consultations_group_1": "Stress management sessions (post-crisis, burnout, workload).",
    "consultations_group_2": "Peer support groups (safe space to share experiences).",
    "consultations_group_3": "Resilience circles using art, storytelling, and movement.",
    "consultations_group_4": "Team-building with therapeutic methods.",
    "consultations_group_title": "Group Support",
    "consultations_hero_subtitle": "Bringing resources, relational health, and systemic harmony to support your teams.",
    "consultations_hero_title": "Technical Consultations",
    "consultations_individual_1": "Confidential counseling sessions (short-term, solution-focused).",
    "consultations_individual_2": "Psychological first aid for staff exposed to crises.",
    "consultations_individual_3": "Coaching for stress management and resilience.",
    "consultations_individual_4": "Referrals and follow-up support when needed.",
    "consultations_individual_title": "Individual Support",
    "consultations_org_1": "Psychosocial risk assessments.",
    "consultations_org_2": "Monitoring and evaluation system for staff well-being.",
    "consultations_org_3": "Management reports: risks, staff needs, recommendations.",
    "consultations_org_4": "Mediation during workplace conflicts.",
    "consultations_org_5": "Policy consultation: integration of mental health into HR systems (leave, workload, flexibility).",
    "consultations_org_6": "Designing well-being strategies aligned with institutional requirements.",
    "consultations_org_title": "Organizational Services",
    "consultations_services_title": "Our Services",
    "consultations_special_1": "Thematic staff-care days (art, music, mindfulness).",
    "consultations_special_2": "Support for managers on leading with mental health awareness.",
    "consultations_special_3": "Transition support for staff leaving organizations.",
    "consultations_special_4": "Emergency response packages for crises.",
    "consultations_special_5": "Supervision for MHPSS staff and frontline workers.",
    "consultations_special_title": "Specialized Interventions",
    "consultations_workshops_1": "Stress management & burnout prevention.",
    "consultations_workshops_2": "Resilience skills for high-pressure environments.",
    "consultations_workshops_3": "Emotional regulation & coping strategies.",
    "consultations_workshops_4": "Trauma-informed care for high-stress contexts.",
    "consultations_workshops_5": "Mental health awareness & stigma reduction.",
    "consultations_workshops_6": "Conflict resolution & communication skills.",
    "consultations_workshops_7": "Self-care and boundaries setting.",
    "consultations_workshops_8": "Mental health emergency response training.",
    "consultations_workshops_title": "Workshops & Training",

    // ===== contact =====
    "contact_address_text": "Traboulsi street, Calot center, 8th floor, Badaro, Beirut, Lebanon",
    "contact_address_title": "Address",
    "contact_email_title": "Email",
    "contact_form_title": "Send us a Message",
    "contact_hero_subtitle": "Ready to start your journey or learn more about our services? We're here to help.",
    "contact_hero_title": "Get in Touch",
    "contact_info_title": "Contact Information",
    "contact_phone_title": "Phone",

    // ===== core =====
    "core_values_collaboration_desc": "We believe in the power of collaboration and community, actively working with partners and clients to co-design and co-achieve shared goals. Our commitment to teamwork enhances connections and drives collective success.",
    "core_values_collaboration_title": "Collaboration and Community",
    "core_values_empathy_desc": "We are dedicated to fostering understanding and compassion in all our interactions, creating a supportive and nurturing environment for everyone we engage with. Our commitment ensures that all individuals feel valued and cared for, promoting healthy relationships and growth.",
    "core_values_empathy_title": "Empathy and Compassion",
    "core_values_evidence_desc": "We provide services and programs grounded in evidence-based approaches to ensure effectiveness and sustainability.",
    "core_values_evidence_title": "Evidence-Based Practice",
    "core_values_inclusivity_desc": "We embrace diversity and cultivate an inclusive environment that respects and values both individual uniqueness and our shared human experiences. By fostering inclusivity, we promote understanding and connection among all individuals, enhancing the overall community experience.",
    "core_values_inclusivity_title": "Inclusivity and Diversity",
    "core_values_innovation_desc": "We are committed to innovative practices that enhance mental health services and improve impact.",
    "core_values_innovation_title": "Innovation Excellence",
    "core_values_integrity_desc": "We act with honesty, transparency, and respect in all our endeavors, ensuring trust and authenticity in every interaction.",
    "core_values_integrity_title": "Integrity and Authenticity",
    "core_values_resilience_desc": "We help individuals and organizations embrace challenges as opportunities for development and sustainable progress.",
    "core_values_resilience_title": "Resilience and Growth",
    "core_values_title": "CORE VALUES",

    // ===== day =====
    "day_fri": "Fri",
    "day_mon": "Mon",
    "day_sat": "Sat",
    "day_sun": "Sun",
    "day_thu": "Thu",
    "day_tue": "Tue",
    "day_wed": "Wed",

    // ===== download =====
    "download": "Download",

    // ===== email =====
    "email_label": "Email Address",
    "email_placeholder": "Enter your email",

    // ===== event =====
    "event_1_description": "This comprehensive training will equip mental health professionals with practical tools and strategies for supporting children in conflict-affected areas. Learn evidence-based approaches to peacebuilding and psychosocial support.",
    "event_1_title": "Peacebuilding and Psychosocial Support for Children: A Practical Toolkit",
    "event_2_description": "Essential training for dietitians and healthcare professionals on eating disorder treatment approaches. Learn to recognize signs, provide appropriate support, and collaborate effectively with mental health professionals.",
    "event_2_title": "The Invisible Weight: Foundations of Eating Disorder Care for Dietitians",
    "event_categories_subtitle": "Explore our diverse range of professional development opportunities",
    "event_categories_title": "Event Categories",
    "event_certificate": "Certificate Provided",
    "event_duration_1h": "1 Hour",
    "event_duration_2h": "2 Hours",
    "event_max_25": "Max 25 Participants",
    "event_max_30": "Max 30 Participants",
    "event_register": "Register Now",
    "event_type_training": "Training",

    // ===== event1 =====
    "event1_about": "As a dietitian, you may be one of the first, and sometimes the only, professionals clients struggling with disordered eating turn to. \nYet many in the field receive limited training on how to recognize, support, or refer those navigating eating disorders. \nThis workshop is designed to bridge that gap.",
    "event1_date": "Jul 3",
    "event1_facilitator": "Dr. Tala Abdallah",
    "event1_facilitatorBio": "Dr. Tala Abdallah is a UK-licensed Clinical Psychologist and Lebanese-licensed Dietitian with over a decade of experience across psychology and nutrition. Founder of Ginger & Walnut, she blends gut and mental health for holistic healing.",
    "event1_fee": "Workshop Fee: Starting $20 contribution",
    "event1_format": "Zoom Link via Reframe",
    "event1_learn_1": "Recognize signs of disordered eating and understand when and how to refer to mental health professionals",
    "event1_learn_2": "Clarify your role as a dietitian in the eating disorder treatment process",
    "event1_learn_3": "Gain an overview of screening, assessment, and intervention techniques used in eating disorder care",
    "event1_outcome_1": "Increased confidence in supporting clients with disordered eating",
    "event1_outcome_2": "Clearer understanding of how to navigate conversations around food and body image",
    "event1_outcome_3": "Practical tools to provide compassionate, non-harmful care",
    "event1_register": "Register Now",
    "event1_title": "Peacebuilding & Psychosocial Support",
    "event1_who_1": "Registered Dietitians",
    "event1_who_2": "Nutritionists",
    "event1_who_3": "Dietetic Students",
    "event1_who_4": "Health professionals working in clinical or outpatient nutrition settings",

    // ===== event2 =====
    "event2_date": "Jul 30",
    "event2_title": "Eating Disorder Care Training",

    // ===== events =====
    "events_hero_subtitle": "Join our professional development programs, workshops, and training sessions designed for mental health professionals",
    "events_hero_title": "Upcoming Events",
    "events_this_month": "This Month's Events",
    "events_title": "Upcoming Training Sessions",
    "events_view_all": "View All Events",

    // ===== featured =====
    "featured_assets_subtitle": "See what's new in our industry-leading library of mental health and well-being self-care tools.",
    "featured_assets_title": "Featured assets",
    "featured_events_subtitle": "Don't miss these upcoming professional development opportunities",
    "featured_events_title": "Featured Events",
    "featured_insights_subtitle": "Take advantage of our expert insights to take your organization to the next level.",
    "featured_insights_title": "Featured insights",

    // ===== footer =====
    "footer_brand": "Reframe MHS",
    "footer_connect": "Connect",
    "footer_consultation": "Consultation",
    "footer_credit": "Website designed & developed by",
    "footer_description": "Unlocking the innate potential and resilience within each person and group across the Middle East.",
    "footer_quick_links": "Quick Links",
    "footer_resources": "Resources",
    "footer_rights": "All rights reserved.",
    "footer_services": "Services",
    "footer_subscribe_btn": "Subscribe",
    "footer_subscribe_placeholder": "Enter your email",
    "footer_subscribe_text": "Subscribe to our newsletter for updates, workshops, and events.",
    "footer_subscribe_title": "Stay Connected",
    "footer_training": "Training Programs",
    "footer_workshops": "Workshops",

    // ===== forgot =====
    "forgot_password": "Forgot password?",

    // ===== form =====
    "form_email": "Email Address",
    "form_first_name": "First Name",
    "form_last_name": "Last Name",
    "form_message": "Message",
    "form_phone": "Phone Number",
    "form_select_subject": "Select a subject",
    "form_subject": "Subject",
    "form_subject_consultation": "Consultation Services",
    "form_subject_general": "General Inquiry",
    "form_subject_placeholder": "Select a subject",
    "form_subject_research": "Research Collaboration",
    "form_subject_training": "Training Programs",
    "form_submit": "Send Message",

    // ===== guidance =====
    "guidance_insights_subtitle": "See what's new and emerging in employee well-being.",
    "guidance_insights_title": "Guidance insights",

    // ===== hero =====
    "hero_cta_learn": "Learn More",
    "hero_paragraph": "Professional mental health services and training programs designed for the unique cultural context of the Middle East.",
    "hero_title": "Unlocking the innate potential and resilience within each person and group",

    // ===== hub =====
    "hub_community_description": "Connect with fellow practitioners, share experiences, and collaborate on best practices across the region.",
    "hub_community_title": "Professional Community",
    "hub_cta_btn": "Book Now",
    "hub_cta_text": "Contact us today and make your next event a success.",
    "hub_cta_title": "Ready to Book Your Space?",
    "hub_development_description": "Access online courses, webinars, and certification programs to advance your professional skills.",
    "hub_development_title": "Continuing Education",
    "hub_download": "Download Tools",
    "hub_explore": "Explore Resources",
    "hub_feature_1": "Seating for Over 20 Guests",
    "hub_feature_2": "High-Quality Screen",
    "hub_feature_3": "Welcoming Reception Area",
    "hub_feature_4": "Conference Camera",
    "hub_feature_5": "Beverage Bar",
    "hub_feature_6": "24/7 High-Speed Internet",
    "hub_feature_7": "Prime Central Location",
    "hub_feature_8": "Complete Privacy",
    "hub_features_title": "Key Features",
    "hub_hero_cta": "Discover More",
    "hub_hero_subtitle": "Looking for the perfect venue to host your next meeting, conference, or workshop? Reframe Hub is your ideal space, designed to meet your professional needs with comfort and convenience.",
    "hub_hero_title": "Reframe Hub",
    "hub_join": "Join Community",
    "hub_learn": "Start Learning",
    "hub_resources_description": "Access our comprehensive library of assessment tools, treatment protocols, and evidence-based resources.",
    "hub_resources_title": "Professional Resources",
    "hub_services_subtitle": "Comprehensive resources designed for mental health professionals",
    "hub_services_title": "What You'll Find Here",
    "hub_tools_description": "Download validated assessment instruments and screening tools adapted for Middle Eastern populations.",
    "hub_tools_title": "Assessment Tools",
    "hub_why_desc": "Looking for the perfect venue to host your next meeting, conference, or workshop? Reframe Hub is your ideal space, designed to meet your professional needs with comfort and convenience.",
    "hub_why_title": "Why Choose Reframe Hub?",

    // ===== insights =====
    "insights_hero_cta": "Subscribe now",
    "insights_hero_title": "Our experience paired with our industry leading data means insights you can trust",

    // ===== lab =====
    "lab_collaboration_question": "Would you like to collaborate with us?",
    "lab_desc": "Join our innovative research initiatives to advance mental health care in the Middle East region.",
    "lab_email_label": "Email address",
    "lab_email_placeholder": "you@example.com",
    "lab_title": "Mental Health Lab",

    // ===== location =====
    "location_title": "Find Us",

    // ===== login =====
    "login_btn": "Sign In",
    "login_header_subtitle": "Interested in working together? Fill out some info and we will be in touch shortly! We can't wait to hear from you",
    "login_header_title": "Welcome to Reframe",

    // ===== milestone1 =====
    "milestone1_desc": "Corporations, NGOs, and healthcare institutions",
    "milestone1_title": "15+ Organizations",

    // ===== milestone2 =====
    "milestone2_desc": "Active studies and assessment tool development",
    "milestone2_title": "2+ Projects",

    // ===== milestone3 =====
    "milestone3_desc": "Trained across multiple countries",
    "milestone3_title": "500+ Professionals",

    // ===== milestone4 =====
    "milestone4_desc": "Regional presence and collaborations",
    "milestone4_title": "6 Countries",

    // ===== milestones =====
    "milestones_subtitle": "Celebrating our journey and impact in the mental health field",
    "milestones_title": "Our Milestones to Date",

    // ===== mission =====
    "mission_description": "We provide evidence-based and culturally adapted mental health approaches that empower individuals, groups, and organizations to navigate challenges and reach their highest potential.",
    "mission_title": "Our Mission",

    // ===== month =====
    "month_jul": "Jul",

    // ===== msg =====
    "msg_contact_success": "Thank you for your message! We'll get back to you soon.",
    "msg_event_details_placeholder": "Event details would appear here in a full implementation.",
    "msg_formspree_success": "Message sent successfully! 😊",
    "msg_generic_error": "Something went wrong. Try again.",
    "msg_invalid_email": "Please enter a valid email address.",
    "msg_invalid_email_short": "Please enter a valid email.",
    "msg_loading": "Loading...",
    "msg_newsletter_success": "Thank you for subscribing! We'll keep you updated.",
    "msg_required_fields": "Please fill in all required fields.",
    "msg_send_error": "Oops! There was a problem sending your message.",
    "msg_subscribe_confirm": "Thanks! Check your inbox to confirm.",
    "msg_video_placeholder": "Video player would open here in a full implementation.",

    // ===== nav =====
    "nav_about": "About",
    "nav_consultations": "Technical Consultations",
    "nav_contact": "Contact",
    "nav_home": "Home",
    "nav_hub": "Hub",
    "nav_hub_reframe": "Hub Reframe",
    "nav_login": "Login",
    "nav_mhlab": "Mental Health Lab",
    "nav_services": "Services",
    "nav_training": "Training",

    // ===== need =====
    "need_help_text": "Contact our support team for assistance with your account.",
    "need_help_title": "Need Help?",

    // ===== newsletter =====
    "newsletter_events_cta": "Get Notified",
    "newsletter_events_subtitle": "Subscribe to receive notifications about upcoming training sessions, workshops, and conferences.",
    "newsletter_events_title": "Stay Updated on Events",
    "newsletter_insights_cta": "Stay informed",
    "newsletter_insights_subtitle": "Subscribe here to keep up on all the latest at Reframe MHS news, including access to our award-winning webinars and insights.",
    "newsletter_insights_title": "Access our webinars & insights",

    // ===== no =====
    "no_account_text": "Don't have an account?",
    "no_self_register_text": "Accounts are issued by program administration. Contact support if you need access.",

    // ===== our =====
    "our_packages_title": "Our Packages",

    // ===== package =====
    "package_pro_desc": "Two-day intensive training focused on enhancing clinical skills.",
    "package_pro_price": "In-Person: $150 | Online: $80",
    "package_pro_title": "Professional Growth Package: Advanced Techniques",
    "package_special_desc": "Three-day workshop covering trauma, grief, and more.",
    "package_special_price": "In-Person: $200 | Online: $120",
    "package_special_title": "Specialized Focus Package",
    "package_starter_desc": "A one-day foundational workshop for mental health professionals.",
    "package_starter_price": "In-Person: $80 | Online: $60",
    "package_starter_title": "Starter Package: Basic Training",
    "package_support_desc": "Monthly supervision, peer support for professional growth.",
    "package_support_price": "$100 per session",
    "package_support_title": "Support Circle Package: Monthly Peer Sessions",

    // ===== page =====
    "page_description_about": "Learn about Reframe MHS mission, vision, and our team of mental health professionals in the Middle East.",
    "page_description_consultations": "Professional technical consultations for corporations, focusing on staff well-being, resilience, and organizational success.",
    "page_description_contact": "Get in touch with Reframe MHS for mental health services, training programs, and collaboration opportunities.",
    "page_description_home": "Professional mental health services and training programs across the Middle East. Unlocking potential and resilience.",
    "page_description_hub": "Professional resources, tools, and community hub for mental health practitioners in the Middle East.",
    "page_description_projects": "Explore our research projects and initiatives advancing mental health services across the Middle East.",
    "page_title_about": "About Us - Reframe MHS",
    "page_title_consultations": "Technical Consultations - Reframe MHS",
    "page_title_contact": "Contact - Reframe MHS",
    "page_title_home": "Reframe MHS - Mental Health Services",
    "page_title_hub": "Hub - Reframe MHS",
    "page_title_projects": "Projects - Reframe MHS",

    // ===== partners =====
    "partners_subtitle": "Building stronger communities through strategic partnerships",
    "partners_title": "Our Partners & Collaborations",

    // ===== password =====
    "password_label": "Password",
    "password_placeholder": "Enter your password",

    // ===== plan =====
    "plan_text": "Reframe’s vision for 2025-2030 rests on three pillars: systemic therapy leadership, the Work-Well Seal for mentally healthy workplaces, and culturally adapted programmes based on annual needs assessments. These efforts aim to strengthen mental health services across the MENA region and empower communities to thrive despite complex challenges.",
    "plan_title": "Strategic Plan 2025-2030",
    "plan_view_btn": "View Full Plan",

    // ===== project1 =====
    "project1_file1": "Development of the Reframe and Altpsy questionnaire",
    "project1_file2": "Questionnaire for panic attacks",
    "project1_file3": "Panic attacks - additional file",
    "project1_file4": "Crisis management for severe anxiety",
    "project1_file5": "Ethics Committee Approval",
    "project1_file6": "Panic Scale Validation",
    "project1_file7": "Reframe Questionnaire (AltPsy)",
    "project1_file8": "Study Introduction",
    "project1_title": "MH LAB, project one: Developing a panic attack scale for the Lebanese and Arabic context",

    // ===== projects =====
    "projects_hero_subtitle": "The Mental Health Lab is a non-profit dedicated to advancing mental health research and practice. We conduct studies and experiments that generate evidence tailored to the cultural and social realities of our community.",
    "projects_hero_title": "The Mental Health Lab",

    // ===== register =====
    "register_btn": "Create Account",
    "register_email_label": "Email",
    "register_name_label": "Full Name",
    "register_note": "All submissions will be securely stored and viewable in Reframe's dashboard.",
    "register_profession_label": "Profession / Title",
    "register_submit": "Submit Registration",
    "register_title": "Register for Training",

    // ===== remember =====
    "remember_me": "Remember me",

    // ===== supervision =====
    "supervision_best_desc": "Practicing psychotherapists seeking supervision and clinical support.",
    "supervision_best_title": "Best suited for:",
    "supervision_desc": "Supervision services focus on supporting ethical, reflective, and effective clinical practice.",
    "supervision_focus_1": "Case discussion and formulation",
    "supervision_focus_2": "Clinical reflection",
    "supervision_focus_3": "Professional development and ethical practice",
    "supervision_focus_title": "Focus areas include:",
    "supervision_format_1": "Individual or group supervision",
    "supervision_format_2": "Online or in-person",
    "supervision_format_title": "Format:",
    "supervision_subtitle": "Individual and group supervision for psychotherapists",
    "supervision_title": "Supervision Services",

    // ===== support =====
    "support_link": "Get Support",

    // ===== team =====
    "team_ali_bio": "A distinguished clinical psychologist and psychotherapist, he is deeply committed to improving mental health services in the Arab world. Ali has successfully partnered with various businesses, organizations, and UN agencies to create and execute impactful mental health and psychosocial support (MHPSS) initiatives across the Middle East and Africa. In his role leading our Mental Health Lab, Ali is recognized for his innovative approach to program development and his effective management of teams. His leadership ensures the provision of culturally sensitive and scientifically backed mental health interventions that have a profound positive impact on communities and individuals in need.",
    "team_ali_name": "Ali El Attar",
    "team_ali_role": "Founder and Manager, Head of the Mental Health Lab",
    "team_bertha_bio": "Bertha Missyadi is a seasoned expert in quality assurance and program management. She has collaborated closely with international organizations, NGOs, and UN entities across Asia, Central America, the United States, Europe, Africa, and the Middle East. Bertha brings strong expertise in program development, crafting theories of change (TOC), and developing MHPSS policies, strategies, and manuals. She is also experienced in establishing staff care systems and strengthening team capacity through coaching and supervision.",
    "team_bertha_name": "Bertha Missyadi",
    "team_bertha_role": "Quality Control Manager",
    "team_linkedin_btn": "LinkedIn",
    "team_mary_bio": "Marie-Adele is a specialist in Mental Health and Psychosocial Support (MHPSS). Since 2006, she has dedicated her career to implementing resource-based approaches in MHPSS, collaborating across NGOs, UN agencies, and diverse cultural settings. She has worked in Asia, Africa, the Middle East, Latin America, and Europe.",
    "team_mary_name": "Marie-Adele Salem",
    "team_mary_role": "Technical Advisor",
    "team_title": "Our Team",
    "team_zeina_bio": "Zeina plays a vital role in overseeing and coordinating the various programs and services provided by the company. With ten years of experience in program management, Zeina brings a wealth of knowledge and expertise. She is responsible for developing, implementing, and evaluating programs at Reframe to ensure the delivery of high-quality services.",
    "team_zeina_name": "Zeina Ballout",
    "team_zeina_role": "Co-founder & Program Coordinator",

    // ===== timeline =====
    "timeline_2022_circle": "2022",
    "timeline_2022_label": "Vision Emerges",
    "timeline_2022_text": "By the last quarter of 2022, a shared vision emerged among a group of experienced therapists from across the Middle East and beyond. United by a deep sense of purpose, we set out to create mental health resources that are not only professionally rigorous but also genuinely rooted in Arabic language and culture — addressing the real realities of our communities.",
    "timeline_2023_circle": "2023",
    "timeline_2023_label": "Foundations Built",
    "timeline_2023_text": "In 2023, we focused on laying strong foundations. We listened deeply, learned extensively, and sought to understand the unique and complex needs of those we serve. Our commitment was clear: to move forward with honesty, care, and unwavering dedication to support those who need it most.",
    "timeline_2024_circle": "2024",
    "timeline_2024_label": "Key Milestones",
    "timeline_2024_text": "2024 marked the year when our efforts began to take tangible shape. We launched our first professional training and international collaboration, initiated a research project on panic attacks, and partnered with NGOs and corporations across the Middle East. Together, we fostered environments where staff well-being became a priority.",
    "timeline_2025_circle": "2025",
    "timeline_2025_label": "Impact Grows",
    "timeline_2025_text": "Entering 2025, our commitment to long-term impact strengthened. We advanced comprehensive training and intervention programs driven by the same urgency and compassion that guided us from the start. Our goal was never simply to add services — but to fundamentally reshape mental health support in our region.",
    "timeline_beyond_circle": "Beyond",
    "timeline_beyond_label": "Together Forward",
    "timeline_beyond_text": "At Reframe, we walk alongside professionals, corporate partners, and researchers — providing tailored solutions that connect, uplift, and empower. Together, we continue this journey hand in hand, reframing mental health for a healthier, more resilient future.",
    "timeline_beyond_text_bold": "Join us and be part of the change.",
    "timeline_title": "Our Story Timeline",

    // ===== training =====
    "training_long_best_desc": "Professionals seeking structured, long-term clinical training.",
    "training_long_best_title": "Best suited for:",
    "training_long_core_1": "Theoretical training",
    "training_long_core_2": "Ongoing supervision",
    "training_long_core_title": "Core components:",
    "training_long_desc": "Long-term trainings are designed to support deep and sustained learning through an integrated structure.",
    "training_long_focus_1": "Advanced conceptual understanding",
    "training_long_focus_2": "Clinical application and case formulation",
    "training_long_focus_3": "Progressive competency development",
    "training_long_focus_title": "Focus areas include:",
    "training_long_subtitle": "Comprehensive professional development pathways",
    "training_long_title": "Long-Term Training Programs",
    "training_main_subtitle": "Structured learning opportunities designed to support growth, skill-building, and ethical clinical practice across different career stages.",
    "training_main_title": "Training and Professional Development Services",
    "training_mid_best_desc": "Practitioners seeking hands-on learning and skill enhancement.",
    "training_mid_best_title": "Best suited for:",
    "training_mid_desc": "Mid-term trainings provide structured and immersive learning experiences aimed at developing and strengthening professional skills.",
    "training_mid_focus_1": "Applied clinical skills",
    "training_mid_focus_2": "Practice-oriented learning",
    "training_mid_focus_3": "Guided exercises and case discussions",
    "training_mid_focus_title": "Focus areas include:",
    "training_mid_format_1": "In-person or online",
    "training_mid_format_2": "Duration: Half day to two weeks",
    "training_mid_format_title": "Format:",
    "training_mid_subtitle": "In-depth skill-building programs",
    "training_mid_title": "Mid-Term Trainings",
    "training_short_best_desc": "Professionals seeking focused learning and timely updates.",
    "training_short_best_title": "Best suited for:",
    "training_short_desc": "Short-term trainings are concise sessions designed to introduce new ideas, tools, or developments in mental health practice.",
    "training_short_focus_1": "Updates on therapeutic techniques",
    "training_short_focus_2": "Introduction to theories and models",
    "training_short_focus_3": "Presentation of research findings and clinical insights",
    "training_short_focus_4": "Sharing practice-based experiences and intervention outcomes",
    "training_short_focus_title": "Focus areas include:",
    "training_short_format_1": "Online",
    "training_short_format_2": "Duration: 2–4 hours",
    "training_short_format_title": "Format:",
    "training_short_subtitle": "Brief learning experiences focused on knowledge updates and practical insights",
    "training_short_title": "Short-Term Trainings",

    // ===== username =====
    "username_label": "Username",
    "username_placeholder": "Enter your ID",

    // ===== value =====
    "value_collaboration_desc": "We work together with individuals, families, and communities to achieve lasting positive change.",
    "value_collaboration_title": "Collaboration",
    "value_compassion_desc": "We approach every individual with empathy, understanding, and genuine care for their wellbeing.",
    "value_compassion_title": "Compassion",
    "value_cultural_desc": "Our services are tailored to respect and honor the diverse cultural contexts of the Middle East.",
    "value_cultural_title": "Cultural Sensitivity",
    "value_innovation_desc": "We continuously evolve our practices to incorporate the latest evidence-based approaches.",
    "value_innovation_title": "Innovation",

    // ===== values =====
    "values_subtitle": "Guiding principles that shape our approach to mental health services",
    "values_title": "Our Core Values",

    // ===== video =====
    "video": "Video",
    "video_1_title": "Affirmations for easing anxiety",
    "video_2_title": "The basics of financial wellness",
    "video_3_title": "Practicing gratitude",

    // ===== view =====
    "view_all": "View all",
    "view_all_blog": "Read all blog posts",

    // ===== whitepaper =====
    "whitepaper": "Whitepaper",
    "whitepaper_1_title": "Reframe On-Site Services: Increasing Employee Assistance Program (EAP) Awareness and Access",
    "whitepaper_2_title": "Well-Being Coaching Increases Overall Employee Engagement",
    "whitepaper_3_title": "Mental Health Trends in the Middle East",
  },

  ar: {
    // ===== a11y =====
    "a11y_skip_link": "تخطَّ إلى المحتوى الرئيسي",

    // ===== about =====
    "about_hero_subtitle": "نحن نتصور مستقبلًا تكون فيه الصحة النفسية أساس كل نظام إنساني، حيث يتم اعتبار التحديات والإخفاقات فرصًا للنمو والتحول.",
    "about_hero_title": "عن ريفريم",

    // ===== accreditation =====
    "accreditation_cta_button": "احجز الآن",
    "accreditation_cta_text": "تواصل معنا اليوم واجعل فعاليتك القادمة تجربة ناجحة بكل المقاييس.",
    "accreditation_cta_title": "هل أنت مستعد لحجز مساحتك؟",
    "accreditation_desc_1": "حصلت Reframe على اعتماد رسمي من نقابة النفسانيين في لبنان (LOPsy) كمركز تدريب في العلاج النفسي النظمي، وذلك للفترة الممتدة من 1 تشرين الأول 2025 إلى 31 تشرين الأول 2027.",
    "accreditation_desc_2": "يعكس هذا الاعتماد التزامنا المستمر بالتميّز، والنزاهة، والممارسة القائمة على الأدلة العلمية في مجال الصحة النفسية، كما يعزّز رسالتنا في تمكين المهنيين في مختلف أنحاء الشرق الأوسط من خلال تدريب وإشراف عاليي الجودة ومُلائمين ثقافيًا.",
    "accreditation_desc_3": "نتوجّه بخالص الشكر والتقدير إلى فريقنا، والمشرفين، ومجتمعنا، لكونهم جزءًا أساسيًا من هذه المسيرة. معًا، نُسهم في بناء مستقبل تكون فيه التربية والممارسة في مجال الصحة النفسية متاحة، وأخلاقية، وإنسانية بعمق.",
    "accreditation_hashtags": "#الاعتماد #LOPsy #العلاج_النفسي_النظمي #التطوير_المهني #الصحة_النفسية_في_لبنان",
    "accreditation_title": "نفخر بمشاركة خبر اعتمادنا الرسمي!",

    // ===== calendar =====
    "calendar_event1_title": "بناء السلام والدعم النفسي الاجتماعي",
    "calendar_event2_title": "تدريب حول رعاية اضطرابات الأكل",
    "calendar_month": "يوليو 2025",
    "calendar_subtitle": "اطّلع على جلساتنا التدريبية وورش العمل القادمة",
    "calendar_this_month": "فعاليات هذا الشهر",
    "calendar_title": "الأحداث القادمة",
    "calendar_view_all": "عرض جميع الفعاليات",

    // ===== changing =====
    "changing_words_1": "الدعم الفردي",
    "changing_words_2": "الخدمات المؤسسية",
    "changing_words_3": "الدعم الجماعي",
    "changing_words_4": "التدخلات المتخصصة",
    "changing_words_5": "ورش العمل والتدريب",

    // ===== close =====
    "close": "إغلاق",

    // ===== consultations =====
    "consultations_about_subtitle": "الاستشارات التقنية",
    "consultations_about_title": "معلومات عنا",
    "consultations_changing_word": "الرؤية",
    "consultations_group_1": "جلسات إدارة الضغوط (بعد الأزمات أو حالات الإرهاق أو ضغط العمل العالي).",
    "consultations_group_2": "مجموعات الدعم النظيري (مساحة آمنة لمشاركة الخبرات).",
    "consultations_group_3": "دوائر المرونة باستخدام الفن، السرد القصصي، والحركة.",
    "consultations_group_4": "بناء فرق باستخدام طرق علاجية (العمل بالطين، لعب الأدوار، الأنشطة القائمة على الاستعارة).",
    "consultations_group_title": "الدعم الجماعي",
    "consultations_hero_subtitle": "نقدّم الموارد، الصحة العلائقية، والانسجام النظامي لدعم فرق عملكم.",
    "consultations_hero_title": "الاستشارات التقنية",
    "consultations_individual_1": "جلسات استشارية سرية (قصيرة الأمد وموجهة للحلول).",
    "consultations_individual_2": "الإسعاف النفسي الأولي للموظفين المعرّضين للأزمات.",
    "consultations_individual_3": "تدريب على إدارة الضغوط وتعزيز المرونة.",
    "consultations_individual_4": "الإحالة والمتابعة عند الحاجة.",
    "consultations_individual_title": "الدعم الفردي",
    "consultations_org_1": "تقييمات المخاطر النفسية الاجتماعية (استبيانات + مجموعات تركيز).",
    "consultations_org_2": "أنظمة متابعة وتقييم لرفاهية الموظفين.",
    "consultations_org_3": "تقارير شهرية/ربع سنوية للإدارة: المخاطر، احتياجات الموظفين، التوصيات.",
    "consultations_org_4": "الوساطة أثناء النزاعات في بيئة العمل.",
    "consultations_org_5": "استشارات السياسات: دمج الصحة النفسية في أنظمة الموارد البشرية (الإجازات، ضغط العمل، المرونة).",
    "consultations_org_6": "تصميم استراتيجيات رفاهية متماشية مع متطلبات المؤسسة.",
    "consultations_org_title": "الخدمات المؤسسية",
    "consultations_services_title": "خدماتنا",
    "consultations_special_1": "أيام رعاية الموظفين الموضوعية (الفن، الموسيقى، اليقظة الذهنية).",
    "consultations_special_2": "دعم المديرين لقيادة أكثر وعيًا بالصحة النفسية.",
    "consultations_special_3": "دعم تلطيفي وانتقالي للموظفين المغادرين للمؤسسات.",
    "consultations_special_4": "حزم استجابة طارئة للأزمات (الحروب، الكوارث، التسريحات المفاجئة).",
    "consultations_special_5": "إشراف للكوادر العاملة في الصحة النفسية والداعمين في الخطوط الأمامية.",
    "consultations_special_title": "التدخلات المتخصصة",
    "consultations_workshops_1": "إدارة الضغوط والوقاية من الاحتراق النفسي.",
    "consultations_workshops_2": "مهارات المرونة في بيئات العمل عالية الضغط.",
    "consultations_workshops_3": "تنظيم العواطف واستراتيجيات التكيف.",
    "consultations_workshops_4": "الرعاية المستنيرة بالصدمات لبيئات العمل المكثفة.",
    "consultations_workshops_5": "التوعية بالصحة النفسية وتقليل الوصمة.",
    "consultations_workshops_6": "حل النزاعات ومهارات التواصل.",
    "consultations_workshops_7": "العناية الذاتية وتحديد الحدود.",
    "consultations_workshops_8": "تدريب الاستجابة لحالات الطوارئ النفسية.",
    "consultations_workshops_title": "ورش العمل والتدريب",

    // ===== contact =====
    "contact_address_text": "شارع طرابلسي، مركز كالوت، الطابق الثامن، بدارو، بيروت، لبنان",
    "contact_address_title": "العنوان",
    "contact_email_title": "البريد الإلكتروني",
    "contact_form_title": "أرسل لنا رسالة",
    "contact_hero_subtitle": "هل أنت مستعد لبدء رحلتك أو التعرف أكثر على خدماتنا؟ نحن هنا لمساعدتك.",
    "contact_hero_title": "تواصل معنا",
    "contact_info_title": "معلومات التواصل",
    "contact_phone_title": "الهاتف",

    // ===== core =====
    "core_values_collaboration_desc": "نؤمن بقوة التعاون والمجتمع، ونعمل بنشاط مع الشركاء والعملاء للتصميم المشترك وتحقيق الأهداف المشتركة. التزامنا بروح الفريق يعزز الروابط ويدفع النجاح الجماعي.",
    "core_values_collaboration_title": "التعاون والمجتمع",
    "core_values_empathy_desc": "نحن ملتزمون بتعزيز الفهم والتعاطف في جميع تعاملاتنا، وخلق بيئة داعمة ومغذية لكل من نتعامل معهم. يضمن التزامنا أن يشعر الجميع بالتقدير والرعاية، مما يعزز العلاقات الصحية والنمو.",
    "core_values_empathy_title": "التعاطف والرحمة",
    "core_values_evidence_desc": "نقدم خدمات وبرامج تستند إلى أساليب قائمة على الأدلة لضمان الفعالية والاستدامة.",
    "core_values_evidence_title": "الممارسة المبنية على الأدلة",
    "core_values_inclusivity_desc": "نحتضن التنوع ونرسّخ بيئة شاملة تحترم وتقدّر خصوصية الأفراد وتجاربنا الإنسانية المشتركة. ومن خلال تعزيز الشمولية، نرسّخ التفاهم والتواصل بين جميع الأفراد، بما يثري تجربة المجتمع ككل.",
    "core_values_inclusivity_title": "الشمولية والتنوع",
    "core_values_innovation_desc": "نحن ملتزمون بالممارسات المبتكرة التي تعزز خدمات الصحة النفسية وتزيد من أثرها.",
    "core_values_innovation_title": "الابتكار والتميز",
    "core_values_integrity_desc": "نتصرف بصدق وشفافية واحترام في جميع مساعينا، مما يضمن الثقة والأصالة في كل تفاعل.",
    "core_values_integrity_title": "النزاهة والأصالة",
    "core_values_resilience_desc": "نساعد الأفراد والمنظمات على احتضان التحديات كفرص للتطور والتقدم المستدام.",
    "core_values_resilience_title": "المرونة والنمو",
    "core_values_title": "قيمنا الأساسية",

    // ===== day =====
    "day_fri": "جمعة",
    "day_mon": "اثنين",
    "day_sat": "سبت",
    "day_sun": "أحد",
    "day_thu": "خميس",
    "day_tue": "ثلاثاء",
    "day_wed": "أربعاء",

    // ===== email =====
    "email_label": "البريد الإلكتروني",
    "email_placeholder": "أدخل بريدك الإلكتروني",

    // ===== event1 =====
    "event1_date": "٣ تموز",
    "event1_title": "بناء السلام والدعم النفسي الاجتماعي",

    // ===== event2 =====
    "event2_date": "٣٠ تموز",
    "event2_title": "تدريب حول رعاية اضطرابات الأكل",

    // ===== events =====
    "events_this_month": "فعاليات هذا الشهر",
    "events_title": "الجلسات التدريبية القادمة",
    "events_view_all": "عرض جميع الفعاليات",

    // ===== footer =====
    "footer_brand": "Reframe للصحة النفسية",
    "footer_connect": "تواصل معنا",
    "footer_consultation": "استشارة",
    "footer_credit": "تصميم وتطوير الموقع بواسطة",
    "footer_description": "إطلاق الإمكانات الكامنة وتعزيز القدرة على الصمود في مواجهة التحديات لدى الأفراد والمجموعات في مختلف أنحاء الشرق الأوسط.",
    "footer_quick_links": "روابط سريعة",
    "footer_resources": "الموارد",
    "footer_rights": "جميع الحقوق محفوظة.",
    "footer_services": "الخدمات",
    "footer_subscribe_btn": "اشترك",
    "footer_subscribe_placeholder": "أدخل بريدك الإلكتروني",
    "footer_subscribe_text": "اشترك في نشرتنا الإخبارية للحصول على التحديثات وورش العمل والفعاليات.",
    "footer_subscribe_title": "ابقَ على تواصل",
    "footer_training": "البرامج التدريبية",
    "footer_workshops": "ورش عمل",

    // ===== forgot =====
    "forgot_password": "هل نسيت كلمة المرور؟",

    // ===== form =====
    "form_email": "البريد الإلكتروني",
    "form_first_name": "الاسم الأول",
    "form_last_name": "اسم العائلة",
    "form_message": "الرسالة",
    "form_phone": "رقم الهاتف",
    "form_select_subject": "اختر موضوعًا",
    "form_subject": "الموضوع",
    "form_subject_consultation": "خدمات الاستشارات",
    "form_subject_general": "استفسار عام",
    "form_subject_placeholder": "اختر موضوعاً",
    "form_subject_research": "التعاون البحثي",
    "form_subject_training": "البرامج التدريبية",
    "form_submit": "إرسال الرسالة",

    // ===== hero =====
    "hero_paragraph": "خدمات وبرامج تدريبية متخصصة في الصحة النفسية، مُصمَّمة بعناية لتتلاءم مع الخصوصيات الثقافية والاجتماعية في منطقة الشرق الأوسط.",
    "hero_title": " إطلاق الإمكانات الإنسانية الكامنة وتعزيز القدرة على الصمود في مواجهة التحديات",

    // ===== hub =====
    "hub_cta_btn": "احجز الآن",
    "hub_cta_text": "تواصل معنا اليوم واجعل فعاليتك القادمة ناجحة.",
    "hub_cta_title": "هل أنت مستعد لحجز مساحتك؟",
    "hub_feature_1": "مقاعد لأكثر من 20 ضيفًا",
    "hub_feature_2": "شاشة عالية الجودة",
    "hub_feature_3": "منطقة استقبال ترحيبية",
    "hub_feature_4": "كاميرا مؤتمرات",
    "hub_feature_5": "ركن المشروبات",
    "hub_feature_6": "إنترنت عالي السرعة على مدار الساعة",
    "hub_feature_7": "موقع مركزي مميز",
    "hub_feature_8": "خصوصية تامة",
    "hub_features_title": "أهم المميزات",
    "hub_hero_cta": "اكتشف المزيد",
    "hub_hero_subtitle": "هل تبحث عن المكان المثالي لعقد اجتماعك أو مؤتمرك أو ورشتك القادمة؟ محور ريفريم هو مساحتك المثالية، المصممة لتلبية احتياجاتك المهنية بالراحة والسهولة.",
    "hub_hero_title": "محور ريفريم",
    "hub_why_desc": "هل تبحث عن المكان المثالي لاستضافة اجتماعك أو مؤتمرك أو ورشة العمل القادمة؟ يوفر Reframe Hub مساحة احترافية مصممة لتلبية احتياجاتك المهنية، مع بيئة مريحة ومجهزة بالكامل لضمان تجربة ناجحة.",
    "hub_why_title": "لماذا تختار محور ريفريم؟",

    // ===== lab =====
    "lab_collaboration_question": "هل تودّون التعاون معنا؟",
    "lab_desc": "انضمّوا إلى مبادراتنا البحثية المبتكرة للمساهمة في تطوير خدمات الرعاية النفسية في منطقة الشرق الأوسط",
    "lab_email_label": "البريد الإلكتروني",
    "lab_email_placeholder": "example@email.com",
    "lab_title": "مختبر الصحة النفسية",

    // ===== location =====
    "location_title": "موقعنا",

    // ===== login =====
    "login_btn": "تسجيل الدخول",
    "login_header_subtitle": "هل ترغب في العمل معنا؟ املأ بعض المعلومات وسنتواصل معك قريبًا! لا يسعنا الانتظار لسماعك.",
    "login_header_title": "مرحبًا بك في ريفريم",

    // ===== milestone1 =====
    "milestone1_desc": "شركات، منظمات غير حكومية، ومؤسسات صحية",
    "milestone1_title": "15 + مؤسسة",

    // ===== milestone2 =====
    "milestone2_desc": "دراسات نشطة وتطوير أدوات تقييم",
    "milestone2_title": "+2 مشروع",

    // ===== milestone3 =====
    "milestone3_desc": "تلقوا تدريبًا في عدة دول",
    "milestone3_title": "+500 مهني/ـة",

    // ===== milestone4 =====
    "milestone4_desc": "حضور إقليمي وتعاونات متعددة",
    "milestone4_title": "6 دول",

    // ===== milestones =====
    "milestones_subtitle": "نحتفي بمسيرتنا وبالأثر الذي أحدثناه في مجال الصحة النفسية",
    "milestones_title": "محطّاتنا حتى اليوم",

    // ===== mission =====
    "mission_description": "نقدم أساليب صحة نفسية قائمة على الأدلة وملائمة ثقافيًا لتمكين الأفراد والمجموعات والمؤسسات من مواجهة التحديات وتحقيق أعلى إمكاناتهم.",
    "mission_title": "مهمتنا",

    // ===== msg =====
    "msg_contact_success": "شكراً لرسالتك! سنتواصل معك قريباً.",
    "msg_event_details_placeholder": "ستظهر تفاصيل الفعالية هنا عند اكتمال التطبيق.",
    "msg_formspree_success": "تم إرسال الرسالة بنجاح! 😊",
    "msg_generic_error": "حدث خطأ ما. حاول مرة أخرى.",
    "msg_invalid_email": "الرجاء إدخال بريد إلكتروني صحيح.",
    "msg_invalid_email_short": "الرجاء إدخال بريد إلكتروني صحيح.",
    "msg_loading": "جارٍ التحميل...",
    "msg_newsletter_success": "شكراً لاشتراكك! سنبقيك على اطلاع بآخر المستجدات.",
    "msg_required_fields": "الرجاء تعبئة جميع الحقول المطلوبة.",
    "msg_send_error": "عذراً! حدثت مشكلة أثناء إرسال رسالتك.",
    "msg_subscribe_confirm": "شكراً! تفقّد بريدك الإلكتروني لتأكيد الاشتراك.",
    "msg_video_placeholder": "سيتم فتح مشغّل الفيديو هنا عند اكتمال التطبيق.",

    // ===== nav =====
    "nav_about": "معلومات عنا",
    "nav_consultations": "الاستشارات التقنية",
    "nav_contact": "اتصل بنا",
    "nav_home": "الرئيسية",
    "nav_hub": "المحور",
    "nav_hub_reframe": "Reframe Hub",
    "nav_login": "تسجيل الدخول",
    "nav_mhlab": "مختبر الصحة النفسية",
    "nav_services": "الخدمات",
    "nav_training": "التدريب",

    // ===== need =====
    "need_help_text": "تواصل مع فريق الدعم لدينا للحصول على مساعدة في حسابك.",
    "need_help_title": "تحتاج إلى مساعدة؟",

    // ===== no =====
    "no_account_text": "ليس لديك حساب؟",
    "no_self_register_text": "يتم إصدار الحسابات من قبل إدارة البرنامج. تواصل مع الدعم إذا احتجت إلى صلاحية الوصول.",

    // ===== our =====
    "our_packages_title": "حزمنا",

    // ===== package =====
    "package_pro_desc": "تدريب مكثف لمدة يومين لتعزيز المهارات السريرية.",
    "package_pro_price": "حضوري: $150 | عبر الإنترنت: $80",
    "package_pro_title": "حزمة النمو المهني: تقنيات متقدمة",
    "package_special_desc": "ورشة عمل لثلاثة أيام تغطي حالات معقدة مثل الصدمات والحزن.",
    "package_special_price": "حضوري: $200 | عبر الإنترنت: $120",
    "package_special_title": "حزمة التركيز المتخصصة",
    "package_starter_desc": "ورشة عمل أساسية ليوم واحد للمهنيين في الصحة النفسية.",
    "package_starter_price": "حضوري: $80 | عبر الإنترنت: $60",
    "package_starter_title": "الحزمة المبتدئة: تدريب أساسي",
    "package_support_desc": "جلسات إشراف أو دعم جماعي شهري.",
    "package_support_price": "$100 لكل جلسة",
    "package_support_title": "حزمة دائرة الدعم: جلسات شهرية للأقران",

    // ===== page =====
    "page_description_about": "تعرّف على مهمة ريفريم ورؤيتها وفريقها من الأخصائيين النفسيين في الشرق الأوسط.",
    "page_description_consultations": "استشارات تقنية مهنية للمؤسسات، تركز على رفاهية الموظفين، تعزيز المرونة، وضمان النجاح المؤسسي.",
    "page_description_contact": "تواصل مع ريفريم للحصول على خدمات الصحة النفسية، البرامج التدريبية، وفرص التعاون.",
    "page_description_home": "خدمات وبرامج تدريبية احترافية في الصحة النفسية عبر الشرق الأوسط. إطلاق الإمكانات وتعزيز المرونة.",
    "page_description_hub": "موارد وأدوات احترافية ومجتمع مهني لممارسي الصحة النفسية في الشرق الأوسط.",
    "page_description_projects": "استكشف مشاريعنا البحثية ومبادراتنا التي تعزز خدمات الصحة النفسية في جميع أنحاء الشرق الأوسط.",
    "page_title_about": "معلومات عنا - ريفريم",
    "page_title_consultations": "الاستشارات التقنية - ريفريم",
    "page_title_contact": "اتصل بنا - ريفريم",
    "page_title_home": "ريفريم - خدمات الصحة النفسية",
    "page_title_hub": "المحور - ريفريم",
    "page_title_projects": "المشاريع - ريفريم",

    // ===== partners =====
    "partners_subtitle": "نبني مجتمعات أقوى من خلال شراكات استراتيجية هادفة",
    "partners_title": "شركاؤنا وتعاوناتنا",

    // ===== password =====
    "password_label": "كلمة المرور",
    "password_placeholder": "أدخل كلمة المرور",

    // ===== plan =====
    "plan_text": "تعتمد رؤية ريفرام 2025-2030 على ثلاثة محاور: الريادة في العلاج الأسري، علامة العمل-الصحي للمؤسسات، وبرامج متكيفة ثقافيًا مبنية على تقييمات الاحتياجات السنوية. تهدف هذه الجهود إلى تعزيز خدمات الصحة النفسية في منطقة الشرق الأوسط وشمال أفريقيا وتمكين المجتمعات من الازدهار رغم التحديات المعقدة.",
    "plan_title": "الخطة الاستراتيجية 2025-2030",
    "plan_view_btn": "عرض الخطة كاملة",

    // ===== project1 =====
    "project1_file1": "تطوير استبيان Reframe و Altpsy",
    "project1_file2": "استبيان نوبات الهلع",
    "project1_file3": "ملف إضافي عن نوبات الهلع",
    "project1_file4": "إدارة الأزمات في حالات القلق الشديد",
    "project1_file5": "موافقة لجنة الأخلاقيات",
    "project1_file6": "التحقق من صحة مقياس الهلع",
    "project1_file7": "استبيان Reframe (AltPsy)",
    "project1_file8": "مقدمة الدراسة",
    "project1_title": "مختبر الصحة النفسية، المشروع الأول: تطوير مقياس نوبات الهلع في السياق اللبناني والعربي",

    // ===== projects =====
    "projects_hero_subtitle": "مختبر الصحة النفسية هو منظمة غير ربحية مكرسة لتعزيز البحث والممارسة في مجال الصحة النفسية. نقوم بإجراء الدراسات والتجارب التي تنتج أدلة مخصصة للواقع الثقافي والاجتماعي في مجتمعنا.",
    "projects_hero_title": "مختبر الصحة النفسية",

    // ===== register =====
    "register_btn": "إنشاء حساب",
    "register_email_label": "البريد الإلكتروني",
    "register_name_label": "الاسم الكامل",
    "register_note": "سيتم تخزين جميع الطلبات بشكل آمن وستكون قابلة للعرض في لوحة تحكم ريفريم.",
    "register_profession_label": "المهنة / المسمى الوظيفي",
    "register_submit": "إرسال التسجيل",
    "register_title": "التسجيل للتدريب",

    // ===== remember =====
    "remember_me": "تذكرني",

    // ===== supervision =====
    "supervision_best_desc": "المعالجين النفسيين الممارسين الباحثين عن دعم وإشراف مهني مستمر.",
    "supervision_best_title": "مناسبة لـ:",
    "supervision_desc": "تركّز خدمات الإشراف المهني على دعم الممارسة الأخلاقية، والتفكير التأملي، وتطوير الكفاءة السريرية.",
    "supervision_focus_1": "مناقشة وصياغة الحالات",
    "supervision_focus_2": "التفكير السريري التأملي",
    "supervision_focus_3": "التطوير المهني واتخاذ القرارات الأخلاقية",
    "supervision_focus_title": "تشمل محاورها:",
    "supervision_format_1": "إشراف فردي أو جماعي",
    "supervision_format_2": "حضوري أو عبر الإنترنت",
    "supervision_format_title": "الصيغة:",
    "supervision_subtitle": "إشراف فردي وجماعي لممارسي العلاج النفسي",
    "supervision_title": "خدمات الإشراف المهني",

    // ===== support =====
    "support_link": "احصل على الدعم",

    // ===== team =====
    "team_ali_bio": "أخصائي نفسي إكلينيكي ومعالج نفسي متميز، ملتزم بعمق بتحسين خدمات الصحة النفسية في العالم العربي. نجح علي في التعاون مع شركات ومنظمات ووكالات أممية لتصميم وتنفيذ مبادرات دعم نفسي واجتماعي مؤثرة في الشرق الأوسط وأفريقيا. في قيادته لمختبر الصحة النفسية، يُعرف علي بنهجه الابتكاري في تطوير البرامج وإدارته الفعالة للفرق، مما يضمن تقديم تدخلات مدعومة علميًا وملائمة ثقافيًا ذات أثر إيجابي عميق على الأفراد والمجتمعات.",
    "team_ali_name": "علي العطار",
    "team_ali_role": "المؤسس والمدير، رئيس مختبر الصحة النفسية",
    "team_bertha_bio": "بيرثا ميسّيادي خبيرة متمرسة في ضمان الجودة وإدارة البرامج. تعاونت عن قرب مع منظمات دولية وهيئات أممية في آسيا وأمريكا الوسطى والولايات المتحدة وأوروبا وأفريقيا والشرق الأوسط. تمتلك خبرة قوية في تطوير البرامج، وصياغة نظريات التغيير، ووضع سياسات واستراتيجيات للدعم النفسي والاجتماعي. كما تمتلك خبرة في إنشاء أنظمة رعاية للموظفين وتعزيز قدرات الفرق من خلال التدريب والإشراف.",
    "team_bertha_name": "بيرثا ميسّيادي",
    "team_bertha_role": "مديرة ضبط الجودة",
    "team_linkedin_btn": "لينكد إن",
    "team_mary_bio": "ماري-أديل متخصصة في الدعم النفسي والاجتماعي منذ عام 2006، كرّست مسيرتها المهنية لتطبيق منهج قائم على الموارد في مجال الدعم النفسي والاجتماعي، متعاونة مع منظمات غير حكومية ووكالات أممية في بيئات ثقافية متعددة. عملت في آسيا وأفريقيا والشرق الأوسط وأمريكا اللاتينية وأوروبا.",
    "team_mary_name": "ماري-أديل سالم",
    "team_mary_role": "المستشارة التقنية",
    "team_title": "فريقنا",
    "team_zeina_bio": "تلعب زينة دورًا محوريًا في الإشراف على البرامج والخدمات المختلفة التي تقدمها المؤسسة. بخبرة تمتد لعشر سنوات في إدارة البرامج، تمتلك معرفة واسعة وخبرة عملية في تطوير وتنفيذ وتقييم البرامج لضمان جودة الخدمات المقدمة.",
    "team_zeina_name": "زينة بلوط",
    "team_zeina_role": "الشريكة المؤسسة ومنسقة البرامج",

    // ===== timeline =====
    "timeline_2022_circle": "2022",
    "timeline_2022_label": "تبلور الرؤية",
    "timeline_2022_text": "بحلول الربع الأخير من عام 2022، تبلورت رؤية مشتركة جمعت مجموعة من المعالجين ذوي الخبرة من مختلف أنحاء الشرق الأوسط وخارجه. وقد وحّدنا إحساس عميق بالرسالة، وانطلقنا لبناء موارد في الصحة النفسية تتميّز بالرصانة المهنية، ومتجذّرة بصدق في اللغة والثقافة العربية، بما يعكس الواقع الحقيقي لمجتمعاتنا ويستجيب لاحتياجاتها الفعلية.",
    "timeline_2023_circle": "2023",
    "timeline_2023_label": "بناء الأسس",
    "timeline_2023_text": "ي عام 2023، ركّزنا على ترسيخ أسس متينة. أصغينا بعمق، وتعلّمنا على نطاق واسع، وسعينا لفهم الاحتياجات المعقّدة والفريدة للأفراد والمجتمعات التي نخدمها. وكان التزامنا واضحًا: المضي قدمًا بصدق، ورعاية، وتفانٍ راسخ في دعم من هم بأمسّ الحاجة.",
    "timeline_2024_circle": "2024",
    "timeline_2024_label": "محطات مفصلية",
    "timeline_2024_text": "شكّل عام 2024 نقطة تحوّل، حيث بدأت جهودنا تتجسّد على أرض الواقع. أطلقنا أول برنامج تدريبي مهني وتعاون دولي، وبدأنا مشروعًا بحثيًا حول نوبات الهلع، كما عقدنا شراكات مع منظمات غير حكومية ومؤسسات وشركات في مختلف أنحاء الشرق الأوسط. معًا، عملنا على تعزيز بيئات عمل تُعطي أولوية حقيقية لرفاه العاملين.",
    "timeline_2025_circle": "2025",
    "timeline_2025_label": "توسيع الأثر والنمور",
    "timeline_2025_text": "مع دخولنا عام 2025، تعزّز التزامنا بإحداث أثر طويل الأمد. طوّرنا برامج تدريب وتدخل شاملة، مدفوعة بالإلحاح والإنسانية نفسيهما اللذين رافقانا منذ البداية. لم يكن هدفنا يومًا مجرّد إضافة خدمات، بل إحداث تحوّل جوهري في كيفية تقديم ودعم الصحة النفسية في منطقتنا.",
    "timeline_beyond_circle": "ما بعد ذلك ",
    "timeline_beyond_label": "|معًا نحو المستقبل",
    "timeline_beyond_text": "في Reframe، نسير جنبًا إلى جنب مع المهنيين، والشركاء من القطاع المؤسسي، والباحثين، مقدّمين حلولًا مصمّمة بعناية، تُعزّز الترابط، وترتقي بالإنسان، وتمكّنه. معًا، نواصل هذه المسيرة، يدًا بيد، لإعادة صياغة مفهوم الصحة النفسية، نحو مستقبل أكثر صحة وقدرة على الصمود",
    "timeline_beyond_text_bold": "انضم إلينا وكن جزءًا من التغيير",
    "timeline_title": "الجدول الزمني لقصتنا",

    // ===== training =====
    "training_long_best_desc": "المهنيين الباحثين عن تدريب سريري منظم وطويل الأمد.",
    "training_long_best_title": "مناسبة لـ:",
    "training_long_core_1": "تدريب نظري معمّق",
    "training_long_core_2": "إشراف مهني مستمر",
    "training_long_core_title": "المكوّنات الأساسية:",
    "training_long_desc": "صُمّمت برامج التدريب طويلة المدى لدعم التعلّم العميق والمستمر من خلال بنية متكاملة.",
    "training_long_focus_1": "تعميق الفهم النظري",
    "training_long_focus_2": "التطبيق السريري وصياغة الحالات",
    "training_long_focus_3": "بناء الكفاءة المهنية بشكل تدريجي",
    "training_long_focus_title": "تشمل محاورها:",
    "training_long_subtitle": "مسارات تدريبية شاملة للتطوير المهني المستدام",
    "training_long_title": "برامج التدريب طويلة المدى",
    "training_main_subtitle": "فرص تعليمية منظّمة تهدف إلى دعم النمو، وبناء المهارات، وتعزيز الممارسة السريرية الأخلاقية عبر مختلف المراحل المهنية.",
    "training_main_title": "خدمات التدريب والتطوير المهني",
    "training_mid_best_desc": "الممارسين الراغبين في تعميق مهاراتهم وتطوير أدائهم المهني.",
    "training_mid_best_title": "مناسبة لـ:",
    "training_mid_desc": "توفر التدريبات متوسطة المدى تجارب تعليمية منظمة وغنية، تركّز على تنمية المهارات المهنية بشكل عملي وتطبيقي.",
    "training_mid_focus_1": "تنمية المهارات السريرية والتطبيقية",
    "training_mid_focus_2": "تعلّم قائم على الممارسة",
    "training_mid_focus_3": "تمارين موجهة ونقاشات حالات",
    "training_mid_focus_title": "تشمل محاورها:",
    "training_mid_format_1": "حضوري أو عبر الإنترنت",
    "training_mid_format_2": "المدة: من نصف يوم إلى أسبوعين كحد أقصى",
    "training_mid_format_title": "الصيغة:",
    "training_mid_subtitle": "برامج معمّقة لبناء وتطوير المهارات",
    "training_mid_title": "التدريبات متوسطة المدى",
    "training_short_best_desc": "المهنيين الراغبين في تعلّم مركّز وسريع ومواكب للمستجدات.",
    "training_short_best_title": "مناسبة لـ:",
    "training_short_desc": "التدريبات قصيرة المدى هي جلسات مختصرة تهدف إلى مشاركة معرفة جديدة أو مستجدات في مجال الصحة النفسية والممارسة المهنية.",
    "training_short_focus_1": "تحديثات حول تقنيات علاجية محددة",
    "training_short_focus_2": "تقديم أطر ونظريات جديدة",
    "training_short_focus_3": "عرض نتائج أبحاث ودراسات حديثة",
    "training_short_focus_4": "مشاركة خبرات تطبيقية ونتائج تدخلات مهنية",
    "training_short_focus_title": "تشمل محاورها:",
    "training_short_format_1": "عبر الإنترنت",
    "training_short_format_2": "المدة: من ساعتين إلى أربع ساعات",
    "training_short_format_title": "الصيغة:",
    "training_short_subtitle": "جلسات تعليمية مركّزة لتحديث المعرفة وتقديم أدوات عملية",
    "training_short_title": "التدريبات قصيرة المدى",

    // ===== username =====
    "username_label": "اسم المستخدم",
    "username_placeholder": "أدخل معرّفك",

    // ===== value =====
    "value_collaboration_desc": "نعمل مع الأفراد والأسر والمجتمعات لتحقيق تغيير إيجابي دائم.",
    "value_collaboration_title": "التعاون",
    "value_compassion_desc": "نتعامل مع كل فرد بتعاطف وفهم ورعاية حقيقية لرفاهيته.",
    "value_compassion_title": "التعاطف",
    "value_cultural_desc": "خدماتنا مصممة لاحترام وتقدير السياقات الثقافية المتنوعة في الشرق الأوسط.",
    "value_cultural_title": "الحس الثقافي",
    "value_innovation_desc": "نطور ممارساتنا باستمرار لدمج أحدث الأساليب المبنية على الأدلة.",
    "value_innovation_title": "الابتكار",

    // ===== values =====
    "values_subtitle": "المبادئ التي توجه نهجنا في خدمات الصحة النفسية",
    "values_title": "قيمنا الأساسية",
  }
};
