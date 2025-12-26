(function () {
  // --- 1. CONFIGURATION ---
  if (!window.UniBoxSettings || !window.UniBoxSettings.tenantId) {
    console.error("UniBox: Settings or Tenant ID missing.");
    return;
  }

  const userConfig = window.UniBoxSettings;
  const SESSION_KEY_FORM = `unibox_form_submitted_${userConfig.tenantId}`;
  const STORAGE_KEY_USER = `unibox_guest_${userConfig.tenantId}`;
  
  // 1. Base API URL (e.g., http://localhost:3011/pulse/v1/chat)
  const API_BASE = userConfig.apiBaseUrl || "https://api.yourdomain.com/pulse/v1/chat";
  
  // 2. S3 URL (e.g., .../pulse/v1/s3/generate-access-url)
  const API_S3_URL = API_BASE.replace(/\/chat\/?$/, "/s3/generate-access-url");

  // 3. SOCKET CONFIGURATION HELPER
  function getSocketConfig(apiBase) {
    try {
      const urlObj = new URL(apiBase);
      // Remove '/chat' from the end to get the base '.../pulse/v1'
      const basePath = urlObj.pathname.replace(/\/chat\/?$/, ""); 
      
      return {
        // Namespace: http://localhost:3011/pulse/v1/events
        namespaceUrl: `${urlObj.protocol}//${urlObj.host}${basePath}/events`,
        // Engine Path: /pulse/v1/socket.io/
        path: `${basePath}/socket.io/`
      };
    } catch (e) {
      console.error("UniBox: Invalid API URL", e);
      return { namespaceUrl: "", path: "" };
    }
  }
  
  const SOCKET_CONFIG = getSocketConfig(API_BASE);

  const defaults = {
    tenantId: "",
    apiKey: "",
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
  let socket = null;
  let userId = localStorage.getItem(STORAGE_KEY_USER);
  let resolvedLogoUrl = ""; 

  if (!userId) {
    userId = `guest_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    localStorage.setItem(STORAGE_KEY_USER, userId);
  }

  // --- 3. HELPER: HEADERS ---
  function getHeaders() {
    return {
      "Content-Type": "application/json",
      "x-tenant-id": settings.tenantId
    };
  }

  // --- 4. DEPENDENCY LOADER (Socket.IO) ---
  function loadSocketScript(callback) {
    if (window.io) {
      callback();
      return;
    }
    const script = document.createElement('script');
    script.src = "https://cdn.socket.io/4.7.4/socket.io.min.js";
    script.onload = callback;
    document.head.appendChild(script);
  }

  // --- 5. INITIALIZATION ---
  if (document.readyState === "complete") {
    init();
  } else {
    window.addEventListener("load", init);
  }

  async function init() {
    loadGoogleFont(settings.appearance.fontFamily);
    
    // 1. Resolve Logo URL
    if (settings.appearance.logoUrl) {
      try {
        resolvedLogoUrl = await fetchSignedUrl(settings.appearance.logoUrl);
      } catch (err) {
        console.warn("UniBox: Failed to load logo", err);
      }
    }

    // 2. Render Widget
    renderWidget();

    // 3. Load Socket Library then Initialize Chat
    loadSocketScript(() => {
        const hasSubmittedForm = sessionStorage.getItem(SESSION_KEY_FORM) === "true";
        if (!settings.preChatForm.enabled || hasSubmittedForm) {
          initializeConversation();
        }
    });
  }

  // --- 6. S3 LOGIC ---
  async function fetchSignedUrl(fileName) {
    if (fileName.startsWith('http')) return fileName;

    try {
      const res = await fetch(API_S3_URL, {
        method: "POST",
        headers: {
            ...getHeaders(),
            "x-api-key": settings.apiKey 
        }, 
        body: JSON.stringify({ fileName: fileName })
      });

      if (!res.ok) throw new Error("S3 Sign failed");
      
      const data = await res.text();
      try {
         const json = JSON.parse(data);
         return json.url || json.signedUrl || data;
      } catch(e) {
         return data; 
      }
    } catch (error) {
      return ""; 
    }
  }

  // --- 7. API & SOCKET LOGIC ---

  async function initializeConversation(userDetails = {}) {
    if (conversationId) return; 

    // 1. Try Restore Thread
    try {
      const restoreRes = await fetch(`${API_BASE}/thread/${userId}?limit=50`, {
        method: "GET",
        headers: getHeaders()
      });

      if (restoreRes.ok) {
        const data = await restoreRes.json();
        if (data.conversation) {
          conversationId = data.conversation.id;
          
          // Render History
          if (data.messages && Array.isArray(data.messages)) {
             data.messages.forEach(msg => appendMessageToUI(msg.text, msg.sender));
          }
          
          connectSocket();
          return; 
        }
      }
    } catch (e) {
      // console.warn("UniBox: Restore failed/empty, creating new.");
    }

    // 2. Create New Conversation
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
      
      connectSocket();
      
    } catch (error) {
      console.error("UniBox: Init Error", error);
    }
  }

  function connectSocket() {
    if (socket || !conversationId || !window.io) return;

    // --- SOCKET CONNECTION FIX ---
    // We must pass the 'path' option so it hits /pulse/v1/socket.io/ instead of root
    socket = window.io(SOCKET_CONFIG.namespaceUrl, {
      path: SOCKET_CONFIG.path,  // <--- THIS IS THE CRITICAL FIX
      auth: {
        tenantId: settings.tenantId
      },
      transports: ['websocket', 'polling'],
      reconnection: true
    });

    socket.on('connect', () => {
      console.log("UniBox: Socket Connected to", SOCKET_CONFIG.namespaceUrl);
      
      // Join Room
      socket.emit('join', {
        type: 'chat',
        conversationId: conversationId
      });
    });

    socket.on('message', (message) => {
      // Only display messages from 'agent'
      if (message.sender === 'agent') {
        appendMessageToUI(message.text, 'agent');
      }
    });
    
    socket.on('connect_error', (err) => {
        console.error("UniBox: Socket Connection Error", err.message);
    });

    socket.on('disconnect', () => {
      console.log("UniBox: Socket Disconnected");
    });
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
      msgDiv.style.cssText = `
        background: var(--primary); color: white; padding: 12px 16px; 
        border-radius: 12px; border-bottom-right-radius: 2px;
        font-size: 14px; line-height: 1.5; max-width: 85%; 
        margin-bottom: 15px; align-self: flex-end; margin-left: auto; word-break: break-word;
      `;
    }
    
    body.appendChild(msgDiv);
    requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
  }


  // --- 8. UI RENDERING ---
  function renderWidget() {
    const host = document.createElement("div");
    host.id = "unibox-root";
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });

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

    const headerLogoImg = resolvedLogoUrl 
        ? `<img src="${resolvedLogoUrl}" class="header-logo" alt="Logo" />` 
        : '';

    const launcherContent = resolvedLogoUrl 
        ? `<img src="${resolvedLogoUrl}" class="launcher-img" alt="Chat" />`
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

    // --- 9. VIEW LOGIC ---
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
          
          // --- FORM DATA EXTRACTION ---
          let capturedName = "";
          let capturedEmail = "";

          settings.preChatForm.fields.forEach(field => {
            const val = data[field.id];
            if(!val) return;

            if (field.type === 'text' && 
               (field.label.toLowerCase().includes('name') || field.id.toLowerCase().includes('name'))) {
                capturedName = val;
            }
            if (field.type === 'email' || field.id.toLowerCase().includes('email')) {
                capturedEmail = val;
            }
          });

          if (!capturedName && capturedEmail) {
            capturedName = capturedEmail;
          }

          // Initialize with extracted data
          loadSocketScript(() => {
              initializeConversation({
                name: capturedName, 
                email: capturedEmail
              });
          });

          sessionStorage.setItem(SESSION_KEY_FORM, "true");
          currentView = 'chat';
          renderView();
        });

      } else {
        footer.classList.remove('hidden');
        
        const msgDiv = document.createElement('div');
        msgDiv.className = 'bot-msg';
        
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

    // --- 10. EVENTS ---
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
