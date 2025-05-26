// backend/src/collectors/scanners/moonshot_scanner.js
const axios = require('axios');
const { Connection, PublicKey } = require('@solana/web3.js');
const EventEmitter = require('events');
const logger = require('../../utils/logger');

class MoonshotScanner extends EventEmitter {
    constructor(config, parent) {
        super();
        this.config = config.sources.moonshot;
        this.parent = parent;
        this.connection = parent.connection;
        this.tokens = new Map();
        this.isRunning = false;
        this.programId = new PublicKey(this.config.programId);
    }

    async start() {
        if (this.isRunning) return;
        
        this.isRunning = true;
        logger.info('🌙 Starting Moonshot scanner');
        
        // Initial fetch
        await this.fetchTokens();
        
        // Monitor program for new tokens
        this.subscribeToProgram();
        
        // Periodic fetch
        this.fetchInterval = setInterval(() => {
            this.fetchTokens();
        }, 60000); // Every minute
    }

    async fetchTokens() {
        try {
            const response = await axios.get(
                `${this.config.api.base}${this.config.api.endpoints.new}`,
                {
                    headers: {
                        'Accept': 'application/json'
                    },
                    timeout: 10000
                }
            );

            if (response.data && response.data.tokens) {
                const tokens = response.data.tokens
                    .filter(token => this.isValidToken(token))
                    .map(token => this.formatToken(token));

                for (const token of tokens) {
                    if (!this.tokens.has(token.address)) {
                        this.tokens.set(token.address, token);
                        this.emit('token', token);
                    }
                }

                logger.info(`🌙 Moonshot: Fetched ${tokens.length} tokens`);
            }
        } catch (error) {
            logger.error('Moonshot API error:', error.message);
        }
    }

    subscribeToProgram() {
        // Monitor Moonshot program for new token creation
        this.connection.onLogs(
            this.programId,
            async (logs) => {
                if (logs.err) return;
                
                // Check for token creation event
                if (this.isTokenCreation(logs)) {
                    const tokenData = await this.parseTokenCreation(logs.signature);
                    if (tokenData) {
                        this.emit('token', { ...tokenData, priority: 95 });
                        logger.info(`🌙 Moonshot: New token ${tokenData.symbol} detected on-chain!`);
                    }
                }
            },
            'confirmed'
        );
    }

    isTokenCreation(logs) {
        return logs.logs.some(log => 
            log.includes('TokenMint') || 
            log.includes('InitializeToken') ||
            log.includes('CreateToken')
        );
    }

    async parseTokenCreation(signature) {
        try {
            const tx = await this.connection.getParsedTransaction(signature, {
                maxSupportedTransactionVersion: 0
            });

            if (!tx || !tx.meta) return null;

            // Extract token mint from transaction
            // This is simplified - actual implementation would parse the specific instruction
            const instructions = tx.transaction.message.instructions;
            
            for (const ix of instructions) {
                if (ix.programId.toString() === this.programId.toString()) {
                    // Extract token address from instruction data
                    // This would need proper parsing based on Moonshot's instruction format
                    return null; // Placeholder
                }
            }
        } catch (error) {
            logger.error('Error parsing Moonshot transaction:', error);
            return null;
        }
    }

    formatToken(moonshotToken) {
        return {
            address: moonshotToken.mint || moonshotToken.address,
            symbol: moonshotToken.symbol,
            name: moonshotToken.name,
            price: parseFloat(moonshotToken.price || 0),
            priceUsd: parseFloat(moonshotToken.priceUsd || 0),
            liquidity: parseFloat(moonshotToken.liquidity || 0),
            liquiditySol: parseFloat(moonshotToken.liquiditySol || 0),
            volume24h: parseFloat(moonshotToken.volume24h || 0),
            marketCap: parseFloat(moonshotToken.marketCap || 0),
            holders: parseInt(moonshotToken.holders || 0),
            createdAt: moonshotToken.createdAt || Date.now(),
            priceChange24h: parseFloat(moonshotToken.priceChange24h || 0),
            
            // Moonshot specific
            verified: moonshotToken.verified || false,
            migrationEligible: moonshotToken.migrationEligible || false,
            totalSupply: parseFloat(moonshotToken.totalSupply || 0),
            
            metadata: {
                description: moonshotToken.description,
                twitter: moonshotToken.twitter,
                telegram: moonshotToken.telegram,
                website: moonshotToken.website,
                logo: moonshotToken.logo
            },
            
            source: 'moonshot',
            sourceData: {
                dexPair: moonshotToken.dexPair,
                poolAddress: moonshotToken.poolAddress
            }
        };
    }

    isValidToken(token) {
        if (!token || !token.mint) return false;
        
        // Skip if too old
        const age = Date.now() - (token.createdAt || 0);
        if (age > 24 * 60 * 60 * 1000) return false;
        
        // Skip if no liquidity
        if (parseFloat(token.liquidity || 0) < 100) return false;
        
        return true;
    }

    stop() {
        this.isRunning = false;
        
        if (this.fetchInterval) {
            clearInterval(this.fetchInterval);
        }
        
        logger.info('Moonshot scanner stopped');
    }
}

module.exports = MoonshotScanner;