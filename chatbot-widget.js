(function () {
  // --- 1. CONFIGURATION ---
  if (!window.UniBoxSettings || !window.UniBoxSettings.tenantId) {
    console.error("UniBox: Settings or Tenant ID missing.");
    return;
  }

  const userConfig = window.UniBoxSettings;
  
  // Storage Keys
  const SESSION_KEY_FORM = `unibox_form_submitted_${userConfig.tenantId}`;
  const STORAGE_KEY_OPEN = `unibox_open_${userConfig.tenantId}`;
  const STORAGE_KEY_USER = `unibox_guest_${userConfig.tenantId}`;
  
  // API URLs
  const API_BASE = userConfig.apiBaseUrl || "https://api.yourdomain.com/pulse/v1/chat";
  const API_S3_URL = API_BASE.replace(/\/chat\/?$/, "/s3/generate-access-url");

  // Socket Config Helper
  function getSocketConfig(apiBase) {
    try {
      const urlObj = new URL(apiBase);
      const basePath = urlObj.pathname.replace(/\/chat\/?$/, ""); 
      return {
        namespaceUrl: `${urlObj.protocol}//${urlObj.host}${basePath}/events`,
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
    testMode: false,
    appearance: {
      primaryColor: "#2563EB",
      secondaryColor: "#F3F4F6", 
      backgroundColor: "#FFFFFF",
      fontFamily: "Inter, sans-serif",
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
  let userId = localStorage.getItem(STORAGE_KEY_USER); // Only load existing, don't create new
  let resolvedLogoUrl = "";
  let messages = new Map(); // Store messages with IDs for read receipt tracking
  let isAgentOnline = false;

  // --- 3. HELPER: HEADERS ---
  function getHeaders() {
    return {
      "Content-Type": "application/json",
      "x-tenant-id": settings.tenantId,
      "x-api-key": settings.apiKey
    };
  }

  // --- 4. HELPER: UI LOADING STATE ---
  function setLoading(isLoading) {
    const host = document.getElementById("unibox-root");
    if (!host || !host.shadowRoot) return;
    const body = host.shadowRoot.getElementById("chatBody");
    if (!body) return;

    if (isLoading) {
      body.innerHTML = `
        <div class="loader-container">
          <div class="loader"></div>
        </div>
      `;
    } else {
      // If the loader exists, remove it
      const loader = body.querySelector('.loader-container');
      if (loader) loader.remove();
    }
  }

  // --- 5. DEPENDENCY LOADER ---
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

  // --- 6. INITIALIZATION ---
  if (document.readyState === "complete") {
    init();
  } else {
    window.addEventListener("load", init);
  }

  async function init() {
    loadGoogleFont(settings.appearance.fontFamily);
    
    if (settings.appearance.logoUrl) {
      try {
        resolvedLogoUrl = await fetchSignedUrl(settings.appearance.logoUrl);
      } catch (err) {
        console.warn("UniBox: Failed to load logo", err);
      }
    }

    renderWidget();

    if (settings.testMode) {
        console.warn("UniBox: Running in TEST MODE.");
    }

    loadSocketScript(() => {
        // Only restore existing conversation if userId exists (user has sent messages before)
        // Don't create new conversation/contact until user sends first message
        if (userId) {
          const hasSubmittedForm = sessionStorage.getItem(SESSION_KEY_FORM) === "true";
          if (!settings.preChatForm.enabled || hasSubmittedForm) {
            restoreExistingConversation();
          }
        }
    });
  }

  // --- 7. S3 LOGIC ---
  async function fetchSignedUrl(fileName) {
    if (fileName.startsWith('http')) return fileName;
    try {
      const res = await fetch(API_S3_URL, {
        method: "POST",
        headers: getHeaders(), 
        body: JSON.stringify({ fileName: fileName })
      });
      if (!res.ok) throw new Error("S3 Sign failed");
      const data = await res.text();
      try { return JSON.parse(data).url || JSON.parse(data).signedUrl || data; } catch(e) { return data; }
    } catch (error) { return ""; }
  }

  // --- 8. API & SOCKET LOGIC ---
  
  /**
   * Restore existing conversation (only called if userId exists)
   * This doesn't create new conversation/contact, just restores existing one
   */
  async function restoreExistingConversation() {
    if (conversationId || !userId) return;
    
    setLoading(true);
    
    try {
      const restoreRes = await fetch(`${API_BASE}/thread/${userId}?limit=50`, {
        method: "GET",
        headers: getHeaders()
      });
      
      if (restoreRes.ok) {
        const data = await restoreRes.json();
        if (data.conversation) {
          conversationId = data.conversation.id;
          setLoading(false);
          
          // RENDER HISTORY
          if (data.messages && Array.isArray(data.messages)) {
            data.messages.forEach(msg => {
              appendMessageToUI(
                msg.text || msg.text_body, 
                msg.sender || (msg.direction === 'inbound' ? 'user' : 'agent'),
                msg.id || msg.messageId,
                msg.timestamp || msg.timestamp_meta,
                msg.status,
                msg.readAt,
                msg.readByUs,
                msg.readByUsAt
              );
            });
            markVisibleMessagesAsRead();
          }
          
          connectSocket();
        } else {
          setLoading(false);
        }
      } else {
        setLoading(false);
      }
    } catch (e) {
      setLoading(false);
    }
  }
  
  /**
   * Initialize conversation when user sends first message
   * This creates the conversation and contact
   */
  async function initializeConversation() {
    if (conversationId) return;
    
    // Create userId if it doesn't exist (first message)
    if (!userId) {
      userId = `guest_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      localStorage.setItem(STORAGE_KEY_USER, userId);
    }
    
    // Get user details from pre-chat form if available
    const userDetails = {};
    const hasSubmittedForm = sessionStorage.getItem(SESSION_KEY_FORM) === "true";
    if (hasSubmittedForm) {
      const storedName = sessionStorage.getItem(`${SESSION_KEY_FORM}_name`);
      const storedEmail = sessionStorage.getItem(`${SESSION_KEY_FORM}_email`);
      if (storedName) userDetails.name = storedName;
      if (storedEmail) userDetails.email = storedEmail;
    } 

    // START LOADING
    setLoading(true);

    try {
      // A. TRY RESTORE EXISTING THREAD (Skip in Test Mode)
      if (!settings.testMode) {
          try {
            const restoreRes = await fetch(`${API_BASE}/thread/${userId}?limit=50`, {
              method: "GET",
              headers: getHeaders()
            });
            if (restoreRes.ok) {
              const data = await restoreRes.json();
              if (data.conversation) {
                conversationId = data.conversation.id;
                
                // STOP LOADING
                setLoading(false);

                // RENDER HISTORY
                if (data.messages && Array.isArray(data.messages)) {
                   data.messages.forEach(msg => {
                     appendMessageToUI(
                       msg.text || msg.text_body, 
                       msg.sender || (msg.direction === 'inbound' ? 'user' : 'agent'),
                       msg.id || msg.messageId,
                       msg.timestamp || msg.timestamp_meta,
                       msg.status,
                       msg.readAt,
                       msg.readByUs,
                       msg.readByUsAt
                     );
                   });
                   // Mark messages as read after rendering
                   markVisibleMessagesAsRead();
                }
                
                connectSocket();
                return; // Done
              }
            }
          } catch (e) {}
      }

      // B. CREATE NEW CONVERSATION (Only when user sends first message)
      const res = await fetch(`${API_BASE}/conversation`, {
        method: "POST",
        headers: getHeaders(), 
        body: JSON.stringify({
          userId: userId,
          userName: userDetails.name || "Guest User",
          userEmail: userDetails.email || "",
          testMode: settings.testMode
        })
      });

      if (!res.ok) throw new Error("Failed to start conversation");
      const data = await res.json();
      conversationId = data.conversationId;
      
      // C. FETCH THREAD AGAIN (To get any system welcome messages)
      if (!settings.testMode) {
          try {
              const threadRes = await fetch(`${API_BASE}/thread/${userId}?limit=50`, {
                  method: "GET",
                  headers: getHeaders()
              });
              
              setLoading(false); // STOP LOADING

              if (threadRes.ok) {
                  const threadData = await threadRes.json();
                  if (threadData.messages && threadData.messages.length > 0) {
                      threadData.messages.forEach(msg => {
                        appendMessageToUI(
                          msg.text || msg.text_body,
                          msg.sender || (msg.direction === 'inbound' ? 'user' : 'agent'),
                          msg.id || msg.messageId,
                          msg.timestamp || msg.timestamp_meta,
                          msg.status,
                          msg.readAt,
                          msg.readByUs,
                          msg.readByUsAt
                        );
                      });
                      // Mark messages as read after rendering
                      markVisibleMessagesAsRead();
                  } else {
                      // Fallback Welcome
                      const welcomeText = settings.appearance.header?.welcomeMessage || settings.appearance.welcomeMessage;
                      if (welcomeText) appendMessageToUI(welcomeText, 'agent');
                      // Mark messages as read after rendering
                      markVisibleMessagesAsRead();
                  }
              }
          } catch(e) { 
              setLoading(false);
              const welcomeText = settings.appearance.header?.welcomeMessage || settings.appearance.welcomeMessage;
              if (welcomeText) appendMessageToUI(welcomeText, 'agent');
          }
          
          // Mark messages as read after rendering
          markVisibleMessagesAsRead();
          
          connectSocket();
      } else {
          // Test Mode
          setLoading(false);
          const welcomeText = settings.appearance.header?.welcomeMessage || settings.appearance.welcomeMessage;
          if (welcomeText) appendMessageToUI(welcomeText, 'agent');
          // Mark messages as read after rendering
          markVisibleMessagesAsRead();
      }
      
    } catch (error) {
      console.error("UniBox: Init Error", error);
      setLoading(false);
    }
  }

  function connectSocket() {
    if (socket || !conversationId || !window.io) return;

    const options = {
      path: SOCKET_CONFIG.path,
      auth: {
        tenantId: settings.tenantId,
        "x-api-key": settings.apiKey 
      },
      query: {
        "x-api-key": settings.apiKey 
      },
      transports: ['polling', 'websocket'], 
      transportOptions: {
        polling: {
          extraHeaders: {
            "x-api-key": settings.apiKey
          }
        }
      },
      reconnection: true
    };

    socket = window.io(SOCKET_CONFIG.namespaceUrl, options);

    socket.on('connect', () => {
      socket.emit('join', {
        type: 'chat',
        conversationId: conversationId,
        userId: userId,
        isAgent: false
      });
    });

    socket.on('message', (message) => {
      if (message.type === 'read_receipt') {
        // Handle read receipt update
        updateReadReceipt(message);
      } else {
        // Handle new message
        const isUserMessage = message.sender === 'user';
        
        // For user messages, check if we already added it (optimistic UI)
        if (isUserMessage && message.userId === userId) {
          // Find the message by text and timestamp (within 5 seconds)
          const existingMessage = Array.from(messages.values()).find(msg => {
            return msg.sender === 'user' && 
                   msg.text === message.text &&
                   Math.abs(new Date(msg.timestamp) - new Date(message.timestamp)) < 5000;
          });
          
          if (existingMessage && existingMessage.element) {
            // Update existing message with server messageId
            existingMessage.id = message.messageId;
            existingMessage.messageId = message.messageId;
            existingMessage.element.setAttribute('data-message-id', message.messageId);
            messages.delete(existingMessage.id);
            messages.set(message.messageId, existingMessage);
          } else {
            // New message from server
            appendMessageToUI(
              message.text,
              message.sender,
              message.messageId,
              message.timestamp,
              message.status,
              message.readAt,
              message.readByUs,
              message.readByUsAt
            );
          }
        } else if (!isUserMessage) {
          // Agent message - always append
          appendMessageToUI(
            message.text,
            message.sender,
            message.messageId,
            message.timestamp,
            message.status,
            message.readAt,
            message.readByUs,
            message.readByUsAt
          );
          
          // Mark agent messages as read when received
          markMessagesAsRead([message.messageId]);
        }
      }
    });
    
    socket.on('online_status', (data) => {
      updateOnlineStatus(data.isOnline, data.isAgent);
    });
    
    socket.on('agent_online_status', (data) => {
      isAgentOnline = data.isOnline;
      updateOnlineStatusIndicator();
    });
    
    socket.on('connect_error', (err) => {
        console.error("UniBox: Socket Connection Error", err.message);
    });
  }

  async function sendMessageToApi(text) {
    if (!conversationId) {
      await initializeConversation(); 
      if (!conversationId) return;
    }

    // Get user details from pre-chat form if available
    const userDetails = {};
    const hasSubmittedForm = sessionStorage.getItem(SESSION_KEY_FORM) === "true";
    if (hasSubmittedForm) {
      const storedName = sessionStorage.getItem(`${SESSION_KEY_FORM}_name`);
      const storedEmail = sessionStorage.getItem(`${SESSION_KEY_FORM}_email`);
      if (storedName) userDetails.userName = storedName;
      if (storedEmail) userDetails.userEmail = storedEmail;
    }

    try {
      await fetch(`${API_BASE}/message/user`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({
          conversationId: conversationId,
          text: text,
          userId: userId,
          userName: userDetails.userName,
          userEmail: userDetails.userEmail,
          testMode: settings.testMode
        })
      });
    } catch (error) {
      console.error("UniBox: Send Error", error);
      const errDiv = document.createElement("div");
      errDiv.style.textAlign = "center"; errDiv.style.fontSize = "12px"; errDiv.style.color = "red"; errDiv.innerText = "Failed to deliver message";
      document.getElementById("unibox-root").shadowRoot.getElementById("chatBody").appendChild(errDiv);
    }
  }

  function formatTimestamp(timestamp, showReadReceipt = false) {
    if (!timestamp) return '';
    const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
    
    // Format as "00:00 AM/PM" for messages with read receipts
    if (showReadReceipt) {
      let hours = date.getHours();
      const minutes = date.getMinutes().toString().padStart(2, '0');
      const ampm = hours >= 12 ? 'PM' : 'AM';
      hours = hours % 12;
      hours = hours ? hours : 12; // the hour '0' should be '12'
      const hoursStr = hours.toString().padStart(2, '0');
      return `${hoursStr}:${minutes} ${ampm}`;
    }
    
    // For other cases, use relative time
    const now = new Date();
    const diffMs = now - date;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);
    
    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    
    // Format as date
    let hours = date.getHours();
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const ampm = hours >= 12 ? 'PM' : 'AM';
    hours = hours % 12;
    hours = hours ? hours : 12;
    const hoursStr = hours.toString().padStart(2, '0');
    const day = date.getDate();
    const month = date.toLocaleString('default', { month: 'short' });
    return `${day} ${month}, ${hoursStr}:${minutes} ${ampm}`;
  }

  function getReadReceiptIcon(status, readAt, readByUs, readByUsAt, sender) {
    if (sender === 'user') {
      // For user messages, show if agent read them
      if (readByUs && readByUsAt) {
        return '<span class="read-receipt read">✓✓</span>';
      }
      return '<span class="read-receipt sent">✓</span>';
    } else {
      // For agent messages, show if user read them
      if (status === 'read' && readAt) {
        return '<span class="read-receipt read">✓✓</span>';
      } else if (status === 'delivered') {
        return '<span class="read-receipt delivered">✓✓</span>';
      }
      return '<span class="read-receipt sent">✓</span>';
    }
  }

  function appendMessageToUI(text, type, messageId, timestamp, status, readAt, readByUs, readByUsAt) {
    const host = document.getElementById("unibox-root");
    if (!host || !host.shadowRoot) return;
    const body = host.shadowRoot.getElementById("chatBody");
    if (!body) return;

    const msgDiv = document.createElement('div');
    msgDiv.className = type === 'agent' ? 'bot-msg' : 'user-msg';
    msgDiv.setAttribute('data-message-id', messageId || `msg_${Date.now()}`);
    
    const msgContent = document.createElement('div');
    msgContent.className = 'msg-content';
    msgContent.textContent = text;
    msgDiv.appendChild(msgContent);
    
    const msgMeta = document.createElement('div');
    msgMeta.className = 'msg-meta';
    
    // Add read receipt for user messages
    if (type === 'user') {
      const receiptSpan = document.createElement('span');
      receiptSpan.className = 'read-receipt-container';
      receiptSpan.innerHTML = getReadReceiptIcon(status, readAt, readByUs, readByUsAt, 'user');
      msgMeta.appendChild(receiptSpan);
    }
    
    const timeSpan = document.createElement('span');
    timeSpan.className = 'msg-time';
    // Show timestamp in "00:00 AM" format for user messages (with read receipts)
    const showTimeFormat = type === 'user';
    timeSpan.textContent = formatTimestamp(timestamp, showTimeFormat);
    msgMeta.appendChild(timeSpan);
    
    msgDiv.appendChild(msgMeta);
    
    // Store message data
    if (messageId) {
      messages.set(messageId, {
        id: messageId,
        text,
        sender: type,
        timestamp: timestamp || new Date(),
        status: status || 'sent',
        readAt,
        readByUs: readByUs || false,
        readByUsAt,
        element: msgDiv
      });
    }
    
    body.appendChild(msgDiv);
    requestAnimationFrame(() => { body.scrollTop = body.scrollHeight; });
  }

  function updateReadReceipt(receipt) {
    const message = messages.get(receipt.messageId);
    if (!message || !message.element) return;
    
    const meta = message.element.querySelector('.msg-meta');
    if (!meta) return;
    
    // Update message data
    message.status = receipt.status || message.status;
    message.readAt = receipt.readAt || message.readAt;
    message.readByUs = receipt.readByUs !== undefined ? receipt.readByUs : message.readByUs;
    message.readByUsAt = receipt.readByUsAt || message.readByUsAt;
    
    // Update read receipt icon
    const receiptContainer = meta.querySelector('.read-receipt-container');
    if (receiptContainer) {
      receiptContainer.innerHTML = getReadReceiptIcon(
        message.status,
        message.readAt,
        message.readByUs,
        message.readByUsAt,
        message.sender
      );
    }
  }

  async function markMessagesAsRead(messageIds) {
    if (!conversationId || !userId || settings.testMode) return;
    
    try {
      await fetch(`${API_BASE}/messages/read`, {
        method: "POST",
        headers: getHeaders(),
        body: JSON.stringify({
          conversationId: conversationId,
          userId: userId,
          messageIds: messageIds
        })
      });
    } catch (error) {
      console.error("UniBox: Failed to mark messages as read", error);
    }
  }

  function markVisibleMessagesAsRead() {
    if (!conversationId || !userId || settings.testMode) return;
    
    const host = document.getElementById("unibox-root");
    if (!host || !host.shadowRoot) return;
    const body = host.shadowRoot.getElementById("chatBody");
    if (!body) return;
    
    // Get all visible agent messages that haven't been read
    const unreadAgentMessages = Array.from(messages.values())
      .filter(msg => msg.sender === 'agent' && msg.status !== 'read')
      .map(msg => msg.id);
    
    if (unreadAgentMessages.length > 0) {
      markMessagesAsRead(unreadAgentMessages);
    }
  }

  function updateOnlineStatus(isOnline, isAgent) {
    if (isAgent) {
      isAgentOnline = isOnline;
      updateOnlineStatusIndicator();
    }
  }

  function updateOnlineStatusIndicator() {
    const host = document.getElementById("unibox-root");
    if (!host || !host.shadowRoot) return;
    const statusIndicator = host.shadowRoot.getElementById("onlineStatusIndicator");
    if (statusIndicator) {
      statusIndicator.textContent = isAgentOnline ? '● Online' : '○ Offline';
      statusIndicator.className = isAgentOnline ? 'online' : 'offline';
    }
  }


  // --- 9. UI RENDERING ---
  function renderWidget() {
    const host = document.createElement("div");
    host.id = "unibox-root";
    document.body.appendChild(host);
    const shadow = host.attachShadow({ mode: "open" });

    // Styles
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
        /* Colors */
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
      
      /* Launcher */
      .launcher {
        position: fixed; ${verticalLauncherCss} ${horizontalCss}
        width: 60px; height: 60px; 
        background: var(--launcher-bg); 
        color: var(--launcher-color);
        border-radius: ${launcherRadius}; 
        box-shadow: 0 4px 14px rgba(0,0,0,0.15); 
        cursor: pointer; display: flex; align-items: center; justify-content: center; 
        transition: transform 0.2s; overflow: hidden;
      }
      .launcher:hover { transform: scale(1.05); }
      .launcher-img { width: 100%; height: 100%; object-fit: cover; }

      /* Window */
      .chat-window {
        position: fixed; ${verticalWindowCss} ${horizontalCss}
        width: 380px; height: 600px; max-width: 90vw; max-height: 80vh;
        background: var(--bg);
        border-radius: var(--radius);
        box-shadow: 0 8px 30px rgba(0,0,0,0.12); 
        display: flex; flex-direction: column; overflow: hidden;
        opacity: 0; pointer-events: none; transform: ${hiddenTransform} scale(0.95);
        transition: all 0.25s ease; 
        border: 1px solid rgba(0,0,0,0.05);
      }
      .chat-window.open { opacity: 1; pointer-events: auto; transform: translateY(0) scale(1); }

      /* Header */
      .header { 
        background: var(--primary); 
        padding: 16px; color: #fff; 
        display: flex; align-items: center; gap: 12px; flex-shrink: 0; 
      }
      .header-logo { width: 32px; height: 32px; border-radius: 50%; background: #fff; padding: 2px; object-fit: cover; }
      .header-title { font-weight: 600; font-size: 16px; flex: 1; }
      .online-status {
        font-size: 12px; opacity: 0.9; margin-left: 8px;
        display: flex; align-items: center; gap: 4px;
      }
      .online-status.online { color: #4ade80; }
      .online-status.offline { color: #9ca3af; }

      /* Body */
      .body { 
        flex: 1; padding: 20px; overflow-y: auto; 
        background-color: var(--bg);
        position: relative; 
      }

      /* Loader */
      .loader-container {
        display: flex; justify-content: center; align-items: center; height: 100%;
      }
      .loader {
        border: 3px solid #f3f3f3;
        border-top: 3px solid var(--primary);
        border-radius: 50%;
        width: 24px; height: 24px;
        animation: spin 1s linear infinite;
      }
      @keyframes spin {
        0% { transform: rotate(0deg); }
        100% { transform: rotate(360deg); }
      }

      /* Messages */
      .bot-msg, .user-msg {
        max-width: 85%; margin-bottom: 15px; 
        display: flex; flex-direction: column;
      }
      .bot-msg { align-self: flex-start; }
      .user-msg { align-self: flex-end; margin-left: auto; }
      
      .msg-content {
        padding: 12px 16px; border-radius: 12px;
        font-size: 14px; line-height: 1.5; word-break: break-word;
      }
      .bot-msg .msg-content {
        background: var(--secondary); 
        color: #333; 
        border-bottom-left-radius: 2px;
        box-shadow: 0 1px 2px rgba(0,0,0,0.05);
      }
      .user-msg .msg-content {
        background: var(--primary);
        color: #fff; 
        border-bottom-right-radius: 2px;
        box-shadow: 0 1px 2px rgba(0,0,0,0.05);
      }
      
      .msg-meta {
        display: flex; align-items: center; gap: 6px;
        margin-top: 4px; font-size: 11px; opacity: 0.7;
        justify-content: flex-end;
      }
      .user-msg .msg-meta { justify-content: flex-end; }
      .bot-msg .msg-meta { justify-content: flex-start; }
      
      .msg-time {
        color: #666; font-size: 11px;
      }
      .user-msg .msg-time { color: rgba(255,255,255,0.7); }
      
      .read-receipt-container {
        display: inline-flex; align-items: center;
      }
      .read-receipt {
        font-size: 14px; line-height: 1;
      }
      .read-receipt.sent { opacity: 0.5; }
      .read-receipt.delivered { opacity: 0.7; }
      .read-receipt.read { opacity: 1; }
      .user-msg .read-receipt { color: rgba(255,255,255,0.8); }

      /* Form */
      .form-container { display: flex; flex-direction: column; gap: 15px; background: var(--bg); padding: 24px; border-radius: 8px; }
      .form-input { width: 100%; padding: 10px; border: 1px solid #E5E7EB; border-radius: 6px; font-size: 14px; }
      .form-input:focus { outline: none; border-color: var(--primary); }
      .form-btn { width: 100%; padding: 12px; background: var(--primary); color: white; border: none; border-radius: 6px; cursor: pointer; }

      /* Footer */
      .footer { 
        padding: 12px; background: var(--bg); border-top: 1px solid #eee; 
        display: flex; align-items: center; gap: 8px; flex-shrink: 0; 
      }
      .footer.hidden { display: none; }
      .input-wrapper { flex: 1; display: flex; align-items: center; background: #f3f4f6; border-radius: 20px; padding: 8px 12px; }
      .msg-input { flex: 1; border: none; background: transparent; outline: none; font-size: 14px; color: #1f2937; }
      .send-btn { 
        background: var(--primary); color: white; border: none; 
        width: 36px; height: 36px; border-radius: 50%; cursor: pointer; 
        display: flex; align-items: center; justify-content: center; 
      }
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
           <div style="flex: 1;">
             <div class="header-title">${settings.appearance.header?.title || settings.appearance.headerName}</div>
             <div id="onlineStatusIndicator" class="online-status offline">○ Offline</div>
           </div>
           <div id="closeBtn" style="cursor:pointer; font-size:24px; opacity:0.8; line-height: 1;">&times;</div>
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

    // --- 10. VIEW LOGIC ---
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
          
          let capturedName = "";
          let capturedEmail = "";

          settings.preChatForm.fields.forEach(field => {
            const val = data[field.id];
            if(!val) return;
            if (field.type === 'text' && (field.label.toLowerCase().includes('name') || field.id.toLowerCase().includes('name'))) capturedName = val;
            if (field.type === 'email' || field.id.toLowerCase().includes('email')) capturedEmail = val;
          });

          if (!capturedName && capturedEmail) capturedName = capturedEmail;

          // Store user details for when they send first message
          // Don't create conversation/contact until first message is sent
          sessionStorage.setItem(SESSION_KEY_FORM, "true");
          if (capturedName) sessionStorage.setItem(`${SESSION_KEY_FORM}_name`, capturedName);
          if (capturedEmail) sessionStorage.setItem(`${SESSION_KEY_FORM}_email`, capturedEmail);

          currentView = 'chat';
          renderView();
        });

      } else {
        footer.classList.remove('hidden');
        // Initial state is now managed by initializeConversation, not here.
      }
    };

    renderView();

    // --- 11. EVENTS ---
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
        
        const messageId = `msg_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        appendMessageToUI(text, 'user', messageId, new Date(), 'sent', null, false, null);
        msgInput.value = "";

        sendMessageToApi(text);
    };

    sendBtn.addEventListener("click", handleSend);
    msgInput.addEventListener("keypress", (e) => { if(e.key === 'Enter') handleSend(); });
    
    // Mark messages as read when chat window is opened and scrolled
    const chatWindow = shadow.getElementById("chatWindow");
    const chatBody = shadow.getElementById("chatBody");
    if (chatBody) {
      // Mark messages as read when body is scrolled (user is viewing messages)
      let scrollTimeout;
      chatBody.addEventListener('scroll', () => {
        clearTimeout(scrollTimeout);
        scrollTimeout = setTimeout(() => {
          markVisibleMessagesAsRead();
        }, 500);
      });
      
      // Mark messages as read when window is opened
      const observer = new MutationObserver(() => {
        if (chatWindow.classList.contains('open')) {
          markVisibleMessagesAsRead();
        }
      });
      observer.observe(chatWindow, { attributes: true, attributeFilter: ['class'] });
    }

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
