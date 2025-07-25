// client/Client.js (Upgraded/Combined)
const { withRealtime, withFbns, withFbnsAndRealtime } = require('instagram_mqtt');
const { GraphQLSubscriptions, SkywalkerSubscriptions } = require('instagram_mqtt'); // Ensure this import is present
const { IgApiClient } = require('instagram-private-api');
const { EventEmitter } = require('events');
const Collection = require('@discordjs/collection');
const fs = require('fs').promises; // Use fs.promises for async/await
const tough = require('tough-cookie'); // For cookie handling
const Util = require('./Util');
const ClientUser = require('./ClientUser');
const Message = require('./Message');
const Chat = require('./Chat');
const User = require('./User');

/**
 * Client, the main hub for interacting with the Instagram API, combining features from insta.js and a custom bot.
 * @extends {EventEmitter}
 */
class Client extends EventEmitter {
    /**
     * @typedef {object} ClientOptions
     * @property {boolean} [disableReplyPrefix=false] Whether the bot should disable user mention for the Message#reply() method
     * @property {string} [sessionFilePath='./session.json'] Path to save/load session state.
     * @property {string} [cookiesFilePath='./cookies.json'] Path to load cookies from.
     * @property {object} [proxy] Proxy configuration { type, host, port, username, password }
     * @property {number} [maxProcessedMessageIds=1000] Maximum number of message IDs to keep for deduplication.
     */
    /**
     * @param {ClientOptions} options
     */
    constructor(options = {}) {
        super();

        /**
         * @type {?ClientUser}
         * The bot's user object.
         */
        this.user = null;

        /**
         * @type {?IgApiClient}
         * @private
         */
        this.ig = null;

        /**
         * @type {boolean}
         * Whether the bot is connected and ready.
         */
        this.ready = false;

        /**
         * @type {ClientOptions}
         * The options for the client.
         */
        this.options = {
            disableReplyPrefix: false,
            sessionFilePath: './session.json',
            cookiesFilePath: './cookies.json',
            proxy: null,
            maxProcessedMessageIds: 1000,
            ...options
        };

        /**
         * @typedef {Object} Cache
         * @property {Collection<string, Message>} messages The bot's messages cache.
         * @property {Collection<string, User>} users The bot's users cache.
         * @property {Collection<string, Chat>} chats The bot's chats cache.
         * @property {Collection<string, Chat>} pendingChats The bot's pending chats cache.
         */
        /**
         * @type {Cache}
         * The bot's cache.
         */
        this.cache = {
            messages: new Collection(),
            users: new Collection(),
            chats: new Collection(),
            pendingChats: new Collection()
        };

        /**
         * @type {Set<string>}
         * @private
         * Keeps track of processed message IDs for deduplication.
         */
        this.processedMessageIds = new Set();

        /**
         * @type {NodeJS.Timeout|null}
         * @private
         * Interval for monitoring message requests.
         */
        this.messageRequestsMonitorInterval = null;

        /**
         * @type {...any[]}
         * @private
         * Stores events received before the client is fully ready.
         */
        this.eventsToReplay = [];
    }

    // --- Logging (from InstagramBot) ---
    /**
     * Log a message
     * @param {string} level Log level (e.g., 'INFO', 'ERROR', 'DEBUG')
     * @param {string} message The log message
     * @param {...any} args Additional arguments to log
     * @private
     */
    log(level, message, ...args) {
        const timestamp = new Date().toISOString();
        console.log(`[${timestamp}] [${level}] ${message}`, ...args);
    }

