(function () {
  // --- 1. CONFIGURATION & DEFAULTS ---
  if (!window.UniBoxSettings || !window.UniBoxSettings.tenantId) {
    console.error("UniBox: Settings or Tenant ID missing.");
    return;
  }

  const userConfig = window.UniBoxSettings;
  const SESSION_KEY_FORM = `unibox_form_submitted_${userConfig.tenantId}`;
  const STORAGE_KEY_OPEN = `unibox_open_${userConfig.tenantId}`;

  const defaults = {
    appearance: {
      primaryColor: "#007BFF",
      secondaryColor: "#F0F0F0",
      backgroundColor: "#FFFFFF",
      textColor: "#333333",
      fontFamily: "sans-serif",
      iconStyle: "circle",
      welcomeMessage: "Hello! How can we help?",
      logoUrl: "", 
    },
    behavior: {
      botDelayMs: 0,
      typingIndicator: false,
      autoOpen: false,
      stickyPlacement: "bottom-right",
    },
    preChatForm: { enabled: false, fields: [] }
  };

  const settings = deepMerge(defaults, userConfig);

  // --- 2. INITIALIZATION ---
  if (document.readyState === "complete") {
    init();
  } else {
    window.addEventListener("load", init);
  }

  function init() {
    loadGoogleFont(settings.appearance.fontFamily);
    renderWidget();
  }

  // --- 3. CORE RENDERING ---
  function renderWidget() {
    const host = document.createElement("div");
    host.id = "unibox-root";
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });

    // Styles
    const isRight = settings.behavior.stickyPlacement === "bottom-right";
    const borderRadius = settings.appearance.iconStyle === "rounded" ? "12px" : (settings.appearance.iconStyle === "square" ? "0px" : "50%");
    
    const styleTag = document.createElement("style");
    styleTag.textContent = `
      :host {
        --primary: ${settings.appearance.primaryColor};
        --secondary: ${settings.appearance.secondaryColor};
        --bg: ${settings.appearance.backgroundColor};
        --text: ${settings.appearance.textColor};
        --font: '${settings.appearance.fontFamily}', sans-serif;
        --radius: ${borderRadius};
        position: fixed; z-index: 2147483647; bottom: 0; left: 0; width: 0; height: 0;
        font-family: var(--font);
      }
      * { box-sizing: border-box; }
      
      .launcher {
        position: fixed; bottom: 20px; ${isRight ? "right: 20px;" : "left: 20px;"}
        width: 60px; height: 60px; background: var(--primary); border-radius: var(--radius);
        box-shadow: 0 4px 14px rgba(0,0,0,0.15); cursor: pointer;
        display: flex; align-items: center; justify-content: center; transition: transform 0.2s;
      }
      .launcher:hover { transform: scale(1.05); }

      .chat-window {
        position: fixed; bottom: 90px; ${isRight ? "right: 20px;" : "left: 20px;"}
        width: 380px; height: 600px; max-width: 90vw; max-height: 80vh;
        background: var(--bg); border-radius: 12px;
        box-shadow: 0 8px 30px rgba(0,0,0,0.12);
        display: flex; flex-direction: column; overflow: hidden;
        opacity: 0; pointer-events: none; transform: translateY(20px) scale(0.95);
        transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      }
      .chat-window.open { opacity: 1; pointer-events: auto; transform: translateY(0) scale(1); }

      .header { background: var(--primary); padding: 16px; color: #fff; display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
      .header-title { font-weight: 600; font-size: 16px; }

      .body { flex: 1; padding: 20px; overflow-y: auto; background-color: #f9f9f9; position: relative; }
      
      /* Messages */
      .bot-msg { background: #fff; padding: 12px 16px; border-radius: 12px; border-bottom-left-radius: 2px; box-shadow: 0 1px 2px rgba(0,0,0,0.05); color: #333; font-size: 14px; line-height: 1.5; max-width: 85%; margin-bottom: 15px; }

      /* Pre-Chat Form Styles */
      .form-container { display: flex; flex-direction: column; gap: 15px; background: #fff; padding: 20px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.05); }
      .form-label { font-size: 12px; font-weight: 600; color: #666; margin-bottom: 4px; display: block; }
      .form-input { width: 100%; padding: 10px; border: 1px solid #ddd; border-radius: 6px; font-size: 14px; }
      .form-input:focus { outline: none; border-color: var(--primary); }
      .form-btn { width: 100%; padding: 12px; background: var(--primary); color: white; border: none; border-radius: 6px; font-weight: 600; cursor: pointer; margin-top: 10px; }
      .form-btn:hover { opacity: 0.9; }

      /* Footer (Input) */
      .footer { padding: 12px; background: #fff; border-top: 1px solid #eee; display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
      .footer.hidden { display: none; } /* Hide footer when form is active */
      
      .input-wrapper { flex: 1; display: flex; align-items: center; background: #f5f5f5; border-radius: 20px; padding: 8px 12px; }
      .msg-input { flex: 1; border: none; background: transparent; outline: none; font-size: 14px; }
      .send-btn { background: var(--primary); color: white; border: none; width: 36px; height: 36px; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center; }
    `;

    // Icons
    const sendIcon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>`;
    const launcherIcon = settings.appearance.logoUrl 
      ? `<img src="${settings.appearance.logoUrl}" alt="Chat" style="border-radius:50%; width:30px; height:30px;" />`
      : `<svg width="28" height="28" viewBox="0 0 24 24" fill="white"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>`;

    // Container Construction
    const container = document.createElement("div");
    container.innerHTML = `
      <div class="launcher" id="launcherBtn">${launcherIcon}</div>
      <div class="chat-window" id="chatWindow">
        <div class="header">
           <div class="header-title">Support</div>
           <div id="closeBtn" style="margin-left:auto; cursor:pointer; font-size:20px;">&times;</div>
        </div>
        
        <div class="body" id="chatBody">
           </div>

        <div class="footer hidden" id="chatFooter">
           <div class="input-wrapper">
             <input type="text" class="msg-input" id="msgInput" placeholder="Type a message..." />
           </div>
           <button class="send-btn" id="sendBtn">${sendIcon}</button>
        </div>
      </div>
    `;

    shadow.appendChild(styleTag);
    shadow.appendChild(container);

    // --- 4. LOGIC & STATE MANAGEMENT ---
    
    // Check if form is enabled AND not yet submitted
    const isFormEnabled = settings.preChatForm.enabled;
    const hasSubmittedForm = sessionStorage.getItem(SESSION_KEY_FORM) === "true";
    
    // Determine initial view
    let currentView = (isFormEnabled && !hasSubmittedForm) ? 'form' : 'chat';

    const renderView = () => {
      const body = shadow.getElementById("chatBody");
      const footer = shadow.getElementById("chatFooter");
      body.innerHTML = ''; // Clear previous content

      if (currentView === 'form') {
        // HIDE Footer, SHOW Form
        footer.classList.add('hidden');
        
        // Render Form HTML
        const formHtml = settings.preChatForm.fields.map(f => `
          <div>
            <label class="form-label">${f.label}</label>
            <input class="form-input" type="${f.type}" name="${f.id}" ${f.required ? 'required' : ''} placeholder="Enter your ${f.label.toLowerCase()}">
          </div>
        `).join('');

        const formContainer = document.createElement('div');
        formContainer.className = 'form-container';
        formContainer.innerHTML = `
          <div style="text-align:center; margin-bottom:10px; font-weight:600;">Please fill details to start chat</div>
          <form id="preChatForm">
            ${formHtml}
            <button type="submit" class="form-btn">Start Chat</button>
          </form>
        `;
        body.appendChild(formContainer);

        // Bind Form Submit
        const formEl = formContainer.querySelector('#preChatForm');
        formEl.addEventListener('submit', (e) => {
          e.preventDefault();
          const formData = new FormData(formEl);
          const data = Object.fromEntries(formData.entries());
          
          console.log("UniBox: Form Data Collected", data);
          
          // Save state so we don't ask again this session
          sessionStorage.setItem(SESSION_KEY_FORM, "true");
          
          // Switch View
          currentView = 'chat';
          renderView();
        });

      } else {
        // SHOW Chat, SHOW Footer
        footer.classList.remove('hidden');
        
        // Show Welcome Message
        const msgDiv = document.createElement('div');
        msgDiv.className = 'bot-msg';
        msgDiv.textContent = settings.appearance.welcomeMessage;
        body.appendChild(msgDiv);
      }
    };

    // Render the initial view state
    renderView();

    // Bind Toggle Events
    const launcher = shadow.getElementById("launcherBtn");
    const windowEl = shadow.getElementById("chatWindow");
    const closeBtn = shadow.getElementById("closeBtn");

    const toggle = (forceState) => {
      const isOpen = windowEl.classList.contains("open");
      const nextState = forceState !== undefined ? forceState : !isOpen;
      
      if (nextState) windowEl.classList.add("open");
      else windowEl.classList.remove("open");
      
      if (settings.behavior.stickyPlacement) {
        localStorage.setItem(STORAGE_KEY_OPEN, nextState);
      }
    };

    launcher.addEventListener("click", () => toggle());
    closeBtn.addEventListener("click", () => toggle(false));

    // Handle Auto-Open
    if (settings.behavior.autoOpen) {
        // Check if user has explicitly closed it before
        const hasHistory = localStorage.getItem(STORAGE_KEY_OPEN);
        
        // If no history (new user) OR if the history says it was left open
        if (hasHistory === null || hasHistory === "true") {
           setTimeout(() => toggle(true), settings.behavior.botDelayMs);
        }
    }
  }

  // Utilities
  function deepMerge(target, source) {
    for (const key in source) {
      if (source[key] instanceof Object && key in target) {
        Object.assign(source[key], deepMerge(target[key], source[key]));
      }
    }
    Object.assign(target || {}, source);
    return target;
  }
  function loadGoogleFont(font) {
    if (!font) return;
    const link = document.createElement('link');
    link.href = `https://fonts.googleapis.com/css2?family=${font.replace(/ /g, '+')}&display=swap`;
    link.rel = 'stylesheet';
    document.head.appendChild(link);
  }
})();
