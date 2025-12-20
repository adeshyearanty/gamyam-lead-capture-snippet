(function () {
  // --- 1. CONFIGURATION ---
  if (!window.UniBoxSettings || !window.UniBoxSettings.tenantId) {
    console.error("UniBox: Settings or Tenant ID missing.");
    return;
  }

  const userConfig = window.UniBoxSettings;
  const SESSION_KEY_FORM = `unibox_form_submitted_${userConfig.tenantId}`;
  const STORAGE_KEY_OPEN = `unibox_open_${userConfig.tenantId}`;
  const STORAGE_KEY_USER = `unibox_guest_${userConfig.tenantId}`;
  
  const API_BASE = userConfig.apiBaseUrl || "https://api.yourdomain.com/messages/v1/chat";

  const defaults = {
    tenantId: "",
    apiKey: "",
    apiBaseUrl: "",
    appearance: {
      primaryColor: "#2563EB",
      secondaryColor: "#1D4ED8",
      backgroundColor: "#FFFFFF",
      fontFamily: "Inter, system-ui, -apple-system, BlinkMacSystemFont",
      iconStyle: "rounded",
      logoUrl: "",
      header: {
        title: "Support",
        welcomeMessage: "Hi there! How can we help?",
        offlineMessage: "We are currently offline."
      },
      headerName: "Support", 
      welcomeMessage: "Hi there! How can we help?",
      chatToggleIcon: {
        backgroundColor: "#2563EB", 
        style: "rounded"
      }
    },
    behavior: {
      botDelayMs: 600,
      typingIndicator: true,
      autoOpen: false,
      autoOpenDelay: 2000,
      stickyPlacement: "bottom-right"
    },
    preChatForm: {
      enabled: false,
      fields: []
    }
  };

  const settings = deepMerge(defaults, userConfig);

  // --- 2. STATE ---
  let conversationId = null;
  let isStreamActive = false;
  let streamController = null;
  let userId = localStorage.getItem(STORAGE_KEY_USER);

  if (!userId) {
    userId = `guest_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    localStorage.setItem(STORAGE_KEY_USER, userId);
  }

  // --- 3. HELPER: HEADERS ---
  function getHeaders() {
    return {
      "Content-Type": "application/json",
      "x-tenant-id": settings.tenantId,
      "x-api-key": settings.apiKey
    };
  }

  // --- 4. INITIALIZATION ---
  if (document.readyState === "complete") {
    init();
  } else {
    window.addEventListener("load", init);
  }

  function init() {
    loadGoogleFont(settings.appearance.fontFamily);
    renderWidget();

    const hasSubmittedForm = sessionStorage.getItem(SESSION_KEY_FORM) === "true";
    if (!settings.preChatForm.enabled || hasSubmittedForm) {
      initializeConversation();
    }
  }

  // --- 5. API LOGIC (RESTORE + STREAM) ---

  async function initializeConversation(userDetails = {}) {
    if (conversationId) return; 

    // 1. TRY TO RESTORE EXISTING THREAD
    try {
      console.log("UniBox: Attempting to restore thread for", userId);
      const restoreRes = await fetch(`${API_BASE}/thread/${userId}?limit=50`, {
        method: "GET",
        headers: getHeaders()
      });

      if (restoreRes.ok) {
        const data = await restoreRes.json();
        
        if (data.conversation) {
          conversationId = data.conversation.id;
          console.log("UniBox: Restored Conversation:", conversationId);

          // RENDER HISTORY
          if (data.messages && Array.isArray(data.messages)) {
             data.messages.forEach(msg => {
               // Map API 'sender' to UI 'type'
               // API: sender="user" | "agent"
               // UI: type="user" | "agent"
               appendMessageToUI(msg.text, msg.sender);
             });
          }

          // Connect to Stream
          connectToStream();
          return; // Exit, we are done
        }
      }
    } catch (e) {
      console.warn("UniBox: Could not restore thread, creating new one.", e);
    }

    // 2. IF RESTORE FAILS, CREATE NEW CONVERSATION
    try {
      const res = await fetch(`${API_BASE}/conversation`, {
        method: "POST",
        headers: getHeaders(), 
        body: JSON.stringify({
          userId: userId,
          userName: userDetails.name || "Guest User",
          userEmail: userDetails.email || ""
        })
      });

      if (!res.ok) throw new Error("Failed to start conversation");
      
      const data = await res.json();
      conversationId = data.conversationId;
      console.log("UniBox: New Conversation Started:", conversationId);
      
      connectToStream();
      
    } catch (error) {
      console.error("UniBox: Init Error", error);
    }
  }

  async function connectToStream() {
    if (isStreamActive || !conversationId) return;
    
    streamController = new AbortController();
    isStreamActive = true;

    try {
      const response = await fetch(`${API_BASE}/stream/${conversationId}`, {
        method: "GET",
        headers: getHeaders(),
        signal: streamController.signal
      });

      if (!response.ok) throw new Error(`Stream failed: ${response.status}`);

      const reader = response.body.getReader();
      const decoder = new TextDecoder("utf-8");
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const blocks = buffer.split("\n\n");
        buffer = blocks.pop(); 

        for (const block of blocks) {
          const lines = block.split("\n");
          for (const line of lines) {
            if (line.trim().startsWith("data:")) {
              const jsonStr = line.replace("data:", "").trim();
              if (!jsonStr) continue;
              try {
                const msg = JSON.parse(jsonStr);
                // Only handle AGENT messages here (User msgs are optimistic)
                if (msg.sender === 'agent') {
                  appendMessageToUI(msg.text, 'agent');
                }
              } catch (e) { console.error(e); }
            }
          }
        }
      }
    } catch (err) {
      if (err.name !== 'AbortError') console.warn("UniBox: Stream disconnected", err);
    } finally {
      isStreamActive = false;
      if (!streamController.signal.aborted) setTimeout(connectToStream, 5000);
    }
  }

  async function sendMessageToApi(text) {
    if (!conversationId) {
      await initializeConversation(); 
      if (!conversationId) return;
    }

    try {
      await fetch(`${API_BASE}/message/user`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({
          conversationId: conversationId,
          text: text,
          userId: userId
        })
      });
    } catch (error) {
      console.error("UniBox: Send Error", error);
      appendMessageToUI("⚠️ Failed to send message.", 'bot-msg');
    }
  }

  function appendMessageToUI(text, type) {
    const host = document.getElementById("unibox-root");
    if (!host || !host.shadowRoot) return;
    
    const body = host.shadowRoot.getElementById("chatBody");
    if (!body) return;

    const msgDiv = document.createElement('div');
    
    if (type === 'agent') {
      msgDiv.className = 'bot-msg';
      msgDiv.textContent = text;
    } else {
      msgDiv.textContent = text;
      // User Message Style
      msgDiv.style.cssText = `
        background: var(--primary); color: white; padding: 12px 16px; 
        border-radius: 12px; border-bottom-right-radius: 2px;
        font-size: 14px; line-height: 1.5; max-width: 85%; 
        margin-bottom: 15px; align-self: flex-end; margin-left: auto; word-break: break-word;
      `;
    }
    
    body.appendChild(msgDiv);
    // Scroll to bottom
    requestAnimationFrame(() => {
        body.scrollTop = body.scrollHeight;
    });
  }


  // --- 6. CORE RENDERING ---
  function renderWidget() {
    const host = document.createElement("div");
    host.id = "unibox-root";
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });

    // Styles & Logic
    const launcherBg = settings.appearance.chatToggleIcon.backgroundColor || settings.appearance.primaryColor;
    const launcherIconColor = (launcherBg.toLowerCase() === '#ffffff' || launcherBg.toLowerCase() === '#fff') 
      ? settings.appearance.primaryColor 
      : '#FFFFFF';
    
    const placement = settings.behavior.stickyPlacement || "bottom-right";
    const isTop = placement.includes("top");
    const isRight = placement.includes("right");

    const horizontalCss = isRight ? "right: 20px;" : "left: 20px;";
    const verticalLauncherCss = isTop ? "top: 20px;" : "bottom: 20px;";
    const verticalWindowCss = isTop ? "top: 90px;" : "bottom: 90px;";
    const hiddenTransform = isTop ? "translateY(-20px)" : "translateY(20px)";

    const getRadius = (style) => {
        if (style === "rounded") return "12px";
        if (style === "square") return "0px";
        return "50%";
    };
    const launcherRadius = getRadius(settings.appearance.chatToggleIcon.style);
    
    const styleTag = document.createElement("style");
    styleTag.textContent = `
      :host {
        --primary: ${settings.appearance.primaryColor};
        --secondary: ${settings.appearance.secondaryColor};
        --bg: ${settings.appearance.backgroundColor};
        --launcher-bg: ${launcherBg};
        --launcher-color: ${launcherIconColor};
        --font: '${settings.appearance.fontFamily}', sans-serif;
        --radius: 12px;
        position: fixed; z-index: 2147483647; 
        top: auto; bottom: auto; left: auto; right: auto;
        font-family: var(--font);
      }
      * { box-sizing: border-box; }
      
      .launcher {
        position: fixed; ${verticalLauncherCss} ${horizontalCss}
        width: 60px; height: 60px; background: var(--launcher-bg); color: var(--launcher-color);
        border-radius: ${launcherRadius}; box-shadow: 0 4px 14px rgba(0,0,0,0.15); 
        cursor: pointer; display: flex; align-items: center; justify-content: center; 
        transition: transform 0.2s, box-shadow 0.2s; overflow: hidden;
      }
      .launcher:hover { transform: scale(1.05); box-shadow: 0 6px 20px rgba(0,0,0,0.2); }
      .launcher-img { width: 100%; height: 100%; object-fit: cover; }

      .chat-window {
        position: fixed; ${verticalWindowCss} ${horizontalCss}
        width: 380px; height: 600px; max-width: 90vw; max-height: 80vh;
        background: #ffffff; border-radius: var(--radius);
        box-shadow: 0 8px 30px rgba(0,0,0,0.12); display: flex; flex-direction: column; overflow: hidden;
        opacity: 0; pointer-events: none; transform: ${hiddenTransform} scale(0.95);
        transition: all 0.25s cubic-bezier(0.16, 1, 0.3, 1); border: 1px solid rgba(0,0,0,0.05);
      }
      .chat-window.open { opacity: 1; pointer-events: auto; transform: translateY(0) scale(1); }

      .header { background: var(--primary); padding: 16px; color: #fff; display: flex; align-items: center; gap: 12px; flex-shrink: 0; }
      .header-logo { width: 32px; height: 32px; border-radius: 50%; background: #fff; padding: 2px; object-fit: cover; }
      .header-title { font-weight: 600; font-size: 16px; letter-spacing: 0.3px; }

      .body { flex: 1; padding: 20px; overflow-y: auto; background-color: #f9f9f9; position: relative; }
      .bot-msg { background: #fff; padding: 12px 16px; border-radius: 12px; border-bottom-left-radius: 2px; box-shadow: 0 1px 2px rgba(0,0,0,0.05); color: #333; font-size: 14px; line-height: 1.5; max-width: 85%; margin-bottom: 15px; }

      .form-container { display: flex; flex-direction: column; gap: 15px; background: #fff; padding: 24px; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.05); }
      .form-group { display: flex; flex-direction: column; gap: 6px; }
      .form-label { font-size: 13px; font-weight: 500; color: #374151; }
      .form-input { width: 100%; padding: 10px; border: 1px solid #E5E7EB; border-radius: 6px; font-size: 14px; transition: border-color 0.2s; font-family: inherit; }
      .form-input:focus { outline: none; border-color: var(--primary); }
      textarea.form-input { min-height: 80px; resize: vertical; }
      .form-btn { width: 100%; padding: 12px; background: var(--primary); color: white; border: none; border-radius: 6px; font-weight: 600; cursor: pointer; margin-top: 5px; }
      .form-btn:hover { opacity: 0.9; }

      .footer { padding: 12px; background: #fff; border-top: 1px solid #eee; display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
      .footer.hidden { display: none; }
      .input-wrapper { flex: 1; display: flex; align-items: center; background: #f3f4f6; border-radius: 20px; padding: 8px 12px; }
      .msg-input { flex: 1; border: none; background: transparent; outline: none; font-size: 14px; color: #1f2937; }
      .send-btn { background: var(--primary); color: white; border: none; width: 36px; height: 36px; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center; }
    `;

    const sendIcon = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"></line><polygon points="22 2 15 22 11 13 2 9 22 2"></polygon></svg>`;
    const chatIcon = `<svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>`;

    const container = document.createElement("div");

    const headerLogoImg = settings.appearance.logoUrl 
        ? `<img src="${settings.appearance.logoUrl}" class="header-logo" alt="Logo" />` 
        : '';

    const launcherContent = settings.appearance.logoUrl 
        ? `<img src="${settings.appearance.logoUrl}" class="launcher-img" alt="Chat" />`
        : chatIcon;

    container.innerHTML = `
      <div class="launcher" id="launcherBtn">${launcherContent}</div>
      <div class="chat-window" id="chatWindow">
        <div class="header">
           ${headerLogoImg}
           <div class="header-title">${settings.appearance.header?.title || settings.appearance.headerName}</div>
           <div id="closeBtn" style="margin-left:auto; cursor:pointer; font-size:24px; opacity:0.8; line-height: 1;">&times;</div>
        </div>
        <div class="body" id="chatBody"></div>
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

    // --- 7. VIEW LOGIC ---
    const isFormEnabled = settings.preChatForm.enabled;
    const hasSubmittedForm = sessionStorage.getItem(SESSION_KEY_FORM) === "true";
    let currentView = (isFormEnabled && !hasSubmittedForm) ? 'form' : 'chat';

    const renderView = () => {
      const body = shadow.getElementById("chatBody");
      const footer = shadow.getElementById("chatFooter");
      body.innerHTML = ''; 

      if (currentView === 'form') {
        footer.classList.add('hidden');
        
        const fieldsHtml = settings.preChatForm.fields.map(f => {
          let inputHtml = '';
          const isRequired = f.required ? 'required' : '';
          
          if (f.type === 'textarea') {
            inputHtml = `<textarea class="form-input" name="${f.id}" ${isRequired} placeholder="${f.label}"></textarea>`;
          } else {
            const inputType = f.type === 'phone' ? 'tel' : f.type;
            inputHtml = `<input class="form-input" type="${inputType}" name="${f.id}" ${isRequired} placeholder="${f.label}">`;
          }

          return `
            <div class="form-group">
              <label class="form-label">${f.label}${f.required ? ' <span style="color:red">*</span>' : ''}</label>
              ${inputHtml}
            </div>
          `;
        }).join('');

        const formContainer = document.createElement('div');
        formContainer.className = 'form-container';
        formContainer.innerHTML = `
          <div style="text-align:center; margin-bottom:5px; font-weight:600; font-size:16px; color:#111;">Welcome</div>
          <div style="text-align:center; margin-bottom:20px; font-size:14px; color:#666;">Please fill in your details to continue.</div>
          <form id="preChatForm">
            ${fieldsHtml}
            <button type="submit" class="form-btn">Start Chat</button>
          </form>
        `;
        body.appendChild(formContainer);
        
        const formEl = formContainer.querySelector('#preChatForm');
        formEl.addEventListener('submit', (e) => {
          e.preventDefault();
          const formData = new FormData(formEl);
          const data = Object.fromEntries(formData.entries());
          
          initializeConversation({
            name: data.name || data["field-1766210497404"],
            email: data.email
          });

          sessionStorage.setItem(SESSION_KEY_FORM, "true");
          currentView = 'chat';
          renderView();
        });

      } else {
        footer.classList.remove('hidden');
        
        // On View load, we don't clear body here if we are restoring history.
        // But if history is empty, we show welcome message
        const msgDiv = document.createElement('div');
        msgDiv.className = 'bot-msg';
        
        // Only show welcome if body is empty (no restored messages)
        if(body.children.length === 0) {
            if(settings.behavior.typingIndicator) {
                msgDiv.textContent = "...";
                body.appendChild(msgDiv);
                setTimeout(() => {
                    msgDiv.textContent = settings.appearance.header?.welcomeMessage || settings.appearance.welcomeMessage;
                }, settings.behavior.botDelayMs);
            } else {
                msgDiv.textContent = settings.appearance.header?.welcomeMessage || settings.appearance.welcomeMessage;
                body.appendChild(msgDiv);
            }
        }
      }
    };

    renderView();

    // --- 8. EVENTS ---
    const launcher = shadow.getElementById("launcherBtn");
    const windowEl = shadow.getElementById("chatWindow");
    const closeBtn = shadow.getElementById("closeBtn");
    const sendBtn = shadow.getElementById("sendBtn");
    const msgInput = shadow.getElementById("msgInput");

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

    const handleSend = () => {
        const text = msgInput.value.trim();
        if(!text) return;
        
        // Optimistic UI
        const userMsg = document.createElement('div');
        userMsg.textContent = text;
        userMsg.style.cssText = `
            background: var(--primary); color: white; padding: 12px 16px; 
            border-radius: 12px; border-bottom-right-radius: 2px;
            font-size: 14px; line-height: 1.5; max-width: 85%; 
            margin-bottom: 15px; align-self: flex-end; margin-left: auto; word-break: break-word;
        `;
        shadow.getElementById('chatBody').appendChild(userMsg);
        shadow.getElementById('chatBody').scrollTop = shadow.getElementById('chatBody').scrollHeight;
        msgInput.value = "";

        sendMessageToApi(text);
    };

    sendBtn.addEventListener("click", handleSend);
    msgInput.addEventListener("keypress", (e) => { if(e.key === 'Enter') handleSend(); });

    // Auto Open
    if (settings.behavior.autoOpen) {
        const hasHistory = localStorage.getItem(STORAGE_KEY_OPEN);
        if (hasHistory === null || hasHistory === "true") {
           const delay = settings.behavior.autoOpenDelay || 2000;
           setTimeout(() => toggle(true), delay);
        }
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
  
  function loadGoogleFont(font) {
    if (!font) return;
    const family = font.split(',')[0].replace(/['"]/g, '').trim();
    if (['sans-serif', 'serif', 'system-ui'].includes(family.toLowerCase())) return;
    const link = document.createElement('link');
    link.href = `https://fonts.googleapis.com/css2?family=${family.replace(/ /g, '+')}:wght@400;500;600&display=swap`;
    link.rel = 'stylesheet';
    document.head.appendChild(link);
  }
})();