    // --- State & Login (from InstagramBot) ---
    /**
     * Load cookies from a JSON file.
     * @param {string} path Path to the cookies JSON file.
     * @returns {Promise<void>}
     * @private
     */
    async loadCookiesFromJson(path) {
        try {
            const raw = await fs.readFile(path, 'utf-8');
            const cookies = JSON.parse(raw);
            let cookiesLoaded = 0;
            for (const cookie of cookies) {
                // Ensure domain doesn't start with a dot for tough-cookie
                const toughCookie = new tough.Cookie({
                    key: cookie.name,
                    value: cookie.value,
                    domain: cookie.domain ? cookie.domain.replace(/^\./, '') : undefined, // Handle potential missing domain
                    path: cookie.path || '/',
                    secure: cookie.secure !== false,
                    httpOnly: cookie.httpOnly !== false,
                    // Add expires if available in your cookie format
                    // expires: cookie.expires ? new Date(cookie.expires) : undefined
                });
                if (toughCookie.domain) { // Only set cookie if domain is present
                     await this.ig.state.cookieJar.setCookie(
                         toughCookie.toString(),
                         `https://${toughCookie.domain}${toughCookie.path}`
                     );
                     cookiesLoaded++;
                } else {
                     this.log('WARN', `Skipping cookie due to missing domain: ${cookie.name}`);
                }
            }
            this.log('INFO', `🍪 Successfully loaded ${cookiesLoaded}/${cookies.length} cookies from file`);
        } catch (error) {
            this.log('ERROR', `❌ Critical error loading cookies from ${path}:`, error.message);
            throw error;
        }
    }

    /**
     * Attempt to login using saved session or cookies.
     * @returns {Promise<boolean>} True if login was successful, false otherwise.
     * @private
     */
    async attemptLogin() {
        let loginSuccess = false;
        const username = process.env.IG_USERNAME || 'default_username'; // Fallback or use config

        this.ig = withFbnsAndRealtime(new IgApiClient());
        this.ig.state.generateDevice(username);

        // Step 1: Try session.json first
        try {
            await fs.access(this.options.sessionFilePath);
            this.log('INFO', `📂 Found ${this.options.sessionFilePath}, trying to login from session...`);
            const sessionData = JSON.parse(await fs.readFile(this.options.sessionFilePath, 'utf-8'));
            await this.ig.state.deserialize(sessionData);
            await this.ig.account.currentUser(); // Validate session
            this.log('INFO', '✅ Logged in from session file');
            loginSuccess = true;
        } catch (sessionError) {
            this.log('INFO', `📂 ${this.options.sessionFilePath} not found or invalid, trying cookies...`, sessionError.message);
        }

        // Step 2: Fallback to cookies.json ONLY if session login wasn't successful
        if (!loginSuccess) {
            try {
                this.log('INFO', `📂 Attempting login using ${this.options.cookiesFilePath}...`);
                await this.loadCookiesFromJson(this.options.cookiesFilePath);
                const currentUserResponse = await this.ig.account.currentUser(); // Validate cookies
                this.log('INFO', `✅ Logged in using ${this.options.cookiesFilePath} as @${currentUserResponse.username}`);
                loginSuccess = true;

                // Step 3: Save session after successful cookie login
                const session = await this.ig.state.serialize();
                // Remove constants before saving, similar to InstagramBot
                delete session.constants;
                await fs.writeFile(this.options.sessionFilePath, JSON.stringify(session, null, 2));
                this.log('INFO', `💾 ${this.options.sessionFilePath} saved from cookie-based login`);
            } catch (cookieError) {
                this.log('ERROR', `❌ Failed to load or process ${this.options.cookiesFilePath}:`, cookieError.message);
                this.log('DEBUG', 'Cookie loading error stack:', cookieError.stack);
            }
        }
        return loginSuccess;
    }

