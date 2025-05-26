// backend/src/collectors/scanner_base.js
const EventEmitter = require('events');
const logger = require('../utils/logger');

class ScannerBase extends EventEmitter {
    constructor(name, config) {
        super();
        this.name = name;
        this.config = config;
        this.isRunning = false;
        this.tokens = new Map();
        this.processedTokens = new Set();
        this.lastFetch = null;
        
        // Program IDs should be passed in config
        this.PROGRAM_IDS = config.PROGRAM_IDS || {};
    }

    async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        logger.info(`🚀 ${this.name} scanner started`);
    }

    stop() {
        this.isRunning = false;
        logger.info(`🛑 ${this.name} scanner stopped`);
    }

    async enrichTokenData(token) {
        // Base enrichment - can be overridden by subclasses
        return {
            ...token,
            source: this.name.toLowerCase(),
            enrichedAt: Date.now()
        };
    }

    emitToken(token) {
        if (!this.processedTokens.has(token.address)) {
            this.processedTokens.add(token.address);
            this.tokens.set(token.address, token);
            this.emit('token', token);
        }
    }
}

module.exports = ScannerBase;