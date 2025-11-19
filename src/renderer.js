/*********************************************************************
 * renderer.js — НОВАЯ ПОЛНАЯ ВЕРСИЯ (обновлённая: Telegram login button)
 *********************************************************************/

/////////////////////////////////////////////////////////////////
// UI ELEMENTS
/////////////////////////////////////////////////////////////////

const $loginScreen = document.getElementById("login-screen");
const $app = document.getElementById("app");
const $username = document.getElementById("username");
const $loginBtn = document.getElementById("login-btn");
const $telegramBtn = document.getElementById("telegram-btn"); // кнопка должна быть добавлена в index.html

const $userList = document.getElementById("userList");
const $chatList = document.getElementById("chatList");
const $messages = document.getElementById("messages");
const $chatTitle = document.getElementById("chatTitle");

const $composer = document.getElementById("composer");
const $messageInput = document.getElementById("messageInput");
const $fileInput = document.getElementById("fileInput");

const $status = document.getElementById("status");
const $changeNameBtn = document.getElementById("changeNameBtn");

const $viewer = document.getElementById("viewer");
const $viewerImg = document.getElementById("viewer-img");
const $viewerClose = document.getElementById("viewer-close");
const $viewerDownload = document.getElementById("viewer-download");

/////////////////////////////////////////////////////////////////
// STATE
/////////////////////////////////////////////////////////////////

const state = {
    you: null,
    users: [],
    chats: {},
    activeChat: null
};

/////////////////////////////////////////////////////////////////
// HELPERS
/////////////////////////////////////////////////////////////////

function escapeHtml(s) {
    return (s || '').replace(/[&<>"']/g, c => ({
        '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":"&#39;"
    }[c]));
}

function addChat(name) {
    if (!state.chats[name]) {
        state.chats[name] = {
            name,
            messages: [],
            loaded: false,
            unread: 0
        };
    }
}

function scrollDown() {
    setTimeout(() => {
        $messages.scrollTop = $messages.scrollHeight;
    }, 40);
}

/////////////////////////////////////////////////////////////////
// RENDER USERS
/////////////////////////////////////////////////////////////////

function renderUsers() {
    $userList.innerHTML = "";

    for (const u of state.users) {
        if (u === state.you) continue;

        const li = document.createElement("li");
        li.dataset.name = u;
        li.innerHTML = `
            <div class="avatar">${u[0].toUpperCase()}</div>
            <div class="chat-meta"><div class="name">${escapeHtml(u)}</div></div>
        `;
        li.onclick = () => {
            addChat(u);
            openChat(u);
        };

        $userList.appendChild(li);
    }
}

/////////////////////////////////////////////////////////////////
// RENDER CHAT LIST
/////////////////////////////////////////////////////////////////

function renderChatList() {
    $chatList.innerHTML = "";

    let keys = Object.keys(state.chats).sort((a, b) => {
        const A = state.chats[a].messages;
        const B = state.chats[b].messages;
        const ta = A.length ? A[A.length - 1].ts : 0;
        const tb = B.length ? B[B.length - 1].ts : 0;
        return tb - ta;
    });

    for (const k of keys) {
        const c = state.chats[k];

        const li = document.createElement("li");
        li.dataset.name = k;
        li.innerHTML = `
            <div class="avatar">${k[0].toUpperCase()}</div>
            <div class="chat-meta"><div class="name">${escapeHtml(k)}</div></div>
            ${c.unread ? `<div class="unread">${c.unread}</div>` : ""}
        `;

        li.onclick = () => {
            openChat(k);
            c.unread = 0;
            renderChatList();
        };

        $chatList.appendChild(li);
    }
}

/////////////////////////////////////////////////////////////////
// OPEN CHAT
/////////////////////////////////////////////////////////////////

function openChat(name) {
    state.activeChat = name;
    addChat(name);

    $chatTitle.textContent = (name === "Global") ? "Глобальный чат" : name;

    // Загрузка истории из SQLite (только 1 раз)
    if (!state.chats[name].loaded) {
        window.api.send("toMain", {
            type: "getHistory",
            with: name,
            limit: 500
        });
    }

    renderMessages();
}

/////////////////////////////////////////////////////////////////
// RENDER MESSAGES
/////////////////////////////////////////////////////////////////

function renderMessages() {
    const chat = state.chats[state.activeChat];
    if (!chat) return;

    $messages.innerHTML = "";

    for (const m of chat.messages) {

        const el = document.createElement("div");
        el.className = "msg " + (m.from === state.you ? "you" : "other");

        // FILE OR IMAGE
        if (m.file) {

            const box = document.createElement("div");

            // IMAGE
            if (m.filetype.startsWith("image/")) {
                const img = document.createElement("img");
                img.src = `data:${m.filetype};base64,${m.data}`;
                img.className = "file-preview";
                img.onclick = () => openViewer(m);
                box.appendChild(img);

            // ANY OTHER FILE
            } else {
                const link = document.createElement("a");
                link.href = `data:${m.filetype};base64,${m.data}`;
                link.download = m.filename;
                link.innerText = "📄 " + m.filename;
                box.appendChild(link);
            }

            const time = document.createElement("div");
            time.className = "msg-time";
            time.innerText = new Date(m.ts).toLocaleTimeString();
            box.appendChild(time);

            el.appendChild(box);

        } else {
            // TEXT
            el.innerHTML = `
                <div class="text">${escapeHtml(m.text)}</div>
                <div class="msg-time">${new Date(m.ts).toLocaleTimeString()}</div>
            `;
        }

        $messages.appendChild(el);
    }

    scrollDown();
}