    // --- Connection & Event Handling (from InstagramBot, integrated with insta.js parsing) ---
    /**
     * Register Realtime event handlers.
     * @private
     */
    registerRealtimeHandlers() {
        this.log('INFO', '📡 Registering real-time event handlers...');

        // --- Core Message Handling (Adapted from InstagramBot) ---
        const handleMessageWrapper = async (data) => {
            try {
                if (!data.message) {
                    this.log('WARN', '⚠️ No message payload in event data');
                    return;
                }
                if (!this.isNewMessageById(data.message.item_id)) {
                    this.log('DEBUG', `⚠️ Message ${data.message.item_id} filtered as duplicate (by ID)`);
                    return;
                }
                this.log('INFO', '✅ Processing new message (by ID)...');
                // This will now call the insta.js style message processing
                await this.processMessage(data.message, data);
            } catch (err) {
                this.log('ERROR', '❌ Critical error in message handler:', err.message);
            }
        };

        this.ig.realtime.on('message', handleMessageWrapper);
        this.ig.realtime.on('direct', handleMessageWrapper); // Handle 'direct' events too

        // --- insta.js Style Parsing (Adapted from original Client.handleRealtimeReceive) ---
        this.ig.realtime.on('receive', (topic, payload) => {
             // Buffer events if not ready (insta.js feature)
             if (!this.ready) {
                 this.eventsToReplay.push(['realtime', topic, payload]);
                 return;
             }
             this.emit('rawRealtime', topic, payload);

             // Forward to original parsing logic for topic 146 (inbox updates)
             if (topic.id === '146') {
                 // This logic is complex and was in the original Client.js
                 // We'll simplify and integrate key parts here or call a dedicated method
                 // For now, placeholder:
                 this.parseInboxUpdates(payload);
             }
             // TODO: Add parsing for other topics (e.g., live comments)
        });

        // --- Additional Event Listeners (From InstagramBot) ---
        this.ig.realtime.on('error', (err) => {
            this.log('ERROR', '🚨 Realtime connection error:', err.message || err);
            this.emit('error', err); // Propagate error event
        });
        this.ig.realtime.on('close', () => {
            this.log('WARN', '🔌 Realtime connection closed');
            this.ready = false;
            this.emit('disconnected');
        });
        this.ig.realtime.on('threadUpdate', (data) => {
            this.log('INFO', '🧵 Thread update event received');
            // TODO: Parse and emit insta.js style events (chatUserAdd, etc.)
            this.emit('threadUpdateRaw', data);
        });
        this.ig.realtime.on('presence', (data) => {
            this.log('INFO', '👤 Presence update event received');
            this.emit('presenceUpdate', data); // New event
        });
        this.ig.realtime.on('typing', (data) => {
            this.log('INFO', '⌨️ Typing indicator event received');
            this.emit('typingStart', data); // New event
        });
        this.ig.realtime.on('messageStatus', (data) => {
            this.log('INFO', '📊 Message status update event received');
            this.emit('messageStatusUpdate', data); // New event
        });
        this.ig.realtime.on('liveNotification', (data) => {
            this.log('INFO', '📺 Live stream notification event received');
            this.emit('liveNotification', data); // New event
        });
        this.ig.realtime.on('activity', (data) => {
            this.log('INFO', '⚡ Activity notification event received');
            this.emit('activity', data); // New event
        });
        this.ig.realtime.on('connect', () => {
            this.log('INFO', '🔗 Realtime connection successfully established');
            // Don't set this.ready = true here, it's set after full login/connect sequence
            this.emit('realtimeConnected');
        });
        this.ig.realtime.on('reconnect', () => {
            this.log('INFO', '🔁 Realtime client is attempting to reconnect');
            this.emit('realtimeReconnecting');
        });
        this.ig.realtime.on('debug', (data) => {
            this.log('TRACE', '🐛 Realtime debug info:', data);
        });

        // --- FBNS Handling (from original insta.js Client) ---
        this.ig.fbns.push$.subscribe((data) => {
             if (!this.ready) {
                 this.eventsToReplay.push(['fbns', data]);
                 return;
             }
             this.emit('rawFbns', data);
             // Forward to original parsing logic
             this.handleFbnsReceive(data);
        });
        this.ig.fbns.on('error', (err) => {
            this.log('ERROR', '🚨 FBNS connection error:', err.message || err);
            this.emit('error', err); // Propagate error event
        });
        this.ig.fbns.on('warning', (warn) => {
            this.log('WARN', '⚠️ FBNS warning:', warn);
        });
    }

