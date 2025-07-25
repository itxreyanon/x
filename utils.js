// client/Util.js
'use strict';

/**
 * Multiple static utility functions.
 */
class Util {
    /**
     * Check if query is an id (numeric string).
     * @param {string} query The query to check.
     * @return {boolean}
     */
    static isID(query) {
        return /^\d+$/.test(query); // More robust than !isNaN
    }

    /**
     * Match admin path.
     * @param {string} query URL path to match.
     * @param {boolean} extract Whether it should return the extracted data from the query.
     * @return {string[]|boolean}
     */
    static matchAdminPath(query, extract) {
        const regex = /\/direct_v2\/threads\/(\d+)\/admin_user_ids\/(\d+)/;
        const isMatched = regex.test(query);
        return extract ? query.match(regex)?.slice(1) : isMatched;
    }

    /**
     * Match message path.
     * @param {string} query URL path to match.
     * @param {boolean} extract Whether it should return the extracted data from the query.
     * @return {string[]|boolean}
     */
    static matchMessagePath(query, extract) {
        const regex = /\/direct_v2\/threads\/(\d+)\/items\/(\d+)/;
        const isMatched = regex.test(query);
        return extract ? query.match(regex)?.slice(1) : isMatched;
    }

    /**
     * Match inbox thread path.
     * @param {string} query URL path to match.
     * @param {boolean} extract Whether it should return the extracted data from the query.
     * @return {string[]|boolean}
     */
    static matchInboxThreadPath(query, extract) {
        const regex = /\/direct_v2\/inbox\/threads\/(\d+)/;
        const isMatched = regex.test(query);
        return extract ? query.match(regex)?.slice(1) : isMatched;
    }

    /**
     * Check if message is valid (not too old).
     * @param {Message} message The message instance.
     * @return {boolean}
     */
    static isMessageValid(message) {
        // Convert timestamp to milliseconds if it's in microseconds
        const timestampMs = message.timestamp > 1e12 ? message.timestamp / 1000 : message.timestamp;
        return (timestampMs + 10000000) > Date.now(); // 10000 seconds = ~2.78 hours
    }
}

module.exports = Util;