/////////////////////////////////////////////////////////////////
/// IMAGE VIEWER
/////////////////////////////////////////////////////////////////

function openViewer(m) {
    $viewerImg.src = `data:${m.filetype};base64,${m.data}`;
    $viewerDownload.href = $viewerImg.src;
    $viewerDownload.download = m.filename;
    $viewer.classList.remove("hidden");
}

$viewerClose.onclick = () => {
    $viewer.classList.add("hidden");
    $viewerImg.src = "";
};

/////////////////////////////////////////////////////////////////
// SEND TEXT MESSAGE
/////////////////////////////////////////////////////////////////

$composer.onsubmit = e => {
    e.preventDefault();

    let txt = $messageInput.value.trim();
    if (!txt) return;

    const to = state.activeChat === "Global" ? null : state.activeChat;

    window.api.send("toMain", {
        type: "message",
        text: txt,
        to
    });

    $messageInput.value = "";
};

/////////////////////////////////////////////////////////////////
// FILE + SENDING
/////////////////////////////////////////////////////////////////

$fileInput.onchange = async () => {
    const file = $fileInput.files[0];
    if (!file) return;

    let base64 = await fileToBase64(file);

    const to = state.activeChat === "Global" ? null : state.activeChat;

    window.api.send("toMain", {
        type: "file",
        filename: file.name,
        filetype: file.type,
        data: base64,
        to
    });

    $fileInput.value = "";
};

function fileToBase64(file) {
    return new Promise(res => {
        const r = new FileReader();
        r.onload = () => res(r.result.split(",")[1]);
        r.readAsDataURL(file);
    });
}

/////////////////////////////////////////////////////////////////
// LOGIN + TELEGRAM BUTTON
/////////////////////////////////////////////////////////////////

$loginBtn.onclick = () => {
    const name = $username.value.trim();
    if (!name) return alert("Введите имя");

    state.you = name;

    $loginScreen.style.display = "none";
    $app.style.display = "flex";

    window.api.send("toMain", { type: "register", name });
    window.api.send("toMain", { type: "requestUsers" });

    addChat("Global");
    openChat("Global");
};

// Telegram login button (optional element in index.html)
if (typeof $telegramBtn !== 'undefined' && $telegramBtn) {
    $telegramBtn.onclick = () => {
        window.api.send('toMain', { type: 'openTelegramAuth' });
    };
}

/////////////////////////////////////////////////////////////////
// RECEIVE FROM MAIN
/////////////////////////////////////////////////////////////////

window.api.on("fromMain", data => {
    if (!data) return;

    // handle telegram auth messages (sent directly by main)
    if (data.type === 'telegram-auth') {
        if (data.status === 'ok') {
            const username = data.username;
            state.you = username;
            $loginScreen.style.display = 'none';
            $app.style.display = 'flex';
            $changeNameBtn.textContent = username;
            window.api.send('toMain', { type: 'requestUsers' });
            addChat('Global');
            openChat('Global');
        } else {
            alert('Telegram вход не прошёл верификацию');
        }
        return;
    }

    if (data.type === "ws-status") {
        $status.textContent = data.status;
        return;
    }

    if (data.type !== "ws-message") return;

    const msg = data.payload;

    if (msg.type === "history") {
        addChat(msg.with);

        state.chats[msg.with].messages = msg.messages.map(x => {
            if (x.filename) {
                return {
                    from: x.from,
                    ts: x.ts,
                    file: true,
                    filename: x.filename,
                    filetype: x.filetype,
                    data: x.data
                };
            } else {
                return {
                    from: x.from,
                    ts: x.ts,
                    text: x.text
                };
            }
        });

        state.chats[msg.with].loaded = true;

        if (state.activeChat === msg.with) {
            renderMessages();
        }

        return;
    }

    if (msg.type === "users") {
        state.users = msg.users;
        renderUsers();
        return;
    }

    if (msg.type === "registered") {
        state.you = msg.yourName;
        state.users = msg.users || [];
        renderUsers();
        return;
    }

    if (msg.type === "presence") {
        if (msg.event === "join") {
            if (!state.users.includes(msg.name)) state.users.push(msg.name);
        } else {
            state.users = state.users.filter(x => x !== msg.name);
        }
        renderUsers();
        return;
    }

    if (msg.type === "message") {
        const chatName =
            (!msg.to || msg.to === "Global")
            ? "Global"
            : (msg.to === state.you ? msg.from : msg.to);

        addChat(chatName);

        state.chats[chatName].messages.push({
            from: msg.from,
            ts: msg.ts,
            text: msg.text
        });

        if (state.activeChat !== chatName) {
            state.chats[chatName].unread++;
            new Notification("Новое сообщение", { body: msg.text });
        }

        if (state.activeChat === chatName) renderMessages();
        renderChatList();

        return;
    }

    if (msg.type === "file") {
        const chatName =
            (!msg.to || msg.to === "Global")
            ? "Global"
            : (msg.to === state.you ? msg.from : msg.to);

        addChat(chatName);

        state.chats[chatName].messages.push({
            from: msg.from,
            ts: msg.ts,
            file: true,
            filename: msg.filename,
            filetype: msg.filetype,
            data: msg.data
        });

        if (state.activeChat !== chatName) {
            state.chats[chatName].unread++;
            new Notification("Файл", { body: msg.filename });
        }

        if (state.activeChat === chatName) renderMessages();
        renderChatList();
        return;
    }

});