    /**
     * Parse inbox updates (simplified placeholder for topic 146 logic).
     * @param {string} payload The JSON payload string.
     * @private
     */
    parseInboxUpdates(payload) {
        // This is where the complex logic from the original `handleRealtimeReceive`
        // for topic '146' would go. It parses JSON paths like `/direct_v2/inbox/threads/...`
        // and updates `this.cache.chats`, `this.cache.messages`, and emits events like
        // `messageCreate`, `chatNameUpdate`, etc.
        // For brevity, we'll assume it exists or is implemented fully later.
        this.log('DEBUG', 'Parsing inbox updates (placeholder logic)');
        // ... (Implementation from original Client.handleRealtimeReceive for topic 146)
        // You can copy/paste the logic from your original handleRealtimeReceive here for topic '146'
        // Or refactor it into this method.
    }

    /**
     * Handle FBNS messages (from original insta.js Client).
     * @param {object} data The FBNS data.
     * @private
     */
    async handleFbnsReceive(data) {
         // This logic is mostly from the original insta.js Client
         if (data.pushCategory === 'new_follower') {
             const user = await this.fetchUser(data.sourceUserId);
             this.emit('newFollower', user);
         }
         if (data.pushCategory === 'private_user_follow_request') {
             const user = await this.fetchUser(data.sourceUserId);
             this.emit('followRequest', user);
         }
         if (data.pushCategory === 'direct_v2_pending') {
             // Logic to fetch and emit pending requests
             // ... (Implementation from original Client.handleFbnsReceive)
             this.log('INFO', '📩 Pending message request notification received (FBNS)');
             this.emit('pendingRequestNotification', data); // New event for notification
         }
    }

    /**
     * Improved deduplication using message ID (from InstagramBot).
     * @param {string} messageId The ID of the message.
     * @returns {boolean} True if the message is new, false if it's a duplicate.
     * @private
     */
    isNewMessageById(messageId) {
        if (!messageId) {
            this.log('WARN', '⚠️ Attempted to check message ID, but ID was missing.');
            return true;
        }
        if (this.processedMessageIds.has(messageId)) {
            return false;
        }
        this.processedMessageIds.add(messageId);
        if (this.processedMessageIds.size > this.options.maxProcessedMessageIds) {
            const first = this.processedMessageIds.values().next().value;
            if (first !== undefined) {
                this.processedMessageIds.delete(first);
            }
        }
        return true;
    }

    /**
     * Process a raw message payload into an insta.js Message object and emit events.
     * This bridges the gap between raw data and the insta.js object model.
     * @param {object} messagePayload The raw message data from Instagram.
     * @param {object} eventData Additional event data (e.g., thread info).
     * @private
     */
    async processMessage(messagePayload, eventData) {
         try {
              // Validate essential message structure early
              if (!messagePayload || !messagePayload.user_id || !messagePayload.item_id) {
                  this.log('WARN', '⚠️ Received message with missing essential fields');
                  return;
              }

              const threadId = eventData.thread?.thread_id || messagePayload.thread_id;
              if (!threadId) {
                  this.log('WARN', '⚠️ Could not determine thread ID for message');
                  return;
              }

              // Ensure thread exists in cache (fetch if needed)
              let chat = this.cache.chats.get(threadId);
              if (!chat) {
                   // Try to fetch or create a basic chat object
                   try {
                        // This might involve calling ig.feed.directThread or similar
                        // For simplicity, let's assume fetchChat handles it or creates a minimal one
                        chat = await this.fetchChat(threadId);
                        // If fetchChat fails, create a minimal one for now
                        if (!chat) {
                             chat = new Chat(this, threadId, { thread_id: threadId }); // Minimal data
                             this.cache.chats.set(threadId, chat);
                        }
                   } catch (fetchErr) {
                        this.log('WARN', `⚠️ Error fetching/creating chat ${threadId} for message:`, fetchErr.message);
                        // Still create a minimal chat object to hold the message
                        chat = new Chat(this, threadId, { thread_id: threadId });
                        this.cache.chats.set(threadId, chat);
                   }
              }

              // Create or update the Message object in the cache
              let message;
              if (chat.messages.has(messagePayload.item_id)) {
                   message = chat.messages.get(messagePayload.item_id);
                   message._patch(messagePayload); // Update existing
              } else {
                   message = new Message(this, threadId, messagePayload);
                   chat.messages.set(message.id, message);
                   // Add to global message cache if needed
                   this.cache.messages.set(message.id, message);
              }

              // Emit the insta.js style event
              if (Util.isMessageValid(message)) {
                  this.emit('messageCreate', message);
              }

         } catch (error) {
              this.log('ERROR', '❌ Error processing message into insta.js object:', error.message);
         }
    }

