(function () {
  // 1. Validation
  if (!window.UniBoxSettings || !window.UniBoxSettings.tenantId) {
    console.error("UniBox: Settings or Tenant ID missing.");
    return;
  }

  const userConfig = window.UniBoxSettings;

  // 2. Defaults
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

  // 3. Merge Config
  const settings = deepMerge(defaults, userConfig);

  // 4. Initialize
  if (document.readyState === "complete") {
    init();
  } else {
    window.addEventListener("load", init);
  }

  function init() {
    loadGoogleFont(settings.appearance.fontFamily);
    renderWidget();
  }

  function renderWidget() {
    const host = document.createElement("div");
    host.id = "unibox-root";
    document.body.appendChild(host);

    const shadow = host.attachShadow({ mode: "open" });

    // CSS Configuration
    const isRight = settings.behavior.stickyPlacement === "bottom-right";
    const positionCss = isRight ? "right: 20px;" : "left: 20px;";
    
    let borderRadius = "50%";
    if (settings.appearance.iconStyle === "rounded") borderRadius = "12px";
    if (settings.appearance.iconStyle === "square") borderRadius = "0px";

    const styleTag = document.createElement("style");
    styleTag.textContent = `
      :host {
        --primary: ${settings.appearance.primaryColor};
        --secondary: ${settings.appearance.secondaryColor};
        --bg: ${settings.appearance.backgroundColor};
        --text: ${settings.appearance.textColor};
        --font: '${settings.appearance.fontFamily}', sans-serif;
        --radius: ${borderRadius};
        
        position: fixed;
        z-index: 2147483647;
        bottom: 0; left: 0; width: 0; height: 0;
        font-family: var(--font);
      }

      * { box-sizing: border-box; }

      /* LAUNCHER */
      .launcher {
        position: fixed;
        bottom: 20px;
        ${positionCss}
        width: 60px; height: 60px;
        background: var(--primary);
        border-radius: var(--radius);
        box-shadow: 0 4px 14px rgba(0,0,0,0.15);
        cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        transition: transform 0.2s;
      }
      .launcher:hover { transform: scale(1.05); }

      /* CHAT WINDOW */
      .chat-window {
        position: fixed;
        bottom: 90px;
        ${positionCss}
        width: 380px; height: 600px;
        max-width: 90vw; max-height: 80vh;
        background: var(--bg);
        border-radius: 12px;
        box-shadow: 0 8px 30px rgba(0,0,0,0.12);
        display: flex; flex-direction: column;
        overflow: hidden;
        opacity: 0; pointer-events: none;
        transform: translateY(20px) scale(0.95);
        transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1);
      }
      .chat-window.open { opacity: 1; pointer-events: auto; transform: translateY(0) scale(1); }

      /* HEADER */
      .header {
        background: var(--primary);
        padding: 16px;
        color: #fff;
        display: flex; align-items: center; gap: 12px;
        flex-shrink: 0;
      }
      .header-title { font-weight: 600; font-size: 16px; }

      /* BODY */
      .body {
        flex: 1;
        padding: 20px;
        overflow-y: auto;
        background-color: var(--secondary);
      }
      .bot-msg {
        background: #fff;
        padding: 12px 16px;
        border-radius: 12px; border-bottom-left-radius: 2px;
        box-shadow: 0 1px 2px rgba(0,0,0,0.05);
        color: #333; font-size: 14px; line-height: 1.5;
        max-width: 85%;
      }

      /* FOOTER (INPUT AREA) - NEW SECTION */
      .footer {
        padding: 12px;
        background: #fff;
        border-top: 1px solid #eee;
        display: flex;
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
      }
      
      .input-wrapper {
        flex: 1;
        display: flex;
        align-items: center;
        background: #f5f5f5;
        border-radius: 20px;
        padding: 8px 12px;
      }

      .msg-input {
        flex: 1;
        border: none;
        background: transparent;
        outline: none;
        font-family: inherit;
        font-size: 14px;
        color: var(--text);
      }

      .icon-btn {
        background: none;
        border: none;
        cursor: pointer;
        padding: 4px;
        display: flex; align-items: center; justify-content: center;
        color: #888;
        transition: color 0.2s;
      }
      .icon-btn:hover { color: var(--primary); }
      
      .send-btn {
        background: var(--primary);
        color: white;
        border: none;
        width: 36px; height: 36px;
        border-radius: 50%;
        cursor: pointer;
        display: flex; align-items: center; justify-content: center;
        transition: opacity 0.2s;
      }
      .send-btn:hover { opacity: 0.9; }
      
      /* Hidden File Input */
      #fileInput { display: none; }
    `;

    // SVG Icons
    const clipIcon = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"></path></svg>`;
    const sendIcon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>`;

    const container = document.createElement("div");
    
    // Logo Logic
    const launcherIcon = settings.appearance.logoUrl 
      ? `<img src="${settings.appearance.logoUrl}" alt="Chat" style="border-radius:50%; width:30px; height:30px;" />`
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
        
        <div class="body" id="chatBody">
           <div class="bot-msg">${settings.appearance.welcomeMessage}</div>
        </div>

        <div class="footer">
           <div class="input-wrapper">
             <button class="icon-btn" id="attachBtn" title="Attach File">${clipIcon}</button>
             <input type="file" id="fileInput" />
             <input type="text" class="msg-input" id="msgInput" placeholder="Type a message..." />
           </div>
           <button class="send-btn" id="sendBtn">${sendIcon}</button>
        </div>
      </div>
    `;

    shadow.appendChild(styleTag);
    shadow.appendChild(container);

    bindEvents(shadow, settings);
  }

  function bindEvents(shadow, settings) {
    // UI Elements
    const launcher = shadow.getElementById("launcherBtn");
    const windowEl = shadow.getElementById("chatWindow");
    const closeBtn = shadow.getElementById("closeBtn");
    
    // Input Elements
    const msgInput = shadow.getElementById("msgInput");
    const sendBtn = shadow.getElementById("sendBtn");
    const attachBtn = shadow.getElementById("attachBtn");
    const fileInput = shadow.getElementById("fileInput");

    // Toggle Logic
    const toggle = (state) => {
      const isOpen = windowEl.classList.contains("open");
      const nextState = state !== undefined ? state : !isOpen;
      
      if (nextState) windowEl.classList.add("open");
      else windowEl.classList.remove("open");
      
      if (settings.behavior.stickyPlacement) {
        localStorage.setItem("unibox_open", nextState);
      }
    };

    launcher.addEventListener("click", () => toggle());
    closeBtn.addEventListener("click", () => toggle(false));

    // --- Message Handling Logic ---

    const handleSend = () => {
      const text = msgInput.value.trim();
      const files = fileInput.files;

      if (!text && files.length === 0) return;

      // 1. Prepare Payload
      const payload = {
        text: text,
        files: files.length > 0 ? files[0] : null,
        timestamp: new Date().toISOString()
      };

      console.log("UniBox: Message Sent:", payload);

      // 2. Here you would trigger your API call or Socket event
      // e.g., socket.emit('message', payload);

      // 3. Clear Inputs
      msgInput.value = "";
      fileInput.value = ""; // Clear file selection
    };

    // Send on Button Click
    sendBtn.addEventListener("click", handleSend);

    // Send on Enter Key (prevent if Shift+Enter)
    msgInput.addEventListener("keypress", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    });

    // File Attachment Logic
    attachBtn.addEventListener("click", () => {
      fileInput.click();
    });

    fileInput.addEventListener("change", (e) => {
      if (e.target.files.length > 0) {
        // Visual feedback that file is selected (Optional)
        msgInput.placeholder = `📎 ${e.target.files[0].name}`;
        msgInput.focus();
      }
    });

    // --- Auto Open Logic ---
    if (settings.behavior.autoOpen) {
       if (localStorage.getItem("unibox_open") === null) {
          setTimeout(() => toggle(true), settings.behavior.botDelayMs);
       }
    } else if (localStorage.getItem("unibox_open") === "true") {
      toggle(true);
    }
  }

  function deepMerge(target, source) {
    for (const key in source) {
      if (source[key] instanceof Object && key in target) {
        Object.assign(source[key], deepMerge(target[key], source[key]));
      }
    }
    Object.assign(target || {}, source);
    return target;
  }

  function loadGoogleFont(fontName) {
    if (!fontName || fontName === 'sans-serif') return;
    const link = document.createElement('link');
    link.href = `https://fonts.googleapis.com/css2?family=${fontName.replace(/ /g, '+')}:wght@400;500;600&display=swap`;
    link.rel = 'stylesheet';
    document.head.appendChild(link);
  }

})();
