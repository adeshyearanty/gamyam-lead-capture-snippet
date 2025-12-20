(function () {
  window.UniBoxWidget = (function () {
    // Internal State
    let config = {};
    let conversationId = null;
    let userId = null;
    let eventSource = null;
    let isChatOpen = false;

    // --- 1. Initialization ---
    function init(userConfig) {
      config = userConfig;
      
      if (!config.tenantId) {
        console.error("UniBox: Tenant ID is required.");
        return;
      }

      // 1. Load or Generate Guest User ID
      userId = localStorage.getItem('unibox_guest_id');
      if (!userId) {
        userId = `guest_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
        localStorage.setItem('unibox_guest_id', userId);
      }

      // 2. Render UI
      injectStyles();
      createWidgetUI();

      // 3. Check for existing active conversation
      initializeConversation();
    }

    // --- 2. API Interactions ---
    
    async function initializeConversation() {
      try {
        // Endpoint: POST /messages/v1/chat/conversation
        const res = await fetch(`${config.apiBaseUrl}/conversation`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-tenant-id": config.tenantId
          },
          body: JSON.stringify({
            userId: userId,
            userName: "Guest User", // You could allow passing this in init()
            userEmail: ""           // Optional
          })
        });

        if (!res.ok) throw new Error("Failed to init conversation");

        const data = await res.json();
        conversationId = data.conversationId;
        
        console.log("UniBox: Conversation Active", conversationId);
        
        // Start Listening for Agent Replies
        connectSSE();

      } catch (err) {
        console.error("UniBox: API Error", err);
      }
    }

    function connectSSE() {
      if (eventSource) return; // Already connected

      // Endpoint: GET /messages/v1/chat/stream/:conversationId
      // NOTE: EventSource does not support headers. We pass tenantId as query param.
      // Ensure your NestJS backend checks Query Params if Header is missing for SSE.
      const sseUrl = `${config.apiBaseUrl}/stream/${conversationId}?x-tenant-id=${config.tenantId}`;
      
      eventSource = new EventSource(sseUrl);

      eventSource.onmessage = (event) => {
        const msg = JSON.parse(event.data);
        // Only display if it comes from the agent (User messages are optimistic)
        if (msg.sender === 'agent') {
          appendMessage(msg.text, 'agent');
        }
      };

      eventSource.onerror = (err) => {
        console.warn("UniBox: SSE Disconnected. Reconnecting in 5s...", err);
        eventSource.close();
        eventSource = null;
        setTimeout(connectSSE, 5000);
      };
    }

    async function sendMessage() {
      const input = document.getElementById("unibox-input");
      const text = input.value.trim();
      if (!text) return;

      // 1. Optimistic UI Update (Show immediately)
      appendMessage(text, 'user');
      input.value = "";

      try {
        // Endpoint: POST /messages/v1/chat/message/user
        await fetch(`${config.apiBaseUrl}/message/user`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-tenant-id": config.tenantId
          },
          body: JSON.stringify({
            conversationId: conversationId,
            text: text,
            userId: userId
          })
        });
      } catch (err) {
        console.error("UniBox: Send Failed", err);
        appendMessage("Failed to send message. Please retry.", 'system');
      }
    }

    // --- 3. UI Logic (Vanilla JS) ---

    function toggleChat() {
      isChatOpen = !isChatOpen;
      const windowEl = document.getElementById("unibox-window");
      const launcherEl = document.getElementById("unibox-launcher");
      
      if (isChatOpen) {
        windowEl.style.display = "flex";
        setTimeout(() => windowEl.style.opacity = "1", 10); // Fade in
        launcherEl.innerHTML = "&times;"; // Change icon to X
        scrollToBottom();
      } else {
        windowEl.style.opacity = "0";
        setTimeout(() => windowEl.style.display = "none", 200); // Fade out
        launcherEl.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" fill="white"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>`;
      }
    }

    function appendMessage(text, sender) {
      const body = document.getElementById("unibox-body");
      const msgDiv = document.createElement("div");
      
      msgDiv.className = `unibox-msg ${sender}`;
      msgDiv.textContent = text;
      
      body.appendChild(msgDiv);
      scrollToBottom();
    }

    function scrollToBottom() {
      const body = document.getElementById("unibox-body");
      body.scrollTop = body.scrollHeight;
    }

    function createWidgetUI() {
      // Container
      const container = document.createElement("div");
      container.id = "unibox-root";
      
      // Chat Window
      const chatWindow = document.createElement("div");
      chatWindow.id = "unibox-window";
      chatWindow.innerHTML = `
        <div class="unibox-header">Support Chat</div>
        <div class="unibox-body" id="unibox-body">
          <div class="unibox-msg system">Welcome! How can we help?</div>
        </div>
        <div class="unibox-footer">
          <input type="text" id="unibox-input" placeholder="Type a message..." />
          <button id="unibox-send">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="white"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
          </button>
        </div>
      `;

      // Launcher Button
      const launcher = document.createElement("div");
      launcher.id = "unibox-launcher";
      launcher.innerHTML = `<svg viewBox="0 0 24 24" width="24" height="24" fill="white"><path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>`;
      
      container.appendChild(chatWindow);
      container.appendChild(launcher);
      document.body.appendChild(container);

      // Event Listeners
      launcher.addEventListener("click", toggleChat);
      
      const sendBtn = document.getElementById("unibox-send");
      const inputEl = document.getElementById("unibox-input");

      sendBtn.addEventListener("click", sendMessage);
      inputEl.addEventListener("keypress", (e) => {
        if (e.key === "Enter") sendMessage();
      });
    }

    function injectStyles() {
      const color = config.primaryColor || "#007BFF";
      const style = document.createElement("style");
      style.textContent = `
        #unibox-root { position: fixed; bottom: 20px; right: 20px; z-index: 9999; font-family: sans-serif; }
        
        /* Launcher */
        #unibox-launcher {
          width: 60px; height: 60px; background: ${color}; border-radius: 50%;
          box-shadow: 0 4px 12px rgba(0,0,0,0.15); cursor: pointer;
          display: flex; align-items: center; justify-content: center;
          transition: transform 0.2s;
          color: white; font-size: 24px;
        }
        #unibox-launcher:hover { transform: scale(1.05); }

        /* Window */
        #unibox-window {
          position: absolute; bottom: 80px; right: 0;
          width: 350px; height: 500px; background: white;
          border-radius: 12px; box-shadow: 0 5px 20px rgba(0,0,0,0.2);
          display: none; flex-direction: column; opacity: 0; transition: opacity 0.2s;
          overflow: hidden;
        }

        /* Header */
        .unibox-header { background: ${color}; color: white; padding: 16px; font-weight: bold; }

        /* Body */
        .unibox-body { flex: 1; padding: 15px; overflow-y: auto; background: #f9f9f9; display: flex; flex-direction: column; gap: 10px; }
        
        /* Messages */
        .unibox-msg { max-width: 80%; padding: 10px 14px; border-radius: 12px; font-size: 14px; line-height: 1.4; word-wrap: break-word; }
        .unibox-msg.user { align-self: flex-end; background: ${color}; color: white; border-bottom-right-radius: 2px; }
        .unibox-msg.agent { align-self: flex-start; background: #E5E7EB; color: black; border-bottom-left-radius: 2px; }
        .unibox-msg.system { align-self: center; background: transparent; color: #888; font-size: 12px; text-align: center; }

        /* Footer */
        .unibox-footer { padding: 10px; border-top: 1px solid #eee; display: flex; gap: 10px; background: white; }
        #unibox-input { flex: 1; border: 1px solid #ddd; border-radius: 20px; padding: 10px 15px; outline: none; }
        #unibox-send { background: ${color}; border: none; width: 40px; height: 40px; border-radius: 50%; cursor: pointer; display: flex; align-items: center; justify-content: center; }
        #unibox-send:hover { opacity: 0.9; }
      `;
      document.head.appendChild(style);
    }

    return { init };
  })();
})();