    // --- Public API Methods (from insta.js, enhanced where needed) ---

    /**
     * Log the bot in to Instagram.
     * @returns {Promise<void>}
     */
    async login() {
        const loginSuccess = await this.attemptLogin();
        if (!loginSuccess) {
             throw new Error('❌ No valid login method succeeded (session or cookies).');
        }

        // Fetch user info for the client user
        try {
            const response = await this.ig.user.usernameinfo(process.env.IG_USERNAME || 'default'); // Use env or config
            const userData = await this.ig.user.info(response.pk);
            this.user = new ClientUser(this, {
                ...response,
                ...userData
            });
            this.cache.users.set(this.user.id, this.user);
            this.emit('debug', 'logged', this.user);
        } catch (userError) {
            this.log('ERROR', '❌ Failed to fetch client user info:', userError.message);
            throw userError;
        }

        // Pre-populate chat cache (insta.js feature)
        try {
            const threads = [
                ...await this.ig.feed.directInbox().items(),
                ...await this.ig.feed.directPending().items()
            ];
            threads.forEach((thread) => {
                const chat = new Chat(this, thread.thread_id, thread);
                this.cache.chats.set(thread.thread_id, chat);
                if (chat.pending) {
                    this.cache.pendingChats.set(thread.thread_id, chat);
                }
            });
        } catch (cacheError) {
            this.log('WARN', '⚠️ Error pre-populating chat cache:', cacheError.message);
        }

        // Register handlers
        this.registerRealtimeHandlers();

        // Connect services with enhanced options
        const socksOptions = this.options.proxy ? {
             type: this.options.proxy.type || 5,
             host: this.options.proxy.host,
             port: this.options.proxy.port,
             userId: this.options.proxy.username,
             password: this.options.proxy.password,
        } : undefined;

        const connectOptions = {
            autoReconnect: true,
            irisData: await this.ig.feed.directInbox().request(),
            graphQlSubs: [
                 GraphQLSubscriptions.getAppPresenceSubscription(),
                 GraphQLSubscriptions.getZeroProvisionSubscription(this.ig.state.phoneId),
                 GraphQLSubscriptions.getDirectStatusSubscription(),
                 GraphQLSubscriptions.getDirectTypingSubscription(this.ig.state.cookieUserId),
                 GraphQLSubscriptions.getAsyncAdSubscription(this.ig.state.cookieUserId),
                 // Add more subscriptions as needed
            ],
            skywalkerSubs: [
                 SkywalkerSubscriptions.directSub(this.ig.state.cookieUserId),
                 SkywalkerSubscriptions.liveSub(this.ig.state.cookieUserId),
            ],
            socksOptions: socksOptions,
        };

        const fbnsConnectOptions = {
            autoReconnect: true,
            socksOptions: socksOptions,
        };

        await Promise.all([
            this.ig.realtime.connect(connectOptions),
            this.ig.fbns.connect(fbnsConnectOptions)
        ]);

        this.ready = true;
        this.emit('connected');
        this.log('INFO', '🚀 Combined Instagram client is now running and listening for messages');

        // Replay buffered events
        this.eventsToReplay.forEach((event) => {
            const eventType = event.shift();
            if (eventType === 'realtime') {
                // Re-trigger the receive handler logic
                const topic = event[0];
                const payload = event[1];
                // Simulate the 'receive' event processing
                if (topic.id === '146') {
                    this.parseInboxUpdates(payload);
                }
                // Handle other topics if needed
            } else if (eventType === 'fbns') {
                this.handleFbnsReceive(...event);
            }
        });
        this.eventsToReplay = [];
    }

