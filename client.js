// Client.js (Modified Lib 1 with Lib 2 login logic)
const { IgApiClient } = require('instagram-private-api');
const { withFbnsAndRealtime } = require('instagram_mqtt');
const { Collection } = require('./Collection'); // Assuming you use your custom Collection
const Util = require('./Util'); // Assuming this exists
const User = require('./User');
const Chat = require('./Chat');
const Message = require('./Message');
const ClientUser = require('./ClientUser');
const fs = require('fs');
const path = require('path');
const tough = require('tough-cookie');

/**
 * Client, the main hub for interacting with the Instagram API.
 * @extends {EventEmitter}
 */
class Client extends require('events').EventEmitter {
  /**
   * @typedef {object} ClientOptions
   * @property {boolean} disableReplyPrefix Whether the bot should disable user mention for the Message#reply() method
   * @property {string} sessionPath Path to save/load session data (Lib 2 style)
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
      sessionPath: './session.json', // Lib 2 style fixed path
      // Add other Lib 2 options if needed
      autoReconnect: true,
      maxRetries: 3,
      ...options,
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
      pendingChats: new Collection(),
    };

    /**
     * @type {any[]}
     * @private
     */
    this.eventsToReplay = [];

    /**
     * @type {number}
     * @private
     */
    this._retryCount = 0;
  }

  /**
   * Create a new user or patch the cache one with the payload
   * @private
   * @param {string} userID The ID of the user to patch
   * @param {object} userPayload The data of the user
   * @returns {User}
   */
  _patchOrCreateUser(userID, userPayload) {
    if (this.cache.users.has(userID)) {
      this.cache.users.get(userID)._patch(userPayload);
    } else {
      this.cache.users.set(userID, new User(this, userPayload));
    }
    return this.cache.users.get(userID);
  }

  /**
   * Create a chat (or return the existing one) between one (a dm chat) or multiple users (a group).
   * @param {string[]} userIDs The users to create a chat for
   * @returns {Promise<Chat>}
   */
  async createChat(userIDs) {
    const thread = await this.ig.direct.createGroupThread(userIDs);
    const chat = new Chat(this, thread.thread_id, thread);
    this.cache.chats.set(chat.id, chat);
    return chat;
  }

  /**
   * Fetch a user by its username or ID
   * @param {string} query The username or ID to fetch
   * @param {boolean} force Whether to force fetch the user from Instagram instead of cache
   * @returns {Promise<User>}
   */
  async fetchUser(query, force = false) {
    const userID = Util.isID(query) ? query : (await this.ig.user.usernameinfo(query)).pk;
    if (!this.cache.users.has(userID) || force) {
      const user = await this.ig.user.info(userID);
      this._patchOrCreateUser(userID, user);
    }
    return this.cache.users.get(userID);
  }

  /**
   * Fetch a chat by its ID
   * @param {string} chatID The ID of the chat to fetch
   * @param {boolean} force Whether to force fetch the chat from Instagram instead of cache
   * @returns {Promise<Chat>}
   */
  async fetchChat(chatID, force = false) {
    if (!this.cache.chats.has(chatID) || force) {
      const { thread: chat } = await this.ig.feed.directThread({ thread_id: chatID }).request();
      const c = new Chat(this, chat.thread_id, chat);
      this.cache.chats.set(c.id, c);
    }
    return this.cache.chats.get(chatID);
  }

  /**
   * Save the current Instagram session to a file.
   * @returns {Promise<void>}
   * @private
   */
  async _saveSession() { // Using _saveSession like Lib 2
    if (!this.ig) return;
    try {
      const sessionData = await this.ig.state.serialize();
      delete sessionData.constants; // Remove constants
      await fs.promises.writeFile(this.options.sessionPath, JSON.stringify(sessionData, null, 2));
      this.emit('debug', 'session saved');
    } catch (err) {
      this.emit('error', new Error(`Failed to save session: ${err.message}`));
    }
  }

  // --- START: Lib 2 Login Logic Integration ---

  /**
   * Load cookies from cookies.json
   * @returns {Promise<void>}
   * @private
   */
  async _loadCookies() {
    const cookiesPath = './cookies.json'; // Lib 2 fixed path
    try {
      if (!fs.existsSync(cookiesPath)) {
        this.emit('debug', 'cookies.json not found');
        return;
      }

      const cookies = JSON.parse(await fs.promises.readFile(cookiesPath, 'utf-8'));
      for (const cookie of cookies) {
        const toughCookie = new tough.Cookie({
          key: cookie.name,
          value: cookie.value,
          domain: cookie.domain.replace(/^\./, ''),
          path: cookie.path || '/',
          secure: cookie.secure !== false,
          httpOnly: cookie.httpOnly !== false,
          expires: cookie.expires ? new Date(cookie.expires) : undefined,
        });

        await this.ig.state.cookieJar.setCookie(
          toughCookie.toString(),
          `https://${toughCookie.domain}${toughCookie.path}`,
        );
      }
      this.emit('debug', 'cookies loaded from cookies.json');
    } catch (err) {
      this.emit('error', new Error(`Failed to load cookies: ${err.message}`));
      // Don't throw, let login process continue
    }
  }

  /**
   * Save cookies to cookies.json
   * @returns {Promise<void>}
   * @private
   */
  async _saveCookies() {
    const cookiesPath = './cookies.json'; // Lib 2 fixed path
    try {
      const cookies = await this.ig.state.cookieJar.getCookies('https://instagram.com');
      await fs.promises.writeFile(cookiesPath, JSON.stringify(cookies, null, 2));
      this.emit('debug', 'cookies saved to cookies.json');
    } catch (err) {
      this.emit('error', new Error(`Failed to save cookies: ${err.message}`));
      // Don't throw, session might still be saved
    }
  }

  /**
   * Log the client in to Instagram
   * @param {string} username The username of the Instagram account
   * @param {string} password The password of the Instagram account
   * @returns {Promise<void>}
   */
  async login(username, password) {
    // Step 1: Initialize API client
    const ig = withFbnsAndRealtime(new IgApiClient());
    ig.state.generateDevice(username);
    this.ig = ig; // Assign to this.ig early

    let loginSuccess = false;

    // Step 2: Try session.json first (Lib 2 approach)
    try {
      if (fs.existsSync(this.options.sessionPath)) {
        this.emit('debug', 'found session.json, trying to login from session...');
        const sessionData = JSON.parse(await fs.promises.readFile(this.options.sessionPath, 'utf-8'));
        await this.ig.state.deserialize(sessionData);
        await this.ig.account.currentUser(); // Validate session
        this.emit('debug', 'logged in from session.json');
        loginSuccess = true;
      }
    } catch (sessionError) {
      this.emit('debug', 'session.json invalid or login failed, falling back to cookies...', sessionError.message);
      // Continue to cookie login
    }

    // Step 3: Fallback to cookies.json (Lib 2 approach)
    if (!loginSuccess) {
      try {
        this.emit('debug', 'attempting login using cookies.json...');
        await this._loadCookies();
        await this.ig.account.currentUser(); // Validate cookies
        this.emit('debug', 'logged in using cookies.json');
        loginSuccess = true;
      } catch (cookieError) {
        this.emit('debug', 'cookies.json login failed', cookieError.message);
        // Continue, might attempt fresh login if implemented or allowed elsewhere
      }
    }

    // --- END: Lib 2 Login Logic Integration ---

    // --- START: Lib 1 Post-Login & Connection Logic ---
    if (loginSuccess) {
      // Fetch user info (Lib 1 style)
      try {
        const response = await this.ig.user.usernameinfo(username);
        const userData = await this.ig.user.info(response.pk);
        this.user = new ClientUser(this, { ...response, ...userData });
        this.cache.users.set(this.user.id, this.user);
        this.emit('debug', 'logged in user', this.user);
      } catch (userInfoError) {
        this.emit('error', new Error(`Failed to fetch user info after login: ${userInfoError.message}`));
        throw userInfoError; // Re-throw if user info is critical
      }

      // Save session/cookies after successful login (Lib 2 style)
      try {
        await this._saveSession();
        await this._saveCookies(); // Save cookies obtained/validated
      } catch (saveError) {
        this.emit('warn', 'Could not save session/cookies after login:', saveError.message);
        // Don't stop the process if saving fails
      }

      // Load initial data (chats etc. - assuming Lib 1 has this or similar)
      // await this._loadInitialData(); // You might need to implement or adapt this

      // Setup handlers (Lib 1 style)
      this._setupRealtimeHandlers(); // Assuming this method exists in Lib 1

      // Connect to realtime (Lib 1 style, but with potential Lib 2 options)
      try {
        await this.ig.realtime.connect({
          autoReconnect: this.options.autoReconnect,
          irisData: await this.ig.feed.directInbox().request(),
          // Add other connect options from Lib 1 if needed
        });
        this.ready = true;
        this.emit('ready');
        this.emit('debug', 'client is ready');

        // Replay events received before ready (Lib 1 style)
        for (const event of this.eventsToReplay) {
          this.emit(...event);
        }
        this.eventsToReplay = [];
      } catch (connectError) {
        this.emit('error', new Error(`Failed to connect to realtime: ${connectError.message}`));
        throw connectError;
      }
    } else {
      // If neither session nor cookies worked, and you want to allow fresh login
      // You would implement the ig.account.login(username, password) logic here
      // Be aware this will likely invalidate the session on the phone.
      this.emit('error', new Error('Login failed: No valid session or cookies found, and fresh login not implemented in this adaptation.'));
      throw new Error('Login failed: No valid session or cookies found, and fresh login not implemented in this adaptation.');
      /*
      // Example of fresh login (WARNING: Logs out phone)
      try {
          await this.ig.account.login(username, password);
          // ... fetch user info, save session ...
          // ... setup handlers, connect ...
      } catch (freshLoginError) {
          this.emit('error', new Error(`Fresh login failed: ${freshLoginError.message}`));
          throw freshLoginError;
      }
      */
    }
    // --- END: Lib 1 Post-Login & Connection Logic ---
  }

  /**
   * Disconnects the client from Instagram
   * @returns {Promise<void>}
   */
  async disconnect() {
    this.ready = false;
    if (this.ig?.realtime) {
      try {
        await this.ig.realtime.disconnect();
      } catch (err) {
        this.emit('error', new Error(`Failed to disconnect realtime: ${err.message}`));
      }
    }
    this.emit('disconnect');
  }

  /**
   * Sets up the realtime event handlers
   * @private
   */
  _setupRealtimeHandlers() {
    // This method should contain the event handling logic from the original Lib 1 Client.js
    // (e.g., this.ig.realtime.on('message', ...), this.ig.realtime.on('direct', ...))
    // The content of this method would be the event handling part from the original Lib 1 file.
    // For brevity, and because the full original logic wasn't provided in snippets,
    // we represent it as a placeholder here.
    // You need to copy the full event handling logic from the original Lib 1 Client.js file into this method.

    this.ig.realtime.on('message', async (data) => {
      // ... Original Lib 1 message handling logic ...
      // Example placeholder:
      if (!this.ready) {
        this.eventsToReplay.push(['message', data]);
        return;
      }
      // Process message data...
      // this.emit('messageCreate', messageObject);
    });

    this.ig.realtime.on('direct', async (data) => {
      // ... Original Lib 1 direct handling logic ...
      if (!this.ready) {
        this.eventsToReplay.push(['direct', data]);
        return;
      }
      // Process direct data...
    });

    // Add other event listeners from Lib 1 (error, close, etc.)
    this.ig.realtime.on('error', (err) => {
      this.emit('error', err);
      // Implement Lib 2 style reconnection logic if desired
    });

    this.ig.realtime.on('close', () => {
      this.emit('disconnect');
      // Implement Lib 2 style reconnection logic if desired
    });

    // Add FBNS handlers if Lib 1 used them
    if (this.ig.fbns) {
      this.ig.fbns.push$.subscribe((data) => {
        // ... Lib 1 FBNS handling logic ...
      });
    }
  }

  // Add other methods from the original Lib 1 Client.js file (e.g., methods for handling received data,
  // emitting events like messageCreate, likeAdd, etc.)
  // These are not included here as the full original logic wasn't in the snippets.
}

module.exports = Client;
