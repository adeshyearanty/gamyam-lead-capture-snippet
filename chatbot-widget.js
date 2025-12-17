(function () {
  // 1. Validation: specific error if settings are missing
  if (!window.UniBoxSettings || !window.UniBoxSettings.tenantId) {
    console.error("UniBox: Settings or Tenant ID missing. Please check your script tag.");
    return;
  }

  const userConfig = window.UniBoxSettings;

  // 2. Default Configuration (Fallbacks)
  const defaults = {
    appearance: {
      primaryColor: "#007BFF",
      secondaryColor: "#F0F0F0",
      backgroundColor: "#FFFFFF",
      textColor: "#333333",
      fontFamily: "sans-serif",
      iconStyle: "circle", // Options: 'circle', 'rounded', 'square'
      welcomeMessage: "Hello! How can we help?",
      logoUrl: "", 
    },
    behavior: {
      botDelayMs: 0,
      typingIndicator: false,
      autoOpen: false,
      stickyPlacement: "bottom-right", // Options: 'bottom-right', 'bottom-left'
    },
    preChatForm: {
      enabled: false,
      fields: []
    }
  };

  // 3. Merge User Config with Defaults
  const settings = deepMerge(defaults, userConfig);

  // 4. Initialize Widget
  if (document.readyState === "complete") {
    init();
  } else {
    window.addEventListener("load", init);
  }

  function init() {
    // Optional: Auto-load Google Font if it's a common one (like DM Sans)
    loadGoogleFont(settings.appearance.fontFamily);
    renderWidget();
  }

  function renderWidget() {
    // Create Host
    const host = document.createElement("div");
    host.id = "unibox-root";
    document.body.appendChild(host);

    // Create Shadow DOM
    const shadow = host.attachShadow({ mode: "open" });

    // Determine Placement CSS
    const isRight = settings.behavior.stickyPlacement === "bottom-right";
    const positionCss = isRight ? "right: 20px;" : "left: 20px;";
    
    // Determine Launcher Shape
    let borderRadius = "50%"; // Default circle
    if (settings.appearance.iconStyle === "rounded") borderRadius = "12px";
    if (settings.appearance.iconStyle === "square") borderRadius = "0px";

    // CSS Variables & Styles
    const styleTag = document.createElement("style");
    styleTag.textContent = `
      :host {
        --primary: ${settings.appearance.primaryColor};
        --secondary: ${settings.appearance.secondaryColor};
        --bg: ${settings.appearance.backgroundColor};
        --text: ${settings.appearance.textColor}; /* You might want to calc this or pass it */
        --font: '${settings.appearance.fontFamily}', sans-serif;
        --radius: ${borderRadius};
        
        position: fixed;
        z-index: 2147483647;
        bottom: 0;
        left: 0;
        width: 0; height: 0;
        font-family: var(--font);
      }

      /* LAUNCHER */
      .launcher {
        position: fixed;
        bottom: 20px;
        ${positionCss}
        width: 60px;
        height: 60px;
        background: var(--primary);
        border-radius: var(--radius);
        box-shadow: 0 4px 14px rgba(0,0,0,0.15);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: transform 0.2s;
      }
      .launcher:hover { transform: scale(1.05); }
      .launcher img { width: 30px; height: 30px; object-fit: contain; }

      /* CHAT WINDOW */
      .chat-window {
        position: fixed;
        bottom: 90px;
        ${positionCss}
        width: 380px;
        height: 600px;
        max-width: 90vw;
        max-height: 80vh;
        background: var(--bg);
        border-radius: 12px;
        box-shadow: 0 8px 30px rgba(0,0,0,0.12);
        display: flex;
        flex-direction: column;
        overflow: hidden;
        opacity: 0;
        pointer-events: none;
        transform: translateY(20px) scale(0.95);
        transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      }
      .chat-window.open {
        opacity: 1;
        pointer-events: auto;
        transform: translateY(0) scale(1);
      }

      /* HEADER */
      .header {
        background: var(--primary);
        padding: 18px;
        color: #fff;
        display: flex;
        align-items: center;
        gap: 12px;
      }
      .header-title { font-weight: 600; font-size: 16px; }

      /* BODY */
      .body {
        flex: 1;
        padding: 20px;
        overflow-y: auto;
        background-color: var(--secondary); /* Using secondary color for message area bg */
      }
      
      /* MESSAGE BUBBLE (Welcome) */
      .bot-msg {
        background: #fff;
        padding: 12px 16px;
        border-radius: 12px;
        border-bottom-left-radius: 2px;
        box-shadow: 0 1px 2px rgba(0,0,0,0.05);
        color: #333;
        line-height: 1.5;
        font-size: 14px;
        max-width: 85%;
      }
    `;

    // 5. HTML Structure
    const container = document.createElement("div");
    
    // Logo / Icon Logic
    const launcherIcon = settings.appearance.logoUrl 
      ? `<img src="${settings.appearance.logoUrl}" alt="Chat" style="border-radius:50%;" />`
      : `<svg width="28" height="28" viewBox="0 0 24 24" fill="white"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>`;

    container.innerHTML = `
      <div class="launcher" id="launcherBtn">
        ${launcherIcon}
      </div>

      <div class="chat-window" id="chatWindow">
        <div class="header">
           ${settings.appearance.logoUrl ? `<img src="${settings.appearance.logoUrl}" width="32" height="32" style="border-radius:50%; background:#fff; padding:2px;">` : ''}
           <div class="header-title">Support Team</div>
           <div id="closeBtn" style="margin-left:auto; cursor:pointer; font-size:20px;">&times;</div>
        </div>
        <div class="body">
           <div class="bot-msg">${settings.appearance.welcomeMessage}</div>
        </div>
      </div>
    `;

    shadow.appendChild(styleTag);
    shadow.appendChild(container);

    bindEvents(shadow, settings);
  }

  function bindEvents(shadow, settings) {
    const launcher = shadow.getElementById("launcherBtn");
    const windowEl = shadow.getElementById("chatWindow");
    const closeBtn = shadow.getElementById("closeBtn");

    const toggle = (state) => {
      const isOpen = windowEl.classList.contains("open");
      const nextState = state !== undefined ? state : !isOpen;
      
      if (nextState) windowEl.classList.add("open");
      else windowEl.classList.remove("open");
      
      // Save state if sticky
      if (settings.behavior.stickyPlacement) {
        localStorage.setItem("unibox_open", nextState);
      }
    };

    launcher.addEventListener("click", () => toggle());
    closeBtn.addEventListener("click", () => toggle(false));

    // Handle Auto-Open
    if (settings.behavior.autoOpen) {
       const hasInteracted = localStorage.getItem("unibox_open");
       if (hasInteracted === null) {
          setTimeout(() => toggle(true), settings.behavior.botDelayMs);
       }
    } else if (localStorage.getItem("unibox_open") === "true") {
      // Respect Sticky State
      toggle(true);
    }
  }

  // Helper: Deep Merge
  function deepMerge(target, source) {
    for (const key in source) {
      if (source[key] instanceof Object && key in target) {
        Object.assign(source[key], deepMerge(target[key], source[key]));
      }
    }
    Object.assign(target || {}, source);
    return target;
  }

  // Helper: Simple Google Font Loader
  function loadGoogleFont(fontName) {
    if (!fontName || fontName === 'sans-serif') return;
    const link = document.createElement('link');
    link.href = `https://fonts.googleapis.com/css2?family=${fontName.replace(/ /g, '+')}:wght@400;500;600&display=swap`;
    link.rel = 'stylesheet';
    document.head.appendChild(link);
  }

})();