    /**
     * Log the bot out from Instagram.
     * @returns {Promise<void>}
     */
    async logout() {
        this.log('INFO', '🔌 Initiating graceful logout from Instagram...');
        this.ready = false;

        if (this.messageRequestsMonitorInterval) {
            clearInterval(this.messageRequestsMonitorInterval);
            this.messageRequestsMonitorInterval = null;
            this.log('INFO', '🕒 Message requests monitor stopped.');
        }

        try {
            await this.setForegroundState(false, false, 900);
        } catch (stateError) {
            this.log('WARN', '⚠️ Error setting background state before logout:', stateError.message);
        }

        try {
            if (this.ig) {
                await this.ig.account.logout();
                this.log('INFO', '✅ Logged out of Instagram account');
            }
        } catch (logoutError) {
            this.log('WARN', '⚠️ Error during account logout:', logoutError.message);
        }

        try {
            if (this.ig?.realtime) {
                await this.ig.realtime.disconnect();
                this.log('INFO', '✅ Disconnected from Instagram realtime');
            }
        } catch (disconnectError) {
            this.log('WARN', '⚠️ Error during realtime disconnect:', disconnectError.message);
        }

        try {
            if (this.ig?.fbns) {
                await this.ig.fbns.disconnect();
                this.log('INFO', '✅ Disconnected from Instagram FBNS');
            }
        } catch (fbnsDisconnectError) {
            this.log('WARN', '⚠️ Error during FBNS disconnect:', fbnsDisconnectError.message);
        }
        this.emit('disconnected');
    }

    // --- insta.js Style Methods (potentially enhanced) ---
    // These methods are largely from the original insta.js Client.js
    // ... (_patchOrCreateUser, createChat, fetchChat, fetchUser) ...
    // (Implementation details are in your original file)

    // --- New Methods from InstagramBot Features ---

    /**
     * Subscribe to live comments on a specific broadcast.
     * @param {string} broadcastId The ID of the live broadcast.
     * @returns {Promise<boolean>} True if subscription was successful.
     */
    async subscribeToLiveComments(broadcastId) {
        if (!broadcastId) {
            this.log('WARN', '⚠️ subscribeToLiveComments called without broadcastId');
            return false;
        }
        try {
            await this.ig.realtime.graphQlSubscribe(
                GraphQLSubscriptions.getLiveRealtimeCommentsSubscription(broadcastId)
            );
            this.log('INFO', `📺 Successfully subscribed to live comments for broadcast: ${broadcastId}`);
            this.emit('liveCommentSubscription', broadcastId); // New event
            return true;
        } catch (error) {
            this.log('ERROR', `Failed to subscribe to live comments for ${broadcastId}:`, error.message);
            return false;
        }
    }

    /**
     * Simulate app/device foreground/background state.
     * @param {boolean} [inApp=true] Whether the app is in the foreground.
     * @param {boolean} [inDevice=true] Whether the device is in the foreground.
     * @param {number} [timeoutSeconds=60] Keep alive timeout.
     * @returns {Promise<boolean>} True if successful.
     */
    async setForegroundState(inApp = true, inDevice = true, timeoutSeconds = 60) {
        const timeout = inApp ? Math.max(10, timeoutSeconds) : 900;
        try {
            await this.ig.realtime.direct.sendForegroundState({
                inForegroundApp: Boolean(inApp),
                inForegroundDevice: Boolean(inDevice),
                keepAliveTimeout: timeout,
            });
            this.log('INFO', `📱 Foreground state set: App=${Boolean(inApp)}, Device=${Boolean(inDevice)}, Timeout=${timeout}s`);
            return true;
        } catch (error) {
            this.log('ERROR', 'Failed to set foreground state:', error.message);
            return false;
        }
    }

    /**
     * Fetch message requests.
     * @returns {Promise<Array>} Array of pending thread objects.
     */
    async getMessageRequests() {
        try {
            const pendingResponse = await this.ig.feed.directPending().request();
            const threads = pendingResponse.inbox?.threads || [];
            this.log('INFO', `📬 Fetched ${threads.length} message requests`);
            return threads;
        } catch (error) {
            this.log('ERROR', 'Failed to fetch message requests:', error.message);
            return [];
        }
    }

    /**
     * Approve a message request.
     * @param {string} threadId The ID of the thread to approve.
     * @returns {Promise<boolean>} True if successful.
     */
    async approveMessageRequest(threadId) {
        if (!threadId) {
            this.log('WARN', '⚠️ approveMessageRequest called without threadId');
            return false;
        }
        try {
            await this.ig.directThread.approve(threadId);
            this.log('INFO', `✅ Successfully approved message request: ${threadId}`);

            // Update cache: Move from pending to main chats if it was pending
            const chat = this.cache.pendingChats.get(threadId);
            if (chat) {
                chat.pending = false; // Update the chat object
                this.cache.chats.set(threadId, chat);
                this.cache.pendingChats.delete(threadId);
                this.emit('messageRequestApproved', chat); // New event
            }

            return true;
        } catch (error) {
            this.log('ERROR', `Failed to approve message request ${threadId}:`, error.message);
            return false;
        }
    }

    /**
     * Decline a message request.
     * @param {string} threadId The ID of the thread to decline.
     * @returns {Promise<boolean>} True if successful.
     */
    async declineMessageRequest(threadId) {
        if (!threadId) {
            this.log('WARN', '⚠️ declineMessageRequest called without threadId');
            return false;
        }
        try {
            await this.ig.directThread.decline(threadId);
            this.log('INFO', `❌ Successfully declined message request: ${threadId}`);

            // Update cache: Remove from pending
            const chat = this.cache.pendingChats.get(threadId);
            if (chat) {
                this.cache.pendingChats.delete(threadId);
                this.emit('messageRequestDeclined', chat); // New event
            }

            return true;
        } catch (error) {
            this.log('ERROR', `Failed to decline message request ${threadId}:`, error.message);
            return false;
        }
    }

    /**
     * Start monitoring message requests periodically.
     * @param {number} [intervalMs=300000] Interval in milliseconds (default 5 minutes).
     * @returns {void}
     */
    startMessageRequestsMonitor(intervalMs = 300000) {
        if (this.messageRequestsMonitorInterval) {
            clearInterval(this.messageRequestsMonitorInterval);
            this.log('WARN', '🛑 Stopping existing message requests monitor before starting a new one.');
        }
        this.messageRequestsMonitorInterval = setInterval(async () => {
            if (this.ready) {
                try {
                    // Just fetch and emit an event, let user handle auto-approve logic if desired
                    const requests = await this.getMessageRequests();
                    this.emit('messageRequestsPolled', requests); // New event
                } catch (error) {
                    this.log('ERROR', 'Error in periodic message requests check:', error.message);
                }
            }
        }, intervalMs);
        this.log('INFO', `🕒 Started message requests monitor (checking every ${intervalMs / 1000 / 60} minutes)`);
    }

    // --- Utility & Serialization (from insta.js) ---
    // ... (exportState, importState can be added if needed, though login handles persistence) ...

    toJSON() {
        return {
            ready: this.ready,
            options: this.options,
            id: this.user?.id
        };
    }
}

module.exports = Client;
